/**
 * 审稿分片共享逻辑。
 *
 * 一次审稿 = 多个并行 LLM 分片（每个分片只审少数维度、只输出少量 JSON），
 * 替代单次大调用：降低输出截断（finishReason=length）概率，避免维度间
 * 注意力稀释，并让新增检查维度（如叙事规范）不挤占既有维度的深度。
 *
 * 这里只放纯逻辑：分片路由、输出合同解析、跨分片去重、summary 合成。
 * LLM 调用与管线组装在 review-chapter.command.ts。
 */

export type ReviewSeverity = 'error' | 'warning' | 'pass'

export interface ShardReviewItem {
  category: string
  severity: ReviewSeverity
  description: string
  quote?: string
}

/** 审稿分片键；与 prompt-templates 的 consistency_check_* 模板键对应 */
export type ReviewShardKey = 'continuity' | 'logic' | 'narration'

/** 审稿报告的确定性行数上限：跨分片合并后整体截断 */
export const MERGED_REVIEW_ITEMS_LIMIT = 16

const SHARD_ITEM_LIMIT = 10
const SHARD_DESCRIPTION_MAX_CHARACTERS = 200
const SHARD_QUOTE_MAX_CHARACTERS = 160

const SEVERITY_RANK: Record<ReviewSeverity, number> = { error: 0, warning: 1, pass: 2 }

/**
 * 把作者勾选的重点维度（join('、') 的字符串）路由到应执行的分片。
 * 空串 = 程序化调用默认全查。叙事规范分片没有开关，恒跑。
 */
export function routeReviewShards(reviewFocus: string | undefined): {
  continuity: boolean
  logic: boolean
} {
  const focus = reviewFocus?.trim() ?? ''
  if (!focus) return { continuity: true, logic: true }
  return {
    continuity: focus.includes('剧情连贯性') || focus.includes('前后章节串联'),
    logic: focus.includes('剧情合理性') || focus.includes('角色状态'),
  }
}

/** 取某分片名下被勾选的维度标签，作为该分片的「重点检查」强调文本 */
export function shardReviewFocus(reviewFocus: string | undefined, shard: ReviewShardKey): string {
  const focus = reviewFocus?.trim() ?? ''
  if (!focus) return ''
  const labelsByShard: Record<ReviewShardKey, string[]> = {
    continuity: ['剧情连贯性', '前后章节串联'],
    logic: ['剧情合理性', '角色状态'],
    narration: [],
  }
  return labelsByShard[shard].filter(label => focus.includes(label)).join('、')
}

function boundText(value: string, maxCharacters: number): string {
  return Array.from(value.trim()).slice(0, maxCharacters).join('')
}

function isShardReviewShape(value: unknown): value is { items: ShardReviewItem[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const review = value as Record<string, unknown>
  if (Object.keys(review).some(key => key !== 'items')
    || !Array.isArray(review.items)
    || review.items.length < 1
    || review.items.length > SHARD_ITEM_LIMIT) return false
  return review.items.every((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    const record = item as Record<string, unknown>
    const severity = record.severity
    return !Object.keys(record).some(key => (
      key !== 'category'
      && key !== 'severity'
      && key !== 'description'
      && key !== 'quote'
    ))
      && typeof record.category === 'string'
      && (severity === 'error' || severity === 'warning' || severity === 'pass')
      && typeof record.description === 'string'
      && (record.quote === undefined
        ? severity === 'pass'
        : typeof record.quote === 'string')
  })
}

/**
 * 解析单个分片的审稿输出：根字段仅 items（1–10 条），
 * 条目合同与整稿报告一致（category/severity/description/quote，
 * quote 仅 pass 可省略，越界文本机械截断）。
 */
export function parseShardReviewItems(content: string): ShardReviewItem[] {
  const trimmed = content.trim()
  const fenced = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu.exec(trimmed)
  const parsed: unknown = JSON.parse(fenced?.[1]?.trim() ?? trimmed)
  if (!isShardReviewShape(parsed)) throw new Error('invalid shard review contract')
  const items = parsed.items.map(item => ({
    category: item.category,
    severity: item.severity,
    description: boundText(item.description, SHARD_DESCRIPTION_MAX_CHARACTERS),
    ...(item.quote === undefined
      ? {}
      : { quote: boundText(item.quote, SHARD_QUOTE_MAX_CHARACTERS) }),
  }))
  if (!isShardReviewShape({ items })) throw new Error('invalid shard review contract')
  return items
}

/**
 * 跨分片去重：同一问题被两个分片重复报告时保留更严重的一条。
 * 判定键 = category + 归一化 quote（无 quote 时用 description）；
 * 只做确定性归一化精确匹配，不猜测改写。
 */
export function dedupeReviewItems(items: readonly ShardReviewItem[]): ShardReviewItem[] {
  const normalized = (value: string): string => value
    .normalize('NFC')
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .toLowerCase()
  const byKey = new Map<string, ShardReviewItem>()
  for (const item of items) {
    const key = `${item.category}|${normalized(item.quote ?? item.description)}`
    const existing = byKey.get(key)
    if (!existing || SEVERITY_RANK[item.severity] < SEVERITY_RANK[existing.severity]) {
      byKey.set(key, item)
    }
  }
  return [...byKey.values()]
}

/** 跨分片合并后的确定性 summary（分片合同不再产出模型 summary） */
export function synthesizeReviewSummary(
  items: readonly ShardReviewItem[],
  language: 'zh-CN' | 'en-US',
): string {
  const errors = items.filter(item => item.severity === 'error').length
  const warnings = items.filter(item => item.severity === 'warning').length
  if (language === 'en-US') {
    if (errors > 0) return `Found ${errors} critical issue(s) and ${warnings} minor inconsistency/inconsistencies.`
    if (warnings > 0) return `No critical issues; ${warnings} minor inconsistency/inconsistencies found.`
    return 'No issues found across the reviewed dimensions.'
  }
  if (errors > 0) return `发现 ${errors} 处严重问题、${warnings} 处轻微不一致。`
  if (warnings > 0) return `未发现严重问题；有 ${warnings} 处轻微不一致。`
  return '各检查维度未发现问题。'
}

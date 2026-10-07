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

/**
 * 三个可开关的审稿分片：一个开关 = 一整片 LLM 调用。
 * `emphasis` 是该分片覆盖的维度清单，注入模板的「重点检查」段落。
 * 章节目标核对（D）由软件冻结清单驱动，恒跑，不在此列。
 */
export const REVIEW_SHARD_DIMENSIONS = [
  { key: 'continuity', promptLabel: '事实线', emphasis: '剧情连贯性、前后章节串联、伏笔完整性' },
  { key: 'logic', promptLabel: '因果与角色', emphasis: '剧情合理性、角色状态' },
  { key: 'narration', promptLabel: '叙事规范', emphasis: '人称一致性、视角越权、时态滑动' },
] as const satisfies readonly { key: ReviewShardKey; promptLabel: string; emphasis: string }[]

/** 未显式指定时的默认分片集合：全查（程序化调用的兼容默认）。 */
export function defaultReviewFocus(): ReviewShardKey[] {
  return REVIEW_SHARD_DIMENSIONS.map(dimension => dimension.key)
}

/** 审稿报告的确定性行数上限：跨分片合并后整体截断 */
export const MERGED_REVIEW_ITEMS_LIMIT = 16

const SHARD_ITEM_LIMIT = 10
const SHARD_DESCRIPTION_MAX_CHARACTERS = 200
const SHARD_QUOTE_MAX_CHARACTERS = 160

const SEVERITY_RANK: Record<ReviewSeverity, number> = { error: 0, warning: 1, pass: 2 }

/**
 * 把作者勾选的分片键路由到应执行的分片。
 * 空/未提供 = 程序化调用默认全查；提供则按集合精确取舍。
 */
export function routeReviewShards(
  reviewFocus: readonly ReviewShardKey[] | undefined,
): Record<ReviewShardKey, boolean> {
  const selected = reviewFocus && reviewFocus.length > 0 ? new Set(reviewFocus) : null
  return {
    continuity: !selected || selected.has('continuity'),
    logic: !selected || selected.has('logic'),
    narration: !selected || selected.has('narration'),
  }
}

/** 分片启用时返回其维度清单，作为该分片的「重点检查」强调文本；未启用返回空串。 */
export function shardReviewFocus(
  reviewFocus: readonly ReviewShardKey[] | undefined,
  shard: ReviewShardKey,
): string {
  if (!routeReviewShards(reviewFocus)[shard]) return ''
  return REVIEW_SHARD_DIMENSIONS.find(dimension => dimension.key === shard)?.emphasis ?? ''
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

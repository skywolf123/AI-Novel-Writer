/**
 * 确定性重复段落检测（审稿线的确定性信号，零 LLM 成本）。
 *
 * 扫描章节草稿中「模型异常复读 / 续写拼接重叠」产生的腐蚀性重复段落：
 * 1. 逐字重复：归一化（去空白/标点/符号）后完全相同的段落 → error；
 * 2. 近似重复：归一化后高度相似（字符三元组 Jaccard 相似度）的长段落
 *    → warning，对应续写重叠只差几个字的场景。
 *
 * 短文本（日期行、口号式短句、功能性回环）天然低于最小长度门槛，
 * 不会被定罪——那是润色门控的判断领域，不在这里处理。
 */

import type { ReviewLike } from './consistency-preflight'

/** 逐字重复定罪的最小归一化长度：更短的重复（日期、短句回环）不报 */
const MIN_EXACT_CHARS = 12
/** 近似重复比较的最小归一化长度 */
const MIN_NEAR_CHARS = 20
/** 字符三元组 Jaccard 相似度阈值 */
const NEAR_SIMILARITY_THRESHOLD = 0.9
/** 单章报告上限，防止大面积腐蚀刷屏 */
const MAX_FINDINGS = 6
/** 报告 quote 上限，与审稿输出合同一致 */
const QUOTE_MAX_CHARACTERS = 160

/** 归一化：去空白/标点/符号、NFC、小写，只留可见文字 */
function normalizeForComparison(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .toLowerCase()
}

export interface DuplicateSpanFinding {
  kind: 'exact-paragraph' | 'near-paragraph'
  severity: 'error' | 'warning'
  /** 首次出现的原文（截断到 160 字符），供审稿报告 quote 直接使用 */
  quote: string
  /** 重复段落的 1-based 段序号 */
  paragraphNumbers: number[]
  /** 近似重复时的相似度（0–1） */
  similarity?: number
  issue: { zhCN: string; enUS: string }
}

/** 把草稿切成段落（按换行），返回原文与归一化文本 */
interface PreparedParagraph {
  original: string
  normalized: string
}

function splitParagraphs(draft: string): PreparedParagraph[] {
  return draft
    .split(/\n+/)
    .map(raw => raw.trim())
    .filter(Boolean)
    .map(original => ({ original, normalized: normalizeForComparison(original) }))
}

function truncateQuote(text: string): string {
  return text.length > QUOTE_MAX_CHARACTERS ? `${text.slice(0, QUOTE_MAX_CHARACTERS)}…` : text
}

/** 归一化文本的字符三元组集合；过短时退化为二元组/整体 */
function charShingles(normalized: string): Set<string> {
  const n = 3
  if (normalized.length <= n) return new Set([normalized])
  const shingles = new Set<string>()
  for (let i = 0; i + n <= normalized.length; i += 1) {
    shingles.add(normalized.slice(i, i + n))
  }
  return shingles
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const shingle of a) {
    if (b.has(shingle)) intersection += 1
  }
  return intersection / (a.size + b.size - intersection)
}

/**
 * 检测草稿中的腐蚀性重复段落。
 * 段序号为 1-based；同一处重复只产出一个 finding（多处互相相似的段落
 * 归并为一条），按 error 优先、相似度降序排序，超出 MAX_FINDINGS 截断。
 */
export function detectDuplicateParagraphs(draft: string): DuplicateSpanFinding[] {
  const paragraphs = splitParagraphs(draft)

  // ---- 逐字重复：归一化后完全相同 ----
  const exactGroups = new Map<string, number[]>()
  paragraphs.forEach((paragraph, index) => {
    if (paragraph.normalized.length < MIN_EXACT_CHARS) return
    const indexes = exactGroups.get(paragraph.normalized) ?? []
    indexes.push(index)
    exactGroups.set(paragraph.normalized, indexes)
  })

  const findings: DuplicateSpanFinding[] = []
  const consumed = new Set<number>()
  for (const indexes of exactGroups.values()) {
    if (indexes.length < 2) continue
    findings.push({
      kind: 'exact-paragraph',
      severity: 'error',
      quote: truncateQuote(paragraphs[indexes[0]]!.original),
      paragraphNumbers: indexes.map(index => index + 1),
      issue: {
        zhCN: `第 ${indexes.map(index => index + 1).join('、')} 段归一化后完全相同，疑似模型输出异常或续写拼接重叠产生的重复段落，请核对删除`,
        enUS: `Paragraphs ${indexes.map(index => index + 1).join(', ')} are identical after normalization; likely duplicated output from a model glitch or continuation overlap. Verify and remove.`,
      },
    })
    indexes.forEach(index => consumed.add(index))
  }

  // ---- 近似重复：长段落高相似（排除已定罪的逐字重复段） ----
  const nearCandidates = paragraphs
    .map((paragraph, index) => ({ paragraph, index }))
    .filter(({ paragraph, index }) => (
      paragraph.normalized.length >= MIN_NEAR_CHARS && !consumed.has(index)
    ))

  // 并查集：互相相似的段落归并为一条 finding，避免一处故障刷多条
  const parent = nearCandidates.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)))
  const union = (a: number, b: number): void => {
    parent[find(a)] = find(b)
  }

  const shingles = nearCandidates.map(({ paragraph }) => charShingles(paragraph.normalized))
  const edges: Array<{ a: number; b: number; similarity: number }> = []
  for (let i = 0; i < nearCandidates.length; i += 1) {
    for (let j = i + 1; j < nearCandidates.length; j += 1) {
      const similarity = jaccard(shingles[i]!, shingles[j]!)
      if (similarity >= NEAR_SIMILARITY_THRESHOLD) {
        union(i, j)
        edges.push({ a: i, b: j, similarity })
      }
    }
  }

  const componentIndexes = new Map<number, number[]>()
  nearCandidates.forEach(({ index }, i) => {
    const root = find(i)
    const members = componentIndexes.get(root) ?? []
    members.push(index)
    componentIndexes.set(root, members)
  })
  for (const [root, members] of componentIndexes) {
    if (members.length < 2) continue
    // 该簇内最弱的一条相似边也要达到阈值，取簇内最小相似度表述
    const similarity = Math.min(...edges
      .filter(edge => find(edge.a) === root && find(edge.b) === root)
      .map(edge => edge.similarity))
    findings.push({
      kind: 'near-paragraph',
      severity: 'warning',
      quote: truncateQuote(paragraphs[members[0]]!.original),
      paragraphNumbers: members.map(index => index + 1),
      similarity,
      issue: {
        zhCN: `第 ${members.map(index => index + 1).join('、')} 段高度相似（约 ${Math.round(similarity * 100)}% 重合），疑似续写拼接重叠，请核对`,
        enUS: `Paragraphs ${members.map(index => index + 1).join(', ')} are highly similar (about ${Math.round(similarity * 100)}% overlap); likely a continuation splice. Verify.`,
      },
    })
  }

  return findings
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))
    .slice(0, MAX_FINDINGS)
}

/**
 * 把重复检测 findings 并入审稿报告（与确定性一致性预检同一管线：
 * 在模型输出解析之后追加，不影响模型输出的合同校验）。
 */
export function mergeDuplicateSpansIntoReview(
  review: ReviewLike,
  findings: readonly DuplicateSpanFinding[],
  locale: 'zh-CN' | 'en-US',
): ReviewLike & { items: Array<Record<string, unknown>> } {
  const mapped = findings.map(finding => ({
    category: locale === 'en-US' ? 'Deterministic duplicate detection' : '确定性重复检测',
    severity: finding.severity,
    description: locale === 'en-US' ? finding.issue.enUS : finding.issue.zhCN,
    quote: finding.quote,
  }))
  return { ...review, items: [...(Array.isArray(review.items) ? review.items : []), ...mapped] }
}

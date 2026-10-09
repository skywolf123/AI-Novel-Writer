/**
 * 跨轮审稿收敛度量（纯确定性，不靠 LLM）。
 *
 * 每条审稿发现都强制携带原文引用（quote）。修稿合并后拿上一轮报告的
 * quote 在新正文里做归一化包含判定：仍在 → 「未修复」；不在 → 「已修复」。
 * 这把「问题是否收敛」从作者肉眼比对变成可度量的证据判定——判定的是
 * "引用原文是否还在当前正文"，不猜测问题语义是否真正解决。
 */

export type CarryoverStatus = 'recurring' | 'resolved'

export interface CarryoverEvidenceItem {
  category: string
  severity: 'error' | 'warning'
  description: string
  quote: string
}

export interface CarryoverEntry extends CarryoverEvidenceItem {
  status: CarryoverStatus
}

export interface ReviewCarryover {
  sourceReviewId: number
  sourceReviewIndex: number
  resolvedCount: number
  recurringCount: number
  items: CarryoverEntry[]
  /** 本轮新发现中命中上一轮同键的证据键；仅作界面标记，不参与任何门控 */
  recurringKeys: string[]
}

/** 与 dedupeReviewItems 同一套归一化：NFC、去空白/标点/符号、小写 */
export function normalizeEvidence(value: string): string {
  return value
    .normalize('NFC')
    .replace(/[\s\p{P}\p{S}\s]/gu, '')
    .toLowerCase()
}

/** 一条发现的证据键：category + 归一化引用；与跨分片去重键同形 */
export function evidenceKey(category: string, quote: string): string {
  return `${category}|${normalizeEvidence(quote)}`
}

function isCarryoverCandidate(item: unknown): item is CarryoverEvidenceItem {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false
  const record = item as Record<string, unknown>
  if (typeof record.category !== 'string' || !record.category.trim()) return false
  if (record.severity !== 'error' && record.severity !== 'warning') return false
  if (typeof record.quote !== 'string' || !record.quote.trim()) return false
  return typeof record.description === 'string'
}

/**
 * 上一轮报告中的可证据条目（error/warning 且带 quote；pass 与本章目标行
 * 没有可比对的原文引用，不参与）。
 */
export function carryoverCandidates(items: readonly unknown[]): CarryoverEvidenceItem[] {
  return items.filter(isCarryoverCandidate).map(item => ({
    category: item.category,
    severity: item.severity,
    description: item.description,
    quote: item.quote,
  }))
}

/**
 * 逐条判定上一轮发现在当前正文中的存留状态。
 * quote 归一化后仍是正文子串 → recurring（原文未动）；否则 → resolved。
 */
export function classifyCarryover(
  previousItems: readonly CarryoverEvidenceItem[],
  currentText: string,
): CarryoverEntry[] {
  const normalizedText = normalizeEvidence(currentText)
  return previousItems.map(item => ({
    ...item,
    status: normalizedText.includes(normalizeEvidence(item.quote))
      ? 'recurring'
      : 'resolved',
  }))
}

export interface PreviousReviewOutline {
  id: number
  reviewIndex: number
  items: readonly unknown[]
}

/**
 * 由上一轮 AI 审稿与当前正文构建 carryover 块；没有可证据条目时返回 null
 * （首审无需收敛视图）。
 */
export function buildReviewCarryover(
  previous: PreviousReviewOutline,
  currentText: string,
): ReviewCarryover | null {
  const items = classifyCarryover(carryoverCandidates(previous.items), currentText)
  if (items.length === 0) return null
  const resolvedCount = items.filter(item => item.status === 'resolved').length
  return {
    sourceReviewId: previous.id,
    sourceReviewIndex: previous.reviewIndex,
    resolvedCount,
    recurringCount: items.length - resolvedCount,
    items,
    recurringKeys: [],
  }
}

/**
 * 本轮新发现中，哪些与上一轮同键（同一 category + 同一原文引用）。
 * 用于把「修不掉的硬问题」在新报告里标记为「上轮已报」。
 */
export function markRecurringKeys(
  carryover: ReviewCarryover,
  currentItems: readonly { category?: unknown; quote?: unknown }[],
): void {
  const previousKeys = new Set(
    carryover.items.map(item => evidenceKey(item.category, item.quote)),
  )
  for (const item of currentItems) {
    if (typeof item.category !== 'string' || typeof item.quote !== 'string') continue
    if (!item.quote.trim()) continue
    const key = evidenceKey(item.category, item.quote)
    if (previousKeys.has(key)) carryover.recurringKeys.push(key)
  }
}

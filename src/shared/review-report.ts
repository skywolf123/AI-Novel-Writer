import { parseChapterGoalReview, type ChapterGoalReview } from './chapter-goal-review'

/**
 * Review-report parsing and the checklist defaults the AI review screen starts
 * from. These live outside the React component so the manual editor and the
 * headless batch pipeline derive the same starting checklist from the same AI
 * report; a divergence here would silently make batch output differ from a
 * hand-confirmed chapter.
 */

export type ReviewSeverity = 'error' | 'warning' | 'pass' | 'unknown'

/** One issue row as it appears in a stored review report. */
export interface ReviewIssue {
  category: string
  severity: ReviewSeverity
  goalId?: string
  description: string
  /** Verbatim draft excerpt; required for issues, optional for passes. */
  quote?: string
  stableFactKey?: string
  sourceChapter?: number
}

/** AI-returned JSON review structure. */
export interface ReviewJSON {
  goalReview?: unknown
  items: Array<{
    category: string
    severity: string
    goalId?: string
    description: string
    quote?: string
    stableFactKey?: string
    sourceChapter?: number
  }>
  summary: string
}

/**
 * Canonical review dimensions. Prompt labels stay in the project writing
 * language; per-locale display copy belongs to the UI layer.
 */
export const REVIEW_FOCUS_DIMENSIONS = [
  { key: 'continuity', promptLabel: '剧情连贯性' },
  { key: 'logic', promptLabel: '剧情合理性' },
  { key: 'character', promptLabel: '角色状态' },
  { key: 'foreshadow', promptLabel: '前后章节串联' },
] as const

/** The default focus string sent when the author touches no dimension toggle. */
export function defaultReviewFocus(): string {
  return REVIEW_FOCUS_DIMENSIONS.map(dimension => dimension.promptLabel).join('、')
}

/**
 * The checklist default shown before any author edit: general issues the model
 * flagged are included, chapter-goal rows and unverified items are not.
 * Chapter goals describe the blueprint the writer already followed, so an
 * automatic rewrite from them is more likely to corrupt prose than to fix it.
 */
export function defaultReviewDecision(
  item: { goalId?: string; severity: ReviewSeverity },
): 'apply' | 'ignore' {
  return !item.goalId && (item.severity === 'error' || item.severity === 'warning')
    ? 'apply'
    : 'ignore'
}

/** Normalize a severity value coming from a model or a legacy report. */
export function normalizeReviewSeverity(raw: unknown): ReviewSeverity {
  const value = typeof raw === 'string' ? raw.toLowerCase().trim() : ''
  if (value === 'error' || value === 'critical' || value === 'severe') return 'error'
  if (value === 'warning' || value === 'warn' || value === 'minor') return 'warning'
  if (value === 'pass') return 'pass'
  return 'unknown'
}

/** Try to extract JSON, tolerating ```json fences and surrounding prose. */
export function extractReviewJSON(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) return trimmed

  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/)
  if (codeBlockMatch) return codeBlockMatch[1].trim()

  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1)
  }

  return null
}

/** Legacy markdown parser kept for review reports stored before JSON output. */
function parseLegacyReport(
  text: string,
  fallbackCategory: string,
): { issues: ReviewIssue[]; summary: string } {
  const issues: ReviewIssue[] = []
  const lines = text.split('\n')
  let currentCategory = fallbackCategory
  const summaryLines: string[] = []
  let inSummary = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const headingMatch = trimmed.match(/^#{2,3}\s+(.+)/)
    if (headingMatch) {
      const heading = headingMatch[1].replace(/[*_]/g, '')
      if (/总体评价|总结|总评/.test(heading)) {
        inSummary = true
      } else {
        inSummary = false
        currentCategory = heading
      }
      continue
    }

    if (inSummary) {
      summaryLines.push(trimmed.replace(/^[-*]\s*/, ''))
      continue
    }

    let severity: ReviewSeverity = 'pass'
    if (trimmed.includes('🔴')) severity = 'error'
    else if (trimmed.includes('🟡')) severity = 'warning'
    else if (trimmed.includes('🟢') || trimmed.includes('✅')) severity = 'pass'
    else if (trimmed.startsWith('-') || trimmed.startsWith('*')) severity = 'warning'
    else continue

    const cleanDesc = trimmed
      .replace(/^[-*]\s*/, '')
      .replace(/[🔴🟡🟢✅]\s*/gu, '')
      .replace(/\*\*/g, '')

    if (cleanDesc) {
      issues.push({ category: currentCategory, severity, description: cleanDesc })
    }
  }

  return { issues, summary: summaryLines.join(' ') }
}

/** Parse a stored review report, preferring JSON and falling back to legacy text. */
export function parseReviewReport(
  text: string,
  fallbackCategory: string,
): { issues: ReviewIssue[]; summary: string; goalReview?: ChapterGoalReview } {
  const jsonStr = extractReviewJSON(text)
  if (jsonStr) {
    try {
      const data = JSON.parse(jsonStr) as ReviewJSON
      if (data.items && Array.isArray(data.items)) {
        const issues: ReviewIssue[] = data.items.map(item => ({
          category: item.category || fallbackCategory,
          severity: normalizeReviewSeverity(item.severity),
          goalId: item.goalId,
          description: item.description || '',
          quote: item.quote || undefined,
          stableFactKey: item.stableFactKey || undefined,
          sourceChapter: Number.isSafeInteger(item.sourceChapter) && Number(item.sourceChapter) > 0
            ? Number(item.sourceChapter)
            : undefined,
        }))
        return {
          issues,
          summary: data.summary || '',
          goalReview: parseChapterGoalReview(data.goalReview) ?? undefined,
        }
      }
    } catch {
      // Fall through to the legacy parser.
    }
  }

  return parseLegacyReport(text, fallbackCategory)
}

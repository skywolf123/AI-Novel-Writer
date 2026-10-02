import type { ExpectedDraftSource } from './ipc-channels'
import {
  createHumanConfirmedReviewSnapshot,
  hasIncludedReviewWork,
  type HumanConfirmedReviewItem,
  type HumanConfirmedReviewSnapshot,
} from './human-confirmed-review'
import { defaultReviewDecision, parseReviewReport } from './review-report'

/**
 * Builds the same confirmation snapshot the review screen would produce when
 * the author accepts every default and adds no guidance. Used by the headless
 * batch pipeline so an automatic chapter derives its checklist from the same
 * defaults as a hand-confirmed one.
 */
export function buildDefaultConfirmedReviewSnapshot(input: {
  sourceReviewId: number
  sourceDraft: ExpectedDraftSource
  /** Persisted review record content (the JSON the review command stored). */
  reportContent: string
  fallbackCategory: string
}): HumanConfirmedReviewSnapshot | null {
  const parsed = parseReviewReport(input.reportContent, input.fallbackCategory)
  const items: HumanConfirmedReviewItem[] = parsed.issues.map(issue => ({
    category: issue.category,
    severity: issue.severity,
    description: issue.description,
    ...(issue.quote?.trim() ? { quote: issue.quote.trim() } : {}),
    ...(issue.stableFactKey ? { stableFactKey: issue.stableFactKey } : {}),
    ...(issue.sourceChapter ? { sourceChapter: issue.sourceChapter } : {}),
    ...(issue.goalId ? { goalId: issue.goalId } : {}),
    decision: defaultReviewDecision({ goalId: issue.goalId, severity: issue.severity }),
    origin: 'ai',
  }))

  return createHumanConfirmedReviewSnapshot({
    sourceReviewId: input.sourceReviewId,
    sourceDraft: input.sourceDraft,
    summary: parsed.summary,
    authorGuidance: '',
    ...(parsed.goalReview ? { goalReview: parsed.goalReview } : {}),
    items,
  })
}

/** True when the default checklist actually asks the refiner to change prose. */
export function defaultSnapshotHasWork(snapshot: HumanConfirmedReviewSnapshot | null): boolean {
  return snapshot ? hasIncludedReviewWork(snapshot) : false
}

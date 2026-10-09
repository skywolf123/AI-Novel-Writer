import { describe, expect, it } from 'vitest'

import {
  buildReviewCarryover,
  carryoverCandidates,
  classifyCarryover,
  evidenceKey,
  markRecurringKeys,
  type ReviewCarryover,
} from '../review-convergence'
import { normalizeEvidence } from '../review-shards'

const ORIGINAL = [
  '林岚把信收进抽屉，转身走出了档案室。',
  '周砚在渡口等了整整一夜，天亮时才离开。',
].join('\n')

function previousItem(overrides: Partial<{
  category: string
  severity: string
  description: string
  quote: string
  status?: unknown
}> = {}): Record<string, unknown> {
  return {
    category: '剧情连贯性',
    severity: 'error',
    description: '信的去向前后矛盾',
    quote: '林岚把信收进抽屉',
    ...overrides,
  }
}

describe('review convergence', () => {
  it('normalizes evidence the same way the shard dedupe does', () => {
    expect(normalizeEvidence('林岚，把信 收进！抽屉……')).toBe(
      normalizeEvidence('林岚把信收进抽屉'),
    )
    expect(evidenceKey('剧情连贯性', '林岚，把信 收进！抽屉……')).toBe(
      evidenceKey('剧情连贯性', '林岚把信收进抽屉'),
    )
  })

  it('keeps only evidenced error/warning rows as carryover candidates', () => {
    const candidates = carryoverCandidates([
      previousItem(),
      previousItem({ severity: 'pass', quote: undefined }),
      previousItem({ category: '本章目标', severity: 'unknown', quote: '目标未完成', description: '目标' }),
      previousItem({ quote: '' }),
      previousItem({ description: undefined }),
    ])
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.quote).toBe('林岚把信收进抽屉')
  })

  it('classifies a quote still present as recurring and an altered one as resolved', () => {
    const entries = classifyCarryover([{
      category: '剧情连贯性',
      severity: 'error',
      description: '信的去向前后矛盾',
      quote: '林岚把信收进抽屉，转身走出了档案室。',
    }], ORIGINAL)
    expect(entries[0]?.status).toBe('recurring')

    const edited = classifyCarryover([{
      category: '剧情连贯性',
      severity: 'error',
      description: '信的去向前后矛盾',
      quote: '林岚把信收进抽屉，转身走出了档案室。',
    }], '林岚将信锁进抽屉，随即离开档案室。')
    expect(edited[0]?.status).toBe('resolved')
  })

  it('tolerates punctuation-only edits before declaring a quote resolved', () => {
    const entries = classifyCarryover([{
      category: '剧情连贯性',
      severity: 'warning',
      description: '句子节奏',
      quote: '周砚在渡口等了整整一夜，天亮时才离开。',
    }], '周砚在渡口等了整整一夜，天亮时才离开！')
    expect(entries[0]?.status).toBe('recurring')
  })

  it('builds no carryover when the previous report has no evidenced findings', () => {
    expect(buildReviewCarryover(
      { id: 9, reviewIndex: 3, items: [previousItem({ severity: 'pass', quote: undefined })] },
      ORIGINAL,
    )).toBeNull()
  })

  it('builds a carryover block with deterministic counts', () => {
    const carryover = buildReviewCarryover({
      id: 9,
      reviewIndex: 3,
      items: [
        previousItem(),
        previousItem({ quote: '周砚在渡口等了整整一夜', description: '等待时长与后文矛盾', category: '角色状态' }),
      ],
    }, '林岚把信收进抽屉，转身走出了档案室。')

    expect(carryover).not.toBeNull()
    expect(carryover?.sourceReviewId).toBe(9)
    expect(carryover?.sourceReviewIndex).toBe(3)
    expect(carryover?.recurringCount).toBe(1)
    expect(carryover?.resolvedCount).toBe(1)
    expect(carryover?.items.find(item => item.status === 'recurring')?.category).toBe('剧情连贯性')
    expect(carryover?.items.find(item => item.status === 'resolved')?.category).toBe('角色状态')
  })

  it('marks current findings that repeat a previous evidence key', () => {
    const carryover: ReviewCarryover = {
      sourceReviewId: 9,
      sourceReviewIndex: 3,
      resolvedCount: 0,
      recurringCount: 1,
      items: [{
        category: '剧情连贯性',
        severity: 'error',
        description: '信的去向前后矛盾',
        quote: '林岚把信收进抽屉',
        status: 'recurring',
      }],
      recurringKeys: [],
    }
    const currentItems = [
      { category: '剧情连贯性', severity: 'error', quote: '林岚，把信 收进抽屉' },
      { category: '剧情连贯性', severity: 'warning', quote: '完全不同的一句新引用' },
      { category: '剧情连贯性', severity: 'error' },
    ]
    markRecurringKeys(carryover, currentItems)
    expect(carryover.recurringKeys).toEqual([evidenceKey('剧情连贯性', '林岚把信收进抽屉')])
  })

  it('skips goal rows and non-evidenced severities when marking repeated findings', () => {
    const carryover: ReviewCarryover = {
      sourceReviewId: 9,
      sourceReviewIndex: 3,
      resolvedCount: 0,
      recurringCount: 1,
      items: [{
        category: '剧情连贯性',
        severity: 'error',
        description: '信的去向前后矛盾',
        quote: '林岚把信收进抽屉',
        status: 'recurring',
      }],
      recurringKeys: [],
    }
    const currentItems = [
      // 本章目标行：即使 category + quote 同键也不参与（goalId 行不标记）
      { goalId: 'g1', category: '剧情连贯性', severity: 'error', quote: '林岚把信收进抽屉' },
      // pass 行不参与
      { category: '剧情连贯性', severity: 'pass', quote: '林岚把信收进抽屉' },
      // 待核实行不参与
      { category: '剧情连贯性', severity: 'unknown', quote: '林岚把信收进抽屉' },
    ]
    markRecurringKeys(carryover, currentItems)
    expect(carryover.recurringKeys).toEqual([])
  })

  it('records a repeated evidence key only once', () => {
    const carryover: ReviewCarryover = {
      sourceReviewId: 9,
      sourceReviewIndex: 3,
      resolvedCount: 0,
      recurringCount: 1,
      items: [{
        category: '剧情连贯性',
        severity: 'error',
        description: '信的去向前后矛盾',
        quote: '林岚把信收进抽屉',
        status: 'recurring',
      }],
      recurringKeys: [],
    }
    markRecurringKeys(carryover, [
      { category: '剧情连贯性', severity: 'error', quote: '林岚把信收进抽屉' },
      { category: '剧情连贯性', severity: 'error', quote: '林岚把信收进抽屉' },
    ])
    expect(carryover.recurringKeys).toEqual([evidenceKey('剧情连贯性', '林岚把信收进抽屉')])
  })
})

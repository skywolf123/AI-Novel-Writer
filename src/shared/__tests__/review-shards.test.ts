import { describe, expect, it } from 'vitest'

import {
  dedupeReviewItems,
  parseShardReviewItems,
  routeReviewShards,
  shardReviewFocus,
  synthesizeReviewSummary,
} from '../review-shards'

describe('routeReviewShards', () => {
  it('runs all shards for an empty focus (programmatic default)', () => {
    expect(routeReviewShards(undefined)).toEqual({ continuity: true, logic: true })
    expect(routeReviewShards('')).toEqual({ continuity: true, logic: true })
  })

  it('routes the author-checked dimensions to their shards', () => {
    expect(routeReviewShards('剧情连贯性、剧情合理性、角色状态、前后章节串联')).toEqual({
      continuity: true,
      logic: true,
    })
    expect(routeReviewShards('剧情连贯性、前后章节串联')).toEqual({ continuity: true, logic: false })
    expect(routeReviewShards('剧情合理性、角色状态')).toEqual({ continuity: false, logic: true })
  })
})

describe('shardReviewFocus', () => {
  it('keeps only the labels belonging to the shard', () => {
    expect(shardReviewFocus('剧情连贯性、剧情合理性、角色状态、前后章节串联', 'continuity'))
      .toBe('剧情连贯性、前后章节串联')
    expect(shardReviewFocus('剧情连贯性、剧情合理性、角色状态、前后章节串联', 'logic'))
      .toBe('剧情合理性、角色状态')
    expect(shardReviewFocus('剧情连贯性', 'narration')).toBe('')
  })
})

describe('parseShardReviewItems', () => {
  it('parses a valid items-only payload and bounds text fields', () => {
    const raw = JSON.stringify({
      items: [{
        category: '剧情连贯性',
        severity: 'error',
        quote: '原句'.repeat(100),
        description: '问题描述'.repeat(80),
      }],
    })
    const items = parseShardReviewItems(raw)
    expect(items).toHaveLength(1)
    expect(items[0]?.quote?.length).toBeLessThanOrEqual(160)
    expect(items[0]?.description.length).toBeLessThanOrEqual(200)
  })

  it('accepts a fenced json block and pass items without quote', () => {
    const raw = '```json\n' + JSON.stringify({
      items: [{ category: '剧情连贯性', severity: 'pass', description: '未发现问题' }],
    }) + '\n```'
    expect(parseShardReviewItems(raw)).toHaveLength(1)
  })

  it('rejects extra root fields, wrong severity, and error items without quote', () => {
    expect(() => parseShardReviewItems(JSON.stringify({
      items: [], summary: '多余字段',
    }))).toThrow()
    expect(() => parseShardReviewItems(JSON.stringify({
      items: [{ category: 'c', severity: 'critical', description: 'd' }],
    }))).toThrow()
    expect(() => parseShardReviewItems(JSON.stringify({
      items: [{ category: 'c', severity: 'error', description: '缺 quote' }],
    }))).toThrow()
    expect(() => parseShardReviewItems('不是 JSON')).toThrow()
  })
})

describe('dedupeReviewItems', () => {
  const item = (overrides: Partial<Parameters<typeof dedupeReviewItems>[0][number]>) => ({
    category: '剧情连贯性',
    severity: 'warning' as const,
    description: '描述',
    ...overrides,
  })

  it('keeps the more severe duplicate and preserves unique items', () => {
    const sameQuote = '他说他昨天到过现场。'
    const merged = dedupeReviewItems([
      item({ category: '剧情连贯性', severity: 'warning', quote: sameQuote, description: 'A 分片的表述' }),
      item({ category: '剧情连贯性', severity: 'error', quote: sameQuote, description: 'B 分片的表述' }),
      item({ category: '剧情合理性', severity: 'warning', quote: sameQuote, description: '不同维度不去重' }),
    ])
    expect(merged.filter(entry => entry.category === '剧情连贯性')).toHaveLength(1)
    expect(merged.find(entry => entry.category === '剧情连贯性')?.severity).toBe('error')
    expect(merged).toHaveLength(2)
  })

  it('falls back to description when quote is absent', () => {
    const merged = dedupeReviewItems([
      item({ severity: 'pass', description: '未发现问题。' }),
      item({ severity: 'pass', description: '未发现问题' }),
    ])
    expect(merged).toHaveLength(1)
  })
})

describe('synthesizeReviewSummary', () => {
  it('summarizes by severity counts', () => {
    const items = [
      { category: 'a', severity: 'error' as const, description: '' },
      { category: 'b', severity: 'warning' as const, description: '' },
    ]
    expect(synthesizeReviewSummary(items, 'zh-CN')).toBe('发现 1 处严重问题、1 处轻微不一致。')
    expect(synthesizeReviewSummary([], 'zh-CN')).toBe('各检查维度未发现问题。')
    expect(synthesizeReviewSummary(items, 'en-US')).toContain('1 critical')
  })
})

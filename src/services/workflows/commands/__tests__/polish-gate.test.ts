import { describe, expect, it } from 'vitest'
import { GenerationHarnessError } from '../../../generation/generation-harness'
import {
  applySpotPatches,
  decidePolishGate,
  isSessionBudgetExhausted,
  parsePolishGateJson,
  parseSpotPatches,
} from '../polish-gate'

const CLEAN = '他把刀收回鞘里，转身走出巷子。雨停了，他加快脚步走向城南的渡口。'.repeat(20)
const DIRTY = '空气仿佛凝固了，他的眼中闪过一丝惊讶，嘴角勾起一抹冷笑。'.repeat(20)

describe('parsePolishGateJson', () => {
  it('parses a clean verdict object', () => {
    const report = parsePolishGateJson(JSON.stringify({
      verdict: 'spot',
      problems: [{ type: 'ai-flavor', scope: 'local', quote: '空气仿佛凝固了', suggestion: '改为具体动作' }],
    }))
    expect(report).toMatchObject({ verdict: 'spot', degraded: false })
    expect(report.problems[0]).toMatchObject({ type: 'ai-flavor', scope: 'local' })
  })

  it('strips code fences and surrounding chatter', () => {
    const raw = '好的，以下是判定结果：\n```json\n{"verdict":"pass","problems":[]}\n```\n以上。'
    expect(parsePolishGateJson(raw)).toMatchObject({ verdict: 'pass', degraded: false })
  })

  it('degrades on malformed JSON or unknown verdict', () => {
    expect(parsePolishGateJson(null).degraded).toBe(true)
    expect(parsePolishGateJson('完全不是 JSON').degraded).toBe(true)
    expect(parsePolishGateJson('{"verdict":"maybe","problems":[]}').degraded).toBe(true)
    expect(parsePolishGateJson('{"verdict":"spot","problems":[]}').verdict).toBe('spot')
  })

  it('drops local problems without a quote and clamps the list', () => {
    const problems = Array.from({ length: 12 }, (_, i) => ({
      type: `t${i}`,
      scope: 'local',
      quote: i < 10 ? `问题句${i}` : undefined,
    }))
    const report = parsePolishGateJson(JSON.stringify({ verdict: 'spot', problems }))
    expect(report.problems.length).toBeLessThanOrEqual(8)
    expect(report.problems.every(problem => problem.quote)).toBe(true)
  })
})

describe('decidePolishGate', () => {
  function input(overrides: Partial<Parameters<typeof decidePolishGate>[0]> = {}) {
    return {
      sourceText: CLEAN,
      candidateText: CLEAN,
      round: 1 as const,
      llmRaw: JSON.stringify({ verdict: 'pass', problems: [] }),
      locale: 'zh-CN' as const,
      ...overrides,
    }
  }

  it('passes when both signals are clean', () => {
    expect(decidePolishGate(input()).action).toBe('pass')
  })

  it('routes to full re-polish on a round-1 global verdict', () => {
    const decision = decidePolishGate(input({
      llmRaw: JSON.stringify({
        verdict: 'full',
        problems: [{ type: 'rhythm', scope: 'global', suggestion: '节奏拖沓' }],
      }),
    }))
    expect(decision.action).toBe('full-repolish')
    expect(decision.problems.join('\n')).toContain('〔节奏·全局〕')
  })

  it('downgrades full to spot-fix at gate 2', () => {
    const decision = decidePolishGate(input({
      round: 2,
      llmRaw: JSON.stringify({ verdict: 'full', problems: [{ type: 'rhythm', scope: 'global' }] }),
    }))
    expect(decision.action).toBe('spot-fix')
    expect(decision.notes.join(' ')).toContain('定点修复')
  })

  it('routes to spot-fix for local problems on a clean deterministic check', () => {
    const decision = decidePolishGate(input({
      llmRaw: JSON.stringify({
        verdict: 'spot',
        problems: [{ type: 'dialogue', scope: 'local', quote: '他说道：你好。' }],
      }),
    }))
    expect(decision.action).toBe('spot-fix')
    expect(decision.problems.join('\n')).toContain('他说道')
  })

  it('deterministic issues force spot-fix even when the LLM passes', () => {
    const decision = decidePolishGate(input({ candidateText: DIRTY }))
    expect(decision.action).toBe('spot-fix')
    expect(decision.deterministic.issues.length).toBeGreaterThan(0)
  })

  it('deterministic regression overrides an LLM pass verdict', () => {
    const decision = decidePolishGate(input({ candidateText: DIRTY + CLEAN }))
    expect(decision.comparison.regressed).toBe(true)
    expect(decision.action).toBe('spot-fix')
    expect(decision.notes.join(' ')).toContain('覆盖')
  })

  it('falls back to deterministic-only when the gate LLM fails', () => {
    const clean = decidePolishGate(input({ llmRaw: null }))
    expect(clean.action).toBe('pass')
    expect(clean.llm.degraded).toBe(true)
    const dirty = decidePolishGate(input({ llmRaw: 'broken', candidateText: DIRTY }))
    expect(dirty.action).toBe('spot-fix')
  })
})

describe('isSessionBudgetExhausted', () => {
  it('recognizes session-level budget exhaustion codes', () => {
    expect(isSessionBudgetExhausted(new GenerationHarnessError(
      'ATTEMPT_BUDGET_EXHAUSTED',
      '生成会话已用尽请求次数。',
    ))).toBe(true)
    expect(isSessionBudgetExhausted(new GenerationHarnessError(
      'DEADLINE_EXHAUSTED',
      '生成会话已超过截止时间。',
    ))).toBe(true)
  })

  it('does not short-circuit on transient provider failures', () => {
    expect(isSessionBudgetExhausted(new GenerationHarnessError(
      'PROVIDER_REQUEST_FAILED',
      '模型请求失败。',
    ))).toBe(false)
    expect(isSessionBudgetExhausted(new Error('网络错误'))).toBe(false)
    expect(isSessionBudgetExhausted(null)).toBe(false)
  })
})

describe('parseSpotPatches / applySpotPatches', () => {
  it('parses tolerant patch JSON and rejects trivial finds', () => {
    const patches = parseSpotPatches('```json\n{"patches":[{"find":"空气仿佛凝固了","replace":"巷子里静得可怕"},{"find":"ab","replace":"x"}]}\n```')
    expect(patches).toEqual([{ find: '空气仿佛凝固了', replace: '巷子里静得可怕' }])
    expect(parseSpotPatches('不是 JSON')).toEqual([])
    expect(parseSpotPatches('{"patches":[]}')).toEqual([])
  })

  it('applies exact matches once and counts misses', () => {
    const text = '第一段空气仿佛凝固了。第二段一切如常。'
    const result = applySpotPatches(text, [
      { find: '空气仿佛凝固了', replace: '巷子里静得可怕' },
      { find: '这段文字不存在', replace: '无所谓' },
    ])
    expect(result.applied).toBe(1)
    expect(result.missed).toBe(1)
    expect(result.text).toBe('第一段巷子里静得可怕。第二段一切如常。')
  })

  it('replaces only the first occurrence of a duplicated find', () => {
    const result = applySpotPatches('重复重复重复', [{ find: '重复重复', replace: 'X' }])
    expect(result.text).toBe('X重复')
  })
})

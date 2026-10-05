import {
  compareProseQuality,
  proseIssueLabel,
  summarizeProseIssues,
  type ProseQualityComparison,
  type ProseQualityReport,
} from '../../../shared/prose-quality'

/**
 * AI 润色门控：合成「确定性质量检查」与「LLM 文笔门控」两路信号，
 * 输出唯一的下一步动作判定。LLM 门控输出损坏时自动降级为纯确定性
 * 判定——门控故障不允许中断润色流程。
 */

export type PolishGateLLMVerdict = 'pass' | 'full' | 'spot'
export type PolishGateAction = 'pass' | 'full-repolish' | 'spot-fix'

export interface PolishGateProblem {
  type: string
  scope: 'global' | 'local'
  quote?: string
  suggestion?: string
}

export interface PolishGateLLMReport {
  verdict: PolishGateLLMVerdict
  problems: PolishGateProblem[]
  /** true = LLM 输出不可解析，已降级为纯确定性判定 */
  degraded: boolean
}

export interface PolishGateInput {
  /** 原稿（确定性回退对比基准） */
  sourceText: string
  /** 本轮候选稿 */
  candidateText: string
  /** 门控轮次：G1=1（允许 full-repolish），G2=2（只允许 pass/spot-fix） */
  round: 1 | 2
  /** LLM 门控原始输出；null 表示调用失败 */
  llmRaw: string | null
  locale: 'zh-CN' | 'en-US'
}

export interface PolishGateDecision {
  action: PolishGateAction
  llm: PolishGateLLMReport
  deterministic: ProseQualityReport
  comparison: ProseQualityComparison
  /** 可定位的问题清单（定点修复 prompt 与日志共用） */
  problems: string[]
  /** 决策说明，供 callbacks.log */
  notes: string[]
}

const MAX_GATE_PROBLEMS = 8
const MIN_PATCH_FIND_LENGTH = 6
const MAX_PATCHES = 16

function stripCodeFences(raw: string): string {
  return raw
    .replace(/^[\s\S]*?```(?:json)?\s*\n?/u, match => (match.includes('```') ? '' : match))
    .replace(/```\s*[\s\S]*$/u, '')
    .trim()
}

/** 宽容解析 LLM 门控 JSON：剥代码围栏、截取首个完整 JSON 对象、逐字段校验 */
export function parsePolishGateJson(raw: string | null): PolishGateLLMReport {
  if (!raw) return { verdict: 'spot', problems: [], degraded: true }
  const candidate = stripCodeFences(raw)
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return { verdict: 'spot', problems: [], degraded: true }
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as {
      verdict?: unknown
      problems?: unknown
    }
    if (parsed.verdict !== 'pass' && parsed.verdict !== 'full' && parsed.verdict !== 'spot') {
      return { verdict: 'spot', problems: [], degraded: true }
    }
    const rawProblems = Array.isArray(parsed.problems) ? parsed.problems : []
    const problems: PolishGateProblem[] = []
    for (const entry of rawProblems.slice(0, MAX_GATE_PROBLEMS)) {
      if (typeof entry !== 'object' || entry === null) continue
      const record = entry as Record<string, unknown>
      const type = typeof record.type === 'string' ? record.type.slice(0, 60) : 'unknown'
      const scope = record.scope === 'global' ? 'global' : 'local'
      const quote = typeof record.quote === 'string' ? record.quote.slice(0, 160) : undefined
      const suggestion = typeof record.suggestion === 'string' ? record.suggestion.slice(0, 120) : undefined
      if (scope === 'local' && !quote) continue
      problems.push({ type, scope, ...(quote ? { quote } : {}), ...(suggestion ? { suggestion } : {}) })
    }
    return { verdict: parsed.verdict, problems, degraded: false }
  } catch {
    return { verdict: 'spot', problems: [], degraded: true }
  }
}

/**
 * 合成两路信号得到下一步动作：
 * 1. LLM 判 full 且处于 G1 → 全篇重润（G2 起降级为局部修正）
 * 2. 两路都干净 → 通过
 * 3. 其余（LLM 判 spot、确定性有命中、或确定性回退覆盖 LLM 的 pass）→ 局部修正
 */
export function decidePolishGate(input: PolishGateInput): PolishGateDecision {
  const llm = parsePolishGateJson(input.llmRaw)
  const comparison = compareProseQuality(input.sourceText, input.candidateText)
  const deterministic = comparison.revision
  // 降级报告不携带任何 LLM 信号：verdict 视为中性，只按确定性结果判定
  const effectiveVerdict: PolishGateLLMVerdict = llm.degraded ? 'pass' : llm.verdict

  const notes: string[] = []
  if (llm.degraded) {
    notes.push(input.locale === 'en-US'
      ? 'Gate LLM output unusable; degraded to deterministic-only verdict.'
      : '门控 LLM 输出不可解析，已降级为纯确定性判定。')
  }
  if (comparison.regressed) {
    const kinds = comparison.worsenedKinds
      .map(kind => proseIssueLabel(kind, input.locale))
      .join(', ')
    notes.push(input.locale === 'en-US'
      ? `Deterministic quality regressed versus the source draft (${kinds}).`
      : `确定性质量指标较原稿回退（${kinds}）。`)
  }

  if (input.round >= 2 && effectiveVerdict === 'full') {
    llm.verdict = 'spot'
    notes.push(input.locale === 'en-US'
      ? 'Full re-polish is unavailable after round 2; downgraded to spot-fix.'
      : '第二轮起不再允许全篇重润，已降级为定点修复。')
  }

  const deterministicIssues = summarizeProseIssues(deterministic, input.locale)
  const llmLocalProblems = llm.problems.filter(problem => problem.scope === 'local')
  const hasLocalIssues = deterministicIssues.length > 0 || llmLocalProblems.length > 0
  const localizedProblemType = (type: string) => {
    const labels: Record<string, { zhCN: string; enUS: string }> = {
      'ai-flavor': { zhCN: 'AI 痕迹', enUS: 'AI flavor' },
      rhythm: { zhCN: '节奏', enUS: 'rhythm' },
      dialogue: { zhCN: '对话', enUS: 'dialogue' },
      ending: { zhCN: '结尾', enUS: 'ending' },
      completeness: { zhCN: '完整性', enUS: 'completeness' },
    }
    return labels[type] ? (input.locale === 'en-US' ? labels[type]!.enUS : labels[type]!.zhCN) : type
  }

  let action: PolishGateAction
  if (effectiveVerdict === 'full' && input.round === 1) {
    action = 'full-repolish'
  } else if (effectiveVerdict === 'pass' && !hasLocalIssues && !comparison.regressed) {
    action = 'pass'
  } else {
    action = 'spot-fix'
    if (effectiveVerdict === 'pass' && comparison.regressed) {
      notes.push(input.locale === 'en-US'
        ? 'Deterministic regression overrides the LLM pass verdict.'
        : '确定性回退判定覆盖了 LLM 的通过判定。')
    }
  }

  const problems: string[] = [...deterministicIssues]
  for (const problem of llmLocalProblems) {
    const suggestion = problem.suggestion
      ? (input.locale === 'en-US' ? ` (${problem.suggestion})` : `（${problem.suggestion}）`)
      : ''
    problems.push(`- 〔${localizedProblemType(problem.type)}〕"${problem.quote}"${suggestion}`)
  }
  if (action === 'full-repolish') {
    for (const problem of llm.problems.filter(p => p.scope === 'global')) {
      const suggestion = problem.suggestion
        ? (input.locale === 'en-US' ? ` (${problem.suggestion})` : `（${problem.suggestion}）`)
        : ''
      problems.push(`- 〔${localizedProblemType(problem.type)}·全局〕${suggestion || localizedProblemType(problem.type)}`)
    }
  }

  return { action, llm, deterministic, comparison, problems: problems.slice(0, MAX_GATE_PROBLEMS), notes }
}

export interface SpotPatch {
  find: string
  replace: string
}

export interface SpotPatchApplyResult {
  text: string
  applied: number
  missed: number
}

/** 宽容解析定点修复补丁 JSON：{"patches":[{"find":"…","replace":"…"}]} */
export function parseSpotPatches(raw: string): SpotPatch[] {
  const candidate = stripCodeFences(raw)
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as { patches?: unknown }
    if (!Array.isArray(parsed.patches)) return []
    const patches: SpotPatch[] = []
    for (const entry of parsed.patches.slice(0, MAX_PATCHES)) {
      if (typeof entry !== 'object' || entry === null) continue
      const record = entry as Record<string, unknown>
      if (typeof record.find !== 'string' || typeof record.replace !== 'string') continue
      if (record.find.length < MIN_PATCH_FIND_LENGTH) continue
      patches.push({ find: record.find, replace: record.replace })
    }
    return patches
  } catch {
    return []
  }
}

/**
 * 逐字精确匹配应用补丁；未命中的补丁直接丢弃并计数，
 * 机械保证「只动问题区」。
 */
export function applySpotPatches(text: string, patches: SpotPatch[]): SpotPatchApplyResult {
  let result = text
  let applied = 0
  let missed = 0
  for (const patch of patches) {
    const index = result.indexOf(patch.find)
    if (index < 0) {
      missed += 1
      continue
    }
    result = result.slice(0, index) + patch.replace + result.slice(index + patch.find.length)
    applied += 1
  }
  return { text: result, applied, missed }
}

export const POLISH_GATE_LIMITS = Object.freeze({
  maxGateProblems: MAX_GATE_PROBLEMS,
  minPatchFindLength: MIN_PATCH_FIND_LENGTH,
  maxPatches: MAX_PATCHES,
})

/** 会话级预算耗尽（Token/次数/截止时间）：后续轮必然同样失败，调用方应短路。 */
export function isSessionBudgetExhausted(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'REQUESTED_TOKEN_BUDGET_EXHAUSTED'
    || code === 'ATTEMPT_BUDGET_EXHAUSTED'
    || code === 'DEADLINE_EXHAUSTED'
}

/**
 * 确定性正文质量分析（AI 润色门控的第一路信号）。
 *
 * 纯函数、无 IO、零 LLM 成本：对正文做正则/统计层面的「AI 味」扫描，
 * 输出带命中次数与原文样例的问题清单，并给出可与历史最优稿比较的
 * 加权扣分。润色门控据此判定「回退即停」，LLM 文笔门控只负责确定性
 * 检查覆盖不到的工艺维度（节奏、钩子、对话）。
 *
 * 指标以中文网文为主要标定对象；英文项目下多数指标天然为零，
 * 此时门控自动退化为仅依赖 LLM 文笔判定。
 */

export type ProseIssueKind =
  | 'ai-marker'
  | 'emotional-telling'
  | 'explanatory-voice'
  | 'transition-pileup'
  | 'le-pileup'
  | 'paragraph-monotony'
  | 'dramatic-punctuation'
  | 'summary-ending'

export interface ProseIssue {
  kind: ProseIssueKind
  /** 命中次数（段落类问题=命中段落数；单调类问题=0 或 1） */
  count: number
  /** 最多 3 条原文样例，供日志与定点修复定位 */
  samples: string[]
}

export interface ProseQualityReport {
  /** 可见文字单元数（与 refinement-completeness 同口径的近似） */
  units: number
  issues: ProseIssue[]
  /** 每千文字单元加权扣分，越低越好 */
  score: number
}

export interface ProseQualityComparison {
  source: ProseQualityReport
  revision: ProseQualityReport
  /** 修订稿质量显著差于原稿 */
  regressed: boolean
  /** 比原稿恶化的问题类别（用于日志与判定说明） */
  worsenedKinds: ProseIssueKind[]
}

const MAX_SAMPLES_PER_ISSUE = 3
const SAMPLE_CONTEXT_CHARS = 8

/** AI 高频词/桥段（中文；出现即记一次命中） */
const AI_MARKER_PATTERNS: readonly RegExp[] = [
  /仿佛/g,
  /宛如/g,
  /恍若/g,
  /犹如/g,
  /竟然/g,
  /居然/g,
  /一丝/g,
  /一抹/g,
  /涌上心头/g,
  /心中一紧/g,
  /心中一颤/g,
  /眼底闪过/g,
  /眼中闪过/g,
  /嘴角勾起/g,
  /勾起一抹/g,
  /空气仿佛/g,
  /命运的齿轮/g,
  /(?:如同|像|好似)潮水/g,
  /潮水般/g,
  /内心深处/g,
  /不禁/g,
]

/** 情绪直陈/内心弹幕句式 */
const EMOTIONAL_TELLING_PATTERN
  = /(?:感到|觉得)(?:非常|十分|无比|格外|一阵)?(?:愤怒|悲伤|高兴|紧张|害怕|恐惧|惊讶|失望|绝望|兴奋|委屈|羞愧|欣慰|不安)|心中(?:涌起|升起|泛起|浮现)|心里(?:涌起|升起|泛起|一酸|一暖|发苦|发沉)/g

/** 解释腔：叙述者跳出场景，在描写之后解释、总结或点破意义 */
const EXPLANATORY_VOICE_PATTERN
  = /这意味着|这说明|这证明|这暗示|仿佛在(?:告诉|诉说|宣告)|像是在(?:提醒|宣告)|似乎在告诉|(?:昭示|诠释|诉说)着|无疑[是在地]|从某种意义上/g

/** 转折词（含「，却/。却」衔接形式，避免「退却/冷却」误报） */
const TRANSITION_PATTERN = /(但是|可是|然而|不过|(?:[，。！？])却)/g

/** 单句「了」字堆砌阈值：一句内 ≥ 3 处视为堆砌句 */
const LE_PILEUP_PER_SENTENCE = 3
const SENTENCE_SPLIT_PATTERN = /[。！？；…!?;]+/

/** 段落单调判定：段落数下限与长度变异系数上限 */
const MONOTONY_MIN_PARAGRAPHS = 6
const MONOTONY_MIN_PARAGRAPH_UNITS = 20
const MONOTONY_MAX_CV = 0.22

const DRAMATIC_PUNCTUATION_PATTERN = /(……){2,}|—{3,}|\.{6,}|[！？]{3,}/g

/** 结尾总结/升华式收尾的保守特征 */
const SUMMARY_ENDING_PATTERN
  = /注定(?:被|会|将)|载入史册|从这一天(?:起|开始)|从那一夜(?:起|开始)|故事才刚刚开始|新的篇章|(?:这一夜|这一天)，(?:注定|将)/

const ISSUE_WEIGHTS: Readonly<Record<ProseIssueKind, number>> = Object.freeze({
  'ai-marker': 1,
  'emotional-telling': 0.8,
  'explanatory-voice': 0.8,
  'transition-pileup': 0.6,
  'le-pileup': 0.5,
  'paragraph-monotony': 1.2,
  'dramatic-punctuation': 0.5,
  'summary-ending': 1.2,
})

const CHINESE_CHARACTER_PATTERN = /[㐀-䶿一-鿿豈-﫿]/gu
const ENGLISH_WORD_PATTERN = /[A-Za-z]+(?:['’][A-Za-z]+)*/g
const WHITESPACE_OR_PUNCTUATION_PATTERN = /[\s\p{P}\p{S}]/gu

function countVisibleProseUnits(text: string): number {
  const englishWords = text.match(ENGLISH_WORD_PATTERN)?.length ?? 0
  const withoutEnglishWords = text.replace(ENGLISH_WORD_PATTERN, '')
  const chineseCharacters = withoutEnglishWords.match(CHINESE_CHARACTER_PATTERN)?.length ?? 0
  const otherCharacters = withoutEnglishWords
    .replace(CHINESE_CHARACTER_PATTERN, '')
    .replace(WHITESPACE_OR_PUNCTUATION_PATTERN, '')
    .length
  return chineseCharacters + englishWords + otherCharacters
}

/** 摘取命中点附近的原文片段作为样例 */
function captureSamples(text: string, matches: RegExpMatchArray[]): string[] {
  return matches
    .slice(0, MAX_SAMPLES_PER_ISSUE)
    .map((match) => {
      const start = Math.max(0, (match.index ?? 0) - SAMPLE_CONTEXT_CHARS)
      const end = Math.min(text.length, (match.index ?? 0) + match[0].length + SAMPLE_CONTEXT_CHARS)
      return text.slice(start, end).replace(/\s+/gu, ' ').trim()
    })
}

function collectPatternHits(text: string, pattern: RegExp): RegExpMatchArray[] {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  return [...text.matchAll(new RegExp(pattern.source, flags))]
}

function splitParagraphs(text: string): string[] {
  return text.split(/\n+/).map(p => p.trim()).filter(p => p.length > 0)
}

function analyzeAiMarkers(text: string): ProseIssue | null {
  const hits = AI_MARKER_PATTERNS.flatMap(pattern => collectPatternHits(text, pattern))
  if (hits.length === 0) return null
  return {
    kind: 'ai-marker',
    count: hits.length,
    samples: captureSamples(text, hits.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))),
  }
}

function analyzeEmotionalTelling(text: string): ProseIssue | null {
  const hits = collectPatternHits(text, EMOTIONAL_TELLING_PATTERN)
  if (hits.length === 0) return null
  return { kind: 'emotional-telling', count: hits.length, samples: captureSamples(text, hits) }
}

function analyzeExplanatoryVoice(text: string): ProseIssue | null {
  const hits = collectPatternHits(text, EXPLANATORY_VOICE_PATTERN)
  if (hits.length === 0) return null
  return { kind: 'explanatory-voice', count: hits.length, samples: captureSamples(text, hits) }
}

function analyzeTransitions(text: string): ProseIssue | null {
  const hits = collectPatternHits(text, TRANSITION_PATTERN)
  if (hits.length === 0) return null
  return { kind: 'transition-pileup', count: hits.length, samples: captureSamples(text, hits) }
}

function analyzeLePileup(text: string): ProseIssue | null {
  const flagged = text
    .split(SENTENCE_SPLIT_PATTERN)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length > 0 && (sentence.match(/了/g) ?? []).length >= LE_PILEUP_PER_SENTENCE)
  if (flagged.length === 0) return null
  return {
    kind: 'le-pileup',
    count: flagged.length,
    samples: flagged.slice(0, MAX_SAMPLES_PER_ISSUE).map(s => `${s.slice(0, SAMPLE_CONTEXT_CHARS * 2)}…`),
  }
}

function analyzeParagraphMonotony(paragraphs: string[]): ProseIssue | null {
  const lengths = paragraphs
    .map(p => countVisibleProseUnits(p))
    .filter(units => units >= MONOTONY_MIN_PARAGRAPH_UNITS)
  if (lengths.length < MONOTONY_MIN_PARAGRAPHS) return null
  const mean = lengths.reduce((sum, n) => sum + n, 0) / lengths.length
  if (mean <= 0) return null
  const variance = lengths.reduce((sum, n) => sum + (n - mean) ** 2, 0) / lengths.length
  const cv = Math.sqrt(variance) / mean
  if (cv >= MONOTONY_MAX_CV) return null
  return {
    kind: 'paragraph-monotony',
    count: 1,
    samples: paragraphs.slice(0, MAX_SAMPLES_PER_ISSUE).map(p => `${p.slice(0, SAMPLE_CONTEXT_CHARS * 2)}…`),
  }
}

function analyzeDramaticPunctuation(text: string): ProseIssue | null {
  const hits = collectPatternHits(text, DRAMATIC_PUNCTUATION_PATTERN)
  if (hits.length === 0) return null
  return { kind: 'dramatic-punctuation', count: hits.length, samples: captureSamples(text, hits) }
}

function analyzeSummaryEnding(paragraphs: string[]): ProseIssue | null {
  const last = paragraphs.at(-1)
  if (!last) return null
  const match = last.match(SUMMARY_ENDING_PATTERN)
  if (!match) return null
  const tail = last.length > SAMPLE_CONTEXT_CHARS * 4 ? last.slice(-SAMPLE_CONTEXT_CHARS * 4) : last
  return { kind: 'summary-ending', count: 1, samples: [tail] }
}

/** 对正文做完整确定性质量分析 */
export function analyzeProseQuality(text: string): ProseQualityReport {
  const paragraphs = splitParagraphs(text)
  const issues = [
    analyzeAiMarkers(text),
    analyzeEmotionalTelling(text),
    analyzeExplanatoryVoice(text),
    analyzeTransitions(text),
    analyzeLePileup(text),
    analyzeParagraphMonotony(paragraphs),
    analyzeDramaticPunctuation(text),
    analyzeSummaryEnding(paragraphs),
  ].filter((issue): issue is ProseIssue => issue !== null)

  const units = countVisibleProseUnits(text)
  const weighted = issues.reduce((sum, issue) => sum + ISSUE_WEIGHTS[issue.kind] * issue.count, 0)
  const score = units > 0 ? (weighted * 1000) / units : 0
  return { units, issues, score }
}

/** 判定修订稿相对基准是否显著回退（用于 best-so-far 守卫） */
export function compareProseQuality(sourceText: string, revisionText: string): ProseQualityComparison {
  const source = analyzeProseQuality(sourceText)
  const revision = analyzeProseQuality(revisionText)

  const weightByKind = new Map<ProseIssueKind, { source: number; revision: number }>()
  for (const issue of source.issues) {
    weightByKind.set(issue.kind, { source: ISSUE_WEIGHTS[issue.kind] * issue.count, revision: 0 })
  }
  for (const issue of revision.issues) {
    const entry = weightByKind.get(issue.kind) ?? { source: 0, revision: 0 }
    entry.revision = ISSUE_WEIGHTS[issue.kind] * issue.count
    weightByKind.set(issue.kind, entry)
  }
  const worsenedKinds = [...weightByKind.entries()]
    .filter(([, w]) => w.revision > w.source)
    .map(([kind]) => kind)

  const margin = 0.8
  const ratio = 1.3
  const regressed = revision.score > source.score + margin && revision.score > source.score * ratio
  return { source, revision, regressed, worsenedKinds }
}

const ISSUE_LABELS: Readonly<Record<ProseIssueKind, { zhCN: string; enUS: string }>> = Object.freeze({
  'ai-marker': { zhCN: 'AI 高频词', enUS: 'AI marker words' },
  'emotional-telling': { zhCN: '情绪直陈', enUS: 'told-not-shown emotion' },
  'explanatory-voice': { zhCN: '解释腔', enUS: 'narrator explanatory voice' },
  'transition-pileup': { zhCN: '转折词堆砌', enUS: 'transition-word pileup' },
  'le-pileup': { zhCN: '「了」字堆砌', enUS: '"了" pileup' },
  'paragraph-monotony': { zhCN: '段落节奏单调', enUS: 'monotonous paragraph rhythm' },
  'dramatic-punctuation': { zhCN: '标点滥用', enUS: 'dramatic punctuation runs' },
  'summary-ending': { zhCN: '总结升华式结尾', enUS: 'summarizing/uplifting ending' },
})

export function proseIssueLabel(kind: ProseIssueKind, locale: 'zh-CN' | 'en-US'): string {
  return locale === 'en-US' ? ISSUE_LABELS[kind].enUS : ISSUE_LABELS[kind].zhCN
}

/** 把确定性报告渲染成可读问题清单（供日志与定点修复 prompt 使用） */
export function summarizeProseIssues(
  report: ProseQualityReport,
  locale: 'zh-CN' | 'en-US',
): string[] {
  return report.issues.map((issue) => {
    const label = proseIssueLabel(issue.kind, locale)
    const samples = issue.samples.length > 0 ? `（如：${issue.samples.map(s => `"${s}"`).join('、')}）` : ''
    return locale === 'en-US'
      ? `- ${label} ×${issue.count}${samples}`
      : `- ${label} ×${issue.count}${samples}`
  })
}

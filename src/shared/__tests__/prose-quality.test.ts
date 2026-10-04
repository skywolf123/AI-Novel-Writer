import { describe, expect, it } from 'vitest'
import {
  analyzeProseQuality,
  compareProseQuality,
  proseIssueLabel,
  summarizeProseIssues,
} from '../prose-quality'

function issueKinds(text: string) {
  return analyzeProseQuality(text).issues.map(issue => issue.kind)
}

function reportIssues(text: string) {
  return analyzeProseQuality(text).issues
}

describe('analyzeProseQuality', () => {
  it('flags AI marker words with samples', () => {
    const report = analyzeProseQuality('空气仿佛凝固了。他的眼中闪过一丝惊讶，嘴角勾起一抹冷笑。')
    const markers = report.issues.find(issue => issue.kind === 'ai-marker')
    expect(markers).toBeDefined()
    expect(markers!.count).toBeGreaterThanOrEqual(4)
    expect(markers!.samples.length).toBeGreaterThan(0)
    expect(markers!.samples[0]).toContain('空气')
  })

  it('flags emotional telling and transition pileup', () => {
    const text = '她感到十分愤怒。但是事情没有结束，然而更大的麻烦来了，不过她没有退缩。'
    const kinds = issueKinds(text)
    expect(kinds).toContain('emotional-telling')
    expect(kinds).toContain('transition-pileup')
  })

  it('flags the narrator explanatory voice after description', () => {
    const text = '他握紧了刀。这意味着他已经没有任何退路了。剑锋划过夜色，仿佛在诉说着他的决心，无疑是在提醒对手退后。'
    const markers = reportIssues(text)
    expect(markers.map(issue => issue.kind)).toContain('explanatory-voice')
    expect(markers.find(issue => issue.kind === 'explanatory-voice')!.count).toBeGreaterThanOrEqual(3)
  })

  it('flags le pileup inside a single dense paragraph', () => {
    const paragraph = Array.from({ length: 12 }, (_, i) => `他吃了饭，喝了水，看了书${i}`).join('，') + '。'
    const kinds = issueKinds(paragraph)
    expect(kinds).toContain('le-pileup')
  })

  it('does not flag short clean prose', () => {
    const report = analyzeProseQuality('他把刀收回鞘里，转身走出巷子。雨停了。')
    expect(report.issues).toEqual([])
    expect(report.score).toBe(0)
  })

  it('flags a summarizing final paragraph only when it is last', () => {
    const withEnding = '他吹熄了灯。\n这一夜，注定被载入史册。'
    const withoutEnding = '这一夜，注定被载入史册。\n他吹熄了灯。'
    expect(issueKinds(withEnding)).toContain('summary-ending')
    expect(issueKinds(withoutEnding)).not.toContain('summary-ending')
  })

  it('flags paragraph monotony for uniformly sized paragraphs', () => {
    const paragraph = '他沿着河边慢慢走，看着水面上的光，什么也没有说，只是把外套裹紧了一些。'
    const text = Array.from({ length: 8 }, () => paragraph).join('\n\n')
    expect(issueKinds(text)).toContain('paragraph-monotony')
  })

  it('scores are zero for empty text', () => {
    const report = analyzeProseQuality('')
    expect(report.units).toBe(0)
    expect(report.score).toBe(0)
  })
})

describe('compareProseQuality', () => {
  it('detects regression when the revision piles on AI markers', () => {
    const source = '他把刀收回鞘里，转身走出巷子。雨停了，他加快脚步走向城南的渡口。'.repeat(10)
    const revision = ('空气仿佛凝固了，他的眼中闪过一丝惊讶，仿佛命运的齿轮开始转动，'
      + '内心深处涌起一股难以言说的情绪，宛如潮水般淹没了他。').repeat(10)
    const comparison = compareProseQuality(source, revision)
    expect(comparison.regressed).toBe(true)
    expect(comparison.worsenedKinds).toContain('ai-marker')
  })

  it('does not flag improvement or parity as regression', () => {
    const dirty = '空气仿佛凝固了，他的眼中闪过一丝惊讶。'.repeat(10)
    const clean = '他把刀收回鞘里，转身走出巷子。雨停了。'.repeat(10)
    expect(compareProseQuality(dirty, clean).regressed).toBe(false)
    expect(compareProseQuality(clean, clean).regressed).toBe(false)
  })

  it('tolerates small score noise without calling it a regression', () => {
    const base = '他把刀收回鞘里，转身走出巷子。'.repeat(200)
    const slightlyWorse = `${base}空气仿佛凝固了。`
    expect(compareProseQuality(base, slightlyWorse).regressed).toBe(false)
  })
})

describe('summarizeProseIssues', () => {
  it('renders localized readable lines', () => {
    const report = analyzeProseQuality('空气仿佛凝固了。')
    const zh = summarizeProseIssues(report, 'zh-CN')
    expect(zh.length).toBeGreaterThan(0)
    expect(zh[0]).toContain('AI 高频词')
    expect(proseIssueLabel('ai-marker', 'en-US')).toBe('AI marker words')
    expect(summarizeProseIssues(analyzeProseQuality('干净文本。'), 'zh-CN')).toEqual([])
  })
})

import {
  BaseWorkflowCommand,
  CommandExecuteParams,
  POLISH_FLOW_CONTINUATION_LIMITS,
  type WorkflowGenerationRuntimeDependencies,
} from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { resolvePromptTemplate } from '../../prompt-templates'
import { ChapterPromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'
import { requireIpcSuccess } from '../../ipc-result'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../../shared/project-session-context'
import { readWorkflowDraftMeta } from '../workflow-draft-meta'
import {
  requireWorkflowProjectSession,
  workflowUiLocale,
  workflowUiText,
  workflowWritingLanguage,
} from '../workflow-project-session'
import { promptLanguageText } from '../../prompt-language'
import { assertMateriallyCompleteRevision } from './refinement-completeness'
import { countDraftUnits } from '../../../shared/draft-units'
import { throwIfSourceDraftChanged } from '../source-draft-changed'
import { analyzeProseQuality } from '../../../shared/prose-quality'
import { applySpotPatches, decidePolishGate, isSessionBudgetExhausted, parseSpotPatches } from './polish-gate'

import type { ChapterInfo, FrozenDraftSourceIdentity } from '../chapter-workflow'
import type { WritingLanguage } from '../../../shared/writing-language'

export interface PolishChapterParams {
  draftPath: string
  draftContent: string
  sourceDraft?: FrozenDraftSourceIdentity
  chapterNumber: number
  chapterInfo: ChapterInfo
  mergedGuidance?: string
  userPolishPrompt?: string
  shortSummary?: string
  openMergeView?: boolean
}

interface PolishCandidate {
  text: string
  score: number
  label: string
}

const MAX_PROSE_CONTINUATIONS = POLISH_FLOW_CONTINUATION_LIMITS.prose
const MAX_GATE_CONTINUATIONS = POLISH_FLOW_CONTINUATION_LIMITS.gate
const MAX_PATCH_CONTINUATIONS = POLISH_FLOW_CONTINUATION_LIMITS.patch

/**
 * AI 润色（全自动多轮）：全篇润色 → 门控 →（全篇重润 | 定点修复）→ 门控
 * → 定点修复。每轮候选稿与历史最优稿做确定性质量比较，回退即停；
 * 只有最终胜出稿写入修订链，中间稿不落库。门控 LLM 故障自动降级为
 * 纯确定性判定；第二轮起不再全篇重润。
 */
export class PolishChapterCommand extends BaseWorkflowCommand<string> {
  constructor(
    private params: PolishChapterParams,
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
  ) {
    super(generationDependencies)
  }

  async execute(params: CommandExecuteParams): Promise<string> {
    return this.executeWithGenerationRuntime('polish', params, () => this.executeWithinGeneration(params))
  }

  private polishPromptBlock(writingLanguage: WritingLanguage): string {
    const userPrompt = this.params.userPolishPrompt?.trim()
    if (!userPrompt) return ''
    return promptLanguageText(
      writingLanguage,
      `【作者额外润色要求（最高优先级）】\n${userPrompt}`,
      `[Author polish guidance — highest priority]\n${userPrompt}`,
    )
  }

  private renderFeedback(decision: ReturnType<typeof decidePolishGate>): string {
    if (decision.problems.length === 0) return ''
    const lines = decision.problems.map((problem, index) => `${index + 1}. ${problem}`)
    return `上一稿存在以下问题，本次润色必须针对性解决：\n${lines.join('\n')}`
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const projectSession = requireWorkflowProjectSession(context)
    const writingLanguage = workflowWritingLanguage(context)
    const locale = workflowUiLocale(context)
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const assertSessionCurrent = (message: string, englishMessage: string) => {
      if (!sameProjectSessionContext(
        projectSession,
        projectSessionContextFromProject(useProjectStore.getState().currentProject),
      )) throw new Error(text(message, englishMessage))
    }

    const project = useProjectStore.getState().currentProject
    if (!project) throw new Error(text('当前没有打开的项目', 'No project is open.'))
    const novelConfig = Object.freeze({ ...project.novelConfig })

    const source = this.params.draftContent
    if (!source) throw new Error(text('无草稿内容', 'There is no draft content to polish.'))
    const userPromptBlock = this.polishPromptBlock(writingLanguage)

    const sourceScore = analyzeProseQuality(source)
    // 候选稿胜负规则：门控 pass 的候选拥有最终裁决权；无 pass 时取确定性
    // 指标最优的候选；若所有候选都不优于原稿，则放弃并保留原稿。
    let best: PolishCandidate | null = null
    let passCandidate: PolishCandidate | null = null
    const logScore = (candidate: PolishCandidate) => text(
      `  质量指标：${sourceScore.score.toFixed(2)} → ${candidate.score.toFixed(2)}（AI 痕迹越少越好）`,
      `  Quality score: ${sourceScore.score.toFixed(2)} → ${candidate.score.toFixed(2)} (lower is better)`,
    )
    const updateBest = (candidate: PolishCandidate) => {
      if (!best || candidate.score < best.score) best = candidate
    }

    callbacks.log(text('AI 润色开始：全篇润色 → 质量门控 → 自动迭代（最多 3 轮）', 'AI polish started: full polish → gate → automatic iteration (max 3 rounds)'))
    callbacks.log(text(`  原稿质量指标：${sourceScore.score.toFixed(2)}`, `  Source quality score: ${sourceScore.score.toFixed(2)}`))

    const polishChapter = async (baseText: string, feedback: string, label: string): Promise<PolishCandidate> => {
      const template = await resolvePromptTemplate('polish_chapter', projectSession, writingLanguage)
      if (!template) throw new Error(text('未找到润色模板', 'The polish prompt template was not found.'))
      const promptBuilder = new ChapterPromptBuilder(template, writingLanguage)
        .withDraftContent(baseText)
        .withChapterInfo(this.params.chapterInfo)
        .withGlobalGuidance(this.params.mergedGuidance || novelConfig.globalGuidance || '')
        .withGlobalSummary(this.params.shortSummary || '')
        .withShortSummary(this.params.shortSummary || '')
        .withWordNumber(novelConfig.wordsPerChapter)
        .withWritingStyle(novelConfig.writingStyle || '')
        .withUserPolishPrompt(userPromptBlock)
        .withPolishFeedback(feedback)
      const raw = await this.callLLMWithBoundedCompletion(
        promptBuilder.build(),
        promptBuilder.getSystemRole(),
        callbacks,
        { mode: 'append-visible-text', maxContinuations: MAX_PROSE_CONTINUATIONS },
        { purpose: 'polish-chapter', reasoningStage: 'review', writingSkillStage: 'refinement' },
        context,
      )
      this.assertNotCancelled(context)
      return { text: this.stripThinkingTags(raw).trim(), score: 0, label }
    }

    const spotFix = async (baseText: string, problems: string[]): Promise<PolishCandidate> => {
      const template = await resolvePromptTemplate('polish_spot_fix', projectSession, writingLanguage)
      if (!template) throw new Error(text('未找到定点修复模板', 'The spot-fix prompt template was not found.'))
      const promptBuilder = new ChapterPromptBuilder(template, writingLanguage)
        .withDraftContent(baseText)
        .withProblemList(problems.join('\n'))
        .withUserPolishPrompt(userPromptBlock)
      const raw = await this.callLLMWithBoundedCompletion(
        promptBuilder.build(),
        promptBuilder.getSystemRole(),
        callbacks,
        { mode: 'append-visible-text', maxContinuations: MAX_PATCH_CONTINUATIONS },
        { purpose: 'polish-spot-fix', reasoningStage: 'review', writingSkillStage: 'refinement' },
        context,
      )
      this.assertNotCancelled(context)
      const patches = parseSpotPatches(this.stripThinkingTags(raw))
      const applied = applySpotPatches(baseText, patches)
      callbacks.log(text(
        `  定点修复：补丁 ${patches.length} 个，命中 ${applied.applied} 个，丢弃 ${applied.missed} 个`,
        `  Spot fix: ${patches.length} patches, ${applied.applied} applied, ${applied.missed} discarded`,
      ))
      return { text: applied.text, score: 0, label: 'spot-fix' }
    }

    const gate = async (round: 1 | 2, candidateText: string) => {
      let llmRaw: string | null = null
      try {
        const template = await resolvePromptTemplate('polish_gate', projectSession, writingLanguage)
        if (!template) throw new Error('gate template missing')
        const promptBuilder = new ChapterPromptBuilder(template, writingLanguage)
          .withDraftContent(candidateText)
          .withChapterInfo(this.params.chapterInfo)
          .withWordNumber(novelConfig.wordsPerChapter)
          .withWritingStyle(novelConfig.writingStyle || '')
          .withUserPolishPrompt(userPromptBlock)
        llmRaw = await this.callLLMWithBoundedCompletion(
          promptBuilder.build(),
          promptBuilder.getSystemRole(),
          callbacks,
          { mode: 'append-visible-text', maxContinuations: MAX_GATE_CONTINUATIONS },
          { purpose: 'polish-gate', reasoningStage: 'review', writingSkillStage: 'refinement' },
          context,
        )
        this.assertNotCancelled(context)
      } catch (error) {
        if (context.cancelled) throw error
        llmRaw = null
      }
      const decision = decidePolishGate({
        sourceText: source,
        candidateText,
        round,
        llmRaw: llmRaw === null ? null : this.stripThinkingTags(llmRaw),
        locale,
      })
      for (const note of decision.notes) callbacks.log(text(`  门控：${note}`, `  Gate: ${note}`))
      for (const problem of decision.problems) {
        callbacks.log(text(`  门控问题：${problem}`, `  Gate finding: ${problem}`))
      }
      callbacks.log(text(
        `  门控判定：${decision.action}`,
        `  Gate verdict: ${decision.action}`,
      ))
      return decision
    }

    const assertComplete = (candidateText: string) => {
      assertMateriallyCompleteRevision(source, candidateText, novelConfig.wordsPerChapter, locale)
    }

    // ── 第 1 轮：全篇润色 ──
    assertSessionCurrent('当前项目已切换，润色已停止', 'The project changed, so polishing stopped.')
    const round1 = await polishChapter(source, '', 'polish-r1')
    assertComplete(round1.text)
    round1.score = analyzeProseQuality(round1.text).score
    updateBest(round1)
    callbacks.log(logScore(round1))

    let gateDecision = await gate(1, round1.text)
    let current = round1
    let currentGateProblems = gateDecision.problems
    if (gateDecision.action === 'pass') passCandidate = round1
    // 会话级预算/次数耗尽后，后续轮必然同样失败；短路省掉空转。
    let sessionBudgetExhausted = false

    if (gateDecision.action !== 'pass') {
      // ── 第 2 轮：全篇重润（全局问题）或定点修复（局部问题）──
      this.assertNotCancelled(context)
      assertSessionCurrent('当前项目已切换，润色已停止', 'The project changed, so polishing stopped.')
      try {
        if (gateDecision.action === 'full-repolish') {
          callbacks.log(text('第 2 轮：根据门控反馈整篇重新润色', 'Round 2: full re-polish from the gate feedback'))
          const round2 = await polishChapter(source, this.renderFeedback(gateDecision), 'polish-r2-full')
          assertComplete(round2.text)
          round2.score = analyzeProseQuality(round2.text).score
          updateBest(round2)
          callbacks.log(logScore(round2))
          current = round2
        } else {
          callbacks.log(text('第 2 轮：定点修复门控问题', 'Round 2: spot-fix the gate findings'))
          const round2 = await spotFix(current.text, currentGateProblems)
          assertComplete(round2.text)
          round2.score = analyzeProseQuality(round2.text).score
          round2.label = 'polish-r2-spot'
          updateBest(round2)
          callbacks.log(logScore(round2))
          current = round2
        }
        gateDecision = await gate(2, current.text)
        currentGateProblems = gateDecision.problems
        if (gateDecision.action === 'pass') passCandidate = current
      } catch (error) {
        if (context.cancelled) throw error
        if (isSessionBudgetExhausted(error)) sessionBudgetExhausted = true
        callbacks.log(text(
          `  第 2 轮失败，使用当前最优稿继续：${error instanceof Error ? error.message : String(error)}`,
          `  Round 2 failed; continuing from the best draft: ${error instanceof Error ? error.message : String(error)}`,
        ))
      }
    }

    if (gateDecision.action !== 'pass' && !sessionBudgetExhausted) {
      // ── 第 3 轮：最后一轮定点修复 ──
      this.assertNotCancelled(context)
      assertSessionCurrent('当前项目已切换，润色已停止', 'The project changed, so polishing stopped.')
      try {
        callbacks.log(text('第 3 轮：最后一轮定点修复', 'Round 3: final spot-fix'))
        const round3 = await spotFix(current.text, currentGateProblems)
        assertComplete(round3.text)
        round3.score = analyzeProseQuality(round3.text).score
        round3.label = 'polish-r3-spot'
        updateBest(round3)
        callbacks.log(logScore(round3))
      } catch (error) {
        if (context.cancelled) throw error
        callbacks.log(text(
          `  第 3 轮失败，使用当前最优稿：${error instanceof Error ? error.message : String(error)}`,
          `  Round 3 failed; keeping the best draft: ${error instanceof Error ? error.message : String(error)}`,
        ))
      }
    }

    const winner = passCandidate ?? best
    callbacks.log(text(
      `润色迭代结束：胜出稿 = ${winner ? winner.label : 'source（无可用候选）'}`,
      `Polish iteration finished: winner = ${winner ? winner.label : 'source (no usable candidate)'}`,
    ))
    if (!passCandidate && (!winner || winner.score > sourceScore.score)) {
      throw new Error(text(
        '润色未能改善文本质量（所有候选稿指标均劣于原稿），已保留原稿，未创建修订稿。',
        'Polishing did not improve the text (every candidate scored worse than the source). The draft was kept; no revision was created.',
      ))
    }
    const cleanRefined = (passCandidate ?? winner!).text

    assertSessionCurrent('当前项目已切换，润色结果未保存', 'The project changed, so the polish result was not saved.')

    const frozenSource = this.params.sourceDraft
    const legacyBaseDraft = frozenSource
      ? null
      : await readWorkflowDraftMeta(this.params.draftPath, context.projectPath, projectSession)
    const baseDraftId = frozenSource?.id ?? legacyBaseDraft?.id
    if (baseDraftId === undefined) throw new Error(text('找不到基准草稿版本', 'The source draft version could not be found.'))

    this.assertNotCancelled(context)
    const createRes = await ipc.invokeWithProjectSession(projectSession, 'db:revision-replace-pending', {
      baseDraftId,
      revisionType: 'polish',
      content: cleanRefined,
      wordCount: countDraftUnits(cleanRefined),
      ...(this.params.userPolishPrompt?.trim() ? { userPrompt: this.params.userPolishPrompt.trim() } : {}),
      ...(frozenSource ? {
        expectedSource: {
          id: frozenSource.id,
          chapterNumber: frozenSource.chapterNumber,
          version: frozenSource.version,
          status: frozenSource.status,
          content: source,
        },
      } : {}),
    }, context.projectPath)
    throwIfSourceDraftChanged(createRes, locale, 'polish')
    requireIpcSuccess(createRes, text('创建润色修订稿', 'Create the polish revision'))
    if (createRes.id === undefined) {
      throw new Error(text('创建润色修订稿失败：未返回修订稿编号', 'The polish revision did not return an ID.'))
    }

    const revIndex = createRes.revisionIndex ?? 0
    context.data.revisionId = createRes.id
    context.data.revisionIndex = revIndex

    if (this.params.openMergeView !== false) {
      this.assertNotCancelled(context)
      assertSessionCurrent('当前项目已切换，已拒绝打开旧修订稿', 'The project changed, so the stale revision was not opened.')
      const { useEditorStore } = await import('../../../stores/editor-store')
      useEditorStore.getState().openFile({
        id: `diff-${this.params.draftPath}-${createRes.id}`,
        name: text(
          `润色合并：第${this.params.chapterNumber}章`,
          `Polish merge: Chapter ${this.params.chapterNumber}`,
        ),
        type: 'diff',
        filePath: this.params.draftPath,
        originalContent: source,
        content: cleanRefined,
        revisionPath: `vela://revision/${createRes.id}`,
        chapterNumber: this.params.chapterNumber,
        chapterDir: `vela://draft/ch${this.params.chapterNumber}`,
        projectKey: context.projectPath,
      })
    }

    callbacks.log(text(
      `润色完成（${countDraftUnits(cleanRefined)} 字），已生成修订稿版本 r${revIndex}`,
      `Polish complete (${countDraftUnits(cleanRefined)} words); created revision r${revIndex}`,
    ))
    return cleanRefined
  }
}

import {
  BaseWorkflowCommand,
  CommandExecuteParams,
  finishReasonPhrase,
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
import { assertMateriallyCompleteRevision } from './refinement-completeness'
import { assertNoExactDuplicateParagraphs } from '../../../shared/duplicate-spans'
import { countDraftUnits } from '../../../shared/draft-units'
import { throwIfSourceDraftChanged } from '../source-draft-changed'
import { readCharacterStates, readFinalizedHistory } from '../continuity-context'
import { applySpotPatches, parseSpotPatches } from '../../../shared/spot-patches'
import {
  hasIncludedReviewItems,
  parseHumanConfirmedReviewSnapshot,
  renderHumanConfirmedReviewBrief,
  serializeHumanConfirmedReviewSnapshot,
  type HumanConfirmedReviewSnapshot,
} from '../../../shared/human-confirmed-review'


export interface RefineFromReviewParams {
  draftPath: string
  draftContent: string
  /** Persisted JSON content of the immutable human-confirmed review snapshot. */
  confirmedReviewContent?: string
  /** ID of the review row that stores the confirmed snapshot. */
  reviewSourceId?: number
  /** @deprecated Raw AI review content is deliberately never sent to the refiner. */
  reviewReport?: string
  reviewFileName?: string
  chapterNumber: number
  /** @deprecated Author guidance must be persisted in the confirmation snapshot. */
  userRefinePrompt?: string
  /**
   * The manual review screen opens the produced revision as a merge tab.
   * Headless orchestrators merge it themselves and opt out. Defaults to true.
   */
  openMergeView?: boolean
}

export class RefineFromReviewCommand extends BaseWorkflowCommand<string> {
  constructor(
    private params: RefineFromReviewParams,
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
  ) {
    super(generationDependencies)
  }

  async execute(params: CommandExecuteParams): Promise<string> {
    const confirmedReview = await this.requireConfirmedReview(params)
    return this.executeWithGenerationRuntime(
      'text',
      params,
      () => this.executeWithinGeneration(params, confirmedReview.snapshot, confirmedReview.reviewSourceId),
    )
  }

  /**
   * A renderer-provided JSON string is only a request to use a confirmation
   * record. Before acquiring a generation lease, resolve that record through
   * the frozen project session and use its persisted content as the source of
   * truth. This keeps review_source_id traceable to the exact prompt input.
   */
  private async requireConfirmedReview({ context }: CommandExecuteParams): Promise<{
    snapshot: HumanConfirmedReviewSnapshot
    reviewSourceId: number
  }> {
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const reviewSourceId = this.params.reviewSourceId
    if (
      typeof reviewSourceId !== 'number'
      || !Number.isSafeInteger(reviewSourceId)
      || reviewSourceId <= 0
    ) {
      throw new Error(text(
        '审稿修稿需要已保存的人工确认快照，未调用模型。',
        'Review-based revision requires a saved human-confirmed review snapshot. The model was not called.',
      ))
    }

    const requestedSnapshot = this.params.confirmedReviewContent
      ? parseHumanConfirmedReviewSnapshot(this.params.confirmedReviewContent)
      : null
    if (!requestedSnapshot) {
      throw new Error(text(
        '审稿修稿需要有效的人工确认快照，未调用模型。',
        'Review-based revision requires a valid human-confirmed review snapshot. The model was not called.',
      ))
    }

    const projectSession = requireWorkflowProjectSession(context)
    this.assertNotCancelled(context)
    const persistedReview = await ipc.invokeWithProjectSession(
      projectSession,
      'db:review-get-full',
      reviewSourceId,
      context.projectPath,
    )
    this.assertNotCancelled(context)
    if (!persistedReview) {
      throw new Error(text(
        '找不到已保存的人工确认快照，未调用模型。',
        'The saved human-confirmed review snapshot could not be found. The model was not called.',
      ))
    }
    if (persistedReview.id !== reviewSourceId) {
      throw new Error(text(
        '人工确认快照记录校验失败，未调用模型。',
        'The human-confirmed review snapshot record failed validation. The model was not called.',
      ))
    }

    const persistedSnapshot = parseHumanConfirmedReviewSnapshot(persistedReview.content)
    if (!persistedSnapshot) {
      throw new Error(text(
        '已保存的审稿记录不是有效的人工确认快照，未调用模型。',
        'The saved review record is not a valid human-confirmed review snapshot. The model was not called.',
      ))
    }
    if (
      serializeHumanConfirmedReviewSnapshot(requestedSnapshot)
      !== serializeHumanConfirmedReviewSnapshot(persistedSnapshot)
    ) {
      throw new Error(text(
        '人工确认快照与已保存记录不一致，请重新确认后再试。',
        'The human-confirmed review snapshot does not match the saved record. Confirm it again and retry.',
      ))
    }
    const sourceDraft = persistedSnapshot.sourceDraft
    if (
      !sourceDraft
      || !persistedReview.sourceDraft
      || persistedReview.sourceDraft.id !== sourceDraft.id
      || persistedReview.sourceDraft.chapterNumber !== sourceDraft.chapterNumber
      || persistedReview.sourceDraft.version !== sourceDraft.version
      || persistedReview.sourceDraft.status !== sourceDraft.status
      || persistedReview.sourceDraft.content !== sourceDraft.content
    ) {
      throw new Error(text(
        '人工确认快照缺少可信的冻结源稿，未调用模型；请重新运行 AI 审稿。',
        'The confirmed review has no trusted frozen source draft. The model was not called; run AI review again.',
      ))
    }

    const baseDraft = await readWorkflowDraftMeta(
      this.params.draftPath,
      context.projectPath,
      projectSession,
    )
    this.assertNotCancelled(context)
    if (!baseDraft) {
      throw new Error(text(
        '找不到基准草稿版本，未调用模型。',
        'The base draft version could not be found. The model was not called.',
      ))
    }
    if (persistedReview.baseDraftId !== baseDraft.id) {
      throw new Error(text(
        '人工确认快照不属于当前草稿版本，未调用模型。',
        'The human-confirmed review snapshot does not belong to the current draft version. The model was not called.',
      ))
    }
    const currentDraft = await ipc.invokeWithProjectSession(
      projectSession,
      'db:draft-get-full',
      baseDraft.id,
      context.projectPath,
    )
    this.assertNotCancelled(context)
    if (
      !currentDraft
      || baseDraft.id !== sourceDraft.id
      || baseDraft.chapterNumber !== sourceDraft.chapterNumber
      || baseDraft.version !== sourceDraft.version
      || baseDraft.status !== sourceDraft.status
      || currentDraft.content !== sourceDraft.content
      || this.params.draftContent !== sourceDraft.content
    ) {
      throw new Error(text(
        '源草稿已变化，未调用模型；请重新运行 AI 审稿并确认清单。',
        'The source draft changed. The model was not called; run AI review and confirm the checklist again.',
      ))
    }
    if (!hasIncludedReviewItems(persistedSnapshot)) {
      throw new Error(text(
        '人工确认快照没有任何纳入项，未调用模型。',
        'The human-confirmed review snapshot has no included items. The model was not called.',
      ))
    }

    return { snapshot: persistedSnapshot, reviewSourceId }
  }

  private async executeWithinGeneration(
    { context, callbacks }: CommandExecuteParams,
    confirmedReview: HumanConfirmedReviewSnapshot,
    reviewSourceId: number,
  ): Promise<string> {
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const projectSession = requireWorkflowProjectSession(context)
    const project = useProjectStore.getState().currentProject
    if (!project || !sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(project),
    )) throw new Error(text('当前项目已切换，修稿已停止', 'The current project changed, so revision stopped.'))
    const novelConfig = Object.freeze({ ...project.novelConfig })
    const writingLanguage = workflowWritingLanguage(context)

    callbacks.log(text(
      '正在根据已确认的审稿项精准修复...',
      'Revising from the confirmed review checklist...',
    ))

    const template = await resolvePromptTemplate('refine_from_review', projectSession, writingLanguage)
    if (!template) throw new Error(text('未找到审稿修复模板', 'The review-based revision template was not found.'))

    // 修复补丁必须与审稿所依据的事实源一致：注入已定稿前文事实与角色状态，
    // 让模型在产出补丁时自查是否制造新的跨章矛盾。
    callbacks.log(text(
      '  读取已定稿连续性事实与角色状态...',
      '  Reading finalized continuity facts and character states...',
    ))
    const [contextSummary, characterStates] = await Promise.all([
      readFinalizedHistory(this.params.chapterNumber ?? 0, projectSession, writingLanguage),
      readCharacterStates(projectSession, writingLanguage),
    ])

    const confirmedReviewBrief = renderHumanConfirmedReviewBrief(confirmedReview, writingLanguage)

    const promptBuilder = new ChapterPromptBuilder(template, writingLanguage)
      .withReviewReport(confirmedReviewBrief)
      .withDraftContent(this.params.draftContent)
      .withGlobalGuidance(novelConfig.globalGuidance || '')
      .withGlobalSummary(contextSummary)
      .withCharacterStates(characterStates)
      // The brief already contains the confirmed author guidance. Do not let
      // a transient UI field bypass the persisted confirmation snapshot.
      .withUserRefinePrompt('')

    const sourceDraft = confirmedReview.sourceDraft
    const currentDraft = sourceDraft
      ? await ipc.invokeWithProjectSession(
          projectSession,
          'db:draft-get-full',
          sourceDraft.id,
          context.projectPath,
        )
      : null
    this.assertNotCancelled(context)
    if (
      !sourceDraft
      || !currentDraft
      || currentDraft.id !== sourceDraft.id
      || currentDraft.chapterNumber !== sourceDraft.chapterNumber
      || currentDraft.version !== sourceDraft.version
      || currentDraft.status !== sourceDraft.status
      || currentDraft.content !== sourceDraft.content
    ) {
      throw new Error(text(
        '源草稿已变化，未调用模型；请重新运行 AI 审稿并确认清单。',
        'The source draft changed. The model was not called; run AI review and confirm the checklist again.',
      ))
    }

    // 补丁 JSON 是结构化数据：续写拼接（append-visible-text）会插入换行、
    // 破坏 JSON，因此这里单次请求 + fail-closed。
    const completion = await this.callLLMResult(
      promptBuilder.build(),
      promptBuilder.getSystemRole(),
      callbacks,
      { purpose: 'refine-from-review', reasoningStage: 'review', writingSkillStage: 'refinement' },
      context,
    )
    callbacks.log(text(
      `  生成结束：${finishReasonPhrase(completion.finishReason, text)}`,
      `  Generation finished: ${finishReasonPhrase(completion.finishReason, text)}`,
    ))
    if (completion.finishReason !== 'stop') {
      throw this.createIncompleteCompletionError(completion.finishReason)
    }
    const raw = completion.content
    this.assertNotCancelled(context)

    // 定点补丁：一条审稿项一个 find/replace，逐字匹配应用；未命中即跳过。
    // 修复范围被机械限定在审稿项覆盖的原文上，不再整章重写。
    const patches = parseSpotPatches(this.stripThinkingTags(raw))
    if (patches.length === 0) {
      throw new Error(text(
        '审稿修复未产出有效补丁（应为 {"patches":[{"find","replace"}]} JSON）。'
          + '若自定义过「审稿驱动修稿」模板，请在模板管理中恢复默认后重试。',
        'The review-based revision produced no valid patches (expected {"patches":[{"find","replace"}]} JSON). '
          + 'If the refine-from-review template was customized, restore its default in template management and retry.',
      ))
    }
    const applied = applySpotPatches(this.params.draftContent, patches)
    callbacks.log(text(
      `  定点修复：生成 ${patches.length} 处修改，成功应用 ${applied.applied} 处，未匹配原文跳过 ${applied.missed} 处`,
      `  Spot fix: ${patches.length} edits proposed, ${applied.applied} applied, ${applied.missed} skipped (no match)`,
    ))
    if (applied.applied === 0) {
      throw new Error(text(
        '所有补丁都未匹配到原文，未生成修订稿；请重新执行 AI 审稿后再试。',
        'No patch matched the draft text, so no revision was created. Run AI review again and retry.',
      ))
    }
    const cleanRefined = applied.text
    assertMateriallyCompleteRevision(
      this.params.draftContent,
      cleanRefined,
      novelConfig.wordsPerChapter,
      workflowUiLocale(context),
    )
    assertNoExactDuplicateParagraphs(cleanRefined, workflowUiLocale(context))

    if (!sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(useProjectStore.getState().currentProject),
    )) throw new Error(text('当前项目已切换，修稿结果未保存', 'The current project changed, so the revision was not saved.'))

    const baseDraft = await readWorkflowDraftMeta(this.params.draftPath, context.projectPath, projectSession)
    if (!baseDraft) throw new Error(text('找不到基准草稿版本', 'The base draft version could not be found.'))

    this.assertNotCancelled(context)
    const createRes = await ipc.invokeWithProjectSession(projectSession, 'db:revision-replace-pending', {
      baseDraftId: baseDraft.id,
      revisionType: 'review-fix',
      content: cleanRefined,
      wordCount: countDraftUnits(cleanRefined),
      userPrompt: confirmedReview.authorGuidance || undefined,
      reviewSourceId,
      expectedSource: confirmedReview.sourceDraft,
    }, context.projectPath)
    throwIfSourceDraftChanged(createRes, workflowUiLocale(context), 'refine')
    requireIpcSuccess(createRes, text('创建审稿修订稿', 'Create review-based revision'))
    if (createRes.id === undefined) throw new Error(text(
      '创建审稿修订稿失败：未返回修订稿编号',
      'Failed to create the review-based revision: no revision ID was returned.',
    ))

    const revIndex = createRes.revisionIndex ?? 0
    context.data.revisionId = createRes.id
    context.data.revisionIndex = revIndex

    if (this.params.openMergeView !== false) {
      this.assertNotCancelled(context)
      if (!sameProjectSessionContext(
        projectSession,
        projectSessionContextFromProject(useProjectStore.getState().currentProject),
      )) throw new Error(text(
        '当前项目已切换，已拒绝打开旧修订稿',
        'The current project changed, so the stale revision was not opened.',
      ))
      const { useEditorStore } = await import('../../../stores/editor-store')
      useEditorStore.getState().openFile({
        id: `diff-${this.params.draftPath}-${createRes.id}`,
        name: text(
          `审稿修复：第${this.params.chapterNumber}章`,
          `Review fix: Chapter ${this.params.chapterNumber}`,
        ),
        type: 'diff',
        filePath: this.params.draftPath,
        originalContent: this.params.draftContent,
        content: cleanRefined,
        revisionPath: `vela://revision/${createRes.id}`,
        chapterNumber: this.params.chapterNumber,
        chapterDir: `vela://draft/ch${this.params.chapterNumber}`,
        projectKey: context.projectPath,
      })
    }

    callbacks.log(text(
      `审稿修复完成（${countDraftUnits(cleanRefined)} 字），已生成修订稿版本 r${revIndex}`,
      `Review-based revision complete (${countDraftUnits(cleanRefined)} words); revision r${revIndex} is ready.`,
    ))
    return cleanRefined
  }
}

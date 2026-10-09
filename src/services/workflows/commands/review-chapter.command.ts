import { BaseWorkflowCommand, CommandExecuteParams, type WorkflowGenerationRuntimeDependencies } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { resolvePromptTemplate } from '../../prompt-templates'
import { ReviewPromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'
import { requireIpcSuccess } from '../../ipc-result'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../../shared/project-session-context'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import type { DraftStatus } from '../../../shared/draft-status'
import { readWorkflowDraftMeta } from '../workflow-draft-meta'
import {
  requireWorkflowProjectSession,
  workflowUiLocale,
  workflowUiText,
  workflowWritingLanguage,
} from '../workflow-project-session'
import { promptLanguageText } from '../../prompt-language'
import { readConsistencyPreflight } from '../../consistency-preflight'
import { mergeConsistencyFindingsIntoReview, type ReviewLike } from '../../../shared/consistency-preflight'
import type { ChapterBlueprint } from '../directory-workflow'
import type { FrozenDraftSourceIdentity } from '../chapter-workflow'
import { throwIfSourceDraftChanged } from '../source-draft-changed'
import { readCharacterStates, readFinalizedHistory } from '../continuity-context'
import { buildChapterGoalReviewPrompt, chapterGoalReviewItems, freezeChapterGoals, normalizeChapterGoalReview } from '../../../shared/chapter-goal-review'
import { detectDuplicateParagraphs, mergeDuplicateSpansIntoReview } from '../../../shared/duplicate-spans'
import {
  dedupeReviewItems,
  MERGED_REVIEW_ITEMS_LIMIT,
  parseShardReviewItems,
  routeReviewShards,
  shardReviewFocus,
  type ReviewShardKey,
  type ShardReviewItem,
  synthesizeReviewSummary,
} from '../../../shared/review-shards'
import {
  buildReviewCarryover,
  markRecurringKeys,
  type ReviewCarryover,
} from '../../../shared/review-convergence'
import { HUMAN_CONFIRMED_REVIEW_KIND } from '../../../shared/human-confirmed-review'


export interface ReviewChapterParams {
  draftPath: string
  draftContent: string
  sourceDraft?: FrozenDraftSourceIdentity
  chapterNumber: number
  /** 要执行的审稿分片键；省略 = 全查（程序化调用默认） */
  reviewFocus?: ReviewShardKey[]
  /**
   * The manual editor opens the persisted report as a read-only tab. Headless
   * orchestrators read the report from the database and opt out so batch runs
   * do not leave stale tabs behind. Defaults to true.
   */
  openReportTab?: boolean
  /** Frozen source identity handed to `db:review-create`; defaults to the draft itself. */
  reviewSource?: {
    id: number
    chapterNumber: number
    version: number
    status: DraftStatus
    content: string
  }
}

/** 解析本章目标分片输出：根字段仅 goalReviews 数组 */
function parseGoalShardResult(content: string): unknown[] {
  const trimmed = content.trim()
  const fenced = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu.exec(trimmed)
  const parsed: unknown = JSON.parse(fenced?.[1]?.trim() ?? trimmed)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid goal review contract')
  const root = parsed as Record<string, unknown>
  if (Object.keys(root).some(key => key !== 'goalReviews') || !Array.isArray(root.goalReviews)) {
    throw new Error('invalid goal review contract')
  }
  return root.goalReviews
}

function formatReviewPlanningMaterial(
  blueprints: readonly ChapterBlueprint[],
  writingLanguage: NonNullable<CommandExecuteParams['context']['writingLanguage']>,
): string {
  const header = promptLanguageText(
    writingLanguage,
    '【当前及未来蓝图/计划｜非既定历史】',
    '[Current and future blueprints/plans | not established history]',
  )
  if (blueprints.length === 0) return `${header}\n${promptLanguageText(
    writingLanguage,
    '（无当前或后续蓝图）',
    '(no current or future blueprints)',
  )}`
  const plans = blueprints.map(blueprint => ({
    chapterNumber: blueprint.chapterNumber,
    title: blueprint.title,
    role: blueprint.role,
    purpose: blueprint.purpose,
    keyEvents: blueprint.keyEvents,
    characters: blueprint.characters,
    suspenseHook: blueprint.suspenseHook,
    userGuidance: blueprint.userGuidance,
  }))
  return `${header}\n${JSON.stringify(plans, null, 2)}`
}

export class ReviewChapterCommand extends BaseWorkflowCommand<string> {
  constructor(
    private params: ReviewChapterParams,
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
  ) {
    super(generationDependencies)
  }

  async execute(params: CommandExecuteParams): Promise<string> {
    return this.executeWithGenerationRuntime('text', params, () => this.executeWithinGeneration(params))
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const projectSession = requireWorkflowProjectSession(context)
    const writingLanguage = workflowWritingLanguage(context)
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const project = useProjectStore.getState().currentProject
    if (!project || !sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(project),
    )) throw new Error(text('当前项目已切换，审稿已停止', 'The project changed, so the review stopped.'))
    const novelConfig = Object.freeze({ ...project.novelConfig })

    const draft = this.params.draftContent
    if (!draft) throw new Error(text('无草稿内容', 'There is no draft content to review.'))

    callbacks.log(text('准备启动一致性审查引擎...', 'Preparing the continuity review...'))
    callbacks.log(text('  读取已定稿连续性事实...', '  Reading finalized continuity facts...'))

    const contextSummary = await readFinalizedHistory(this.params.chapterNumber, projectSession, writingLanguage)

    const characterState = await readCharacterStates(projectSession, writingLanguage)
    const worldBuilding = await this.readWorldBuilding(context.projectPath, projectSession, writingLanguage)
    const globalGuidance = novelConfig.globalGuidance?.trim() || promptLanguageText(
      writingLanguage,
      '（无作者全局创作指导）',
      '(no author global creative guidance)',
    )
    const authorGuidanceSection = promptLanguageText(
      writingLanguage,
      `【作者全局创作指导｜约束而非已发生事实】\n${globalGuidance}`,
      `[Author global creative guidance | constraint, not established history]\n${globalGuidance}`,
    )
    const authorConfigSection = promptLanguageText(
      writingLanguage,
      `【作者确认项目配置｜约束而非已发生事实】\n${JSON.stringify(novelConfig, null, 2)}`,
      `[Author-confirmed project configuration | constraint, not established history]\n${JSON.stringify(novelConfig, null, 2)}`,
    )
    let planningMaterial = formatReviewPlanningMaterial([], writingLanguage)
    let frozenGoals = freezeChapterGoals(this.params.chapterNumber, undefined)
    try {
      const { loadDirectoryBlueprints } = await import('../directory-workflow')
      const blueprints = (await loadDirectoryBlueprints(context.projectPath, projectSession))
        .filter(blueprint => (
          blueprint.chapterNumber >= this.params.chapterNumber
          && blueprint.chapterNumber <= this.params.chapterNumber + 5
        ))
      planningMaterial = formatReviewPlanningMaterial(blueprints, writingLanguage)
      frozenGoals = freezeChapterGoals(this.params.chapterNumber,
        blueprints.find(blueprint => blueprint.chapterNumber === this.params.chapterNumber)?.keyEvents ?? null)
    } catch {
      planningMaterial = promptLanguageText(
        writingLanguage,
        '【当前及未来蓝图/计划｜非既定历史】\n（蓝图读取暂时不可用）',
        '[Current and future blueprints/plans | not established history]\n(blueprint retrieval unavailable)',
      )
    }

    // ---- 审稿分片：A 事实线 / B 因果与角色 / C 叙事规范 / D 本章目标 ----
    // 每个分片独立调用、独立重建，只输出少量 JSON，降低截断与注意力稀释。
    const routing = routeReviewShards(this.params.reviewFocus)
    const [continuityTemplate, logicTemplate, narrationTemplate] = await Promise.all([
      resolvePromptTemplate('consistency_check_continuity', projectSession, writingLanguage),
      resolvePromptTemplate('consistency_check_logic', projectSession, writingLanguage),
      resolvePromptTemplate('consistency_check_narration', projectSession, writingLanguage),
    ])
    if (!continuityTemplate || !logicTemplate || !narrationTemplate) {
      throw new Error(text('未找到审稿分片模板', 'A review shard prompt template was not found.'))
    }

    const itemsOnlyContract = promptLanguageText(
      writingLanguage,
      '【硬性要求】只重新输出一个完整审稿 JSON，根字段仅 items：items 为 1–10 条，每条含 category、severity(error|warning|pass)、description(≤200 字符)；quote 仅 pass 可省略，error/warning 必须提供且不超过 160 字符。不得输出 summary、goalReviews、约定以外的字段、Markdown、解释或思考过程。',
      '[Hard requirement] Output one complete review JSON whose root field is only items: 1–10 entries with category, severity(error|warning|pass), description(≤200 characters); quote is optional only for pass and required (≤160 characters) for error/warning. Never output summary, goalReviews, fields outside this contract, Markdown, explanation, or reasoning.',
    )
    const goalsOnlyContract = promptLanguageText(
      writingLanguage,
      '【硬性要求】只重新输出一个完整 JSON，根字段仅 goalReviews 数组：逐项覆盖冻结清单，每项含 id、status(completed|unmet|unknown)、description、evidence；completed/unmet 必须给出正文逐字 quote，unknown 可 evidence:[]。不得输出 items、summary 或其他字段。',
      '[Hard requirement] Output one complete JSON whose root field is only the goalReviews array covering the frozen checklist: each entry with id, status(completed|unmet|unknown), description, evidence; completed/unmet require verbatim draft quotes, unknown may use evidence:[]. Never output items, summary, or other fields.',
    )

    interface ShardCall<T> {
      key: string
      logName: string
      prompt: string
      systemRole: string
      parse: (raw: string) => T
      rebuildContract: string
    }

    const runLlmShard = async <T>(shard: ShardCall<T>): Promise<T> => {
      callbacks.log(text(
        `  审稿分片[${shard.logName}]已发起`,
        `  Review shard [${shard.logName}] started`,
      ))
      let raw = await this.callLLMWithBoundedCompletion(
        shard.prompt,
        shard.systemRole,
        callbacks,
        { mode: 'replace-structured-output', maxContinuations: 1 },
        {
          responseFormat: { type: 'json_object' },
          purpose: `review-chapter-${shard.key}`,
          reasoningStage: 'review',
          writingSkillStage: 'review',
        },
        context,
      )
      try {
        return shard.parse(this.stripThinkingTags(raw))
      } catch {
        // 分片内合同失败再补一次完整替代输出：失败隔离在分片内，不串片。
        this.assertNotCancelled(context)
        callbacks.log(text(
          `  分片[${shard.logName}]输出未通过合同校验，正在请求一次完整替代输出...`,
          `  Shard [${shard.logName}] failed contract validation; requesting one complete replacement...`,
        ))
        const rebuildPrompt = [
          promptLanguageText(
            writingLanguage,
            '上一轮分片输出未通过合同校验，已被丢弃，不得引用或续接。请重新完成原始审稿任务。',
            'The previous shard output failed contract validation and was discarded. Do not quote or continue it; complete the original review task again.',
          ),
          promptLanguageText(writingLanguage, '【原始审稿任务】', '[Original review task]'),
          shard.prompt,
          shard.rebuildContract,
        ].join('\n\n')
        raw = await this.callLLMWithBoundedCompletion(
          rebuildPrompt,
          shard.systemRole,
          callbacks,
          { mode: 'replace-structured-output', maxContinuations: 1 },
          {
            responseFormat: { type: 'json_object' },
            purpose: `review-chapter-${shard.key}-rebuild`,
            reasoningStage: 'review',
            writingSkillStage: 'review',
          },
          context,
        )
        try {
          return shard.parse(this.stripThinkingTags(raw))
        } catch {
          throw new Error(text(
            `分片[${shard.logName}]两次输出均未通过审稿合同校验，报告未保存。若反复出现，通常是输出被模型最大长度截断：请提高模型最大输出 Tokens 后重试。`,
            `Shard [${shard.logName}] failed the review contract validation twice, so no report was saved. If this keeps happening, the output was likely truncated by the model maximum length: increase the model maximum output tokens and retry.`,
          ))
        }
      }
    }

    interface ShardOutcome {
      key: ReviewShardKey | 'goals'
      items?: ShardReviewItem[]
      goalReviews?: unknown[]
    }

    const authorSections = [authorGuidanceSection, authorConfigSection]
    const shardPromises: Array<Promise<ShardOutcome>> = []

    if (routing.continuity) {
      const builder = new ReviewPromptBuilder(continuityTemplate, writingLanguage)
        .withChapterContent(draft)
        .withGlobalSummary(contextSummary)
        .withFutureBlueprints(planningMaterial)
        .withReviewFocus(shardReviewFocus(this.params.reviewFocus, 'continuity'))
      shardPromises.push(
        runLlmShard({
          key: 'continuity',
          logName: promptLanguageText(writingLanguage, '事实线', 'continuity'),
          prompt: [builder.build(), ...authorSections].join('\n\n'),
          systemRole: builder.getSystemRole(),
          parse: parseShardReviewItems,
          rebuildContract: itemsOnlyContract,
        }).then(items => ({ key: 'continuity' as const, items })),
      )
    }

    if (routing.logic) {
      const builder = new ReviewPromptBuilder(logicTemplate, writingLanguage)
        .withChapterContent(draft)
        .withCharacterStates(characterState)
        .withWorldBuilding(worldBuilding)
        .withReviewFocus(shardReviewFocus(this.params.reviewFocus, 'logic'))
      shardPromises.push(
        runLlmShard({
          key: 'logic',
          logName: promptLanguageText(writingLanguage, '因果与角色', 'causal & character'),
          prompt: [builder.build(), ...authorSections].join('\n\n'),
          systemRole: builder.getSystemRole(),
          parse: parseShardReviewItems,
          rebuildContract: itemsOnlyContract,
        }).then(items => ({ key: 'logic' as const, items })),
      )
    }

    if (routing.narration) {
      const builder = new ReviewPromptBuilder(narrationTemplate, writingLanguage)
        .withChapterContent(draft)
      shardPromises.push(
        runLlmShard({
          key: 'narration',
          logName: promptLanguageText(writingLanguage, '叙事规范', 'narration'),
          prompt: builder.build(),
          systemRole: builder.getSystemRole(),
          parse: parseShardReviewItems,
          rebuildContract: itemsOnlyContract,
        }).then(items => ({ key: 'narration' as const, items })),
      )
    }

    {
      const goalPrompt = [
        promptLanguageText(writingLanguage, '【待审章节】', '[Chapter under review]'),
        draft,
        buildChapterGoalReviewPrompt(frozenGoals, writingLanguage),
      ].join('\n\n')
      const goalSystemRole = promptLanguageText(
        writingLanguage,
        '你是一位严谨的小说审稿编辑。只依据文本证据完成本章目标的逐项核对。',
        'You are a rigorous fiction continuity editor. Complete the per-goal checklist using only textual evidence.',
      )
      shardPromises.push(
        runLlmShard({
          key: 'goals',
          logName: promptLanguageText(writingLanguage, '本章目标', 'chapter goals'),
          prompt: goalPrompt,
          systemRole: goalSystemRole,
          parse: parseGoalShardResult,
          rebuildContract: goalsOnlyContract,
        }).then(goalReviews => ({ key: 'goals' as const, goalReviews })),
      )
    }

    callbacks.log(text(
      `并行执行 ${shardPromises.length} 个审稿分片...`,
      `Running ${shardPromises.length} review shards in parallel...`,
    ))

    const settled = await Promise.allSettled(shardPromises)
    this.assertNotCancelled(context)
    // 任一分片两次尝试后仍失败则整体失败（fail-closed），错误点名该分片。
    const firstRejection = settled.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
    if (firstRejection) throw firstRejection.reason
    const outcomes = settled.map(outcome => (outcome as PromiseFulfilledResult<ShardOutcome>).value)

    const mergedItems = dedupeReviewItems(
      outcomes.flatMap(outcome => outcome.items ?? []),
    ).slice(0, MERGED_REVIEW_ITEMS_LIMIT)
    let parsedResult: ReviewLike = {
      summary: synthesizeReviewSummary(mergedItems, context.uiLocale ?? 'zh-CN'),
      items: mergedItems.map((item): Record<string, unknown> => ({
        category: item.category,
        severity: item.severity,
        description: item.description,
        ...(item.quote === undefined ? {} : { quote: item.quote }),
      })),
    }

    const goalOutcomes = outcomes.filter(outcome => outcome.key === 'goals')
    const goalReview = normalizeChapterGoalReview(goalOutcomes[0]?.goalReviews, frozenGoals, draft, writingLanguage)
    parsedResult.goalReview = goalReview
    parsedResult.items = [...(parsedResult.items ?? []), ...chapterGoalReviewItems(goalReview, writingLanguage)]
    if (parsedResult.items.some(item => item.severity === 'unknown')) {
      parsedResult.summary = text('审稿包含待核实项目，不能视为全部通过。', 'The review contains unresolved items and is not an overall pass.')
    } else if (goalReview.items.some(item => item.status === 'unmet')) {
      parsedResult.summary = text('本章存在尚未完成的目标，请核对逐项证据。', 'Some chapter goals are unmet; check their evidence.')
    }

    // 确定性重复检测：模型异常复读或续写拼接重叠产生的重复段落。
    // 纯本地扫描，不依赖蓝图与外部数据，每次审稿必检；发现即并入报告。
    parsedResult = mergeDuplicateSpansIntoReview(
      parsedResult,
      detectDuplicateParagraphs(draft),
      context.uiLocale ?? 'zh-CN',
    )

    const blueprint = await ipc.invokeWithProjectSession(
      projectSession, 'db:blueprint-get', this.params.chapterNumber, context.projectPath,
    )
    if (blueprint) {
      try {
        const preflight = await readConsistencyPreflight(projectSession, [blueprint])
        parsedResult = mergeConsistencyFindingsIntoReview(parsedResult, preflight.findings, context.uiLocale ?? 'zh-CN')
      } catch {
        callbacks.log(text(
          '一致性证据暂时不可用；AI 审稿仍会继续。',
          'Continuity evidence is temporarily unavailable; the AI review will continue.',
        ))
      }
      if (!sameProjectSessionContext(projectSession, projectSessionContextFromProject(useProjectStore.getState().currentProject))) {
        throw new Error(text('当前项目已切换，审稿已停止', 'The project changed, so the review stopped.'))
      }
    }

    const frozenSource = this.params.sourceDraft
    const legacyBaseDraft = frozenSource
      ? null
      : await readWorkflowDraftMeta(this.params.draftPath, context.projectPath, projectSession)
    const baseDraftId = frozenSource?.id ?? legacyBaseDraft?.id
    const baseVersion = frozenSource?.version ?? legacyBaseDraft?.version
    if (baseDraftId === undefined || baseVersion === undefined) {
      throw new Error(text('找不到基准草稿版本', 'The source draft version could not be found.'))
    }

    // 跨轮收敛度量：与同草稿最近一份 AI 审稿逐条比对原文引用。
    // 纯确定性证据判定，失败不阻断审稿本身。
    let carryover: ReviewCarryover | null = null
    try {
      carryover = await this.buildReviewCarryover(baseDraftId, draft, projectSession)
      if (carryover) {
        callbacks.log(text(
          `  与上一轮审稿（r${carryover.sourceReviewIndex}）比对：已修复 ${carryover.resolvedCount} 项，原文未动 ${carryover.recurringCount} 项`,
          `  Compared with the previous review (r${carryover.sourceReviewIndex}): ${carryover.resolvedCount} resolved, ${carryover.recurringCount} still verbatim`,
        ))
      }
    } catch {
      callbacks.log(text(
        '  上一轮审稿比对暂不可用；本次报告不包含收敛度量。',
        '  Previous-review comparison unavailable; this report has no convergence metrics.',
      ))
    }

    if (carryover) {
      parsedResult.carryover = carryover
      markRecurringKeys(carryover, parsedResult.items ?? [])
    }

    this.assertNotCancelled(context)
    const createResult = await ipc.invokeWithProjectSession(projectSession, 'db:review-create', {
      baseDraftId,
      content: JSON.stringify(parsedResult, null, 2),
      ...(this.params.reviewSource
        ? { expectedSource: { ...this.params.reviewSource } }
        : frozenSource
          ? {
              expectedSource: {
                id: frozenSource.id,
                chapterNumber: frozenSource.chapterNumber,
                version: frozenSource.version,
                status: frozenSource.status,
                content: draft,
              },
            }
          : {}),
    }, context.projectPath)
    throwIfSourceDraftChanged(createResult, workflowUiLocale(context), 'review')
    requireIpcSuccess(createResult, text('保存审稿报告', 'Save the review report'))
    const revIndex = createResult.reviewIndex ?? 0

    // 将审稿报告 JSON 序列化为字符串，作为 content 传给 Tab
    // EditorArea 渲染 ReviewReport 的条件：activeTab.content 存在
    this.assertNotCancelled(context)
    const reportContent = JSON.stringify(parsedResult, null, 2)

    context.data.reviewId = createResult.id
    context.data.reviewIndex = revIndex
    context.data.reviewReport = reportContent

    if (this.params.openReportTab !== false) {
      if (!sameProjectSessionContext(
        projectSession,
        projectSessionContextFromProject(useProjectStore.getState().currentProject),
      )) throw new Error(text('当前项目已切换，已拒绝打开旧审稿报告', 'The project changed, so the stale review report was not opened.'))
      const { useEditorStore } = await import('../../../stores/editor-store')
      const pseudoReviewPath = `vela://draft/ch${this.params.chapterNumber}/v${baseVersion}/review${revIndex}`
      useEditorStore.getState().openFile({
        id: `review-${this.params.draftPath}-${revIndex}`,
        name: text(
          `审稿报告：第${this.params.chapterNumber}章`,
          `Review report: Chapter ${this.params.chapterNumber}`,
        ),
        type: 'review-report',
        content: reportContent,
        filePath: this.params.draftPath,
        reportPath: pseudoReviewPath,
        reviewReport: reportContent,
        chapterNumber: this.params.chapterNumber,
        chapterDir: `vela://draft/ch${this.params.chapterNumber}`,
        reviewId: createResult.id,
        projectKey: context.projectPath,
      })
    }

    callbacks.log(text(
      `审查完成，已生成审稿报告 r${revIndex}`,
      `Review complete; created review report r${revIndex}`,
    ))
    return JSON.stringify(parsedResult, null, 2)
  }


  /**
   * 取同草稿最近一份「AI 审稿」（跳过 human-confirmed 快照行），
   * 与当前正文逐条比对原文引用，产出收敛度量。最多向前看 5 份。
   */
  private async buildReviewCarryover(
    baseDraftId: number,
    currentText: string,
    projectSession: ProjectSessionContext,
  ): Promise<ReviewCarryover | null> {
    const metas = await ipc.invokeWithProjectSession(
      projectSession, 'db:review-list', baseDraftId, projectSession.projectPath,
    )
    if (!Array.isArray(metas)) return null
    for (const meta of [...metas].reverse().slice(0, 5)) {
      if (typeof meta?.id !== 'number') continue
      const full = await ipc.invokeWithProjectSession(
        projectSession, 'db:review-get-full', meta.id, projectSession.projectPath,
      )
      if (!full?.content) continue
      let parsed: unknown
      try { parsed = JSON.parse(full.content) } catch { continue }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      const record = parsed as Record<string, unknown>
      if (record.kind === HUMAN_CONFIRMED_REVIEW_KIND) continue
      if (!Array.isArray(record.items)) continue
      return buildReviewCarryover(
        { id: meta.id, reviewIndex: meta.reviewIndex ?? 0, items: record.items },
        currentText,
      )
    }
    return null
  }

  private async readWorldBuilding(
    projectPath: string,
    projectSession: ProjectSessionContext,
    writingLanguage: NonNullable<CommandExecuteParams['context']['writingLanguage']>,
  ): Promise<string> {
    const core = await ipc.invokeWithProjectSession(projectSession, 'db:project-core-get', projectPath)
    return core?.worldbuilding || promptLanguageText(writingLanguage, '（暂无）', '(none)')
  }
}

import { workflowResourceKey, type WorkflowContext, type WorkflowDefinition, type WorkflowStep, type StepCallbacks } from '../../stores/workflow-store'
import { ipc } from '../ipc-client'
import { guardChapterWriting } from '../workflow-guards'
import type { ChapterInfo } from './chapter-workflow'
import type { ChapterBlueprint } from './directory-workflow'
import { GenerateDraftCommand } from './commands/generate-draft.command'
import { ReviewChapterCommand } from './commands/review-chapter.command'
import { RefineDraftCommand } from './commands/refine-draft.command'
import { RefineFromReviewCommand } from './commands/refine-from-review.command'
import type { SelectedCandidateDraft } from './chapter-materials'
import { FinalizeChapterCommand } from './commands/finalize-chapter.command'
import type { Locale } from '../../i18n/types'
import type { ExpectedDraftSource, ProjectSessionContext } from '../../shared/ipc-channels'
import type { DraftStatus } from '../../shared/draft-status'
import { sameProjectPathKey } from '../../shared/project-session-context'
import type { FinalizationSnapshot } from '../finalization-snapshot'
import { FINALIZATION_SHARED_WRITE_RESOURCE_KINDS } from '../../shared/workflow-resource-claims'
import { requireWorkflowProjectSession } from './workflow-project-session'
import { normalizeChapterWordsTarget } from './chapter-creation-parameters'
import { defaultReviewFocus } from '../../shared/review-shards'
import { buildDefaultConfirmedReviewSnapshot, defaultSnapshotHasWork } from '../../shared/review-confirmation'
import { requireIpcSuccess } from '../ipc-result'

/** 单次批量创作的安全上限，避免无边界调用模型。 */
export const MIN_BATCH_CHAPTERS = 1
export const MAX_BATCH_CHAPTERS = 10

export type BatchChapterCompletionMode = 'draft_review' | 'auto_finalize' | 'ai_pipeline'

export interface BatchChapterWorkflowParams {
  projectPath: string
  /** 点击开始时冻结的完整项目 lease，禁止工厂借用当前项目。 */
  projectSession: ProjectSessionContext
  /** 从哪一章开始，通常是当前第一章未定稿的蓝图 */
  startChapterNumber: number
  /** 本次连续创作章节数（强制限制为 1–10） */
  chapterCount: number
  /** 任务面板中的章节名称跟随应用界面语言 */
  locale?: Locale
  /** 由批量创作入口选择并冻结；批量任务禁止回退到运行时默认模型。 */
  generationModelId: string
  /** 点击开始时从全局默认值初始化并由用户确认，本批次每章一致。 */
  chapterWordsTarget?: number
  /** 点击开始时冻结；草稿待审与自动定稿在同一批次内不得混用。 */
  completionMode: BatchChapterCompletionMode
}

export interface BatchChapterWorkflowDefinition extends WorkflowDefinition {
  /** 批量任务必须携带启动时冻结的非空生成模型。 */
  generationModelId: string
  /** 随定义冻结的每章目标可见单位。 */
  chapterWordsTarget: number
  /** 随定义冻结的批量完成模式，供启动收据与 UI 验证。 */
  completionMode: BatchChapterCompletionMode
}

/** 将 UI 或外部输入收敛到安全的 1–10 章范围。 */
export function normalizeBatchChapterCount(value: number | string | null | undefined): number {
  const parsed = Math.trunc(Number(value))
  if (!Number.isFinite(parsed)) return MIN_BATCH_CHAPTERS
  return Math.min(MAX_BATCH_CHAPTERS, Math.max(MIN_BATCH_CHAPTERS, parsed))
}

function normalizeGenerationModelId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeCompletionMode(value: unknown): BatchChapterCompletionMode {
  if (value === 'auto_finalize') return 'auto_finalize'
  if (value === 'ai_pipeline') return 'ai_pipeline'
  return 'draft_review'
}

/** Modes that commit the chapter instead of leaving an editable draft behind. */
function modeFinalizes(mode: BatchChapterCompletionMode): boolean {
  return mode === 'auto_finalize' || mode === 'ai_pipeline'
}

/** Modes that keep every chapter of the batch as an unreviewed candidate draft. */
function modeUsesCandidateDrafts(mode: BatchChapterCompletionMode): boolean {
  return mode === 'draft_review'
}

/**
 * Accepts the whole revision. The three-way merge view starts every change
 * unapplied, so an automatic accept is exactly the revision body itself.
 */
function acceptedRevisionText(revisionContent: string): string {
  return revisionContent
}

function localeText(locale: Locale, zhCNText: string, enUSText: string): string {
  return locale === 'en-US' ? enUSText : zhCNText
}

function toChapterInfo(
  blueprint: ChapterBlueprint,
  projectPath: string,
  chapterWordsTarget: number,
): ChapterInfo {
  return {
    projectPath,
    chapterNumber: blueprint.chapterNumber,
    title: blueprint.title || `第${blueprint.chapterNumber}章`,
    role: blueprint.role || '发展',
    purpose: blueprint.purpose || '',
    characters: Array.isArray(blueprint.characters) ? blueprint.characters : [],
    keyEvents: blueprint.keyEvents || '',
    suspenseHook: blueprint.suspenseHook || '',
    userGuidance: blueprint.userGuidance || '',
    wordsTarget: chapterWordsTarget,
  }
}

function throwIfCancelled(context: WorkflowContext, uiLocale: Locale) {
  if (context.cancelled) {
    throw new Error(localeText(uiLocale, '批量创作已取消', 'Batch writing was cancelled.'))
  }
}

/**
 * Bind the draft tab opened by GenerateDraftCommand to the same immutable
 * snapshot consumed by automatic finalization. Existing reconciliation then
 * marks an unchanged tab read-only and preserves any concurrent author edit as
 * a conflict instead of silently closing or overwriting it.
 */
async function captureBatchFinalizationSnapshot(
  draftPath: string,
  draftContent: string,
  chapterNumber: number,
  chapterTitle: string,
  projectPath: string,
  projectSession: ProjectSessionContext,
): Promise<FinalizationSnapshot | undefined> {
  const draftIdMatch = draftPath.match(/^vela:\/\/draft\/(\d+)$/)
  if (!draftIdMatch) return undefined
  const draftId = Number.parseInt(draftIdMatch[1], 10)

  try {
    const { useEditorStore } = await import('../../stores/editor-store')
    const tab = useEditorStore.getState().tabs.find(candidate => (
      candidate.filePath === draftPath
      && candidate.type === 'chapter'
      && sameProjectPathKey(candidate.projectKey, projectPath)
    ))
    if (!tab) return undefined

    const contentRevision = tab.contentRevision ?? 0
    useEditorStore.setState(state => ({
      tabs: state.tabs.map(candidate => candidate.id === tab.id
        ? {
          ...candidate,
          draftId,
          chapterNumber,
          draftStatus: 'draft',
          projectSessionLease: projectSession.leaseId,
          contentRevision,
        }
        : candidate),
    }))

    return Object.freeze({
      tabId: tab.id,
      projectPath,
      projectSession: Object.freeze({ ...projectSession }),
      draftId,
      chapterNumber,
      chapterTitle,
      content: draftContent,
      contentRevision,
    })
  } catch {
    // Editor binding is a renderer projection. Finalization can still use its
    // database-backed fallback when the tab was not opened or already closed.
    return undefined
  }
}

async function runOneBatchChapter(
  projectPath: string,
  batchStartChapterNumber: number,
  chapterNumber: number,
  chapterWordsTarget: number,
  completionMode: BatchChapterCompletionMode,
  uiLocale: Locale,
  step: WorkflowStep,
  context: WorkflowContext,
  callbacks: StepCallbacks,
  draftReviewCandidates: Map<number, SelectedCandidateDraft>,
): Promise<string> {
  const projectSession = requireWorkflowProjectSession(context)
  // 草稿待审模式不会把本批次前一章变成定稿事实；首章仍遵守外部连续性门禁，
  // 后续章只重复校验蓝图/角色等全局前置条件。自动定稿与全流程定稿会在本批次内
  // 逐章定稿，因此后续章同样可以要求前一章已完成。
  const guardedChapterNumber = modeUsesCandidateDrafts(completionMode) && chapterNumber > batchStartChapterNumber
    ? undefined
    : chapterNumber
  const guard = await guardChapterWriting(guardedChapterNumber, projectPath, projectSession)
  if (!guard.ok) {
    throw new Error(uiLocale === 'en-US'
      ? `Chapter ${chapterNumber} does not meet the writing prerequisites.`
      : guard.message || `第${chapterNumber}章不满足创作前置条件`)
  }

  const [blueprint, existingDraft] = await Promise.all([
    ipc.invokeWithProjectSession(projectSession, 'db:blueprint-get', chapterNumber, projectPath),
    ipc.invokeWithProjectSession(projectSession, 'db:draft-get-latest', chapterNumber, projectPath),
  ])
  if (!blueprint) {
    throw new Error(localeText(
      uiLocale,
      `未找到第${chapterNumber}章蓝图，批量创作已停止`,
      `No blueprint was found for Chapter ${chapterNumber}. Batch writing stopped.`,
    ))
  }
  if (existingDraft) {
    throw new Error(localeText(
      uiLocale,
      `第${chapterNumber}章已有草稿，批量创作不会覆盖既有内容`,
      `Chapter ${chapterNumber} already has a draft. Batch writing will not overwrite it.`,
    ))
  }

  const chapterInfo = toChapterInfo(blueprint as ChapterBlueprint, projectPath, chapterWordsTarget)
  if (modeUsesCandidateDrafts(completionMode)) {
    callbacks.log(localeText(
      uiLocale,
      `开始第${chapterNumber}章：生成草稿待审。`,
      `Starting Chapter ${chapterNumber}: generate a review draft.`,
    ))
  } else if (completionMode === 'auto_finalize') {
    callbacks.log(localeText(
      uiLocale,
      `开始第${chapterNumber}章：生成草稿、自动定稿并完成后处理。`,
      `Starting Chapter ${chapterNumber}: generate, auto-finalize, and post-process.`,
    ))
  } else {
    callbacks.log(localeText(
      uiLocale,
      `开始第${chapterNumber}章：生成草稿、AI 修稿、AI 审稿与自动定稿全流程。`,
      `Starting Chapter ${chapterNumber}: generate, revise, review, and auto-finalize.`,
    ))
  }
  callbacks.setProgress(5)

  const draftContent = await new GenerateDraftCommand(chapterInfo, {
    selectedCandidateDrafts: modeUsesCandidateDrafts(completionMode)
      ? [...draftReviewCandidates.values()]
      : [],
  }).execute({ step, context, callbacks })
  throwIfCancelled(context, uiLocale)

  if (modeUsesCandidateDrafts(completionMode)) {
    const draftId = Number(context.data.draftId)
    const version = Number(context.data.draftVersion)
    if (!Number.isSafeInteger(draftId) || !Number.isSafeInteger(version)) {
      throw new Error(localeText(
        uiLocale,
        `第${chapterNumber}章草稿已保存，但缺少可冻结的草稿身份，批量创作已停止`,
        `Chapter ${chapterNumber} was saved, but its draft identity could not be frozen. Batch writing stopped.`,
      ))
    }
    draftReviewCandidates.set(chapterNumber, Object.freeze({
      chapterNumber,
      draftId,
      version,
      content: draftContent,
    }))
    callbacks.setProgress(100)
    return localeText(
      uiLocale,
      `第${chapterNumber}章草稿已生成并保存，等待审稿。`,
      `Chapter ${chapterNumber} draft was generated and saved for review.`,
    )
  }

  callbacks.setProgress(55)

  const draftPath = String(context.data.draftPath || '')
  if (!draftPath) {
    throw new Error(localeText(
      uiLocale,
      `第${chapterNumber}章草稿已生成，但未取得草稿路径`,
      `Chapter ${chapterNumber} was generated, but its draft path is unavailable.`,
    ))
  }

  // 「AI 全流程定稿」在草稿落库后串起 AI 修稿、AI 审稿与自动合并；每一步都
  // 在生成的修订稿上原地继续，未经人工介入。生成与定稿两条旧路径不经过这里。
  let finalContent = draftContent
  if (completionMode === 'ai_pipeline') {
    const draftId = Number(context.data.draftId)
    const draftVersion = Number(context.data.draftVersion)
    if (!Number.isSafeInteger(draftId) || !Number.isSafeInteger(draftVersion) || draftId <= 0 || draftVersion <= 0) {
      throw new Error(localeText(
        uiLocale,
        `第${chapterNumber}章草稿已生成，但缺少可冻结的草稿身份，AI 全流程定稿已停止`,
        `Chapter ${chapterNumber} was generated, but its draft identity could not be frozen. The pipeline stopped.`,
      ))
    }
    finalContent = await runAiPipelineChapterSteps({
      draftPath,
      draftId,
      draftVersion,
      chapterNumber,
      chapterInfo,
      draftContent,
      uiLocale,
      step,
      context,
      callbacks,
    })
    throwIfCancelled(context, uiLocale)
    callbacks.setProgress(90)
  }

  const snapshot = await captureBatchFinalizationSnapshot(
    draftPath,
    finalContent,
    chapterNumber,
    chapterInfo.title,
    projectPath,
    projectSession,
  )
  throwIfCancelled(context, uiLocale)

  await new FinalizeChapterCommand({
    draftPath,
    draftContent: finalContent,
    chapterNumber,
    chapterInfo,
    stopOnPostProcessFailure: true,
    eventSource: 'batch',
    ...(snapshot ? { snapshot } : {}),
  }).execute({ step, context, callbacks })

  callbacks.setProgress(100)
  return localeText(
    uiLocale,
    completionMode === 'ai_pipeline'
      ? `第${chapterNumber}章已完成撰写、修稿、审稿并定稿，后处理全部通过。`
      : `第${chapterNumber}章已定稿，后处理全部通过。`,
    completionMode === 'ai_pipeline'
      ? `Chapter ${chapterNumber} was drafted, revised, reviewed, and finalized; all post-processing passed.`
      : `Chapter ${chapterNumber} was finalized and all post-processing passed.`,
  )
}

interface AiPipelineStepInput {
  draftPath: string
  draftId: number
  draftVersion: number
  chapterNumber: number
  chapterInfo: ChapterInfo
  draftContent: string
  uiLocale: Locale
  step: WorkflowStep
  context: WorkflowContext
  callbacks: StepCallbacks
}

interface PendingRevisionRecord {
  id: number
  expectedSource: ExpectedDraftSource
}

/** Refuses to continue when a step did not leave exactly one mergeable revision. */
function requirePendingRevision(
  action: string,
  revisionId: unknown,
  expectedSource: ExpectedDraftSource,
): PendingRevisionRecord {
  if (typeof revisionId !== 'number' || !Number.isSafeInteger(revisionId) || revisionId <= 0) {
    throw new Error(`AI 全流程定稿中断：${action}未返回可合并的修订稿。`)
  }
  return { id: revisionId, expectedSource }
}

/**
 * Runs the headless half of the per-chapter pipeline. Each refine/review step
 * receives the exact text produced by the previous step and is told not to open
 * editor tabs, because this workflow accepts the whole revision and merges it
 * by itself. The merge reuses the same database commit the manual merge view
 * calls, so a batch chapter ends in the same state as a hand-confirmed one.
 */
async function runAiPipelineChapterSteps(input: AiPipelineStepInput): Promise<string> {
  const {
    draftPath, chapterNumber, chapterInfo, uiLocale, step, context, callbacks,
  } = input
  const projectPath = context.projectPath
  const projectSession = requireWorkflowProjectSession(context)
  const log = (zhCNText: string, enUSText: string) => callbacks.log(localeText(uiLocale, zhCNText, enUSText))

  let current = input.draftContent

  const mergeRevision = async (revisionId: number, expectedSource: ExpectedDraftSource) => {
    const full = await ipc.invokeWithProjectSession(projectSession, 'db:revision-get-full', revisionId, projectPath)
    if (!full || full.id !== revisionId) {
      throw new Error(localeText(uiLocale, 'AI 全流程定稿中断：找不到待合并的修订稿。', 'The pipeline stopped: the pending revision could not be found.'))
    }
    const mergedContent = acceptedRevisionText(String((full as { content?: string }).content ?? ''))
    if (!mergedContent.trim()) {
      throw new Error(localeText(uiLocale, 'AI 全流程定稿中断：修订稿正文为空。', 'The pipeline stopped: the revision was empty.'))
    }
    // Use the same merge seam as the manual merge view: it commits the revision
    // in the database and settles the open draft tab to the merged text. Keeping
    // the tab in sync matters because finalization reconciles against that tab.
    const { useDraftStore } = await import('../../stores/draft-store')
    const result = await useDraftStore.getState().applyMergedRevision(
      `vela://draft/ch${chapterNumber}`,
      chapterNumber,
      draftPath,
      `vela://revision/${revisionId}`,
      mergedContent,
      current,
      projectPath,
      projectSession,
    )
    if (!result.success) {
      throw new Error(localeText(
        uiLocale,
        `AI 全流程定稿中断：合并修订稿失败（${result.error ?? '未知原因'}）。`,
        `The pipeline stopped: merging the revision failed (${result.error ?? 'unknown reason'}).`,
      ))
    }
    // The merge overwrote the draft body in place, so the source identity for
    // the next step is the same draft at its new status and content.
    return {
      content: mergedContent,
      expectedSource: { ...expectedSource, status: 'revised' as DraftStatus, content: mergedContent },
    }
  }

  // ── 步骤 1/4：AI 修稿（默认值：无额外提示词的全篇精修） ──
  log('AI 全流程：第 1/4 步 — AI 修稿（默认）', 'Full pipeline: step 1/4 — AI revision (defaults)')
  await new RefineDraftCommand({
    draftPath,
    draftContent: current,
    sourceDraft: {
      id: input.draftId,
      chapterNumber,
      version: input.draftVersion,
      status: 'draft',
      contentRevision: 0,
    },
    chapterNumber,
    chapterInfo,
    openMergeView: false,
  }).execute({ step, context, callbacks })
  throwIfCancelled(context, uiLocale)

  // ── 步骤 2/4：完全接受修稿 ──
  log('AI 全流程：第 2/4 步 — 完全接受修稿并合并', 'Full pipeline: step 2/4 — accept the revision in full')
  const refineRevision = requirePendingRevision('AI 修稿', context.data.revisionId, {
    id: input.draftId,
    chapterNumber,
    version: input.draftVersion,
    status: 'draft' as DraftStatus,
    content: current,
  })
  let merged = await mergeRevision(refineRevision.id, refineRevision.expectedSource)
  current = merged.content
  throwIfCancelled(context, uiLocale)

  // ── 步骤 3/4：AI 审稿（默认维度）+ 按默认清单确认 + 修稿 + 完全接受合并 ──
  log('AI 全流程：第 3/4 步 — AI 审稿（默认维度）', 'Full pipeline: step 3/4 — AI review (default focus)')
  await new ReviewChapterCommand({
    draftPath,
    draftContent: current,
    reviewSource: merged.expectedSource,
    chapterNumber,
    reviewFocus: defaultReviewFocus(),
    openReportTab: false,
  }).execute({ step, context, callbacks })
  throwIfCancelled(context, uiLocale)

  const sourceReviewId = context.data.reviewId
  const reportContent = context.data.reviewReport
  if (typeof sourceReviewId !== 'number' || !Number.isSafeInteger(sourceReviewId) || typeof reportContent !== 'string') {
    throw new Error(localeText(uiLocale, 'AI 全流程定稿中断：审稿报告未保存。', 'The pipeline stopped: the review report was not saved.'))
  }

  log('AI 全流程：第 3/4 步 — 按默认清单确认审稿意见', 'Full pipeline: step 3/4 — confirm the default review checklist')
  const snapshot = buildDefaultConfirmedReviewSnapshot({
    sourceReviewId,
    sourceDraft: { ...merged.expectedSource },
    reportContent,
    fallbackCategory: uiLocale === 'en-US' ? 'General review' : '综合检查',
  })
  if (!snapshot) {
    throw new Error(localeText(uiLocale, 'AI 全流程定稿中断：无法构造默认审稿清单。', 'The pipeline stopped: the default review checklist could not be built.'))
  }

  if (!defaultSnapshotHasWork(snapshot)) {
    // 全 pass 的章节没有需要修稿的条目；审稿驱动修稿的合同要求至少一个纳入项，
    // 因此跳过修稿步骤，保留审稿报告后直接进入定稿。
    log('审稿未包含可修项，跳过审稿修稿步骤。', 'The review contained nothing to act on; skipping the review-driven revision.')
  } else {
    const confirmation = await ipc.invokeWithProjectSession(projectSession, 'db:review-create', {
      baseDraftId: input.draftId,
      content: JSON.stringify(snapshot),
      expectedSource: merged.expectedSource,
    }, projectPath)
    requireIpcSuccess(confirmation, localeText(uiLocale, '保存默认审稿清单', 'Save the default review checklist'))
    const confirmationId = Number((confirmation as { id?: number }).id)
    if (!Number.isSafeInteger(confirmationId) || confirmationId <= 0) {
      throw new Error(localeText(uiLocale, 'AI 全流程定稿中断：默认审稿清单未保存。', 'The pipeline stopped: the default review checklist was not saved.'))
    }

    log('AI 全流程：第 3/4 步 — 按默认审稿意见修稿', 'Full pipeline: step 3/4 — revise from the default review checklist')
    await new RefineFromReviewCommand({
      draftPath,
      draftContent: current,
      confirmedReviewContent: JSON.stringify(snapshot),
      reviewSourceId: confirmationId,
      chapterNumber,
      openMergeView: false,
    }).execute({ step, context, callbacks })
    throwIfCancelled(context, uiLocale)

    log('AI 全流程：第 3/4 步 — 完全接受审稿修稿并合并', 'Full pipeline: step 3/4 — accept the review-based revision in full')
    const reviewRevision = requirePendingRevision('审稿修稿', context.data.revisionId, merged.expectedSource)
    merged = await mergeRevision(reviewRevision.id, reviewRevision.expectedSource)
    current = merged.content
    throwIfCancelled(context, uiLocale)
  }

  // ── 步骤 4/4：定稿由调用方在返回后执行 ──
  log('AI 全流程：第 4/4 步 — 定稿与后处理', 'Full pipeline: step 4/4 — finalize and post-process')
  return current
}

/**
 * 受控批量创作：每个步骤完整处理一章。
 *
 * 工作流层只会在章节边界推进；因此暂停/取消不会将一个正在进行的模型请求或后处理
 * 截断到不一致状态。后处理任一步骤最终失败会抛出错误，阻止后续章节启动。
 */
export function createBatchChapterWorkflow(params: BatchChapterWorkflowParams): BatchChapterWorkflowDefinition {
  if (!sameProjectPathKey(params.projectSession.projectPath, params.projectPath)) {
    throw new Error('批量创作项目会话与目标路径不匹配')
  }
  const projectPath = params.projectPath
  const startChapterNumber = Math.max(1, Math.trunc(Number(params.startChapterNumber) || 1))
  const chapterCount = normalizeBatchChapterCount(params.chapterCount)
  const uiLocale: Locale = params.locale === 'en-US' ? 'en-US' : 'zh-CN'
  const generationModelId = normalizeGenerationModelId(params.generationModelId)
  if (!generationModelId) {
    throw new Error(localeText(
      uiLocale,
      '批量创作必须冻结一项可用的生成模型。',
      'Batch writing requires a frozen generation model.',
    ))
  }
  const completionMode = normalizeCompletionMode(params.completionMode)
  const chapterWordsTarget = normalizeChapterWordsTarget(params.chapterWordsTarget)
  const endChapterNumber = startChapterNumber + chapterCount - 1
  const draftReviewCandidates = new Map<number, SelectedCandidateDraft>()
  const chapterResourceKeys = Array.from({ length: chapterCount }, (_, index) => (
    workflowResourceKey('chapter', startChapterNumber + index)
  ))

  return {
    type: 'batch_generate',
    projectPath,
    projectSession: Object.freeze({ ...params.projectSession }),
    generationModelId,
    chapterWordsTarget,
    resourceKeys: modeFinalizes(completionMode)
      ? [
          ...chapterResourceKeys,
          ...FINALIZATION_SHARED_WRITE_RESOURCE_KINDS.map(kind => workflowResourceKey(kind)),
        ]
      : chapterResourceKeys,
    readResourceKeys: [
      workflowResourceKey('novel-config'),
      workflowResourceKey('architecture'),
      workflowResourceKey('blueprints'),
    ],
    completionMode,
    title: completionMode === 'draft_review'
      ? localeText(
        uiLocale,
        `批量草稿待审 — 第${startChapterNumber}–${endChapterNumber}章`,
        `Batch review drafts — Chapters ${startChapterNumber}–${endChapterNumber}`,
      )
      : completionMode === 'auto_finalize'
        ? localeText(
          uiLocale,
          `批量自动定稿 — 第${startChapterNumber}–${endChapterNumber}章`,
          `Batch auto-finalize — Chapters ${startChapterNumber}–${endChapterNumber}`,
        )
        : localeText(
          uiLocale,
          `批量 AI 全流程定稿 — 第${startChapterNumber}–${endChapterNumber}章`,
          `Batch AI full-pipeline finalize — Chapters ${startChapterNumber}–${endChapterNumber}`,
        ),
    steps: Array.from({ length: chapterCount }, (_, index) => {
      const chapterNumber = startChapterNumber + index
      return {
        name: completionMode === 'draft_review'
          ? localeText(
            uiLocale,
            `第${chapterNumber}章：生成草稿待审`,
            `Chapter ${chapterNumber}: generate review draft`,
          )
          : completionMode === 'auto_finalize'
            ? localeText(
              uiLocale,
              `第${chapterNumber}章：自动定稿与后处理`,
              `Chapter ${chapterNumber}: auto-finalize and post-process`,
            )
            : localeText(
              uiLocale,
              `第${chapterNumber}章：AI 全流程定稿`,
              `Chapter ${chapterNumber}: AI full-pipeline finalize`,
            ),
        description: completionMode === 'draft_review'
          ? localeText(
            uiLocale,
            '按蓝图生成可编辑草稿并保留待审；不定稿或运行后处理。',
            'Generate an editable draft from the blueprint and keep it for review without finalizing or post-processing.',
          )
          : completionMode === 'auto_finalize'
            ? localeText(
              uiLocale,
              '按蓝图生成草稿并自动定稿；任一后处理失败立即停止。',
              'Generate from the blueprint, finalize automatically, and stop immediately if post-processing fails.',
            )
            : localeText(
              uiLocale,
              '按蓝图生成草稿，再用默认值完成 AI 修稿、AI 审稿与自动合并，最后定稿；全程无需人工确认。',
              'Generate from the blueprint, then run AI revision, AI review, and automatic merge with default settings before finalizing; no human confirmation is required.',
            ),
        executor: (step, context, callbacks) => runOneBatchChapter(
          projectPath,
          startChapterNumber,
          chapterNumber,
          chapterWordsTarget,
          completionMode,
          uiLocale,
          step,
          context,
          callbacks,
          draftReviewCandidates,
        ),
      }
    }),
    onComplete: { mode: 'silent' },
  }
}

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createBatchChapterWorkflow,
  type BatchChapterWorkflowParams,
} from '../batch-chapter-workflow'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore, type WorkflowContext } from '../../../stores/workflow-store'
import { defaultReviewFocus } from '../../../shared/review-report'
import { buildDefaultConfirmedReviewSnapshot } from '../../../shared/review-confirmation'

const doubles = vi.hoisted(() => ({
  guardChapterWriting: vi.fn(),
  invokeWithProjectSession: vi.fn(),
  generateDraftExecute: vi.fn(),
  finalizeChapterParams: [] as Array<Record<string, unknown>>,
  finalizeChapterExecute: vi.fn(),
  refineDraftExecute: vi.fn(),
  refineDraftParams: [] as Array<Record<string, unknown>>,
  refineFromReviewExecute: vi.fn(),
  refineFromReviewParams: [] as Array<Record<string, unknown>>,
  reviewExecute: vi.fn(),
  reviewParams: [] as Array<Record<string, unknown>>,
  applyMergedRevision: vi.fn(),
}))

vi.mock('../../workflow-guards', () => ({
  guardChapterWriting: doubles.guardChapterWriting,
}))

vi.mock('../../ipc-client', () => ({
  ipc: {
    invokeWithProjectSession: (context: unknown, channel: string, ...args: unknown[]) => (
      channel === 'fs:check-exists'
        ? Promise.resolve(false)
        : doubles.invokeWithProjectSession(context, channel, ...args)
    ),
  },
}))

vi.mock('../commands/generate-draft.command', () => ({
  previousChapterEnding: (content: string) => content.slice(-1000),
  GenerateDraftCommand: class {
    execute = doubles.generateDraftExecute
  },
}))

vi.mock('../commands/finalize-chapter.command', () => ({
  FinalizeChapterCommand: class {
    constructor(params: Record<string, unknown>) {
      doubles.finalizeChapterParams.push(params)
    }

    execute = doubles.finalizeChapterExecute
  },
}))

vi.mock('../commands/refine-draft.command', () => ({
  RefineDraftCommand: class {
    constructor(params: Record<string, unknown>) {
      doubles.refineDraftParams.push(params)
    }

    execute = doubles.refineDraftExecute
  },
}))

vi.mock('../commands/review-chapter.command', () => ({
  ReviewChapterCommand: class {
    constructor(params: Record<string, unknown>) {
      doubles.reviewParams.push(params)
    }

    execute = doubles.reviewExecute
  },
}))

vi.mock('../commands/refine-from-review.command', () => ({
  RefineFromReviewCommand: class {
    constructor(params: Record<string, unknown>) {
      doubles.refineFromReviewParams.push(params)
    }

    execute = doubles.refineFromReviewExecute
  },
}))

vi.mock('../../../stores/draft-store', () => ({
  useDraftStore: {
    getState: () => ({ applyMergedRevision: doubles.applyMergedRevision }),
  },
}))

const projectPath = 'C:\\pipeline-project'
const projectSession = {
  projectId: 'pipeline-project',
  leaseId: 'pipeline-lease',
  projectPath,
}

const REFINED_TEXT = '精修后的文本'
const FIXED_TEXT = '按审稿意见修复后的文本'

function pipelineParams(overrides: Partial<BatchChapterWorkflowParams> = {}): BatchChapterWorkflowParams {
  return {
    projectPath,
    projectSession,
    startChapterNumber: 1,
    chapterCount: 1,
    generationModelId: 'pipeline-model',
    completionMode: 'ai_pipeline',
    ...overrides,
  }
}

function reviewReport(items: Array<Record<string, unknown>>): string {
  return JSON.stringify({ summary: '总体评价', items })
}

beforeEach(() => {
  vi.clearAllMocks()
  doubles.finalizeChapterParams.length = 0
  doubles.refineDraftParams.length = 0
  doubles.refineFromReviewParams.length = 0
  doubles.reviewParams.length = 0
  useWorkflowStore.setState({
    activeRuns: [],
    history: [],
    globalLogs: [],
    waitingRuns: {},
    currentRun: null,
    waitingForConfirm: false,
    waitingAfterStepIndex: -1,
  })
  useProjectStore.setState({
    currentProject: {
      id: 'pipeline-project',
      name: 'Pipeline project',
      path: projectPath,
      sessionLease: 'pipeline-lease',
      novelConfig: {},
    } as never,
  })

  doubles.guardChapterWriting.mockResolvedValue({ ok: true })
  doubles.finalizeChapterExecute.mockResolvedValue(undefined)
  doubles.applyMergedRevision.mockResolvedValue({ success: true })

  doubles.generateDraftExecute.mockImplementation(async ({ context }: { context: WorkflowContext }) => {
    context.data.draftPath = `vela://draft/7`
    context.data.draftId = 7
    context.data.draftVersion = 1
    return '原始草稿'
  })
  doubles.refineDraftExecute.mockImplementation(async ({ context }: { context: WorkflowContext }) => {
    context.data.revisionId = 11
    return REFINED_TEXT
  })
  doubles.reviewExecute.mockImplementation(async ({ context }: { context: WorkflowContext }) => {
    context.data.reviewId = 21
    context.data.reviewReport = reviewReport([
      { category: '剧情连贯性', severity: 'error', description: '与前文矛盾', quote: '原始草稿' },
    ])
    return '{}'
  })
  doubles.refineFromReviewExecute.mockImplementation(async ({ context }: { context: WorkflowContext }) => {
    context.data.revisionId = 12
    return FIXED_TEXT
  })

  doubles.invokeWithProjectSession.mockImplementation(async (
    _session: unknown,
    channel: string,
    ...args: unknown[]
  ) => {
    switch (channel) {
      case 'db:blueprint-get':
        return { chapterNumber: Number(args[0]), title: `Chapter ${args[0]}`, role: 'development' }
      case 'db:draft-get-latest':
        return null
      case 'db:revision-get-full':
        return args[0] === 11
          ? { id: 11, content: REFINED_TEXT }
          : { id: 12, content: FIXED_TEXT }
      case 'db:review-create':
        return { success: true, id: 31 }
      default:
        throw new Error(`Unexpected IPC channel in pipeline test: ${channel}`)
    }
  })
})

describe('AI full-pipeline batch definition', () => {
  it('declares finalization writes and a pipeline-labelled chapter step', () => {
    const workflow = createBatchChapterWorkflow(pipelineParams({ chapterCount: 2 }))

    expect(workflow.completionMode).toBe('ai_pipeline')
    expect(workflow.resourceKeys).toEqual(expect.arrayContaining([
      'character-roster',
      'continuity',
      'chapter-summary',
    ]))
    expect(workflow.title).toContain('AI 全流程定稿')
    expect(workflow.steps[0]).toMatchObject({ name: '第1章：AI 全流程定稿' })
    expect(workflow.steps.every(step => step.description.includes('无需人工确认'))).toBe(true)
  })

  it('keeps the two existing modes unchanged', () => {
    expect(createBatchChapterWorkflow(pipelineParams({ completionMode: 'draft_review' })).steps[0])
      .toMatchObject({ name: '第1章：生成草稿待审' })
    expect(createBatchChapterWorkflow(pipelineParams({ completionMode: 'auto_finalize' })).steps[0])
      .toMatchObject({ name: '第1章：自动定稿与后处理' })
  })
})

describe('AI full-pipeline per-chapter execution', () => {
  it('runs revise → accept → review → confirm defaults → revise → accept → finalize', async () => {
    const workflow = createBatchChapterWorkflow(pipelineParams())
    await useWorkflowStore.getState().startWorkflow(workflow)

    expect(useWorkflowStore.getState().history[0]?.status).toBe('completed')

    // The headless steps must not leave editor tabs behind.
    expect(doubles.refineDraftParams[0]).toMatchObject({ openMergeView: false })
    expect(doubles.reviewParams[0]).toMatchObject({
      openReportTab: false,
      reviewFocus: defaultReviewFocus(),
    })
    expect(doubles.refineFromReviewParams[0]).toMatchObject({ openMergeView: false })

    // Each automatic merge accepts the whole revision text.
    expect(doubles.applyMergedRevision.mock.calls.map(call => call[4]))
      .toEqual([REFINED_TEXT, FIXED_TEXT])

    // The review step reviews the revised text, not the original draft.
    expect(doubles.reviewParams[0]).toMatchObject({ draftContent: REFINED_TEXT })
    expect(doubles.reviewParams[0].reviewSource).toMatchObject({ status: 'revised', content: REFINED_TEXT })

    // The review-based revision is driven by the persisted default confirmation.
    const confirmationCalls = doubles.invokeWithProjectSession.mock.calls
      .filter(call => call[1] === 'db:review-create')
    expect(confirmationCalls).toHaveLength(1)
    const confirmationPayload = confirmationCalls[0][2] as { content: string, baseDraftId: number }
    const confirmed = buildDefaultConfirmedReviewSnapshot({
      sourceReviewId: 21,
      sourceDraft: { id: 7, chapterNumber: 1, version: 1, status: 'revised', content: REFINED_TEXT },
      reportContent: reviewReport([
        { category: '剧情连贯性', severity: 'error', description: '与前文矛盾', quote: '原始草稿' },
      ]),
      fallbackCategory: '综合检查',
    })
    expect(JSON.parse(confirmationPayload.content)).toEqual(confirmed)
    expect(confirmed?.items[0]).toMatchObject({ decision: 'apply', origin: 'ai' })

    // Finalization receives the fully accepted pipeline output.
    expect(doubles.finalizeChapterParams[0]).toMatchObject({
      draftContent: FIXED_TEXT,
      eventSource: 'batch',
    })
  })

  it('skips the review-driven revision when the default checklist has nothing to apply', async () => {
    doubles.reviewExecute.mockImplementation(async ({ context }: { context: WorkflowContext }) => {
      context.data.reviewId = 21
      context.data.reviewReport = reviewReport([
        { category: '剧情连贯性', severity: 'pass', description: '未发现矛盾' },
        { category: '本章目标', severity: 'error', description: '目标未完成', goalId: 'ch1:keyEvents:1' },
      ])
      return '{}'
    })

    const workflow = createBatchChapterWorkflow(pipelineParams())
    await useWorkflowStore.getState().startWorkflow(workflow)

    expect(useWorkflowStore.getState().history[0]?.status).toBe('completed')
    // Goal rows default to ignore, so nothing is left to apply.
    expect(doubles.refineFromReviewExecute).not.toHaveBeenCalled()
    expect(doubles.applyMergedRevision).toHaveBeenCalledTimes(1)
    expect(doubles.invokeWithProjectSession.mock.calls.some(call => call[1] === 'db:review-create'))
      .toBe(false)
    expect(doubles.finalizeChapterParams[0]).toMatchObject({ draftContent: REFINED_TEXT })
  })

  it('stops the batch when the revise step produces no mergeable revision', async () => {
    doubles.refineDraftExecute.mockImplementation(async () => REFINED_TEXT)

    const workflow = createBatchChapterWorkflow(pipelineParams())
    await useWorkflowStore.getState().startWorkflow(workflow)

    expect(useWorkflowStore.getState().history[0]?.status).toBe('failed')
    expect(doubles.applyMergedRevision).not.toHaveBeenCalled()
    expect(doubles.finalizeChapterParams).toHaveLength(0)
  })
})

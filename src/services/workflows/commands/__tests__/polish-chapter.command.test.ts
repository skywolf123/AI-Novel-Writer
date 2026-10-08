import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ModelExecutionLeaseReceipt } from '../../../../shared/ipc-channels'
import { useEditorStore } from '../../../../stores/editor-store'
import { useProjectStore } from '../../../../stores/project-store'
import type { StepCallbacks, WorkflowContext } from '../../../../stores/workflow-store'
import {
  createGenerationRuntime,
  type GenerationRuntimeEnvironment,
} from '../../../generation/generation-runtime'
import { PolishChapterCommand } from '../polish-chapter.command'
import type { WorkflowGenerationRuntimeDependencies } from '../base-command'

const PROJECT_PATH = 'C:\\novels\\polish'
const PROJECT_SESSION = Object.freeze({
  projectId: 'polish',
  leaseId: 'project-lease-polish',
  projectPath: PROJECT_PATH,
})

const SOURCE = '他把刀收回鞘里，转身走出巷子。雨停了，他加快脚步走向城南的渡口。'.repeat(30)
const CLEAN_POLISHED = '他把刀收回鞘中，转身出了巷子。雨已经停了，他加快脚步，往城南渡口走去。'.repeat(30)
const DIRTY_POLISHED = '空气仿佛凝固了，他的眼中闪过一丝惊讶，嘴角勾起一抹冷笑，仿佛命运的齿轮开始转动。'.repeat(25)

function leaseReceipt(): ModelExecutionLeaseReceipt {
  return {
    leaseId: 'model-lease-polish',
    modelId: 'model-a',
    provider: 'custom',
    protocol: 'openai',
    modelName: 'model-a',
    modelRevision: 'a'.repeat(64),
    endpointFingerprint: 'b'.repeat(64),
    capabilityEvidence: {
      source: {
        contextWindowTokens: 'unknown',
        maxOutputTokens: 'user-operational-cap',
        featureFlags: 'unknown',
      },
      subjectFingerprint: 'c'.repeat(64),
      contextWindowTokens: 32_768,
      maxOutputTokens: 8192,
      reasoning: null,
      structuredOutput: true,
      usage: null,
    },
    createdAt: 1000,
    expiresAt: 61_000,
  }
}

function runtimeDependencies(
  completeWithLease: GenerationRuntimeEnvironment['completeWithLease'],
): WorkflowGenerationRuntimeDependencies {
  return {
    createRuntime: options => createGenerationRuntime(options, {
      snapshotDefaultModelId: () => 'model-a',
      beginModelExecution: async () => leaseReceipt(),
      completeWithLease,
      closeModelExecution: async () => {},
    }),
  }
}

function workflowContext(): WorkflowContext {
  return {
    runId: 'polish-run',
    projectPath: PROJECT_PATH,
    projectSession: PROJECT_SESSION,
    writingLanguage: 'zh-CN',
    uiLocale: 'zh-CN',
    data: {},
    cancelled: false,
  }
}

function callbacks(): StepCallbacks {
  return { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() }
}

function command(
  completeWithLease: GenerationRuntimeEnvironment['completeWithLease'],
  draftContent = SOURCE,
  options: { userPolishPrompt?: string } = {},
): PolishChapterCommand {
  return new PolishChapterCommand({
    draftPath: 'vela://draft/1',
    draftContent,
    sourceDraft: { id: 1, chapterNumber: 1, version: 1, status: 'draft', contentRevision: 1 },
    chapterNumber: 1,
    chapterInfo: {
      projectPath: PROJECT_PATH,
      chapterNumber: 1,
      title: '第一章',
      role: '开端',
      purpose: '建立冲突',
      keyEvents: '事件',
      characters: [],
    },
    userPolishPrompt: options.userPolishPrompt,
  }, runtimeDependencies(completeWithLease))
}

function stubIpc(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
): void {
  vi.stubGlobal('window', {
    velaAPI: {
      invoke: (channel: string, ...args: unknown[]) => (
        channel === 'prompt:load-global'
          ? Promise.resolve({ templates: [], diagnostics: [] })
          : channel === 'fs:check-exists' && String(args[0]).endsWith('/.vela/prompts')
            ? Promise.resolve(false)
            : invoke(channel, ...args)
      ),
    },
  })
}

function revisionIpc(options: { revisionResult?: unknown } = {}) {
  return vi.fn(async (channel: string, ...args: unknown[]) => {
    void args
    if (channel === 'db:revision-replace-pending') {
      return options.revisionResult ?? { success: true, id: 9, revisionIndex: 3 }
    }
    throw new Error(`unexpected IPC: ${channel}`)
  })
}

function gateJson(verdict: 'pass' | 'full' | 'spot', problems: unknown[] = []): string {
  return JSON.stringify({ verdict, problems })
}

const SPOT_PROBLEMS = [
  { type: 'ai-flavor', scope: 'local', quote: '空气仿佛凝固了', suggestion: '改为具体动作' },
]

beforeEach(() => {
  useProjectStore.setState({
    currentProject: {
      id: 'polish',
      name: 'Polish',
      path: PROJECT_PATH,
      sessionLease: PROJECT_SESSION.leaseId,
      novelConfig: { globalGuidance: '', wordsPerChapter: 3000 },
    } as never,
  })
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useProjectStore.setState({ currentProject: null })
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
})

describe('PolishChapterCommand', () => {
  it('ships round 1 and creates a polish revision when the gate passes', async () => {
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
      .mockResolvedValueOnce({ content: CLEAN_POLISHED, finishReason: 'stop' })
      .mockResolvedValueOnce({ content: gateJson('pass'), finishReason: 'stop' })
    const invoke = revisionIpc()
    stubIpc(invoke)

    const result = await command(completeWithLease).execute({
      step: {},
      context: workflowContext(),
      callbacks: callbacks(),
    })

    expect(result).toBe(CLEAN_POLISHED)
    expect(completeWithLease).toHaveBeenCalledTimes(2)
    expect(invoke.mock.calls.filter(([channel]) => channel === 'db:revision-replace-pending')).toEqual([
      ['db:revision-replace-pending', expect.objectContaining({
        revisionType: 'polish',
        content: CLEAN_POLISHED,
      }), PROJECT_PATH, PROJECT_SESSION],
    ])
    const tabs = useEditorStore.getState().tabs
    expect(tabs.some(tab => tab.name.includes('润色合并'))).toBe(true)
  })

  it('re-polishes the full chapter from gate feedback and ships the improved draft', async () => {
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
      .mockResolvedValueOnce({ content: DIRTY_POLISHED, finishReason: 'stop' })
      .mockResolvedValueOnce({ content: gateJson('full', [
        { type: 'rhythm', scope: 'global', suggestion: '段落节奏失衡' },
      ]), finishReason: 'stop' })
      .mockResolvedValueOnce({ content: CLEAN_POLISHED, finishReason: 'stop' })
      .mockResolvedValueOnce({ content: gateJson('pass'), finishReason: 'stop' })
    const invoke = revisionIpc()
    stubIpc(invoke)

    await command(completeWithLease).execute({
      step: {},
      context: workflowContext(),
      callbacks: callbacks(),
    })

    expect(completeWithLease).toHaveBeenCalledTimes(4)
    const thirdRequest = completeWithLease.mock.calls[2]?.[0].messages
      .map(message => message.content).join('\n') ?? ''
    expect(thirdRequest).toContain('上一稿存在以下问题')
    expect(thirdRequest).toContain('〔节奏·全局〕')
    const payload = invoke.mock.calls.find(([channel]) => channel === 'db:revision-replace-pending')?.[1]
    expect(payload).toMatchObject({ revisionType: 'polish', content: CLEAN_POLISHED })
  })

  it('applies spot-fix patches and passes gate 2', async () => {
    // 单处污染：一个补丁即可完全清除，第二轮门控才可能放行
    const cleanBase = '他把刀收回鞘中，转身出了巷子。雨已经停了，他加快脚步，往城南渡口走去。'
    const onceDirty = cleanBase.repeat(30) + '空气仿佛凝固了，他的眼中闪过一丝惊讶。'
    const patched = cleanBase.repeat(30) + '巷子里静得能听见脚步声。'
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
      .mockResolvedValueOnce({ content: onceDirty, finishReason: 'stop' })
      .mockResolvedValueOnce({ content: gateJson('spot', SPOT_PROBLEMS), finishReason: 'stop' })
      .mockResolvedValueOnce({ content: JSON.stringify({
        patches: [{ find: '空气仿佛凝固了，他的眼中闪过一丝惊讶。', replace: '巷子里静得能听见脚步声。' }],
      }), finishReason: 'stop' })
      .mockResolvedValueOnce({ content: gateJson('pass'), finishReason: 'stop' })
    const invoke = revisionIpc()
    stubIpc(invoke)

    const logs = callbacks()
    const result = await command(completeWithLease, SOURCE).execute({
      step: {},
      context: workflowContext(),
      callbacks: logs,
    })

    expect(result).toBe(patched)
    expect(completeWithLease).toHaveBeenCalledTimes(4)
    const patchRequest = completeWithLease.mock.calls[2]?.[0].messages
      .map(message => message.content).join('\n') ?? ''
    expect(patchRequest).toContain('空气仿佛凝固了')
    const payload = invoke.mock.calls.find(([channel]) => channel === 'db:revision-replace-pending')?.[1]
    expect(payload).toMatchObject({ content: patched })
    const logText = vi.mocked(logs.log).mock.calls.map(([message]) => message).join('\n')
    expect(logText).toContain('定点修复：生成 1 处修改，成功应用 1 处')
  })

  it('degrades to deterministic-only gating when the gate call fails', async () => {
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
      .mockResolvedValueOnce({ content: CLEAN_POLISHED, finishReason: 'stop' })
      .mockRejectedValueOnce(new Error('gate provider down'))
    const invoke = revisionIpc()
    stubIpc(invoke)

    const logs = callbacks()
    await command(completeWithLease).execute({
      step: {},
      context: workflowContext(),
      callbacks: logs,
    })

    expect(completeWithLease).toHaveBeenCalledTimes(2)
    const logText = vi.mocked(logs.log).mock.calls.map(([message]) => message).join('\n')
    expect(logText).toContain('降级为纯确定性判定')
    const payload = invoke.mock.calls.find(([channel]) => channel === 'db:revision-replace-pending')?.[1]
    expect(payload).toMatchObject({ revisionType: 'polish' })
  })

  it('keeps the source draft and creates no revision when every candidate regresses', async () => {
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
      .mockResolvedValueOnce({ content: DIRTY_POLISHED, finishReason: 'stop' })
      .mockResolvedValueOnce({ content: gateJson('spot', SPOT_PROBLEMS), finishReason: 'stop' })
      .mockResolvedValueOnce({ content: JSON.stringify({
        patches: [{ find: '这段文字不存在于正文中', replace: '无所谓' }],
      }), finishReason: 'stop' })
      .mockResolvedValueOnce({ content: gateJson('spot', SPOT_PROBLEMS), finishReason: 'stop' })
      .mockResolvedValueOnce({ content: JSON.stringify({ patches: [] }), finishReason: 'stop' })
    const invoke = revisionIpc()
    stubIpc(invoke)

    await expect(command(completeWithLease).execute({
      step: {},
      context: workflowContext(),
      callbacks: callbacks(),
    })).rejects.toThrow('润色未能改善文本质量')

    expect(invoke.mock.calls.some(([channel]) => channel === 'db:revision-replace-pending')).toBe(false)
  })

  it('keeps retrying provider-level failures in later rounds (only session-budget errors short-circuit)', async () => {
    // provider 层失败被 harness 包装为 PROVIDER_REQUEST_FAILED（瞬时错误），
    // 设计上第 3 轮仍应尝试；会话级预算耗尽由 harness 入口检查抛出（无法经
    // provider mock 触发），其识别逻辑在 polish-gate.test.ts 单测覆盖。
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
      .mockResolvedValueOnce({ content: DIRTY_POLISHED, finishReason: 'stop' })
      .mockResolvedValueOnce({ content: gateJson('spot', SPOT_PROBLEMS), finishReason: 'stop' })
      .mockRejectedValueOnce(new Error('provider transient failure'))
    const invoke = revisionIpc()
    stubIpc(invoke)

    const logs = callbacks()
    await expect(command(completeWithLease, SOURCE).execute({
      step: {},
      context: workflowContext(),
      callbacks: logs,
    })).rejects.toThrow('润色未能改善文本质量')

    expect(completeWithLease).toHaveBeenCalledTimes(4)
    const logText = vi.mocked(logs.log).mock.calls.map(([message]) => message).join('\n')
    expect(logText).toContain('门控问题：')
    expect(logText).toContain('〔AI 痕迹〕')
    expect(logText).toContain('第 3 轮')
  })

  it('opens the generation session with the dedicated polish budget', async () => {
    let capturedBudget: unknown = null
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
      .mockResolvedValueOnce({ content: CLEAN_POLISHED, finishReason: 'stop' })
      .mockResolvedValueOnce({ content: gateJson('pass'), finishReason: 'stop' })
    const runtimeDependencies: WorkflowGenerationRuntimeDependencies = {
      createRuntime: options => {
        capturedBudget = options.budget
        return createGenerationRuntime(options, {
          snapshotDefaultModelId: () => 'model-a',
          beginModelExecution: async () => leaseReceipt(),
          completeWithLease,
          closeModelExecution: async () => {},
        })
      },
    }
    stubIpc(revisionIpc())

    await new PolishChapterCommand({
      draftPath: 'vela://draft/1',
      draftContent: SOURCE,
      sourceDraft: { id: 1, chapterNumber: 1, version: 1, status: 'draft', contentRevision: 1 },
      chapterNumber: 1,
      chapterInfo: {
        projectPath: PROJECT_PATH,
        chapterNumber: 1,
        title: '第一章',
        role: '开端',
        purpose: '建立冲突',
        keyEvents: '事件',
        characters: [],
      },
    }, runtimeDependencies).execute({
      step: {},
      context: workflowContext(),
      callbacks: callbacks(),
    })

    // Derived worst path: (1+3) + (1+1) + (1+3) + (1+1) + (1+2) = 15 attempts.
    expect(capturedBudget).toMatchObject({ maxAttempts: 15 })
  })

  it('prefers the latest candidate when deterministic scores tie (rounds keep their fixes)', async () => {
    // 全程 0.00 平局时不得回滚到第 1 轮：第 3 轮包含前两轮门控修复，应胜出。
    const cleanBase = '他把刀收回鞘中，转身出了巷子。雨已经停了，他加快脚步，往城南渡口走去。'
    const r1 = cleanBase.repeat(30) + '院里的雪还在下。'
    const r3 = cleanBase.repeat(30) + '院里的雪停了。'
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
      .mockResolvedValueOnce({ content: r1, finishReason: 'stop' })
      .mockResolvedValueOnce({ content: gateJson('spot', SPOT_PROBLEMS), finishReason: 'stop' })
      .mockResolvedValueOnce({ content: JSON.stringify({
        patches: [{ find: '院里的雪还在下。', replace: '院里的雪还在落。' }],
      }), finishReason: 'stop' })
      .mockResolvedValueOnce({ content: gateJson('spot', SPOT_PROBLEMS), finishReason: 'stop' })
      .mockResolvedValueOnce({ content: JSON.stringify({
        patches: [{ find: '院里的雪还在落。', replace: '院里的雪停了。' }],
      }), finishReason: 'stop' })
    const invoke = revisionIpc()
    stubIpc(invoke)

    await command(completeWithLease, SOURCE).execute({
      step: {},
      context: workflowContext(),
      callbacks: callbacks(),
    })

    expect(completeWithLease).toHaveBeenCalledTimes(5)
    const payload = invoke.mock.calls.find(([channel]) => channel === 'db:revision-replace-pending')?.[1]
    expect(payload).toMatchObject({ revisionType: 'polish', content: r3 })
  })

  it('injects the author polish guidance at the highest priority across rounds', async () => {
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
      .mockResolvedValueOnce({ content: CLEAN_POLISHED, finishReason: 'stop' })
      .mockResolvedValueOnce({ content: gateJson('pass'), finishReason: 'stop' })
    stubIpc(revisionIpc())

    await command(completeWithLease, SOURCE, { userPolishPrompt: '保持短句节奏' }).execute({
      step: {},
      context: workflowContext(),
      callbacks: callbacks(),
    })

    const firstRequest = completeWithLease.mock.calls[0]?.[0].messages
      .map(message => message.content).join('\n') ?? ''
    expect(firstRequest).toContain('【作者额外润色要求（最高优先级）】')
    expect(firstRequest).toContain('保持短句节奏')
  })
})

import { BaseWorkflowCommand, CommandExecuteParams, type WorkflowGenerationRuntimeDependencies } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { resolvePromptTemplate } from '../../prompt-templates'
import { BasePromptBuilder } from '../../prompts/prompt-builder'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../../shared/project-session-context'
import {
  requireWorkflowProjectSession,
  workflowUiText,
  workflowWritingLanguage,
} from '../workflow-project-session'
import {
  parseKeyEventBeats,
  validateKeyEventBeats,
  KEY_EVENT_BEAT_MAX_ITEMS,
  KEY_EVENT_BEAT_MIN_ITEMS,
} from '../../../shared/key-event-beats'
import { StructuredContractDiagnostic } from '../../../shared/structured-contract-diagnostic'

export interface SplitKeyEventsOptions {
  chapterNumber: number
  /** 当前蓝图的 keyEvents 原文，是本次拆分的唯一输入。 */
  keyEvents: string
  /** 结果交回编辑器填入未保存状态；命令本身不写库。 */
  onGenerated: (beats: string[]) => void
}

/**
 * 把单章蓝图 keyEvents 的长段落按原意拆成 2-6 个事件节拍（只改格式不改内容）。
 * 结果通过回调回填编辑器，由作者确认后再手动保存；不在命令内写库。
 */
export class SplitKeyEventsCommand extends BaseWorkflowCommand<string> {
  constructor(
    private readonly options: SplitKeyEventsOptions,
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
  ) {
    super(generationDependencies)
  }

  async execute(params: CommandExecuteParams): Promise<string> {
    return this.executeWithGenerationRuntime('text', params, () => this.executeWithinGeneration(params))
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const projectSession = requireWorkflowProjectSession(context)
    const writingLanguage = workflowWritingLanguage(context)
    const project = useProjectStore.getState().currentProject
    if (!project || !sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(project),
    )) throw new Error(text('当前项目已切换，拆分已停止', 'The project changed, so the split stopped.'))

    const source = this.options.keyEvents.trim()
    if (!source) throw new Error(text('关键事件为空，无法拆分', 'The key events are empty, so nothing can be split.'))

    callbacks.log(text(
      `正在把第 ${this.options.chapterNumber} 章关键事件拆分为 ${KEY_EVENT_BEAT_MIN_ITEMS}-${KEY_EVENT_BEAT_MAX_ITEMS} 个节拍...`,
      `Splitting Chapter ${this.options.chapterNumber} key events into ${KEY_EVENT_BEAT_MIN_ITEMS}-${KEY_EVENT_BEAT_MAX_ITEMS} beats...`,
    ))

    const template = await resolvePromptTemplate('split_key_events', projectSession, writingLanguage)
    if (!template) throw new Error(text('未找到关键事件拆分模板', 'The key-event split template was not found.'))

    const promptBuilder = new BasePromptBuilder(template, writingLanguage)
    // BasePromptBuilder 不暴露 chapter_number/key_events 的链式 setter；
    // 该模块只需这两个变量，与 analyze-style 同样直接写入 variables。
    ;(promptBuilder as unknown as { variables: Record<string, string> }).variables = {
      chapter_number: String(this.options.chapterNumber),
      key_events: source,
    }

    const completion = await this.callLLMResult(
      promptBuilder.build(),
      promptBuilder.getSystemRole(),
      callbacks,
      {
        responseFormat: { type: 'json_object' },
        purpose: 'split-key-events',
        reasoningStage: 'planning',
        writingSkillStage: 'planning',
      },
      context,
    )
    if (completion.finishReason !== 'stop') {
      throw this.createIncompleteCompletionError(completion.finishReason)
    }
    this.assertNotCancelled(context)

    let beats: string[]
    try {
      beats = parseKeyEventBeats(this.stripThinkingTags(completion.content))
    } catch (error) {
      const reason = error instanceof StructuredContractDiagnostic ? error.message : String(error)
      throw new Error(text(
        `关键事件拆分结果不符合合同：${reason}。请重试，或在模板管理中检查「关键事件拆分节拍」模板。`,
        `The key-event split did not match the contract: ${reason}. Retry, or check the "Split key events into beats" template in template management.`,
      ))
    }
    const validated = validateKeyEventBeats(beats)
    if (!validated.ok) {
      throw new Error(validated.reason === 'count'
        ? text(
            `关键事件拆分得到 ${beats.length} 个节拍，超出 ${KEY_EVENT_BEAT_MIN_ITEMS}-${KEY_EVENT_BEAT_MAX_ITEMS} 的范围，未回填。请重试。`,
            `The split produced ${beats.length} beats, outside the ${KEY_EVENT_BEAT_MIN_ITEMS}-${KEY_EVENT_BEAT_MAX_ITEMS} range, so nothing was filled in. Retry.`,
          )
        : text(
            '关键事件拆分结果含空节拍，未回填。请重试。',
            'The split produced an empty beat, so nothing was filled in. Retry.',
          ))
    }

    callbacks.log(text(
      `拆分完成：${validated.beats.length} 个节拍，已回填编辑框，请确认后保存。`,
      `Split complete: ${validated.beats.length} beats filled into the editor; review and save.`,
    ))
    this.options.onGenerated(validated.beats)
    return validated.beats.join('\n')
  }
}

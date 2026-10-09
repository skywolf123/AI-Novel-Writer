import { workflowResourceKey, type WorkflowDefinition } from '../../stores/workflow-store'
import { useLocaleStore } from '../../stores/locale-store'
import { useProjectStore } from '../../stores/project-store'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import {
  projectSessionContextFromProject,
  sameProjectPathKey,
  sameProjectSessionContext,
} from '../../shared/project-session-context'

export interface SplitKeyEventsWorkflowParams {
  projectPath: string
  /** UI 在异步确认前冻结的完整项目会话。 */
  projectSession: ProjectSessionContext
  chapterNumber: number
  /** 当前蓝图的 keyEvents 原文，是本次拆分的唯一输入。 */
  keyEvents: string
  /** 拆分结果回填编辑器未保存状态；工作流本身不写库。 */
  onGenerated: (beats: string[]) => void
}

/**
 * 单章 blueprint keyEvents 的节拍拆分工作流：只重新组织格式，不改事件内容，
 * 结果回填编辑器由作者确认后手动保存。
 */
export function createSplitKeyEventsWorkflow(params: SplitKeyEventsWorkflowParams): WorkflowDefinition {
  const text = useLocaleStore.getState().text
  const project = useProjectStore.getState().currentProject
  const currentProjectSession = projectSessionContextFromProject(project)
  if (
    !project
    || !currentProjectSession
    || !sameProjectPathKey(project.path, params.projectPath)
    || !sameProjectSessionContext(params.projectSession, currentProjectSession)
  ) {
    throw new Error(text('当前项目已切换，无法拆分关键事件', 'The project changed, so key events cannot be split.'))
  }
  const projectSession = Object.freeze({ ...params.projectSession })
  return {
    type: 'config_generation',
    title: text('拆分关键事件节拍', 'Split key events into beats'),
    projectPath: params.projectPath,
    projectSession,
    // 与蓝图生成互斥（同一 'blueprints' 资源），不允许并发生成与拆分。
    resourceKeys: [workflowResourceKey('blueprints')],
    steps: [
      {
        name: text('拆分关键事件节拍', 'Split key events into beats'),
        description: text(
          `把第 ${params.chapterNumber} 章关键事件按原意拆成 2-6 个事件节拍（只改格式）`,
          `Split Chapter ${params.chapterNumber} key events into 2-6 beats preserving the original meaning (format only)`,
        ),
        executor: async (step, context, callbacks) => {
          const { SplitKeyEventsCommand } = await import('./commands/split-key-events.command')
          const cmd = new SplitKeyEventsCommand({
            chapterNumber: params.chapterNumber,
            keyEvents: params.keyEvents,
            onGenerated: params.onGenerated,
          })
          return cmd.execute({ step, context, callbacks })
        },
      },
    ],
    onComplete: {
      mode: 'silent',
      message: text('关键事件已拆分为节拍，请确认后保存蓝图。', 'Key events were split into beats. Review them, then save the blueprint.'),
    },
  }
}

/**
 * manual-draft — 作者手动创建空草稿
 *
 * 不走 AI、不携带来源依赖，只往当前章节追加一条空正文草稿，供作者从零手写。
 * 空草稿不能定稿（定稿命令会因无内容拒绝），因此这是一个安全的「手写逃生舱」。
 */
import { ipc } from './ipc-client'
import { requireIpcSuccess } from './ipc-result'
import type { ProjectSessionContext } from '../shared/ipc-channels'

export interface ManualBlankDraftResult {
  draftId: number
  version: number
  /** true 表示复用了该章已存在的空手动草稿，没有新建版本。 */
  reusedExisting: boolean
}

/**
 * 为指定章节创建（或复用）一条空的手动草稿。
 *
 * 重复点击不应堆出多个空版本：若该章最新草稿本身就是空的手动草稿，直接复用。
 */
export async function createManualBlankDraft(
  chapterNumber: number,
  projectSession: ProjectSessionContext,
): Promise<ManualBlankDraftResult> {
  const projectPath = projectSession.projectPath
  const latest = await ipc.invokeWithProjectSession(
    projectSession,
    'db:draft-get-latest',
    chapterNumber,
    projectPath,
  )
  if (
    latest
    && latest.source === 'manual'
    && latest.status === 'draft'
    && (latest.wordCount ?? 0) === 0
  ) {
    return { draftId: latest.id, version: latest.version, reusedExisting: true }
  }

  const version = await ipc.invokeWithProjectSession(
    projectSession,
    'db:draft-next-version',
    chapterNumber,
    projectPath,
  )
  const created = await ipc.invokeWithProjectSession(
    projectSession,
    'db:draft-create',
    {
      chapterNumber,
      version,
      source: 'manual',
      content: '',
      wordCount: 0,
    },
    projectPath,
  )
  requireIpcSuccess(created, '创建空草稿')
  if (!created.id) throw new Error('创建空草稿失败：未返回草稿 ID')
  return { draftId: created.id, version, reusedExisting: false }
}

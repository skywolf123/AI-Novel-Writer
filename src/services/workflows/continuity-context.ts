import { ipc } from '../ipc-client'
import { promptLanguageText } from '../prompt-language'
import { CHARACTER_STATE_TEXT_FIELDS } from '../../shared/character-roster'
import type { FinalizedContinuityProjection } from '../../shared/finalized-continuity'
import type { ProjectSessionContext } from '../../shared/ipc-channels'

type WritingLanguage = NonNullable<Parameters<typeof promptLanguageText>[0]>

/**
 * 已定稿连续性事实与角色状态的读取逻辑，供审稿与审稿修复共用：
 * 两边必须看到同一份事实源，修复补丁才不会与审稿所依据的事实矛盾。
 * 读取失败返回占位文本，不阻断流程。
 */

export function formatFinalizedHistory(
  projections: readonly FinalizedContinuityProjection[],
  writingLanguage: WritingLanguage,
): string {
  const header = promptLanguageText(
    writingLanguage,
    '【已确认定稿历史｜唯一已发生事实源】',
    '[Finalized history | the only source of events that have already happened]',
  )
  if (projections.length === 0) return `${header}\n${promptLanguageText(
    writingLanguage,
    '（当前章节之前没有已定稿历史）',
    '(there is no finalized history before the current chapter)',
  )}`
  return [
    header,
    ...projections.map((projection) => {
      const facts = (projection.facts ?? []).map(fact => promptLanguageText(
        writingLanguage,
        `- [${fact.category}] ${fact.statement}（来源第${fact.sourceChapter}章；证据：${fact.evidence}）`,
        `- [${fact.category}] ${fact.statement} (source: Chapter ${fact.sourceChapter}; evidence: ${fact.evidence})`,
      ))
      return [
        promptLanguageText(
          writingLanguage,
          `### 第${projection.chapterNumber}章 ${projection.chapterTitle}`,
          `### Chapter ${projection.chapterNumber}: ${projection.chapterTitle}`,
        ),
        projection.chapterNotes,
        ...facts,
      ].filter(Boolean).join('\n')
    }),
  ].join('\n\n')
}

export async function readFinalizedHistory(
  chapterNumber: number,
  projectSession: ProjectSessionContext,
  writingLanguage: WritingLanguage,
): Promise<string> {
  try {
    const projections = await ipc.invokeWithProjectSession(
      projectSession,
      'db:continuity-list-before',
      chapterNumber,
      projectSession.projectPath,
    )
    return formatFinalizedHistory(projections, writingLanguage)
  } catch {
    return promptLanguageText(
      writingLanguage,
      '【已确认定稿历史｜唯一已发生事实源】\n（连续性投影暂时不可用；未使用知识库资料替代）',
      '[Finalized history | the only source of events that have already happened]\n(continuity projection unavailable; knowledge-base material was not substituted)',
    )
  }
}

export async function readCharacterStates(
  projectSession: ProjectSessionContext,
  writingLanguage: WritingLanguage,
): Promise<string> {
  try {
    const allChars = await ipc.invokeWithProjectSession(
      projectSession, 'db:character-get-all', projectSession.projectPath,
    )
    const states: string[] = []
    for (const card of allChars) {
      if (card.name && card.currentState) {
        const cs = card.currentState
        const authorState = Object.fromEntries(CHARACTER_STATE_TEXT_FIELDS.flatMap((field) => {
          const provenance = cs.provenance?.[field]
          return provenance?.kind === 'author' && cs[field]
            ? [[field, `${cs[field]} @ch${provenance.chapterNumber}`]]
            : []
        }))
        if (Object.keys(authorState).length === 0) continue
        states.push(promptLanguageText(
          writingLanguage,
          `${card.name}（${card.role || '未知'}）作者状态（按标注章节理解，非永久约束）: ${JSON.stringify(authorState)}`,
          `${card.name} (${card.role || 'unknown'}) author state (time-bound to the annotated chapter, not permanent): ${JSON.stringify(authorState)}`,
        ))
      }
    }
    return states.length > 0 ? states.join('\n') : promptLanguageText(writingLanguage, '（暂无）', '(none)')
  } catch { return promptLanguageText(writingLanguage, '（读取失败）', '(unavailable)') }
}

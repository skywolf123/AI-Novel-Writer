import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ProjectData } from '../../../shared/ipc-channels'
import type { AuthoritativeChapterSequence } from '../../../shared/author-manuscript-import'
import type { ChapterBlueprint } from '../../../services/workflows/directory-workflow'
import { useEditorStore } from '../../../stores/editor-store'
import { useLayoutStore } from '../../../stores/layout-store'
import { useProjectStore } from '../../../stores/project-store'
import { toast } from '../../ui/Toast'
import ChapterCardEditor from '../ChapterCardEditor'

const PROJECT_PATH = 'C:\\novels\\chapter-write-entry'
const originalEditorState = useEditorStore.getState()
const originalLayoutState = useLayoutStore.getState()
const originalProjectState = useProjectStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined

function project(): ProjectData {
  return {
    id: 'chapter-write-entry',
    sessionLease: 'chapter-write-entry-lease',
    name: '章节入口测试项目',
    path: PROJECT_PATH,
    novelConfig: {
      genre: '玄幻',
      subGenre: '',
      targetAudience: '全龄',
      totalChapters: 1,
      wordsPerChapter: 3000,
      plotStructure: 'three_act',
      narrativePOV: 'third_limited',
      coreOutline: '',
      worldSetting: '',
      goldenFinger: '',
      protagonistProfile: '',
      globalGuidance: '',
    },
    characterStates: '',
    createdAt: '',
    updatedAt: '',
  }
}

function blueprint(chapterNumber: number): ChapterBlueprint {
  return {
    chapterNumber,
    title: '雨夜启程',
    role: '建置',
    purpose: '建立主角的首个目标。',
    keyEvents: '收到匿名信。',
    characters: ['沈砺'],
    suspenseHook: '信封背面出现陌生署名。',
    userGuidance: '',
    notes: '',
    notesUpdatedAt: '',
  }
}

function installIpc(options: {
  blueprints?: ChapterBlueprint[]
  finalizedChapter?: (chapterNumber: number) => unknown
  onClearGeneratedText?: () => void
  authoritySequence?: AuthoritativeChapterSequence | (() => AuthoritativeChapterSequence)
  latestDraft?: unknown | (() => unknown)
  createdDraftId?: number
} = {}) {
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'db:blueprint-get-all') return options.blueprints ?? [blueprint(1)]
    if (channel === 'db:draft-authority-sequence') return typeof options.authoritySequence === 'function'
      ? options.authoritySequence()
      : options.authoritySequence ?? {
          status: 'empty',
          lastChapterNumber: 0,
          nextChapterNumber: 1,
          duplicateChapterNumbers: [],
          authorityFingerprint: 'a'.repeat(64),
        }
    if (channel === 'db:draft-get-finalized') {
      const chapterNumber = args[0] as number
      return options.finalizedChapter?.(chapterNumber) ?? null
    }
    if (channel === 'db:draft-get-latest') {
      return typeof options.latestDraft === 'function' ? options.latestDraft() : options.latestDraft ?? null
    }
    if (channel === 'db:draft-next-version') return 1
    if (channel === 'db:draft-create') return { success: true, id: options.createdDraftId ?? 77 }
    if (channel === 'db:draft-list') return []
    if (channel === 'db:project-clear-generated-data') {
      options.onClearGeneratedText?.()
      return { success: true, cleared: ['generatedText'] }
    }
    if (channel === 'fs:list-dir') return []
    throw new Error(`unexpected IPC ${channel}`)
  })
  Object.defineProperty(window, 'velaAPI', {
    configurable: true,
    value: {
      invoke,
      on: vi.fn(() => () => {}),
      once: vi.fn(),
      send: vi.fn(),
      setZoomLevel: vi.fn(),
      setZoomFactor: vi.fn(),
      getZoomLevel: vi.fn(() => 0),
    },
  })
  return invoke
}

async function renderEditor() {
  await act(async () => {
    root?.render(<ChapterCardEditor projectKey={PROJECT_PATH} />)
  })
}

beforeEach(() => {
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
  useLayoutStore.setState({ chapterCreationOpen: false, chapterCreationPrefill: null })
  useProjectStore.setState({ currentProject: project(), fileTree: [], loading: false })
  installIpc()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  Reflect.deleteProperty(window, 'velaAPI')
  useEditorStore.setState(originalEditorState)
  useLayoutStore.setState(originalLayoutState)
  useProjectStore.setState(originalProjectState)
})

describe('ChapterCardEditor writing entry', () => {
  it('uses finalized authority to expose Chapter 10 even when imported Chapters 1 through 9 have no blueprints', async () => {
    installIpc({
      blueprints: [blueprint(10)],
      authoritySequence: {
        status: 'continuous',
        lastChapterNumber: 9,
        nextChapterNumber: 10,
        duplicateChapterNumbers: [],
        authorityFingerprint: 'b'.repeat(64),
      },
    })

    await renderEditor()

    await vi.waitFor(() => {
      expect(container?.textContent).toContain('写作第10章')
      expect(container?.textContent).toContain('批量创作')
    })
  })

  it('creates a manual blueprint at the authoritative next chapter instead of the blueprint maximum', async () => {
    installIpc({
      blueprints: [],
      authoritySequence: {
        status: 'continuous',
        lastChapterNumber: 9,
        nextChapterNumber: 10,
        duplicateChapterNumbers: [],
        authorityFingerprint: 'b'.repeat(64),
      },
    })

    await renderEditor()
    await vi.waitFor(() => expect(container?.textContent).toContain('暂无蓝图'))
    const addButton = Array.from(container?.querySelectorAll<HTMLButtonElement>('button') ?? [])
      .find(button => button.title === '新建章节')
    expect(addButton).toBeDefined()
    await act(async () => addButton?.click())

    expect(container?.textContent).toContain('第 10 章：')
  })

  it('appends after the blueprint maximum when the authoritative next blueprint already exists', async () => {
    const info = vi.spyOn(toast, 'info').mockImplementation(() => undefined)
    installIpc({
      blueprints: [blueprint(10), blueprint(11)],
      authoritySequence: {
        status: 'continuous',
        lastChapterNumber: 9,
        nextChapterNumber: 10,
        duplicateChapterNumbers: [],
        authorityFingerprint: 'b'.repeat(64),
      },
    })

    await renderEditor()
    await vi.waitFor(() => expect(container?.textContent).toContain('写作第10章'))
    const addButton = Array.from(container?.querySelectorAll<HTMLButtonElement>('button') ?? [])
      .find(button => button.title === '新建章节')
    expect(addButton).toBeDefined()
    await act(async () => addButton?.click())

    expect(container?.textContent).toContain('第 12 章：')
    expect(container?.textContent).toContain('写作第10章')
    expect(info).toHaveBeenCalledWith(expect.stringContaining('写作入口仍为第 10 章'))
  })

  it('blocks card writing and explains duplicate finalized authority', async () => {
    installIpc({
      blueprints: [blueprint(3)],
      authoritySequence: {
        status: 'invalid',
        lastChapterNumber: 3,
        duplicateChapterNumbers: [3],
        authorityFingerprint: 'c'.repeat(64),
      },
    })

    await renderEditor()

    await vi.waitFor(() => {
      expect(container?.textContent).toMatch(/第 3 章存在重复记录/u)
    })
    expect(container?.textContent).not.toContain('写作第3章')
    expect(container?.textContent).not.toContain('批量创作')
  })

  it('shows Write Chapter 1 after blueprints are available and opens the chapter-creation workbench', async () => {
    await renderEditor()

    await vi.waitFor(() => {
      expect(container?.textContent).toContain('写作第1章')
    })
    const writeButton = Array.from(container?.querySelectorAll('button') ?? [])
      .find((button) => button.textContent?.includes('写作第1章'))

    expect(writeButton).toBeDefined()
    await act(async () => writeButton?.click())

    expect(useLayoutStore.getState()).toMatchObject({
      chapterCreationOpen: true,
      chapterCreationPrefill: expect.objectContaining({ chapterNumber: 1, title: '雨夜启程' }),
    })
  })

  it('requires explicit recovery before writing Chapter 1 when legacy-imported finalized text exists for Chapters 2 through 5', async () => {
    let legacyImportedTextExists = true
    const invoke = installIpc({
      blueprints: [1, 2, 3, 4, 5].map(blueprint),
      authoritySequence: () => legacyImportedTextExists
        ? {
            status: 'invalid',
            lastChapterNumber: 5,
            firstGapChapterNumber: 1,
            duplicateChapterNumbers: [],
            authorityFingerprint: 'd'.repeat(64),
          }
        : {
            status: 'empty',
            lastChapterNumber: 0,
            nextChapterNumber: 1,
            duplicateChapterNumbers: [],
            authorityFingerprint: 'e'.repeat(64),
          },
      finalizedChapter: (chapterNumber) => (
        legacyImportedTextExists && chapterNumber >= 2 ? { id: chapterNumber } : null
      ),
      onClearGeneratedText: () => { legacyImportedTextExists = false },
    })

    await renderEditor()

    await vi.waitFor(() => {
      expect(container?.textContent).toContain('检测到后续正文但第 1 章尚未写作')
    })
    expect(container?.textContent).not.toContain('写作第1章')
    expect(invoke).not.toHaveBeenCalledWith(
      'db:project-clear-generated-data',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    )

    const recoveryButton = Array.from(container?.querySelectorAll('button') ?? [])
      .find((button) => button.textContent?.includes('清除误导入正文'))
    expect(recoveryButton).toBeDefined()
    await act(async () => recoveryButton?.click())

    await vi.waitFor(() => {
      expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
    })
    const confirmationButton = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
      .find((button) => button.textContent?.includes('清除误导入正文'))
    expect(confirmationButton).toBeDefined()
    await act(async () => {
      confirmationButton?.click()
      await new Promise(resolve => setTimeout(resolve, 250))
    })

    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'db:project-clear-generated-data',
        expect.objectContaining({ generatedText: true }),
        PROJECT_PATH,
        expect.objectContaining({ projectPath: PROJECT_PATH }),
      )
      expect(container?.textContent).toContain('写作第1章')
    })

    expect(container?.textContent).not.toContain('检测到后续正文但第 1 章尚未写作')
  })

  it('creates a manual blank draft for a selected blueprint that is not the writable next chapter', async () => {
    const invoke = installIpc({
      blueprints: [blueprint(1), blueprint(2), blueprint(3)],
      createdDraftId: 501,
    })

    await renderEditor()
    await vi.waitFor(() => expect(container?.textContent).toContain('写作第1章'))
    // 选中第 3 章蓝图（权威下一章是第 1 章），此时没有「写作此章」按钮
    const listItems = Array.from(container?.querySelectorAll<HTMLElement>('div.group') ?? [])
    const thirdItem = listItems.find(item => item.querySelector('.font-mono')?.textContent?.trim() === '3')
    expect(thirdItem).toBeDefined()
    await act(async () => thirdItem?.click())

    await vi.waitFor(() => expect(container?.textContent).toContain('第 3 章：'))
    expect(container?.textContent).not.toContain('写作此章')

    const blankButton = Array.from(container?.querySelectorAll<HTMLButtonElement>('button') ?? [])
      .find(button => button.textContent?.includes('新建空草稿'))
    expect(blankButton).toBeDefined()
    await act(async () => blankButton?.click())

    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'db:draft-create',
        expect.objectContaining({ chapterNumber: 3, source: 'manual', content: '', wordCount: 0 }),
        PROJECT_PATH,
        expect.objectContaining({ projectPath: PROJECT_PATH }),
      )
    })
    expect(useEditorStore.getState().tabs.some(tab => tab.filePath === 'vela://draft/501')).toBe(true)
  })

  it('reuses an existing blank manual draft instead of stacking versions', async () => {
    const invoke = installIpc({
      blueprints: [blueprint(1)],
      latestDraft: { id: 42, chapterNumber: 1, version: 3, source: 'manual', status: 'draft', wordCount: 0 },
    })

    await renderEditor()
    await vi.waitFor(() => expect(container?.textContent).toContain('新建空草稿'))
    const blankButton = Array.from(container?.querySelectorAll<HTMLButtonElement>('button') ?? [])
      .find(button => button.textContent?.includes('新建空草稿'))
    await act(async () => blankButton?.click())

    await vi.waitFor(() => {
      expect(useEditorStore.getState().tabs.some(tab => tab.filePath === 'vela://draft/42')).toBe(true)
    })
    expect(invoke).not.toHaveBeenCalledWith('db:draft-create', expect.anything(), expect.anything(), expect.anything())
  })
})

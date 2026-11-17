// `closeTabsWhere` closes the tabs it is asked to and leaves every other tab as it was, with
// its unsaved edits. A project that moves to the dev folder uses it for the tabs of its folder.
import { beforeEach, describe, expect, it } from 'vitest'

import { useFileViewerStore, type TabEntry } from '@/stores/useFileViewerStore'

const viewer = (): ReturnType<typeof useFileViewerStore.getState> => useFileViewerStore.getState()
const openTabs = (): string[] => Array.from(viewer().openFiles.keys())

const inFolder =
  (folder: string) =>
  (_key: string, tab: TabEntry): boolean =>
    (tab.type === 'file' && tab.path.startsWith(`${folder}/`)) ||
    (tab.type === 'diff' && tab.worktreePath === folder)

const diffOf = (
  worktreePath: string,
  filePath: string
): {
  worktreePath: string
  filePath: string
  fileName: string
  staged: boolean
  isUntracked: boolean
} => ({
  worktreePath,
  filePath,
  fileName: filePath.split('/').pop() ?? filePath,
  staged: false,
  isUntracked: false
})

beforeEach(() => {
  viewer().closeAllFiles()
})

describe('closeTabsWhere', () => {
  it('closes the tabs that match and keeps the others, with their unsaved edits', () => {
    viewer().openFile('/old/app/src/a.ts', 'a.ts', 'wt-1')
    viewer().markDirty('/old/app/src/a.ts')
    viewer().setOriginalContent('/old/app/src/a.ts', 'a before')
    viewer().markExternallyChanged('/old/app/src/a.ts')
    viewer().openFile('/elsewhere/notes.md', 'notes.md', 'wt-9')
    viewer().markDirty('/elsewhere/notes.md')
    viewer().setOriginalContent('/elsewhere/notes.md', 'notes before')
    viewer().markExternallyChanged('/elsewhere/notes.md')

    viewer().closeTabsWhere(inFolder('/old/app'))

    expect(openTabs()).toEqual(['/elsewhere/notes.md'])
    expect(Array.from(viewer().dirtyFiles)).toEqual(['/elsewhere/notes.md'])
    expect(Array.from(viewer().originalContents)).toEqual([['/elsewhere/notes.md', 'notes before']])
    expect(Array.from(viewer().externallyChanged)).toEqual(['/elsewhere/notes.md'])
  })

  it('leaves the tab on screen where it is when it was not closed', () => {
    viewer().openFile('/elsewhere/notes.md', 'notes.md', 'wt-9')
    viewer().openFile('/old/app/src/a.ts', 'a.ts', 'wt-1')
    viewer().setActiveFile('/elsewhere/notes.md')

    viewer().closeTabsWhere(inFolder('/old/app'))

    expect(viewer().activeFilePath).toBe('/elsewhere/notes.md')
    expect(viewer().activeDiff).toBeNull()
  })

  it('shows the last tab left when the tab on screen was closed', () => {
    viewer().openFile('/elsewhere/first.md', 'first.md', 'wt-9')
    viewer().openFile('/elsewhere/last.md', 'last.md', 'wt-9')
    viewer().openFile('/old/app/src/a.ts', 'a.ts', 'wt-1')
    expect(viewer().activeFilePath).toBe('/old/app/src/a.ts')

    viewer().closeTabsWhere(inFolder('/old/app'))

    expect(viewer().activeFilePath).toBe('/elsewhere/last.md')
    expect(viewer().activeDiff).toBeNull()
  })

  it('shows the diff of the last tab left when that tab is a diff', () => {
    viewer().setActiveDiff(diffOf('/elsewhere', 'src/kept.ts'))
    const keptKey = openTabs()[0]
    viewer().openFile('/old/app/src/a.ts', 'a.ts', 'wt-1')

    viewer().closeTabsWhere(inFolder('/old/app'))

    expect(openTabs()).toEqual([keptKey])
    expect(viewer().activeFilePath).toBe(keptKey)
    expect(viewer().activeDiff).toEqual({
      worktreePath: '/elsewhere',
      filePath: 'src/kept.ts',
      fileName: 'kept.ts',
      staged: false,
      isUntracked: false,
      isNewFile: undefined,
      compareBranch: undefined,
      prReviewWorktreeId: undefined
    })
  })

  it('closes a diff on screen and takes it off the screen when no tab is left', () => {
    viewer().setActiveDiff(diffOf('/old/app', 'src/a.ts'))

    viewer().closeTabsWhere(inFolder('/old/app'))

    expect(openTabs()).toEqual([])
    expect(viewer().activeFilePath).toBeNull()
    expect(viewer().activeDiff).toBeNull()
  })

  it('does not put a tab on screen when none was', () => {
    viewer().openFile('/elsewhere/notes.md', 'notes.md', 'wt-9')
    viewer().openFile('/old/app/src/a.ts', 'a.ts', 'wt-1')
    viewer().setActiveFile(null)

    viewer().closeTabsWhere(inFolder('/old/app'))

    expect(openTabs()).toEqual(['/elsewhere/notes.md'])
    expect(viewer().activeFilePath).toBeNull()
  })

  it('withdraws the question about closing a tab that it closed, and only that one', () => {
    viewer().openFile('/elsewhere/notes.md', 'notes.md', 'wt-9')
    viewer().openFile('/old/app/src/a.ts', 'a.ts', 'wt-1')
    viewer().markDirty('/old/app/src/a.ts')
    viewer().requestCloseFile('/old/app/src/a.ts')
    expect(viewer().pendingClose).toBe('/old/app/src/a.ts')

    viewer().closeTabsWhere(inFolder('/old/app'))
    expect(viewer().pendingClose).toBeNull()

    viewer().markDirty('/elsewhere/notes.md')
    viewer().requestCloseFile('/elsewhere/notes.md')
    viewer().closeTabsWhere(inFolder('/old/app'))
    expect(viewer().pendingClose).toBe('/elsewhere/notes.md')
  })

  it('keeps the context tab open, and forgets it once it was closed', () => {
    viewer().openFile('/old/app/src/a.ts', 'a.ts', 'wt-1')
    viewer().openContextEditor('wt-1')

    viewer().closeTabsWhere(inFolder('/old/app'))
    expect(openTabs()).toEqual(['context:wt-1'])
    expect(viewer().contextEditorWorktreeId).toBe('wt-1')
    expect(viewer().activeFilePath).toBe('context:wt-1')

    viewer().closeTabsWhere((key) => key === 'context:wt-1')
    expect(openTabs()).toEqual([])
    expect(viewer().contextEditorWorktreeId).toBeNull()
  })

  it('changes nothing when no tab matches', () => {
    viewer().openFile('/elsewhere/notes.md', 'notes.md', 'wt-9')
    viewer().markDirty('/elsewhere/notes.md')
    const before = useFileViewerStore.getState()

    viewer().closeTabsWhere(inFolder('/old/app'))

    expect(useFileViewerStore.getState()).toBe(before)
  })
})

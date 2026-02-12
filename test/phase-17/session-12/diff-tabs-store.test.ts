import { describe, test, expect, beforeEach } from 'vitest'
import { useFileViewerStore } from '../../../src/renderer/src/stores/useFileViewerStore'

/**
 * Session 12: Diff File Tabs — Store Layer
 *
 * Tests verify:
 * 1. setActiveDiff creates a tab entry in openFiles with correct key
 * 2. setActiveDiff sets activeFilePath to the diff tab key
 * 3. closeDiffTab removes the entry and clears active state
 * 4. setActiveDiff(null) clears activeDiff without removing tabs
 * 5. Multiple diff tabs can coexist (different files, staged vs unstaged)
 * 6. Existing file tab operations are unaffected
 * 7. openFile adds entries with type: 'file'
 * 8. Diff tab key format is diff:{filePath}:{staged|unstaged}
 */

describe('Session 12: Diff File Tabs Store', () => {
  beforeEach(() => {
    // Reset store to initial state
    useFileViewerStore.setState({
      openFiles: new Map(),
      activeFilePath: null,
      activeDiff: null
    })
  })

  test('setActiveDiff creates tab entry in openFiles', () => {
    useFileViewerStore.getState().setActiveDiff({
      worktreePath: '/project',
      filePath: 'src/a.ts',
      fileName: 'a.ts',
      staged: false,
      isUntracked: false
    })

    const state = useFileViewerStore.getState()
    expect(state.openFiles.has('diff:src/a.ts:unstaged')).toBe(true)

    const tab = state.openFiles.get('diff:src/a.ts:unstaged')
    expect(tab).toEqual({
      type: 'diff',
      worktreePath: '/project',
      filePath: 'src/a.ts',
      fileName: 'a.ts',
      staged: false,
      isUntracked: false
    })
  })

  test('setActiveDiff sets activeFilePath to tab key', () => {
    useFileViewerStore.getState().setActiveDiff({
      worktreePath: '/project',
      filePath: 'src/a.ts',
      fileName: 'a.ts',
      staged: true,
      isUntracked: false
    })

    expect(useFileViewerStore.getState().activeFilePath).toBe('diff:src/a.ts:staged')
  })

  test('setActiveDiff sets activeDiff', () => {
    const diff = {
      worktreePath: '/project',
      filePath: 'src/a.ts',
      fileName: 'a.ts',
      staged: false,
      isUntracked: false
    }

    useFileViewerStore.getState().setActiveDiff(diff)

    expect(useFileViewerStore.getState().activeDiff).toEqual(diff)
  })

  test('setActiveDiff uses staged suffix for staged diffs', () => {
    useFileViewerStore.getState().setActiveDiff({
      worktreePath: '/project',
      filePath: 'src/b.ts',
      fileName: 'b.ts',
      staged: true,
      isUntracked: false
    })

    expect(useFileViewerStore.getState().openFiles.has('diff:src/b.ts:staged')).toBe(true)
    expect(useFileViewerStore.getState().activeFilePath).toBe('diff:src/b.ts:staged')
  })

  test('setActiveDiff uses unstaged suffix for unstaged diffs', () => {
    useFileViewerStore.getState().setActiveDiff({
      worktreePath: '/project',
      filePath: 'src/b.ts',
      fileName: 'b.ts',
      staged: false,
      isUntracked: false
    })

    expect(useFileViewerStore.getState().openFiles.has('diff:src/b.ts:unstaged')).toBe(true)
    expect(useFileViewerStore.getState().activeFilePath).toBe('diff:src/b.ts:unstaged')
  })

  test('closeDiffTab removes entry and clears active state', () => {
    useFileViewerStore.getState().setActiveDiff({
      worktreePath: '/project',
      filePath: 'src/a.ts',
      fileName: 'a.ts',
      staged: false,
      isUntracked: false
    })

    useFileViewerStore.getState().closeDiffTab('diff:src/a.ts:unstaged')

    const state = useFileViewerStore.getState()
    expect(state.openFiles.has('diff:src/a.ts:unstaged')).toBe(false)
    expect(state.activeFilePath).toBeNull()
    expect(state.activeDiff).toBeNull()
  })

  test('closeDiffTab does not clear active state when closing non-active tab', () => {
    // Open two diff tabs
    useFileViewerStore.getState().setActiveDiff({
      worktreePath: '/project',
      filePath: 'src/a.ts',
      fileName: 'a.ts',
      staged: false,
      isUntracked: false
    })
    useFileViewerStore.getState().setActiveDiff({
      worktreePath: '/project',
      filePath: 'src/b.ts',
      fileName: 'b.ts',
      staged: false,
      isUntracked: false
    })

    // Close the first (non-active) tab
    useFileViewerStore.getState().closeDiffTab('diff:src/a.ts:unstaged')

    const state = useFileViewerStore.getState()
    expect(state.openFiles.has('diff:src/a.ts:unstaged')).toBe(false)
    expect(state.openFiles.has('diff:src/b.ts:unstaged')).toBe(true)
    // Active tab is still the second one
    expect(state.activeFilePath).toBe('diff:src/b.ts:unstaged')
    expect(state.activeDiff).not.toBeNull()
  })

  test('setActiveDiff(null) clears activeDiff without removing tabs', () => {
    useFileViewerStore.getState().setActiveDiff({
      worktreePath: '/project',
      filePath: 'src/a.ts',
      fileName: 'a.ts',
      staged: false,
      isUntracked: false
    })

    // Verify tab was created
    expect(useFileViewerStore.getState().openFiles.size).toBe(1)

    useFileViewerStore.getState().setActiveDiff(null)

    const state = useFileViewerStore.getState()
    expect(state.activeDiff).toBeNull()
    // Tab should still exist
    expect(state.openFiles.size).toBe(1)
    expect(state.openFiles.has('diff:src/a.ts:unstaged')).toBe(true)
  })

  test('multiple diff tabs can coexist for different files', () => {
    useFileViewerStore.getState().setActiveDiff({
      worktreePath: '/project',
      filePath: 'src/a.ts',
      fileName: 'a.ts',
      staged: false,
      isUntracked: false
    })
    useFileViewerStore.getState().setActiveDiff({
      worktreePath: '/project',
      filePath: 'src/b.ts',
      fileName: 'b.ts',
      staged: false,
      isUntracked: false
    })

    const state = useFileViewerStore.getState()
    expect(state.openFiles.size).toBe(2)
    expect(state.openFiles.has('diff:src/a.ts:unstaged')).toBe(true)
    expect(state.openFiles.has('diff:src/b.ts:unstaged')).toBe(true)
  })

  test('same file can have staged and unstaged diff tabs', () => {
    useFileViewerStore.getState().setActiveDiff({
      worktreePath: '/project',
      filePath: 'src/a.ts',
      fileName: 'a.ts',
      staged: false,
      isUntracked: false
    })
    useFileViewerStore.getState().setActiveDiff({
      worktreePath: '/project',
      filePath: 'src/a.ts',
      fileName: 'a.ts',
      staged: true,
      isUntracked: false
    })

    const state = useFileViewerStore.getState()
    expect(state.openFiles.size).toBe(2)
    expect(state.openFiles.has('diff:src/a.ts:unstaged')).toBe(true)
    expect(state.openFiles.has('diff:src/a.ts:staged')).toBe(true)
  })

  test('openFile still works and adds entries with type file', () => {
    useFileViewerStore.getState().openFile('/project/src/a.ts', 'a.ts', 'wt-1')

    const state = useFileViewerStore.getState()
    const tab = state.openFiles.get('/project/src/a.ts')
    expect(tab).toEqual({
      type: 'file',
      path: '/project/src/a.ts',
      name: 'a.ts',
      worktreeId: 'wt-1'
    })
    expect(state.activeFilePath).toBe('/project/src/a.ts')
    expect(state.activeDiff).toBeNull()
  })

  test('file tabs and diff tabs coexist', () => {
    useFileViewerStore.getState().openFile('/project/src/a.ts', 'a.ts', 'wt-1')
    useFileViewerStore.getState().setActiveDiff({
      worktreePath: '/project',
      filePath: 'src/b.ts',
      fileName: 'b.ts',
      staged: false,
      isUntracked: false
    })

    const state = useFileViewerStore.getState()
    expect(state.openFiles.size).toBe(2)

    const fileTab = state.openFiles.get('/project/src/a.ts')
    expect(fileTab?.type).toBe('file')

    const diffTab = state.openFiles.get('diff:src/b.ts:unstaged')
    expect(diffTab?.type).toBe('diff')
  })

  test('closeFile still works for file tabs', () => {
    useFileViewerStore.getState().openFile('/project/src/a.ts', 'a.ts', 'wt-1')
    useFileViewerStore.getState().openFile('/project/src/b.ts', 'b.ts', 'wt-1')

    useFileViewerStore.getState().closeFile('/project/src/b.ts')

    const state = useFileViewerStore.getState()
    expect(state.openFiles.size).toBe(1)
    expect(state.openFiles.has('/project/src/a.ts')).toBe(true)
    expect(state.activeFilePath).toBe('/project/src/a.ts')
  })

  test('closeAllFiles clears all tabs including diff tabs', () => {
    useFileViewerStore.getState().openFile('/project/src/a.ts', 'a.ts', 'wt-1')
    useFileViewerStore.getState().setActiveDiff({
      worktreePath: '/project',
      filePath: 'src/b.ts',
      fileName: 'b.ts',
      staged: false,
      isUntracked: false
    })

    useFileViewerStore.getState().closeAllFiles()

    const state = useFileViewerStore.getState()
    expect(state.openFiles.size).toBe(0)
    expect(state.activeFilePath).toBeNull()
    expect(state.activeDiff).toBeNull()
  })

  test('opening a file tab clears activeDiff', () => {
    useFileViewerStore.getState().setActiveDiff({
      worktreePath: '/project',
      filePath: 'src/a.ts',
      fileName: 'a.ts',
      staged: false,
      isUntracked: false
    })

    expect(useFileViewerStore.getState().activeDiff).not.toBeNull()

    useFileViewerStore.getState().openFile('/project/src/b.ts', 'b.ts', 'wt-1')

    expect(useFileViewerStore.getState().activeDiff).toBeNull()
    expect(useFileViewerStore.getState().activeFilePath).toBe('/project/src/b.ts')
  })

  test('setActiveFile clears activeDiff', () => {
    useFileViewerStore.getState().openFile('/project/src/a.ts', 'a.ts', 'wt-1')
    useFileViewerStore.getState().setActiveDiff({
      worktreePath: '/project',
      filePath: 'src/b.ts',
      fileName: 'b.ts',
      staged: false,
      isUntracked: false
    })

    expect(useFileViewerStore.getState().activeDiff).not.toBeNull()

    useFileViewerStore.getState().setActiveFile('/project/src/a.ts')

    expect(useFileViewerStore.getState().activeDiff).toBeNull()
    expect(useFileViewerStore.getState().activeFilePath).toBe('/project/src/a.ts')
  })

  test('re-activating same diff does not duplicate tab', () => {
    const diff = {
      worktreePath: '/project',
      filePath: 'src/a.ts',
      fileName: 'a.ts',
      staged: false,
      isUntracked: false
    }

    useFileViewerStore.getState().setActiveDiff(diff)
    useFileViewerStore.getState().setActiveDiff(diff)

    const state = useFileViewerStore.getState()
    // Map key is the same, so size should be 1
    expect(state.openFiles.size).toBe(1)
  })
})

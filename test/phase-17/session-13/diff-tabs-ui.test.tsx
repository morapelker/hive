import { describe, test, expect, beforeEach } from 'vitest'
import { useFileViewerStore } from '../../../src/renderer/src/stores/useFileViewerStore'

/**
 * Session 13: Diff File Tabs — UI Integration
 *
 * Tests verify:
 * 1. activateDiffTab restores activeDiff from tab data
 * 2. activateDiffTab sets activeFilePath to the tab key
 * 3. activateDiffTab on non-existent key is a no-op
 * 4. activateDiffTab on a file tab (not diff) is a no-op
 * 5. Session tab click flow: setActiveFile(null) clears diff state
 * 6. Diff tab click -> session tab click -> diff tab click cycle works
 * 7. Closing a diff tab via closeDiffTab after activating another works
 * 8. Middle-click (closeDiffTab) on active tab clears state
 * 9. Cmd+W flow: activeFilePath starting with diff: triggers closeDiffTab
 * 10. Multiple diff tabs: activating one does not affect others
 */

describe('Session 13: Diff File Tabs UI', () => {
  beforeEach(() => {
    useFileViewerStore.setState({
      openFiles: new Map(),
      activeFilePath: null,
      activeDiff: null
    })
  })

  // ─── activateDiffTab ─────────────────────────────────────────────────

  test('activateDiffTab restores activeDiff from tab data', () => {
    // Create a diff tab via setActiveDiff
    useFileViewerStore.getState().setActiveDiff({
      worktreePath: '/project',
      filePath: 'src/a.ts',
      fileName: 'a.ts',
      staged: false,
      isUntracked: false
    })

    // Clear active state (simulating clicking a session tab)
    useFileViewerStore.getState().setActiveFile(null)
    expect(useFileViewerStore.getState().activeDiff).toBeNull()
    expect(useFileViewerStore.getState().activeFilePath).toBeNull()

    // Re-activate the diff tab
    useFileViewerStore.getState().activateDiffTab('diff:src/a.ts:unstaged')

    const state = useFileViewerStore.getState()
    expect(state.activeFilePath).toBe('diff:src/a.ts:unstaged')
    expect(state.activeDiff).toEqual({
      worktreePath: '/project',
      filePath: 'src/a.ts',
      fileName: 'a.ts',
      staged: false,
      isUntracked: false
    })
  })

  test('activateDiffTab sets activeFilePath to tab key', () => {
    useFileViewerStore.getState().setActiveDiff({
      worktreePath: '/project',
      filePath: 'src/b.ts',
      fileName: 'b.ts',
      staged: true,
      isUntracked: false
    })

    useFileViewerStore.getState().setActiveFile(null)
    useFileViewerStore.getState().activateDiffTab('diff:src/b.ts:staged')

    expect(useFileViewerStore.getState().activeFilePath).toBe('diff:src/b.ts:staged')
  })

  test('activateDiffTab on non-existent key is a no-op', () => {
    useFileViewerStore.getState().activateDiffTab('diff:nonexistent.ts:unstaged')

    const state = useFileViewerStore.getState()
    expect(state.activeFilePath).toBeNull()
    expect(state.activeDiff).toBeNull()
  })

  test('activateDiffTab on a file tab key is a no-op', () => {
    useFileViewerStore.getState().openFile('/project/src/a.ts', 'a.ts', 'wt-1')

    // Try to activate a file tab as a diff tab
    useFileViewerStore.getState().activateDiffTab('/project/src/a.ts')

    // activeDiff should remain null
    expect(useFileViewerStore.getState().activeDiff).toBeNull()
  })

  // ─── Tab switching flow ──────────────────────────────────────────────

  test('session tab click clears diff state via setActiveFile(null)', () => {
    useFileViewerStore.getState().setActiveDiff({
      worktreePath: '/project',
      filePath: 'src/a.ts',
      fileName: 'a.ts',
      staged: false,
      isUntracked: false
    })

    expect(useFileViewerStore.getState().activeDiff).not.toBeNull()

    // Simulate session tab click
    useFileViewerStore.getState().setActiveFile(null)

    expect(useFileViewerStore.getState().activeDiff).toBeNull()
    expect(useFileViewerStore.getState().activeFilePath).toBeNull()
  })

  test('diff tab -> session tab -> diff tab cycle restores diff', () => {
    // Step 1: Open diff
    useFileViewerStore.getState().setActiveDiff({
      worktreePath: '/project',
      filePath: 'src/a.ts',
      fileName: 'a.ts',
      staged: false,
      isUntracked: false
    })

    expect(useFileViewerStore.getState().activeDiff).not.toBeNull()

    // Step 2: Click session tab
    useFileViewerStore.getState().setActiveFile(null)
    expect(useFileViewerStore.getState().activeDiff).toBeNull()

    // Step 3: Click diff tab again
    useFileViewerStore.getState().activateDiffTab('diff:src/a.ts:unstaged')

    const state = useFileViewerStore.getState()
    expect(state.activeDiff).not.toBeNull()
    expect(state.activeDiff?.filePath).toBe('src/a.ts')
    expect(state.activeFilePath).toBe('diff:src/a.ts:unstaged')
  })

  test('diff tab -> file tab -> diff tab cycle works', () => {
    // Open a regular file tab
    useFileViewerStore.getState().openFile('/project/src/b.ts', 'b.ts', 'wt-1')

    // Open diff
    useFileViewerStore.getState().setActiveDiff({
      worktreePath: '/project',
      filePath: 'src/a.ts',
      fileName: 'a.ts',
      staged: false,
      isUntracked: false
    })

    // Switch to file tab
    useFileViewerStore.getState().setActiveFile('/project/src/b.ts')
    expect(useFileViewerStore.getState().activeDiff).toBeNull()
    expect(useFileViewerStore.getState().activeFilePath).toBe('/project/src/b.ts')

    // Switch back to diff tab
    useFileViewerStore.getState().activateDiffTab('diff:src/a.ts:unstaged')
    expect(useFileViewerStore.getState().activeDiff).not.toBeNull()
    expect(useFileViewerStore.getState().activeFilePath).toBe('diff:src/a.ts:unstaged')
  })

  // ─── Closing diff tabs ──────────────────────────────────────────────

  test('closing active diff tab clears state', () => {
    useFileViewerStore.getState().setActiveDiff({
      worktreePath: '/project',
      filePath: 'src/a.ts',
      fileName: 'a.ts',
      staged: false,
      isUntracked: false
    })

    useFileViewerStore.getState().closeDiffTab('diff:src/a.ts:unstaged')

    const state = useFileViewerStore.getState()
    expect(state.openFiles.size).toBe(0)
    expect(state.activeFilePath).toBeNull()
    expect(state.activeDiff).toBeNull()
  })

  test('closing non-active diff tab preserves active state', () => {
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

    // Close the non-active one
    useFileViewerStore.getState().closeDiffTab('diff:src/a.ts:unstaged')

    const state = useFileViewerStore.getState()
    expect(state.openFiles.size).toBe(1)
    expect(state.activeFilePath).toBe('diff:src/b.ts:unstaged')
    expect(state.activeDiff?.filePath).toBe('src/b.ts')
  })

  // ─── Multiple diff tabs ─────────────────────────────────────────────

  test('activating one diff tab does not affect other tabs', () => {
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
      staged: true,
      isUntracked: false
    })

    // Both tabs exist
    expect(useFileViewerStore.getState().openFiles.size).toBe(2)

    // Activate the first one
    useFileViewerStore.getState().activateDiffTab('diff:src/a.ts:unstaged')

    // Both still exist
    expect(useFileViewerStore.getState().openFiles.size).toBe(2)
    expect(useFileViewerStore.getState().openFiles.has('diff:src/a.ts:unstaged')).toBe(true)
    expect(useFileViewerStore.getState().openFiles.has('diff:src/b.ts:staged')).toBe(true)

    // Active one is the first
    expect(useFileViewerStore.getState().activeFilePath).toBe('diff:src/a.ts:unstaged')
    expect(useFileViewerStore.getState().activeDiff?.filePath).toBe('src/a.ts')
    expect(useFileViewerStore.getState().activeDiff?.staged).toBe(false)
  })

  test('switching between multiple diff tabs works', () => {
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
      staged: true,
      isUntracked: false
    })

    // Active is b.ts (last opened)
    expect(useFileViewerStore.getState().activeDiff?.filePath).toBe('src/b.ts')

    // Switch to a.ts
    useFileViewerStore.getState().activateDiffTab('diff:src/a.ts:unstaged')
    expect(useFileViewerStore.getState().activeDiff?.filePath).toBe('src/a.ts')

    // Switch back to b.ts
    useFileViewerStore.getState().activateDiffTab('diff:src/b.ts:staged')
    expect(useFileViewerStore.getState().activeDiff?.filePath).toBe('src/b.ts')
    expect(useFileViewerStore.getState().activeDiff?.staged).toBe(true)
  })

  // ─── Cmd+W simulation ──────────────────────────────────────────────

  test('Cmd+W logic: diff tab key triggers closeDiffTab', () => {
    useFileViewerStore.getState().setActiveDiff({
      worktreePath: '/project',
      filePath: 'src/a.ts',
      fileName: 'a.ts',
      staged: false,
      isUntracked: false
    })

    const { activeFilePath } = useFileViewerStore.getState()
    expect(activeFilePath?.startsWith('diff:')).toBe(true)

    // Simulate the Cmd+W handler logic
    if (activeFilePath?.startsWith('diff:')) {
      useFileViewerStore.getState().closeDiffTab(activeFilePath)
    }

    expect(useFileViewerStore.getState().openFiles.size).toBe(0)
    expect(useFileViewerStore.getState().activeFilePath).toBeNull()
    expect(useFileViewerStore.getState().activeDiff).toBeNull()
  })

  test('Cmd+W on file tab does not trigger closeDiffTab', () => {
    useFileViewerStore.getState().openFile('/project/src/a.ts', 'a.ts', 'wt-1')

    const { activeFilePath } = useFileViewerStore.getState()
    expect(activeFilePath?.startsWith('diff:')).toBe(false)

    // Simulate the Cmd+W handler logic — should NOT enter closeDiffTab path
    if (activeFilePath?.startsWith('diff:')) {
      useFileViewerStore.getState().closeDiffTab(activeFilePath)
    } else if (activeFilePath) {
      useFileViewerStore.getState().closeFile(activeFilePath)
    }

    expect(useFileViewerStore.getState().openFiles.size).toBe(0)
    expect(useFileViewerStore.getState().activeFilePath).toBeNull()
  })

  // ─── DiffTabItem component contract ─────────────────────────────────

  test('diff tab entry contains all fields needed for rendering', () => {
    useFileViewerStore.getState().setActiveDiff({
      worktreePath: '/project',
      filePath: 'src/deep/nested/file.ts',
      fileName: 'file.ts',
      staged: true,
      isUntracked: false
    })

    const tab = useFileViewerStore.getState().openFiles.get('diff:src/deep/nested/file.ts:staged')
    expect(tab).toBeDefined()
    expect(tab?.type).toBe('diff')

    if (tab?.type === 'diff') {
      // These fields are used by DiffTabItem for rendering
      expect(tab.fileName).toBe('file.ts') // displayed in tab text
      expect(tab.filePath).toBe('src/deep/nested/file.ts') // used in tooltip
      expect(tab.staged).toBe(true) // staged indicator shown
      expect(tab.worktreePath).toBe('/project') // used when restoring activeDiff
    }
  })

  test('untracked files have correct tab data', () => {
    useFileViewerStore.getState().setActiveDiff({
      worktreePath: '/project',
      filePath: 'src/new-file.ts',
      fileName: 'new-file.ts',
      staged: false,
      isUntracked: true
    })

    const tab = useFileViewerStore.getState().openFiles.get('diff:src/new-file.ts:unstaged')

    expect(tab).toBeDefined()
    if (tab?.type === 'diff') {
      expect(tab.isUntracked).toBe(true)
    }
  })

  // ─── Edge cases ─────────────────────────────────────────────────────

  test('closing all files clears diff tabs too', () => {
    useFileViewerStore.getState().openFile('/project/src/a.ts', 'a.ts', 'wt-1')
    useFileViewerStore.getState().setActiveDiff({
      worktreePath: '/project',
      filePath: 'src/b.ts',
      fileName: 'b.ts',
      staged: false,
      isUntracked: false
    })

    expect(useFileViewerStore.getState().openFiles.size).toBe(2)

    useFileViewerStore.getState().closeAllFiles()

    expect(useFileViewerStore.getState().openFiles.size).toBe(0)
    expect(useFileViewerStore.getState().activeFilePath).toBeNull()
    expect(useFileViewerStore.getState().activeDiff).toBeNull()
  })

  test('opening same diff twice does not create duplicate tab', () => {
    const diff = {
      worktreePath: '/project',
      filePath: 'src/a.ts',
      fileName: 'a.ts',
      staged: false,
      isUntracked: false
    }

    useFileViewerStore.getState().setActiveDiff(diff)
    useFileViewerStore.getState().setActiveDiff(diff)

    expect(useFileViewerStore.getState().openFiles.size).toBe(1)
  })
})

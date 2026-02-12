import { describe, test, expect, beforeEach, vi } from 'vitest'
import { useFileViewerStore } from '../../../src/renderer/src/stores/useFileViewerStore'
import { useSessionStore } from '../../../src/renderer/src/stores/useSessionStore'

/**
 * Session 7: Tab Context Menus — Store Actions
 *
 * Tests verify:
 * 1. closeOtherSessions closes all sessions except the kept one
 * 2. closeSessionsToRight closes sessions after the given index
 * 3. closeOtherFiles keeps only the specified file tab
 * 4. closeFilesToRight removes file tabs after the specified one
 * 5. Edge cases: single tab, last tab, active tab among closed ones
 */

// Mock window.db.session for useSessionStore
Object.defineProperty(window, 'db', {
  writable: true,
  configurable: true,
  value: {
    session: {
      getActiveByWorktree: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: 'new', name: 'New', status: 'active' }),
      update: vi.fn().mockResolvedValue({ id: 'test', status: 'completed' })
    }
  }
})

describe('Session 7: Tab Context Store Actions', () => {
  describe('useSessionStore', () => {
    const worktreeId = 'wt-1'

    beforeEach(() => {
      // Reset store with 3 sessions in tab order
      useSessionStore.setState({
        sessionsByWorktree: new Map([
          [
            worktreeId,
            [
              {
                id: 's1',
                worktree_id: worktreeId,
                project_id: 'p1',
                name: 'Session 1',
                status: 'active',
                opencode_session_id: null,
                mode: 'build',
                model_provider_id: null,
                model_id: null,
                model_variant: null,
                created_at: '2024-01-01',
                updated_at: '2024-01-01',
                completed_at: null
              },
              {
                id: 's2',
                worktree_id: worktreeId,
                project_id: 'p1',
                name: 'Session 2',
                status: 'active',
                opencode_session_id: null,
                mode: 'build',
                model_provider_id: null,
                model_id: null,
                model_variant: null,
                created_at: '2024-01-02',
                updated_at: '2024-01-02',
                completed_at: null
              },
              {
                id: 's3',
                worktree_id: worktreeId,
                project_id: 'p1',
                name: 'Session 3',
                status: 'active',
                opencode_session_id: null,
                mode: 'build',
                model_provider_id: null,
                model_id: null,
                model_variant: null,
                created_at: '2024-01-03',
                updated_at: '2024-01-03',
                completed_at: null
              }
            ]
          ]
        ]),
        tabOrderByWorktree: new Map([[worktreeId, ['s1', 's2', 's3']]]),
        activeSessionId: 's1',
        activeWorktreeId: worktreeId,
        activeSessionByWorktree: { [worktreeId]: 's1' },
        modeBySession: new Map([
          ['s1', 'build'],
          ['s2', 'build'],
          ['s3', 'build']
        ]),
        pendingMessages: new Map(),
        isLoading: false,
        error: null
      })
    })

    test('closeOtherSessions closes all except the kept session', async () => {
      await useSessionStore.getState().closeOtherSessions(worktreeId, 's2')

      const state = useSessionStore.getState()
      const tabOrder = state.tabOrderByWorktree.get(worktreeId) || []
      const sessions = state.sessionsByWorktree.get(worktreeId) || []

      // Only s2 should remain
      expect(tabOrder).toEqual(['s2'])
      expect(sessions.map((s) => s.id)).toEqual(['s2'])
      expect(state.activeSessionId).toBe('s2')
    })

    test('closeOtherSessions with single tab is a no-op', async () => {
      // Set up single session
      useSessionStore.setState({
        tabOrderByWorktree: new Map([[worktreeId, ['s1']]]),
        sessionsByWorktree: new Map([
          [
            worktreeId,
            [
              {
                id: 's1',
                worktree_id: worktreeId,
                project_id: 'p1',
                name: 'Session 1',
                status: 'active',
                opencode_session_id: null,
                mode: 'build',
                model_provider_id: null,
                model_id: null,
                model_variant: null,
                created_at: '2024-01-01',
                updated_at: '2024-01-01',
                completed_at: null
              }
            ]
          ]
        ]),
        activeSessionId: 's1'
      })

      await useSessionStore.getState().closeOtherSessions(worktreeId, 's1')

      const state = useSessionStore.getState()
      const tabOrder = state.tabOrderByWorktree.get(worktreeId) || []
      expect(tabOrder).toEqual(['s1'])
      expect(state.activeSessionId).toBe('s1')
    })

    test('closeSessionsToRight closes sessions after the given one', async () => {
      await useSessionStore.getState().closeSessionsToRight(worktreeId, 's1')

      const state = useSessionStore.getState()
      const tabOrder = state.tabOrderByWorktree.get(worktreeId) || []
      const sessions = state.sessionsByWorktree.get(worktreeId) || []

      // s2 and s3 should be closed, only s1 remains
      expect(tabOrder).toEqual(['s1'])
      expect(sessions.map((s) => s.id)).toEqual(['s1'])
    })

    test('closeSessionsToRight from middle position', async () => {
      await useSessionStore.getState().closeSessionsToRight(worktreeId, 's2')

      const state = useSessionStore.getState()
      const tabOrder = state.tabOrderByWorktree.get(worktreeId) || []
      const sessions = state.sessionsByWorktree.get(worktreeId) || []

      // Only s3 should be closed, s1 and s2 remain
      expect(tabOrder).toEqual(['s1', 's2'])
      expect(sessions.map((s) => s.id)).toEqual(['s1', 's2'])
    })

    test('closeSessionsToRight with last tab is a no-op', async () => {
      await useSessionStore.getState().closeSessionsToRight(worktreeId, 's3')

      const state = useSessionStore.getState()
      const tabOrder = state.tabOrderByWorktree.get(worktreeId) || []

      // All 3 should remain
      expect(tabOrder).toEqual(['s1', 's2', 's3'])
    })

    test('closeSessionsToRight with non-existent session is a no-op', async () => {
      await useSessionStore.getState().closeSessionsToRight(worktreeId, 'nonexistent')

      const state = useSessionStore.getState()
      const tabOrder = state.tabOrderByWorktree.get(worktreeId) || []
      expect(tabOrder).toEqual(['s1', 's2', 's3'])
    })

    test('closeOtherSessions sets kept session as active', async () => {
      // Active is s1, but we keep s3
      useSessionStore.setState({ activeSessionId: 's1' })

      await useSessionStore.getState().closeOtherSessions(worktreeId, 's3')

      expect(useSessionStore.getState().activeSessionId).toBe('s3')
    })
  })

  describe('useFileViewerStore', () => {
    beforeEach(() => {
      // Reset store with 3 file tabs
      const openFiles = new Map()
      openFiles.set('/project/src/a.ts', {
        type: 'file' as const,
        path: '/project/src/a.ts',
        name: 'a.ts',
        worktreeId: 'wt-1'
      })
      openFiles.set('/project/src/b.ts', {
        type: 'file' as const,
        path: '/project/src/b.ts',
        name: 'b.ts',
        worktreeId: 'wt-1'
      })
      openFiles.set('/project/src/c.ts', {
        type: 'file' as const,
        path: '/project/src/c.ts',
        name: 'c.ts',
        worktreeId: 'wt-1'
      })

      useFileViewerStore.setState({
        openFiles,
        activeFilePath: '/project/src/b.ts',
        activeDiff: null
      })
    })

    test('closeOtherFiles keeps only the specified file', () => {
      useFileViewerStore.getState().closeOtherFiles('/project/src/b.ts')

      const state = useFileViewerStore.getState()
      expect(state.openFiles.size).toBe(1)
      expect(state.openFiles.has('/project/src/b.ts')).toBe(true)
      expect(state.activeFilePath).toBe('/project/src/b.ts')
    })

    test('closeOtherFiles sets kept file as active', () => {
      // Active is b.ts, keep a.ts
      useFileViewerStore.getState().closeOtherFiles('/project/src/a.ts')

      const state = useFileViewerStore.getState()
      expect(state.openFiles.size).toBe(1)
      expect(state.activeFilePath).toBe('/project/src/a.ts')
    })

    test('closeOtherFiles with single file is a no-op', () => {
      // Set up single file
      const openFiles = new Map()
      openFiles.set('/project/src/only.ts', {
        type: 'file' as const,
        path: '/project/src/only.ts',
        name: 'only.ts',
        worktreeId: 'wt-1'
      })
      useFileViewerStore.setState({
        openFiles,
        activeFilePath: '/project/src/only.ts'
      })

      useFileViewerStore.getState().closeOtherFiles('/project/src/only.ts')

      const state = useFileViewerStore.getState()
      expect(state.openFiles.size).toBe(1)
      expect(state.openFiles.has('/project/src/only.ts')).toBe(true)
    })

    test('closeOtherFiles clears activeDiff when kept file is not a diff', () => {
      useFileViewerStore.setState({
        activeDiff: {
          worktreePath: '/project',
          filePath: 'src/x.ts',
          fileName: 'x.ts',
          staged: false,
          isUntracked: false
        }
      })

      useFileViewerStore.getState().closeOtherFiles('/project/src/a.ts')

      expect(useFileViewerStore.getState().activeDiff).toBeNull()
    })

    test('closeOtherFiles preserves activeDiff when kept file is a diff tab', () => {
      const diffEntry = {
        type: 'diff' as const,
        worktreePath: '/project',
        filePath: 'src/x.ts',
        fileName: 'x.ts',
        staged: false,
        isUntracked: false
      }
      const activeDiff = {
        worktreePath: '/project',
        filePath: 'src/x.ts',
        fileName: 'x.ts',
        staged: false,
        isUntracked: false
      }

      const openFiles = new Map(useFileViewerStore.getState().openFiles)
      openFiles.set('diff:src/x.ts:unstaged', diffEntry)
      useFileViewerStore.setState({ openFiles, activeDiff })

      useFileViewerStore.getState().closeOtherFiles('diff:src/x.ts:unstaged')

      const state = useFileViewerStore.getState()
      expect(state.openFiles.size).toBe(1)
      expect(state.activeDiff).toEqual(activeDiff)
    })

    test('closeFilesToRight removes files after the specified one', () => {
      useFileViewerStore.getState().closeFilesToRight('/project/src/a.ts')

      const state = useFileViewerStore.getState()
      expect(state.openFiles.size).toBe(1)
      expect(state.openFiles.has('/project/src/a.ts')).toBe(true)
      expect(state.openFiles.has('/project/src/b.ts')).toBe(false)
      expect(state.openFiles.has('/project/src/c.ts')).toBe(false)
    })

    test('closeFilesToRight from middle keeps files to the left', () => {
      useFileViewerStore.getState().closeFilesToRight('/project/src/b.ts')

      const state = useFileViewerStore.getState()
      expect(state.openFiles.size).toBe(2)
      expect(state.openFiles.has('/project/src/a.ts')).toBe(true)
      expect(state.openFiles.has('/project/src/b.ts')).toBe(true)
      expect(state.openFiles.has('/project/src/c.ts')).toBe(false)
    })

    test('closeFilesToRight with last file is a no-op', () => {
      useFileViewerStore.getState().closeFilesToRight('/project/src/c.ts')

      const state = useFileViewerStore.getState()
      expect(state.openFiles.size).toBe(3)
    })

    test('closeFilesToRight activates fromKey when active was closed', () => {
      // Active is c.ts, close to right of a.ts
      useFileViewerStore.setState({ activeFilePath: '/project/src/c.ts' })

      useFileViewerStore.getState().closeFilesToRight('/project/src/a.ts')

      const state = useFileViewerStore.getState()
      // c.ts was closed, so active should fall back to a.ts
      expect(state.activeFilePath).toBe('/project/src/a.ts')
    })

    test('closeFilesToRight keeps active when still open', () => {
      // Active is a.ts, close to right of b.ts
      useFileViewerStore.setState({ activeFilePath: '/project/src/a.ts' })

      useFileViewerStore.getState().closeFilesToRight('/project/src/b.ts')

      const state = useFileViewerStore.getState()
      // a.ts is still open, stays active
      expect(state.activeFilePath).toBe('/project/src/a.ts')
    })

    test('closeFilesToRight with non-existent key is a no-op', () => {
      useFileViewerStore.getState().closeFilesToRight('/nonexistent')

      const state = useFileViewerStore.getState()
      expect(state.openFiles.size).toBe(3)
    })

    test('closeOtherFiles with non-existent key clears all', () => {
      useFileViewerStore.getState().closeOtherFiles('/nonexistent')

      const state = useFileViewerStore.getState()
      expect(state.openFiles.size).toBe(0)
      expect(state.activeFilePath).toBeNull()
    })
  })
})

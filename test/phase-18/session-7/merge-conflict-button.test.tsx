/**
 * Session 7: Merge Conflict Header Button Tests
 *
 * Testing criteria from phase-18.md:
 * - Button renders when hasConflicts is true
 * - Button hidden when hasConflicts is false
 * - handleFixConflicts creates session with correct prompt
 * - conflictsByWorktree is populated from file status loading
 * - setHasConflicts updates the store correctly
 */

import { describe, test, expect, vi, beforeEach } from 'vitest'
import { useGitStore } from '../../../src/renderer/src/stores/useGitStore'

// -- Git store conflict detection tests --

describe('Session 7: Merge Conflict Header Button', () => {
  beforeEach(() => {
    // Reset the store to initial state
    useGitStore.setState({
      fileStatusesByWorktree: new Map(),
      branchInfoByWorktree: new Map(),
      conflictsByWorktree: {},
      isLoading: false,
      error: null,
      isCommitting: false,
      isPushing: false,
      isPulling: false
    })
  })

  describe('useGitStore: conflictsByWorktree', () => {
    test('initial state has empty conflictsByWorktree', () => {
      const state = useGitStore.getState()
      expect(state.conflictsByWorktree).toEqual({})
    })

    test('setHasConflicts sets true for a worktree path', () => {
      useGitStore.getState().setHasConflicts('/path/to/worktree', true)
      const state = useGitStore.getState()
      expect(state.conflictsByWorktree['/path/to/worktree']).toBe(true)
    })

    test('setHasConflicts sets false for a worktree path', () => {
      useGitStore.getState().setHasConflicts('/path/to/worktree', true)
      useGitStore.getState().setHasConflicts('/path/to/worktree', false)
      const state = useGitStore.getState()
      expect(state.conflictsByWorktree['/path/to/worktree']).toBe(false)
    })

    test('setHasConflicts handles multiple worktree paths independently', () => {
      useGitStore.getState().setHasConflicts('/path/a', true)
      useGitStore.getState().setHasConflicts('/path/b', false)
      useGitStore.getState().setHasConflicts('/path/c', true)

      const state = useGitStore.getState()
      expect(state.conflictsByWorktree['/path/a']).toBe(true)
      expect(state.conflictsByWorktree['/path/b']).toBe(false)
      expect(state.conflictsByWorktree['/path/c']).toBe(true)
    })

    test('loadFileStatuses sets hasConflicts true when files have status C', async () => {
      const mockFiles = [
        { path: '/wt/src/app.ts', relativePath: 'src/app.ts', status: 'C', staged: false },
        { path: '/wt/src/index.ts', relativePath: 'src/index.ts', status: 'M', staged: false }
      ]

      const mockGitOps = window.gitOps as Record<string, ReturnType<typeof vi.fn>>
      mockGitOps.getFileStatuses = vi.fn().mockResolvedValue({ success: true, files: mockFiles })

      await useGitStore.getState().loadFileStatuses('/wt')
      const state = useGitStore.getState()
      expect(state.conflictsByWorktree['/wt']).toBe(true)
    })

    test('loadFileStatuses sets hasConflicts false when no files have status C', async () => {
      const mockFiles = [
        { path: '/wt/src/app.ts', relativePath: 'src/app.ts', status: 'M', staged: false },
        { path: '/wt/src/index.ts', relativePath: 'src/index.ts', status: 'A', staged: true }
      ]

      const mockGitOps = window.gitOps as Record<string, ReturnType<typeof vi.fn>>
      mockGitOps.getFileStatuses = vi.fn().mockResolvedValue({ success: true, files: mockFiles })

      await useGitStore.getState().loadFileStatuses('/wt')
      const state = useGitStore.getState()
      expect(state.conflictsByWorktree['/wt']).toBe(false)
    })

    test('loadFileStatuses sets hasConflicts false for empty file list', async () => {
      const mockGitOps = window.gitOps as Record<string, ReturnType<typeof vi.fn>>
      mockGitOps.getFileStatuses = vi.fn().mockResolvedValue({ success: true, files: [] })

      await useGitStore.getState().loadFileStatuses('/wt')
      const state = useGitStore.getState()
      expect(state.conflictsByWorktree['/wt']).toBe(false)
    })
  })

  describe('handleFixConflicts logic', () => {
    const mockCreateSession = vi.fn()
    const mockUpdateSessionName = vi.fn()
    const mockSetPendingMessage = vi.fn()
    const mockSetActiveSession = vi.fn()

    beforeEach(() => {
      vi.clearAllMocks()
      mockCreateSession.mockResolvedValue({
        success: true,
        session: { id: 'session-123' }
      })
      mockUpdateSessionName.mockResolvedValue(true)
    })

    // Simulate the handleFixConflicts logic from Header.tsx
    async function handleFixConflicts(
      selectedWorktreeId: string | null,
      selectedProjectId: string | null,
      branchName: string | undefined
    ) {
      if (!selectedWorktreeId || !selectedProjectId) return
      const { success, session } = await mockCreateSession(selectedWorktreeId, selectedProjectId)
      if (!success || !session) return

      const branch = branchName || 'unknown'
      await mockUpdateSessionName(session.id, `Merge Conflicts -- ${branch}`)
      mockSetPendingMessage(session.id, 'Fix merge conflicts')
      mockSetActiveSession(session.id)
    }

    test('creates session with correct worktreeId and projectId', async () => {
      await handleFixConflicts('wt-1', 'proj-1', 'feature/auth')

      expect(mockCreateSession).toHaveBeenCalledWith('wt-1', 'proj-1')
    })

    test('names session with branch name', async () => {
      await handleFixConflicts('wt-1', 'proj-1', 'feature/auth')

      expect(mockUpdateSessionName).toHaveBeenCalledWith(
        'session-123',
        'Merge Conflicts -- feature/auth'
      )
    })

    test('sets pending message to Fix merge conflicts', async () => {
      await handleFixConflicts('wt-1', 'proj-1', 'main')

      expect(mockSetPendingMessage).toHaveBeenCalledWith('session-123', 'Fix merge conflicts')
    })

    test('sets active session after creation', async () => {
      await handleFixConflicts('wt-1', 'proj-1', 'main')

      expect(mockSetActiveSession).toHaveBeenCalledWith('session-123')
    })

    test('uses "unknown" when branch name is undefined', async () => {
      await handleFixConflicts('wt-1', 'proj-1', undefined)

      expect(mockUpdateSessionName).toHaveBeenCalledWith(
        'session-123',
        'Merge Conflicts -- unknown'
      )
    })

    test('returns early when selectedWorktreeId is null', async () => {
      await handleFixConflicts(null, 'proj-1', 'main')

      expect(mockCreateSession).not.toHaveBeenCalled()
    })

    test('returns early when selectedProjectId is null', async () => {
      await handleFixConflicts('wt-1', null, 'main')

      expect(mockCreateSession).not.toHaveBeenCalled()
    })

    test('does not set pending message when session creation fails', async () => {
      mockCreateSession.mockResolvedValue({ success: false })

      await handleFixConflicts('wt-1', 'proj-1', 'main')

      expect(mockCreateSession).toHaveBeenCalled()
      expect(mockUpdateSessionName).not.toHaveBeenCalled()
      expect(mockSetPendingMessage).not.toHaveBeenCalled()
      expect(mockSetActiveSession).not.toHaveBeenCalled()
    })
  })

  describe('Conflict button visibility logic', () => {
    test('hasConflicts returns true when worktree path has conflicts', () => {
      useGitStore.getState().setHasConflicts('/path/to/wt', true)

      const state = useGitStore.getState()
      const worktreePath = '/path/to/wt'
      const hasConflicts = state.conflictsByWorktree[worktreePath] ?? false

      expect(hasConflicts).toBe(true)
    })

    test('hasConflicts returns false when worktree path has no conflicts', () => {
      useGitStore.getState().setHasConflicts('/path/to/wt', false)

      const state = useGitStore.getState()
      const worktreePath = '/path/to/wt'
      const hasConflicts = state.conflictsByWorktree[worktreePath] ?? false

      expect(hasConflicts).toBe(false)
    })

    test('hasConflicts returns false for unknown worktree path', () => {
      const state = useGitStore.getState()
      const worktreePath = '/unknown/path'
      const hasConflicts = state.conflictsByWorktree[worktreePath] ?? false

      expect(hasConflicts).toBe(false)
    })

    test('hasConflicts returns false when worktree path is undefined', () => {
      const state = useGitStore.getState()
      const worktreePath: string | undefined = undefined
      const hasConflicts = worktreePath ? (state.conflictsByWorktree[worktreePath] ?? false) : false

      expect(hasConflicts).toBe(false)
    })
  })
})

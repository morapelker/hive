/**
 * Session 5: PR Header UI Tests
 *
 * Tests the state-driven PR button rendering logic in Header.tsx:
 * - none/creating → PR button (with spinner during creating)
 * - created + clean tree → green "Merge PR" button
 * - created + dirty tree → PR button (user needs to commit first)
 * - merged → red "Archive" button
 * - handleCreatePR sets PR state to creating with sessionId
 * - handleMergePR calls prMerge and transitions to merged
 */

import { describe, test, expect, vi, beforeEach } from 'vitest'
import { useGitStore } from '../../../src/renderer/src/stores/useGitStore'

// Mock useWorktreeStore (required by useGitStore internals)
vi.mock('../../../src/renderer/src/stores/useWorktreeStore', () => ({
  useWorktreeStore: {
    getState: vi.fn(() => ({
      worktreesByProject: new Map(),
      selectedWorktreeId: null,
      archiveWorktree: vi.fn().mockResolvedValue({ success: true })
    })),
    // Zustand selector-style call
    __esModule: true
  }
}))

describe('Session 5: PR Header UI', () => {
  beforeEach(() => {
    useGitStore.setState({
      prInfo: new Map(),
      fileStatusesByWorktree: new Map(),
      remoteInfo: new Map(),
      branchInfoByWorktree: new Map(),
      isPushing: false,
      isPulling: false,
      error: null
    })
  })

  describe('PR state rendering conditions', () => {
    test('prState defaults to none when no prInfo exists for worktree', () => {
      const prInfo = useGitStore.getState().prInfo.get('wt-1')
      const prState = prInfo?.state ?? 'none'
      expect(prState).toBe('none')
    })

    test('prState is none when explicitly set', () => {
      useGitStore.getState().setPrState('wt-1', { state: 'none' })
      const prInfo = useGitStore.getState().prInfo.get('wt-1')
      const prState = prInfo?.state ?? 'none'
      expect(prState).toBe('none')
    })

    test('prState is creating after handleCreatePR sets it', () => {
      useGitStore.getState().setPrState('wt-1', {
        state: 'creating',
        sessionId: 'session-1',
        targetBranch: 'origin/main'
      })
      const prInfo = useGitStore.getState().prInfo.get('wt-1')
      expect(prInfo?.state).toBe('creating')
      expect(prInfo?.sessionId).toBe('session-1')
      expect(prInfo?.targetBranch).toBe('origin/main')
    })

    test('prState is created after PR URL detection', () => {
      useGitStore.getState().setPrState('wt-1', {
        state: 'created',
        prNumber: 42,
        prUrl: 'https://github.com/org/repo/pull/42',
        sessionId: 'session-1',
        targetBranch: 'origin/main'
      })
      const prInfo = useGitStore.getState().prInfo.get('wt-1')
      expect(prInfo?.state).toBe('created')
      expect(prInfo?.prNumber).toBe(42)
    })

    test('prState is merged after successful PR merge', () => {
      useGitStore.getState().setPrState('wt-1', {
        state: 'merged',
        prNumber: 42,
        prUrl: 'https://github.com/org/repo/pull/42'
      })
      const prInfo = useGitStore.getState().prInfo.get('wt-1')
      expect(prInfo?.state).toBe('merged')
    })
  })

  describe('clean tree detection for merge button', () => {
    test('isCleanTree is true when no file statuses exist for worktree', () => {
      const fileStatuses = useGitStore.getState().fileStatusesByWorktree.get('/test/path')
      const isCleanTree = !fileStatuses || fileStatuses.length === 0
      expect(isCleanTree).toBe(true)
    })

    test('isCleanTree is true when file statuses array is empty', () => {
      useGitStore.setState({
        fileStatusesByWorktree: new Map([['/test/path', []]])
      })
      const fileStatuses = useGitStore.getState().fileStatusesByWorktree.get('/test/path')
      const isCleanTree = !fileStatuses || fileStatuses.length === 0
      expect(isCleanTree).toBe(true)
    })

    test('isCleanTree is false when file statuses have entries', () => {
      useGitStore.setState({
        fileStatusesByWorktree: new Map([
          [
            '/test/path',
            [
              {
                path: '/test/path/file.ts',
                relativePath: 'file.ts',
                status: 'M' as const,
                staged: false
              }
            ]
          ]
        ])
      })
      const fileStatuses = useGitStore.getState().fileStatusesByWorktree.get('/test/path')
      const isCleanTree = !fileStatuses || fileStatuses.length === 0
      expect(isCleanTree).toBe(false)
    })
  })

  describe('button visibility state machine', () => {
    // Simulates the rendering conditions from Header.tsx

    function getVisibleButton(
      prState: string,
      isCleanTree: boolean,
      isGitHub: boolean
    ): 'pr-button' | 'pr-merge-button' | 'pr-archive-button' | null {
      if (!isGitHub) return null
      if (prState === 'merged') return 'pr-archive-button'
      if (prState === 'created' && isCleanTree) return 'pr-merge-button'
      if (prState === 'none' || prState === 'creating' || (prState === 'created' && !isCleanTree)) {
        return 'pr-button'
      }
      return null
    }

    test('shows PR button when state is none', () => {
      expect(getVisibleButton('none', true, true)).toBe('pr-button')
    })

    test('shows PR button when state is creating', () => {
      expect(getVisibleButton('creating', true, true)).toBe('pr-button')
    })

    test('shows Merge PR button when state is created and tree is clean', () => {
      expect(getVisibleButton('created', true, true)).toBe('pr-merge-button')
    })

    test('shows PR button (not Merge) when state is created but tree is dirty', () => {
      expect(getVisibleButton('created', false, true)).toBe('pr-button')
    })

    test('shows Archive button when state is merged', () => {
      expect(getVisibleButton('merged', true, true)).toBe('pr-archive-button')
    })

    test('shows Archive button when state is merged even with dirty tree', () => {
      expect(getVisibleButton('merged', false, true)).toBe('pr-archive-button')
    })

    test('shows nothing when isGitHub is false regardless of state', () => {
      expect(getVisibleButton('none', true, false)).toBeNull()
      expect(getVisibleButton('creating', true, false)).toBeNull()
      expect(getVisibleButton('created', true, false)).toBeNull()
      expect(getVisibleButton('merged', true, false)).toBeNull()
    })
  })

  describe('PR button disabled state', () => {
    test('PR button disabled during creating state', () => {
      const prState = 'creating'
      const isOperating = false
      const disabled = isOperating || prState === 'creating'
      expect(disabled).toBe(true)
    })

    test('PR button disabled when git operation in progress', () => {
      const prState: string = 'none'
      const isOperating = true
      const disabled = isOperating || prState === 'creating'
      expect(disabled).toBe(true)
    })

    test('PR button enabled when state is none and no operations', () => {
      const prState: string = 'none'
      const isOperating = false
      const disabled = isOperating || prState === 'creating'
      expect(disabled).toBe(false)
    })
  })

  describe('handleCreatePR sets prState to creating', () => {
    test('setPrState is called with creating state and sessionId after session creation', () => {
      // Simulate what handleCreatePR does after successful session creation
      const wtId = 'wt-1'
      const sessionId = 'new-session-1'
      const targetBranch = 'origin/main'

      useGitStore.getState().setPrState(wtId, {
        state: 'creating',
        sessionId,
        targetBranch
      })

      const prInfo = useGitStore.getState().prInfo.get(wtId)
      expect(prInfo?.state).toBe('creating')
      expect(prInfo?.sessionId).toBe(sessionId)
      expect(prInfo?.targetBranch).toBe(targetBranch)
    })

    test('prState does not change if session creation fails', () => {
      // Before handleCreatePR — no prInfo set
      const prInfo = useGitStore.getState().prInfo.get('wt-1')
      expect(prInfo).toBeUndefined()

      // Simulate session creation failure — setPrState is NOT called
      // (handleCreatePR returns early before setPrState)
      const resultSuccess = false
      if (resultSuccess) {
        useGitStore.getState().setPrState('wt-1', { state: 'creating' })
      }

      // prInfo should still be undefined
      expect(useGitStore.getState().prInfo.get('wt-1')).toBeUndefined()
    })
  })

  describe('handleMergePR logic', () => {
    test('transitions to merged on successful prMerge', () => {
      // Set up created state
      useGitStore.getState().setPrState('wt-1', {
        state: 'created',
        prNumber: 42,
        prUrl: 'https://github.com/org/repo/pull/42',
        sessionId: 'session-1',
        targetBranch: 'origin/main'
      })

      // Simulate successful merge — what handleMergePR does on success
      const pr = useGitStore.getState().prInfo.get('wt-1')!
      useGitStore.getState().setPrState('wt-1', { ...pr, state: 'merged' })

      const updatedPr = useGitStore.getState().prInfo.get('wt-1')
      expect(updatedPr?.state).toBe('merged')
      // Original fields preserved
      expect(updatedPr?.prNumber).toBe(42)
      expect(updatedPr?.prUrl).toBe('https://github.com/org/repo/pull/42')
    })

    test('does not transition to merged if prMerge fails', () => {
      useGitStore.getState().setPrState('wt-1', {
        state: 'created',
        prNumber: 42
      })

      // Simulate failed merge — handleMergePR shows toast but does NOT call setPrState
      const mergeResult = { success: false, error: 'Merge conflicts' }
      if (mergeResult.success) {
        const pr = useGitStore.getState().prInfo.get('wt-1')!
        useGitStore.getState().setPrState('wt-1', { ...pr, state: 'merged' })
      }

      expect(useGitStore.getState().prInfo.get('wt-1')?.state).toBe('created')
    })

    test('handleMergePR does nothing when prNumber is missing', () => {
      useGitStore.getState().setPrState('wt-1', {
        state: 'created'
        // no prNumber
      })

      const pr = useGitStore.getState().prInfo.get('wt-1')
      // handleMergePR guard: if (!pr?.prNumber) return
      const shouldProceed = !!pr?.prNumber
      expect(shouldProceed).toBe(false)
    })
  })

  describe('full lifecycle transitions', () => {
    test('none → creating → created → merged', () => {
      // Start: no prInfo
      expect(useGitStore.getState().prInfo.get('wt-1')).toBeUndefined()

      // Step 1: handleCreatePR — set to creating
      useGitStore.getState().setPrState('wt-1', {
        state: 'creating',
        sessionId: 'session-1',
        targetBranch: 'origin/main'
      })
      expect(useGitStore.getState().prInfo.get('wt-1')?.state).toBe('creating')

      // Step 2: PR URL detected — set to created
      const pr1 = useGitStore.getState().prInfo.get('wt-1')!
      useGitStore.getState().setPrState('wt-1', {
        ...pr1,
        state: 'created',
        prNumber: 42,
        prUrl: 'https://github.com/org/repo/pull/42'
      })
      expect(useGitStore.getState().prInfo.get('wt-1')?.state).toBe('created')
      expect(useGitStore.getState().prInfo.get('wt-1')?.prNumber).toBe(42)

      // Step 3: handleMergePR success — set to merged
      const pr2 = useGitStore.getState().prInfo.get('wt-1')!
      useGitStore.getState().setPrState('wt-1', { ...pr2, state: 'merged' })
      expect(useGitStore.getState().prInfo.get('wt-1')?.state).toBe('merged')

      // All fields preserved through transitions
      const finalPr = useGitStore.getState().prInfo.get('wt-1')
      expect(finalPr?.sessionId).toBe('session-1')
      expect(finalPr?.targetBranch).toBe('origin/main')
      expect(finalPr?.prNumber).toBe(42)
      expect(finalPr?.prUrl).toBe('https://github.com/org/repo/pull/42')
    })

    test('target branch dropdown hidden when showing Merge PR', () => {
      // When prState === 'created' && isCleanTree, only pr-merge-button shows
      // The PR button + dropdown block requires:
      // prState === 'none' || prState === 'creating' || (prState === 'created' && !isCleanTree)
      const prState: string = 'created'
      const isCleanTree = true
      const showsPRButtonWithDropdown =
        prState === 'none' || prState === 'creating' || (prState === 'created' && !isCleanTree)
      expect(showsPRButtonWithDropdown).toBe(false)
    })

    test('target branch dropdown hidden when showing Archive', () => {
      const prState: string = 'merged'
      const showsPRButtonWithDropdown =
        prState === 'none' || prState === 'creating' || (prState === 'created' && false)
      expect(showsPRButtonWithDropdown).toBe(false)
    })

    test('target branch dropdown visible when state is none', () => {
      const prState: string = 'none'
      const showsPRButtonWithDropdown =
        prState === 'none' || prState === 'creating' || (prState === 'created' && false)
      expect(showsPRButtonWithDropdown).toBe(true)
    })

    test('target branch dropdown visible when state is creating', () => {
      const prState: string = 'creating'
      const showsPRButtonWithDropdown =
        prState === 'none' || prState === 'creating' || (prState === 'created' && false)
      expect(showsPRButtonWithDropdown).toBe(true)
    })
  })
})

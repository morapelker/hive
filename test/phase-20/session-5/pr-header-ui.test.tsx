import { beforeEach, describe, expect, test, vi } from 'vitest'
import { useGitStore } from '../../../src/renderer/src/stores/useGitStore'

vi.mock('../../../src/renderer/src/stores/useWorktreeStore', () => ({
  useWorktreeStore: {
    getState: vi.fn(() => ({
      worktreesByProject: new Map(),
      selectedWorktreeId: null
    }))
  }
}))

describe('Session 5: PR header UI state', () => {
  beforeEach(() => {
    useGitStore.setState({
      prCreation: new Map(),
      attachedPR: new Map(),
      fileStatusesByWorktree: new Map(),
      remoteInfo: new Map(),
      branchInfoByWorktree: new Map(),
      isPushing: false,
      isPulling: false,
      error: null
    })
  })

  function deriveHeaderState(worktreeId: string) {
    const state = useGitStore.getState()
    const attachedPR = state.attachedPR.get(worktreeId) ?? null
    const prCreation = state.prCreation.get(worktreeId) ?? null

    return {
      attachedPR,
      isCreatingPR: prCreation?.creating ?? false,
      hasAttachedPR: !!attachedPR
    }
  }

  function isCleanTree(worktreePath: string): boolean {
    const fileStatuses = useGitStore.getState().fileStatusesByWorktree.get(worktreePath)
    return !fileStatuses || fileStatuses.length === 0
  }

  test('defaults to no attached PR and not creating', () => {
    expect(deriveHeaderState('wt-1')).toEqual({
      attachedPR: null,
      isCreatingPR: false,
      hasAttachedPR: false
    })
  })

  test('shows creating state after PR creation starts', () => {
    useGitStore.getState().setPrCreation('wt-1', {
      creating: true,
      sessionId: 'session-1'
    })

    expect(deriveHeaderState('wt-1')).toEqual({
      attachedPR: null,
      isCreatingPR: true,
      hasAttachedPR: false
    })
  })

  test('shows attached PR badge after a PR is attached', () => {
    useGitStore.getState().setAttachedPR('wt-1', {
      number: 42,
      url: 'https://github.com/org/repo/pull/42'
    })

    expect(deriveHeaderState('wt-1')).toEqual({
      attachedPR: {
        number: 42,
        url: 'https://github.com/org/repo/pull/42'
      },
      isCreatingPR: false,
      hasAttachedPR: true
    })
  })

  test('attached PR takes over once creation state is cleared', () => {
    useGitStore.getState().setPrCreation('wt-1', {
      creating: true,
      sessionId: 'session-1'
    })
    useGitStore.getState().setAttachedPR('wt-1', {
      number: 280,
      url: 'https://github.com/org/repo/pull/280'
    })
    useGitStore.getState().setPrCreation('wt-1', null)

    expect(deriveHeaderState('wt-1')).toEqual({
      attachedPR: {
        number: 280,
        url: 'https://github.com/org/repo/pull/280'
      },
      isCreatingPR: false,
      hasAttachedPR: true
    })
  })

  test('PR create button should be disabled while creating', () => {
    useGitStore.getState().setPrCreation('wt-1', {
      creating: true,
      sessionId: 'session-1'
    })

    const disabled = deriveHeaderState('wt-1').isCreatingPR
    expect(disabled).toBe(true)
  })

  test('clean tree is true when no file statuses exist for worktree path', () => {
    expect(isCleanTree('/test/path')).toBe(true)
  })

  test('clean tree is true when file statuses array is empty', () => {
    useGitStore.setState({
      fileStatusesByWorktree: new Map([['/test/path', []]])
    })

    expect(isCleanTree('/test/path')).toBe(true)
  })

  test('clean tree is false when file statuses have entries', () => {
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

    expect(isCleanTree('/test/path')).toBe(false)
  })

  test('replacing an older attachment updates the badge data', () => {
    useGitStore.getState().setAttachedPR('wt-1', {
      number: 101,
      url: 'https://github.com/org/repo/pull/101'
    })
    useGitStore.getState().setAttachedPR('wt-1', {
      number: 280,
      url: 'https://github.com/org/repo/pull/280'
    })

    expect(deriveHeaderState('wt-1').attachedPR).toEqual({
      number: 280,
      url: 'https://github.com/org/repo/pull/280'
    })
  })
})

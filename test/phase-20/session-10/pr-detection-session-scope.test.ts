import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { usePRDetection } from '../../../src/renderer/src/hooks/usePRDetection'
import { useGitStore } from '../../../src/renderer/src/stores/useGitStore'

let streamCallback: ((event: Record<string, unknown>) => void) | null = null
const getMessagesMock = vi.fn()
const attachPRMock = vi.fn(async (worktreeId: string, prNumber: number, prUrl: string) => {
  useGitStore.getState().setAttachedPR(worktreeId, { number: prNumber, url: prUrl })
})

const mockOnStream = vi.fn((cb: (event: Record<string, unknown>) => void) => {
  streamCallback = cb
  return () => {
    streamCallback = null
  }
})

Object.defineProperty(window, 'opencodeOps', {
  writable: true,
  value: {
    onStream: mockOnStream,
    getMessages: getMessagesMock
  }
})

const mockWorktreeState: {
  worktreesByProject: Map<string, Array<{ id: string; path: string }>>
} = {
  worktreesByProject: new Map()
}

const mockSessionState: {
  sessionsByWorktree: Map<string, Array<{ id: string; opencode_session_id: string | null }>>
} = {
  sessionsByWorktree: new Map()
}

vi.mock('../../../src/renderer/src/stores/useWorktreeStore', () => ({
  useWorktreeStore: Object.assign(
    <T>(selector: (state: typeof mockWorktreeState) => T): T => selector(mockWorktreeState),
    {
      getState: () => mockWorktreeState
    }
  )
}))

vi.mock('../../../src/renderer/src/stores/useSessionStore', () => ({
  useSessionStore: Object.assign(
    <T>(selector: (state: typeof mockSessionState) => T): T => selector(mockSessionState),
    {
      getState: () => mockSessionState
    }
  )
}))

describe('Session 10: PR detection session scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    streamCallback = null

    mockWorktreeState.worktreesByProject = new Map([
      [
        'project-1',
        [
          { id: 'wt-1', path: '/repo/wt-1' },
          { id: 'wt-2', path: '/repo/wt-2' }
        ]
      ]
    ])

    mockSessionState.sessionsByWorktree = new Map([
      [
        'wt-1',
        [
          {
            id: 'session-1',
            opencode_session_id: 'oc-1'
          }
        ]
      ],
      [
        'wt-2',
        [
          {
            id: 'session-2',
            opencode_session_id: 'oc-2'
          }
        ]
      ]
    ])

    useGitStore.setState({
      fileStatusesByWorktree: new Map(),
      branchInfoByWorktree: new Map(),
      conflictsByWorktree: {},
      isLoading: false,
      error: null,
      isCommitting: false,
      isPushing: false,
      isPulling: false,
      remoteInfo: new Map(),
      prTargetBranch: new Map(),
      reviewTargetBranch: new Map(),
      prCreation: new Map(),
      attachedPR: new Map(),
      defaultMergeBranch: new Map(),
      mergeSelectionVersion: 0,
      selectedMergeBranch: new Map(),
      selectedDiffBranch: new Map(),
      attachPR: attachPRMock
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  test('ignores PR URL stream events from other sessions/worktrees', () => {
    act(() => {
      useGitStore.getState().setPrCreation('wt-1', {
        creating: true,
        sessionId: 'session-1'
      })
      useGitStore.getState().setPrCreation('wt-2', {
        creating: true,
        sessionId: 'session-2'
      })
    })

    renderHook(() => usePRDetection('wt-1'))
    expect(streamCallback).not.toBeNull()

    act(() => {
      streamCallback?.({
        type: 'message.part.updated',
        sessionId: 'session-2',
        data: {
          part: {
            type: 'text',
            text: 'https://github.com/org/repo/pull/22'
          },
          delta: 'https://github.com/org/repo/pull/22'
        }
      })
    })

    expect(attachPRMock).not.toHaveBeenCalled()
    expect(useGitStore.getState().prCreation.get('wt-1')?.creating).toBe(true)
    expect(useGitStore.getState().prCreation.get('wt-2')?.creating).toBe(true)

    act(() => {
      streamCallback?.({
        type: 'message.part.updated',
        sessionId: 'session-1',
        data: {
          part: {
            type: 'text',
            text: 'https://github.com/org/repo/pull/11'
          },
          delta: 'https://github.com/org/repo/pull/11'
        }
      })
    })

    expect(attachPRMock).toHaveBeenCalledWith(
      'wt-1',
      11,
      'https://github.com/org/repo/pull/11'
    )
    expect(useGitStore.getState().prCreation.has('wt-1')).toBe(false)
    expect(useGitStore.getState().prCreation.get('wt-2')?.creating).toBe(true)
  })

  test('prefers the newly created PR URL over older PR URLs in the same streamed text', () => {
    act(() => {
      useGitStore.getState().setAttachedPR('wt-1', {
        number: 101,
        url: 'https://github.com/org/repo/pull/101'
      })
      useGitStore.getState().setPrCreation('wt-1', {
        creating: true,
        sessionId: 'session-1'
      })
    })

    renderHook(() => usePRDetection('wt-1'))

    act(() => {
      streamCallback?.({
        type: 'message.part.updated',
        sessionId: 'session-1',
        data: {
          part: {
            type: 'text',
            text: [
              'Existing context referenced https://github.com/org/repo/pull/101 earlier.',
              'Created PR #280 targeting main: https://github.com/org/repo/pull/280'
            ].join('\n')
          },
          delta: [
            'Existing context referenced https://github.com/org/repo/pull/101 earlier.\n',
            'Created PR #280 targeting main: https://github.com/org/repo/pull/280'
          ].join('')
        }
      })
    })

    expect(attachPRMock).toHaveBeenCalledWith(
      'wt-1',
      280,
      'https://github.com/org/repo/pull/280'
    )
    expect(useGitStore.getState().attachedPR.get('wt-1')).toEqual({
      number: 280,
      url: 'https://github.com/org/repo/pull/280'
    })
  })

  test('prefers the newest PR URL in tool output from PR creation', () => {
    act(() => {
      useGitStore.getState().setPrCreation('wt-1', {
        creating: true,
        sessionId: 'session-1'
      })
    })

    renderHook(() => usePRDetection('wt-1'))

    act(() => {
      streamCallback?.({
        type: 'message.part.updated',
        sessionId: 'session-1',
        data: {
          part: {
            type: 'tool',
            state: {
              output: [
                'Previous discussion mentioned https://github.com/org/repo/pull/101',
                'Creating pull request for feature into main',
                'https://github.com/org/repo/pull/280'
              ].join('\n')
            }
          }
        }
      })
    })

    expect(attachPRMock).toHaveBeenCalledWith(
      'wt-1',
      280,
      'https://github.com/org/repo/pull/280'
    )
  })

})

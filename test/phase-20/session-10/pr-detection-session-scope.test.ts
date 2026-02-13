import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { usePRDetection } from '../../../src/renderer/src/hooks/usePRDetection'
import { useGitStore } from '../../../src/renderer/src/stores/useGitStore'

let streamCallback: ((event: Record<string, unknown>) => void) | null = null

const mockOnStream = vi.fn((cb: (event: Record<string, unknown>) => void) => {
  streamCallback = cb
  return () => {
    streamCallback = null
  }
})

Object.defineProperty(window, 'opencodeOps', {
  writable: true,
  value: {
    onStream: mockOnStream
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
            opencode_session_id: null
          }
        ]
      ],
      [
        'wt-2',
        [
          {
            id: 'session-2',
            opencode_session_id: null
          }
        ]
      ]
    ])

    useGitStore.setState({
      prInfo: new Map(),
      fileStatusesByWorktree: new Map(),
      branchInfoByWorktree: new Map(),
      conflictsByWorktree: {},
      remoteInfo: new Map(),
      prTargetBranch: new Map(),
      defaultMergeBranch: new Map(),
      selectedMergeBranch: new Map(),
      mergeSelectionVersion: 0,
      isLoading: false,
      error: null,
      isCommitting: false,
      isPushing: false,
      isPulling: false
    })
  })

  afterEach(() => {
    cleanup()
  })

  test('ignores PR URL stream events from other sessions/worktrees', () => {
    act(() => {
      useGitStore.getState().setPrState('wt-1', {
        state: 'creating',
        sessionId: 'session-1',
        targetBranch: 'origin/main'
      })
      useGitStore.getState().setPrState('wt-2', {
        state: 'creating',
        sessionId: 'session-2',
        targetBranch: 'origin/main'
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

    expect(useGitStore.getState().prInfo.get('wt-1')?.state).toBe('creating')
    expect(useGitStore.getState().prInfo.get('wt-2')?.state).toBe('creating')

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

    const wt1Pr = useGitStore.getState().prInfo.get('wt-1')
    expect(wt1Pr?.state).toBe('created')
    expect(wt1Pr?.prNumber).toBe(11)
    expect(wt1Pr?.prUrl).toBe('https://github.com/org/repo/pull/11')
  })
})

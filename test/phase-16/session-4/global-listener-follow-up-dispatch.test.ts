import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { useOpenCodeGlobalListener } from '@/hooks/useOpenCodeGlobalListener'
import { resetSessionFollowUpDispatchState } from '@/lib/session-follow-up-dispatch'

let streamCallback: ((event: Record<string, unknown>) => void) | null = null

const mockPrompt = vi.fn<
  (
    path: string,
    opencodeSessionId: string,
    message: Array<{ type: 'text'; text: string }>
  ) => Promise<{
    success: boolean
    error?: string
  }>
>()

const mockOnStream = vi.fn((cb: (event: Record<string, unknown>) => void) => {
  streamCallback = cb
  return () => {
    streamCallback = null
  }
})

const mockOnBranchRenamed = vi.fn(() => () => {})
const mockDbSessionGet = vi.fn()
const mockDbWorktreeGet = vi.fn()
const mockConnectionGet = vi.fn()

Object.defineProperty(window, 'opencodeOps', {
  writable: true,
  value: {
    onStream: mockOnStream,
    prompt: mockPrompt
  }
})

Object.defineProperty(window, 'worktreeOps', {
  writable: true,
  value: { onBranchRenamed: mockOnBranchRenamed }
})

Object.defineProperty(window, 'db', {
  writable: true,
  value: {
    session: {
      get: mockDbSessionGet
    },
    worktree: {
      get: mockDbWorktreeGet
    }
  }
})

Object.defineProperty(window, 'connectionOps', {
  writable: true,
  value: {
    get: mockConnectionGet
  }
})

const setSessionStatusSpy = vi.fn()
const setLastMessageTimeSpy = vi.fn()
const addWorktreeToRecentSpy = vi.fn()
const addConnectionToRecentSpy = vi.fn()
const fetchUsageForProviderSpy = vi.fn().mockResolvedValue(undefined)
const fetchUsageSpy = vi.fn().mockResolvedValue(undefined)

const followUpQueues = new Map<string, string[]>()

const sessionStoreState = {
  activeSessionId: 'session-A',
  getSessionMode: vi.fn(() => 'build'),
  getPendingPlan: vi.fn(() => null),
  updateSessionName: vi.fn(),
  sessionsByWorktree: new Map<string, Array<{ id: string; opencode_session_id: string | null }>>(),
  sessionsByConnection: new Map<
    string,
    Array<{ id: string; opencode_session_id: string | null }>
  >(),
  dequeueFollowUpMessage: vi.fn((sessionId: string) => {
    const queue = followUpQueues.get(sessionId)
    if (!queue || queue.length === 0) return null
    const [head, ...rest] = queue
    if (rest.length === 0) {
      followUpQueues.delete(sessionId)
    } else {
      followUpQueues.set(sessionId, rest)
    }
    return head
  }),
  requeueFollowUpMessageFront: vi.fn((sessionId: string, message: string) => {
    const queue = followUpQueues.get(sessionId) || []
    followUpQueues.set(sessionId, [message, ...queue])
  })
}

const worktreeStoreState = {
  worktreesByProject: new Map<string, Array<{ id: string; path: string }>>(),
  updateWorktreeBranch: vi.fn()
}

const connectionStoreState = {
  connections: [] as Array<{ id: string; path: string; members: Array<{ worktree_id: string }> }>
}

vi.mock('@/stores/useSessionStore', () => ({
  useSessionStore: {
    getState: () => sessionStoreState
  }
}))

vi.mock('@/stores/useWorktreeStore', () => ({
  useWorktreeStore: {
    getState: () => worktreeStoreState
  }
}))

vi.mock('@/stores/useConnectionStore', () => ({
  useConnectionStore: {
    getState: () => connectionStoreState
  }
}))

vi.mock('@/stores/useWorktreeStatusStore', () => ({
  useWorktreeStatusStore: {
    getState: () => ({
      setSessionStatus: setSessionStatusSpy,
      setLastMessageTime: setLastMessageTimeSpy,
      clearSessionStatus: vi.fn(),
      sessionStatuses: {}
    })
  }
}))

vi.mock('@/stores/useRecentStore', () => ({
  useRecentStore: {
    getState: () => ({
      addWorktreeToRecent: addWorktreeToRecentSpy,
      addConnectionToRecent: addConnectionToRecentSpy
    })
  }
}))

vi.mock('@/stores/useQuestionStore', () => ({
  useQuestionStore: {
    getState: () => ({
      addQuestion: vi.fn(),
      removeQuestion: vi.fn()
    })
  }
}))

vi.mock('@/stores/usePermissionStore', () => ({
  usePermissionStore: {
    getState: () => ({
      addPermission: vi.fn(),
      removePermission: vi.fn(),
      pendingBySession: new Map()
    })
  }
}))

vi.mock('@/stores/useContextStore', () => ({
  useContextStore: {
    getState: () => ({
      setSessionTokens: vi.fn(),
      addSessionCost: vi.fn(),
      setModelLimit: vi.fn()
    })
  }
}))

vi.mock('@/stores', () => ({
  useUsageStore: {
    getState: () => ({
      fetchUsageForProvider: fetchUsageForProviderSpy,
      fetchUsage: fetchUsageSpy
    })
  },
  resolveUsageProvider: vi.fn(() => 'opencode')
}))

function hasCompletedStatus(sessionId: string): boolean {
  return setSessionStatusSpy.mock.calls.some((call) => {
    const calledSessionId = call[0]
    const status = call[1]
    return calledSessionId === sessionId && status === 'completed'
  })
}

async function flushAsync(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('Global listener background follow-up dispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetSessionFollowUpDispatchState()
    streamCallback = null
    followUpQueues.clear()
    sessionStoreState.activeSessionId = 'session-A'
    sessionStoreState.getSessionMode.mockReturnValue('build')
    sessionStoreState.sessionsByWorktree = new Map()
    sessionStoreState.sessionsByConnection = new Map()
    worktreeStoreState.worktreesByProject = new Map()
    connectionStoreState.connections = []
    mockPrompt.mockResolvedValue({ success: true })
    mockDbSessionGet.mockResolvedValue(null)
    mockDbWorktreeGet.mockResolvedValue(null)
    mockConnectionGet.mockResolvedValue({ success: false, error: 'not found' })
  })

  afterEach(() => {
    cleanup()
  })

  function mountAndGetCallback() {
    renderHook(() => useOpenCodeGlobalListener())
    expect(streamCallback).not.toBeNull()
    return streamCallback!
  }

  test('background idle with queued follow-up dispatches prompt and skips completed status', async () => {
    followUpQueues.set('session-B', ['follow-up 2'])
    sessionStoreState.sessionsByWorktree = new Map([
      ['wt-1', [{ id: 'session-B', opencode_session_id: 'opc-123' }]]
    ])
    worktreeStoreState.worktreesByProject = new Map([
      ['proj-1', [{ id: 'wt-1', path: '/tmp/worktree-1' }]]
    ])

    const cb = mountAndGetCallback()
    cb({
      type: 'session.status',
      sessionId: 'session-B',
      statusPayload: { type: 'idle' }
    })
    await flushAsync()

    expect(mockPrompt).toHaveBeenCalledWith('/tmp/worktree-1', 'opc-123', [
      { type: 'text', text: 'follow-up 2' }
    ])
    expect(setSessionStatusSpy).toHaveBeenCalledWith('session-B', 'working')
    expect(hasCompletedStatus('session-B')).toBe(false)
    expect(followUpQueues.has('session-B')).toBe(false)
  })

  test('prompt send failure requeues follow-up at front', async () => {
    followUpQueues.set('session-B', ['follow-up 2'])
    sessionStoreState.sessionsByWorktree = new Map([
      ['wt-1', [{ id: 'session-B', opencode_session_id: 'opc-123' }]]
    ])
    worktreeStoreState.worktreesByProject = new Map([
      ['proj-1', [{ id: 'wt-1', path: '/tmp/worktree-1' }]]
    ])
    mockPrompt.mockResolvedValue({ success: false, error: 'network failure' })

    const cb = mountAndGetCallback()
    cb({
      type: 'session.status',
      sessionId: 'session-B',
      statusPayload: { type: 'idle' }
    })
    await flushAsync()

    expect(mockPrompt).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(followUpQueues.get('session-B')).toEqual(['follow-up 2'])
      expect(hasCompletedStatus('session-B')).toBe(true)
    })
    expect(setSessionStatusSpy).toHaveBeenCalledWith('session-B', 'working')
  })

  test('duplicate idle events while dispatch in-flight do not double-dispatch', async () => {
    followUpQueues.set('session-B', ['follow-up 2'])
    sessionStoreState.sessionsByWorktree = new Map([
      ['wt-1', [{ id: 'session-B', opencode_session_id: 'opc-123' }]]
    ])
    worktreeStoreState.worktreesByProject = new Map([
      ['proj-1', [{ id: 'wt-1', path: '/tmp/worktree-1' }]]
    ])

    const deferred = createDeferred<{ success: boolean }>()
    mockPrompt.mockReturnValue(deferred.promise)

    const cb = mountAndGetCallback()
    cb({
      type: 'session.status',
      sessionId: 'session-B',
      statusPayload: { type: 'idle' }
    })
    cb({
      type: 'session.status',
      sessionId: 'session-B',
      statusPayload: { type: 'idle' }
    })
    await flushAsync()

    expect(mockPrompt).toHaveBeenCalledTimes(1)
    expect(sessionStoreState.dequeueFollowUpMessage).toHaveBeenCalledTimes(1)
    expect(followUpQueues.has('session-B')).toBe(false)

    deferred.resolve({ success: true })
    await flushAsync()

    await waitFor(() => {
      expect(mockPrompt).toHaveBeenCalledTimes(1)
      // One dequeue for initial dispatch, one dequeue when processing deferred idle.
      expect(sessionStoreState.dequeueFollowUpMessage).toHaveBeenCalledTimes(2)
      expect(hasCompletedStatus('session-B')).toBe(true)
    })
  })

  test('background idle with no follow-up keeps existing completed behavior', async () => {
    sessionStoreState.sessionsByWorktree = new Map([
      ['wt-1', [{ id: 'session-B', opencode_session_id: 'opc-123' }]]
    ])
    worktreeStoreState.worktreesByProject = new Map([
      ['proj-1', [{ id: 'wt-1', path: '/tmp/worktree-1' }]]
    ])

    const cb = mountAndGetCallback()
    cb({
      type: 'session.status',
      sessionId: 'session-B',
      statusPayload: { type: 'idle' }
    })

    expect(mockPrompt).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(hasCompletedStatus('session-B')).toBe(true)
    })
  })

  test('active session idle is ignored by global listener even with queued follow-up', async () => {
    followUpQueues.set('session-A', ['should not dispatch'])
    sessionStoreState.activeSessionId = 'session-A'
    sessionStoreState.sessionsByWorktree = new Map([
      ['wt-1', [{ id: 'session-A', opencode_session_id: 'opc-active' }]]
    ])
    worktreeStoreState.worktreesByProject = new Map([
      ['proj-1', [{ id: 'wt-1', path: '/tmp/worktree-active' }]]
    ])

    const cb = mountAndGetCallback()
    cb({
      type: 'session.status',
      sessionId: 'session-A',
      statusPayload: { type: 'idle' }
    })
    await flushAsync()

    expect(mockPrompt).not.toHaveBeenCalled()
    expect(followUpQueues.get('session-A')).toEqual(['should not dispatch'])
    expect(setSessionStatusSpy).not.toHaveBeenCalled()
  })

  test('connection session follow-up uses connection path', async () => {
    followUpQueues.set('session-C', ['follow-up connection'])
    sessionStoreState.sessionsByConnection = new Map([
      ['conn-1', [{ id: 'session-C', opencode_session_id: 'opc-conn' }]]
    ])
    connectionStoreState.connections = [
      { id: 'conn-1', path: '/tmp/connection-root', members: [{ worktree_id: 'wt-1' }] }
    ]

    const cb = mountAndGetCallback()
    cb({
      type: 'session.status',
      sessionId: 'session-C',
      statusPayload: { type: 'idle' }
    })
    await flushAsync()

    expect(mockPrompt).toHaveBeenCalledWith('/tmp/connection-root', 'opc-conn', [
      { type: 'text', text: 'follow-up connection' }
    ])
    expect(setSessionStatusSpy).toHaveBeenCalledWith('session-C', 'working')
    expect(hasCompletedStatus('session-C')).toBe(false)
  })

  test('background follow-up prefers DB materialized session id over store pending id', async () => {
    followUpQueues.set('session-B', ['follow-up 2'])
    sessionStoreState.sessionsByWorktree = new Map([
      ['wt-1', [{ id: 'session-B', opencode_session_id: 'pending::abc' }]]
    ])
    worktreeStoreState.worktreesByProject = new Map([
      ['proj-1', [{ id: 'wt-1', path: '/tmp/worktree-1' }]]
    ])

    mockDbSessionGet.mockResolvedValue({
      id: 'session-B',
      worktree_id: 'wt-1',
      connection_id: null,
      opencode_session_id: 'opc-real-123'
    })
    mockDbWorktreeGet.mockResolvedValue({ id: 'wt-1', path: '/tmp/worktree-1' })

    const cb = mountAndGetCallback()
    cb({
      type: 'session.status',
      sessionId: 'session-B',
      statusPayload: { type: 'idle' }
    })
    await flushAsync()

    expect(mockPrompt).toHaveBeenCalledWith('/tmp/worktree-1', 'opc-real-123', [
      { type: 'text', text: 'follow-up 2' }
    ])
    expect(followUpQueues.has('session-B')).toBe(false)
  })
})

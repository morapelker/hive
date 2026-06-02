import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { useOpenCodeGlobalListener } from '@/hooks/useOpenCodeGlobalListener'
import { resetSessionFollowUpDispatchState } from '@/lib/session-follow-up-dispatch'

const apiMocks = vi.hoisted(() => {
  const state = {
    streamCallback: null as ((event: Record<string, unknown>) => void) | null,
    notifyKanbanSessionSyncSpy: vi.fn(),
    prompt: vi.fn<
      (
        path: string,
        opencodeSessionId: string,
        message: Array<{ type: 'text'; text: string }>
      ) => Promise<{
        success: boolean
        error?: string
      }>
    >(),
    onStream: vi.fn((cb: (event: Record<string, unknown>) => void) => {
      state.streamCallback = cb
      return () => {
        state.streamCallback = null
      }
    }),
    onBranchRenamed: vi.fn(() => () => {}),
    dbSessionGet: vi.fn(),
    dbWorktreeGet: vi.fn(),
    connectionGet: vi.fn()
  }
  return state
})

const {
  notifyKanbanSessionSyncSpy,
  prompt: mockPrompt,
  dbSessionGet: mockDbSessionGet,
  dbWorktreeGet: mockDbWorktreeGet,
  connectionGet: mockConnectionGet
} = apiMocks

vi.mock('@/api/opencode-api', () => ({
  opencodeApi: {
    onStream: apiMocks.onStream,
    prompt: apiMocks.prompt
  }
}))

vi.mock('@/api/worktree-api', () => ({
  worktreeApi: {
    onBranchRenamed: apiMocks.onBranchRenamed
  }
}))

vi.mock('@/api/db-api', () => ({
  dbApi: {
    session: {
      get: apiMocks.dbSessionGet
    },
    worktree: {
      get: apiMocks.dbWorktreeGet
    }
  }
}))

vi.mock('@/api/connection-api', () => ({
  connectionApi: {
    get: apiMocks.connectionGet
  }
}))

const setSessionStatusSpy = vi.fn()
const clearSessionStatusSpy = vi.fn()
const setLastMessageTimeSpy = vi.fn()
const addWorktreeToRecentSpy = vi.fn()
const addConnectionToRecentSpy = vi.fn()
const fetchUsageForProviderSpy = vi.fn().mockResolvedValue(undefined)
const fetchUsageSpy = vi.fn().mockResolvedValue(undefined)
const removeQuestionSpy = vi.fn()
const removePermissionSpy = vi.fn()
const removeApprovalSpy = vi.fn()
const clearPendingPlanSpy = vi.fn()
const setSessionModeSpy = vi.fn().mockResolvedValue(undefined)

const followUpQueues = new Map<string, string[]>()
const questionQueues = new Map<string, Array<{ id: string }>>()
const permissionQueues = new Map<string, Array<{ id: string }>>()
const approvalQueues = new Map<string, Array<{ id: string }>>()
const pendingPlans = new Map<string, unknown>()

const sessionStoreState = {
  activeSessionId: 'session-A',
  getSessionMode: vi.fn(() => 'build'),
  getPendingPlan: vi.fn((sessionId: string) => pendingPlans.get(sessionId) ?? null),
  clearPendingPlan: clearPendingPlanSpy,
  setSessionMode: setSessionModeSpy,
  updateSessionName: vi.fn(),
  setCodexGoal: vi.fn(),
  clearCodexGoal: vi.fn(),
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

vi.mock('@/stores/useSettingsStore', () => ({
  useSettingsStore: {
    getState: () => ({
      commandFilter: { enabled: false, allowlist: [] },
      usageIndicatorMode: 'off',
      usageIndicatorProviders: []
    })
  }
}))

vi.mock('@/stores/useWorktreeStatusStore', () => ({
  useWorktreeStatusStore: {
    getState: () => ({
      setSessionStatus: setSessionStatusSpy,
      setLastMessageTime: setLastMessageTimeSpy,
      clearSessionStatus: clearSessionStatusSpy,
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
      removeQuestion: removeQuestionSpy,
      getQuestions: (sessionId: string) => questionQueues.get(sessionId) ?? []
    })
  }
}))

vi.mock('@/stores/usePermissionStore', () => ({
  usePermissionStore: {
    getState: () => ({
      addPermission: vi.fn(),
      removePermission: removePermissionSpy,
      getPermissions: (sessionId: string) => permissionQueues.get(sessionId) ?? [],
      pendingBySession: permissionQueues
    })
  }
}))

vi.mock('@/stores/useCommandApprovalStore', () => ({
  useCommandApprovalStore: {
    getState: () => ({
      addApproval: vi.fn(),
      removeApproval: removeApprovalSpy,
      getApprovals: (sessionId: string) => approvalQueues.get(sessionId) ?? []
    })
  }
}))

vi.mock('@/stores/store-coordination', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/store-coordination')>()
  return {
    ...actual,
    notifyKanbanSessionSync: apiMocks.notifyKanbanSessionSyncSpy
  }
})

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
    apiMocks.streamCallback = null
    followUpQueues.clear()
    questionQueues.clear()
    permissionQueues.clear()
    approvalQueues.clear()
    pendingPlans.clear()
    clearPendingPlanSpy.mockImplementation((sessionId: string) => {
      pendingPlans.delete(sessionId)
    })
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
    expect(apiMocks.streamCallback).not.toBeNull()
    return apiMocks.streamCallback!
  }

  test('background question reply clears the prompt and restores working status', () => {
    questionQueues.set('session-B', [])

    const cb = mountAndGetCallback()
    cb({
      type: 'question.replied',
      sessionId: 'session-B',
      data: { requestId: 'question-1' }
    })

    expect(removeQuestionSpy).toHaveBeenCalledWith('session-B', 'question-1')
    expect(setSessionStatusSpy).toHaveBeenCalledWith('session-B', 'working')
  })

  test('background question reply keeps answering status when another question remains', () => {
    questionQueues.set('session-B', [{ id: 'question-2' }])

    const cb = mountAndGetCallback()
    cb({
      type: 'question.replied',
      sessionId: 'session-B',
      data: { requestId: 'question-1' }
    })

    expect(removeQuestionSpy).toHaveBeenCalledWith('session-B', 'question-1')
    expect(setSessionStatusSpy).not.toHaveBeenCalledWith('session-B', 'working')
  })

  test('background permission reply clears the prompt and restores working status', () => {
    permissionQueues.set('session-B', [])

    const cb = mountAndGetCallback()
    cb({
      type: 'permission.replied',
      sessionId: 'session-B',
      data: { requestId: 'permission-1' }
    })

    expect(removePermissionSpy).toHaveBeenCalledWith('session-B', 'permission-1')
    expect(setSessionStatusSpy).toHaveBeenCalledWith('session-B', 'working')
  })

  test('background command approval reply clears the prompt and restores working status', () => {
    approvalQueues.set('session-B', [])

    const cb = mountAndGetCallback()
    cb({
      type: 'command.approval_replied',
      sessionId: 'session-B',
      data: { requestId: 'approval-1' }
    })

    expect(removeApprovalSpy).toHaveBeenCalledWith('session-B', 'approval-1')
    expect(setSessionStatusSpy).toHaveBeenCalledWith('session-B', 'working')
  })

  test('background plan implement clears review state and marks the session working', async () => {
    pendingPlans.set('session-B', { requestId: 'plan-1' })

    const cb = mountAndGetCallback()
    cb({
      type: 'plan.resolved',
      sessionId: 'session-B',
      data: { requestId: 'plan-1', approved: true, resolution: 'implement' }
    })
    await flushAsync()

    expect(clearPendingPlanSpy).toHaveBeenCalledWith('session-B')
    expect(setSessionModeSpy).toHaveBeenCalledWith('session-B', 'build')
    expect(notifyKanbanSessionSyncSpy).toHaveBeenCalledWith('session-B', { type: 'implement' })
    expect(setSessionStatusSpy).toHaveBeenCalledWith('session-B', 'working')
  })

  test('background plan feedback clears review state and marks the session planning', async () => {
    pendingPlans.set('session-B', { requestId: 'plan-1' })

    const cb = mountAndGetCallback()
    cb({
      type: 'plan.resolved',
      sessionId: 'session-B',
      data: { requestId: 'plan-1', approved: false, resolution: 'feedback' }
    })
    await flushAsync()

    expect(clearPendingPlanSpy).toHaveBeenCalledWith('session-B')
    expect(setSessionStatusSpy).toHaveBeenCalledWith('session-B', 'planning')
  })

  test('background plan handoff clears the old session without marking it working', () => {
    pendingPlans.set('session-B', { requestId: 'plan-1' })

    const cb = mountAndGetCallback()
    cb({
      type: 'plan.resolved',
      sessionId: 'session-B',
      data: { requestId: 'plan-1', approved: true, resolution: 'handoff' }
    })

    expect(clearPendingPlanSpy).toHaveBeenCalledWith('session-B')
    expect(clearSessionStatusSpy).toHaveBeenCalledWith('session-B')
    expect(setSessionStatusSpy).not.toHaveBeenCalledWith('session-B', 'working')
  })

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

    await waitFor(() => {
      expect(mockPrompt).toHaveBeenCalledWith('/tmp/worktree-1', 'opc-real-123', [
        { type: 'text', text: 'follow-up 2' }
      ])
    })
    expect(followUpQueues.has('session-B')).toBe(false)
  })

  test('goal update events update Codex goal state for background sessions', () => {
    const goal = {
      threadId: 'thread-1',
      objective: 'finish the narrow fix',
      status: 'complete',
      tokenBudget: null,
      tokensUsed: 42,
      timeUsedSeconds: 12,
      createdAt: 100,
      updatedAt: 200
    }

    const cb = mountAndGetCallback()
    cb({
      type: 'codex.goal.updated',
      sessionId: 'session-B',
      data: { goal }
    })

    expect(sessionStoreState.setCodexGoal).toHaveBeenCalledWith('session-B', goal)
  })

  test('goal cleared events clear Codex goal state for active sessions too', () => {
    sessionStoreState.activeSessionId = 'session-A'

    const cb = mountAndGetCallback()
    cb({
      type: 'codex.goal.cleared',
      sessionId: 'session-A',
      data: {}
    })

    expect(sessionStoreState.clearCodexGoal).toHaveBeenCalledWith('session-A')
  })
})

// The window tells the backend which sessions are running: which statuses count, and when the
// report is sent.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  reportRunningSessions: vi.fn(async (_sessionIds: readonly string[]) => ({ ok: true as const })),
  openListeners: new Set<() => void>()
}))
vi.mock('@/api/settings-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/settings-api')>()
  return {
    ...actual,
    settingsApi: { ...actual.settingsApi, reportRunningSessions: api.reportRunningSessions }
  }
})
vi.mock('@/api/rpc-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/rpc-client')>()
  return {
    ...actual,
    // The client the stores were given, with the socket's "opened" hook of the real one.
    getRendererRpcClient: () => ({
      request: async () => undefined,
      subscribe: () => () => undefined,
      onOpen: (listener: () => void) => {
        api.openListeners.add(listener)
        return () => api.openListeners.delete(listener)
      }
    })
  }
})

import { lastSendMode } from '@/lib/message-send-times'
import { useWorktreeStatusStore, type SessionStatusEntry } from '@/stores/useWorktreeStatusStore'
import type { SessionStatusType } from '@shared/types/session-status'
import {
  RUNNING_REPORT_DEBOUNCE_MS,
  RUNNING_REPORT_RETRY_MS,
  runningSessionIdsOf,
  startRunningSessionsReport
} from './running-sessions-report'

const entry = (
  status: SessionStatusType,
  extra: Partial<SessionStatusEntry> = {}
): SessionStatusEntry => ({
  status,
  timestamp: 1,
  ...extra
})

const reports = (): unknown[] => api.reportRunningSessions.mock.calls.map(([ids]) => ids)
const setStatus = (sessionId: string, status: SessionStatusType | null): void =>
  useWorktreeStatusStore.getState().setSessionStatus(sessionId, status)
const reopen = (): void => {
  for (const listener of api.openListeners) listener()
}

describe('runningSessionIdsOf', () => {
  const notPlan = (): boolean => false

  it.each<[SessionStatusType, boolean]>([
    ['working', true],
    ['planning', true],
    ['answering', true],
    ['permission', true],
    ['command_approval', true],
    ['plan_ready', true],
    ['completed', false],
    ['unread', false]
  ])('a %s session: running = %s', (status, running) => {
    expect(runningSessionIdsOf({ s1: entry(status) }, notPlan)).toEqual(running ? ['s1'] : [])
  })

  it('counts a turn that ended in plan mode as a plan waiting for approval', () => {
    const sentInPlanMode = (id: string): boolean => id === 'planned'
    expect(
      runningSessionIdsOf(
        { planned: entry('completed'), built: entry('completed') },
        sentInPlanMode
      )
    ).toEqual(['planned'])
    // A turn that ended on an API error produced no plan
    expect(
      runningSessionIdsOf(
        { planned: entry('completed', { apiError: 'overloaded' }) },
        sentInPlanMode
      )
    ).toEqual([])
    // Unread after a plan turn is merely unread
    expect(runningSessionIdsOf({ planned: entry('unread') }, sentInPlanMode)).toEqual([])
  })

  it('reads the plan mode a message was last sent in, by default', () => {
    lastSendMode.set('s-plan', 'plan')
    lastSendMode.set('s-build', 'build')
    try {
      expect(
        runningSessionIdsOf({ 's-plan': entry('completed'), 's-build': entry('completed') })
      ).toEqual(['s-plan'])
    } finally {
      lastSendMode.delete('s-plan')
      lastSendMode.delete('s-build')
    }
  })

  it('lists every running session, sorted by id, skipping cleared ones', () => {
    expect(
      runningSessionIdsOf(
        {
          b: entry('answering'),
          a: entry('working'),
          gone: null,
          done: entry('completed'),
          c: entry('planning')
        },
        notPlan
      )
    ).toEqual(['a', 'b', 'c'])
  })

  it('never sends more sessions than the backend accepts', () => {
    const statuses: Record<string, SessionStatusEntry> = {}
    for (let i = 0; i < 600; i++) statuses[`s${String(i).padStart(4, '0')}`] = entry('working')
    expect(runningSessionIdsOf(statuses, notPlan)).toHaveLength(500)
  })
})

describe('running sessions report', () => {
  let stop: () => void = () => undefined
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    api.reportRunningSessions.mockReset()
    api.reportRunningSessions.mockImplementation(async () => ({ ok: true as const }))
    api.openListeners.clear()
    useWorktreeStatusStore.setState({ sessionStatuses: {} })
  })

  afterEach(() => {
    stop()
    stop = () => undefined
    useWorktreeStatusStore.setState({ sessionStatuses: {} })
    warn.mockRestore()
    vi.useRealTimers()
  })

  it('says at start what is running, also when that is nothing', () => {
    stop = startRunningSessionsReport()
    expect(reports()).toEqual([[]])
  })

  it('says at start which sessions are already running', () => {
    useWorktreeStatusStore.setState({
      sessionStatuses: { s1: entry('working'), s2: entry('answering'), s3: entry('completed') }
    })
    stop = startRunningSessionsReport()
    expect(reports()).toEqual([['s1', 's2']])
  })

  it('reports a session that starts and one that ends; waiting on a person changes nothing', async () => {
    stop = startRunningSessionsReport()
    setStatus('s1', 'working')
    await vi.advanceTimersByTimeAsync(RUNNING_REPORT_DEBOUNCE_MS)
    setStatus('s1', 'answering')
    await vi.advanceTimersByTimeAsync(RUNNING_REPORT_DEBOUNCE_MS)
    setStatus('s1', 'working')
    await vi.advanceTimersByTimeAsync(RUNNING_REPORT_DEBOUNCE_MS)
    setStatus('s1', 'completed')
    await vi.advanceTimersByTimeAsync(RUNNING_REPORT_DEBOUNCE_MS)
    expect(reports()).toEqual([[], ['s1'], []])
  })

  it('folds a burst of status changes into one report', async () => {
    stop = startRunningSessionsReport()
    setStatus('s1', 'working')
    setStatus('s2', 'planning')
    setStatus('s1', 'permission')
    await vi.advanceTimersByTimeAsync(RUNNING_REPORT_DEBOUNCE_MS)
    expect(reports()).toEqual([[], ['s1', 's2']])
  })

  it('stays silent while the set does not change: ticks of a working session, a session read', async () => {
    stop = startRunningSessionsReport()
    setStatus('s1', 'working')
    await vi.advanceTimersByTimeAsync(RUNNING_REPORT_DEBOUNCE_MS)
    // The store replaces its record on every tick of a working session
    useWorktreeStatusStore.setState((state) => ({
      sessionStatuses: {
        ...state.sessionStatuses,
        s1: entry('working', { timestamp: 2, tokenDelta: 40 })
      }
    }))
    setStatus('s2', 'completed')
    setStatus('s2', 'unread')
    setStatus('s2', null)
    await vi.advanceTimersByTimeAsync(RUNNING_REPORT_DEBOUNCE_MS * 4)
    expect(reports()).toHaveLength(2)
  })

  it('says it all again when the socket reopens: the backend forgot the closed socket', async () => {
    stop = startRunningSessionsReport()
    setStatus('s1', 'working')
    await vi.advanceTimersByTimeAsync(RUNNING_REPORT_DEBOUNCE_MS)
    reopen()
    expect(reports().slice(-2)).toEqual([['s1'], ['s1']])
  })

  it('a report that failed is sent again by itself, until the backend takes it', async () => {
    api.reportRunningSessions.mockRejectedValueOnce(new Error('TIMEOUT'))
    api.reportRunningSessions.mockRejectedValueOnce(new Error('TIMEOUT'))
    useWorktreeStatusStore.setState({ sessionStatuses: { s1: entry('working') } })
    stop = startRunningSessionsReport()
    await vi.advanceTimersByTimeAsync(RUNNING_REPORT_RETRY_MS - 1)
    expect(reports()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(reports()).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(RUNNING_REPORT_RETRY_MS)
    expect(reports()).toHaveLength(3)
    // Taken: nothing more is sent
    await vi.advanceTimersByTimeAsync(RUNNING_REPORT_RETRY_MS * 5)
    expect(reports()).toEqual([['s1'], ['s1'], ['s1']])
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('a report that failed is sent again with the next change, without waiting', async () => {
    api.reportRunningSessions.mockRejectedValueOnce(new Error('socket closed'))
    useWorktreeStatusStore.setState({ sessionStatuses: { s1: entry('working') } })
    stop = startRunningSessionsReport()
    await vi.advanceTimersByTimeAsync(0)
    expect(warn).toHaveBeenCalledTimes(1)
    // The record is replaced with the same set: nothing changed, but the backend was never told
    useWorktreeStatusStore.setState((state) => ({
      sessionStatuses: { ...state.sessionStatuses }
    }))
    await vi.advanceTimersByTimeAsync(RUNNING_REPORT_DEBOUNCE_MS)
    expect(reports()).toEqual([['s1'], ['s1']])
    // The retry that was pending finds nothing left to say
    await vi.advanceTimersByTimeAsync(RUNNING_REPORT_RETRY_MS)
    expect(reports()).toHaveLength(2)
  })

  it('survives a window without an RPC client and reports when the socket opens', () => {
    api.reportRunningSessions.mockImplementationOnce(() => {
      throw new Error('no client')
    })
    stop = startRunningSessionsReport()
    expect(warn).toHaveBeenCalledTimes(1)
    reopen()
    expect(reports()).toEqual([[], []])
  })

  it('is started once, and stops reporting when stopped', async () => {
    stop = startRunningSessionsReport()
    expect(startRunningSessionsReport()).toBe(stop)
    setStatus('s1', 'working')
    stop()
    await vi.advanceTimersByTimeAsync(RUNNING_REPORT_DEBOUNCE_MS * 2)
    reopen()
    expect(reports()).toEqual([[]])
  })
})

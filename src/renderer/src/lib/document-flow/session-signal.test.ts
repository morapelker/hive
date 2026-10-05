import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { markSessionAborted } from '@/api/opencode-api'
import { useQuestionStore } from '@/stores/useQuestionStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStatusStore, type SessionStatusEntry } from '@/stores/useWorktreeStatusStore'
import type { Session } from '../../../../main/db/types'
import {
  getSessionSignal,
  resetSessionSignalLatchForTests,
  startSessionSignalLatch
} from './session-signal'

const SESSION = 'session-1'
const OPENCODE_SESSION = 'opc-1'

const initialStatusState = useWorktreeStatusStore.getState()
const initialQuestionState = useQuestionStore.getState()
const initialSessionState = useSessionStore.getState()

/** An SDK session row in the store, so the signal can find its opencode session id. */
function seedSdkSession(): void {
  const session = {
    id: SESSION,
    worktree_id: 'wt-1',
    project_id: 'project-1',
    connection_id: null,
    name: 'Session',
    status: 'active',
    opencode_session_id: OPENCODE_SESSION,
    claude_session_id: null,
    agent_sdk: 'claude-code',
    mode: 'build',
    session_type: 'default',
    model_provider_id: null,
    model_id: null,
    model_variant: null,
    remote_launch: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    completed_at: null,
    pinned_to_board: false
  } as Session
  useSessionStore.setState({ sessionsByWorktree: new Map([['wt-1', [session]]]) })
}

function setStatus(sessionId: string, entry: SessionStatusEntry | null): void {
  useWorktreeStatusStore.setState((state) => ({
    sessionStatuses: { ...state.sessionStatuses, [sessionId]: entry }
  }))
}

const completed = (overrides: Partial<SessionStatusEntry> = {}): SessionStatusEntry => ({
  status: 'completed',
  timestamp: 1_000,
  completion: 'completed',
  ...overrides
})

describe('getSessionSignal', () => {
  beforeEach(() => {
    useWorktreeStatusStore.setState(
      {
        ...initialStatusState,
        sessionStatuses: {},
        sessionApiErrors: {},
        backgroundWorkBySession: {}
      },
      true
    )
    useQuestionStore.setState({ ...initialQuestionState, pendingBySession: new Map() }, true)
    useSessionStore.setState(
      { ...initialSessionState, sessionsByWorktree: new Map(), sessionsByConnection: new Map() },
      true
    )
    resetSessionSignalLatchForTests()
  })

  afterEach(() => {
    resetSessionSignalLatchForTests()
    useWorktreeStatusStore.setState(initialStatusState, true)
    useQuestionStore.setState(initialQuestionState, true)
    useSessionStore.setState(initialSessionState, true)
    vi.useRealTimers()
  })

  it('is unknown for a session without a status', () => {
    expect(getSessionSignal(SESSION)).toEqual({ kind: 'unknown' })
  })

  it.each(['working', 'planning'] as const)('reads %s as working, with its time', (status) => {
    setStatus(SESSION, { status, timestamp: 1 })
    expect(getSessionSignal(SESSION)).toEqual({ kind: 'working', since: 1 })
  })

  it('maps the waiting statuses to a blocked signal with its reason', () => {
    setStatus(SESSION, { status: 'answering', timestamp: 1 })
    expect(getSessionSignal(SESSION)).toEqual({
      kind: 'blocked',
      reason: 'question',
      detail: null
    })

    setStatus(SESSION, { status: 'permission', timestamp: 1, toolName: 'Bash' })
    expect(getSessionSignal(SESSION)).toEqual({
      kind: 'blocked',
      reason: 'permission',
      detail: 'Permission to use Bash'
    })

    setStatus(SESSION, { status: 'command_approval', timestamp: 1 })
    expect(getSessionSignal(SESSION)).toMatchObject({ kind: 'blocked', reason: 'command_approval' })

    setStatus(SESSION, { status: 'plan_ready', timestamp: 1 })
    expect(getSessionSignal(SESSION)).toMatchObject({ kind: 'blocked', reason: 'plan' })
  })

  it('reads a pending question from the question store, with its text, over any status', () => {
    setStatus(SESSION, { status: 'working', timestamp: 1 })
    useQuestionStore.getState().addQuestion(SESSION, {
      id: 'q-1',
      sessionID: SESSION,
      questions: [{ question: ' Which currency? ', header: 'Currency', options: [] }]
    })

    expect(getSessionSignal(SESSION)).toEqual({
      kind: 'blocked',
      reason: 'question',
      detail: 'Which currency?'
    })

    useQuestionStore.getState().removeQuestion(SESSION, 'q-1')
    expect(getSessionSignal(SESSION)).toEqual({ kind: 'working', since: 1 })
  })

  it('falls back to the question header, then to no text', () => {
    useQuestionStore.getState().addQuestion(SESSION, {
      id: 'q-1',
      sessionID: SESSION,
      questions: [{ question: '', header: 'Currency', options: [] }]
    })
    expect(getSessionSignal(SESSION)).toMatchObject({ detail: 'Currency' })

    useQuestionStore.getState().clearSession(SESSION)
    useQuestionStore.getState().addQuestion(SESSION, {
      id: 'q-2',
      sessionID: SESSION,
      questions: []
    })
    expect(getSessionSignal(SESSION)).toMatchObject({ kind: 'blocked', detail: null })
  })

  it('reads a completed status as an ended turn with its details', () => {
    setStatus(
      SESSION,
      completed({
        timestamp: 42,
        completion: 'waiting',
        reason: 'pty_exit',
        apiError: 'rate_limit',
        hookEventName: 'StopFailure'
      })
    )
    useWorktreeStatusStore.getState().setSessionBackgroundWork(SESSION, {
      runningShells: 1,
      runningMonitors: 0,
      runningSubagents: 0
    })

    expect(getSessionSignal(SESSION)).toEqual({
      kind: 'ended',
      at: 42,
      completion: 'waiting',
      apiError: 'rate_limit',
      reason: 'pty_exit',
      hookEvent: 'StopFailure',
      hasBackgroundWork: true
    })
  })

  it('takes the API error from the separate error map when the entry has none', () => {
    setStatus(SESSION, completed())
    useWorktreeStatusStore.getState().setSessionApiError(SESSION, 'overloaded')

    expect(getSessionSignal(SESSION)).toMatchObject({ kind: 'ended', apiError: 'overloaded' })
  })

  it('treats an unread entry like no entry', () => {
    setStatus(SESSION, { status: 'unread', timestamp: 1 })
    expect(getSessionSignal(SESSION)).toEqual({ kind: 'unknown' })
  })

  describe('a user Stop of an SDK session', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      seedSdkSession()
      startSessionSignalLatch()
    })

    it('reads the end that follows the Stop as a user interruption', () => {
      vi.setSystemTime(1_000)
      setStatus(SESSION, { status: 'working', timestamp: 1_000 })
      vi.setSystemTime(5_000)
      markSessionAborted(OPENCODE_SESSION)
      setStatus(SESSION, { status: 'completed', timestamp: 5_010, word: 'Stopped' })

      expect(getSessionSignal(SESSION)).toMatchObject({ kind: 'ended', reason: 'user_abort' })
    })

    it('keeps a reason the end already carries', () => {
      setStatus(SESSION, { status: 'working', timestamp: 1_000 })
      vi.setSystemTime(5_000)
      markSessionAborted(OPENCODE_SESSION)
      setStatus(SESSION, { status: 'completed', timestamp: 5_010, reason: 'pty_exit' })

      expect(getSessionSignal(SESSION)).toMatchObject({ reason: 'pty_exit' })
    })

    it('does not explain an end that came before the Stop', () => {
      setStatus(SESSION, { status: 'working', timestamp: 1_000 })
      setStatus(SESSION, { status: 'completed', timestamp: 2_000 })
      vi.setSystemTime(5_000)
      markSessionAborted(OPENCODE_SESSION)

      expect(getSessionSignal(SESSION)).toMatchObject({ kind: 'ended', reason: null })
    })

    it('forgets the Stop once the session worked again', () => {
      setStatus(SESSION, { status: 'working', timestamp: 1_000 })
      vi.setSystemTime(5_000)
      markSessionAborted(OPENCODE_SESSION)
      setStatus(SESSION, { status: 'completed', timestamp: 5_010 })
      setStatus(SESSION, { status: 'working', timestamp: 8_000 })
      setStatus(SESSION, { status: 'completed', timestamp: 9_000 })

      expect(getSessionSignal(SESSION)).toMatchObject({ kind: 'ended', at: 9_000, reason: null })
    })

    it('needs the session row to know the opencode session id', () => {
      useSessionStore.setState({ sessionsByWorktree: new Map() })
      vi.setSystemTime(5_000)
      markSessionAborted(OPENCODE_SESSION)
      setStatus(SESSION, { status: 'completed', timestamp: 5_010 })

      expect(getSessionSignal(SESSION)).toMatchObject({ kind: 'ended', reason: null })
    })
  })

  describe('the completed latch', () => {
    it('keeps a completed turn after the entry was nulled by opening the worktree', () => {
      startSessionSignalLatch()
      setStatus(SESSION, completed({ timestamp: 7 }))
      setStatus(SESSION, null)

      expect(getSessionSignal(SESSION)).toMatchObject({ kind: 'ended', at: 7 })
    })

    it('remembers a completed turn that was set before the latch started', () => {
      setStatus(SESSION, completed({ timestamp: 7 }))
      startSessionSignalLatch()
      setStatus(SESSION, null)

      expect(getSessionSignal(SESSION)).toMatchObject({ kind: 'ended', at: 7 })
    })

    it('forgets the turn once the session works again', () => {
      startSessionSignalLatch()
      setStatus(SESSION, completed({ timestamp: 7 }))
      setStatus(SESSION, { status: 'working', timestamp: 8 })
      setStatus(SESSION, null)

      expect(getSessionSignal(SESSION)).toEqual({ kind: 'unknown' })
    })

    it('forgets the turn once the session is blocked', () => {
      startSessionSignalLatch()
      setStatus(SESSION, completed({ timestamp: 7 }))
      setStatus(SESSION, { status: 'answering', timestamp: 8 })
      setStatus(SESSION, null)

      expect(getSessionSignal(SESSION)).toEqual({ kind: 'unknown' })
    })

    it('keeps the newest completed turn', () => {
      startSessionSignalLatch()
      setStatus(SESSION, completed({ timestamp: 7 }))
      setStatus(SESSION, { status: 'working', timestamp: 8 })
      setStatus(SESSION, completed({ timestamp: 9, completion: 'waiting' }))
      setStatus(SESSION, null)

      expect(getSessionSignal(SESSION)).toMatchObject({
        kind: 'ended',
        at: 9,
        completion: 'waiting'
      })
    })

    it('is cleared by the test reset', () => {
      startSessionSignalLatch()
      setStatus(SESSION, completed({ timestamp: 7 }))
      setStatus(SESSION, null)
      resetSessionSignalLatchForTests()

      expect(getSessionSignal(SESSION)).toEqual({ kind: 'unknown' })
    })
  })
})

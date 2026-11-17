import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockPerfSlow } = vi.hoisted(() => ({
  mockPerfSlow: vi.fn()
}))

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

vi.mock('../agent-event-bus', () => ({
  agentEventBus: { publish: vi.fn() }
}))

vi.mock('../codex-app-server-manager', () => ({
  CodexAppServerManager: class {
    on = vi.fn()
  }
}))

vi.mock('../notification-service', () => ({
  notificationService: {}
}))

vi.mock('../codex-session-title', () => ({
  generateCodexSessionTitle: vi.fn()
}))

vi.mock('../git-service', () => ({
  autoRenameWorktreeBranch: vi.fn()
}))

vi.mock('../perf-logging/perf-logger', () => ({
  perfLog: { slow: mockPerfSlow, mark: vi.fn(), registerGauge: vi.fn() }
}))

import { CodexImplementer, type CodexSessionState } from '../codex-implementer'

type PersistRow = { opencode_message_json: string; opencode_timeline_json: string }

type ImplInternals = {
  dbService: { replaceSessionMessages: ReturnType<typeof vi.fn> }
  persistCanonicalMessages: (session: CodexSessionState) => void
  persistCanonicalMessagesDebounced: (session: CodexSessionState) => void
  flushPendingPersist: (session: CodexSessionState) => void
  popLastExchange: (session: CodexSessionState) => string
  appendCanonicalAssistantText: (
    session: CodexSessionState,
    kind: 'text' | 'reasoning',
    text: string,
    turnId?: string
  ) => void
}

function createSession(overrides: Partial<CodexSessionState> = {}): CodexSessionState {
  return {
    threadId: 'thread-1',
    hiveSessionId: 'hive-session-1',
    worktreePath: '/repo',
    status: 'ready',
    messages: [],
    messagesDirty: false,
    pendingHitlRequestIds: new Set(),
    liveAssistantDraft: null,
    currentTurnId: null,
    currentAssistantMessageId: null,
    revertMessageID: null,
    revertDiff: null,
    titleGenerated: true,
    titleGenerationStarted: true,
    persistDebounceTimer: null,
    goalIdleFallbackTimer: null,
    ...overrides
  }
}

function setup(): { impl: ImplInternals; db: ImplInternals['dbService'] } {
  const impl = new CodexImplementer() as unknown as ImplInternals
  const db = { replaceSessionMessages: vi.fn() }
  impl.dbService = db
  return { impl, db }
}

const userMessage = {
  id: 'user-1',
  role: 'user',
  parts: [{ type: 'text', text: 'hello' }],
  timestamp: '2026-05-15T10:00:00.000Z'
}

describe('CodexImplementer canonical message persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('skips the DB rewrite when nothing changed between two flushes', () => {
    const { impl, db } = setup()
    const session = createSession({ messages: [userMessage], messagesDirty: true })

    impl.persistCanonicalMessages(session)
    impl.persistCanonicalMessages(session)

    expect(db.replaceSessionMessages).toHaveBeenCalledTimes(1)
    expect(session.messagesDirty).toBe(false)
  })

  it('does not persist a session that was never marked dirty', () => {
    const { impl, db } = setup()
    const session = createSession({ messages: [userMessage] })

    impl.persistCanonicalMessages(session)

    expect(db.replaceSessionMessages).not.toHaveBeenCalled()
  })

  it('persists exactly once more after a message is appended', () => {
    const { impl, db } = setup()
    const session = createSession({ messages: [userMessage], messagesDirty: true })
    impl.persistCanonicalMessages(session)
    expect(db.replaceSessionMessages).toHaveBeenCalledTimes(1)

    impl.appendCanonicalAssistantText(session, 'text', 'hi there', 'turn-1')
    expect(session.messagesDirty).toBe(true)

    impl.persistCanonicalMessages(session)
    impl.persistCanonicalMessages(session)

    expect(db.replaceSessionMessages).toHaveBeenCalledTimes(2)
    const rows = db.replaceSessionMessages.mock.calls[1][1] as Array<{
      role: string
      content: string
    }>
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({ role: 'assistant', content: 'hi there' })
  })

  it('writes the same canonical JSON to both message and timeline columns', () => {
    const { impl, db } = setup()
    const session = createSession({ messages: [userMessage], messagesDirty: true })

    impl.persistCanonicalMessages(session)

    const rows = db.replaceSessionMessages.mock.calls[0][1] as PersistRow[]
    expect(rows).toHaveLength(1)
    expect(rows[0].opencode_timeline_json).toBe(rows[0].opencode_message_json)
    expect(JSON.parse(rows[0].opencode_message_json)).toMatchObject({ id: 'user-1', role: 'user' })
  })

  it('keeps the session dirty when the DB write fails so the next flush retries', () => {
    const { impl, db } = setup()
    db.replaceSessionMessages.mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    const session = createSession({ messages: [userMessage], messagesDirty: true })

    impl.persistCanonicalMessages(session)
    expect(session.messagesDirty).toBe(true)

    impl.persistCanonicalMessages(session)
    expect(db.replaceSessionMessages).toHaveBeenCalledTimes(2)
    expect(session.messagesDirty).toBe(false)
  })

  it('reports persist duration through perfLog.slow', () => {
    const { impl } = setup()
    const session = createSession({ messages: [userMessage], messagesDirty: true })

    impl.persistCanonicalMessages(session)

    expect(mockPerfSlow).toHaveBeenCalledWith('codex-persist-messages', expect.any(Number), {
      count: 1
    })
  })

  it('debounced flush persists once per change and not again when idle', () => {
    vi.useFakeTimers()
    const { impl, db } = setup()
    const session = createSession()

    impl.appendCanonicalAssistantText(session, 'text', 'a', 'turn-1')
    impl.persistCanonicalMessagesDebounced(session)
    impl.appendCanonicalAssistantText(session, 'text', 'b', 'turn-1')
    impl.persistCanonicalMessagesDebounced(session)
    vi.advanceTimersByTime(2000)
    expect(db.replaceSessionMessages).toHaveBeenCalledTimes(1)

    // A new debounce cycle with no in-memory change must not rewrite the rows.
    impl.persistCanonicalMessagesDebounced(session)
    vi.advanceTimersByTime(2000)
    expect(db.replaceSessionMessages).toHaveBeenCalledTimes(1)

    // End-of-turn flush after a change still persists.
    impl.appendCanonicalAssistantText(session, 'text', 'c', 'turn-1')
    impl.persistCanonicalMessagesDebounced(session)
    impl.flushPendingPersist(session)
    expect(db.replaceSessionMessages).toHaveBeenCalledTimes(2)
    expect(session.persistDebounceTimer).toBeNull()
  })

  it('persists the shortened list once more after the undo path pops an exchange', () => {
    const { impl, db } = setup()
    const assistantMessage = {
      id: 'assistant-1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'hi' }],
      timestamp: '2026-05-15T10:00:01.000Z'
    }
    const session = createSession({
      messages: [userMessage, assistantMessage],
      messagesDirty: true
    })
    impl.persistCanonicalMessages(session)
    expect(db.replaceSessionMessages).toHaveBeenCalledTimes(1)

    expect(impl.popLastExchange(session)).toBe('revert-0')
    expect(session.messagesDirty).toBe(true)

    impl.persistCanonicalMessages(session)
    expect(db.replaceSessionMessages).toHaveBeenCalledTimes(2)
    const rows = db.replaceSessionMessages.mock.calls[1][1] as PersistRow[]
    expect(rows).toHaveLength(0)
  })

  it('does not mark the session dirty when undo has nothing to pop', () => {
    const { impl } = setup()
    const session = createSession()

    expect(impl.popLastExchange(session)).toBe('revert-0')
    expect(session.messagesDirty).toBe(false)
  })
})

const OLD_FOLDER = '/Users/me/hive-projects/app'
const NEW_FOLDER = '/Users/me/dev/app'

type ResumeInternals = {
  manager: ReturnType<typeof installManager>
  dbService: unknown
  sessions: Map<string, CodexSessionState>
  findSessionByThreadId: (threadId: string) => CodexSessionState | undefined
}

function installManager(impl: CodexImplementer) {
  const manager = {
    on: vi.fn(),
    startSession: vi.fn(async (options: { cwd: string; resumeThreadId?: string }) => ({
      provider: 'codex',
      status: 'ready',
      threadId: options.resumeThreadId ?? 'thread-new',
      cwd: options.cwd
    })),
    stopSession: vi.fn(),
    getSession: vi.fn(() => undefined),
    getThreadGoal: vi.fn(async () => null),
    readThread: vi.fn(async () => ({}))
  }
  ;(impl as unknown as { manager: typeof manager }).manager = manager
  return manager
}

function setupResume(): { impl: CodexImplementer; inner: ResumeInternals } {
  const impl = new CodexImplementer()
  installManager(impl)
  return { impl, inner: impl as unknown as ResumeInternals }
}

describe('CodexImplementer resume of a thread under another folder', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reconnect under another folder stops the helper started under the old one', async () => {
    const { impl, inner } = setupResume()

    expect((await impl.reconnect(OLD_FOLDER, 'thread-1', 'session-1')).success).toBe(true)
    expect((await impl.reconnect(NEW_FOLDER, 'thread-1', 'session-1')).success).toBe(true)

    const { startSession, stopSession } = inner.manager
    expect(stopSession).toHaveBeenCalledTimes(1)
    expect(stopSession).toHaveBeenCalledWith('thread-1')
    expect(startSession).toHaveBeenCalledTimes(2)
    expect(startSession.mock.calls[1][0]).toMatchObject({
      cwd: NEW_FOLDER,
      resumeThreadId: 'thread-1'
    })
    // The old helper is stopped while it is still the one the manager has for the thread.
    expect(stopSession.mock.invocationCallOrder[0]).toBeLessThan(
      startSession.mock.invocationCallOrder[1]
    )
    expect([...inner.sessions.keys()]).toEqual([`${NEW_FOLDER}::thread-1`])
    expect(inner.findSessionByThreadId('thread-1')?.worktreePath).toBe(NEW_FOLDER)
  })

  it('reading the messages under another folder stops the helper started under the old one', async () => {
    const { impl, inner } = setupResume()
    inner.sessions.set(`${OLD_FOLDER}::thread-1`, createSession({ worktreePath: OLD_FOLDER }))
    inner.dbService = {
      getSessionByOpenCodeSessionId: () => ({
        id: 'session-1',
        agent_sdk: 'codex',
        model_id: null
      }),
      getSessionMessages: () => []
    }

    await impl.getMessages(NEW_FOLDER, 'thread-1')

    const { startSession, stopSession } = inner.manager
    expect(stopSession).toHaveBeenCalledTimes(1)
    expect(stopSession).toHaveBeenCalledWith('thread-1')
    expect(startSession).toHaveBeenCalledTimes(1)
    expect(startSession.mock.calls[0][0]).toMatchObject({
      cwd: NEW_FOLDER,
      resumeThreadId: 'thread-1'
    })
    expect(stopSession.mock.invocationCallOrder[0]).toBeLessThan(
      startSession.mock.invocationCallOrder[0]
    )
    expect([...inner.sessions.keys()]).toEqual([`${NEW_FOLDER}::thread-1`])
    expect(inner.findSessionByThreadId('thread-1')?.worktreePath).toBe(NEW_FOLDER)
  })

  it('reconnects under the new folder when the old helper cannot be stopped', async () => {
    const { impl, inner } = setupResume()
    await impl.reconnect(OLD_FOLDER, 'thread-1', 'session-1')
    inner.manager.stopSession.mockImplementation(() => {
      throw new Error('kill failed')
    })

    const result = await impl.reconnect(NEW_FOLDER, 'thread-1', 'session-1')

    expect(result.success).toBe(true)
    expect(inner.manager.startSession).toHaveBeenCalledTimes(2)
    expect([...inner.sessions.keys()]).toEqual([`${NEW_FOLDER}::thread-1`])
    expect(inner.findSessionByThreadId('thread-1')?.worktreePath).toBe(NEW_FOLDER)
  })

  it('leaves a state under another folder that is in the middle of a turn', async () => {
    const { impl, inner } = setupResume()
    const running = createSession({ worktreePath: OLD_FOLDER, status: 'running' })
    inner.sessions.set(`${OLD_FOLDER}::thread-1`, running)

    const result = await impl.reconnect(NEW_FOLDER, 'thread-1', 'session-1')

    expect(result.success).toBe(true)
    expect(inner.manager.stopSession).not.toHaveBeenCalled()
    expect(inner.sessions.get(`${OLD_FOLDER}::thread-1`)).toBe(running)
    expect(inner.sessions.has(`${NEW_FOLDER}::thread-1`)).toBe(true)
  })

  it('leaves a state under another folder whose goal run waits for its next turn', async () => {
    vi.useFakeTimers()
    const { impl, inner } = setupResume()
    const betweenTurns = createSession({
      worktreePath: OLD_FOLDER,
      goalIdleFallbackTimer: setTimeout(() => {}, 60_000)
    })
    inner.sessions.set(`${OLD_FOLDER}::thread-1`, betweenTurns)

    const result = await impl.reconnect(NEW_FOLDER, 'thread-1', 'session-1')

    expect(result.success).toBe(true)
    expect(inner.manager.stopSession).not.toHaveBeenCalled()
    expect(inner.sessions.get(`${OLD_FOLDER}::thread-1`)).toBe(betweenTurns)
  })

  it('leaves the states of other threads and the state under the asked folder alone', async () => {
    const { impl, inner } = setupResume()
    const otherThread = createSession({ threadId: 'thread-2', worktreePath: OLD_FOLDER })
    inner.sessions.set(`${OLD_FOLDER}::thread-2`, otherThread)

    await impl.reconnect(NEW_FOLDER, 'thread-1', 'session-1')
    await impl.reconnect(NEW_FOLDER, 'thread-1', 'session-1')

    expect(inner.manager.stopSession).not.toHaveBeenCalled()
    expect(inner.manager.startSession).toHaveBeenCalledTimes(1)
    expect([...inner.sessions.keys()]).toEqual([
      `${OLD_FOLDER}::thread-2`,
      `${NEW_FOLDER}::thread-1`
    ])
  })
})

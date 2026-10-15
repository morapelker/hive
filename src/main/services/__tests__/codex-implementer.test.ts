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
    const rows = db.replaceSessionMessages.mock.calls[1][1] as Array<{ role: string; content: string }>
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

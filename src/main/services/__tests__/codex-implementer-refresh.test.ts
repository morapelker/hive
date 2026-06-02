import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

vi.mock('../agent-event-bus', () => ({
  agentEventBus: { publish: vi.fn() }
}))

vi.mock('../codex-app-server-manager', () => ({
  CodexAppServerManager: class {
    on = vi.fn()
    readThread = vi.fn()
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

import { CodexImplementer, type CodexSessionState } from '../codex-implementer'

type RefreshResult = { success: boolean; count?: number; error?: string }

function createSession(overrides: Partial<CodexSessionState> = {}): CodexSessionState {
  return {
    threadId: 'thread-1',
    hiveSessionId: 'hive-session-1',
    worktreePath: '/repo',
    status: 'ready',
    messages: [],
    pendingHitlRequestIds: new Set(),
    liveAssistantDraft: null,
    currentTurnId: null,
    currentAssistantMessageId: null,
    revertMessageID: null,
    revertDiff: null,
    titleGenerated: true,
    titleGenerationStarted: true,
    persistDebounceTimer: null,
    ...overrides
  }
}

function installSession(
  impl: CodexImplementer,
  session: CodexSessionState,
  agentSessionId = session.threadId
): void {
  ;(impl as unknown as { sessions: Map<string, CodexSessionState> }).sessions.set(
    `${session.worktreePath}::${agentSessionId}`,
    session
  )
}

function installDb(impl: CodexImplementer) {
  const db = {
    replaceSessionMessages: vi.fn(),
    deleteSessionActivities: vi.fn()
  }
  ;(impl as unknown as { dbService: typeof db }).dbService = db
  return db
}

function installManager(impl: CodexImplementer, readThread: () => Promise<unknown>): void {
  ;(impl as unknown as { manager: { readThread: () => Promise<unknown> } }).manager = {
    readThread
  }
}

async function refresh(impl: CodexImplementer): Promise<RefreshResult> {
  return (
    impl as unknown as {
      refreshMessagesFromThread: (
        worktreePath: string,
        agentSessionId: string
      ) => Promise<RefreshResult>
    }
  ).refreshMessagesFromThread('/repo', 'thread-1')
}

const snapshot = {
  thread: {
    turns: [
      {
        id: 'turn-1',
        createdAt: '2026-05-15T10:00:00.000Z',
        items: [
          {
            type: 'userMessage',
            id: 'user-item',
            content: [{ type: 'text', text: 'hello' }]
          },
          {
            type: 'agentMessage',
            id: 'agent-item',
            text: 'hi there'
          }
        ]
      }
    ]
  }
}

describe('CodexImplementer.refreshMessagesFromThread', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('replaces canonical messages and clears durable activities on success', async () => {
    const impl = new CodexImplementer()
    const session = createSession()
    installSession(impl, session)
    const db = installDb(impl)
    installManager(impl, vi.fn().mockResolvedValue(snapshot))

    const result = await refresh(impl)

    expect(result).toEqual({ success: true, count: 2 })
    expect(session.messages).toHaveLength(2)
    expect(db.replaceSessionMessages).toHaveBeenCalledWith(
      'hive-session-1',
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'hello' }),
        expect.objectContaining({ role: 'assistant', content: 'hi there' })
      ])
    )
    expect(db.deleteSessionActivities).toHaveBeenCalledWith('hive-session-1')
  })

  it('does not overwrite durable state for an empty snapshot', async () => {
    const impl = new CodexImplementer()
    installSession(impl, createSession())
    const db = installDb(impl)
    installManager(impl, vi.fn().mockResolvedValue({ thread: { turns: [] } }))

    const result = await refresh(impl)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/empty/i)
    expect(db.replaceSessionMessages).not.toHaveBeenCalled()
    expect(db.deleteSessionActivities).not.toHaveBeenCalled()
  })

  it('rejects sessions without a thread id', async () => {
    const impl = new CodexImplementer()
    installSession(impl, createSession({ threadId: null as unknown as string }), 'thread-1')
    const db = installDb(impl)
    installManager(impl, vi.fn().mockResolvedValue(snapshot))

    const result = await refresh(impl)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/thread/i)
    expect(db.replaceSessionMessages).not.toHaveBeenCalled()
    expect(db.deleteSessionActivities).not.toHaveBeenCalled()
  })

  it('rejects running sessions', async () => {
    const impl = new CodexImplementer()
    installSession(impl, createSession({ status: 'running' }))
    const db = installDb(impl)
    installManager(impl, vi.fn().mockResolvedValue(snapshot))

    const result = await refresh(impl)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/running/i)
    expect(db.replaceSessionMessages).not.toHaveBeenCalled()
    expect(db.deleteSessionActivities).not.toHaveBeenCalled()
  })

  it('returns failure when thread/read throws', async () => {
    const impl = new CodexImplementer()
    installSession(impl, createSession())
    const db = installDb(impl)
    installManager(impl, vi.fn().mockRejectedValue(new Error('thread read failed')))

    const result = await refresh(impl)

    expect(result.success).toBe(false)
    expect(result.error).toContain('thread read failed')
    expect(db.replaceSessionMessages).not.toHaveBeenCalled()
    expect(db.deleteSessionActivities).not.toHaveBeenCalled()
  })
})

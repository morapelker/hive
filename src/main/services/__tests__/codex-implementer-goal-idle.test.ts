import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockAgentPublish } = vi.hoisted(() => ({
  mockAgentPublish: vi.fn()
}))

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

vi.mock('../agent-event-bus', () => ({
  agentEventBus: { publish: mockAgentPublish }
}))

vi.mock('../codex-app-server-manager', () => ({
  CodexAppServerManager: class {
    on = vi.fn()
  }
}))

vi.mock('../notification-service', () => ({
  notificationService: { shouldNotifyWhenWindowUnfocused: vi.fn(() => false) }
}))

vi.mock('../codex-session-title', () => ({
  generateCodexSessionTitle: vi.fn()
}))

vi.mock('../git-service', () => ({
  autoRenameWorktreeBranch: vi.fn()
}))

vi.mock('../worktree-events', () => ({
  emitWorktreeBranchRenamed: vi.fn()
}))

import { CodexImplementer, type CodexSessionState } from '../codex-implementer'
import type { CodexManagerEvent, CodexProviderSession } from '../codex-app-server-manager'
import type { OpenCodeStreamEvent } from '@shared/types/opencode'

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
    goalIdleFallbackTimer: null,
    ...overrides
  }
}

function installSession(impl: CodexImplementer, session: CodexSessionState): void {
  ;(impl as unknown as { sessions: Map<string, CodexSessionState> }).sessions.set(
    `${session.worktreePath}::${session.threadId}`,
    session
  )
}

interface ManagerMock {
  session: Partial<CodexProviderSession>
  listeners: Array<(event: CodexManagerEvent) => void>
  sendTurn: ReturnType<typeof vi.fn>
}

function installManager(
  impl: CodexImplementer,
  session: Partial<CodexProviderSession>
): ManagerMock {
  const mock: ManagerMock = {
    session,
    listeners: [],
    sendTurn: vi.fn(async () => ({ turnId: 't1', threadId: 'thread-1' }))
  }
  ;(impl as unknown as { manager: unknown }).manager = {
    getSession: vi.fn(() => mock.session),
    on: vi.fn((_event: string, listener: (event: CodexManagerEvent) => void) => {
      mock.listeners.push(listener)
    }),
    removeListener: vi.fn(),
    sendTurn: mock.sendTurn
  }
  return mock
}

function makeManagerEvent(overrides: Partial<CodexManagerEvent> = {}): CodexManagerEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    kind: 'notification',
    provider: 'codex',
    threadId: 'thread-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    method: 'turn/completed',
    payload: { threadId: 'thread-1', turn: { id: 't1', status: 'completed' } },
    ...overrides
  }
}

function forward(impl: CodexImplementer, session: CodexSessionState, event: CodexManagerEvent): boolean {
  return (
    impl as unknown as {
      forwardAutonomousStreamEvent: (s: CodexSessionState, e: CodexManagerEvent) => boolean
    }
  ).forwardAutonomousStreamEvent(session, event)
}

function handleManagerEvent(impl: CodexImplementer, event: CodexManagerEvent): void {
  ;(impl as unknown as { handleManagerEvent: (e: CodexManagerEvent) => void }).handleManagerEvent(
    event
  )
}

const publishedEvents = (): OpenCodeStreamEvent[] =>
  mockAgentPublish.mock.calls.map(([event]) => event as OpenCodeStreamEvent)

const publishedStatuses = (type: string): OpenCodeStreamEvent[] =>
  publishedEvents().filter(
    (event) => event.type === 'session.status' && event.statusPayload?.type === type
  )

describe('CodexImplementer goal-aware idle suppression', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('forwards idle for an autonomous turn/completed when no goal is active', () => {
    const impl = new CodexImplementer()
    const session = createSession()
    installManager(impl, { status: 'ready', goalStatus: null })

    forward(impl, session, makeManagerEvent())

    expect(publishedStatuses('idle')).toHaveLength(1)
    expect(session.goalIdleFallbackTimer).toBeNull()
  })

  it('suppresses idle while a goal is active but still forwards usage, and arms the fallback', () => {
    const impl = new CodexImplementer()
    const session = createSession()
    installManager(impl, { status: 'ready', goalStatus: 'active' })

    forward(
      impl,
      session,
      makeManagerEvent({
        payload: {
          threadId: 'thread-1',
          turn: { id: 't1', status: 'completed' },
          usage: { inputTokens: 10, outputTokens: 5 }
        }
      })
    )

    expect(publishedStatuses('idle')).toHaveLength(0)
    expect(publishedEvents().some((event) => event.type === 'message.updated')).toBe(true)
    expect(session.goalIdleFallbackTimer).not.toBeNull()
  })

  it('does not suppress idle for a failed turn under an active goal', () => {
    const impl = new CodexImplementer()
    const session = createSession()
    installManager(impl, { status: 'ready', goalStatus: 'active' })

    forward(
      impl,
      session,
      makeManagerEvent({
        payload: {
          threadId: 'thread-1',
          turn: { id: 't1', status: 'failed', error: { message: 'boom' } }
        }
      })
    )

    expect(publishedEvents().some((event) => event.type === 'session.error')).toBe(true)
    expect(publishedStatuses('idle')).toHaveLength(1)
    expect(session.goalIdleFallbackTimer).toBeNull()
  })

  it('cancels the fallback when a continuation turn starts', () => {
    const impl = new CodexImplementer()
    const session = createSession()
    installManager(impl, { status: 'ready', goalStatus: 'active' })

    forward(impl, session, makeManagerEvent())
    expect(session.goalIdleFallbackTimer).not.toBeNull()

    forward(
      impl,
      session,
      makeManagerEvent({
        method: 'turn/started',
        payload: { threadId: 'thread-1', turn: { id: 't2', status: 'inProgress' } }
      })
    )

    expect(session.goalIdleFallbackTimer).toBeNull()
    expect(publishedStatuses('busy')).toHaveLength(1)

    vi.advanceTimersByTime(60_000)
    expect(publishedStatuses('idle')).toHaveLength(0)
  })

  it('emits idle from the fallback when no continuation turn arrives and the session is ready', () => {
    const impl = new CodexImplementer()
    const session = createSession()
    installManager(impl, { status: 'ready', goalStatus: 'active' })

    forward(impl, session, makeManagerEvent())
    expect(publishedStatuses('idle')).toHaveLength(0)

    vi.advanceTimersByTime(15_000)

    expect(publishedStatuses('idle')).toHaveLength(1)
    expect(session.status).toBe('ready')
  })

  it('does not emit idle from the fallback while the manager session is still running', () => {
    const impl = new CodexImplementer()
    const session = createSession()
    const manager = installManager(impl, { status: 'ready', goalStatus: 'active' })

    forward(impl, session, makeManagerEvent())
    manager.session = { status: 'running', goalStatus: 'active' }

    vi.advanceTimersByTime(60_000)

    expect(publishedStatuses('idle')).toHaveLength(0)
  })

  it('emits idle exactly once when a terminal goal update lands after a suppressed completion', () => {
    const impl = new CodexImplementer()
    const session = createSession()
    installSession(impl, session)
    installManager(impl, { status: 'ready', goalStatus: 'active' })

    forward(impl, session, makeManagerEvent())
    expect(publishedStatuses('idle')).toHaveLength(0)

    handleManagerEvent(
      impl,
      makeManagerEvent({
        method: 'thread/goal/updated',
        payload: {
          threadId: 'thread-1',
          turnId: 't1',
          goal: {
            threadId: 'thread-1',
            objective: 'ship it',
            status: 'complete',
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: 0,
            updatedAt: 0
          }
        }
      })
    )

    expect(publishedStatuses('idle')).toHaveLength(1)
    expect(session.goalIdleFallbackTimer).toBeNull()

    vi.advanceTimersByTime(60_000)
    expect(publishedStatuses('idle')).toHaveLength(1)
  })

  it('defers idle in the prompt path while a goal is active', async () => {
    const impl = new CodexImplementer()
    const session = createSession()
    installSession(impl, session)
    const manager = installManager(impl, { status: 'ready', goalStatus: 'active' })

    await (
      impl as unknown as {
        runUserTurn: (
          s: CodexSessionState,
          worktreePath: string,
          agentSessionId: string,
          text: string,
          turnInput: unknown[]
        ) => Promise<void>
      }
    ).runUserTurn(session, '/repo', 'thread-1', 'do it', [
      { type: 'text', text: 'do it', text_elements: [] }
    ])

    const completion = makeManagerEvent()
    for (const listener of [...manager.listeners]) {
      listener(completion)
    }
    await vi.advanceTimersByTimeAsync(0)

    expect(publishedStatuses('idle')).toHaveLength(0)
    expect(session.goalIdleFallbackTimer).not.toBeNull()
  })

  it('ignores a turn/completed whose payload belongs to another thread in the prompt path', async () => {
    const impl = new CodexImplementer()
    const session = createSession()
    installSession(impl, session)
    const manager = installManager(impl, { status: 'running', goalStatus: null })

    await (
      impl as unknown as {
        runUserTurn: (
          s: CodexSessionState,
          worktreePath: string,
          agentSessionId: string,
          text: string,
          turnInput: unknown[]
        ) => Promise<void>
      }
    ).runUserTurn(session, '/repo', 'thread-1', 'do it', [
      { type: 'text', text: 'do it', text_elements: [] }
    ])

    const foreignCompletion = makeManagerEvent({
      payload: { threadId: 'C-child', turn: { id: 'c1', status: 'completed' } }
    })
    for (const listener of [...manager.listeners]) {
      listener(foreignCompletion)
    }
    await vi.advanceTimersByTimeAsync(0)

    expect(publishedStatuses('idle')).toHaveLength(0)
    expect(session.status).toBe('running')

    const completion = makeManagerEvent()
    for (const listener of [...manager.listeners]) {
      listener(completion)
    }
    await vi.advanceTimersByTimeAsync(0)

    expect(publishedStatuses('idle')).toHaveLength(1)
  })

  it('emits idle in the prompt path when no goal is active', async () => {
    const impl = new CodexImplementer()
    const session = createSession()
    installSession(impl, session)
    const manager = installManager(impl, { status: 'ready', goalStatus: null })

    await (
      impl as unknown as {
        runUserTurn: (
          s: CodexSessionState,
          worktreePath: string,
          agentSessionId: string,
          text: string,
          turnInput: unknown[]
        ) => Promise<void>
      }
    ).runUserTurn(session, '/repo', 'thread-1', 'do it', [
      { type: 'text', text: 'do it', text_elements: [] }
    ])

    const completion = makeManagerEvent()
    for (const listener of [...manager.listeners]) {
      listener(completion)
    }
    await vi.advanceTimersByTimeAsync(0)

    expect(publishedStatuses('idle')).toHaveLength(1)
  })
})

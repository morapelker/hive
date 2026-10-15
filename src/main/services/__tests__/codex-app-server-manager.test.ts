import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import type { ChildProcess } from 'node:child_process'
import type readline from 'node:readline'
import {
  CodexAppServerManager,
  type CodexManagerEvent,
  type CodexProviderSession,
  type CodexSessionContext
} from '../codex-app-server-manager'
import { perfLog } from '../perf-logging/perf-logger'

function createContext(overrides: Partial<CodexProviderSession> = {}): CodexSessionContext {
  return {
    session: {
      provider: 'codex',
      status: 'ready',
      threadId: 'T',
      cwd: '/repo',
      model: null,
      activeTurnId: null,
      resumeCursor: 'T',
      goalStatus: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides
    },
    child: {} as ChildProcess,
    output: {} as readline.Interface,
    pending: new Map(),
    pendingApprovals: new Map(),
    pendingUserInputs: new Map(),
    collabReceiverTurns: new Map(),
    nextRequestId: 1,
    stopping: false
  }
}

function notify(
  manager: CodexAppServerManager,
  context: CodexSessionContext,
  method: string,
  params: Record<string, unknown>
): void {
  manager.handleStdoutLine(context, JSON.stringify({ jsonrpc: '2.0', method, params }))
}

describe('CodexAppServerManager turn lifecycle guards', () => {
  let manager: CodexAppServerManager
  let context: CodexSessionContext
  let events: CodexManagerEvent[]

  const eventsFor = (method: string): CodexManagerEvent[] =>
    events.filter((event) => event.method === method)

  beforeEach(() => {
    manager = new CodexAppServerManager()
    context = createContext()
    events = []
    manager.on('event', (event) => events.push(event))
  })

  it('marks the session ready on the active turn matching turn/completed', () => {
    notify(manager, context, 'turn/started', { threadId: 'T', turn: { id: 't1', status: 'inProgress' } })
    expect(context.session.status).toBe('running')
    expect(context.session.activeTurnId).toBe('t1')

    notify(manager, context, 'turn/completed', { threadId: 'T', turn: { id: 't1', status: 'completed' } })
    expect(context.session.status).toBe('ready')
    expect(context.session.activeTurnId).toBeNull()
    expect(eventsFor('turn/completed')).toHaveLength(1)
  })

  it('ignores turn/completed from an unregistered child thread', () => {
    notify(manager, context, 'turn/started', { threadId: 'T', turn: { id: 't1', status: 'inProgress' } })

    notify(manager, context, 'turn/completed', {
      threadId: 'C-unregistered',
      turn: { id: 'c9', status: 'completed' }
    })

    expect(context.session.status).toBe('running')
    expect(context.session.activeTurnId).toBe('t1')
    expect(eventsFor('turn/completed')).toHaveLength(0)
  })

  it('ignores turn/started from an unregistered child thread', () => {
    notify(manager, context, 'turn/started', { threadId: 'C-unregistered', turn: { id: 'c1', status: 'inProgress' } })

    expect(context.session.status).toBe('ready')
    expect(context.session.activeTurnId).toBeNull()
    expect(eventsFor('turn/started')).toHaveLength(0)
  })

  it('still suppresses turn/completed from a registered collab child thread', () => {
    notify(manager, context, 'turn/started', { threadId: 'T', turn: { id: 't1', status: 'inProgress' } })
    notify(manager, context, 'item/started', {
      threadId: 'T',
      turnId: 't1',
      item: { id: 'i1', type: 'collabAgentToolCall', receiverThreadIds: ['C'] }
    })

    notify(manager, context, 'turn/completed', { threadId: 'C', turn: { id: 'c9', status: 'completed' } })

    expect(context.session.status).toBe('running')
    expect(context.session.activeTurnId).toBe('t1')
    expect(eventsFor('turn/completed')).toHaveLength(0)
  })

  it('drops a stale turn/completed whose turn id does not match the active turn', () => {
    notify(manager, context, 'turn/started', { threadId: 'T', turn: { id: 't2', status: 'inProgress' } })

    notify(manager, context, 'turn/completed', { threadId: 'T', turn: { id: 't1', status: 'completed' } })
    expect(context.session.status).toBe('running')
    expect(context.session.activeTurnId).toBe('t2')
    expect(eventsFor('turn/completed')).toHaveLength(0)

    notify(manager, context, 'turn/completed', { threadId: 'T', turn: { id: 't2', status: 'completed' } })
    expect(context.session.status).toBe('ready')
    expect(context.session.activeTurnId).toBeNull()
    expect(eventsFor('turn/completed')).toHaveLength(1)
  })

  it('accepts turn/completed when no active turn is tracked (interrupt flow)', () => {
    context = createContext({ status: 'running', activeTurnId: null })

    notify(manager, context, 'turn/completed', { threadId: 'T', turn: { id: 't1', status: 'interrupted' } })

    expect(context.session.status).toBe('ready')
    expect(eventsFor('turn/completed')).toHaveLength(1)
  })

  it('marks the session as error on a matching failed turn/completed', () => {
    notify(manager, context, 'turn/started', { threadId: 'T', turn: { id: 't1', status: 'inProgress' } })

    notify(manager, context, 'turn/completed', { threadId: 'T', turn: { id: 't1', status: 'failed' } })

    expect(context.session.status).toBe('error')
    expect(context.session.activeTurnId).toBeNull()
    expect(eventsFor('turn/completed')).toHaveLength(1)
  })

  it('tracks goal status from thread/goal/updated and clears it on thread/goal/cleared', () => {
    notify(manager, context, 'thread/goal/updated', {
      threadId: 'T',
      turnId: 't1',
      goal: {
        threadId: 'T',
        objective: 'ship it',
        status: 'active',
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 0,
        updatedAt: 0
      }
    })

    expect(context.session.goalStatus).toBe('active')
    expect(eventsFor('thread/goal/updated')).toHaveLength(1)

    notify(manager, context, 'thread/goal/cleared', { threadId: 'T' })
    expect(context.session.goalStatus).toBeNull()
  })

  it('ignores goal updates from foreign threads', () => {
    notify(manager, context, 'thread/goal/updated', {
      threadId: 'C-foreign',
      turnId: null,
      goal: {
        threadId: 'C-foreign',
        objective: 'child goal',
        status: 'active',
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 0,
        updatedAt: 0
      }
    })

    expect(context.session.goalStatus).toBeNull()
  })

  it('tracks goal status through the thread goal RPC helpers', async () => {
    ;(manager as unknown as { sessions: Map<string, CodexSessionContext> }).sessions.set(
      'T',
      context
    )
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce({ goal: { status: 'active' } })
      .mockResolvedValueOnce({ goal: { status: 'complete' } })
      .mockResolvedValueOnce({ cleared: true })
    ;(manager as unknown as { sendRequest: typeof sendRequest }).sendRequest = sendRequest

    await manager.setThreadGoal('T', { objective: 'ship it' })
    expect(context.session.goalStatus).toBe('active')

    await manager.getThreadGoal('T')
    expect(context.session.goalStatus).toBe('complete')

    await manager.clearThreadGoal('T')
    expect(context.session.goalStatus).toBeNull()
  })

  it('still forwards non-lifecycle notifications from foreign threads, stamped as child events', () => {
    notify(manager, context, 'turn/started', { threadId: 'T', turn: { id: 't1', status: 'inProgress' } })

    notify(manager, context, 'item/agentMessage/delta', { threadId: 'C', itemId: 'i1', delta: 'hi' })

    const deltas = eventsFor('item/agentMessage/delta')
    expect(deltas).toHaveLength(1)
    expect(deltas[0].childThreadId).toBe('C')
    expect(context.session.status).toBe('running')
  })
})

describe('CodexAppServerManager request timeouts', () => {
  let manager: CodexAppServerManager
  let context: CodexSessionContext

  beforeEach(() => {
    vi.useFakeTimers()
    manager = new CodexAppServerManager()
    context = createContext()
    ;(manager as unknown as { writeMessage: () => void }).writeMessage = vi.fn()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const settle = (promise: Promise<unknown>): { rejected: () => Error | null } => {
    let error: Error | null = null
    promise.catch((cause: Error) => {
      error = cause
    })
    return { rejected: () => error }
  }

  it('gives thread/start a 60 s budget and records a perf record on timeout', async () => {
    const slow = vi.spyOn(perfLog, 'slow')
    const request = settle(manager.sendRequest(context, 'thread/start', {}))

    await vi.advanceTimersByTimeAsync(20_000)
    expect(request.rejected()).toBeNull()
    expect(context.pending.size).toBe(1)
    expect(context.pending.get('1')?.startedAt).toBeTypeOf('number')

    await vi.advanceTimersByTimeAsync(40_000)
    expect(request.rejected()?.message).toBe('Timed out waiting for thread/start.')
    expect(context.pending.size).toBe(0)
    expect(slow).toHaveBeenCalledWith('codex-rpc-timeout', 60_000, { method: 'thread/start' })
  })

  it('keeps 20 s for other methods and honours an explicit override', async () => {
    const generic = settle(manager.sendRequest(context, 'turn/start', {}))
    const explicit = settle(manager.sendRequest(context, 'thread/resume', {}, 1_000))

    await vi.advanceTimersByTimeAsync(1_000)
    expect(explicit.rejected()?.message).toBe('Timed out waiting for thread/resume.')
    expect(generic.rejected()).toBeNull()

    await vi.advanceTimersByTimeAsync(19_000)
    expect(generic.rejected()?.message).toBe('Timed out waiting for turn/start.')
  })
})

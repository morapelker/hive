import type { ChildProcess } from 'node:child_process'
import type readline from 'node:readline'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

vi.mock('../codex-debug-logger', () => ({
  logCodexMessage: vi.fn(),
  logCodexLifecycleEvent: vi.fn(),
  resetSession: vi.fn()
}))

import { CodexAppServerManager, type CodexSessionContext } from '../codex-app-server-manager'

const PARENT_THREAD_ID = 'thread-parent'
const PARENT_TURN_ID = 'turn-1'

interface OutgoingMessage {
  jsonrpc: string
  id?: number
  method?: string
  params?: Record<string, unknown>
}

interface Harness {
  manager: CodexAppServerManager
  context: CodexSessionContext
  written: OutgoingMessage[]
  /** Called for every outgoing request; return false to skip the default ok-response. */
  onRequest: (handler: (msg: OutgoingMessage) => boolean | void) => void
  notify: (method: string, params: Record<string, unknown>) => void
  respond: (msg: OutgoingMessage, result?: unknown) => void
  respondError: (msg: OutgoingMessage, message: string) => void
  interrupts: () => Array<{ threadId: string; turnId: string }>
}

function createHarness(): Harness {
  const manager = new CodexAppServerManager()
  const written: OutgoingMessage[] = []
  const handlers: Array<(msg: OutgoingMessage) => boolean | void> = []

  const child = {
    killed: false,
    stdin: {
      writable: true,
      write: (line: string): boolean => {
        const msg = JSON.parse(line) as OutgoingMessage
        written.push(msg)
        // Defer so the promise machinery in sendRequest settles like real IO.
        queueMicrotask(() => {
          for (const handler of handlers) {
            if (handler(msg) === false) return
          }
          respond(msg)
        })
        return true
      }
    }
  }

  const context: CodexSessionContext = {
    session: {
      provider: 'codex',
      status: 'running',
      threadId: PARENT_THREAD_ID,
      cwd: '/repo',
      model: null,
      activeTurnId: PARENT_TURN_ID,
      resumeCursor: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    child: child as unknown as ChildProcess,
    output: { close: vi.fn() } as unknown as readline.Interface,
    pending: new Map(),
    pendingApprovals: new Map(),
    pendingUserInputs: new Map(),
    collabReceiverTurns: new Map(),
    subagentThreadIds: new Set(),
    nextRequestId: 1,
    stopping: false,
    abortRequested: false,
    abortReinterruptsRemaining: 0
  }

  ;(manager as unknown as { sessions: Map<string, CodexSessionContext> }).sessions.set(
    PARENT_THREAD_ID,
    context
  )

  function respond(msg: OutgoingMessage, result: unknown = {}): void {
    if (msg.id === undefined) return
    manager.handleStdoutLine(context, JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
  }

  function respondError(msg: OutgoingMessage, message: string): void {
    if (msg.id === undefined) return
    manager.handleStdoutLine(
      context,
      JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32600, message } })
    )
  }

  function notify(method: string, params: Record<string, unknown>): void {
    manager.handleStdoutLine(context, JSON.stringify({ jsonrpc: '2.0', method, params }))
  }

  return {
    manager,
    context,
    written,
    onRequest: (handler) => handlers.push(handler),
    notify,
    respond,
    respondError,
    interrupts: () =>
      written
        .filter((msg) => msg.method === 'turn/interrupt')
        .map((msg) => msg.params as { threadId: string; turnId: string })
  }
}

function registerCollabChildren(harness: Harness, childThreadIds: string[]): void {
  harness.notify('item/started', {
    threadId: PARENT_THREAD_ID,
    turnId: PARENT_TURN_ID,
    item: {
      id: 'item-collab-1',
      type: 'collabAgentToolCall',
      receiverThreadIds: childThreadIds
    }
  })
}

describe('CodexAppServerManager abort', () => {
  it('interrupts the parent turn and every known subagent thread', async () => {
    const harness = createHarness()
    registerCollabChildren(harness, ['child-1', 'child-2'])

    await harness.manager.interruptTurn(PARENT_THREAD_ID)

    expect(harness.interrupts()).toEqual([
      { threadId: PARENT_THREAD_ID, turnId: PARENT_TURN_ID },
      { threadId: 'child-1', turnId: '' },
      { threadId: 'child-2', turnId: '' }
    ])
    expect(harness.context.session.status).toBe('ready')
    expect(harness.context.session.activeTurnId).toBeNull()
    expect(harness.context.abortRequested).toBe(true)
  })

  it('still interrupts subagents when the collab map is cleared mid-abort', async () => {
    const harness = createHarness()
    registerCollabChildren(harness, ['child-1'])

    harness.onRequest((msg) => {
      if (msg.method === 'turn/interrupt' && msg.params?.threadId === PARENT_THREAD_ID) {
        // A non-interrupted turn/completed clears collabReceiverTurns before
        // the deferred interrupt response resolves.
        harness.notify('turn/completed', {
          threadId: PARENT_THREAD_ID,
          turn: { id: PARENT_TURN_ID, status: 'completed' }
        })
      }
    })

    await harness.manager.interruptTurn(PARENT_THREAD_ID)

    expect(harness.context.collabReceiverTurns.size).toBe(0)
    expect(harness.interrupts()).toContainEqual({ threadId: 'child-1', turnId: '' })
  })

  it('interrupts subagents even when the parent interrupt fails', async () => {
    const harness = createHarness()
    registerCollabChildren(harness, ['child-1', 'child-2'])

    harness.onRequest((msg) => {
      if (msg.method === 'turn/interrupt' && msg.params?.threadId === PARENT_THREAD_ID) {
        harness.respondError(msg, 'no active turn to interrupt')
        return false
      }
      return undefined
    })

    await expect(harness.manager.interruptTurn(PARENT_THREAD_ID)).resolves.toBeUndefined()

    expect(harness.interrupts().slice(1)).toEqual([
      { threadId: 'child-1', turnId: '' },
      { threadId: 'child-2', turnId: '' }
    ])
    expect(harness.context.session.status).toBe('ready')
  })

  it('tolerates individual subagent interrupt failures', async () => {
    const harness = createHarness()
    registerCollabChildren(harness, ['child-1', 'child-2'])

    harness.onRequest((msg) => {
      if (msg.method === 'turn/interrupt' && msg.params?.threadId === 'child-1') {
        harness.respondError(msg, 'no active turn to interrupt')
        return false
      }
      return undefined
    })

    await expect(harness.manager.interruptTurn(PARENT_THREAD_ID)).resolves.toBeUndefined()
    expect(harness.interrupts()).toHaveLength(3)
  })

  it('re-interrupts turns that start while an abort is in flight', async () => {
    const harness = createHarness()
    await harness.manager.interruptTurn(PARENT_THREAD_ID)
    harness.written.length = 0

    // A subagent thread we never saw in a collab item restarts from queued mail.
    harness.notify('turn/started', { threadId: 'child-9', turn: { id: 'turn-9' } })
    // The parent thread restarts too.
    harness.notify('turn/started', { threadId: PARENT_THREAD_ID, turn: { id: 'turn-2' } })
    await vi.waitFor(() => expect(harness.interrupts()).toHaveLength(2))

    expect(harness.interrupts()).toEqual([
      { threadId: 'child-9', turnId: 'turn-9' },
      { threadId: PARENT_THREAD_ID, turnId: 'turn-2' }
    ])
    // The restarted parent turn must not revive the session.
    expect(harness.context.session.status).toBe('ready')
    expect(harness.context.session.activeTurnId).toBeNull()
  })

  it('caps post-abort re-interrupts', async () => {
    const harness = createHarness()
    await harness.manager.interruptTurn(PARENT_THREAD_ID)
    harness.written.length = 0
    harness.context.abortReinterruptsRemaining = 2

    for (let i = 0; i < 4; i += 1) {
      harness.notify('turn/started', { threadId: `child-${i}`, turn: { id: `turn-${i}` } })
    }
    await vi.waitFor(() => expect(harness.interrupts()).toHaveLength(2))

    expect(harness.context.abortReinterruptsRemaining).toBe(0)
  })

  it('does not re-interrupt turns once a new prompt is sent', async () => {
    const harness = createHarness()
    registerCollabChildren(harness, ['child-1'])
    await harness.manager.interruptTurn(PARENT_THREAD_ID)
    expect(harness.context.abortRequested).toBe(true)

    harness.onRequest((msg) => {
      if (msg.method === 'turn/start') {
        harness.respond(msg, { turn: { id: 'turn-2' } })
        return false
      }
      return undefined
    })
    await harness.manager.sendTurn(PARENT_THREAD_ID, { text: 'go again' })

    expect(harness.context.abortRequested).toBe(false)
    expect(harness.context.abortReinterruptsRemaining).toBe(0)
    expect(harness.context.collabReceiverTurns.size).toBe(0)

    harness.written.length = 0
    harness.notify('turn/started', { threadId: PARENT_THREAD_ID, turn: { id: 'turn-2' } })
    expect(harness.interrupts()).toHaveLength(0)
    expect(harness.context.session.status).toBe('running')
  })

  // Newer codex builds emit collab items with empty receiverThreadIds; child
  // threads are only recognizable by their thread id differing from the root.
  it('detects subagent threads by thread id when receiverThreadIds is empty', async () => {
    const harness = createHarness()

    harness.notify('turn/started', { threadId: 'child-a', turn: { id: 'turn-a' } })
    harness.notify('turn/started', { threadId: 'child-b', turn: { id: 'turn-b' } })

    // Child turn lifecycle must not clobber the parent session state.
    expect(harness.context.session.activeTurnId).toBe(PARENT_TURN_ID)
    expect(harness.context.session.status).toBe('running')

    await harness.manager.interruptTurn(PARENT_THREAD_ID)

    expect(harness.interrupts()).toEqual([
      { threadId: PARENT_THREAD_ID, turnId: PARENT_TURN_ID },
      { threadId: 'child-a', turnId: '' },
      { threadId: 'child-b', turnId: '' }
    ])
  })

  it('does not let subagent turn completions flip the parent session state', async () => {
    const harness = createHarness()

    harness.notify('turn/started', { threadId: 'child-a', turn: { id: 'turn-a' } })
    harness.notify('turn/completed', {
      threadId: 'child-a',
      turn: { id: 'turn-a', status: 'failed' }
    })

    expect(harness.context.session.status).toBe('running')
    expect(harness.context.session.activeTurnId).toBe(PARENT_TURN_ID)
  })

  it('keeps suppressing straggler subagent notifications after an abort', async () => {
    const harness = createHarness()
    registerCollabChildren(harness, ['child-1'])

    await harness.manager.interruptTurn(PARENT_THREAD_ID)

    // Parent turn reports interrupted — the collab map must survive.
    harness.notify('turn/completed', {
      threadId: PARENT_THREAD_ID,
      turn: { id: PARENT_TURN_ID, status: 'interrupted' }
    })
    expect(harness.context.collabReceiverTurns.size).toBe(1)

    // A straggler child failure must not flip the parent session to error.
    harness.notify('turn/completed', {
      threadId: 'child-1',
      turn: { id: 'child-turn-1', status: 'failed' }
    })
    expect(harness.context.session.status).toBe('ready')
  })
})

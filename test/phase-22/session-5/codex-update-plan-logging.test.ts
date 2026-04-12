/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const debugLoggerMocks = vi.hoisted(() => ({
  logCodexMessage: vi.fn(),
  logCodexLifecycleEvent: vi.fn(),
  resetSession: vi.fn()
}))

vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    spawn: vi.fn(),
    spawnSync: vi.fn()
  }
})

vi.mock('../../../src/main/services/codex-debug-logger', () => ({
  logCodexMessage: debugLoggerMocks.logCodexMessage,
  logCodexLifecycleEvent: debugLoggerMocks.logCodexLifecycleEvent,
  resetSession: debugLoggerMocks.resetSession,
  configure: vi.fn()
}))

import {
  CodexAppServerManager,
  type CodexProviderSession,
  type CodexSessionContext
} from '../../../src/main/services/codex-app-server-manager'

function createTestContext(overrides?: Partial<CodexProviderSession>): {
  context: CodexSessionContext
  stdin: { write: ReturnType<typeof vi.fn>; writable: boolean }
} {
  const stdin = { write: vi.fn(), writable: true }

  const child = {
    stdin,
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    pid: 12345,
    killed: false,
    kill: vi.fn(),
    on: vi.fn()
  } as any

  const output = {
    on: vi.fn(),
    close: vi.fn(),
    removeAllListeners: vi.fn()
  } as any

  const session: CodexProviderSession = {
    provider: 'codex',
    status: 'ready',
    threadId: 'thread-123',
    cwd: '/test/project',
    model: 'gpt-5.4',
    activeTurnId: null,
    resumeCursor: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  }

  const context: CodexSessionContext = {
    session,
    child,
    output,
    pending: new Map(),
    pendingApprovals: new Map(),
    pendingUserInputs: new Map(),
    collabReceiverTurns: new Map(),
    nextRequestId: 1,
    stopping: false
  }

  return { context, stdin }
}

describe('Codex update_plan logging boundaries', () => {
  let manager: CodexAppServerManager

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new CodexAppServerManager()
  })

  afterEach(() => {
    manager.stopAll()
    manager.removeAllListeners()
  })

  it('logs outgoing turn/start requests that expose update_plan guidance', async () => {
    const { context, stdin } = createTestContext()
    ;((manager as any).sessions as Map<string, CodexSessionContext>).set('thread-123', context)

    const turnPromise = manager.sendTurn('thread-123', {
      text: 'do the thing',
      model: 'gpt-5.4',
      interactionMode: 'default'
    })

    const messages = stdin.write.mock.calls.map((call: any[]) =>
      JSON.parse((call[0] as string).trim())
    )
    const turnStartMsg = messages.find((message: any) => message.method === 'turn/start')
    expect(turnStartMsg).toBeDefined()
    expect(debugLoggerMocks.logCodexMessage).toHaveBeenCalledWith('outgoing', turnStartMsg)

    manager.handleStdoutLine(
      context,
      JSON.stringify({ id: turnStartMsg.id, result: { turn: { id: 'turn-123' } } })
    )

    await turnPromise
  })

  it('logs incoming turn/plan/updated notifications to codex.jsonl', () => {
    const { context } = createTestContext()

    const notification = {
      method: 'turn/plan/updated',
      params: {
        threadId: 'thread-123',
        turnId: 'turn-123',
        explanation: 'Tracking progress',
        plan: [{ step: 'Map plan updates', status: 'inProgress' }]
      }
    }

    manager.handleStdoutLine(context, JSON.stringify(notification))

    expect(debugLoggerMocks.logCodexMessage).toHaveBeenCalledWith('incoming', notification)
  })
})

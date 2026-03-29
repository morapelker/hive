/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock logger
vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

// Mock child_process
vi.mock('node:child_process', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    spawn: vi.fn(),
    spawnSync: vi.fn()
  }
})

import {
  CodexAppServerManager,
  type CodexSessionContext,
  type CodexProviderSession
} from '../../../src/main/services/codex-app-server-manager'

// ── Helper: create a test session context ───────────────────────────

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
    nextRequestId: 1,
    stopping: false
  }

  return { context, stdin }
}

// ── Tests ───────────────────────────────────────────────────────────

describe('CodexAppServerManager — collaborationMode in sendTurn', () => {
  let manager: CodexAppServerManager

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new CodexAppServerManager()
  })

  afterEach(() => {
    manager.stopAll()
    manager.removeAllListeners()
  })

  function seedSession(context: CodexSessionContext): void {
    const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
    sessionsMap.set(context.session.threadId!, context)
  }

  function getWrittenMessages(stdin: { write: ReturnType<typeof vi.fn> }): any[] {
    return stdin.write.mock.calls.map((call: any[]) => JSON.parse((call[0] as string).trim()))
  }

  function getTurnStartParams(messages: any[]): any {
    const msg = messages.find((m: any) => m.method === 'turn/start')
    return msg?.params ?? null
  }

  it('includes collaborationMode with mode: plan and plan developer instructions when interactionMode is plan', async () => {
    const { context, stdin } = createTestContext()
    seedSession(context)

    // Start the sendTurn call — it will await a response
    const turnPromise = manager.sendTurn('thread-123', {
      text: 'plan my task',
      model: 'gpt-5.4',
      interactionMode: 'plan'
    })

    // Resolve the pending request by simulating a turn/start response
    const messages = getWrittenMessages(stdin)
    const turnStartMsg = messages.find((m: any) => m.method === 'turn/start')
    expect(turnStartMsg).toBeDefined()

    manager.handleStdoutLine(
      context,
      JSON.stringify({ id: turnStartMsg.id, result: { turn: { id: 'turn-abc' } } })
    )

    await turnPromise

    const params = getTurnStartParams(messages)
    expect(params).not.toBeNull()
    expect(params.collaborationMode).toBeDefined()
    expect(params.collaborationMode.mode).toBe('plan')
    expect(params.collaborationMode.settings).toBeDefined()
    expect(params.collaborationMode.settings.developer_instructions).toContain('plan')
    expect(params.collaborationMode.settings.developer_instructions).toContain(
      'Writing, editing, or deleting files'
    )
    expect(params.collaborationMode.settings.developer_instructions).toContain(
      'Stop after producing the plan block'
    )
  })

  it('includes collaborationMode with mode: default and default developer instructions when interactionMode is default', async () => {
    const { context, stdin } = createTestContext()
    seedSession(context)

    const turnPromise = manager.sendTurn('thread-123', {
      text: 'do the thing',
      model: 'gpt-5.4',
      interactionMode: 'default'
    })

    const messages = getWrittenMessages(stdin)
    const turnStartMsg = messages.find((m: any) => m.method === 'turn/start')
    expect(turnStartMsg).toBeDefined()

    manager.handleStdoutLine(
      context,
      JSON.stringify({ id: turnStartMsg.id, result: { turn: { id: 'turn-def' } } })
    )

    await turnPromise

    const params = getTurnStartParams(messages)
    expect(params).not.toBeNull()
    expect(params.collaborationMode).toBeDefined()
    expect(params.collaborationMode.mode).toBe('default')
    expect(params.collaborationMode.settings).toBeDefined()
    expect(params.collaborationMode.settings.developer_instructions).toContain('default')
  })

  it('does not include collaborationMode when interactionMode is not provided', async () => {
    const { context, stdin } = createTestContext()
    seedSession(context)

    const turnPromise = manager.sendTurn('thread-123', {
      text: 'hello',
      model: 'gpt-5.4'
    })

    const messages = getWrittenMessages(stdin)
    const turnStartMsg = messages.find((m: any) => m.method === 'turn/start')
    expect(turnStartMsg).toBeDefined()

    manager.handleStdoutLine(
      context,
      JSON.stringify({ id: turnStartMsg.id, result: { turn: { id: 'turn-xyz' } } })
    )

    await turnPromise

    const params = getTurnStartParams(messages)
    expect(params).not.toBeNull()
    expect(params.collaborationMode).toBeUndefined()
  })

  it('collaborationMode.settings.model matches the provided model', async () => {
    const { context, stdin } = createTestContext({ model: 'gpt-5.4' })
    seedSession(context)

    const turnPromise = manager.sendTurn('thread-123', {
      text: 'plan it',
      model: 'o4-mini',
      interactionMode: 'plan'
    })

    const messages = getWrittenMessages(stdin)
    const turnStartMsg = messages.find((m: any) => m.method === 'turn/start')

    manager.handleStdoutLine(
      context,
      JSON.stringify({ id: turnStartMsg.id, result: { turn: { id: 'turn-model' } } })
    )

    await turnPromise

    const params = getTurnStartParams(messages)
    expect(params.collaborationMode.settings.model).toBe('o4-mini')
  })

  it('collaborationMode.settings.reasoning_effort defaults to medium when not provided', async () => {
    const { context, stdin } = createTestContext()
    seedSession(context)

    const turnPromise = manager.sendTurn('thread-123', {
      text: 'plan it',
      model: 'gpt-5.4',
      interactionMode: 'plan'
    })

    const messages = getWrittenMessages(stdin)
    const turnStartMsg = messages.find((m: any) => m.method === 'turn/start')

    manager.handleStdoutLine(
      context,
      JSON.stringify({ id: turnStartMsg.id, result: { turn: { id: 'turn-effort' } } })
    )

    await turnPromise

    const params = getTurnStartParams(messages)
    expect(params.collaborationMode.settings.reasoning_effort).toBe('medium')
  })

  it('includes custom developer instructions and multi-part input for title generation', async () => {
    const { context, stdin } = createTestContext()
    seedSession(context)

    const turnPromise = manager.sendTurn('thread-123', {
      text: 'fast please',
      model: 'gpt-5.4',
      serviceTier: 'fast'
    })

    const messages = getWrittenMessages(stdin)
    const turnStartMsg = messages.find((m: any) => m.method === 'turn/start')

    manager.handleStdoutLine(
      context,
      JSON.stringify({ id: turnStartMsg.id, result: { turn: { id: 'turn-fast' } } })
    )

    await turnPromise

    const params = getTurnStartParams(messages)
    expect(params.serviceTier).toBe('fast')
  })

  it('includes custom developer instructions and multi-part input for title generation', async () => {
    const { context, stdin } = createTestContext()
    seedSession(context)

    const turnPromise = manager.sendTurn('thread-123', {
      model: 'gpt-5.4',
      reasoningEffort: 'low',
      developerInstructions: 'Title only instructions',
      input: [
        { type: 'text', text: 'Generate a title for this conversation:\n' },
        { type: 'text', text: 'Fix auth refresh token bug' }
      ]
    })

    const messages = getWrittenMessages(stdin)
    const turnStartMsg = messages.find((m: any) => m.method === 'turn/start')

    manager.handleStdoutLine(
      context,
      JSON.stringify({ id: turnStartMsg.id, result: { turn: { id: 'turn-title' } } })
    )

    await turnPromise

    const params = getTurnStartParams(messages)
    expect(params.input).toEqual([
      { type: 'text', text: 'Generate a title for this conversation:\n' },
      { type: 'text', text: 'Fix auth refresh token bug' }
    ])
    expect(params.settings.reasoningEffort).toBe('low')
    expect(params.collaborationMode.mode).toBe('default')
    expect(params.collaborationMode.settings.developer_instructions).toBe(
      'Title only instructions'
    )
    expect(params.collaborationMode.settings.reasoning_effort).toBe('low')
  })
})

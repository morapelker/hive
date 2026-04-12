/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockLogInfo, mockLogWarn } = vi.hoisted(() => ({
  mockLogInfo: vi.fn(),
  mockLogWarn: vi.fn()
}))

// Mock logger
vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: mockLogInfo,
    warn: mockLogWarn,
    error: vi.fn(),
    debug: vi.fn()
  })
}))

const mockGenerateCodexSessionTitle = vi.fn()
vi.mock('../../../src/main/services/codex-session-title', () => ({
  generateCodexSessionTitle: (...args: any[]) => mockGenerateCodexSessionTitle(...args)
}))

vi.mock('../../../src/main/services/git-service', () => ({
  autoRenameWorktreeBranch: vi.fn().mockResolvedValue({ success: true })
}))

// Track event listeners registered on the mock manager
let eventListeners: Array<(event: any) => void> = []

// Mock the CodexAppServerManager
vi.mock('../../../src/main/services/codex-app-server-manager', () => {
  const MockManager = vi.fn().mockImplementation(() => ({
    startSession: vi.fn(),
    stopSession: vi.fn(),
    stopAll: vi.fn(),
    hasSession: vi.fn().mockReturnValue(false),
    getSession: vi.fn(),
    listSessions: vi.fn().mockReturnValue([]),
    sendTurn: vi.fn(),
    on: vi.fn().mockImplementation((_event: string, handler: any) => {
      eventListeners.push(handler)
    }),
    emit: vi.fn(),
    removeListener: vi.fn().mockImplementation((_event: string, handler: any) => {
      eventListeners = eventListeners.filter((h) => h !== handler)
    }),
    removeAllListeners: vi.fn()
  }))
  return {
    CodexAppServerManager: MockManager
  }
})

import {
  CodexImplementer,
  normalizeCodexMessageTimestamps,
  type CodexSessionState
} from '../../../src/main/services/codex-implementer'

describe('CodexImplementer.prompt()', () => {
  let impl: CodexImplementer
  let mockManager: any
  let mockWindow: any

  beforeEach(() => {
    vi.clearAllMocks()
    eventListeners = []
    mockGenerateCodexSessionTitle.mockResolvedValue(null)
    impl = new CodexImplementer()
    mockManager = impl.getManager()
    mockWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    }
    impl.setMainWindow(mockWindow)
  })

  function seedSession(overrides?: Partial<CodexSessionState>): CodexSessionState {
    const session: CodexSessionState = {
      threadId: 'thread-1',
      hiveSessionId: 'hive-session-1',
      worktreePath: '/test/project',
      status: 'ready',
      messages: [],
      liveAssistantDraft: null,
      revertMessageID: null,
      revertDiff: null,
      titleGenerated: false,
      titleGenerationStarted: false,
      ...overrides
    }
    impl.getSessions().set('/test/project::thread-1', session)
    return session
  }

  function simulateManagerEvents(events: any[]) {
    // sendTurn resolves immediately, then we fire events asynchronously
    mockManager.sendTurn.mockImplementation(async () => {
      // Schedule events to fire after the sendTurn resolves
      setTimeout(() => {
        for (const event of events) {
          for (const listener of [...eventListeners]) {
            listener(event)
          }
        }
      }, 5)
      return { turnId: 'turn-1', threadId: 'thread-1' }
    })
  }

  // ── Basic prompt flow ───────────────────────────────────────

  it('calls sendTurn with extracted text', async () => {
    seedSession()

    simulateManagerEvents([
      {
        id: 'e1',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'turn/completed',
        payload: { turn: { status: 'completed' } }
      }
    ])

    await impl.prompt('/test/project', 'thread-1', 'Hello Codex')

    expect(mockManager.sendTurn).toHaveBeenCalledWith('thread-1', {
      text: 'Hello Codex',
      model: expect.any(String),
      interactionMode: 'default'
    })
    expect(mockGenerateCodexSessionTitle).toHaveBeenCalledWith(
      'Hello Codex',
      '/test/project',
      null
    )
    expect(mockLogInfo).toHaveBeenCalledWith(
      'Prompt: evaluating title generation',
      expect.objectContaining({
        hiveSessionId: 'hive-session-1',
        threadId: 'thread-1',
        shouldGenerateTitle: true
      })
    )
    expect(mockLogWarn).toHaveBeenCalledWith(
      'handleTitleGeneration: generator returned null title',
      { hiveSessionId: 'hive-session-1', threadId: 'thread-1' }
    )
  })

  it('logs when title generation is skipped for a pre-titled session', async () => {
    impl.setDatabaseService({
      getSession: vi.fn().mockReturnValue({ id: 'hive-session-1', name: 'Existing title' })
    } as any)
    seedSession()

    simulateManagerEvents([
      {
        id: 'e1',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'turn/completed',
        payload: { turn: { status: 'completed' } }
      }
    ])

    await impl.prompt('/test/project', 'thread-1', 'Hello Codex')

    expect(mockGenerateCodexSessionTitle).not.toHaveBeenCalled()
    expect(mockLogInfo).toHaveBeenCalledWith(
      'Prompt: skipped title generation for pre-titled session',
      { hiveSessionId: 'hive-session-1', currentTitle: 'Existing title' }
    )
  })

  it('extracts text from parts array', async () => {
    seedSession()

    simulateManagerEvents([
      {
        id: 'e1',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'turn/completed',
        payload: { turn: { status: 'completed' } }
      }
    ])

    await impl.prompt('/test/project', 'thread-1', [
      { type: 'text', text: 'Part 1' },
      { type: 'text', text: 'Part 2' }
    ])

    expect(mockManager.sendTurn).toHaveBeenCalledWith('thread-1', {
      text: 'Part 1\nPart 2',
      model: expect.any(String),
      interactionMode: 'default'
    })
  })

  // ── Status transitions ──────────────────────────────────────

  it('emits busy status at start and idle at end', async () => {
    seedSession()

    simulateManagerEvents([
      {
        id: 'e1',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'turn/completed',
        payload: { turn: { status: 'completed' } }
      }
    ])

    await impl.prompt('/test/project', 'thread-1', 'test')

    const sendCalls = mockWindow.webContents.send.mock.calls
    const streamCalls = sendCalls.filter((c: any[]) => c[0] === 'opencode:stream')
    const statusEvents = streamCalls
      .map((c: any[]) => c[1])
      .filter((e: any) => e.type === 'session.status')

    // At minimum: busy at start, idle at end
    expect(statusEvents.length).toBeGreaterThanOrEqual(2)

    // First status should be busy
    expect(statusEvents[0].statusPayload.type).toBe('busy')

    // Last status should be idle
    expect(statusEvents[statusEvents.length - 1].statusPayload.type).toBe('idle')
  })

  // ── Event forwarding ────────────────────────────────────────

  it('forwards mapped item/agentMessage/delta events to renderer', async () => {
    seedSession()

    simulateManagerEvents([
      {
        id: 'e1',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'item/agentMessage/delta',
        textDelta: 'Hello',
        payload: { delta: 'Hello' }
      },
      {
        id: 'e2',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'turn/completed',
        payload: { turn: { status: 'completed' } }
      }
    ])

    await impl.prompt('/test/project', 'thread-1', 'test')

    const sendCalls = mockWindow.webContents.send.mock.calls
    const streamCalls = sendCalls
      .filter((c: any[]) => c[0] === 'opencode:stream')
      .map((c: any[]) => c[1])

    const textEvents = streamCalls.filter(
      (e: any) => e.type === 'message.part.updated' && e.data?.part?.type === 'text'
    )

    expect(textEvents.length).toBeGreaterThanOrEqual(1)
    expect(textEvents[0].data.part.text).toBe('Hello')
  })

  it('ignores events for other threads', async () => {
    seedSession()

    simulateManagerEvents([
      {
        id: 'e-other',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-OTHER',
        createdAt: new Date().toISOString(),
        method: 'item/agentMessage/delta',
        textDelta: 'Wrong thread',
        payload: { delta: 'Wrong thread' }
      },
      {
        id: 'e-done',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'turn/completed',
        payload: { turn: { status: 'completed' } }
      }
    ])

    await impl.prompt('/test/project', 'thread-1', 'test')

    const sendCalls = mockWindow.webContents.send.mock.calls
    const streamCalls = sendCalls
      .filter((c: any[]) => c[0] === 'opencode:stream')
      .map((c: any[]) => c[1])

    const textEvents = streamCalls.filter(
      (e: any) => e.type === 'message.part.updated' && e.data?.part?.type === 'text'
    )

    // The "Wrong thread" event should not have been forwarded
    expect(textEvents).toHaveLength(0)
  })

  // ── Message accumulation ────────────────────────────────────

  it('accumulates messages in session.messages', async () => {
    const session = seedSession()

    simulateManagerEvents([
      {
        id: 'e1',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'item/agentMessage/delta',
        textDelta: 'Response text',
        payload: { delta: 'Response text' }
      },
      {
        id: 'e2',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'turn/completed',
        payload: { turn: { status: 'completed' } }
      }
    ])

    await impl.prompt('/test/project', 'thread-1', 'My question')

    // Should have user message and assistant message
    expect(session.messages.length).toBe(2)
    expect((session.messages[0] as any).role).toBe('user')
    expect((session.messages[1] as any).role).toBe('assistant')
    expect((session.messages[1] as any).parts[0].text).toBe('Response text')
  })

  it('includes synthetic user message', async () => {
    const session = seedSession()

    simulateManagerEvents([
      {
        id: 'e1',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'turn/completed',
        payload: { turn: { status: 'completed' } }
      }
    ])

    await impl.prompt('/test/project', 'thread-1', 'User says hello')

    const userMsg = session.messages[0] as any
    expect(userMsg.role).toBe('user')
    expect(userMsg.parts[0].text).toBe('User says hello')
  })

  it('applies only the generated title for a new session', async () => {
    seedSession()

    const mockDb = {
      updateSession: vi.fn(),
      getSession: vi
        .fn()
        .mockReturnValueOnce({ id: 'hive-session-1', name: 'Session 1' })
        .mockReturnValueOnce({ id: 'hive-session-1', name: 'Fix auth token refresh bug' }),
      getWorktreeBySessionId: vi.fn().mockReturnValue(null)
    }
    impl.setDatabaseService(mockDb as any)

    mockGenerateCodexSessionTitle.mockResolvedValue('Auth refresh fix')

    simulateManagerEvents([
      {
        id: 'e1',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'turn/completed',
        payload: { turn: { status: 'completed' } }
      }
    ])

    await impl.prompt('/test/project', 'thread-1', 'Fix auth token refresh bug')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(mockDb.updateSession).toHaveBeenCalledTimes(1)
    expect(mockDb.updateSession).toHaveBeenNthCalledWith(1, 'hive-session-1', {
      name: 'Auth refresh fix'
    })

    const streamCalls = mockWindow.webContents.send.mock.calls
      .filter((c: any[]) => c[0] === 'opencode:stream')
      .map((c: any[]) => c[1])
      .filter((e: any) => e.type === 'session.updated')

    expect(streamCalls).toEqual([
      {
        type: 'session.updated',
        sessionId: 'hive-session-1',
        data: {
          title: 'Auth refresh fix',
          info: { title: 'Auth refresh fix' }
        }
      }
    ])
  })

  it('starts title generation only once per session', async () => {
    const session = seedSession()

    simulateManagerEvents([
      {
        id: 'e1',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'turn/completed',
        payload: { turn: { status: 'completed' } }
      }
    ])

    await impl.prompt('/test/project', 'thread-1', 'First message')
    session.status = 'ready'
    await impl.prompt('/test/project', 'thread-1', 'Second message')

    expect(mockGenerateCodexSessionTitle).toHaveBeenCalledTimes(1)
  })

  it('skips title generation when the session already has a meaningful title', async () => {
    seedSession()

    const mockDb = {
      getSession: vi.fn().mockReturnValue({ id: 'hive-session-1', name: 'Existing manual title' }),
      updateSession: vi.fn(),
      getWorktreeBySessionId: vi.fn().mockReturnValue(null)
    }
    impl.setDatabaseService(mockDb as any)

    simulateManagerEvents([
      {
        id: 'e1',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'turn/completed',
        payload: { turn: { status: 'completed' } }
      }
    ])

    await impl.prompt('/test/project', 'thread-1', 'First message')

    expect(mockGenerateCodexSessionTitle).not.toHaveBeenCalled()
    expect(mockDb.updateSession).not.toHaveBeenCalled()
  })

  // ── Error handling ──────────────────────────────────────────

  it('emits session.error when sendTurn throws', async () => {
    seedSession()
    mockManager.sendTurn.mockRejectedValue(new Error('API error'))

    await impl.prompt('/test/project', 'thread-1', 'test')

    const sendCalls = mockWindow.webContents.send.mock.calls
    const streamCalls = sendCalls
      .filter((c: any[]) => c[0] === 'opencode:stream')
      .map((c: any[]) => c[1])

    const errorEvents = streamCalls.filter((e: any) => e.type === 'session.error')
    expect(errorEvents).toHaveLength(1)
    expect(errorEvents[0].data.error).toBe('API error')
  })

  it('sets session status to error on failure', async () => {
    const session = seedSession()
    mockManager.sendTurn.mockRejectedValue(new Error('fail'))

    await impl.prompt('/test/project', 'thread-1', 'test')

    expect(session.status).toBe('error')
  })

  it('cleans up event listener after success', async () => {
    seedSession()

    simulateManagerEvents([
      {
        id: 'e1',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'turn/completed',
        payload: { turn: { status: 'completed' } }
      }
    ])

    await impl.prompt('/test/project', 'thread-1', 'test')

    expect(mockManager.removeListener).toHaveBeenCalledWith('event', expect.any(Function))
  })

  it('cleans up event listener after error', async () => {
    seedSession()
    mockManager.sendTurn.mockRejectedValue(new Error('fail'))

    await impl.prompt('/test/project', 'thread-1', 'test')

    expect(mockManager.removeListener).toHaveBeenCalledWith('event', expect.any(Function))
  })

  it('rejects when process crashes (error kind event)', async () => {
    const session = seedSession()

    simulateManagerEvents([
      {
        id: 'e1',
        kind: 'error',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'process/error',
        message: 'codex app-server process crashed'
      }
    ])

    await impl.prompt('/test/project', 'thread-1', 'test')

    // Should have set status to error
    expect(session.status).toBe('error')

    // Should have emitted session.error to renderer
    const sendCalls = mockWindow.webContents.send.mock.calls
    const streamCalls = sendCalls
      .filter((c: any[]) => c[0] === 'opencode:stream')
      .map((c: any[]) => c[1])
    const errorEvents = streamCalls.filter((e: any) => e.type === 'session.error')
    expect(errorEvents.length).toBeGreaterThanOrEqual(1)
  })

  it('does not abort turn on non-fatal error events (e.g. stderr warnings)', async () => {
    const session = seedSession()

    // Simulate a non-fatal error event followed by turn/completed.
    // Before the fix, ANY kind='error' event would abort the turn.
    // Now only fatal events (process/error, session/exited, session/closed) abort.
    simulateManagerEvents([
      {
        id: 'e1',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'process/stderr',
        message: 'Some benign stderr warning'
      },
      {
        id: 'e2',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'item/agentMessage/delta',
        textDelta: 'Hello from Codex'
      },
      {
        id: 'e3',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'turn/completed',
        payload: { turn: { status: 'completed' } }
      }
    ])

    await impl.prompt('/test/project', 'thread-1', 'test')

    // Turn should complete successfully — not error out
    expect(session.status).toBe('ready')

    // Assistant text should have been accumulated
    expect(session.messages.length).toBeGreaterThanOrEqual(2)
    const assistantMsg = session.messages.find((m: any) => m.role === 'assistant') as any
    expect(assistantMsg).toBeTruthy()
    expect(assistantMsg.parts[0].text).toBe('Hello from Codex')
  })

  it('rejects when session exits (session/exited)', async () => {
    const session = seedSession()

    simulateManagerEvents([
      {
        id: 'e1',
        kind: 'session',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'session/exited',
        message: 'codex app-server exited (code=1, signal=null).'
      }
    ])

    await impl.prompt('/test/project', 'thread-1', 'test')

    expect(session.status).toBe('error')
  })

  it('rejects when session closes (session/closed)', async () => {
    const session = seedSession()

    simulateManagerEvents([
      {
        id: 'e1',
        kind: 'session',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'session/closed',
        message: 'Session stopped'
      }
    ])

    await impl.prompt('/test/project', 'thread-1', 'test')

    expect(session.status).toBe('error')
  })

  it('rejects when session.state.changed emits error', async () => {
    const session = seedSession()

    simulateManagerEvents([
      {
        id: 'e1',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'session.state.changed',
        payload: { state: 'error', reason: 'API key revoked' }
      }
    ])

    await impl.prompt('/test/project', 'thread-1', 'test')

    expect(session.status).toBe('error')

    const sendCalls = mockWindow.webContents.send.mock.calls
    const streamCalls = sendCalls
      .filter((c: any[]) => c[0] === 'opencode:stream')
      .map((c: any[]) => c[1])
    const errorEvents = streamCalls.filter((e: any) => e.type === 'session.error')
    expect(errorEvents.length).toBeGreaterThanOrEqual(1)
    expect(errorEvents.some((e: any) => e.data?.error?.includes('API key revoked'))).toBe(true)
  })

  it('sets session status to error on failed turn', async () => {
    const session = seedSession()

    simulateManagerEvents([
      {
        id: 'e1',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'turn/completed',
        payload: { turn: { status: 'failed', error: 'Rate limit exceeded' } }
      }
    ])

    await impl.prompt('/test/project', 'thread-1', 'test')

    expect(session.status).toBe('error')
  })

  // ── Session not found ───────────────────────────────────────

  it('throws if session not found', async () => {
    await expect(impl.prompt('/unknown', 'thread-x', 'hello')).rejects.toThrow('session not found')
  })

  // ── Empty text ──────────────────────────────────────────────

  it('ignores empty text prompt', async () => {
    seedSession()

    await impl.prompt('/test/project', 'thread-1', '   ')

    expect(mockManager.sendTurn).not.toHaveBeenCalled()
  })

  // ── Model override ──────────────────────────────────────────

  it('uses modelOverride when provided', async () => {
    seedSession()

    simulateManagerEvents([
      {
        id: 'e1',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'turn/completed',
        payload: { turn: { status: 'completed' } }
      }
    ])

    await impl.prompt('/test/project', 'thread-1', 'test', {
      providerID: 'codex',
      modelID: 'gpt-5.3-codex'
    })

    expect(mockManager.sendTurn).toHaveBeenCalledWith('thread-1', {
      text: 'test',
      model: 'gpt-5.3-codex',
      interactionMode: 'default'
    })
  })

  it('maps codexFastMode to serviceTier fast', async () => {
    seedSession()

    simulateManagerEvents([
      {
        id: 'e1',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'turn/completed',
        payload: { turn: { status: 'completed' } }
      }
    ])

    await impl.prompt('/test/project', 'thread-1', 'test', undefined, { codexFastMode: true })

    expect(mockManager.sendTurn).toHaveBeenCalledWith('thread-1', {
      text: 'test',
      model: 'gpt-5.4',
      serviceTier: 'fast',
      interactionMode: 'default'
    })
  })

  // ── plan mode interactionMode ───────────────────────────────

  describe('plan mode interactionMode', () => {
    it('passes interactionMode: plan when dbService returns a session with mode: plan', async () => {
      seedSession()

      const mockDbService = {
        getSession: vi.fn().mockReturnValue({ id: 'hive-session-1', mode: 'plan' }),
        updateSession: vi.fn()
      } as any
      impl.setDatabaseService(mockDbService)

      simulateManagerEvents([
        {
          id: 'e1',
          kind: 'notification',
          provider: 'codex',
          threadId: 'thread-1',
          createdAt: new Date().toISOString(),
          method: 'turn/completed',
          payload: { turn: { status: 'completed' } }
        }
      ])

      await impl.prompt('/test/project', 'thread-1', 'Plan something')

      expect(mockManager.sendTurn).toHaveBeenCalledWith('thread-1', {
        text: 'Plan something',
        model: expect.any(String),
        interactionMode: 'plan'
      })
    })

    it('passes interactionMode: default when dbService returns a session with mode: build', async () => {
      seedSession()

      const mockDbService = {
        getSession: vi.fn().mockReturnValue({ id: 'hive-session-1', mode: 'build' }),
        updateSession: vi.fn()
      } as any
      impl.setDatabaseService(mockDbService)

      simulateManagerEvents([
        {
          id: 'e1',
          kind: 'notification',
          provider: 'codex',
          threadId: 'thread-1',
          createdAt: new Date().toISOString(),
          method: 'turn/completed',
          payload: { turn: { status: 'completed' } }
        }
      ])

      await impl.prompt('/test/project', 'thread-1', 'Build something')

      expect(mockManager.sendTurn).toHaveBeenCalledWith('thread-1', {
        text: 'Build something',
        model: expect.any(String),
        interactionMode: 'default'
      })
    })

    it('passes interactionMode: default when no dbService is set', async () => {
      seedSession()
      // impl has no dbService set by default

      simulateManagerEvents([
        {
          id: 'e1',
          kind: 'notification',
          provider: 'codex',
          threadId: 'thread-1',
          createdAt: new Date().toISOString(),
          method: 'turn/completed',
          payload: { turn: { status: 'completed' } }
        }
      ])

      await impl.prompt('/test/project', 'thread-1', 'Do something')

      expect(mockManager.sendTurn).toHaveBeenCalledWith('thread-1', {
        text: 'Do something',
        model: expect.any(String),
        interactionMode: 'default'
      })
    })

    it('emits plan.ready when a plan-shaped task_complete arrives in plan mode', async () => {
      seedSession()

      const mockDbService = {
        getSession: vi.fn().mockReturnValue({ id: 'hive-session-1', mode: 'plan' }),
        updateSession: vi.fn()
      } as any
      impl.setDatabaseService(mockDbService)

      simulateManagerEvents([
        {
          id: 'e-plan',
          kind: 'notification',
          provider: 'codex',
          threadId: 'thread-1',
          createdAt: new Date().toISOString(),
          method: 'codex/event/task_complete',
          payload: {
            msg: {
              turn_id: 'turn-1',
              last_agent_message:
                '<proposed_plan>\n1. Add the function\n2. Add a test\n</proposed_plan>'
            }
          }
        },
        {
          id: 'e-done',
          kind: 'notification',
          provider: 'codex',
          threadId: 'thread-1',
          createdAt: new Date().toISOString(),
          method: 'turn/completed',
          payload: { turn: { id: 'turn-1', status: 'completed' } }
        }
      ])

      await impl.prompt('/test/project', 'thread-1', 'Plan something')

      const streamCalls = mockWindow.webContents.send.mock.calls
        .filter((c: any[]) => c[0] === 'opencode:stream')
        .map((c: any[]) => c[1])

      const planReadyEvent = streamCalls.find((e: any) => e.type === 'plan.ready')
      expect(planReadyEvent).toBeDefined()
      expect(planReadyEvent.data.plan).toContain('1. Add the function')
      expect(planReadyEvent.data.toolUseID).toBeTruthy()
    })

    it('does not emit plan.ready for a clarifying question in plan mode', async () => {
      seedSession()

      const mockDbService = {
        getSession: vi.fn().mockReturnValue({ id: 'hive-session-1', mode: 'plan' }),
        updateSession: vi.fn()
      } as any
      impl.setDatabaseService(mockDbService)

      simulateManagerEvents([
        {
          id: 'e-plan',
          kind: 'notification',
          provider: 'codex',
          threadId: 'thread-1',
          createdAt: new Date().toISOString(),
          method: 'codex/event/task_complete',
          payload: {
            msg: {
              turn_id: 'turn-1',
              last_agent_message:
                'Where should I add it?\n\n- New module\n- Existing utils\n\nConfirm your preference.'
            }
          }
        },
        {
          id: 'e-done',
          kind: 'notification',
          provider: 'codex',
          threadId: 'thread-1',
          createdAt: new Date().toISOString(),
          method: 'turn/completed',
          payload: { turn: { id: 'turn-1', status: 'completed' } }
        }
      ])

      await impl.prompt('/test/project', 'thread-1', 'Plan something')

      const streamCalls = mockWindow.webContents.send.mock.calls
        .filter((c: any[]) => c[0] === 'opencode:stream')
        .map((c: any[]) => c[1])

      const planReadyEvent = streamCalls.find((e: any) => e.type === 'plan.ready')
      expect(planReadyEvent).toBeUndefined()
    })
  })

  // ── getMessages ─────────────────────────────────────────────

  describe('getMessages', () => {
    it('returns accumulated messages', async () => {
      const session = seedSession()
      session.messages = [
        { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', parts: [{ type: 'text', text: 'hello' }] }
      ]

      const messages = await impl.getMessages('/test/project', 'thread-1')

      expect(messages).toHaveLength(2)
    })

    it('returns empty array for unknown session', async () => {
      const messages = await impl.getMessages('/unknown', 'thread-x')

      expect(messages).toEqual([])
    })

    it('returns a copy of messages', async () => {
      const session = seedSession()
      session.messages = [{ role: 'user', parts: [] }]

      const messages = await impl.getMessages('/test/project', 'thread-1')
      messages.push({ role: 'fake' })

      expect(session.messages).toHaveLength(1)
    })

    it('returns a live in-progress assistant draft with text and tool parts while running', async () => {
      seedSession()

      let completeTurn: (() => void) | null = null
      mockManager.sendTurn.mockImplementation(async () => {
        setTimeout(() => {
          for (const listener of [...eventListeners]) {
            listener({
              id: 'e-text',
              kind: 'notification',
              provider: 'codex',
              threadId: 'thread-1',
              createdAt: new Date().toISOString(),
              method: 'item/agentMessage/delta',
              textDelta: 'Thinking through it',
              payload: { delta: 'Thinking through it' }
            })
            listener({
              id: 'e-tool-start',
              kind: 'notification',
              provider: 'codex',
              threadId: 'thread-1',
              createdAt: new Date().toISOString(),
              method: 'item.started',
              payload: {
                item: {
                  type: 'commandExecution',
                  id: 'tool-1',
                  toolName: 'bash',
                  input: { command: 'ls' }
                }
              }
            })
            listener({
              id: 'e-tool-done',
              kind: 'notification',
              provider: 'codex',
              threadId: 'thread-1',
              createdAt: new Date().toISOString(),
              method: 'item.completed',
              payload: {
                item: {
                  type: 'commandExecution',
                  id: 'tool-1',
                  toolName: 'bash',
                  status: 'completed',
                  output: 'file-a'
                }
              }
            })
          }
        }, 0)

        await new Promise<void>((resolve) => {
          completeTurn = resolve
        })
        return { turnId: 'turn-1', threadId: 'thread-1' }
      })

      const promptPromise = impl.prompt('/test/project', 'thread-1', 'Inspect repo')
      await new Promise((resolve) => setTimeout(resolve, 10))

      const messages = await impl.getMessages('/test/project', 'thread-1')
      expect(messages).toHaveLength(2)
      expect((messages[0] as any).role).toBe('user')
      expect((messages[1] as any).role).toBe('assistant')
      expect((messages[1] as any).id).toBe('codex-live-thread-1')
      expect((messages[1] as any).parts[0]).toMatchObject({
        type: 'text',
        text: 'Thinking through it'
      })
      const toolPart = (messages[1] as any).parts[1]
      if (toolPart.type === 'tool') {
        expect(toolPart).toMatchObject({
          type: 'tool',
          callID: 'tool-1',
          tool: 'bash',
          state: {
            status: 'completed',
            input: { command: 'ls' },
            output: 'file-a'
          }
        })
      } else {
        expect(toolPart).toMatchObject({
          type: 'tool_use',
          toolUse: {
            id: 'tool-1',
            name: 'bash',
            output: 'file-a'
          }
        })
        expect(['success', 'completed']).toContain(toolPart.toolUse.status)
      }

      for (const listener of [...eventListeners]) {
        listener({
          id: 'e-done',
          kind: 'notification',
          provider: 'codex',
          threadId: 'thread-1',
          createdAt: new Date().toISOString(),
          method: 'turn/completed',
          payload: { turn: { status: 'completed' } }
        })
      }
      completeTurn?.()
      await promptPromise
    })

    it('returns a live text-only assistant draft while running', async () => {
      seedSession()

      let completeTurn: (() => void) | null = null
      mockManager.sendTurn.mockImplementation(async () => {
        setTimeout(() => {
          for (const listener of [...eventListeners]) {
            listener({
              id: 'e-text',
              kind: 'notification',
              provider: 'codex',
              threadId: 'thread-1',
              createdAt: new Date().toISOString(),
              method: 'item/agentMessage/delta',
              textDelta: 'Partial answer',
              payload: { delta: 'Partial answer' }
            })
          }
        }, 0)

        await new Promise<void>((resolve) => {
          completeTurn = resolve
        })
        return { turnId: 'turn-1', threadId: 'thread-1' }
      })

      const promptPromise = impl.prompt('/test/project', 'thread-1', 'Say hi')
      await new Promise((resolve) => setTimeout(resolve, 10))

      const messages = await impl.getMessages('/test/project', 'thread-1')
      expect(messages).toHaveLength(2)
      expect((messages[1] as any).parts).toEqual([
        expect.objectContaining({
          type: 'text',
          text: 'Partial answer'
        })
      ])

      for (const listener of [...eventListeners]) {
        listener({
          id: 'e-done',
          kind: 'notification',
          provider: 'codex',
          threadId: 'thread-1',
          createdAt: new Date().toISOString(),
          method: 'turn/completed',
          payload: { turn: { status: 'completed' } }
        })
      }
      completeTurn?.()
      await promptPromise
    })
  })
})

describe('normalizeCodexMessageTimestamps', () => {
  it('preserves transcript order when raw timestamps regress', () => {
    const rows = normalizeCodexMessageTimestamps([
      { created_at: '2026-03-14T10:00:05.000Z', role: 'user' },
      { created_at: '2026-03-14T10:00:01.000Z', role: 'assistant' },
      { created_at: 'invalid-timestamp', role: 'user' }
    ])

    expect(Date.parse(rows[0]!.created_at)).toBeLessThan(Date.parse(rows[1]!.created_at))
    expect(Date.parse(rows[1]!.created_at)).toBeLessThan(Date.parse(rows[2]!.created_at))
  })
})

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

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

// ── Helper: create a mock child process ─────────────────────────────

function createMockChild(): {
  child: any
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
} {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()

  const child = new EventEmitter() as any
  child.stdin = stdin
  child.stdout = stdout
  child.stderr = stderr
  child.pid = 12345
  child.killed = false
  child.kill = vi.fn(() => {
    child.killed = true
  })

  return { child, stdin, stdout, stderr }
}

// ── Helper: create a test session context ───────────────────────────

function createTestContext(overrides?: Partial<CodexProviderSession>): {
  context: CodexSessionContext
  child: any
  stdin: PassThrough
} {
  const { child, stdin } = createMockChild()

  const output = {
    on: vi.fn(),
    close: vi.fn(),
    removeAllListeners: vi.fn()
  } as any

  const session: CodexProviderSession = {
    provider: 'codex',
    status: 'running',
    threadId: 'thread-abort-1',
    cwd: '/test/project',
    model: 'gpt-5.4',
    activeTurnId: 'turn-active-1',
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

  return { context, child, stdin }
}

// ── Tests ───────────────────────────────────────────────────────────

describe('Codex Abort & getMessages', () => {
  let manager: CodexAppServerManager

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new CodexAppServerManager()
  })

  // ── interruptTurn ───────────────────────────────────────────────

  describe('interruptTurn', () => {
    it('sends turn/interrupt JSON-RPC request with threadId and turnId', async () => {
      const { context, child } = createTestContext()
      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      sessionsMap.set('thread-abort-1', context)

      const writeSpy = vi.spyOn(child.stdin, 'write')

      // Resolve the sendRequest by simulating a response
      const interruptPromise = manager.interruptTurn('thread-abort-1', 'turn-99')
      // The manager's sendRequest writes the request and waits for response
      // Find the request ID and send a response
      const requestWritten = JSON.parse((writeSpy.mock.calls[0][0] as string).trim())
      expect(requestWritten.method).toBe('turn/interrupt')
      expect(requestWritten.params.threadId).toBe('thread-abort-1')
      expect(requestWritten.params.turnId).toBe('turn-99')

      // Simulate response
      manager.handleStdoutLine(
        context,
        JSON.stringify({
          id: requestWritten.id,
          result: { ok: true }
        })
      )

      await interruptPromise
    })

    it('uses activeTurnId when no turnId is provided', async () => {
      const { context, child } = createTestContext({ activeTurnId: 'turn-active-1' })
      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      sessionsMap.set('thread-abort-1', context)

      const writeSpy = vi.spyOn(child.stdin, 'write')

      const interruptPromise = manager.interruptTurn('thread-abort-1')
      const requestWritten = JSON.parse((writeSpy.mock.calls[0][0] as string).trim())
      expect(requestWritten.params.turnId).toBe('turn-active-1')

      manager.handleStdoutLine(
        context,
        JSON.stringify({
          id: requestWritten.id,
          result: { ok: true }
        })
      )

      await interruptPromise
    })

    it('updates session status to ready and clears activeTurnId', async () => {
      const { context, child } = createTestContext({
        status: 'running',
        activeTurnId: 'turn-active-1'
      })
      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      sessionsMap.set('thread-abort-1', context)

      const writeSpy = vi.spyOn(child.stdin, 'write')

      const interruptPromise = manager.interruptTurn('thread-abort-1')
      const requestWritten = JSON.parse((writeSpy.mock.calls[0][0] as string).trim())

      manager.handleStdoutLine(
        context,
        JSON.stringify({
          id: requestWritten.id,
          result: { ok: true }
        })
      )

      await interruptPromise

      expect(context.session.status).toBe('ready')
      expect(context.session.activeTurnId).toBeNull()
    })

    it('emits turn/interrupted event', async () => {
      const { context, child } = createTestContext()
      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      sessionsMap.set('thread-abort-1', context)

      const events: any[] = []
      manager.on('event', (event) => events.push(event))

      const writeSpy = vi.spyOn(child.stdin, 'write')

      const interruptPromise = manager.interruptTurn('thread-abort-1')
      const requestWritten = JSON.parse((writeSpy.mock.calls[0][0] as string).trim())

      manager.handleStdoutLine(
        context,
        JSON.stringify({
          id: requestWritten.id,
          result: { ok: true }
        })
      )

      await interruptPromise

      const interruptEvent = events.find((e) => e.method === 'turn/interrupted')
      expect(interruptEvent).toBeDefined()
    })

    it('throws when threadId is unknown', async () => {
      await expect(manager.interruptTurn('nonexistent')).rejects.toThrow('no session for threadId')
    })
  })

  // ── readThread ──────────────────────────────────────────────────

  describe('readThread', () => {
    it('sends thread/read JSON-RPC request with correct params', async () => {
      const { context, child } = createTestContext()
      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      sessionsMap.set('thread-abort-1', context)

      const writeSpy = vi.spyOn(child.stdin, 'write')

      const readPromise = manager.readThread('thread-abort-1')
      const requestWritten = JSON.parse((writeSpy.mock.calls[0][0] as string).trim())

      expect(requestWritten.method).toBe('thread/read')
      expect(requestWritten.params.threadId).toBe('thread-abort-1')
      expect(requestWritten.params.includeTurns).toBe(true)

      // Simulate response with thread snapshot
      manager.handleStdoutLine(
        context,
        JSON.stringify({
          id: requestWritten.id,
          result: {
            thread: {
              id: 'thread-abort-1',
              turns: [
                {
                  id: 'turn-1',
                  input: [{ type: 'text', text: 'Hello' }],
                  outputText: 'World',
                  createdAt: '2026-01-01T00:00:00Z',
                  updatedAt: '2026-01-01T00:00:01Z'
                }
              ]
            }
          }
        })
      )

      const result = await readPromise
      expect(result).toBeDefined()
      expect((result as any).thread.turns).toHaveLength(1)
    })

    it('throws when threadId is unknown', async () => {
      await expect(manager.readThread('nonexistent')).rejects.toThrow('no session for threadId')
    })
  })

  // ── CodexImplementer.abort ──────────────────────────────────────

  describe('CodexImplementer.abort', () => {
    it('calls manager.interruptTurn and updates status', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()
      const internalManager = impl.getManager() as any
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      }
      impl.setMainWindow(mockWindow as any)

      const session = {
        threadId: 'thread-abort-1',
        hiveSessionId: 'hive-abort-1',
        worktreePath: '/test',
        status: 'running' as const,
        messages: [],
        revertMessageID: null,
        revertDiff: null
      }
      impl.getSessions().set('/test::thread-abort-1', session)

      internalManager.interruptTurn = vi.fn().mockResolvedValue(undefined)

      const result = await impl.abort('/test', 'thread-abort-1')

      expect(result).toBe(true)
      expect(internalManager.interruptTurn).toHaveBeenCalledWith('thread-abort-1')
      expect(session.status).toBe('ready')
    })

    it('emits idle status to renderer', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()
      const internalManager = impl.getManager() as any
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      }
      impl.setMainWindow(mockWindow as any)

      impl.getSessions().set('/test::thread-abort-1', {
        threadId: 'thread-abort-1',
        hiveSessionId: 'hive-abort-1',
        worktreePath: '/test',
        status: 'running',
        messages: [],
        revertMessageID: null,
        revertDiff: null
      })

      internalManager.interruptTurn = vi.fn().mockResolvedValue(undefined)

      await impl.abort('/test', 'thread-abort-1')

      const sendCalls = mockWindow.webContents.send.mock.calls
      const streamCalls = sendCalls
        .filter((c: any[]) => c[0] === 'opencode:stream')
        .map((c: any[]) => c[1])

      const statusEvent = streamCalls.find((e: any) => e.type === 'session.status')
      expect(statusEvent).toBeDefined()
      expect(statusEvent.statusPayload.type).toBe('idle')
    })

    it('returns false for unknown session', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()

      const result = await impl.abort('/unknown', 'thread-x')
      expect(result).toBe(false)
    })

    it('still succeeds even if interruptTurn throws', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()
      const internalManager = impl.getManager() as any
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      }
      impl.setMainWindow(mockWindow as any)

      impl.getSessions().set('/test::thread-abort-1', {
        threadId: 'thread-abort-1',
        hiveSessionId: 'hive-abort-1',
        worktreePath: '/test',
        status: 'running',
        messages: [],
        revertMessageID: null,
        revertDiff: null
      })

      internalManager.interruptTurn = vi.fn().mockRejectedValue(new Error('Server not responding'))

      const result = await impl.abort('/test', 'thread-abort-1')
      expect(result).toBe(true) // Still succeeds
    })
  })

  // ── CodexImplementer.getMessages ────────────────────────────────

  describe('CodexImplementer.getMessages', () => {
    it('returns in-memory messages first', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()

      const session = {
        threadId: 'thread-msg-1',
        hiveSessionId: 'hive-msg-1',
        worktreePath: '/test',
        status: 'ready' as const,
        messages: [
          { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
          { role: 'assistant', parts: [{ type: 'text', text: 'hello' }] }
        ],
        revertMessageID: null,
        revertDiff: null
      }
      impl.getSessions().set('/test::thread-msg-1', session)

      const messages = await impl.getMessages('/test', 'thread-msg-1')
      expect(messages).toHaveLength(2)
      expect((messages[0] as any).role).toBe('user')
      expect((messages[1] as any).role).toBe('assistant')
    })

    it('falls back to readThread when in-memory is empty', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()
      const internalManager = impl.getManager() as any

      impl.getSessions().set('/test::thread-msg-1', {
        threadId: 'thread-msg-1',
        hiveSessionId: 'hive-msg-1',
        worktreePath: '/test',
        status: 'ready',
        messages: [],
        revertMessageID: null,
        revertDiff: null
      })

      // Mock readThread to return a thread snapshot
      internalManager.readThread = vi.fn().mockResolvedValue({
        thread: {
          id: 'thread-msg-1',
          turns: [
            {
              id: 'turn-1',
              input: [{ type: 'text', text: 'User question' }],
              outputText: 'Assistant answer',
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:01Z'
            }
          ]
        }
      })

      const messages = await impl.getMessages('/test', 'thread-msg-1')

      expect(internalManager.readThread).toHaveBeenCalledWith('thread-msg-1')
      expect(messages).toHaveLength(2)
      expect((messages[0] as any).role).toBe('user')
      expect((messages[0] as any).parts[0].text).toBe('User question')
      expect((messages[1] as any).role).toBe('assistant')
      expect((messages[1] as any).parts[0].text).toBe('Assistant answer')
    })

    it('warms in-memory cache from readThread result', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()
      const internalManager = impl.getManager() as any

      const session = {
        threadId: 'thread-msg-1',
        hiveSessionId: 'hive-msg-1',
        worktreePath: '/test',
        status: 'ready' as const,
        messages: [] as unknown[],
        revertMessageID: null,
        revertDiff: null
      }
      impl.getSessions().set('/test::thread-msg-1', session)

      internalManager.readThread = vi.fn().mockResolvedValue({
        thread: {
          id: 'thread-msg-1',
          turns: [
            {
              id: 'turn-1',
              input: [{ type: 'text', text: 'Hello' }],
              outputText: 'World',
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:01Z'
            }
          ]
        }
      })

      await impl.getMessages('/test', 'thread-msg-1')

      // The in-memory cache should now be warmed
      expect(session.messages.length).toBe(2)
    })

    it('does not call readThread when session is closed', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()
      const internalManager = impl.getManager() as any

      impl.getSessions().set('/test::thread-msg-1', {
        threadId: 'thread-msg-1',
        hiveSessionId: 'hive-msg-1',
        worktreePath: '/test',
        status: 'closed',
        messages: [],
        revertMessageID: null,
        revertDiff: null
      })

      internalManager.readThread = vi.fn()

      const messages = await impl.getMessages('/test', 'thread-msg-1')

      expect(internalManager.readThread).not.toHaveBeenCalled()
      expect(messages).toEqual([])
    })

    it('recovers a persisted Codex session when no in-memory session exists', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()
      const internalManager = impl.getManager() as any

      impl.setDatabaseService({
        getSessionByOpenCodeSessionId: vi.fn().mockReturnValue({
          id: 'hive-msg-1',
          opencode_session_id: 'thread-msg-1',
          agent_sdk: 'codex',
          model_id: null
        })
      } as any)

      internalManager.startSession = vi.fn().mockResolvedValue({
        threadId: 'thread-msg-1',
        status: 'ready'
      })
      internalManager.readThread = vi.fn().mockResolvedValue({
        thread: {
          id: 'thread-msg-1',
          turns: [
            {
              id: 'turn-1',
              items: [
                {
                  type: 'userMessage',
                  id: 'user-1',
                  content: [{ type: 'text', text: 'Recovered question' }]
                },
                {
                  type: 'agentMessage',
                  id: 'assistant-1',
                  text: 'Recovered answer'
                }
              ],
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:01Z'
            }
          ]
        }
      })

      const messages = await impl.getMessages('/test', 'thread-msg-1')

      expect(internalManager.startSession).toHaveBeenCalledWith({
        cwd: '/test',
        model: impl.getSelectedModel(),
        resumeThreadId: 'thread-msg-1'
      })
      expect(internalManager.readThread).toHaveBeenCalledWith('thread-msg-1')
      expect(messages).toHaveLength(2)
      expect((messages[0] as any).parts[0].text).toBe('Recovered question')
      expect((messages[1] as any).parts[0].text).toBe('Recovered answer')
      expect(impl.getSessions().get('/test::thread-msg-1')).toMatchObject({
        hiveSessionId: 'hive-msg-1',
        threadId: 'thread-msg-1',
        worktreePath: '/test'
      })
    })

    it('returns empty array for unknown session', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()

      const messages = await impl.getMessages('/unknown', 'thread-x')
      expect(messages).toEqual([])
    })

    it('returns empty array when readThread fails', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()
      const internalManager = impl.getManager() as any

      impl.getSessions().set('/test::thread-msg-1', {
        threadId: 'thread-msg-1',
        hiveSessionId: 'hive-msg-1',
        worktreePath: '/test',
        status: 'ready',
        messages: [],
        revertMessageID: null,
        revertDiff: null
      })

      internalManager.readThread = vi.fn().mockRejectedValue(new Error('Server unavailable'))

      const messages = await impl.getMessages('/test', 'thread-msg-1')
      expect(messages).toEqual([])
    })

    it('parses thread snapshot with output array (no outputText)', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()
      const internalManager = impl.getManager() as any

      impl.getSessions().set('/test::thread-msg-1', {
        threadId: 'thread-msg-1',
        hiveSessionId: 'hive-msg-1',
        worktreePath: '/test',
        status: 'ready',
        messages: [],
        revertMessageID: null,
        revertDiff: null
      })

      internalManager.readThread = vi.fn().mockResolvedValue({
        thread: {
          id: 'thread-msg-1',
          turns: [
            {
              id: 'turn-1',
              input: [{ type: 'text', text: 'Hello' }],
              output: [{ type: 'text', text: 'Hi there' }],
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:01Z'
            }
          ]
        }
      })

      const messages = await impl.getMessages('/test', 'thread-msg-1')

      expect(messages).toHaveLength(2)
      expect((messages[1] as any).role).toBe('assistant')
      expect((messages[1] as any).parts[0].text).toBe('Hi there')
    })

    it('parses real Codex thread/read turns with items arrays', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()
      const internalManager = impl.getManager() as any

      impl.getSessions().set('/test::thread-msg-1', {
        threadId: 'thread-msg-1',
        hiveSessionId: 'hive-msg-1',
        worktreePath: '/test',
        status: 'ready',
        messages: [],
        revertMessageID: null,
        revertDiff: null
      })

      internalManager.readThread = vi.fn().mockResolvedValue({
        thread: {
          id: 'thread-msg-1',
          turns: [
            {
              id: 'turn-1',
              items: [
                {
                  type: 'userMessage',
                  id: 'user-1',
                  content: [{ type: 'text', text: 'Saved user message' }]
                },
                {
                  type: 'agentMessage',
                  id: 'assistant-1',
                  text: 'Saved assistant reply'
                }
              ]
            }
          ]
        }
      })

      const messages = await impl.getMessages('/test', 'thread-msg-1')

      expect(messages).toHaveLength(2)
      expect((messages[0] as any).role).toBe('user')
      expect((messages[0] as any).parts[0].text).toBe('Saved user message')
      expect((messages[1] as any).role).toBe('assistant')
      expect((messages[1] as any).parts[0].text).toBe('Saved assistant reply')
    })

    it('returns recovered Codex messages in chronological order', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()
      const internalManager = impl.getManager() as any

      impl.getSessions().set('/test::thread-msg-1', {
        threadId: 'thread-msg-1',
        hiveSessionId: 'hive-msg-1',
        worktreePath: '/test',
        status: 'ready',
        messages: [],
        revertMessageID: null,
        revertDiff: null
      })

      internalManager.readThread = vi.fn().mockResolvedValue({
        thread: {
          id: 'thread-msg-1',
          turns: [
            {
              id: 'turn-2',
              items: [
                {
                  type: 'userMessage',
                  id: 'user-2',
                  content: [{ type: 'text', text: 'Second question' }]
                },
                {
                  type: 'agentMessage',
                  id: 'assistant-2',
                  text: 'Second answer'
                }
              ],
              createdAt: '2026-01-01T00:01:00Z',
              updatedAt: '2026-01-01T00:01:10Z'
            },
            {
              id: 'turn-1',
              items: [
                {
                  type: 'userMessage',
                  id: 'user-1',
                  content: [{ type: 'text', text: 'First question' }]
                },
                {
                  type: 'agentMessage',
                  id: 'assistant-1',
                  text: 'First answer'
                }
              ],
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:10Z'
            }
          ]
        }
      })

      const messages = await impl.getMessages('/test', 'thread-msg-1')

      expect(messages.map((message: any) => message.parts[0].text)).toEqual([
        'First question',
        'First answer',
        'Second question',
        'Second answer'
      ])
    })
  })
})

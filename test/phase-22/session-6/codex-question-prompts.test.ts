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
    status: 'ready',
    threadId: 'thread-q-1',
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

  return { context, child, stdin }
}

// ── Tests ───────────────────────────────────────────────────────────

describe('Codex Question Prompts', () => {
  let manager: CodexAppServerManager

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new CodexAppServerManager()
  })

  // ── respondToUserInput ──────────────────────────────────────────

  describe('respondToUserInput', () => {
    it('sends correct JSON-RPC response with answers map', () => {
      const { context, child } = createTestContext()
      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      sessionsMap.set('thread-q-1', context)

      const writeSpy = vi.spyOn(child.stdin, 'write')

      context.pendingUserInputs.set('uinput-1', {
        requestId: 'uinput-1',
        jsonRpcId: 55,
        threadId: 'thread-q-1'
      })

      manager.respondToUserInput('thread-q-1', 'uinput-1', [
        { id: 'q1', answer: 'yes' },
        { id: 'q2', answer: 'no' }
      ])

      expect(writeSpy).toHaveBeenCalledTimes(1)
      const written = JSON.parse((writeSpy.mock.calls[0][0] as string).trim())
      expect(written).toEqual({
        jsonrpc: '2.0',
        id: 55,
        result: {
          answers: {
            q1: { answers: ['yes'] },
            q2: { answers: ['no'] }
          }
        }
      })
    })

    it('removes the user input from pendingUserInputs after responding', () => {
      const { context } = createTestContext()
      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      sessionsMap.set('thread-q-1', context)

      context.pendingUserInputs.set('uinput-1', {
        requestId: 'uinput-1',
        jsonRpcId: 55,
        threadId: 'thread-q-1'
      })

      manager.respondToUserInput('thread-q-1', 'uinput-1', [{ id: 'q1', answer: 'yes' }])

      expect(context.pendingUserInputs.size).toBe(0)
    })

    it('emits userInput/responded event', () => {
      const { context } = createTestContext()
      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      sessionsMap.set('thread-q-1', context)

      const events: any[] = []
      manager.on('event', (event) => events.push(event))

      context.pendingUserInputs.set('uinput-1', {
        requestId: 'uinput-1',
        jsonRpcId: 55,
        threadId: 'thread-q-1'
      })

      manager.respondToUserInput('thread-q-1', 'uinput-1', [{ id: 'q1', answer: 'yes' }])

      const inputEvent = events.find((e) => e.method === 'item/tool/requestUserInput/answered')
      expect(inputEvent).toBeDefined()
      expect(inputEvent.kind).toBe('notification')
      expect(inputEvent.requestId).toBe('uinput-1')
      expect(inputEvent.payload).toBeDefined()
      expect(inputEvent.payload.requestId).toBe('uinput-1')
    })

    it('throws when threadId is unknown', () => {
      expect(() => manager.respondToUserInput('nonexistent', 'req-1', [])).toThrow(
        'no session for threadId'
      )
    })

    it('throws when requestId is not pending', () => {
      const { context } = createTestContext()
      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      sessionsMap.set('thread-q-1', context)

      expect(() => manager.respondToUserInput('thread-q-1', 'nonexistent', [])).toThrow(
        'no pending user input'
      )
    })
  })

  // ── rejectUserInput ─────────────────────────────────────────────

  describe('rejectUserInput', () => {
    it('sends JSON-RPC response with empty answers and rejected flag', () => {
      const { context, child } = createTestContext()
      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      sessionsMap.set('thread-q-1', context)

      const writeSpy = vi.spyOn(child.stdin, 'write')

      context.pendingUserInputs.set('uinput-2', {
        requestId: 'uinput-2',
        jsonRpcId: 60,
        threadId: 'thread-q-1'
      })

      manager.rejectUserInput('thread-q-1', 'uinput-2')

      expect(writeSpy).toHaveBeenCalledTimes(1)
      const written = JSON.parse((writeSpy.mock.calls[0][0] as string).trim())
      expect(written).toEqual({
        jsonrpc: '2.0',
        id: 60,
        result: { answers: {}, rejected: true }
      })
    })

    it('removes from pendingUserInputs', () => {
      const { context } = createTestContext()
      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      sessionsMap.set('thread-q-1', context)

      context.pendingUserInputs.set('uinput-2', {
        requestId: 'uinput-2',
        jsonRpcId: 60,
        threadId: 'thread-q-1'
      })

      manager.rejectUserInput('thread-q-1', 'uinput-2')
      expect(context.pendingUserInputs.size).toBe(0)
    })

    it('emits userInput/rejected event', () => {
      const { context } = createTestContext()
      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      sessionsMap.set('thread-q-1', context)

      const events: any[] = []
      manager.on('event', (event) => events.push(event))

      context.pendingUserInputs.set('uinput-2', {
        requestId: 'uinput-2',
        jsonRpcId: 60,
        threadId: 'thread-q-1'
      })

      manager.rejectUserInput('thread-q-1', 'uinput-2')

      const rejectedEvent = events.find((e) => e.method === 'userInput/rejected')
      expect(rejectedEvent).toBeDefined()
    })
  })

  // ── getPendingUserInputs ────────────────────────────────────────

  describe('getPendingUserInputs', () => {
    it('returns array of pending user inputs', () => {
      const { context } = createTestContext()
      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      sessionsMap.set('thread-q-1', context)

      context.pendingUserInputs.set('u1', {
        requestId: 'u1',
        jsonRpcId: 1,
        threadId: 'thread-q-1'
      })

      const inputs = manager.getPendingUserInputs('thread-q-1')
      expect(inputs).toHaveLength(1)
      expect(inputs[0].requestId).toBe('u1')
    })

    it('returns empty array for unknown threadId', () => {
      expect(manager.getPendingUserInputs('nonexistent')).toEqual([])
    })
  })

  // ── CodexImplementer question routing ───────────────────────────

  describe('CodexImplementer.questionReply', () => {
    it('routes correctly to manager.respondToUserInput', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()
      const internalManager = impl.getManager() as any

      // Seed session
      impl.getSessions().set('/test::thread-q-1', {
        threadId: 'thread-q-1',
        hiveSessionId: 'hive-q-1',
        worktreePath: '/test',
        status: 'ready',
        messages: [],
        revertMessageID: null,
        revertDiff: null
      })

      // Seed pending question
      impl.getPendingQuestions().set('q-req-1', {
        threadId: 'thread-q-1',
        hiveSessionId: 'hive-q-1',
        worktreePath: '/test'
      })

      // Mock manager method
      internalManager.respondToUserInput = vi.fn()

      // answers format: string[][] where each entry is [id, answer]
      await impl.questionReply('q-req-1', [
        ['q1', 'yes'],
        ['q2', 'no']
      ])

      expect(internalManager.respondToUserInput).toHaveBeenCalledWith('thread-q-1', 'q-req-1', [
        { id: 'q1', answer: 'yes' },
        { id: 'q2', answer: 'no' }
      ])
    })

    it('removes question from pending after reply', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()
      const internalManager = impl.getManager() as any
      internalManager.respondToUserInput = vi.fn()

      impl.getSessions().set('/test::thread-q-1', {
        threadId: 'thread-q-1',
        hiveSessionId: 'hive-q-1',
        worktreePath: '/test',
        status: 'ready',
        messages: [],
        revertMessageID: null,
        revertDiff: null
      })
      impl.getPendingQuestions().set('q-req-1', {
        threadId: 'thread-q-1',
        hiveSessionId: 'hive-q-1',
        worktreePath: '/test'
      })

      await impl.questionReply('q-req-1', [['q1', 'yes']])

      expect(impl.getPendingQuestions().has('q-req-1')).toBe(false)
    })

    it('throws when requestId is not pending', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()

      await expect(impl.questionReply('nonexistent', [['q1', 'yes']])).rejects.toThrow(
        'No pending question found'
      )
    })
  })

  describe('CodexImplementer.questionReject', () => {
    it('routes correctly to manager.rejectUserInput', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()
      const internalManager = impl.getManager() as any

      impl.getSessions().set('/test::thread-q-1', {
        threadId: 'thread-q-1',
        hiveSessionId: 'hive-q-1',
        worktreePath: '/test',
        status: 'ready',
        messages: [],
        revertMessageID: null,
        revertDiff: null
      })
      impl.getPendingQuestions().set('q-req-2', {
        threadId: 'thread-q-1',
        hiveSessionId: 'hive-q-1',
        worktreePath: '/test'
      })

      internalManager.rejectUserInput = vi.fn()

      await impl.questionReject('q-req-2')

      expect(internalManager.rejectUserInput).toHaveBeenCalledWith('thread-q-1', 'q-req-2')
    })

    it('removes question from pending after reject', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()
      const internalManager = impl.getManager() as any
      internalManager.rejectUserInput = vi.fn()

      impl.getSessions().set('/test::thread-q-1', {
        threadId: 'thread-q-1',
        hiveSessionId: 'hive-q-1',
        worktreePath: '/test',
        status: 'ready',
        messages: [],
        revertMessageID: null,
        revertDiff: null
      })
      impl.getPendingQuestions().set('q-req-2', {
        threadId: 'thread-q-1',
        hiveSessionId: 'hive-q-1',
        worktreePath: '/test'
      })

      await impl.questionReject('q-req-2')

      expect(impl.getPendingQuestions().has('q-req-2')).toBe(false)
    })

    it('throws when requestId is not pending', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()

      await expect(impl.questionReject('nonexistent')).rejects.toThrow('No pending question found')
    })
  })

  // ── hasPendingQuestion ──────────────────────────────────────────

  describe('CodexImplementer.hasPendingQuestion', () => {
    it('returns true when question is pending', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()

      impl.getPendingQuestions().set('q-1', {
        threadId: 'thread-1',
        hiveSessionId: 'hive-1',
        worktreePath: '/test'
      })

      expect(impl.hasPendingQuestion('q-1')).toBe(true)
    })

    it('returns false when question is not pending', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()

      expect(impl.hasPendingQuestion('nonexistent')).toBe(false)
    })
  })

  // ── Event forwarding to renderer ────────────────────────────────

  describe('CodexImplementer event forwarding', () => {
    it('forwards question.asked event to renderer on requestUserInput', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()
      const internalManager = impl.getManager() as any
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      }
      impl.setMainWindow(mockWindow as any)

      // Seed a session
      impl.getSessions().set('/test::thread-q-1', {
        threadId: 'thread-q-1',
        hiveSessionId: 'hive-q-1',
        worktreePath: '/test',
        status: 'ready',
        messages: [],
        revertMessageID: null,
        revertDiff: null
      })

      // Capture the manager event listener
      let managerListener: any
      internalManager.on = vi.fn().mockImplementation((_: string, handler: any) => {
        managerListener = handler
      })

      // Trigger listener attachment by calling connect indirectly
      // Instead, directly call the internal method via any cast
      ;(impl as any).attachManagerListener()

      // Simulate a requestUserInput event from the manager
      managerListener({
        id: 'evt-1',
        kind: 'request',
        provider: 'codex',
        threadId: 'thread-q-1',
        createdAt: new Date().toISOString(),
        method: 'item/tool/requestUserInput',
        requestId: 'req-q-1',
        payload: {
          questions: [{ id: 'q1', question: 'What is the API key?' }]
        }
      })

      // Verify question.asked was sent to renderer
      const sendCalls = mockWindow.webContents.send.mock.calls
      const streamCalls = sendCalls
        .filter((c: any[]) => c[0] === 'opencode:stream')
        .map((c: any[]) => c[1])

      const questionEvent = streamCalls.find((e: any) => e.type === 'question.asked')
      expect(questionEvent).toBeDefined()
      expect(questionEvent.sessionId).toBe('hive-q-1')
      expect(questionEvent.data.requestId).toBe('req-q-1')
      expect(questionEvent.data.questions).toHaveLength(1)

      // Verify it was tracked in pendingQuestions
      expect(impl.getPendingQuestions().has('req-q-1')).toBe(true)
    })

    it('forwards permission.asked event to renderer on requestApproval', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()
      const internalManager = impl.getManager() as any
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      }
      impl.setMainWindow(mockWindow as any)

      impl.getSessions().set('/test::thread-q-1', {
        threadId: 'thread-q-1',
        hiveSessionId: 'hive-q-1',
        worktreePath: '/test',
        status: 'ready',
        messages: [],
        revertMessageID: null,
        revertDiff: null
      })

      let managerListener: any
      internalManager.on = vi.fn().mockImplementation((_: string, handler: any) => {
        managerListener = handler
      })
      ;(impl as any).attachManagerListener()

      managerListener({
        id: 'evt-2',
        kind: 'request',
        provider: 'codex',
        threadId: 'thread-q-1',
        createdAt: new Date().toISOString(),
        method: 'item/commandExecution/requestApproval',
        requestId: 'req-a-1',
        payload: { command: 'rm -rf /' }
      })

      const sendCalls = mockWindow.webContents.send.mock.calls
      const streamCalls = sendCalls
        .filter((c: any[]) => c[0] === 'opencode:stream')
        .map((c: any[]) => c[1])

      const approvalEvent = streamCalls.find((e: any) => e.type === 'permission.asked')
      expect(approvalEvent).toBeDefined()
      expect(approvalEvent.sessionId).toBe('hive-q-1')
      expect(approvalEvent.data.id).toBe('req-a-1')
      expect(approvalEvent.data.permission).toBe('bash')
      expect(approvalEvent.data.patterns).toEqual(['rm -rf /'])

      // Verify it was tracked in pending approvals
      expect(impl.getPendingApprovalSessions().has('req-a-1')).toBe(true)
    })

    it('ignores events for unknown threads', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()
      const internalManager = impl.getManager() as any
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      }
      impl.setMainWindow(mockWindow as any)

      let managerListener: any
      internalManager.on = vi.fn().mockImplementation((_: string, handler: any) => {
        managerListener = handler
      })
      ;(impl as any).attachManagerListener()

      // Event for unknown thread
      managerListener({
        id: 'evt-3',
        kind: 'request',
        provider: 'codex',
        threadId: 'unknown-thread',
        createdAt: new Date().toISOString(),
        method: 'item/tool/requestUserInput',
        requestId: 'req-x',
        payload: { questions: [] }
      })

      // Nothing should be sent to renderer
      expect(mockWindow.webContents.send).not.toHaveBeenCalled()
    })
  })
})

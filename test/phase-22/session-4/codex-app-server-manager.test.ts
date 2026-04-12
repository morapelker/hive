/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
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

vi.mock('node:readline', () => {
  const createInterface = vi.fn(() => ({
    on: vi.fn(),
    close: vi.fn(),
    removeAllListeners: vi.fn()
  }))

  return {
    default: { createInterface },
    createInterface
  }
})

import {
  CodexAppServerManager,
  classifyCodexStderrLine,
  isRecoverableThreadResumeError,
  isServerRequest,
  isServerNotification,
  isResponse,
  killChildTree,
  type CodexSessionContext,
  type CodexProviderSession
} from '../../../src/main/services/codex-app-server-manager'
import { toJsonSnapshot } from '../../../src/main/services/codex-utils'

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
  stdout: PassThrough
  stderr: PassThrough
} {
  const { child, stdin, stdout, stderr } = createMockChild()

  // Use a mock readline interface to avoid open handle issues in jsdom
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

  return { context, child, stdin, stdout, stderr }
}

// ── Tests ───────────────────────────────────────────────────────────

describe('CodexAppServerManager', () => {
  let manager: CodexAppServerManager

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new CodexAppServerManager()
  })

  afterEach(() => {
    manager.stopAll()
    manager.removeAllListeners()
  })

  // ── Type guards ─────────────────────────────────────────────────

  describe('type guards', () => {
    describe('isServerRequest', () => {
      it('returns true for valid request (method + id)', () => {
        expect(isServerRequest({ id: 1, method: 'turn/started', params: {} })).toBe(true)
      })

      it('returns true for string id', () => {
        expect(isServerRequest({ id: 'req-1', method: 'turn/started' })).toBe(true)
      })

      it('returns false for notification (method + no id)', () => {
        expect(isServerRequest({ method: 'turn/started', params: {} })).toBe(false)
      })

      it('returns false for response (id + no method)', () => {
        expect(isServerRequest({ id: 1, result: {} })).toBe(false)
      })

      it('returns false for null', () => {
        expect(isServerRequest(null)).toBe(false)
      })

      it('returns false for string', () => {
        expect(isServerRequest('hello')).toBe(false)
      })
    })

    describe('isServerNotification', () => {
      it('returns true for valid notification (method + no id)', () => {
        expect(isServerNotification({ method: 'turn/completed', params: {} })).toBe(true)
      })

      it('returns false for request (method + id)', () => {
        expect(isServerNotification({ id: 1, method: 'turn/completed' })).toBe(false)
      })

      it('returns false for response (id + no method)', () => {
        expect(isServerNotification({ id: 1, result: {} })).toBe(false)
      })

      it('returns false for null', () => {
        expect(isServerNotification(null)).toBe(false)
      })
    })

    describe('isResponse', () => {
      it('returns true for valid response (id + no method)', () => {
        expect(isResponse({ id: 1, result: { ok: true } })).toBe(true)
      })

      it('returns true for error response', () => {
        expect(isResponse({ id: 1, error: { code: -1, message: 'failed' } })).toBe(true)
      })

      it('returns false for request (method + id)', () => {
        expect(isResponse({ id: 1, method: 'test' })).toBe(false)
      })

      it('returns false for notification (method + no id)', () => {
        expect(isResponse({ method: 'test' })).toBe(false)
      })

      it('returns false for null', () => {
        expect(isResponse(null)).toBe(false)
      })
    })
  })

  // ── Stderr classification ───────────────────────────────────────

  describe('classifyCodexStderrLine', () => {
    it('returns null for empty line', () => {
      expect(classifyCodexStderrLine('')).toBeNull()
    })

    it('returns null for whitespace-only line', () => {
      expect(classifyCodexStderrLine('   \t  ')).toBeNull()
    })

    it('returns null for non-ERROR log levels (INFO)', () => {
      expect(
        classifyCodexStderrLine('2025-01-01T00:00:00Z INFO mod: informational')
      ).toBeNull()
    })

    it('returns null for DEBUG log level', () => {
      expect(
        classifyCodexStderrLine('2025-01-01T00:00:00Z DEBUG mod: debug message')
      ).toBeNull()
    })

    it('returns null for WARN log level', () => {
      expect(
        classifyCodexStderrLine('2025-01-01T00:00:00Z WARN mod: warning')
      ).toBeNull()
    })

    it('returns null for benign error: rollout path', () => {
      expect(
        classifyCodexStderrLine(
          '2025-01-01T00:00:00Z ERROR mod: state db missing rollout path for thread xyz'
        )
      ).toBeNull()
    })

    it('returns null for benign error: fallback', () => {
      expect(
        classifyCodexStderrLine(
          '2025-01-01T00:00:00Z ERROR mod: state db record_discrepancy: find_thread_path_by_id_str_in_subdir, falling_back'
        )
      ).toBeNull()
    })

    it('returns message for real ERROR log', () => {
      const result = classifyCodexStderrLine(
        '2025-01-01T00:00:00Z ERROR mod: something broke badly'
      )
      expect(result).not.toBeNull()
      expect(result!.message).toContain('something broke badly')
    })

    it('returns message for non-log stderr output', () => {
      const result = classifyCodexStderrLine('Permission denied: /usr/local/bin/codex')
      expect(result).not.toBeNull()
      expect(result!.message).toBe('Permission denied: /usr/local/bin/codex')
    })

    it('strips ANSI escape codes', () => {
      const result = classifyCodexStderrLine('\x1b[31mSome error\x1b[0m')
      expect(result).not.toBeNull()
      expect(result!.message).toBe('Some error')
    })

    it('returns null after stripping ANSI codes leaves empty string', () => {
      expect(classifyCodexStderrLine('\x1b[31m\x1b[0m')).toBeNull()
    })
  })

  // ── Recoverable resume error ────────────────────────────────────

  describe('isRecoverableThreadResumeError', () => {
    it('returns false for non-resume errors', () => {
      expect(isRecoverableThreadResumeError(new Error('something failed'))).toBe(false)
    })

    it('returns true for "thread/resume not found"', () => {
      expect(
        isRecoverableThreadResumeError(new Error('thread/resume failed: not found'))
      ).toBe(true)
    })

    it('returns true for "thread/resume missing thread"', () => {
      expect(
        isRecoverableThreadResumeError(new Error('thread/resume: missing thread'))
      ).toBe(true)
    })

    it('returns true for "thread/resume no such thread"', () => {
      expect(
        isRecoverableThreadResumeError(new Error('thread/resume: no such thread abc'))
      ).toBe(true)
    })

    it('returns true for "thread/resume unknown thread"', () => {
      expect(
        isRecoverableThreadResumeError(new Error('thread/resume: unknown thread id'))
      ).toBe(true)
    })

    it('returns true for "thread/resume does not exist"', () => {
      expect(
        isRecoverableThreadResumeError(new Error('thread/resume: thread does not exist'))
      ).toBe(true)
    })

    it('handles string values', () => {
      expect(isRecoverableThreadResumeError('thread/resume: not found')).toBe(true)
      expect(isRecoverableThreadResumeError('random error')).toBe(false)
    })
  })

  describe('toJsonSnapshot', () => {
    it('returns a stable string for undefined', () => {
      expect(toJsonSnapshot(undefined, 50)).toBe('undefined')
    })

    it('stringifies plain objects', () => {
      expect(toJsonSnapshot({ ok: true }, 50)).toBe('{"ok":true}')
    })

    it('truncates long snapshots', () => {
      expect(toJsonSnapshot({ text: 'abcdefghij' }, 10)).toBe('{"text":"a')
    })

    it('falls back safely for circular objects', () => {
      const circular: Record<string, unknown> = {}
      circular.self = circular

      expect(() => toJsonSnapshot(circular, 50)).not.toThrow()
      expect(toJsonSnapshot(circular, 50)).toBe('[object Object]')
    })
  })

  // ── sendRequest ─────────────────────────────────────────────────

  describe('sendRequest', () => {
    it('resolves when matching response arrives', async () => {
      const { context } = createTestContext()

      const promise = manager.sendRequest(context, 'test/method', { key: 'value' })
      manager.handleStdoutLine(context, JSON.stringify({ id: 1, result: { ok: true } }))

      const result = await promise
      expect(result).toEqual({ ok: true })
    })

    it('rejects on timeout', async () => {
      const { context } = createTestContext()

      const promise = manager.sendRequest(context, 'slow/method', {}, 50)
      await expect(promise).rejects.toThrow('Timed out waiting for slow/method.')
    })

    it('rejects on JSON-RPC error response', async () => {
      const { context } = createTestContext()

      const promise = manager.sendRequest(context, 'test/method', {})
      manager.handleStdoutLine(
        context,
        JSON.stringify({ id: 1, error: { code: -1, message: 'bad request' } })
      )

      await expect(promise).rejects.toThrow('test/method failed: bad request')
    })

    it('auto-increments request IDs', async () => {
      const { context } = createTestContext()

      const p1 = manager.sendRequest(context, 'method1', {}, 100)
      expect(context.nextRequestId).toBe(2)
      manager.handleStdoutLine(context, JSON.stringify({ id: 1, result: {} }))
      await p1

      const p2 = manager.sendRequest(context, 'method2', {}, 100)
      expect(context.nextRequestId).toBe(3)
      manager.handleStdoutLine(context, JSON.stringify({ id: 2, result: {} }))
      await p2
    })

    it('writes JSON to child stdin with newline', async () => {
      const { context, child } = createTestContext()
      const writeSpy = vi.spyOn(child.stdin, 'write')

      const promise = manager.sendRequest(context, 'test/method', { key: 'val' })

      expect(writeSpy).toHaveBeenCalledTimes(1)
      const written = writeSpy.mock.calls[0][0] as string
      expect(written.endsWith('\n')).toBe(true)

      const parsed = JSON.parse(written.trim())
      expect(parsed.method).toBe('test/method')
      expect(parsed.id).toBe(1)
      expect(parsed.params).toEqual({ key: 'val' })

      manager.handleStdoutLine(context, JSON.stringify({ id: 1, result: {} }))
      await promise
    })
  })

  // ── Message routing ─────────────────────────────────────────────

  describe('handleStdoutLine', () => {
    it('emits event for notifications', () => {
      const { context } = createTestContext()
      const events: any[] = []
      manager.on('event', (event) => events.push(event))

      manager.handleStdoutLine(
        context,
        JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'hello' } })
      )

      expect(events).toHaveLength(1)
      expect(events[0].kind).toBe('notification')
      expect(events[0].method).toBe('item/agentMessage/delta')
    })

    it('emits event for notifications when params are omitted', () => {
      const { context } = createTestContext()
      const events: any[] = []
      manager.on('event', (event) => events.push(event))

      expect(() =>
        manager.handleStdoutLine(context, JSON.stringify({ method: 'process/stderr' }))
      ).not.toThrow()

      expect(events).toHaveLength(1)
      expect(events[0].kind).toBe('notification')
      expect(events[0].method).toBe('process/stderr')
      expect(events[0].threadId).toBe('thread-123')
      expect(events[0].payload).toBeUndefined()
    })

    it('emits event for server requests', () => {
      const { context } = createTestContext()
      const events: any[] = []
      manager.on('event', (event) => events.push(event))

      manager.handleStdoutLine(
        context,
        JSON.stringify({
          id: 99,
          method: 'item/commandExecution/requestApproval',
          params: { command: 'rm -rf /' }
        })
      )

      expect(events).toHaveLength(1)
      expect(events[0].kind).toBe('request')
      expect(events[0].method).toBe('item/commandExecution/requestApproval')
    })

    it('tracks pending approval requests', () => {
      const { context } = createTestContext()

      manager.handleStdoutLine(
        context,
        JSON.stringify({
          id: 99,
          method: 'item/commandExecution/requestApproval',
          params: { command: 'echo test' }
        })
      )

      expect(context.pendingApprovals.size).toBe(1)
      const approval = [...context.pendingApprovals.values()][0]
      expect(approval.jsonRpcId).toBe(99)
      expect(approval.method).toBe('item/commandExecution/requestApproval')
    })

    it('tracks pending user input requests', () => {
      const { context } = createTestContext()

      manager.handleStdoutLine(
        context,
        JSON.stringify({
          id: 100,
          method: 'item/tool/requestUserInput',
          params: { questions: [{ id: 'q1', question: 'What?' }] }
        })
      )

      expect(context.pendingUserInputs.size).toBe(1)
    })

    it('resolves pending request on matching response', async () => {
      const { context } = createTestContext()

      const promise = manager.sendRequest(context, 'test/method', {})
      manager.handleStdoutLine(context, JSON.stringify({ id: 1, result: { data: 42 } }))

      const result = await promise
      expect(result).toEqual({ data: 42 })
      expect(context.pending.size).toBe(0)
    })

    it('emits error for invalid JSON', () => {
      const { context } = createTestContext()
      const events: any[] = []
      manager.on('event', (event) => events.push(event))

      manager.handleStdoutLine(context, 'not json at all')

      expect(events).toHaveLength(1)
      expect(events[0].kind).toBe('error')
      expect(events[0].method).toBe('protocol/parseError')
    })

    it('emits error for non-object JSON', () => {
      const { context } = createTestContext()
      const events: any[] = []
      manager.on('event', (event) => events.push(event))

      manager.handleStdoutLine(context, '"just a string"')

      expect(events).toHaveLength(1)
      expect(events[0].kind).toBe('error')
      expect(events[0].method).toBe('protocol/invalidMessage')
    })

    it('updates session status on turn/started notification', () => {
      const { context } = createTestContext({ status: 'ready' })

      manager.handleStdoutLine(
        context,
        JSON.stringify({
          method: 'turn/started',
          params: { turn: { id: 'turn-1' } }
        })
      )

      expect(context.session.status).toBe('running')
      expect(context.session.activeTurnId).toBe('turn-1')
    })

    it('updates session status on turn/completed notification', () => {
      const { context } = createTestContext({ status: 'running', activeTurnId: 'turn-1' })

      manager.handleStdoutLine(
        context,
        JSON.stringify({
          method: 'turn/completed',
          params: { turn: { id: 'turn-1', status: 'completed' } }
        })
      )

      expect(context.session.status).toBe('ready')
      expect(context.session.activeTurnId).toBeNull()
    })

    it('sets error status on turn/completed with failed status', () => {
      const { context } = createTestContext({ status: 'running', activeTurnId: 'turn-1' })

      manager.handleStdoutLine(
        context,
        JSON.stringify({
          method: 'turn/completed',
          params: { turn: { id: 'turn-1', status: 'failed' } }
        })
      )

      expect(context.session.status).toBe('error')
    })

    // ── Session 4: Typed notification params ──────────────────────

    it('handles turn/started with full TurnStartedNotification shape', () => {
      const { context } = createTestContext({ status: 'ready' })

      // Full TurnStartedNotification shape: { threadId, turn: Turn }
      manager.handleStdoutLine(
        context,
        JSON.stringify({
          method: 'turn/started',
          params: {
            threadId: 'thread-123',
            turn: {
              id: 'turn-typed-1',
              items: [],
              status: 'inProgress',
              error: null,
              startedAt: 1712000000,
              completedAt: null,
              durationMs: null
            }
          }
        })
      )

      expect(context.session.status).toBe('running')
      expect(context.session.activeTurnId).toBe('turn-typed-1')
    })

    it('handles turn/completed with full TurnCompletedNotification shape', () => {
      const { context } = createTestContext({ status: 'running', activeTurnId: 'turn-typed-2' })

      // Full TurnCompletedNotification shape: { threadId, turn: Turn }
      manager.handleStdoutLine(
        context,
        JSON.stringify({
          method: 'turn/completed',
          params: {
            threadId: 'thread-123',
            turn: {
              id: 'turn-typed-2',
              items: [],
              status: 'completed',
              error: null,
              startedAt: 1712000000,
              completedAt: 1712000060,
              durationMs: 60000
            }
          }
        })
      )

      expect(context.session.status).toBe('ready')
      expect(context.session.activeTurnId).toBeNull()
    })

    it('handles turn/completed with failed status and error in full Turn shape', () => {
      const { context } = createTestContext({ status: 'running', activeTurnId: 'turn-typed-3' })

      manager.handleStdoutLine(
        context,
        JSON.stringify({
          method: 'turn/completed',
          params: {
            threadId: 'thread-123',
            turn: {
              id: 'turn-typed-3',
              items: [],
              status: 'failed',
              error: { code: 'model_error', message: 'Something went wrong' },
              startedAt: 1712000000,
              completedAt: 1712000010,
              durationMs: 10000
            }
          }
        })
      )

      expect(context.session.status).toBe('error')
      expect(context.session.activeTurnId).toBeNull()
    })

    // ── Session 4: Typed request params ─────────────────────────

    it('tracks approval with typed CommandExecutionRequestApprovalParams', () => {
      const { context } = createTestContext()

      // Full CommandExecutionRequestApprovalParams shape
      manager.handleStdoutLine(
        context,
        JSON.stringify({
          id: 200,
          method: 'item/commandExecution/requestApproval',
          params: {
            threadId: 'thread-123',
            turnId: 'turn-exec-1',
            itemId: 'item-exec-1',
            command: 'npm install',
            cwd: '/test/project',
            commandActions: null,
            availableDecisions: ['accept', 'acceptForSession', 'decline']
          }
        })
      )

      expect(context.pendingApprovals.size).toBe(1)
      const approval = [...context.pendingApprovals.values()][0]
      expect(approval.jsonRpcId).toBe(200)
      expect(approval.method).toBe('item/commandExecution/requestApproval')
      expect(approval.turnId).toBe('turn-exec-1')
      expect(approval.itemId).toBe('item-exec-1')
    })

    it('tracks approval with typed FileChangeRequestApprovalParams', () => {
      const { context } = createTestContext()

      // Full FileChangeRequestApprovalParams shape
      manager.handleStdoutLine(
        context,
        JSON.stringify({
          id: 201,
          method: 'item/fileChange/requestApproval',
          params: {
            threadId: 'thread-123',
            turnId: 'turn-fc-1',
            itemId: 'item-fc-1',
            reason: 'Write access to /etc/config'
          }
        })
      )

      expect(context.pendingApprovals.size).toBe(1)
      const approval = [...context.pendingApprovals.values()][0]
      expect(approval.turnId).toBe('turn-fc-1')
      expect(approval.itemId).toBe('item-fc-1')
    })

    it('tracks user input with typed ToolRequestUserInputParams', () => {
      const { context } = createTestContext()

      // Full ToolRequestUserInputParams shape
      manager.handleStdoutLine(
        context,
        JSON.stringify({
          id: 202,
          method: 'item/tool/requestUserInput',
          params: {
            threadId: 'thread-123',
            turnId: 'turn-ui-1',
            itemId: 'item-ui-1',
            questions: [
              { id: 'q1', question: 'What is the API key?' }
            ]
          }
        })
      )

      expect(context.pendingUserInputs.size).toBe(1)
      const input = [...context.pendingUserInputs.values()][0]
      expect(input.turnId).toBe('turn-ui-1')
      expect(input.itemId).toBe('item-ui-1')
    })

    it('extracts route fields from notification params', () => {
      const { context } = createTestContext()
      const events: any[] = []
      manager.on('event', (event) => events.push(event))

      manager.handleStdoutLine(
        context,
        JSON.stringify({
          method: 'item/agentMessage/created',
          params: { turnId: 'turn-42', itemId: 'item-7' }
        })
      )

      expect(events[0].turnId).toBe('turn-42')
      expect(events[0].itemId).toBe('item-7')
    })

    it('ignores response for unknown request ID', () => {
      const { context } = createTestContext()

      // Should not throw
      manager.handleStdoutLine(
        context,
        JSON.stringify({ id: 999, result: { data: 'orphan' } })
      )

      expect(context.pending.size).toBe(0)
    })

    it('emits error for unrecognized message shape', () => {
      const { context } = createTestContext()
      const events: any[] = []
      manager.on('event', (event) => events.push(event))

      manager.handleStdoutLine(context, JSON.stringify({ foo: 'bar' }))

      expect(events).toHaveLength(1)
      expect(events[0].kind).toBe('error')
      expect(events[0].method).toBe('protocol/unrecognizedMessage')
    })
  })

  // ── stopSession ─────────────────────────────────────────────────

  describe('startSession', () => {
    it('starts fresh sessions in full-access mode', async () => {
      const child = new EventEmitter() as any
      child.stdin = { writable: true, write: vi.fn() }
      child.stdout = {}
      child.stderr = { on: vi.fn() }
      child.pid = 12345
      child.killed = false
      child.kill = vi.fn(() => {
        child.killed = true
      })
      vi.mocked(spawn).mockReturnValue(child)

      const sendRequestSpy = vi
        .spyOn(manager, 'sendRequest')
        .mockResolvedValueOnce({} as never)
        .mockResolvedValueOnce({} as never)
        .mockResolvedValueOnce({ thread: { id: 'thread-live-1' } } as never)

      const session = await manager.startSession({
        cwd: '/test/project',
        model: 'gpt-5.4'
      })

      expect(session.threadId).toBe('thread-live-1')
      expect(sendRequestSpy).toHaveBeenNthCalledWith(
        3,
        expect.anything(),
        'thread/start',
        expect.objectContaining({
          model: 'gpt-5.4',
          cwd: '/test/project',
          approvalPolicy: 'never',
          sandbox: 'danger-full-access'
        })
      )
    })

    it('resumes sessions in full-access mode', async () => {
      const child = new EventEmitter() as any
      child.stdin = { writable: true, write: vi.fn() }
      child.stdout = {}
      child.stderr = { on: vi.fn() }
      child.pid = 12345
      child.killed = false
      child.kill = vi.fn(() => {
        child.killed = true
      })
      vi.mocked(spawn).mockReturnValue(child)

      const sendRequestSpy = vi
        .spyOn(manager, 'sendRequest')
        .mockResolvedValueOnce({} as never)
        .mockResolvedValueOnce({} as never)
        .mockResolvedValueOnce({ thread: { id: 'thread-live-2' } } as never)

      const session = await manager.startSession({
        cwd: '/test/project',
        model: 'gpt-5.4',
        resumeThreadId: 'thread-live-2'
      })

      expect(session.threadId).toBe('thread-live-2')
      expect(sendRequestSpy).toHaveBeenNthCalledWith(
        3,
        expect.anything(),
        'thread/resume',
        expect.objectContaining({
          threadId: 'thread-live-2',
          model: 'gpt-5.4',
          cwd: '/test/project',
          approvalPolicy: 'never',
          sandbox: 'danger-full-access'
        })
      )
    })
  })

  describe('stopSession', () => {
    it('rejects all pending requests', () => {
      const { context } = createTestContext()

      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      sessionsMap.set('thread-123', context)

      let rejected = false
      context.pending.set('1', {
        method: 'test',
        timeout: setTimeout(() => {}, 60000),
        resolve: vi.fn(),
        reject: () => {
          rejected = true
        }
      })

      manager.stopSession('thread-123')

      expect(rejected).toBe(true)
      expect(context.pending.size).toBe(0)
    })

    it('kills child process', () => {
      const { context, child } = createTestContext()

      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      sessionsMap.set('thread-123', context)

      manager.stopSession('thread-123')

      expect(child.kill).toHaveBeenCalled()
    })

    it('removes session from map', () => {
      const { context } = createTestContext()

      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      sessionsMap.set('thread-123', context)

      expect(manager.hasSession('thread-123')).toBe(true)
      manager.stopSession('thread-123')
      expect(manager.hasSession('thread-123')).toBe(false)
    })

    it('sets session status to closed', () => {
      const { context } = createTestContext()

      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      sessionsMap.set('thread-123', context)

      manager.stopSession('thread-123')

      expect(context.session.status).toBe('closed')
    })

    it('clears pending approvals and user inputs', () => {
      const { context } = createTestContext()

      context.pendingApprovals.set('a1', {
        requestId: 'a1',
        jsonRpcId: 1,
        method: 'item/commandExecution/requestApproval',
        threadId: 'thread-123'
      })
      context.pendingUserInputs.set('u1', {
        requestId: 'u1',
        jsonRpcId: 2,
        threadId: 'thread-123'
      })

      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      sessionsMap.set('thread-123', context)

      manager.stopSession('thread-123')

      expect(context.pendingApprovals.size).toBe(0)
      expect(context.pendingUserInputs.size).toBe(0)
    })

    it('is a no-op for unknown thread IDs', () => {
      expect(() => manager.stopSession('nonexistent')).not.toThrow()
    })

    it('emits session/closed event', () => {
      const { context } = createTestContext()
      const events: any[] = []
      manager.on('event', (event) => events.push(event))

      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      sessionsMap.set('thread-123', context)

      manager.stopSession('thread-123')

      const closedEvent = events.find((e: any) => e.method === 'session/closed')
      expect(closedEvent).toBeDefined()
      expect(closedEvent.kind).toBe('session')
      expect(closedEvent.provider).toBe('codex')
    })
  })

  // ── stopAll ─────────────────────────────────────────────────────

  describe('stopAll', () => {
    it('stops all sessions', () => {
      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>

      const { context: ctx1 } = createTestContext({ threadId: 't1' })
      const { context: ctx2 } = createTestContext({ threadId: 't2' })
      sessionsMap.set('t1', ctx1)
      sessionsMap.set('t2', ctx2)

      manager.stopAll()

      expect(sessionsMap.size).toBe(0)
    })
  })

  // ── killChildTree ───────────────────────────────────────────────

  describe('killChildTree', () => {
    it('calls child.kill() on non-Windows platforms', () => {
      const { child } = createMockChild()

      killChildTree(child)

      expect(child.kill).toHaveBeenCalled()
    })
  })

  // ── Session 4: respondToUserInput with ToolRequestUserInputAnswer ──

  describe('respondToUserInput', () => {
    it('sends answers in ToolRequestUserInputAnswer format { answers: string[] }', () => {
      const { context, child } = createTestContext()
      const writeSpy = vi.spyOn(child.stdin, 'write')

      // Register session in manager
      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      sessionsMap.set('thread-123', context)

      // Simulate a pending user input request
      context.pendingUserInputs.set('req-ui-1', {
        requestId: 'req-ui-1',
        jsonRpcId: 42,
        threadId: 'thread-123',
        turnId: 'turn-1',
        itemId: 'item-1'
      })

      manager.respondToUserInput('thread-123', 'req-ui-1', [
        { id: 'q1', answer: 'my-api-key' },
        { id: 'q2', answer: 'us-east-1' }
      ])

      expect(writeSpy).toHaveBeenCalled()
      const written = JSON.parse((writeSpy.mock.calls[0][0] as string).trim())

      // Verify the format matches ToolRequestUserInputAnswer: { answers: string[] }
      expect(written.id).toBe(42)
      expect(written.result.answers).toEqual({
        q1: { answers: ['my-api-key'] },
        q2: { answers: ['us-east-1'] }
      })
    })

    it('removes pending user input after responding', () => {
      const { context } = createTestContext()

      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      sessionsMap.set('thread-123', context)

      context.pendingUserInputs.set('req-ui-2', {
        requestId: 'req-ui-2',
        jsonRpcId: 43,
        threadId: 'thread-123'
      })

      manager.respondToUserInput('thread-123', 'req-ui-2', [
        { id: 'q1', answer: 'yes' }
      ])

      expect(context.pendingUserInputs.size).toBe(0)
    })

    it('emits answered event with answer payload', () => {
      const { context } = createTestContext()
      const events: any[] = []
      manager.on('event', (event) => events.push(event))

      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      sessionsMap.set('thread-123', context)

      context.pendingUserInputs.set('req-ui-3', {
        requestId: 'req-ui-3',
        jsonRpcId: 44,
        threadId: 'thread-123'
      })

      manager.respondToUserInput('thread-123', 'req-ui-3', [
        { id: 'q1', answer: 'answer-val' }
      ])

      const answered = events.find((e: any) => e.method === 'item/tool/requestUserInput/answered')
      expect(answered).toBeDefined()
      expect(answered.requestId).toBe('req-ui-3')
      expect(answered.payload.answers).toEqual({
        q1: { answers: ['answer-val'] }
      })
    })

    it('throws for unknown threadId', () => {
      expect(() => {
        manager.respondToUserInput('nonexistent', 'req-1', [{ id: 'q1', answer: 'x' }])
      }).toThrow('no session for threadId=nonexistent')
    })

    it('throws for unknown requestId', () => {
      const { context } = createTestContext()

      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      sessionsMap.set('thread-123', context)

      expect(() => {
        manager.respondToUserInput('thread-123', 'req-missing', [{ id: 'q1', answer: 'x' }])
      }).toThrow('no pending user input for requestId=req-missing')
    })
  })

  // ── Session queries ─────────────────────────────────────────────

  describe('session queries', () => {
    it('hasSession returns false for unknown threads', () => {
      expect(manager.hasSession('nonexistent')).toBe(false)
    })

    it('getSession returns undefined for unknown threads', () => {
      expect(manager.getSession('nonexistent')).toBeUndefined()
    })

    it('listSessions returns empty array initially', () => {
      expect(manager.listSessions()).toEqual([])
    })

    it('getSession returns a copy of the session', () => {
      const { context } = createTestContext()
      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      sessionsMap.set('thread-123', context)

      const session = manager.getSession('thread-123')
      expect(session).toBeDefined()
      expect(session!.threadId).toBe('thread-123')
      expect(session!.provider).toBe('codex')
      expect(session).not.toBe(context.session)
    })

    it('listSessions returns all active sessions', () => {
      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      const { context: ctx1 } = createTestContext({ threadId: 'thread-a' })
      const { context: ctx2 } = createTestContext({ threadId: 'thread-b' })
      sessionsMap.set('thread-a', ctx1)
      sessionsMap.set('thread-b', ctx2)

      const list = manager.listSessions()
      expect(list).toHaveLength(2)
      const ids = list.map((s) => s.threadId)
      expect(ids).toContain('thread-a')
      expect(ids).toContain('thread-b')
    })
  })
})

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
    threadId: 'thread-undo-1',
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

describe('Codex Undo/Redo', () => {
  let manager: CodexAppServerManager

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new CodexAppServerManager()
  })

  // ── Manager rollbackThread ──────────────────────────────────────

  describe('rollbackThread', () => {
    it('sends thread/rollback JSON-RPC request with correct params', async () => {
      const { context, child } = createTestContext()
      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      sessionsMap.set('thread-undo-1', context)

      const writeSpy = vi.spyOn(child.stdin, 'write')

      const rollbackPromise = manager.rollbackThread('thread-undo-1', 1)
      const requestWritten = JSON.parse((writeSpy.mock.calls[0][0] as string).trim())

      expect(requestWritten.method).toBe('thread/rollback')
      expect(requestWritten.params.threadId).toBe('thread-undo-1')
      expect(requestWritten.params.numTurns).toBe(1)

      // Simulate response
      manager.handleStdoutLine(context, JSON.stringify({
        id: requestWritten.id,
        result: { thread: { id: 'thread-undo-1', turns: [] } }
      }))

      const result = await rollbackPromise
      expect(result).toBeDefined()
    })

    it('updates session status to ready and clears activeTurnId', async () => {
      const { context, child } = createTestContext({
        status: 'running',
        activeTurnId: 'turn-active-1'
      })
      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      sessionsMap.set('thread-undo-1', context)

      const writeSpy = vi.spyOn(child.stdin, 'write')

      const rollbackPromise = manager.rollbackThread('thread-undo-1', 1)
      const requestWritten = JSON.parse((writeSpy.mock.calls[0][0] as string).trim())

      manager.handleStdoutLine(context, JSON.stringify({
        id: requestWritten.id,
        result: { ok: true }
      }))

      await rollbackPromise

      expect(context.session.status).toBe('ready')
      expect(context.session.activeTurnId).toBeNull()
    })

    it('emits thread/rolledBack lifecycle event', async () => {
      const { context, child } = createTestContext()
      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      sessionsMap.set('thread-undo-1', context)

      const events: any[] = []
      manager.on('event', (event) => events.push(event))

      const writeSpy = vi.spyOn(child.stdin, 'write')

      const rollbackPromise = manager.rollbackThread('thread-undo-1', 1)
      const requestWritten = JSON.parse((writeSpy.mock.calls[0][0] as string).trim())

      manager.handleStdoutLine(context, JSON.stringify({
        id: requestWritten.id,
        result: { ok: true }
      }))

      await rollbackPromise

      const rollbackEvent = events.find((e) => e.method === 'thread/rolledBack')
      expect(rollbackEvent).toBeDefined()
      expect(rollbackEvent.message).toContain('1 turn(s)')
    })

    it('throws when threadId is unknown', async () => {
      await expect(
        manager.rollbackThread('nonexistent', 1)
      ).rejects.toThrow('no session for threadId')
    })

    it('throws when numTurns is not a positive integer', async () => {
      const { context } = createTestContext()
      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      sessionsMap.set('thread-undo-1', context)

      await expect(
        manager.rollbackThread('thread-undo-1', 0)
      ).rejects.toThrow('numTurns must be an integer >= 1')

      await expect(
        manager.rollbackThread('thread-undo-1', -1)
      ).rejects.toThrow('numTurns must be an integer >= 1')

      await expect(
        manager.rollbackThread('thread-undo-1', 1.5)
      ).rejects.toThrow('numTurns must be an integer >= 1')
    })

    it('supports rolling back multiple turns', async () => {
      const { context, child } = createTestContext()
      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      sessionsMap.set('thread-undo-1', context)

      const writeSpy = vi.spyOn(child.stdin, 'write')

      const rollbackPromise = manager.rollbackThread('thread-undo-1', 3)
      const requestWritten = JSON.parse((writeSpy.mock.calls[0][0] as string).trim())

      expect(requestWritten.params.numTurns).toBe(3)

      manager.handleStdoutLine(context, JSON.stringify({
        id: requestWritten.id,
        result: { ok: true }
      }))

      await rollbackPromise
    })
  })

  // ── CodexImplementer.undo ─────────────────────────────────────────

  describe('CodexImplementer.undo', () => {
    it('calls manager.rollbackThread and returns correct shape', async () => {
      const { CodexImplementer } = await import(
        '../../../src/main/services/codex-implementer'
      )
      const impl = new CodexImplementer()
      const internalManager = impl.getManager() as any
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      }
      impl.setMainWindow(mockWindow as any)

      const session = {
        threadId: 'thread-undo-1',
        hiveSessionId: 'hive-undo-1',
        worktreePath: '/test',
        status: 'ready' as const,
        messages: [
          {
            role: 'user',
            parts: [{ type: 'text', text: 'Fix the bug', timestamp: '2026-01-01T00:00:00Z' }],
            timestamp: '2026-01-01T00:00:00Z'
          },
          {
            role: 'assistant',
            parts: [{ type: 'text', text: 'Done', timestamp: '2026-01-01T00:00:01Z' }],
            timestamp: '2026-01-01T00:00:01Z'
          }
        ],
        revertMessageID: null,
        revertDiff: null
      }
      impl.getSessions().set('/test::thread-undo-1', session)

      internalManager.rollbackThread = vi.fn().mockResolvedValue({
        thread: { id: 'thread-undo-1', turns: [] }
      })

      const result = await impl.undo('/test', 'thread-undo-1', 'hive-undo-1')

      expect(internalManager.rollbackThread).toHaveBeenCalledWith('thread-undo-1', 1)
      expect(result).toHaveProperty('revertMessageID')
      expect(result).toHaveProperty('restoredPrompt', 'Fix the bug')
      expect(result).toHaveProperty('revertDiff', null)
    })

    it('updates session revert state after undo', async () => {
      const { CodexImplementer } = await import(
        '../../../src/main/services/codex-implementer'
      )
      const impl = new CodexImplementer()
      const internalManager = impl.getManager() as any
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      }
      impl.setMainWindow(mockWindow as any)

      const session = {
        threadId: 'thread-undo-1',
        hiveSessionId: 'hive-undo-1',
        worktreePath: '/test',
        status: 'ready' as const,
        messages: [
          {
            role: 'user',
            parts: [{ type: 'text', text: 'Hello' }],
            timestamp: '2026-01-01T00:00:00Z'
          },
          {
            role: 'assistant',
            parts: [{ type: 'text', text: 'Hi' }],
            timestamp: '2026-01-01T00:00:01Z'
          }
        ],
        revertMessageID: null,
        revertDiff: null
      }
      impl.getSessions().set('/test::thread-undo-1', session)

      internalManager.rollbackThread = vi.fn().mockResolvedValue({ ok: true })

      await impl.undo('/test', 'thread-undo-1', 'hive-undo-1')

      expect(session.revertMessageID).toBeTruthy()
      expect(session.revertDiff).toBeNull()
      expect(session.messages).toHaveLength(0) // Both messages popped
    })

    it('emits session.updated event to renderer', async () => {
      const { CodexImplementer } = await import(
        '../../../src/main/services/codex-implementer'
      )
      const impl = new CodexImplementer()
      const internalManager = impl.getManager() as any
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      }
      impl.setMainWindow(mockWindow as any)

      impl.getSessions().set('/test::thread-undo-1', {
        threadId: 'thread-undo-1',
        hiveSessionId: 'hive-undo-1',
        worktreePath: '/test',
        status: 'ready',
        messages: [
          { role: 'user', parts: [{ type: 'text', text: 'Test' }], timestamp: '2026-01-01' },
          { role: 'assistant', parts: [{ type: 'text', text: 'OK' }], timestamp: '2026-01-01' }
        ],
        revertMessageID: null,
        revertDiff: null
      })

      internalManager.rollbackThread = vi.fn().mockResolvedValue({ ok: true })

      await impl.undo('/test', 'thread-undo-1', 'hive-undo-1')

      const sendCalls = mockWindow.webContents.send.mock.calls
      const streamCalls = sendCalls
        .filter((c: any[]) => c[0] === 'opencode:stream')
        .map((c: any[]) => c[1])

      const updateEvent = streamCalls.find((e: any) => e.type === 'session.updated')
      expect(updateEvent).toBeDefined()
      expect(updateEvent.data.revertMessageID).toBeTruthy()
    })

    it('throws for unknown session', async () => {
      const { CodexImplementer } = await import(
        '../../../src/main/services/codex-implementer'
      )
      const impl = new CodexImplementer()

      await expect(
        impl.undo('/unknown', 'thread-x', 'hive-x')
      ).rejects.toThrow('session not found')
    })

    it('throws when no messages to undo', async () => {
      const { CodexImplementer } = await import(
        '../../../src/main/services/codex-implementer'
      )
      const impl = new CodexImplementer()

      impl.getSessions().set('/test::thread-undo-1', {
        threadId: 'thread-undo-1',
        hiveSessionId: 'hive-undo-1',
        worktreePath: '/test',
        status: 'ready',
        messages: [],
        revertMessageID: null,
        revertDiff: null
      })

      await expect(
        impl.undo('/test', 'thread-undo-1', 'hive-undo-1')
      ).rejects.toThrow('Nothing to undo')
    })

    it('preserves earlier messages when undoing the last exchange', async () => {
      const { CodexImplementer } = await import(
        '../../../src/main/services/codex-implementer'
      )
      const impl = new CodexImplementer()
      const internalManager = impl.getManager() as any
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      }
      impl.setMainWindow(mockWindow as any)

      const session = {
        threadId: 'thread-undo-1',
        hiveSessionId: 'hive-undo-1',
        worktreePath: '/test',
        status: 'ready' as const,
        messages: [
          { role: 'user', parts: [{ type: 'text', text: 'First' }], timestamp: '2026-01-01' },
          {
            id: 'msg-1',
            role: 'assistant',
            parts: [{ type: 'text', text: 'Reply 1' }],
            timestamp: '2026-01-01'
          },
          { role: 'user', parts: [{ type: 'text', text: 'Second' }], timestamp: '2026-01-02' },
          { role: 'assistant', parts: [{ type: 'text', text: 'Reply 2' }], timestamp: '2026-01-02' }
        ],
        revertMessageID: null,
        revertDiff: null
      }
      impl.getSessions().set('/test::thread-undo-1', session)

      internalManager.rollbackThread = vi.fn().mockResolvedValue({ ok: true })

      const result = await impl.undo('/test', 'thread-undo-1', 'hive-undo-1')

      // First exchange should remain, second should be removed
      expect(session.messages).toHaveLength(2)
      expect((session.messages[0] as any).role).toBe('user')
      expect((session.messages[1] as any).role).toBe('assistant')
      expect(result.restoredPrompt).toBe('Second')
    })
  })

  // ── CodexImplementer.redo ─────────────────────────────────────────

  describe('CodexImplementer.redo', () => {
    it('throws unsupported error', async () => {
      const { CodexImplementer } = await import(
        '../../../src/main/services/codex-implementer'
      )
      const impl = new CodexImplementer()

      await expect(
        impl.redo('/test', 'thread-1', 'hive-1')
      ).rejects.toThrow('Redo is not supported for Codex sessions')
    })
  })
})

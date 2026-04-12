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

vi.mock('../../../src/main/services/git-service', () => ({
  autoRenameWorktreeBranch: vi.fn()
}))

import {
  CodexAppServerManager,
  type CodexSessionContext,
  type CodexProviderSession,
  type PendingApprovalRequest
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
    threadId: 'thread-perm-1',
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

  return { context, child, stdin }
}

// ── Tests ───────────────────────────────────────────────────────────

describe('Codex Permission Requests', () => {
  let manager: CodexAppServerManager

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new CodexAppServerManager()
  })

  // ── respondToApproval ───────────────────────────────────────────

  describe('respondToApproval', () => {
    it('sends correct JSON-RPC response with "once" decision', () => {
      const { context, child } = createTestContext()
      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      sessionsMap.set('thread-perm-1', context)

      const writeSpy = vi.spyOn(child.stdin, 'write')

      context.pendingApprovals.set('req-1', {
        requestId: 'req-1',
        jsonRpcId: 42,
        method: 'item/commandExecution/requestApproval',
        threadId: 'thread-perm-1'
      })

      manager.respondToApproval('thread-perm-1', 'req-1', 'once')

      expect(writeSpy).toHaveBeenCalledTimes(1)
      const written = JSON.parse((writeSpy.mock.calls[0][0] as string).trim())
      expect(written).toEqual({
        jsonrpc: '2.0',
        id: 42,
        result: { decision: 'accept' }
      })
    })

    it('sends correct JSON-RPC response with "always" decision', () => {
      const { context, child } = createTestContext()
      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      sessionsMap.set('thread-perm-1', context)

      const writeSpy = vi.spyOn(child.stdin, 'write')

      context.pendingApprovals.set('req-2', {
        requestId: 'req-2',
        jsonRpcId: 99,
        method: 'item/fileChange/requestApproval',
        threadId: 'thread-perm-1'
      })

      manager.respondToApproval('thread-perm-1', 'req-2', 'always')

      const written = JSON.parse((writeSpy.mock.calls[0][0] as string).trim())
      expect(written.result.decision).toBe('acceptForSession')
    })

    it('sends correct JSON-RPC response with "reject" decision', () => {
      const { context, child } = createTestContext()
      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      sessionsMap.set('thread-perm-1', context)

      const writeSpy = vi.spyOn(child.stdin, 'write')

      context.pendingApprovals.set('req-3', {
        requestId: 'req-3',
        jsonRpcId: 77,
        method: 'item/fileRead/requestApproval',
        threadId: 'thread-perm-1'
      })

      manager.respondToApproval('thread-perm-1', 'req-3', 'reject')

      const written = JSON.parse((writeSpy.mock.calls[0][0] as string).trim())
      expect(written.result.decision).toBe('decline')
    })

    it('removes the approval from pendingApprovals after responding', () => {
      const { context } = createTestContext()
      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      sessionsMap.set('thread-perm-1', context)

      context.pendingApprovals.set('req-1', {
        requestId: 'req-1',
        jsonRpcId: 42,
        method: 'item/commandExecution/requestApproval',
        threadId: 'thread-perm-1'
      })

      manager.respondToApproval('thread-perm-1', 'req-1', 'once')

      expect(context.pendingApprovals.size).toBe(0)
    })

    it('emits approval/responded event', () => {
      const { context } = createTestContext()
      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      sessionsMap.set('thread-perm-1', context)

      const events: any[] = []
      manager.on('event', (event) => events.push(event))

      context.pendingApprovals.set('req-1', {
        requestId: 'req-1',
        jsonRpcId: 42,
        method: 'item/commandExecution/requestApproval',
        threadId: 'thread-perm-1'
      })

      manager.respondToApproval('thread-perm-1', 'req-1', 'once')

      const approvalEvent = events.find((e) => e.method === 'approval/responded')
      expect(approvalEvent).toBeDefined()
      expect(approvalEvent.kind).toBe('session')
    })

    it('throws when threadId is unknown', () => {
      expect(() => manager.respondToApproval('nonexistent', 'req-1', 'once')).toThrow(
        'no session for threadId'
      )
    })

    it('throws when requestId is not pending', () => {
      const { context } = createTestContext()
      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      sessionsMap.set('thread-perm-1', context)

      expect(() => manager.respondToApproval('thread-perm-1', 'nonexistent', 'once')).toThrow(
        'no pending approval'
      )
    })
  })

  // ── getPendingApprovals ─────────────────────────────────────────

  describe('getPendingApprovals', () => {
    it('returns array of pending approvals for a thread', () => {
      const { context } = createTestContext()
      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      sessionsMap.set('thread-perm-1', context)

      context.pendingApprovals.set('a1', {
        requestId: 'a1',
        jsonRpcId: 1,
        method: 'item/commandExecution/requestApproval',
        threadId: 'thread-perm-1'
      })
      context.pendingApprovals.set('a2', {
        requestId: 'a2',
        jsonRpcId: 2,
        method: 'item/fileChange/requestApproval',
        threadId: 'thread-perm-1'
      })

      const approvals = manager.getPendingApprovals('thread-perm-1')
      expect(approvals).toHaveLength(2)
      expect(approvals.map((a: PendingApprovalRequest) => a.requestId)).toContain('a1')
      expect(approvals.map((a: PendingApprovalRequest) => a.requestId)).toContain('a2')
    })

    it('returns empty array for unknown threadId', () => {
      const approvals = manager.getPendingApprovals('nonexistent')
      expect(approvals).toEqual([])
    })

    it('returns empty array when no approvals are pending', () => {
      const { context } = createTestContext()
      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      sessionsMap.set('thread-perm-1', context)

      const approvals = manager.getPendingApprovals('thread-perm-1')
      expect(approvals).toEqual([])
    })
  })

  // ── Implementer permissionReply routing ─────────────────────────

  describe('CodexImplementer.permissionReply', () => {
    it('routes through to manager.respondToApproval', async () => {
      // We need to import after mocking — but since the manager mock
      // is already set up at module level for the prompt tests, let's
      // test this via the real implementer with manual session seeding

      // Direct test: populate pending approval in implementer's tracking map
      // and verify it calls the manager correctly
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()
      const internalManager = impl.getManager() as any

      // Seed a session
      impl.getSessions().set('/test::thread-perm-1', {
        threadId: 'thread-perm-1',
        hiveSessionId: 'hive-1',
        worktreePath: '/test',
        status: 'ready',
        messages: [],
        revertMessageID: null,
        revertDiff: null
      })

      // Seed a pending approval in the implementer's map
      impl.getPendingApprovalSessions().set('req-perm-1', {
        threadId: 'thread-perm-1',
        hiveSessionId: 'hive-1',
        worktreePath: '/test'
      })

      // Mock the manager's respondToApproval
      internalManager.respondToApproval = vi.fn()

      await impl.permissionReply('req-perm-1', 'once')

      expect(internalManager.respondToApproval).toHaveBeenCalledWith(
        'thread-perm-1',
        'req-perm-1',
        'once'
      )
    })
  })

  // ── Implementer permissionList ──────────────────────────────────

  describe('CodexImplementer.permissionList', () => {
    it('returns pending approvals from all sessions in PermissionRequest shape', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()
      const internalManager = impl.getManager() as any

      // Seed sessions
      impl.getSessions().set('/test::thread-1', {
        threadId: 'thread-1',
        hiveSessionId: 'hive-1',
        worktreePath: '/test',
        status: 'ready',
        messages: [],
        revertMessageID: null,
        revertDiff: null
      })
      impl.getSessions().set('/test::thread-2', {
        threadId: 'thread-2',
        hiveSessionId: 'hive-2',
        worktreePath: '/test',
        status: 'ready',
        messages: [],
        revertMessageID: null,
        revertDiff: null
      })

      // Mock manager to return pending approvals
      internalManager.getPendingApprovals = vi
        .fn()
        .mockReturnValueOnce([
          { requestId: 'a1', method: 'item/commandExecution/requestApproval', threadId: 'thread-1' }
        ])
        .mockReturnValueOnce([
          { requestId: 'a2', method: 'item/fileChange/requestApproval', threadId: 'thread-2' }
        ])

      const permissions = await impl.permissionList()
      expect(permissions).toHaveLength(2)
      expect((permissions[0] as any).id).toBe('a1')
      expect((permissions[0] as any).permission).toBe('bash')
      expect((permissions[1] as any).id).toBe('a2')
      expect((permissions[1] as any).permission).toBe('edit')
    })
  })
})

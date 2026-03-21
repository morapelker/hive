/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'

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

import type { CodexSessionState } from '../../../src/main/services/codex-implementer'

// ── Tests ───────────────────────────────────────────────────────────

describe('Codex getSessionInfo & renameSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── getSessionInfo ────────────────────────────────────────────────

  describe('getSessionInfo', () => {
    it('returns null/null when no session exists', async () => {
      const { CodexImplementer } = await import(
        '../../../src/main/services/codex-implementer'
      )
      const impl = new CodexImplementer()

      const result = await impl.getSessionInfo('/unknown', 'thread-x')

      expect(result.revertMessageID).toBeNull()
      expect(result.revertDiff).toBeNull()
    })

    it('returns null/null for a fresh session (no undo performed)', async () => {
      const { CodexImplementer } = await import(
        '../../../src/main/services/codex-implementer'
      )
      const impl = new CodexImplementer()

      impl.getSessions().set('/test::thread-1', {
        threadId: 'thread-1',
        hiveSessionId: 'hive-1',
        worktreePath: '/test',
        status: 'ready',
        messages: [],
        revertMessageID: null,
        revertDiff: null
      })

      const result = await impl.getSessionInfo('/test', 'thread-1')

      expect(result.revertMessageID).toBeNull()
      expect(result.revertDiff).toBeNull()
    })

    it('returns stored revert state after undo', async () => {
      const { CodexImplementer } = await import(
        '../../../src/main/services/codex-implementer'
      )
      const impl = new CodexImplementer()

      const session: CodexSessionState = {
        threadId: 'thread-1',
        hiveSessionId: 'hive-1',
        worktreePath: '/test',
        status: 'ready',
        messages: [],
        revertMessageID: 'revert-msg-42',
        revertDiff: null
      }
      impl.getSessions().set('/test::thread-1', session)

      const result = await impl.getSessionInfo('/test', 'thread-1')

      expect(result.revertMessageID).toBe('revert-msg-42')
      expect(result.revertDiff).toBeNull()
    })

    it('returns state after undo sets revertMessageID', async () => {
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

      impl.getSessions().set('/test::thread-1', {
        threadId: 'thread-1',
        hiveSessionId: 'hive-1',
        worktreePath: '/test',
        status: 'ready',
        messages: [
          { role: 'user', parts: [{ type: 'text', text: 'Hi' }], timestamp: '2026-01-01' },
          { role: 'assistant', parts: [{ type: 'text', text: 'Hey' }], timestamp: '2026-01-01' }
        ],
        revertMessageID: null,
        revertDiff: null
      })

      internalManager.rollbackThread = vi.fn().mockResolvedValue({ ok: true })

      await impl.undo('/test', 'thread-1', 'hive-1')

      const info = await impl.getSessionInfo('/test', 'thread-1')
      expect(info.revertMessageID).toBeTruthy()
      expect(info.revertDiff).toBeNull()
    })
  })

  // ── renameSession ─────────────────────────────────────────────────

  describe('renameSession', () => {
    it('updates the session title in the database', async () => {
      const { CodexImplementer } = await import(
        '../../../src/main/services/codex-implementer'
      )
      const impl = new CodexImplementer()

      const mockDbService = {
        updateSession: vi.fn().mockReturnValue({ id: 'hive-1', name: 'New Title' })
      }
      impl.setDatabaseService(mockDbService as any)

      impl.getSessions().set('/test::thread-1', {
        threadId: 'thread-1',
        hiveSessionId: 'hive-1',
        worktreePath: '/test',
        status: 'ready',
        messages: [],
        revertMessageID: null,
        revertDiff: null
      })

      await impl.renameSession('/test', 'thread-1', 'New Title')

      expect(mockDbService.updateSession).toHaveBeenCalledWith('hive-1', { name: 'New Title' })
    })

    it('does not throw without dbService', async () => {
      const { CodexImplementer } = await import(
        '../../../src/main/services/codex-implementer'
      )
      const impl = new CodexImplementer()

      impl.getSessions().set('/test::thread-1', {
        threadId: 'thread-1',
        hiveSessionId: 'hive-1',
        worktreePath: '/test',
        status: 'ready',
        messages: [],
        revertMessageID: null,
        revertDiff: null
      })

      // Should not throw
      await expect(
        impl.renameSession('/test', 'thread-1', 'Title')
      ).resolves.not.toThrow()
    })

    it('handles unknown session gracefully', async () => {
      const { CodexImplementer } = await import(
        '../../../src/main/services/codex-implementer'
      )
      const impl = new CodexImplementer()

      const mockDbService = {
        updateSession: vi.fn()
      }
      impl.setDatabaseService(mockDbService as any)

      // Should not throw
      await expect(
        impl.renameSession('/test', 'nonexistent', 'Title')
      ).resolves.not.toThrow()

      // Should not attempt DB update
      expect(mockDbService.updateSession).not.toHaveBeenCalled()
    })

    it('handles DB error gracefully', async () => {
      const { CodexImplementer } = await import(
        '../../../src/main/services/codex-implementer'
      )
      const impl = new CodexImplementer()

      const mockDbService = {
        updateSession: vi.fn().mockImplementation(() => {
          throw new Error('DB write failed')
        })
      }
      impl.setDatabaseService(mockDbService as any)

      impl.getSessions().set('/test::thread-1', {
        threadId: 'thread-1',
        hiveSessionId: 'hive-1',
        worktreePath: '/test',
        status: 'ready',
        messages: [],
        revertMessageID: null,
        revertDiff: null
      })

      // Should not throw (error is caught internally)
      await expect(
        impl.renameSession('/test', 'thread-1', 'Title')
      ).resolves.not.toThrow()
    })
  })
})

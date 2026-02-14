/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../src/main/services/claude-sdk-loader', () => ({
  loadClaudeSDK: vi.fn()
}))

vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import {
  ClaudeCodeImplementer,
  type ClaudeSessionState,
  type ClaudeQuery
} from '../../../src/main/services/claude-code-implementer'

function createMockQuery(overrides: Partial<ClaudeQuery> = {}): ClaudeQuery {
  return {
    interrupt: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    next: vi.fn().mockResolvedValue({ done: true, value: undefined }),
    [Symbol.asyncIterator]: vi.fn() as any,
    ...overrides
  }
}

describe('ClaudeCodeImplementer – lifecycle (Session 3)', () => {
  let impl: ClaudeCodeImplementer
  let sessions: Map<string, ClaudeSessionState>

  beforeEach(() => {
    impl = new ClaudeCodeImplementer()
    sessions = (impl as any).sessions
  })

  // ── connect() ──────────────────────────────────────────────────────

  describe('connect()', () => {
    it('returns a sessionId starting with "pending::"', async () => {
      const result = await impl.connect('/proj', 'hive-1')
      expect(result.sessionId).toMatch(/^pending::/)
    })

    it('returns unique IDs on successive calls', async () => {
      const r1 = await impl.connect('/proj', 'h1')
      const r2 = await impl.connect('/proj', 'h2')
      expect(r1.sessionId).not.toBe(r2.sessionId)
    })

    it('registers the session in the sessions map', async () => {
      const { sessionId } = await impl.connect('/proj', 'hive-1')
      const key = (impl as any).getSessionKey('/proj', sessionId)
      expect(sessions.has(key)).toBe(true)
    })

    it('sets materialized to false', async () => {
      const { sessionId } = await impl.connect('/proj', 'hive-1')
      const key = (impl as any).getSessionKey('/proj', sessionId)
      const state = sessions.get(key)!
      expect(state.materialized).toBe(false)
    })

    it('creates an AbortController', async () => {
      const { sessionId } = await impl.connect('/proj', 'hive-1')
      const key = (impl as any).getSessionKey('/proj', sessionId)
      const state = sessions.get(key)!
      expect(state.abortController).toBeInstanceOf(AbortController)
      expect(state.abortController!.signal.aborted).toBe(false)
    })

    it('initializes empty checkpoints', async () => {
      const { sessionId } = await impl.connect('/proj', 'hive-1')
      const key = (impl as any).getSessionKey('/proj', sessionId)
      const state = sessions.get(key)!
      expect(state.checkpoints).toBeInstanceOf(Map)
      expect(state.checkpoints.size).toBe(0)
    })

    it('sets query to null', async () => {
      const { sessionId } = await impl.connect('/proj', 'hive-1')
      const key = (impl as any).getSessionKey('/proj', sessionId)
      const state = sessions.get(key)!
      expect(state.query).toBeNull()
    })

    it('stores worktreePath and hiveSessionId correctly', async () => {
      const { sessionId } = await impl.connect('/my/path', 'hive-42')
      const key = (impl as any).getSessionKey('/my/path', sessionId)
      const state = sessions.get(key)!
      expect(state.worktreePath).toBe('/my/path')
      expect(state.hiveSessionId).toBe('hive-42')
      expect(state.claudeSessionId).toBe(sessionId)
    })
  })

  // ── reconnect() ────────────────────────────────────────────────────

  describe('reconnect()', () => {
    it('returns { success: true, sessionStatus: "idle", revertMessageID: null }', async () => {
      const result = await impl.reconnect('/proj', 'real-sid-1', 'hive-1')
      expect(result).toEqual({
        success: true,
        sessionStatus: 'idle',
        revertMessageID: null
      })
    })

    it('registers persisted session ID with materialized: true', async () => {
      await impl.reconnect('/proj', 'real-sid-1', 'hive-1')
      const key = (impl as any).getSessionKey('/proj', 'real-sid-1')
      const state = sessions.get(key)!
      expect(state.materialized).toBe(true)
    })

    it('creates an AbortController for reconnected session', async () => {
      await impl.reconnect('/proj', 'real-sid-1', 'hive-1')
      const key = (impl as any).getSessionKey('/proj', 'real-sid-1')
      const state = sessions.get(key)!
      expect(state.abortController).toBeInstanceOf(AbortController)
    })

    it('sets query to null', async () => {
      await impl.reconnect('/proj', 'real-sid-1', 'hive-1')
      const key = (impl as any).getSessionKey('/proj', 'real-sid-1')
      const state = sessions.get(key)!
      expect(state.query).toBeNull()
    })

    it('handles already-registered sessions by updating hiveSessionId', async () => {
      await impl.reconnect('/proj', 'sid-1', 'hive-old')
      const result = await impl.reconnect('/proj', 'sid-1', 'hive-new')

      expect(result).toEqual({
        success: true,
        sessionStatus: 'idle',
        revertMessageID: null
      })

      const key = (impl as any).getSessionKey('/proj', 'sid-1')
      const state = sessions.get(key)!
      expect(state.hiveSessionId).toBe('hive-new')
    })

    it('does not create a duplicate entry for already-registered sessions', async () => {
      await impl.reconnect('/proj', 'sid-1', 'hive-old')
      await impl.reconnect('/proj', 'sid-1', 'hive-new')

      let count = 0
      for (const [k] of sessions) {
        if (k.includes('sid-1')) count++
      }
      expect(count).toBe(1)
    })

    it('stores correct worktreePath and claudeSessionId', async () => {
      await impl.reconnect('/other/path', 'persisted-id', 'h5')
      const key = (impl as any).getSessionKey('/other/path', 'persisted-id')
      const state = sessions.get(key)!
      expect(state.worktreePath).toBe('/other/path')
      expect(state.claudeSessionId).toBe('persisted-id')
      expect(state.hiveSessionId).toBe('h5')
    })
  })

  // ── disconnect() ───────────────────────────────────────────────────

  describe('disconnect()', () => {
    it('removes the session from the map', async () => {
      const { sessionId } = await impl.connect('/proj', 'h1')
      expect(sessions.size).toBe(1)

      await impl.disconnect('/proj', sessionId)
      expect(sessions.size).toBe(0)
    })

    it('aborts the AbortController', async () => {
      const { sessionId } = await impl.connect('/proj', 'h1')
      const key = (impl as any).getSessionKey('/proj', sessionId)
      const controller = sessions.get(key)!.abortController!
      const abortSpy = vi.spyOn(controller, 'abort')

      await impl.disconnect('/proj', sessionId)
      expect(abortSpy).toHaveBeenCalled()
    })

    it('calls query.close() if a query is active', async () => {
      const { sessionId } = await impl.connect('/proj', 'h1')
      const key = (impl as any).getSessionKey('/proj', sessionId)
      const mockQuery = createMockQuery()
      sessions.get(key)!.query = mockQuery

      await impl.disconnect('/proj', sessionId)
      expect(mockQuery.close).toHaveBeenCalled()
    })

    it('handles query.close() throwing without propagating', async () => {
      const { sessionId } = await impl.connect('/proj', 'h1')
      const key = (impl as any).getSessionKey('/proj', sessionId)
      const mockQuery = createMockQuery({
        close: vi.fn(() => {
          throw new Error('close failed')
        })
      })
      sessions.get(key)!.query = mockQuery

      await expect(impl.disconnect('/proj', sessionId)).resolves.toBeUndefined()
      expect(sessions.size).toBe(0)
    })

    it('handles missing sessions gracefully (no throw)', async () => {
      await expect(impl.disconnect('/proj', 'nonexistent')).resolves.toBeUndefined()
    })

    it('does not affect other sessions when disconnecting one', async () => {
      const r1 = await impl.connect('/proj', 'h1')
      const r2 = await impl.connect('/proj', 'h2')

      await impl.disconnect('/proj', r1.sessionId)
      expect(sessions.size).toBe(1)

      const key2 = (impl as any).getSessionKey('/proj', r2.sessionId)
      expect(sessions.has(key2)).toBe(true)
    })
  })

  // ── cleanup() ──────────────────────────────────────────────────────

  describe('cleanup()', () => {
    it('resolves without error when no sessions exist', async () => {
      await expect(impl.cleanup()).resolves.toBeUndefined()
    })

    it('clears all sessions from the map', async () => {
      await impl.connect('/a', 'h1')
      await impl.connect('/b', 'h2')
      expect(sessions.size).toBe(2)

      await impl.cleanup()
      expect(sessions.size).toBe(0)
    })

    it('aborts all controllers', async () => {
      await impl.connect('/a', 'h1')
      await impl.connect('/b', 'h2')

      const controllers = [...sessions.values()].map((s) => s.abortController!)
      const spies = controllers.map((c) => vi.spyOn(c, 'abort'))

      await impl.cleanup()
      for (const spy of spies) {
        expect(spy).toHaveBeenCalled()
      }
    })

    it('closes all active queries', async () => {
      const r1 = await impl.connect('/a', 'h1')
      const r2 = await impl.connect('/b', 'h2')

      const key1 = (impl as any).getSessionKey('/a', r1.sessionId)
      const key2 = (impl as any).getSessionKey('/b', r2.sessionId)
      const q1 = createMockQuery()
      const q2 = createMockQuery()
      sessions.get(key1)!.query = q1
      sessions.get(key2)!.query = q2

      await impl.cleanup()
      expect(q1.close).toHaveBeenCalled()
      expect(q2.close).toHaveBeenCalled()
    })

    it('handles query.close() throwing without stopping cleanup', async () => {
      const r1 = await impl.connect('/a', 'h1')
      const r2 = await impl.connect('/b', 'h2')

      const key1 = (impl as any).getSessionKey('/a', r1.sessionId)
      const key2 = (impl as any).getSessionKey('/b', r2.sessionId)
      const throwingQuery = createMockQuery({
        close: vi.fn(() => {
          throw new Error('boom')
        })
      })
      const normalQuery = createMockQuery()
      sessions.get(key1)!.query = throwingQuery
      sessions.get(key2)!.query = normalQuery

      await expect(impl.cleanup()).resolves.toBeUndefined()
      expect(throwingQuery.close).toHaveBeenCalled()
      expect(normalQuery.close).toHaveBeenCalled()
      expect(sessions.size).toBe(0)
    })

    it('handles sessions with null query and null abortController', async () => {
      const key = '/x::manual'
      sessions.set(key, {
        claudeSessionId: 'manual',
        hiveSessionId: 'h1',
        worktreePath: '/x',
        abortController: null,
        checkpoints: new Map(),
        query: null,
        materialized: false
      })

      await expect(impl.cleanup()).resolves.toBeUndefined()
      expect(sessions.size).toBe(0)
    })
  })

  // ── Integration / lifecycle flows ──────────────────────────────────

  describe('lifecycle integration', () => {
    it('connect -> disconnect -> reconnect cycle', async () => {
      // 1. Connect (deferred)
      const { sessionId: placeholderId } = await impl.connect('/proj', 'hive-1')
      expect(placeholderId).toMatch(/^pending::/)
      expect(sessions.size).toBe(1)

      // 2. Disconnect
      await impl.disconnect('/proj', placeholderId)
      expect(sessions.size).toBe(0)

      // 3. Reconnect with a "real" persisted ID
      const result = await impl.reconnect('/proj', 'real-sdk-session-abc', 'hive-1')
      expect(result.success).toBe(true)
      expect(sessions.size).toBe(1)

      const key = (impl as any).getSessionKey('/proj', 'real-sdk-session-abc')
      const state = sessions.get(key)!
      expect(state.materialized).toBe(true)
    })

    it('multiple worktrees coexist independently', async () => {
      const r1 = await impl.connect('/proj-a', 'h1')
      const r2 = await impl.connect('/proj-b', 'h2')
      await impl.reconnect('/proj-c', 'persisted-3', 'h3')

      expect(sessions.size).toBe(3)

      // Disconnect one, others survive
      await impl.disconnect('/proj-a', r1.sessionId)
      expect(sessions.size).toBe(2)

      // The remaining two are still accessible
      const keyB = (impl as any).getSessionKey('/proj-b', r2.sessionId)
      const keyC = (impl as any).getSessionKey('/proj-c', 'persisted-3')
      expect(sessions.has(keyB)).toBe(true)
      expect(sessions.has(keyC)).toBe(true)
    })

    it('app restart simulation: fresh implementer + reconnect restores sessions', async () => {
      // Simulate first run: connect a session
      const impl1 = new ClaudeCodeImplementer()
      const { sessionId } = await impl1.connect('/proj', 'hive-1')
      // In real app, sessionId would be replaced by a real SDK ID after first prompt.
      // Simulate saving the real ID to DB
      const persistedSdkId = 'real-sdk-session-xyz'

      // Simulate app restart: new implementer, reconnect with persisted ID
      const impl2 = new ClaudeCodeImplementer()
      const sessions2 = (impl2 as any).sessions as Map<string, ClaudeSessionState>
      expect(sessions2.size).toBe(0)

      const result = await impl2.reconnect('/proj', persistedSdkId, 'hive-1')
      expect(result.success).toBe(true)
      expect(sessions2.size).toBe(1)

      const key = (impl2 as any).getSessionKey('/proj', persistedSdkId)
      const state = sessions2.get(key)!
      expect(state.materialized).toBe(true)
      expect(state.claudeSessionId).toBe(persistedSdkId)

      // Original placeholder from impl1 is irrelevant -- different instance
      expect(sessionId).toMatch(/^pending::/)
    })

    it('cleanup after mixed connect/reconnect clears everything', async () => {
      await impl.connect('/a', 'h1')
      await impl.connect('/b', 'h2')
      await impl.reconnect('/c', 'persisted-1', 'h3')
      expect(sessions.size).toBe(3)

      await impl.cleanup()
      expect(sessions.size).toBe(0)
    })

    it('double-disconnect is safe (second call is no-op)', async () => {
      const { sessionId } = await impl.connect('/proj', 'h1')
      await impl.disconnect('/proj', sessionId)
      await expect(impl.disconnect('/proj', sessionId)).resolves.toBeUndefined()
      expect(sessions.size).toBe(0)
    })
  })
})

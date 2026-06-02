/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentSdkImplementer } from '../../../src/main/services/agent-sdk-types'
import { CLAUDE_CODE_CAPABILITIES } from '../../../src/main/services/agent-sdk-types'

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

vi.mock('../../../src/main/desktop/backend-manager', () => ({
  publishDesktopBackendEvent: vi.fn()
}))

vi.mock('../../../src/main/services/agent-event-bus', () => ({
  agentEventBus: { publish: vi.fn() }
}))

import {
  ClaudeCodeImplementer,
  type ClaudeSessionState
} from '../../../src/main/services/claude-code-implementer'

describe('ClaudeCodeImplementer', () => {
  let impl: ClaudeCodeImplementer

  beforeEach(() => {
    vi.clearAllMocks()
    impl = new ClaudeCodeImplementer()
  })

  // ── Identity & capabilities ────────────────────────────────────────

  describe('identity & capabilities', () => {
    it('id is "claude-code"', () => {
      expect(impl.id).toBe('claude-code')
    })

    it('capabilities equals CLAUDE_CODE_CAPABILITIES', () => {
      expect(impl.capabilities).toEqual(CLAUDE_CODE_CAPABILITIES)
    })

    it('satisfies AgentSdkImplementer interface shape (all methods exist)', () => {
      const requiredMethods: (keyof AgentSdkImplementer)[] = [
        'connect',
        'reconnect',
        'disconnect',
        'cleanup',
        'prompt',
        'abort',
        'getMessages',
        'getAvailableModels',
        'getModelInfo',
        'setSelectedModel',
        'getSessionInfo',
        'questionReply',
        'questionReject',
        'permissionReply',
        'permissionList',
        'undo',
        'redo',
        'listCommands',
        'sendCommand',
        'renameSession'
      ]
      for (const method of requiredMethods) {
        expect(typeof impl[method]).toBe('function')
      }
    })
  })

  // ── Stub methods ───────────────────────────────────────────────────

  describe('stub methods', () => {
    it('connect returns a deferred placeholder sessionId', async () => {
      const result = await impl.connect('/path', 'hive-1')
      expect(result.sessionId).toMatch(/^pending::/)
    })

    it('prompt throws when session not found', async () => {
      await expect(impl.prompt('/path', 'sid', 'hello')).rejects.toThrow(/session not found/)
    })

    it('getMessages returns empty array (stub)', async () => {
      const result = await impl.getMessages('/path', 'sid')
      expect(result).toEqual([])
    })
  })

  // ── cleanup ────────────────────────────────────────────────────────

  describe('cleanup', () => {
    it('resolves without error when no sessions exist', async () => {
      await expect(impl.cleanup()).resolves.toBeUndefined()
    })

    it('aborts active abort controllers during cleanup', async () => {
      const controller = new AbortController()
      const abortSpy = vi.spyOn(controller, 'abort')

      // Inject a session via the exposed helper
      ;(impl as any).sessions.set('wp::/sid', {
        claudeSessionId: 'sid',
        hiveSessionId: 'hive-1',
        worktreePath: 'wp',
        abortController: controller,
        checkpoints: new Map(),
        query: null,
        materialized: false
      } satisfies ClaudeSessionState)

      await impl.cleanup()
      expect(abortSpy).toHaveBeenCalled()
    })

    it('cleans up multiple sessions including mix of active/null controllers', async () => {
      const c1 = new AbortController()
      const c2 = new AbortController()
      const spy1 = vi.spyOn(c1, 'abort')
      const spy2 = vi.spyOn(c2, 'abort')

      const sessions = (impl as any).sessions as Map<string, ClaudeSessionState>
      sessions.set('a::1', {
        claudeSessionId: '1',
        hiveSessionId: 'h1',
        worktreePath: 'a',
        abortController: c1,
        checkpoints: new Map(),
        query: null,
        materialized: false
      })
      sessions.set('b::2', {
        claudeSessionId: '2',
        hiveSessionId: 'h2',
        worktreePath: 'b',
        abortController: null,
        checkpoints: new Map(),
        query: null,
        materialized: false
      })
      sessions.set('c::3', {
        claudeSessionId: '3',
        hiveSessionId: 'h3',
        worktreePath: 'c',
        abortController: c2,
        checkpoints: new Map(),
        query: null,
        materialized: false
      })

      await impl.cleanup()
      expect(spy1).toHaveBeenCalled()
      expect(spy2).toHaveBeenCalled()
    })

    it('skips null abort controllers without throwing', async () => {
      const sessions = (impl as any).sessions as Map<string, ClaudeSessionState>
      sessions.set('x::y', {
        claudeSessionId: 'y',
        hiveSessionId: 'hy',
        worktreePath: 'x',
        abortController: null,
        checkpoints: new Map(),
        query: null,
        materialized: false
      })

      await expect(impl.cleanup()).resolves.toBeUndefined()
    })

    it('sessions map is empty after cleanup', async () => {
      const sessions = (impl as any).sessions as Map<string, ClaudeSessionState>
      sessions.set('k::v', {
        claudeSessionId: 'v',
        hiveSessionId: 'hv',
        worktreePath: 'k',
        abortController: new AbortController(),
        checkpoints: new Map(),
        query: null,
        materialized: false
      })

      await impl.cleanup()
      expect(sessions.size).toBe(0)
    })
  })

  // ── sendToRenderer ─────────────────────────────────────────────────

  describe('sendToRenderer', () => {
    it('does not throw for unknown channels', () => {
      expect(() => (impl as any).sendToRenderer('ch', { a: 1 })).not.toThrow()
    })

    it('does not route unknown channels through the agent event bus', async () => {
      const { agentEventBus } = await import('../../../src/main/services/agent-event-bus')
      ;(impl as any).sendToRenderer('test:channel', { foo: 'bar' })

      expect(agentEventBus.publish).not.toHaveBeenCalled()
    })

    it('routes opencode stream events through the agent event bus', async () => {
      const { agentEventBus } = await import('../../../src/main/services/agent-event-bus')
      const event = { type: 'session.updated', sessionId: 'hive-1', data: {} }

      ;(impl as any).sendToRenderer('opencode:stream', event)

      expect(agentEventBus.publish).toHaveBeenCalledWith(event)
    })
  })

  // ── Session key helpers ────────────────────────────────────────────

  describe('session key helpers', () => {
    it('getSessionKey produces composite key worktreePath::sessionId', () => {
      const key = (impl as any).getSessionKey('/home/proj', 'sess-42')
      expect(key).toBe('/home/proj::sess-42')
    })

    it('getSession returns undefined for unknown key', () => {
      const result = (impl as any).getSession('/unknown', 'none')
      expect(result).toBeUndefined()
    })

    it('getSession returns state for registered session', () => {
      const state: ClaudeSessionState = {
        claudeSessionId: 's1',
        hiveSessionId: 'h1',
        worktreePath: '/proj',
        abortController: null,
        checkpoints: new Map(),
        query: null,
        materialized: false
      }
      ;(impl as any).sessions.set('/proj::s1', state)

      const result = (impl as any).getSession('/proj', 's1')
      expect(result).toBe(state)
    })
  })
})

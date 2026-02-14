/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BrowserWindow } from 'electron'

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn()
}))
vi.mock('../../../src/main/services/claude-sdk-loader', () => ({
  loadClaudeSDK: vi.fn().mockResolvedValue({ query: mockQuery })
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
  type ClaudeSessionState
} from '../../../src/main/services/claude-code-implementer'

function createMockWindow(): BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  } as unknown as BrowserWindow
}

function createMockQueryIterator(messages: Array<Record<string, unknown>>) {
  let index = 0
  const iterator = {
    interrupt: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    next: vi.fn().mockImplementation(async () => {
      if (index < messages.length) {
        return { done: false, value: messages[index++] }
      }
      return { done: true, value: undefined }
    }),
    return: vi.fn().mockResolvedValue({ done: true, value: undefined }),
    [Symbol.asyncIterator]: () => iterator
  }
  return iterator
}

function getStreamEvents(window: BrowserWindow): any[] {
  const send = (window.webContents as any).send as ReturnType<typeof vi.fn>
  return send.mock.calls
    .filter((call: any[]) => call[0] === 'opencode:stream')
    .map((call: any[]) => call[1])
}

describe('ClaudeCodeImplementer – prompt streaming (Session 4)', () => {
  let impl: ClaudeCodeImplementer
  let sessions: Map<string, ClaudeSessionState>
  let mockWindow: BrowserWindow

  beforeEach(() => {
    vi.clearAllMocks()
    impl = new ClaudeCodeImplementer()
    sessions = (impl as any).sessions
    mockWindow = createMockWindow()
    impl.setMainWindow(mockWindow)
  })

  // ── prompt() ────────────────────────────────────────────────────────

  describe('prompt()', () => {
    it('throws if session is not found', async () => {
      await expect(impl.prompt('/proj', 'nonexistent-session', 'hello')).rejects.toThrow(
        /session not found/i
      )
    })

    it('emits session.status busy then idle for a simple prompt', async () => {
      const { sessionId } = await impl.connect('/proj', 'hive-1')

      const iter = createMockQueryIterator([
        {
          type: 'assistant',
          session_id: 'sdk-real-1',
          content: [{ type: 'text', text: 'Hello!' }]
        }
      ])
      mockQuery.mockReturnValue(iter)

      await impl.prompt('/proj', sessionId, 'hi')

      const events = getStreamEvents(mockWindow)

      // First event should be busy status
      expect(events[0]).toMatchObject({
        type: 'session.status',
        sessionId: 'hive-1',
        statusPayload: { type: 'busy' }
      })

      // Last event should be idle status
      expect(events[events.length - 1]).toMatchObject({
        type: 'session.status',
        sessionId: 'hive-1',
        statusPayload: { type: 'idle' }
      })
    })

    it('materializes pending:: session ID on first SDK message', async () => {
      const { sessionId } = await impl.connect('/proj', 'hive-1')
      expect(sessionId).toMatch(/^pending::/)

      const oldKey = (impl as any).getSessionKey('/proj', sessionId)
      expect(sessions.has(oldKey)).toBe(true)

      const iter = createMockQueryIterator([
        {
          type: 'assistant',
          session_id: 'sdk-real-abc',
          content: [{ type: 'text', text: 'Hi' }]
        }
      ])
      mockQuery.mockReturnValue(iter)

      await impl.prompt('/proj', sessionId, 'hello')

      // Old pending key should be gone
      expect(sessions.has(oldKey)).toBe(false)

      // New key with real SDK session ID should exist
      const newKey = (impl as any).getSessionKey('/proj', 'sdk-real-abc')
      expect(sessions.has(newKey)).toBe(true)

      const state = sessions.get(newKey)!
      expect(state.claudeSessionId).toBe('sdk-real-abc')
      expect(state.materialized).toBe(true)
    })

    it('emits message.part.updated for assistant text', async () => {
      const { sessionId } = await impl.connect('/proj', 'hive-1')

      const iter = createMockQueryIterator([
        {
          type: 'assistant',
          session_id: 'sdk-1',
          content: [
            { type: 'text', text: 'First block' },
            { type: 'text', text: 'Second block' }
          ]
        }
      ])
      mockQuery.mockReturnValue(iter)

      await impl.prompt('/proj', sessionId, 'test')

      const events = getStreamEvents(mockWindow)
      const partEvents = events.filter((e: any) => e.type === 'message.part.updated')
      expect(partEvents.length).toBeGreaterThanOrEqual(2)
      expect(partEvents[0].data.content).toMatchObject({
        type: 'text',
        text: 'First block'
      })
      expect(partEvents[1].data.content).toMatchObject({
        type: 'text',
        text: 'Second block'
      })
    })

    it('captures user message UUIDs as checkpoints', async () => {
      const { sessionId } = await impl.connect('/proj', 'hive-1')

      const iter = createMockQueryIterator([
        {
          type: 'assistant',
          session_id: 'sdk-1',
          content: [{ type: 'text', text: 'Hi' }]
        },
        {
          type: 'user',
          session_id: 'sdk-1',
          uuid: 'user-msg-uuid-42',
          content: [{ type: 'text', text: 'echo' }]
        }
      ])
      mockQuery.mockReturnValue(iter)

      await impl.prompt('/proj', sessionId, 'test')

      // Find the session (may have been re-keyed)
      const newKey = (impl as any).getSessionKey('/proj', 'sdk-1')
      const state = sessions.get(newKey)!
      expect(state.checkpoints.has('user-msg-uuid-42')).toBe(true)
    })

    it('skips init messages', async () => {
      const { sessionId } = await impl.connect('/proj', 'hive-1')

      const iter = createMockQueryIterator([
        {
          type: 'init',
          session_id: 'sdk-1',
          content: { some: 'init-data' }
        },
        {
          type: 'assistant',
          session_id: 'sdk-1',
          content: [{ type: 'text', text: 'Hello' }]
        }
      ])
      mockQuery.mockReturnValue(iter)

      await impl.prompt('/proj', sessionId, 'test')

      const events = getStreamEvents(mockWindow)

      // No events should have init type data forwarded
      const initEvents = events.filter((e: any) => e.data?.type === 'init')
      expect(initEvents.length).toBe(0)
    })

    it('emits session.error and then idle on SDK error', async () => {
      const { sessionId } = await impl.connect('/proj', 'hive-1')

      mockQuery.mockImplementation(() => {
        throw new Error('SDK query failed')
      })

      await impl.prompt('/proj', sessionId, 'test')

      const events = getStreamEvents(mockWindow)

      // Should have busy, then error, then idle
      expect(events[0]).toMatchObject({
        type: 'session.status',
        statusPayload: { type: 'busy' }
      })

      const errorEvent = events.find((e: any) => e.type === 'session.error')
      expect(errorEvent).toBeDefined()
      expect(errorEvent.sessionId).toBe('hive-1')

      // Last event should be idle
      expect(events[events.length - 1]).toMatchObject({
        type: 'session.status',
        statusPayload: { type: 'idle' }
      })
    })

    it('passes resume ID to SDK when session is materialized', async () => {
      await impl.reconnect('/proj', 'real-sdk-id-1', 'hive-1')

      const iter = createMockQueryIterator([
        {
          type: 'assistant',
          session_id: 'real-sdk-id-1',
          content: [{ type: 'text', text: 'Resumed' }]
        }
      ])
      mockQuery.mockReturnValue(iter)

      await impl.prompt('/proj', 'real-sdk-id-1', 'continue')

      expect(mockQuery).toHaveBeenCalledTimes(1)
      const callArgs = mockQuery.mock.calls[0][0]
      expect(callArgs.options.resume).toBe('real-sdk-id-1')
    })
  })

  // ── DB materialization update ─────────────────────────────────────

  describe('DB materialization update', () => {
    it('updates DB opencode_session_id after materialization', async () => {
      const mockDb = {
        updateSession: vi.fn(),
        getSession: vi.fn()
      }
      impl.setDatabaseService(mockDb as any)

      const { sessionId } = await impl.connect('/proj', 'hive-1')
      const messages = [
        { type: 'assistant', session_id: 'real-sdk-id', content: [{ type: 'text', text: 'Hi' }] }
      ]
      mockQuery.mockReturnValue(createMockQueryIterator(messages))

      await impl.prompt('/proj', sessionId, 'Hello')

      expect(mockDb.updateSession).toHaveBeenCalledWith('hive-1', {
        opencode_session_id: 'real-sdk-id'
      })
    })

    it('does not fail if dbService is null', async () => {
      // No setDatabaseService called — dbService is null
      const { sessionId } = await impl.connect('/proj', 'hive-1')
      const messages = [
        { type: 'assistant', session_id: 'real-sdk-id', content: [{ type: 'text', text: 'Hi' }] }
      ]
      mockQuery.mockReturnValue(createMockQueryIterator(messages))

      // Should not throw
      await impl.prompt('/proj', sessionId, 'Hello')
    })

    it('handles DB update error gracefully', async () => {
      const mockDb = {
        updateSession: vi.fn().mockImplementation(() => {
          throw new Error('DB write failed')
        }),
        getSession: vi.fn()
      }
      impl.setDatabaseService(mockDb as any)

      const { sessionId } = await impl.connect('/proj', 'hive-1')
      const messages = [
        { type: 'assistant', session_id: 'real-sdk-id', content: [{ type: 'text', text: 'Hi' }] }
      ]
      mockQuery.mockReturnValue(createMockQueryIterator(messages))

      // Should not throw even if DB fails
      await impl.prompt('/proj', sessionId, 'Hello')

      expect(mockDb.updateSession).toHaveBeenCalledWith('hive-1', {
        opencode_session_id: 'real-sdk-id'
      })
    })

    it('does not update DB when session is already materialized', async () => {
      const mockDb = {
        updateSession: vi.fn(),
        getSession: vi.fn()
      }
      impl.setDatabaseService(mockDb as any)

      // Reconnect creates an already-materialized session
      await impl.reconnect('/proj', 'existing-sdk-id', 'hive-1')
      const messages = [
        {
          type: 'assistant',
          session_id: 'existing-sdk-id',
          content: [{ type: 'text', text: 'Resumed' }]
        }
      ]
      mockQuery.mockReturnValue(createMockQueryIterator(messages))

      await impl.prompt('/proj', 'existing-sdk-id', 'continue')

      // DB should NOT be updated since session was already materialized
      expect(mockDb.updateSession).not.toHaveBeenCalled()
    })
  })

  // ── getMessages() ───────────────────────────────────────────────────

  describe('getMessages()', () => {
    it('returns empty array (Session 5 stub)', async () => {
      await impl.connect('/proj', 'hive-1')
      const result = await impl.getMessages('/proj', 'any-session')
      expect(result).toEqual([])
    })
  })
})

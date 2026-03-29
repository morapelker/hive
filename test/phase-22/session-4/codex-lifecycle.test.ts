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

// Mock the CodexAppServerManager
vi.mock('../../../src/main/services/codex-app-server-manager', () => {
  const MockManager = vi.fn().mockImplementation(() => ({
    startSession: vi.fn(),
    stopSession: vi.fn(),
    stopAll: vi.fn(),
    hasSession: vi.fn().mockReturnValue(false),
    getSession: vi.fn(),
    listSessions: vi.fn().mockReturnValue([]),
    on: vi.fn(),
    emit: vi.fn(),
    removeAllListeners: vi.fn()
  }))
  return {
    CodexAppServerManager: MockManager
  }
})

import { CodexImplementer } from '../../../src/main/services/codex-implementer'
import { CODEX_DEFAULT_MODEL } from '../../../src/main/services/codex-models'

describe('CodexImplementer lifecycle', () => {
  let impl: CodexImplementer
  let mockManager: any

  beforeEach(() => {
    vi.clearAllMocks()
    impl = new CodexImplementer()
    mockManager = impl.getManager()
  })

  // ── connect ─────────────────────────────────────────────────────

  describe('connect', () => {
    it('returns a session ID (threadId)', async () => {
      mockManager.startSession.mockResolvedValue({
        provider: 'codex',
        status: 'ready',
        threadId: 'thread-new-1',
        cwd: '/test/project',
        model: 'gpt-5.4',
        activeTurnId: null,
        resumeCursor: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })

      const result = await impl.connect('/test/project', 'hive-session-1')

      expect(result.sessionId).toBe('thread-new-1')
    })

    it('calls manager.startSession with correct options', async () => {
      mockManager.startSession.mockResolvedValue({
        provider: 'codex',
        status: 'ready',
        threadId: 'thread-abc',
        cwd: '/test/project',
        model: 'gpt-5.4',
        activeTurnId: null,
        resumeCursor: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })

      await impl.connect('/test/project', 'hive-session-1')

      expect(mockManager.startSession).toHaveBeenCalledWith({
        cwd: '/test/project',
        model: CODEX_DEFAULT_MODEL
      })
    })

    it('uses selected model when set', async () => {
      impl.setSelectedModel({ providerID: 'codex', modelID: 'gpt-5.3-codex' })

      mockManager.startSession.mockResolvedValue({
        provider: 'codex',
        status: 'ready',
        threadId: 'thread-xyz',
        cwd: '/test',
        model: 'gpt-5.3-codex',
        activeTurnId: null,
        resumeCursor: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })

      await impl.connect('/test', 'hive-1')

      expect(mockManager.startSession).toHaveBeenCalledWith({
        cwd: '/test',
        model: 'gpt-5.3-codex'
      })
    })

    it('stores session state in local map', async () => {
      mockManager.startSession.mockResolvedValue({
        provider: 'codex',
        status: 'ready',
        threadId: 'thread-stored',
        cwd: '/test',
        model: 'gpt-5.4',
        activeTurnId: null,
        resumeCursor: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })

      await impl.connect('/test', 'hive-session-2')

      const sessions = impl.getSessions()
      const key = '/test::thread-stored'
      expect(sessions.has(key)).toBe(true)

      const state = sessions.get(key)!
      expect(state.threadId).toBe('thread-stored')
      expect(state.hiveSessionId).toBe('hive-session-2')
      expect(state.worktreePath).toBe('/test')
      expect(state.status).toBe('ready')
      expect(state.messages).toEqual([])
    })

    it('throws if startSession returns no threadId', async () => {
      mockManager.startSession.mockResolvedValue({
        provider: 'codex',
        status: 'ready',
        threadId: null,
        cwd: '/test',
        model: 'gpt-5.4',
        activeTurnId: null,
        resumeCursor: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })

      await expect(impl.connect('/test', 'hive-1')).rejects.toThrow(
        'no thread ID was returned'
      )
    })

    it('sends session.materialized event to renderer', async () => {
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      } as any
      impl.setMainWindow(mockWindow)

      mockManager.startSession.mockResolvedValue({
        provider: 'codex',
        status: 'ready',
        threadId: 'thread-mat',
        cwd: '/test',
        model: 'gpt-5.4',
        activeTurnId: null,
        resumeCursor: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })

      await impl.connect('/test', 'hive-session-3')

      expect(mockWindow.webContents.send).toHaveBeenCalledWith('opencode:stream', {
        type: 'session.materialized',
        sessionId: 'hive-session-3',
        data: { newSessionId: 'thread-mat', wasFork: false }
      })
    })
  })

  // ── reconnect ───────────────────────────────────────────────────

  describe('reconnect', () => {
    it('returns success for existing session with updated hiveSessionId', async () => {
      // Pre-populate a session
      const sessions = impl.getSessions()
      sessions.set('/test::thread-existing', {
        threadId: 'thread-existing',
        hiveSessionId: 'old-hive-id',
        worktreePath: '/test',
        status: 'ready',
        messages: []
      })

      const result = await impl.reconnect('/test', 'thread-existing', 'new-hive-id')

      expect(result.success).toBe(true)
      expect(result.sessionStatus).toBe('idle')

      // Verify hiveSessionId was updated
      const state = sessions.get('/test::thread-existing')!
      expect(state.hiveSessionId).toBe('new-hive-id')
    })

    it('returns busy status for running session', async () => {
      const sessions = impl.getSessions()
      sessions.set('/test::thread-running', {
        threadId: 'thread-running',
        hiveSessionId: 'hive-1',
        worktreePath: '/test',
        status: 'running',
        messages: []
      })

      const result = await impl.reconnect('/test', 'thread-running', 'hive-2')

      expect(result.success).toBe(true)
      expect(result.sessionStatus).toBe('busy')
    })

    it('creates fresh connection for unknown session via thread resume', async () => {
      mockManager.startSession.mockResolvedValue({
        provider: 'codex',
        status: 'ready',
        threadId: 'thread-reconnected',
        cwd: '/test',
        model: 'gpt-5.4',
        activeTurnId: null,
        resumeCursor: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })

      const result = await impl.reconnect('/test', 'thread-old', 'hive-new')

      expect(result.success).toBe(true)
      expect(result.sessionStatus).toBe('idle')

      // Verify manager was called with resume
      expect(mockManager.startSession).toHaveBeenCalledWith({
        cwd: '/test',
        model: CODEX_DEFAULT_MODEL,
        resumeThreadId: 'thread-old'
      })
    })

    it('stores the new session state', async () => {
      mockManager.startSession.mockResolvedValue({
        provider: 'codex',
        status: 'ready',
        threadId: 'thread-new-reconnect',
        cwd: '/workspace',
        model: 'gpt-5.4',
        activeTurnId: null,
        resumeCursor: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })

      await impl.reconnect('/workspace', 'thread-old', 'hive-reconnect')

      const sessions = impl.getSessions()
      expect(sessions.has('/workspace::thread-new-reconnect')).toBe(true)
    })

    it('returns failure if startSession throws', async () => {
      mockManager.startSession.mockRejectedValue(new Error('Connection refused'))

      const result = await impl.reconnect('/test', 'thread-fail', 'hive-fail')

      expect(result.success).toBe(false)
    })
  })

  // ── disconnect ──────────────────────────────────────────────────

  describe('disconnect', () => {
    it('stops the session and removes from local map', async () => {
      // Pre-populate a session
      const sessions = impl.getSessions()
      sessions.set('/test::thread-dc', {
        threadId: 'thread-dc',
        hiveSessionId: 'hive-dc',
        worktreePath: '/test',
        status: 'ready',
        messages: []
      })

      await impl.disconnect('/test', 'thread-dc')

      expect(mockManager.stopSession).toHaveBeenCalledWith('thread-dc')
      expect(sessions.has('/test::thread-dc')).toBe(false)
    })

    it('ignores disconnect for unknown session', async () => {
      await expect(impl.disconnect('/test', 'nonexistent')).resolves.toBeUndefined()
      expect(mockManager.stopSession).not.toHaveBeenCalled()
    })
  })

  // ── cleanup ─────────────────────────────────────────────────────

  describe('cleanup', () => {
    it('stops all manager sessions', async () => {
      await impl.cleanup()

      expect(mockManager.stopAll).toHaveBeenCalled()
    })

    it('clears all local sessions', async () => {
      const sessions = impl.getSessions()
      sessions.set('/test::t1', {
        threadId: 't1',
        hiveSessionId: 'h1',
        worktreePath: '/test',
        status: 'ready',
        messages: []
      })
      sessions.set('/test::t2', {
        threadId: 't2',
        hiveSessionId: 'h2',
        worktreePath: '/test',
        status: 'ready',
        messages: []
      })

      await impl.cleanup()

      expect(sessions.size).toBe(0)
    })

    it('clears mainWindow', async () => {
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      } as any
      impl.setMainWindow(mockWindow)

      await impl.cleanup()

      expect(impl.getMainWindow()).toBeNull()
    })

    it('resets model to default', async () => {
      impl.setSelectedModel({ providerID: 'codex', modelID: 'gpt-5.3-codex', variant: 'low' })

      await impl.cleanup()

      expect(impl.getSelectedModel()).toBe(CODEX_DEFAULT_MODEL)
      expect(impl.getSelectedVariant()).toBeUndefined()
    })

    it('does not throw when called with no sessions', async () => {
      await expect(impl.cleanup()).resolves.toBeUndefined()
    })
  })

  // ── Session state tracking ──────────────────────────────────────

  describe('session state tracking', () => {
    it('multiple connects create separate sessions', async () => {
      mockManager.startSession
        .mockResolvedValueOnce({
          provider: 'codex',
          status: 'ready',
          threadId: 'thread-a',
          cwd: '/project-a',
          model: 'gpt-5.4',
          activeTurnId: null,
          resumeCursor: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        })
        .mockResolvedValueOnce({
          provider: 'codex',
          status: 'ready',
          threadId: 'thread-b',
          cwd: '/project-b',
          model: 'gpt-5.4',
          activeTurnId: null,
          resumeCursor: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        })

      await impl.connect('/project-a', 'hive-a')
      await impl.connect('/project-b', 'hive-b')

      const sessions = impl.getSessions()
      expect(sessions.size).toBe(2)
      expect(sessions.has('/project-a::thread-a')).toBe(true)
      expect(sessions.has('/project-b::thread-b')).toBe(true)
    })

    it('session key uses worktreePath::agentSessionId format', async () => {
      mockManager.startSession.mockResolvedValue({
        provider: 'codex',
        status: 'ready',
        threadId: 'thread-key-test',
        cwd: '/my/project',
        model: 'gpt-5.4',
        activeTurnId: null,
        resumeCursor: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })

      await impl.connect('/my/project', 'hive-key-test')

      const sessions = impl.getSessions()
      const keys = [...sessions.keys()]
      expect(keys[0]).toBe('/my/project::thread-key-test')
    })

    it('disconnect only removes the target session', async () => {
      const sessions = impl.getSessions()
      sessions.set('/test::thread-keep', {
        threadId: 'thread-keep',
        hiveSessionId: 'hive-keep',
        worktreePath: '/test',
        status: 'ready',
        messages: []
      })
      sessions.set('/test::thread-remove', {
        threadId: 'thread-remove',
        hiveSessionId: 'hive-remove',
        worktreePath: '/test',
        status: 'ready',
        messages: []
      })

      await impl.disconnect('/test', 'thread-remove')

      expect(sessions.size).toBe(1)
      expect(sessions.has('/test::thread-keep')).toBe(true)
      expect(sessions.has('/test::thread-remove')).toBe(false)
    })
  })

  // ── Implemented methods behavior ────────────────────────────────

  describe('implemented methods behavior', () => {
    it('prompt throws when session not found', async () => {
      await expect(impl.prompt('/test', 'session-1', 'hello')).rejects.toThrow(
        'session not found'
      )
    })

    it('abort returns false for unknown session', async () => {
      const result = await impl.abort('/test', 'session-1')
      expect(result).toBe(false)
    })

    it('getMessages returns empty array for unknown session', async () => {
      const messages = await impl.getMessages('/test', 'session-1')
      expect(messages).toEqual([])
    })
  })
})

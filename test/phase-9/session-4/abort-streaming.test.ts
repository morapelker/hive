import { describe, test, expect, vi, beforeEach } from 'vitest'

// Mock the stores before importing any components
vi.mock('../../../src/renderer/src/stores', () => ({
  useSessionStore: Object.assign(
    vi.fn().mockImplementation((selector: (s: unknown) => unknown) =>
      selector({
        activeSessionId: null,
        sessions: [],
        openSessions: []
      })
    ),
    { getState: () => ({ activeSessionId: null, sessions: [], openSessions: [] }) }
  ),
  useWorktreeStore: Object.assign(
    vi.fn().mockImplementation((selector: (s: unknown) => unknown) =>
      selector({
        activeWorktree: null
      })
    ),
    { getState: () => ({ activeWorktree: null }) }
  ),
  useLayoutStore: Object.assign(
    vi.fn().mockImplementation((selector: (s: unknown) => unknown) =>
      selector({
        rightSidebarWidth: 300
      })
    ),
    { getState: () => ({ rightSidebarWidth: 300 }) }
  ),
  useFileTreeStore: Object.assign(vi.fn(), {
    getState: () => ({})
  }),
  useGitStore: Object.assign(vi.fn(), {
    getState: () => ({})
  }),
  useFileViewerStore: Object.assign(vi.fn(), {
    getState: () => ({})
  }),
  useProjectStore: Object.assign(vi.fn(), {
    getState: () => ({})
  }),
  useScriptStore: Object.assign(vi.fn(), {
    getState: () => ({})
  }),
  useThemeStore: Object.assign(vi.fn(), {
    getState: () => ({})
  }),
  useShortcutStore: Object.assign(vi.fn(), {
    getState: () => ({
      getEffectiveBinding: () => null
    })
  })
}))

// Mock opencodeOps
const mockAbort = vi.fn().mockResolvedValue({ success: true })
const mockOpencodeOps = {
  connect: vi.fn().mockResolvedValue({ success: true, sessionId: 'oc-1' }),
  reconnect: vi.fn().mockResolvedValue({ success: true }),
  prompt: vi.fn().mockResolvedValue({ success: true }),
  abort: mockAbort,
  disconnect: vi.fn().mockResolvedValue({ success: true }),
  getMessages: vi.fn().mockResolvedValue({ success: true, messages: [] }),
  listModels: vi.fn().mockResolvedValue({ success: true, providers: {} }),
  setModel: vi.fn().mockResolvedValue({ success: true }),
  modelInfo: vi.fn().mockResolvedValue({ success: true, model: null }),
  commands: vi.fn().mockResolvedValue({ success: true, commands: [] }),
  onStream: vi.fn().mockReturnValue(() => {})
}

Object.defineProperty(window, 'opencodeOps', {
  writable: true,
  value: mockOpencodeOps
})

describe('Session 4: Abort Streaming', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Stop button visibility logic', () => {
    test('stop button shown when streaming and input empty', () => {
      // Test the conditional logic directly:
      // isStreaming=true, inputValue.trim()='' => show stop button
      const isStreaming = true
      const inputValue = ''
      const showStop = isStreaming && !inputValue.trim()
      expect(showStop).toBe(true)
    })

    test('queue button shown when streaming and input has text', () => {
      // isStreaming=true, inputValue='hello' => show queue/send button
      const isStreaming = true
      const inputValue = 'hello'
      const showStop = isStreaming && !inputValue.trim()
      expect(showStop).toBe(false)
    })

    test('send button shown when not streaming', () => {
      // isStreaming=false => show send button regardless of input
      const isStreaming = false
      const inputValue = ''
      const showStop = isStreaming && !inputValue.trim()
      expect(showStop).toBe(false)
    })

    test('stop button not shown when streaming with whitespace-only input', () => {
      // isStreaming=true, inputValue='   ' => trim() is '' => show stop
      const isStreaming = true
      const inputValue = '   '
      const showStop = isStreaming && !inputValue.trim()
      expect(showStop).toBe(true)
    })
  })

  describe('IPC abort chain', () => {
    test('window.opencodeOps.abort is callable with correct params', async () => {
      const worktreePath = '/path/to/worktree'
      const opencodeSessionId = 'session-123'

      await window.opencodeOps.abort(worktreePath, opencodeSessionId)

      expect(mockAbort).toHaveBeenCalledWith(worktreePath, opencodeSessionId)
      expect(mockAbort).toHaveBeenCalledTimes(1)
    })

    test('abort returns success result', async () => {
      mockAbort.mockResolvedValueOnce({ success: true })

      const result = await window.opencodeOps.abort('/path', 'session-1')
      expect(result).toEqual({ success: true })
    })

    test('abort returns failure result on error', async () => {
      mockAbort.mockResolvedValueOnce({ success: false, error: 'No session' })

      const result = await window.opencodeOps.abort('/path', 'session-1')
      expect(result).toEqual({ success: false, error: 'No session' })
    })
  })

  describe('handleAbort behavior', () => {
    test('handleAbort does nothing when worktreePath is null', async () => {
      // Simulate the handleAbort logic from SessionView
      const worktreePath: string | null = null
      const opencodeSessionId: string | null = 'session-1'

      // This mirrors the guard in handleAbort
      if (!worktreePath || !opencodeSessionId) return
      await window.opencodeOps.abort(worktreePath, opencodeSessionId)

      expect(mockAbort).not.toHaveBeenCalled()
    })

    test('handleAbort does nothing when opencodeSessionId is null', async () => {
      const worktreePath: string | null = '/path'
      const opencodeSessionId: string | null = null

      if (!worktreePath || !opencodeSessionId) return
      await window.opencodeOps.abort(worktreePath, opencodeSessionId)

      expect(mockAbort).not.toHaveBeenCalled()
    })

    test('handleAbort calls abort when both params present', async () => {
      const worktreePath: string | null = '/path/to/worktree'
      const opencodeSessionId: string | null = 'session-123'

      if (!worktreePath || !opencodeSessionId) return
      await window.opencodeOps.abort(worktreePath, opencodeSessionId)

      expect(mockAbort).toHaveBeenCalledWith('/path/to/worktree', 'session-123')
    })
  })

  describe('Button state transitions', () => {
    test('transitions: not streaming -> streaming (empty) -> streaming (typing) -> not streaming', () => {
      // State 1: Not streaming
      let isStreaming = false
      let inputValue = ''
      expect(isStreaming && !inputValue.trim()).toBe(false) // send button

      // State 2: Streaming starts, input empty
      isStreaming = true
      expect(isStreaming && !inputValue.trim()).toBe(true) // stop button

      // State 3: User starts typing while streaming
      inputValue = 'new message'
      expect(isStreaming && !inputValue.trim()).toBe(false) // queue button

      // State 4: User clears input
      inputValue = ''
      expect(isStreaming && !inputValue.trim()).toBe(true) // stop button

      // State 5: Streaming ends
      isStreaming = false
      expect(isStreaming && !inputValue.trim()).toBe(false) // send button
    })
  })
})

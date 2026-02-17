import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest'
import { renderHook, cleanup } from '@testing-library/react'
import { useOpenCodeGlobalListener } from '@/hooks/useOpenCodeGlobalListener'
import { extractTokens, extractCost, extractModelRef } from '@/lib/token-utils'

/**
 * Session 4: Global Listener Busy Handling — Tests
 *
 * These tests verify:
 * 1. session.status busy sets working status for background sessions (build mode)
 * 2. session.status busy sets planning status for plan-mode background sessions
 * 3. session.status busy is ignored for the active session
 * 4. session.status idle still sets unread for background sessions (existing behavior)
 */

// Capture the stream callback registered by the hook
let streamCallback: ((event: Record<string, unknown>) => void) | null = null

// Mock window.opencodeOps.onStream to capture the callback
const mockOnStream = vi.fn((cb: (event: Record<string, unknown>) => void) => {
  streamCallback = cb
  return () => {
    streamCallback = null
  }
})

// Mock window.worktreeOps.onBranchRenamed
const mockOnBranchRenamed = vi.fn(() => () => {})

Object.defineProperty(window, 'opencodeOps', {
  writable: true,
  value: { onStream: mockOnStream }
})

Object.defineProperty(window, 'worktreeOps', {
  writable: true,
  value: { onBranchRenamed: mockOnBranchRenamed }
})

// Mock useWorktreeStore (imported by the listener)
vi.mock('@/stores/useWorktreeStore', () => ({
  useWorktreeStore: {
    getState: () => ({
      updateWorktreeBranch: vi.fn()
    })
  }
}))

// Mock useQuestionStore (imported by the listener)
vi.mock('@/stores/useQuestionStore', () => ({
  useQuestionStore: {
    getState: () => ({
      addQuestion: vi.fn(),
      removeQuestion: vi.fn()
    })
  }
}))

// Mock useContextStore (imported by the listener)
const setSessionTokensSpy = vi.fn()
const addSessionCostSpy = vi.fn()
const setModelLimitSpy = vi.fn()

vi.mock('@/stores/useContextStore', () => ({
  useContextStore: {
    getState: () => ({
      setSessionTokens: setSessionTokensSpy,
      addSessionCost: addSessionCostSpy,
      setModelLimit: setModelLimitSpy
    })
  }
}))

// Mock extractTokens, extractCost, extractModelRef
vi.mock('@/lib/token-utils', () => ({
  extractTokens: vi.fn(() => null),
  extractCost: vi.fn(() => 0),
  extractModelRef: vi.fn(() => null),
  extractModelUsage: vi.fn(() => null)
}))

const extractTokensMock = vi.mocked(extractTokens)
const extractCostMock = vi.mocked(extractCost)
const extractModelRefMock = vi.mocked(extractModelRef)

// Spies for stores we want to verify
const setSessionStatusSpy = vi.fn()
const clearSessionStatusSpy = vi.fn()
const setLastMessageTimeSpy = vi.fn()
const getSessionModeSpy = vi.fn()
const updateSessionNameSpy = vi.fn()

// Mock useSessionStore
vi.mock('@/stores/useSessionStore', () => ({
  useSessionStore: {
    getState: () => ({
      activeSessionId: 'session-A',
      getSessionMode: getSessionModeSpy,
      getPendingPlan: vi.fn(() => null),
      updateSessionName: updateSessionNameSpy,
      sessionsByWorktree: new Map([['wt-1', [{ id: 'session-B' }]]])
    })
  }
}))

// Mock useWorktreeStatusStore
vi.mock('@/stores/useWorktreeStatusStore', () => ({
  useWorktreeStatusStore: {
    getState: () => ({
      setSessionStatus: setSessionStatusSpy,
      clearSessionStatus: clearSessionStatusSpy,
      setLastMessageTime: setLastMessageTimeSpy
    })
  }
}))

describe('Session 4: Global Listener Busy Handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    streamCallback = null
    // Default mode is 'build'
    getSessionModeSpy.mockReturnValue('build')
    extractTokensMock.mockReturnValue(null)
    extractCostMock.mockReturnValue(0)
    extractModelRefMock.mockReturnValue(null)
  })

  afterEach(() => {
    cleanup()
  })

  function mountListenerAndGetCallback() {
    renderHook(() => useOpenCodeGlobalListener())
    expect(streamCallback).not.toBeNull()
    return streamCallback!
  }

  test('session.status busy sets working status for background session', () => {
    const cb = mountListenerAndGetCallback()
    getSessionModeSpy.mockReturnValue('build')

    cb({
      type: 'session.status',
      sessionId: 'session-B',
      statusPayload: { type: 'busy' }
    })

    expect(setSessionStatusSpy).toHaveBeenCalledWith('session-B', 'working')
  })

  test('session.status busy sets planning status for plan-mode background session', () => {
    const cb = mountListenerAndGetCallback()
    getSessionModeSpy.mockReturnValue('plan')

    cb({
      type: 'session.status',
      sessionId: 'session-B',
      statusPayload: { type: 'busy' }
    })

    expect(setSessionStatusSpy).toHaveBeenCalledWith('session-B', 'planning')
  })

  test('session.status busy is ignored for the active session', () => {
    const cb = mountListenerAndGetCallback()

    cb({
      type: 'session.status',
      sessionId: 'session-A', // active session
      statusPayload: { type: 'busy' }
    })

    expect(setSessionStatusSpy).not.toHaveBeenCalled()
  })

  test('session.status idle sets completed for background session (transitions to unread after 30s)', () => {
    const cb = mountListenerAndGetCallback()

    cb({
      type: 'session.status',
      sessionId: 'session-B',
      statusPayload: { type: 'idle' }
    })

    expect(setSessionStatusSpy).toHaveBeenCalledWith(
      'session-B',
      'completed',
      expect.objectContaining({ durationMs: 0, word: expect.any(String) })
    )
  })

  test('session.status idle is ignored for the active session', () => {
    const cb = mountListenerAndGetCallback()

    cb({
      type: 'session.status',
      sessionId: 'session-A', // active session
      statusPayload: { type: 'idle' }
    })

    expect(setSessionStatusSpy).not.toHaveBeenCalled()
  })

  test('session.status busy reads status from data.status when statusPayload is absent', () => {
    const cb = mountListenerAndGetCallback()
    getSessionModeSpy.mockReturnValue('build')

    cb({
      type: 'session.status',
      sessionId: 'session-B',
      data: { status: { type: 'busy' } }
    })

    expect(setSessionStatusSpy).toHaveBeenCalledWith('session-B', 'working')
  })

  test('non session.status events are not handled as busy/idle', () => {
    const cb = mountListenerAndGetCallback()

    cb({
      type: 'message.created',
      sessionId: 'session-B',
      statusPayload: { type: 'busy' }
    })

    // message.created for non-active session with no title data should be ignored
    expect(setSessionStatusSpy).not.toHaveBeenCalled()
  })

  test('session.status with unknown type is ignored (falls through)', () => {
    const cb = mountListenerAndGetCallback()

    cb({
      type: 'session.status',
      sessionId: 'session-B',
      statusPayload: { type: 'connecting' }
    })

    // 'connecting' is not 'busy' or 'idle', so nothing should happen
    expect(setSessionStatusSpy).not.toHaveBeenCalled()
  })

  test('idle sets last message time for the worktree', () => {
    const cb = mountListenerAndGetCallback()

    cb({
      type: 'session.status',
      sessionId: 'session-B',
      statusPayload: { type: 'idle' }
    })

    expect(setLastMessageTimeSpy).toHaveBeenCalledWith('wt-1', expect.any(Number))
  })

  test('busy does not set last message time', () => {
    const cb = mountListenerAndGetCallback()

    cb({
      type: 'session.status',
      sessionId: 'session-B',
      statusPayload: { type: 'busy' }
    })

    expect(setLastMessageTimeSpy).not.toHaveBeenCalled()
  })

  test('message.updated from child session does not update context tokens', () => {
    const cb = mountListenerAndGetCallback()

    extractTokensMock.mockReturnValue({
      input: 500,
      output: 200,
      reasoning: 50,
      cacheRead: 0,
      cacheWrite: 0
    })

    cb({
      type: 'message.updated',
      sessionId: 'session-B',
      childSessionId: 'tool-subtask-1',
      data: {
        role: 'assistant',
        info: { time: { completed: '2026-02-17T12:00:00.000Z' } }
      }
    })

    expect(setSessionTokensSpy).not.toHaveBeenCalled()
    expect(addSessionCostSpy).not.toHaveBeenCalled()
  })
})

import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  setSessionStatus: vi.fn(),
  setPendingPlan: vi.fn(),
  clearPendingPlan: vi.fn(),
  notifyKanbanSessionSync: vi.fn(),
  setSelectedTicketId: vi.fn(),
  lastSendMode: new Map<string, 'plan' | 'build'>(),
  modeBySession: new Map<string, 'build' | 'plan' | 'super-plan'>(),
  sessionStatuses: {} as Record<string, { status: string } | null>,
  kanbanState: {
    selectedTicketId: null as string | null,
    tickets: new Map<string, Array<{ id: string; current_session_id: string | null }>>()
  }
}))

vi.mock('@/stores/useWorktreeStatusStore', () => ({
  useWorktreeStatusStore: {
    getState: () => ({
      sessionStatuses: mocks.sessionStatuses,
      setSessionStatus: mocks.setSessionStatus
    })
  }
}))

vi.mock('@/stores/useSessionStore', () => ({
  useSessionStore: {
    getState: () => ({
      modeBySession: mocks.modeBySession,
      setPendingPlan: mocks.setPendingPlan,
      clearPendingPlan: mocks.clearPendingPlan
    })
  }
}))

vi.mock('@/stores/useKanbanStore', () => ({
  useKanbanStore: Object.assign(
    (selector: (state: typeof mocks.kanbanState) => unknown) => selector(mocks.kanbanState),
    {
      getState: () => ({
        ...mocks.kanbanState,
        setSelectedTicketId: mocks.setSelectedTicketId
      })
    }
  )
}))

vi.mock('@/stores/store-coordination', () => ({
  notifyKanbanSessionSync: mocks.notifyKanbanSessionSync
}))

vi.mock('@/lib/message-send-times', () => ({
  lastSendMode: mocks.lastSendMode
}))

import { useClaudeCliStatusListener } from '../useClaudeCliStatusListener'

describe('useClaudeCliStatusListener', () => {
  let subscribedCallback:
    | ((payload: {
        sessionId: string
        status: 'completed' | 'working' | 'planning' | 'plan_ready'
        metadata?: {
          reason?: string
          hookEventName?: string
          hookPath?: string
          toolName?: string
          plan?: string
        }
      }) => void)
    | null
  let planFollowupCallback: ((payload: { sessionId: string }) => void) | null
  const unsubscribe = vi.fn()
  const unsubscribePlanFollowup = vi.fn()

  beforeEach(() => {
    subscribedCallback = null
    planFollowupCallback = null
    unsubscribe.mockClear()
    unsubscribePlanFollowup.mockClear()
    mocks.setSessionStatus.mockClear()
    mocks.setPendingPlan.mockClear()
    mocks.clearPendingPlan.mockClear()
    mocks.setSelectedTicketId.mockClear()
    mocks.notifyKanbanSessionSync.mockClear()
    mocks.lastSendMode.clear()
    mocks.modeBySession.clear()
    mocks.sessionStatuses = {}
    mocks.kanbanState = {
      selectedTicketId: null,
      tickets: new Map()
    }

    Object.defineProperty(window, 'terminalOps', {
      configurable: true,
      value: {
        onClaudeCliStatus: vi.fn((callback) => {
          subscribedCallback = callback
          return unsubscribe
        }),
        onClaudeCliPlanFollowup: vi.fn((callback) => {
          planFollowupCallback = callback
          return unsubscribePlanFollowup
        })
      }
    })
  })

  afterEach(() => {
    delete (window as { terminalOps?: unknown }).terminalOps
  })

  it('subscribes to Claude CLI status IPC and writes payloads into the worktree status store', () => {
    const { unmount } = renderHook(() => useClaudeCliStatusListener())

    subscribedCallback?.({
      sessionId: 'hive-session-1',
      status: 'plan_ready',
      metadata: { hookEventName: 'PreToolUse', hookPath: 'tool' }
    })

    expect(window.terminalOps.onClaudeCliStatus).toHaveBeenCalledTimes(1)
    expect(mocks.setSessionStatus).toHaveBeenCalledWith('hive-session-1', 'plan_ready', {
      hookEventName: 'PreToolUse',
      hookPath: 'tool'
    })

    unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(unsubscribePlanFollowup).toHaveBeenCalledTimes(1)
  })

  it('stores raw ExitPlanMode plan text when a Claude CLI plan becomes ready', () => {
    renderHook(() => useClaudeCliStatusListener())

    subscribedCallback?.({
      sessionId: 'hive-session-1',
      status: 'plan_ready',
      metadata: {
        hookEventName: 'PreToolUse',
        hookPath: 'tool',
        toolName: 'ExitPlanMode',
        plan: '# Plan\n\n1. Add CLI card.'
      }
    })

    expect(mocks.setPendingPlan).toHaveBeenCalledWith('hive-session-1', {
      requestId: 'claude-cli:hive-session-1',
      planContent: '# Plan\n\n1. Add CLI card.',
      toolUseID: 'claude-cli:hive-session-1'
    })
    expect(mocks.setSessionStatus).toHaveBeenCalledWith('hive-session-1', 'plan_ready', {
      hookEventName: 'PreToolUse',
      hookPath: 'tool',
      toolName: 'ExitPlanMode',
      plan: '# Plan\n\n1. Add CLI card.'
    })
  })

  it('implements the pending plan when terminal approval completes ExitPlanMode', () => {
    renderHook(() => useClaudeCliStatusListener())

    subscribedCallback?.({
      sessionId: 'hive-session-1',
      status: 'working',
      metadata: {
        hookEventName: 'PostToolUse',
        hookPath: 'tool',
        toolName: 'ExitPlanMode'
      }
    })

    expect(mocks.clearPendingPlan).toHaveBeenCalledWith('hive-session-1')
    expect(mocks.notifyKanbanSessionSync).toHaveBeenCalledWith('hive-session-1', {
      type: 'implement'
    })
    expect(mocks.lastSendMode.get('hive-session-1')).toBe('build')
    expect(mocks.setSessionStatus).toHaveBeenCalledWith('hive-session-1', 'working', {
      hookEventName: 'PostToolUse',
      hookPath: 'tool',
      toolName: 'ExitPlanMode'
    })
  })

  it('does nothing when the preload API is unavailable', () => {
    delete (window as { terminalOps?: unknown }).terminalOps

    const { unmount } = renderHook(() => useClaudeCliStatusListener())

    expect(mocks.setSessionStatus).not.toHaveBeenCalled()
    expect(() => unmount()).not.toThrow()
  })

  it('derives planning and plan_ready for Claude CLI plan-mode hook sequences', () => {
    mocks.modeBySession.set('hive-session-1', 'plan')
    renderHook(() => useClaudeCliStatusListener())

    subscribedCallback?.({
      sessionId: 'hive-session-1',
      status: 'working',
      metadata: { hookEventName: 'UserPromptSubmit', hookPath: 'start' }
    })
    mocks.sessionStatuses = { 'hive-session-1': { status: 'planning' } }

    subscribedCallback?.({
      sessionId: 'hive-session-1',
      status: 'completed',
      metadata: { hookEventName: 'Stop', hookPath: 'stop' }
    })

    expect(mocks.lastSendMode.get('hive-session-1')).toBe('plan')
    expect(mocks.setSessionStatus).toHaveBeenNthCalledWith(1, 'hive-session-1', 'planning', {
      hookEventName: 'UserPromptSubmit',
      hookPath: 'start'
    })
    expect(mocks.setSessionStatus).toHaveBeenNthCalledWith(2, 'hive-session-1', 'plan_ready', {
      hookEventName: 'Stop',
      hookPath: 'stop'
    })
  })

  it('treats a prompt submitted while plan_ready as plan approval work', () => {
    mocks.modeBySession.set('hive-session-1', 'plan')
    mocks.sessionStatuses = { 'hive-session-1': { status: 'plan_ready' } }
    renderHook(() => useClaudeCliStatusListener())

    subscribedCallback?.({
      sessionId: 'hive-session-1',
      status: 'working',
      metadata: { hookEventName: 'UserPromptSubmit', hookPath: 'start' }
    })
    mocks.sessionStatuses = { 'hive-session-1': { status: 'working' } }

    subscribedCallback?.({
      sessionId: 'hive-session-1',
      status: 'completed',
      metadata: { hookEventName: 'Stop', hookPath: 'stop' }
    })

    expect(mocks.lastSendMode.get('hive-session-1')).toBe('build')
    expect(mocks.setSessionStatus).toHaveBeenNthCalledWith(1, 'hive-session-1', 'working', {
      hookEventName: 'UserPromptSubmit',
      hookPath: 'start'
    })
    expect(mocks.setSessionStatus).toHaveBeenNthCalledWith(2, 'hive-session-1', 'completed', {
      hookEventName: 'Stop',
      hookPath: 'stop'
    })
  })

  it('handles transcript-detected plan followups by returning the session and ticket to planning', () => {
    renderHook(() => useClaudeCliStatusListener())

    planFollowupCallback?.({ sessionId: 'hive-session-1' })

    expect(mocks.clearPendingPlan).toHaveBeenCalledWith('hive-session-1')
    expect(mocks.notifyKanbanSessionSync).toHaveBeenCalledWith('hive-session-1', {
      type: 'plan_followup'
    })
    expect(mocks.lastSendMode.get('hive-session-1')).toBe('plan')
    expect(mocks.setSessionStatus).toHaveBeenCalledWith('hive-session-1', 'planning', {
      reason: 'claude_cli_plan_followup'
    })
  })

  it('closes the selected ticket modal when a linked Claude CLI plan followup is detected', () => {
    mocks.kanbanState = {
      selectedTicketId: 'ticket-plan',
      tickets: new Map([
        ['project-1', [{ id: 'ticket-plan', current_session_id: 'hive-session-1' }]]
      ])
    }
    renderHook(() => useClaudeCliStatusListener())

    planFollowupCallback?.({ sessionId: 'hive-session-1' })

    expect(mocks.setSelectedTicketId).toHaveBeenCalledWith(null)
  })

  it('does not close the selected ticket modal for a different session followup', () => {
    mocks.kanbanState = {
      selectedTicketId: 'ticket-plan',
      tickets: new Map([
        ['project-1', [{ id: 'ticket-plan', current_session_id: 'other-session' }]]
      ])
    }
    renderHook(() => useClaudeCliStatusListener())

    planFollowupCallback?.({ sessionId: 'hive-session-1' })

    expect(mocks.setSelectedTicketId).not.toHaveBeenCalled()
  })

  it('handles ExitPlanMode failure hooks as plan followups', () => {
    renderHook(() => useClaudeCliStatusListener())

    subscribedCallback?.({
      sessionId: 'hive-session-1',
      status: 'planning',
      metadata: {
        hookEventName: 'PostToolUseFailure',
        hookPath: 'tool',
        toolName: 'ExitPlanMode'
      }
    })

    expect(mocks.clearPendingPlan).toHaveBeenCalledWith('hive-session-1')
    expect(mocks.notifyKanbanSessionSync).toHaveBeenCalledWith('hive-session-1', {
      type: 'plan_followup'
    })
    expect(mocks.lastSendMode.get('hive-session-1')).toBe('plan')
    expect(mocks.setSessionStatus).toHaveBeenCalledWith('hive-session-1', 'planning', {
      hookEventName: 'PostToolUseFailure',
      hookPath: 'tool',
      toolName: 'ExitPlanMode'
    })
  })
})

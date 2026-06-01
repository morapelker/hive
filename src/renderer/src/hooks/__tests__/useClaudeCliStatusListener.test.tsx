import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  onClaudeCliStatus: vi.fn(),
  setSessionStatus: vi.fn(),
  setPendingPlan: vi.fn(),
  clearPendingPlan: vi.fn(),
  notifyKanbanSessionSync: vi.fn(),
  lastSendMode: new Map<string, 'plan' | 'build'>(),
  modeBySession: new Map<string, 'build' | 'plan' | 'super-plan'>(),
  sessionStatuses: {} as Record<string, { status: string } | null>
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

vi.mock('@/api/terminal-api', () => ({
  terminalApi: {
    onClaudeCliStatus: mocks.onClaudeCliStatus
  }
}))

vi.mock('@/stores/store-coordination', () => ({
  notifyKanbanSessionSync: mocks.notifyKanbanSessionSync
}))

vi.mock('@/lib/message-send-times', () => ({
  lastSendMode: mocks.lastSendMode
}))

type SubscribedPayload = {
  sessionId: string
  status:
    | 'working'
    | 'planning'
    | 'answering'
    | 'permission'
    | 'command_approval'
    | 'unread'
    | 'completed'
    | 'plan_ready'
  metadata?: {
    reason?: string
    hookEventName?: string
    hookPath?: string
    toolName?: string
    plan?: string
  }
}

import { useClaudeCliStatusListener } from '../useClaudeCliStatusListener'

describe('useClaudeCliStatusListener', () => {
  let subscribedCallback: ((payload: SubscribedPayload) => void) | null
  const unsubscribe = vi.fn()

  beforeEach(() => {
    subscribedCallback = null
    mocks.onClaudeCliStatus.mockReset()
    mocks.onClaudeCliStatus.mockImplementation((callback: (payload: SubscribedPayload) => void) => {
      subscribedCallback = callback
      return unsubscribe
    })
    unsubscribe.mockClear()
    mocks.setSessionStatus.mockClear()
    mocks.setPendingPlan.mockClear()
    mocks.clearPendingPlan.mockClear()
    mocks.notifyKanbanSessionSync.mockClear()
    mocks.lastSendMode.clear()
    mocks.modeBySession.clear()
    mocks.sessionStatuses = {}
  })

  afterEach(() => {
    mocks.onClaudeCliStatus.mockReset()
  })

  it('subscribes to Claude CLI status events and writes payloads into the worktree status store', () => {
    const { unmount } = renderHook(() => useClaudeCliStatusListener())

    subscribedCallback?.({
      sessionId: 'hive-session-1',
      status: 'plan_ready',
      metadata: { hookEventName: 'PreToolUse', hookPath: 'tool' }
    })

    expect(mocks.onClaudeCliStatus).toHaveBeenCalledTimes(1)
    expect(mocks.setSessionStatus).toHaveBeenCalledWith('hive-session-1', 'plan_ready', {
      hookEventName: 'PreToolUse',
      hookPath: 'tool'
    })

    unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
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
})

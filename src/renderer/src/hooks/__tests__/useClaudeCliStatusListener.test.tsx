import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  onClaudeCliStatus: vi.fn(),
  setClaudeCliPlanAutoApprove: vi.fn().mockResolvedValue({ success: true }),
  setSessionStatus: vi.fn(),
  setPendingPlan: vi.fn(),
  clearPendingPlan: vi.fn(),
  setSessionMode: vi.fn().mockResolvedValue(undefined),
  notifyKanbanSessionSync: vi.fn(),
  setSelectedTicketId: vi.fn(),
  lastSendMode: new Map<string, 'plan' | 'build'>(),
  modeBySession: new Map<string, 'build' | 'plan' | 'super-plan'>(),
  sessionAgentSdk: new Map<string, string>(),
  sessionStatuses: {} as Record<string, { status: string } | null>,
  kanbanState: {
    selectedTicketId: null as string | null,
    tickets: new Map<
      string,
      Array<{
        id: string
        current_session_id: string | null
        auto_approve_plan?: boolean
        mode?: 'build' | 'plan' | 'super-plan' | null
        goal_mode?: boolean
      }>
    >()
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
      clearPendingPlan: mocks.clearPendingPlan,
      setSessionMode: mocks.setSessionMode,
      // Defaults to claude-code-cli so the plan-mode Stop→plan_ready fallback
      // stays active for the existing claude tests; a codex-cli case overrides it.
      getSessionById: (id: string) => ({
        agent_sdk: mocks.sessionAgentSdk.get(id) ?? 'claude-code-cli'
      })
    })
  }
}))

vi.mock('@/api/terminal-api', () => ({
  terminalApi: {
    onClaudeCliStatus: mocks.onClaudeCliStatus,
    setClaudeCliPlanAutoApprove: mocks.setClaudeCliPlanAutoApprove
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
    taskNotification?: boolean
  }
}

import { useClaudeCliStatusListener } from '../useClaudeCliStatusListener'
import { resetHandoffPickerState, setHandoffPickerOpen } from '@/lib/handoff-ui-state'

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
    mocks.setClaudeCliPlanAutoApprove.mockClear()
    mocks.setSessionStatus.mockClear()
    mocks.setPendingPlan.mockClear()
    mocks.clearPendingPlan.mockClear()
    mocks.setSessionMode.mockClear()
    mocks.setSelectedTicketId.mockClear()
    mocks.notifyKanbanSessionSync.mockClear()
    mocks.lastSendMode.clear()
    mocks.modeBySession.clear()
    mocks.sessionAgentSdk.clear()
    mocks.sessionStatuses = {}
    mocks.kanbanState = {
      selectedTicketId: null,
      tickets: new Map()
    }
  })

  afterEach(() => {
    mocks.onClaudeCliStatus.mockReset()
    resetHandoffPickerState()
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

  it('persists the session to build mode without PTY sync when a plan-mode terminal approval completes ExitPlanMode', () => {
    mocks.modeBySession.set('hive-session-1', 'plan')
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

    expect(mocks.setSessionMode).toHaveBeenCalledWith('hive-session-1', 'build', {
      syncCliPermissionMode: false
    })
  })

  it('persists super-plan sessions to build mode on terminal plan approval', () => {
    mocks.modeBySession.set('hive-session-1', 'super-plan')
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

    expect(mocks.setSessionMode).toHaveBeenCalledWith('hive-session-1', 'build', {
      syncCliPermissionMode: false
    })
  })

  it('leaves session mode untouched when ExitPlanMode completes for a build-mode session', () => {
    mocks.modeBySession.set('hive-session-1', 'build')
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

    expect(mocks.setSessionMode).not.toHaveBeenCalled()
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

  it('does NOT re-derive plan_ready from a tagless plan-mode Stop for codex-cli', () => {
    // codex-cli plan_ready is authoritative from <proposed_plan> detection; a
    // plain Stop (no plan block — e.g. it asked a question) must stay completed.
    mocks.modeBySession.set('hive-session-1', 'plan')
    mocks.lastSendMode.set('hive-session-1', 'plan')
    mocks.sessionAgentSdk.set('hive-session-1', 'codex-cli')
    renderHook(() => useClaudeCliStatusListener())

    subscribedCallback?.({
      sessionId: 'hive-session-1',
      status: 'completed',
      metadata: { hookEventName: 'Stop', hookPath: 'stop' }
    })

    expect(mocks.setSessionStatus).toHaveBeenLastCalledWith('hive-session-1', 'completed', {
      hookEventName: 'Stop',
      hookPath: 'stop'
    })
    expect(mocks.setSessionStatus).not.toHaveBeenCalledWith(
      'hive-session-1',
      'plan_ready',
      expect.anything()
    )
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

    subscribedCallback?.({
      sessionId: 'hive-session-1',
      status: 'planning',
      metadata: { reason: 'claude_cli_plan_followup' }
    })

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

    subscribedCallback?.({
      sessionId: 'hive-session-1',
      status: 'planning',
      metadata: { reason: 'claude_cli_plan_followup' }
    })

    expect(mocks.setSelectedTicketId).toHaveBeenCalledWith(null)
  })

  it('defers plan-followup teardown while a handoff picker for the session is open', () => {
    mocks.kanbanState = {
      selectedTicketId: 'ticket-plan',
      tickets: new Map([
        ['project-1', [{ id: 'ticket-plan', current_session_id: 'hive-session-1' }]]
      ])
    }
    setHandoffPickerOpen('picker-1', 'hive-session-1', true)
    renderHook(() => useClaudeCliStatusListener())

    subscribedCallback?.({
      sessionId: 'hive-session-1',
      status: 'planning',
      metadata: { reason: 'claude_cli_plan_followup' }
    })

    // The user is mid-handoff: keep the modal, plan card, and ticket state up.
    expect(mocks.clearPendingPlan).not.toHaveBeenCalled()
    expect(mocks.notifyKanbanSessionSync).not.toHaveBeenCalled()
    expect(mocks.setSelectedTicketId).not.toHaveBeenCalled()
    // Status bookkeeping still proceeds.
    expect(mocks.setSessionStatus).toHaveBeenCalledWith('hive-session-1', 'planning', {
      reason: 'claude_cli_plan_followup'
    })
  })

  it('defers terminal plan-approval teardown while a handoff picker for the session is open', () => {
    mocks.kanbanState = {
      selectedTicketId: 'ticket-plan',
      tickets: new Map([
        ['project-1', [{ id: 'ticket-plan', current_session_id: 'hive-session-1' }]]
      ])
    }
    setHandoffPickerOpen('picker-1', 'hive-session-1', true)
    renderHook(() => useClaudeCliStatusListener())

    subscribedCallback?.({
      sessionId: 'hive-session-1',
      status: 'working',
      metadata: { hookEventName: 'PostToolUse', hookPath: 'tool', toolName: 'ExitPlanMode' }
    })

    expect(mocks.clearPendingPlan).not.toHaveBeenCalled()
    expect(mocks.notifyKanbanSessionSync).not.toHaveBeenCalled()
    expect(mocks.setSelectedTicketId).not.toHaveBeenCalled()
    expect(mocks.setSessionStatus).toHaveBeenCalledWith('hive-session-1', 'working', {
      hookEventName: 'PostToolUse',
      hookPath: 'tool',
      toolName: 'ExitPlanMode'
    })
  })

  it('tears down normally when the open handoff picker belongs to another session', () => {
    setHandoffPickerOpen('picker-1', 'other-session', true)
    renderHook(() => useClaudeCliStatusListener())

    subscribedCallback?.({
      sessionId: 'hive-session-1',
      status: 'planning',
      metadata: { reason: 'claude_cli_plan_followup' }
    })

    expect(mocks.clearPendingPlan).toHaveBeenCalledWith('hive-session-1')
    expect(mocks.notifyKanbanSessionSync).toHaveBeenCalledWith('hive-session-1', {
      type: 'plan_followup'
    })
  })

  it('does not close the selected ticket modal for a different session followup', () => {
    mocks.kanbanState = {
      selectedTicketId: 'ticket-plan',
      tickets: new Map([
        ['project-1', [{ id: 'ticket-plan', current_session_id: 'other-session' }]]
      ])
    }
    renderHook(() => useClaudeCliStatusListener())

    subscribedCallback?.({
      sessionId: 'hive-session-1',
      status: 'planning',
      metadata: { reason: 'claude_cli_plan_followup' }
    })

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

  describe('background subagent auto-resume (task-notification) publishes', () => {
    it('preserves plan_ready and does not clear the pending plan when a subagent resume arrives while plan_ready', () => {
      mocks.sessionStatuses = { 'hive-session-1': { status: 'plan_ready' } }
      renderHook(() => useClaudeCliStatusListener())

      subscribedCallback?.({
        sessionId: 'hive-session-1',
        status: 'working',
        metadata: { hookEventName: 'UserPromptSubmit', hookPath: 'start', taskNotification: true }
      })

      expect(mocks.clearPendingPlan).not.toHaveBeenCalled()
      expect(mocks.lastSendMode.get('hive-session-1')).toBeUndefined()
      expect(mocks.setSessionStatus).not.toHaveBeenCalled()
    })

    it('falls through to a plain working status when a subagent resume arrives while not plan_ready', () => {
      mocks.sessionStatuses = { 'hive-session-1': { status: 'working' } }
      renderHook(() => useClaudeCliStatusListener())

      subscribedCallback?.({
        sessionId: 'hive-session-1',
        status: 'working',
        metadata: { hookEventName: 'UserPromptSubmit', hookPath: 'start', taskNotification: true }
      })

      expect(mocks.setSessionStatus).toHaveBeenCalledWith('hive-session-1', 'working', {
        hookEventName: 'UserPromptSubmit',
        hookPath: 'start',
        taskNotification: true
      })
    })

    it('falls through to a plain working status when a subagent resume arrives with no prior status', () => {
      renderHook(() => useClaudeCliStatusListener())

      subscribedCallback?.({
        sessionId: 'hive-session-1',
        status: 'working',
        metadata: { hookEventName: 'UserPromptSubmit', hookPath: 'start', taskNotification: true }
      })

      expect(mocks.setSessionStatus).toHaveBeenCalledWith('hive-session-1', 'working', {
        hookEventName: 'UserPromptSubmit',
        hookPath: 'start',
        taskNotification: true
      })
    })

    it('still performs the human plan-approval transition when a real UserPromptSubmit arrives while plan_ready', () => {
      mocks.sessionStatuses = { 'hive-session-1': { status: 'plan_ready' } }
      renderHook(() => useClaudeCliStatusListener())

      subscribedCallback?.({
        sessionId: 'hive-session-1',
        status: 'working',
        metadata: { hookEventName: 'UserPromptSubmit', hookPath: 'start' }
      })

      expect(mocks.lastSendMode.get('hive-session-1')).toBe('build')
      expect(mocks.setSessionStatus).toHaveBeenCalledWith('hive-session-1', 'working', {
        hookEventName: 'UserPromptSubmit',
        hookPath: 'start'
      })
    })

    it('does not trigger a plan followup for an auto-resume planning publish while plan_ready', () => {
      mocks.sessionStatuses = { 'hive-session-1': { status: 'plan_ready' } }
      renderHook(() => useClaudeCliStatusListener())

      subscribedCallback?.({
        sessionId: 'hive-session-1',
        status: 'planning',
        metadata: { hookEventName: 'UserPromptSubmit', hookPath: 'start', taskNotification: true }
      })

      expect(mocks.clearPendingPlan).not.toHaveBeenCalled()
      expect(mocks.notifyKanbanSessionSync).not.toHaveBeenCalled()
      expect(mocks.setSessionStatus).not.toHaveBeenCalled()
    })
  })
})

describe('useClaudeCliStatusListener — plan auto-approve arming', () => {
  let subscribedCallbackForAutoApprove: ((payload: SubscribedPayload) => void) | null = null

  beforeEach(() => {
    subscribedCallbackForAutoApprove = null
    mocks.setClaudeCliPlanAutoApprove.mockClear()
    mocks.sessionStatuses = {}
    mocks.kanbanState = { selectedTicketId: null, tickets: new Map() }
    mocks.onClaudeCliStatus.mockReset()
    mocks.onClaudeCliStatus.mockImplementation((callback: (payload: SubscribedPayload) => void) => {
      subscribedCallbackForAutoApprove = callback
      return vi.fn()
    })
  })

  it('re-asserts server-side arming on planning for an armed plan-like ticket', () => {
    mocks.kanbanState.tickets = new Map([
      [
        'proj-1',
        [
          {
            id: 'ticket-1',
            current_session_id: 'hive-session-1',
            auto_approve_plan: true,
            mode: 'plan',
            goal_mode: false
          }
        ]
      ]
    ])
    renderHook(() => useClaudeCliStatusListener())

    subscribedCallbackForAutoApprove?.({
      sessionId: 'hive-session-1',
      status: 'planning',
      metadata: { hookEventName: 'UserPromptSubmit', hookPath: 'start' }
    })

    expect(mocks.setClaudeCliPlanAutoApprove).toHaveBeenCalledWith('hive-session-1', true)
  })

  it('does not arm on planning when the linked ticket is not flagged', () => {
    mocks.kanbanState.tickets = new Map([
      [
        'proj-1',
        [
          {
            id: 'ticket-1',
            current_session_id: 'hive-session-1',
            auto_approve_plan: false,
            mode: 'plan',
            goal_mode: false
          }
        ]
      ]
    ])
    renderHook(() => useClaudeCliStatusListener())

    subscribedCallbackForAutoApprove?.({
      sessionId: 'hive-session-1',
      status: 'planning',
      metadata: { hookEventName: 'UserPromptSubmit', hookPath: 'start' }
    })

    expect(mocks.setClaudeCliPlanAutoApprove).not.toHaveBeenCalled()
  })

  it('does not arm on planning for a goal-mode ticket', () => {
    mocks.kanbanState.tickets = new Map([
      [
        'proj-1',
        [
          {
            id: 'ticket-1',
            current_session_id: 'hive-session-1',
            auto_approve_plan: true,
            mode: 'plan',
            goal_mode: true
          }
        ]
      ]
    ])
    renderHook(() => useClaudeCliStatusListener())

    subscribedCallbackForAutoApprove?.({
      sessionId: 'hive-session-1',
      status: 'planning',
      metadata: { hookEventName: 'UserPromptSubmit', hookPath: 'start' }
    })

    expect(mocks.setClaudeCliPlanAutoApprove).not.toHaveBeenCalled()
  })

  it('disarms server-side on PostToolUse ExitPlanMode (any plan approval)', () => {
    renderHook(() => useClaudeCliStatusListener())

    subscribedCallbackForAutoApprove?.({
      sessionId: 'hive-session-1',
      status: 'working',
      metadata: { hookEventName: 'PostToolUse', hookPath: 'tool', toolName: 'ExitPlanMode' }
    })

    expect(mocks.setClaudeCliPlanAutoApprove).toHaveBeenCalledWith('hive-session-1', false)
  })
})

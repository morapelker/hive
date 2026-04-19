import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

// ── Mock window APIs BEFORE importing stores ────────────────────────
const mockKanban = {
  ticket: {
    create: vi.fn(),
    get: vi.fn(),
    getByProject: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    move: vi.fn().mockResolvedValue(undefined),
    reorder: vi.fn(),
    getBySession: vi.fn()
  },
  simpleMode: { toggle: vi.fn() }
}

const mockDbSession = {
  create: vi.fn().mockResolvedValue({
    id: 'new-session-1',
    worktree_id: 'wt-1',
    project_id: 'proj-1',
    connection_id: null,
    name: 'Session 1',
    status: 'active',
    opencode_session_id: null,
    agent_sdk: 'claude-code',
    mode: 'plan',
    model_provider_id: null,
    model_id: null,
    model_variant: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    completed_at: null
  }),
  getActiveByWorktree: vi.fn().mockResolvedValue([]),
  update: vi.fn().mockResolvedValue(undefined),
  get: vi.fn().mockResolvedValue(null)
}

const mockDbWorktree = {
  getActiveByProject: vi.fn().mockResolvedValue([]),
  update: vi.fn().mockResolvedValue(undefined),
  get: vi.fn().mockResolvedValue(null)
}

const mockOpencodeOps = {
  connect: vi.fn().mockResolvedValue({ success: true, sessionId: 'opc-session-1' }),
  prompt: vi.fn().mockResolvedValue({ success: true }),
  reconnect: vi.fn().mockResolvedValue({ success: true }),
  getMessages: vi.fn().mockResolvedValue({ success: true, messages: [] }),
  planApprove: vi.fn().mockResolvedValue({ success: true }),
  abort: vi.fn().mockResolvedValue({ success: true }),
  commands: vi.fn().mockResolvedValue({
    success: true,
    commands: [{ name: 'using-superpowers' }]
  })
}

const mockWorktreeOps = {
  create: vi.fn().mockResolvedValue({ success: true }),
  duplicate: vi.fn().mockResolvedValue({ success: true })
}

const mockGitOps = {
  listBranchesWithStatus: vi.fn().mockResolvedValue({ success: true, branches: [] })
}

const mockConnectionOps = {
  get: vi.fn().mockResolvedValue({
    success: true,
    connection: {
      id: 'conn-1',
      path: '/test/conn-1',
      members: [{ project_id: 'proj-1', worktree_id: 'wt-1' }]
    }
  })
}

Object.defineProperty(window, 'connectionOps', {
  writable: true,
  configurable: true,
  value: mockConnectionOps
})

Object.defineProperty(window, 'kanban', {
  writable: true,
  configurable: true,
  value: mockKanban
})

Object.defineProperty(window, 'db', {
  writable: true,
  configurable: true,
  value: {
    session: mockDbSession,
    worktree: mockDbWorktree
  }
})

Object.defineProperty(window, 'opencodeOps', {
  writable: true,
  configurable: true,
  value: mockOpencodeOps
})

Object.defineProperty(window, 'worktreeOps', {
  writable: true,
  configurable: true,
  value: mockWorktreeOps
})

Object.defineProperty(window, 'gitOps', {
  writable: true,
  configurable: true,
  value: mockGitOps
})

// ── Mock toast ──────────────────────────────────────────────────────
vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn()
  },
  default: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn()
  }
}))

// ── Mock MarkdownRenderer and react-markdown ────────────────────────
vi.mock('@/components/sessions/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="markdown-renderer">{content}</div>
  )
}))

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>
}))

vi.mock('remark-gfm', () => ({
  default: {}
}))

// ── Import stores AFTER mocking ─────────────────────────────────────
import { toast } from '@/lib/toast'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'

// ── Import components under test ────────────────────────────────────
import { KanbanTicketModal } from '@/components/kanban/KanbanTicketModal'

import type { KanbanTicket } from '../../src/main/db/types'

// ── Helpers ─────────────────────────────────────────────────────────
function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: 'proj-1',
    title: 'Implement auth flow',
    description: 'Add login and signup pages with JWT tokens',
    attachments: [],
    column: 'todo',
    sort_order: 0,
    current_session_id: null,
    worktree_id: null,
    mode: null,
    plan_ready: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides
  }
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    worktree_id: 'wt-1',
    project_id: 'proj-1',
    connection_id: null,
    name: 'Session 1',
    status: 'active' as const,
    opencode_session_id: 'opc-session-1',
    agent_sdk: 'claude-code' as const,
    mode: 'plan' as const,
    model_provider_id: null,
    model_id: null,
    model_variant: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    completed_at: null,
    ...overrides
  }
}

function makeWorktree(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wt-1',
    project_id: 'proj-1',
    name: 'feature-auth',
    branch_name: 'feature-auth',
    path: '/test/feature-auth',
    status: 'active' as const,
    is_default: false,
    branch_renamed: 0,
    last_message_at: null,
    session_titles: '[]',
    last_model_provider_id: null,
    last_model_id: null,
    last_model_variant: null,
    created_at: '2026-01-01T00:00:00Z',
    last_accessed_at: '2026-01-01T00:00:00Z',
    github_pr_number: null,
    github_pr_url: null,
    ...overrides
  }
}

function makeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proj-1',
    name: 'My Project',
    path: '/test/my-project',
    description: null,
    tags: null,
    language: null,
    custom_icon: null,
    setup_script: null,
    run_script: null,
    archive_script: null,
    auto_assign_port: false,
    sort_order: 0,
    created_at: '2026-01-01T00:00:00Z',
    last_accessed_at: '2026-01-01T00:00:00Z',
    ...overrides
  }
}

// ── Setup ───────────────────────────────────────────────────────────
describe('Plan review followup dispatch', () => {
  const planTicket = makeTicket({
    id: 'ticket-plan',
    column: 'in_progress',
    plan_ready: true,
    current_session_id: 'session-1',
    worktree_id: 'wt-1',
    mode: 'plan',
    description: '## Plan\n\nStep 1: Setup routes'
  })

  beforeEach(() => {
    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [planTicket]]]),
        isLoading: false,
        isBoardViewActive: true,
        simpleModeByProject: {},
        selectedTicketId: 'ticket-plan'
      })
      useWorktreeStore.setState({
        selectedWorktreeId: null,
        worktreesByProject: new Map([['proj-1', [makeWorktree()]]])
      })
      useSessionStore.setState({
        activeSessionId: null,
        isLoading: false,
        sessionsByWorktree: new Map([['wt-1', [makeSession()]]]),
        sessionsByConnection: new Map(),
        closedTerminalSessionIds: new Set(),
        inlineConnectionSessionId: null,
        modeBySession: new Map(),
        pendingPlans: new Map([
          [
            'session-1',
            {
              requestId: 'req-1',
              planContent: '## Detailed Plan\n\nStep 1: Setup routes\nStep 2: Add auth',
              toolUseID: 'tool-1'
            }
          ]
        ]),
        pendingMessages: new Map(),
        pendingFollowUpMessages: new Map()
      })
      useWorktreeStatusStore.setState({
        sessionStatuses: {}
      })
      useProjectStore.setState({
        projects: [makeProject()]
      })
    })
    vi.clearAllMocks()
    mockKanban.ticket.getBySession.mockImplementation(async (sessionId: string) => {
      const tickets = [...useKanbanStore.getState().tickets.values()].flat()
      return tickets.filter((ticket) => ticket.current_session_id === sessionId)
    })
  })

  // ════════════════════════════════════════════════════════════════════
  // P0 REGRESSION: Followup must actually be sent to the session
  // ════════════════════════════════════════════════════════════════════

  test('sends followup to session when rejecting plan with feedback', async () => {
    render(<KanbanTicketModal />)

    const input = screen.getByTestId('plan-review-followup-input') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'Please add error handling to step 2' } })

    const sendBtn = screen.getByTestId('plan-review-send-followup-btn')
    await act(async () => {
      fireEvent.click(sendBtn)
    })

    await waitFor(() => {
      expect(mockOpencodeOps.prompt).toHaveBeenCalledWith(
        '/test/feature-auth',
        'opc-session-1',
        [{ type: 'text', text: 'Please add error handling to step 2' }],
        undefined
      )
    })
  })

  test('clears pending plan before sending followup', async () => {
    render(<KanbanTicketModal />)

    const input = screen.getByTestId('plan-review-followup-input') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'Revise the plan' } })

    await act(async () => {
      fireEvent.click(screen.getByTestId('plan-review-send-followup-btn'))
    })

    // Pending plan should be cleared
    const pendingPlan = useSessionStore.getState().pendingPlans.get('session-1')
    expect(pendingPlan).toBeUndefined()

    // Prompt should still be sent
    await waitFor(() => {
      expect(mockOpencodeOps.prompt).toHaveBeenCalled()
    })
  })

  test('sets session status to planning', async () => {
    render(<KanbanTicketModal />)

    const input = screen.getByTestId('plan-review-followup-input') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'Add more detail' } })

    await act(async () => {
      fireEvent.click(screen.getByTestId('plan-review-send-followup-btn'))
    })

    const statuses = useWorktreeStatusStore.getState().sessionStatuses
    expect(statuses['session-1']?.status).toBe('planning')
  })

  test('closes modal immediately without blocking on prompt', async () => {
    // Make prompt() return a promise that never resolves (simulating a long session)
    let resolvePrompt!: () => void
    mockOpencodeOps.prompt.mockReturnValue(
      new Promise<{ success: boolean }>((resolve) => {
        resolvePrompt = () => resolve({ success: true })
      })
    )

    render(<KanbanTicketModal />)

    const input = screen.getByTestId('plan-review-followup-input') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'Revise step 1' } })

    await act(async () => {
      fireEvent.click(screen.getByTestId('plan-review-send-followup-btn'))
    })

    // Modal should close immediately (toast fires before prompt resolves)
    expect(toast.success).toHaveBeenCalledWith('Plan rejected with feedback')

    // Verify prompt was fired in the background
    await waitFor(() => {
      expect(mockOpencodeOps.prompt).toHaveBeenCalled()
    })

    // Clean up: resolve the pending promise to avoid unhandled rejection
    await act(async () => {
      resolvePrompt()
      await new Promise((r) => setTimeout(r, 0))
    })
  })

  test('shows error toast when followup send fails', async () => {
    mockOpencodeOps.prompt.mockRejectedValueOnce(new Error('Connection lost'))

    render(<KanbanTicketModal />)

    const input = screen.getByTestId('plan-review-followup-input') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'Add validation' } })

    await act(async () => {
      fireEvent.click(screen.getByTestId('plan-review-send-followup-btn'))
    })

    // Allow background promise chain (sendFollowupToSession → reconnect → throw → catch) to complete
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('Connection lost')
      )
    })

    // Session status should be cleared on failure
    const statuses = useWorktreeStatusStore.getState().sessionStatuses
    expect(statuses['session-1']).toBeFalsy()
  })

  // ════════════════════════════════════════════════════════════════════
  // P2 REGRESSION: Reconnect failure should surface as error
  // ════════════════════════════════════════════════════════════════════

  test('shows error when reconnect fails', async () => {
    mockOpencodeOps.reconnect.mockResolvedValue({ success: false })

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    render(<KanbanTicketModal />)

    const input = screen.getByTestId('plan-review-followup-input') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'Fix the plan' } })

    await act(async () => {
      fireEvent.click(screen.getByTestId('plan-review-send-followup-btn'))
    })

    // Allow background promise chain (sendFollowupToSession → reconnect → throw → catch) to complete
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100))
    })

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to send followup')
      )
    }, { timeout: 3000 })

    // prompt should never have been called
    expect(mockOpencodeOps.prompt).not.toHaveBeenCalled()

    errorSpy.mockRestore()
  })

  test('codex supercharge from ticket view stays on the board and starts background work', async () => {
    const codexPlanTicket = makeTicket({
      id: 'ticket-codex',
      column: 'review',
      plan_ready: true,
      current_session_id: 'session-codex-old',
      worktree_id: 'wt-1',
      mode: 'plan',
      description: '## Plan\n\nStep 1: Implement auth flow'
    })

    mockDbSession.create.mockResolvedValueOnce(
      makeSession({
        id: 'session-codex-new',
        agent_sdk: 'codex',
        mode: 'build',
        opencode_session_id: null
      })
    )

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [codexPlanTicket]]]),
        isBoardViewActive: true,
        selectedTicketId: 'ticket-codex'
      })
      useSessionStore.setState({
        activeSessionId: null,
        activeWorktreeId: null,
        sessionsByWorktree: new Map([
          [
            'wt-1',
            [makeSession({ id: 'session-codex-old', agent_sdk: 'codex', opencode_session_id: 'opc-session-1' })]
          ]
        ]),
        pendingPlans: new Map([
          [
            'session-codex-old',
            {
              requestId: 'req-codex',
              planContent: '## Detailed Plan\n\nStep 1: Implement auth flow',
              toolUseID: 'tool-codex'
            }
          ]
        ]),
        pendingMessages: new Map(),
        pendingFollowUpMessages: new Map()
      })
      useWorktreeStatusStore.setState({
        sessionStatuses: {}
      })
      useWorktreeStore.setState({
        selectedWorktreeId: null,
        worktreesByProject: new Map([['proj-1', [makeWorktree()]]])
      })
    })

    render(<KanbanTicketModal />)

    const superchargeLocalBtn = await screen.findByTestId('plan-review-supercharge-local-btn')
    await act(async () => {
      fireEvent.click(superchargeLocalBtn)
    })

    await waitFor(() => {
      expect(mockOpencodeOps.connect).toHaveBeenCalledWith('/test/feature-auth', 'session-codex-new')
    })

    await waitFor(() => {
      expect(mockOpencodeOps.prompt).toHaveBeenCalled()
    })

    const promptCall = mockOpencodeOps.prompt.mock.calls.at(-1)
    expect(promptCall?.[0]).toBe('/test/feature-auth')
    expect(promptCall?.[1]).toBe('opc-session-1')
    expect(promptCall?.[2]).toEqual([{ type: 'text', text: '/using-superpowers' }])

    const updatedTicket = useKanbanStore.getState().tickets.get('proj-1')?.find((t) => t.id === 'ticket-codex')
    expect(updatedTicket?.current_session_id).toBe('session-codex-new')
    expect(updatedTicket?.plan_ready).toBe(false)
    expect(updatedTicket?.mode).toBe('build')
    expect(updatedTicket?.column).toBe('in_progress')

    expect(useKanbanStore.getState().isBoardViewActive).toBe(true)
    expect(useKanbanStore.getState().selectedTicketId).toBeNull()
    expect(useWorktreeStore.getState().selectedWorktreeId).toBeNull()
    expect(useSessionStore.getState().activeSessionId).toBeNull()

    expect(useWorktreeStatusStore.getState().sessionStatuses['session-codex-new']?.status).toBe('working')
    expect(
      useSessionStore.getState().pendingFollowUpMessages.get('session-codex-new')
    ).toEqual([
      'use the subagent development skill to implement the following plan:\n## Detailed Plan\n\nStep 1: Implement auth flow'
    ])
  })

  test('plan review supercharge derives a branch name from the plan heading', async () => {
    const codexPlanTicket = makeTicket({
      id: 'ticket-codex',
      column: 'review',
      plan_ready: true,
      current_session_id: 'session-codex-old',
      worktree_id: 'wt-1',
      mode: 'plan',
      description: '# Add `mul_998` function\n\nImplement the new helper'
    })

    mockWorktreeOps.duplicate.mockResolvedValueOnce({
      success: true,
      worktree: makeWorktree({
        id: 'wt-2',
        name: 'add-mul-998-function',
        branch_name: 'add-mul-998-function',
        path: '/test/add-mul-998-function'
      })
    })

    mockDbSession.create.mockResolvedValueOnce(
      makeSession({
        id: 'session-codex-new',
        agent_sdk: 'codex',
        mode: 'build',
        opencode_session_id: null,
        worktree_id: 'wt-2'
      })
    )

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [codexPlanTicket]]]),
        isBoardViewActive: true,
        selectedTicketId: 'ticket-codex'
      })
      useSessionStore.setState({
        activeSessionId: null,
        activeWorktreeId: null,
        sessionsByWorktree: new Map([
          [
            'wt-1',
            [makeSession({ id: 'session-codex-old', agent_sdk: 'codex', opencode_session_id: 'opc-session-1' })]
          ]
        ]),
        pendingPlans: new Map([
          [
            'session-codex-old',
            {
              requestId: 'req-codex',
              planContent: '# Add `mul_998` function\n\nImplement the new helper',
              toolUseID: 'tool-codex'
            }
          ]
        ]),
        pendingMessages: new Map(),
        pendingFollowUpMessages: new Map()
      })
      useWorktreeStatusStore.setState({
        sessionStatuses: {}
      })
      useWorktreeStore.setState({
        selectedWorktreeId: null,
        worktreesByProject: new Map([['proj-1', [makeWorktree()]]])
      })
    })

    render(<KanbanTicketModal />)

    const superchargeBtn = await screen.findByTestId('plan-review-supercharge-btn')
    await act(async () => {
      fireEvent.click(superchargeBtn)
    })

    await waitFor(() => {
      expect(mockWorktreeOps.duplicate).toHaveBeenCalledWith({
        projectId: 'proj-1',
        projectPath: '/test/my-project',
        projectName: 'My Project',
        sourceBranch: 'feature-auth',
        sourceWorktreePath: '/test/feature-auth',
        nameHint: 'add-mul-998-function'
      })
    })
  })

  test('supercharge does not leave session stuck "working" when background connect fails', async () => {
    const codexPlanTicket = makeTicket({
      id: 'ticket-codex',
      column: 'review',
      plan_ready: true,
      current_session_id: 'session-codex-old',
      worktree_id: 'wt-1',
      mode: 'plan',
      description: '## Plan\n\nStep 1: Implement auth flow'
    })

    mockDbSession.create.mockResolvedValueOnce(
      makeSession({
        id: 'session-codex-new',
        agent_sdk: 'codex',
        mode: 'build',
        opencode_session_id: null
      })
    )

    // Background connect fails — modal has already closed.
    mockOpencodeOps.connect.mockResolvedValueOnce({ success: false })

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [codexPlanTicket]]]),
        isBoardViewActive: true,
        selectedTicketId: 'ticket-codex'
      })
      useSessionStore.setState({
        activeSessionId: null,
        activeWorktreeId: null,
        sessionsByWorktree: new Map([
          [
            'wt-1',
            [makeSession({ id: 'session-codex-old', agent_sdk: 'codex', opencode_session_id: 'opc-session-1' })]
          ]
        ]),
        pendingPlans: new Map([
          [
            'session-codex-old',
            {
              requestId: 'req-codex',
              planContent: '## Detailed Plan\n\nStep 1: Implement auth flow',
              toolUseID: 'tool-codex'
            }
          ]
        ]),
        pendingMessages: new Map(),
        pendingFollowUpMessages: new Map()
      })
      useWorktreeStatusStore.setState({ sessionStatuses: {} })
      useWorktreeStore.setState({
        selectedWorktreeId: null,
        worktreesByProject: new Map([['proj-1', [makeWorktree()]]])
      })
    })

    render(<KanbanTicketModal />)

    const superchargeLocalBtn = await screen.findByTestId('plan-review-supercharge-local-btn')
    await act(async () => {
      fireEvent.click(superchargeLocalBtn)
    })

    // Wait for the background IIFE to reach connect (which we've forced to fail).
    await waitFor(() => {
      expect(mockOpencodeOps.connect).toHaveBeenCalledWith('/test/feature-auth', 'session-codex-new')
    })

    // Let the failing background chain settle.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })

    // prompt must not have fired — we never got a valid opencode session id.
    expect(mockOpencodeOps.prompt).not.toHaveBeenCalled()

    // Regression guard: connect failure must not leave the new session stuck in 'working'.
    expect(
      useWorktreeStatusStore.getState().sessionStatuses['session-codex-new']?.status
    ).not.toBe('working')

    // User is told the supercharge failed, not falsely told it started.
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('upercharge'))

    errorSpy.mockRestore()
  })

  test('supercharge shows success toast only after background work succeeds', async () => {
    const codexPlanTicket = makeTicket({
      id: 'ticket-codex',
      column: 'review',
      plan_ready: true,
      current_session_id: 'session-codex-old',
      worktree_id: 'wt-1',
      mode: 'plan',
      description: '## Plan\n\nStep 1: Implement auth flow'
    })

    mockDbSession.create.mockResolvedValueOnce(
      makeSession({
        id: 'session-codex-new',
        agent_sdk: 'codex',
        mode: 'build',
        opencode_session_id: null
      })
    )

    // Hold prompt pending so success can't be claimed until we release it.
    let resolvePrompt!: () => void
    mockOpencodeOps.prompt.mockReturnValue(
      new Promise<{ success: boolean }>((resolve) => {
        resolvePrompt = () => resolve({ success: true })
      })
    )

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [codexPlanTicket]]]),
        isBoardViewActive: true,
        selectedTicketId: 'ticket-codex'
      })
      useSessionStore.setState({
        activeSessionId: null,
        activeWorktreeId: null,
        sessionsByWorktree: new Map([
          [
            'wt-1',
            [makeSession({ id: 'session-codex-old', agent_sdk: 'codex', opencode_session_id: 'opc-session-1' })]
          ]
        ]),
        pendingPlans: new Map([
          [
            'session-codex-old',
            {
              requestId: 'req-codex',
              planContent: '## Detailed Plan\n\nStep 1: Implement auth flow',
              toolUseID: 'tool-codex'
            }
          ]
        ]),
        pendingMessages: new Map(),
        pendingFollowUpMessages: new Map()
      })
      useWorktreeStatusStore.setState({ sessionStatuses: {} })
      useWorktreeStore.setState({
        selectedWorktreeId: null,
        worktreesByProject: new Map([['proj-1', [makeWorktree()]]])
      })
    })

    render(<KanbanTicketModal />)

    const superchargeLocalBtn = await screen.findByTestId('plan-review-supercharge-local-btn')
    await act(async () => {
      fireEvent.click(superchargeLocalBtn)
    })

    // Wait for the background work to reach prompt (still pending).
    await waitFor(() => {
      expect(mockOpencodeOps.prompt).toHaveBeenCalled()
    })

    // Success cannot be claimed while background prompt is still in flight.
    expect(toast.success).not.toHaveBeenCalledWith(expect.stringContaining('upercharge'))

    // Release the background prompt — now success should be reported.
    await act(async () => {
      resolvePrompt()
      await new Promise((r) => setTimeout(r, 0))
    })

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('upercharge'))
    })
  })

  // ════════════════════════════════════════════════════════════════════
  // REGRESSION: Handoff for a connection ticket from the kanban board
  // must actually switch to the new session in non-sticky-tab mode.
  // setActiveConnectionSession short-circuits when activeConnectionId is
  // null (the common state when the modal is opened from the board), so
  // the handler must also set the active connection.
  // ════════════════════════════════════════════════════════════════════

  test('handoff on connection ticket (non-sticky-tab) switches to the new connection session', async () => {
    const connTicket = makeTicket({
      id: 'ticket-conn',
      column: 'in_progress',
      plan_ready: true,
      current_session_id: 'session-conn-old',
      worktree_id: null, // connection ticket has no worktree
      mode: 'plan',
      description: '## Plan\n\nStep 1: Implement auth'
    })

    mockDbSession.create.mockResolvedValueOnce(
      makeSession({
        id: 'session-conn-new',
        worktree_id: null,
        connection_id: 'conn-1',
        agent_sdk: 'claude-code',
        mode: 'build',
        opencode_session_id: null
      })
    )

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [connTicket]]]),
        isBoardViewActive: true,
        selectedTicketId: 'ticket-conn'
      })
      useSessionStore.setState({
        activeSessionId: null,
        activeConnectionId: null, // user is on the board, not in a connection
        activeWorktreeId: null,
        sessionsByWorktree: new Map(),
        sessionsByConnection: new Map([
          [
            'conn-1',
            [
              makeSession({
                id: 'session-conn-old',
                worktree_id: null,
                connection_id: 'conn-1',
                agent_sdk: 'claude-code',
                opencode_session_id: 'opc-session-1'
              })
            ]
          ]
        ]),
        tabOrderByConnection: new Map([['conn-1', ['session-conn-old']]]),
        activeSessionByConnection: {},
        pendingPlans: new Map([
          [
            'session-conn-old',
            {
              requestId: 'req-conn',
              planContent: '## Detailed Plan\n\nStep 1: Implement auth',
              toolUseID: 'tool-conn'
            }
          ]
        ]),
        pendingMessages: new Map(),
        pendingFollowUpMessages: new Map()
      })
      useWorktreeStatusStore.setState({ sessionStatuses: {} })
      useConnectionStore.setState({
        connections: [
          {
            id: 'conn-1',
            name: 'Test Conn',
            custom_name: null,
            status: 'active',
            path: '/test/conn-1',
            color: null,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            members: [
              {
                id: 'mem-1',
                connection_id: 'conn-1',
                worktree_id: 'wt-1',
                project_id: 'proj-1',
                symlink_name: 'wt-1',
                added_at: '2026-01-01T00:00:00Z',
                worktree_name: 'feature-auth',
                worktree_branch: 'feature-auth',
                worktree_path: '/test/feature-auth',
                project_name: 'My Project'
              }
            ]
          }
        ]
      })
      useSettingsStore.setState({ boardMode: 'toggle' })
    })

    render(<KanbanTicketModal />)

    const handoffBtn = await screen.findByTestId('plan-review-handoff-btn')
    await act(async () => {
      fireEvent.click(handoffBtn)
    })

    // New session is created in the DB
    await waitFor(() => {
      expect(mockDbSession.create).toHaveBeenCalled()
    })

    // In non-sticky-tab mode, the user should be navigated to the new
    // connection session — which requires activeConnectionId to be set so
    // the shell can render the connection context (setActiveConnectionSession
    // alone is a no-op when activeConnectionId is null).
    await waitFor(() => {
      expect(useSessionStore.getState().activeConnectionId).toBe('conn-1')
    })
    expect(useSessionStore.getState().activeSessionId).toBe('session-conn-new')
    expect(mockOpencodeOps.connect).toHaveBeenCalledWith('/test/conn-1', 'session-conn-new')
    expect(mockOpencodeOps.prompt).toHaveBeenCalledWith(
      '/test/conn-1',
      'opc-session-1',
      [{ type: 'text', text: 'Implement the following plan\n## Detailed Plan\n\nStep 1: Implement auth' }],
      undefined
    )

    // Ticket is re-linked to the new session with plan_ready cleared.
    const updatedTicket = useKanbanStore
      .getState()
      .tickets.get('proj-1')
      ?.find((t) => t.id === 'ticket-conn')
    expect(updatedTicket?.current_session_id).toBe('session-conn-new')
    expect(updatedTicket?.plan_ready).toBe(false)
    expect(updatedTicket?.mode).toBe('build')
    expect(updatedTicket?.column).toBe('in_progress')
    expect(useWorktreeStatusStore.getState().sessionStatuses['session-conn-new']?.status).toBe('working')
  })

  test('handoff on worktree ticket relinks the ticket to the new session', async () => {
    mockDbSession.create.mockResolvedValueOnce(
      makeSession({
        id: 'session-worktree-new',
        worktree_id: 'wt-1',
        connection_id: null,
        agent_sdk: 'claude-code',
        mode: 'build',
        opencode_session_id: null
      })
    )

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [planTicket]]]),
        isBoardViewActive: true,
        selectedTicketId: 'ticket-plan'
      })
      useSessionStore.setState({
        activeSessionId: null,
        activeWorktreeId: 'wt-1',
        sessionsByWorktree: new Map([['wt-1', [makeSession({ id: 'session-1' })]]]),
        sessionsByConnection: new Map(),
        tabOrderByWorktree: new Map([['wt-1', ['session-1']]]),
        activeSessionByWorktree: {},
        pendingPlans: new Map([
          [
            'session-1',
            {
              requestId: 'req-1',
              planContent: '## Detailed Plan\n\nStep 1: Setup routes\nStep 2: Add auth',
              toolUseID: 'tool-1'
            }
          ]
        ]),
        pendingMessages: new Map(),
        pendingFollowUpMessages: new Map()
      })
      useWorktreeStore.setState({
        selectedWorktreeId: 'wt-1',
        worktreesByProject: new Map([['proj-1', [makeWorktree()]]])
      })
      useWorktreeStatusStore.setState({ sessionStatuses: {} })
      useSettingsStore.setState({ boardMode: 'toggle' })
    })

    render(<KanbanTicketModal />)

    const handoffBtn = await screen.findByTestId('plan-review-handoff-btn')
    await act(async () => {
      fireEvent.click(handoffBtn)
    })

    await waitFor(() => {
      expect(mockDbSession.create).toHaveBeenCalled()
    })

    await waitFor(() => {
      expect(useSessionStore.getState().activeSessionId).toBe('session-worktree-new')
    })
    expect(mockOpencodeOps.connect).toHaveBeenCalledWith('/test/feature-auth', 'session-worktree-new')
    expect(mockOpencodeOps.prompt).toHaveBeenCalledWith(
      '/test/feature-auth',
      'opc-session-1',
      [{ type: 'text', text: 'Implement the following plan\n## Detailed Plan\n\nStep 1: Setup routes\nStep 2: Add auth' }],
      undefined
    )

    const updatedTicket = useKanbanStore
      .getState()
      .tickets.get('proj-1')
      ?.find((t) => t.id === 'ticket-plan')
    expect(updatedTicket?.current_session_id).toBe('session-worktree-new')
    expect(updatedTicket?.plan_ready).toBe(false)
    expect(updatedTicket?.mode).toBe('build')
    expect(updatedTicket?.column).toBe('in_progress')
    expect(useWorktreeStatusStore.getState().sessionStatuses['session-worktree-new']?.status).toBe('working')
  })
})

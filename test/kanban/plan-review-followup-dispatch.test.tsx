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
  planApprove: vi.fn().mockResolvedValue({ success: true }),
  abort: vi.fn().mockResolvedValue({ success: true })
}

const mockWorktreeOps = {
  create: vi.fn().mockResolvedValue({ success: true }),
  duplicate: vi.fn().mockResolvedValue({ success: true })
}

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
})

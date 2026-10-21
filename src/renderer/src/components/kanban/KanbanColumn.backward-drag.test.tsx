/**
 * Dragging an In Progress ticket with a session back to To Do stops the session: the row
 * is marked completed, the ticket unlinked, and every PTY-backed session (claude / codex
 * CLI, shell command) has its process destroyed and its hidden terminal view released —
 * a completed row must not keep a live agent behind it. SDK sessions are aborted instead.
 */
import type { PropsWithChildren } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanColumn } from '@/components/kanban/KanbanColumn'
import { TooltipProvider } from '@/components/ui/tooltip'
import { setKanbanDragData, useKanbanStore } from '@/stores/useKanbanStore'
import { useSessionStore } from '@/stores/useSessionStore'
import type { KanbanTicket, Session } from '../../../../main/db/types'

const dbApiMocks = vi.hoisted(() => ({
  session: { get: vi.fn(), update: vi.fn() },
  worktree: { get: vi.fn(), getActiveByProject: vi.fn() }
}))
const terminalApiMocks = vi.hoisted(() => ({ destroy: vi.fn() }))
const opencodeApiMocks = vi.hoisted(() => ({ abort: vi.fn() }))
const getBySession = vi.hoisted(() => vi.fn())

vi.mock('@/api/db-api', () => ({ dbApi: dbApiMocks }))
vi.mock('@/api/terminal-api', () => ({ terminalApi: terminalApiMocks }))
vi.mock('@/api/opencode-api', () => ({ opencodeApi: opencodeApiMocks }))
vi.mock('@/api/kanban-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/kanban-api')>()
  return {
    kanbanApi: { ...actual.kanbanApi, ticket: { ...actual.kanbanApi.ticket, getBySession } }
  }
})

vi.mock('@/components/kanban/KanbanTicketCard', () => ({
  KanbanTicketCard: ({ ticket }: { ticket: KanbanTicket }) => (
    <div data-testid="kanban-ticket-card" data-ticket-id={ticket.id} />
  )
}))
vi.mock('@/components/kanban/WorktreePickerModal', () => ({ WorktreePickerModal: () => null }))
vi.mock('@/components/kanban/TicketCreateModal', () => ({ TicketCreateModal: () => null }))
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))
vi.mock('motion/react', () => ({
  LayoutGroup: ({ children }: PropsWithChildren) => <>{children}</>,
  motion: {
    div: ({
      children,
      layoutId: _layoutId,
      layout: _layout,
      layoutScroll: _layoutScroll,
      transition: _transition,
      ...props
    }: PropsWithChildren<Record<string, unknown>>) => <div {...props}>{children}</div>
  }
}))

import { toast } from '@/lib/toast'

const initialKanbanState = useKanbanStore.getState()
const initialSessionState = useSessionStore.getState()
const now = '2026-06-01T00:00:00.000Z'
const SESSION_ID = 'session-1'

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: 'proj-1',
    title: 'Fix the login form',
    description: null,
    attachments: [],
    column: 'in_progress',
    sort_order: 0,
    current_session_id: SESSION_ID,
    worktree_id: 'wt-1',
    mode: 'build',
    plan_ready: false,
    created_at: now,
    updated_at: now,
    column_changed_at: null,
    archived_at: null,
    external_provider: null,
    external_id: null,
    external_url: null,
    github_pr_number: null,
    github_pr_url: null,
    sync_task_id: null,
    sync_task_title: null,
    sync_task_status: null,
    sync_task_org_id: null,
    mark: null,
    total_tokens: 0,
    pending_launch_config: null,
    goal_mode: false,
    goal_success_criteria: null,
    note: null,
    created_from_session: false,
    auto_approve_plan: false,
    unread: false,
    awaiting_completion: false,
    model_provider_id: null,
    model_id: null,
    model_variant: null,
    variant_group_id: null,
    ticket_prefix: null,
    ticket_number: null,
    parent_ticket_id: null,
    parent_ticket_key: null,
    ...overrides
  }
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: SESSION_ID,
    worktree_id: 'wt-1',
    project_id: 'proj-1',
    connection_id: null,
    name: 'Session',
    status: 'active',
    opencode_session_id: null,
    claude_session_id: 'claude-1',
    agent_sdk: 'claude-code-cli',
    mode: 'build',
    session_type: 'default',
    model_provider_id: null,
    model_id: null,
    model_variant: null,
    remote_launch: null,
    created_at: now,
    updated_at: now,
    completed_at: null,
    pinned_to_board: false,
    ...overrides
  } as Session
}

const updateTicket = vi.fn()
const moveTicket = vi.fn()

/** Drag the ticket from In Progress onto To Do and confirm the stop. */
async function dragBackAndConfirm(ticket: KanbanTicket): Promise<void> {
  useKanbanStore.setState({ tickets: new Map([[ticket.project_id, [ticket]]]) })
  render(
    <TooltipProvider>
      <KanbanColumn column="todo" projectId="proj-1" tickets={[]} />
    </TooltipProvider>
  )
  setKanbanDragData({
    projectId: ticket.project_id,
    ticketId: ticket.id,
    sourceColumn: 'in_progress',
    sourceIndex: 0
  })
  await act(async () => {
    fireEvent.drop(screen.getByTestId('kanban-drop-area-todo'))
  })
  expect(screen.getByTestId('backward-drag-confirm-dialog')).toBeInTheDocument()
  await act(async () => {
    fireEvent.click(screen.getByTestId('backward-drag-confirm-btn'))
  })
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  )
  dbApiMocks.session.get.mockResolvedValue(makeSession())
  dbApiMocks.session.update.mockResolvedValue(makeSession({ status: 'completed' }))
  dbApiMocks.worktree.get.mockResolvedValue({ id: 'wt-1', path: '/repo/wt-1' })
  dbApiMocks.worktree.getActiveByProject.mockResolvedValue([])
  terminalApiMocks.destroy.mockResolvedValue({ success: true, value: undefined })
  opencodeApiMocks.abort.mockResolvedValue({ success: true, value: undefined })
  getBySession.mockResolvedValue([makeTicket()])
  updateTicket.mockResolvedValue(undefined)
  moveTicket.mockResolvedValue(undefined)
  useKanbanStore.setState({
    tickets: new Map(),
    markdownDiagnostics: new Map(),
    markdownPlaceholders: new Map(),
    dependencyMap: new Map(),
    draggingTicketKey: null,
    simpleModeByProject: {},
    updateTicket,
    moveTicket
  })
})

afterEach(async () => {
  await act(async () => {})
  cleanup()
  vi.unstubAllGlobals()
  vi.resetAllMocks()
  setKanbanDragData(null)
  useKanbanStore.setState(initialKanbanState, true)
  useSessionStore.setState(initialSessionState, true)
})

describe('backward drag to To Do stops the session', () => {
  it.each([
    ['claude CLI', makeSession()],
    ['codex CLI', makeSession({ agent_sdk: 'codex-cli' })],
    ['shell command', makeSession({ agent_sdk: 'terminal', session_type: 'shell-command' })]
  ])('destroys the PTY of a %s session and releases its terminal view', async (_label, session) => {
    dbApiMocks.session.get.mockResolvedValue(session)

    await dragBackAndConfirm(makeTicket())

    expect(dbApiMocks.session.update).toHaveBeenCalledWith(SESSION_ID, {
      status: 'completed',
      completed_at: expect.any(String)
    })
    expect(terminalApiMocks.destroy).toHaveBeenCalledWith(SESSION_ID)
    expect(useSessionStore.getState().closedTerminalSessionIds.has(SESSION_ID)).toBe(true)
    // The ticket is unlinked before the process is stopped
    expect(updateTicket.mock.invocationCallOrder[0]).toBeLessThan(
      terminalApiMocks.destroy.mock.invocationCallOrder[0]
    )
    expect(moveTicket).toHaveBeenCalledWith('ticket-1', 'proj-1', 'todo', expect.any(Number))
    expect(toast.success).toHaveBeenCalledWith('Session stopped and ticket moved to To Do')
  })

  it('closes the tab of a session still shown behind the board instead of leaving it to respawn', async () => {
    const otherTab = makeSession({ id: 'session-2' })
    useSessionStore.setState({
      sessionsByWorktree: new Map([['wt-1', [makeSession(), otherTab]]]),
      tabOrderByWorktree: new Map([['wt-1', [SESSION_ID, 'session-2']]]),
      activeSessionId: SESSION_ID
    })

    await dragBackAndConfirm(makeTicket())

    const state = useSessionStore.getState()
    expect(terminalApiMocks.destroy).toHaveBeenCalledWith(SESSION_ID)
    expect(state.sessionsByWorktree.get('wt-1')?.map((s) => s.id)).toEqual(['session-2'])
    expect(state.activeSessionId).toBe('session-2')
    expect(state.closedTerminalSessionIds.has(SESSION_ID)).toBe(true)
    expect(moveTicket).toHaveBeenCalled()
  })

  it('aborts an SDK session instead and destroys no PTY', async () => {
    dbApiMocks.session.get.mockResolvedValue(
      makeSession({ agent_sdk: 'claude-code', opencode_session_id: 'oc-1' })
    )

    await dragBackAndConfirm(makeTicket())

    expect(opencodeApiMocks.abort).toHaveBeenCalledWith('/repo/wt-1', 'oc-1')
    expect(terminalApiMocks.destroy).not.toHaveBeenCalled()
    expect(useSessionStore.getState().closedTerminalSessionIds.has(SESSION_ID)).toBe(false)
    expect(moveTicket).toHaveBeenCalled()
  })

  it('still moves the ticket when the PTY destroy fails', async () => {
    terminalApiMocks.destroy.mockRejectedValue(new Error('already gone'))

    await dragBackAndConfirm(makeTicket())

    expect(useSessionStore.getState().closedTerminalSessionIds.has(SESSION_ID)).toBe(true)
    expect(moveTicket).toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it.each([
    ['in progress', makeTicket({ id: 'ticket-2' })],
    ['in review', makeTicket({ id: 'ticket-2', column: 'review' })]
  ])('leaves a session another %s ticket still rides untouched', async (_label, otherTicket) => {
    getBySession.mockResolvedValue([makeTicket(), otherTicket])

    await dragBackAndConfirm(makeTicket())

    expect(getBySession).toHaveBeenCalledWith(SESSION_ID)
    expect(terminalApiMocks.destroy).not.toHaveBeenCalled()
    expect(dbApiMocks.session.update).not.toHaveBeenCalled()
    expect(useSessionStore.getState().closedTerminalSessionIds.has(SESSION_ID)).toBe(false)
    // Only the dragged ticket is unlinked and moved
    expect(updateTicket).toHaveBeenCalledWith('ticket-1', 'proj-1', {
      current_session_id: null,
      worktree_id: null,
      mode: null,
      plan_ready: false
    })
    expect(moveTicket).toHaveBeenCalledWith('ticket-1', 'proj-1', 'todo', expect.any(Number))
    expect(toast.success).toHaveBeenCalledWith(
      'Ticket moved to To Do — its session keeps running for another ticket'
    )
  })

  it('still stops a session whose other tickets are done, merged or archived', async () => {
    getBySession.mockResolvedValue([
      makeTicket(),
      makeTicket({ id: 'ticket-2', column: 'done' }),
      makeTicket({ id: 'ticket-3', column: 'merged' }),
      makeTicket({ id: 'ticket-4', archived_at: now })
    ])

    await dragBackAndConfirm(makeTicket())

    expect(terminalApiMocks.destroy).toHaveBeenCalledWith(SESSION_ID)
    expect(toast.success).toHaveBeenCalledWith('Session stopped and ticket moved to To Do')
  })

  it('leaves the session running when the link set cannot be read', async () => {
    getBySession.mockRejectedValue(new Error('rpc down'))

    await dragBackAndConfirm(makeTicket())

    expect(terminalApiMocks.destroy).not.toHaveBeenCalled()
    expect(dbApiMocks.session.update).not.toHaveBeenCalled()
    expect(moveTicket).toHaveBeenCalled()
    expect(toast.warning).toHaveBeenCalled()
  })
})

/**
 * Renaming a ticket from the board's context menu changes its title and nothing else:
 * an in-progress ticket keeps its session, worktree and branch, because the update
 * carries only the title. The dialog is board-level (RenameTicketDialog, driven by the
 * store) so it outlives its card when a board search filters the card out mid-save.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import type { KanbanTicket } from '../../../../main/db/types'

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

import { KanbanTicketCard } from './KanbanTicketCard'
import { RenameTicketDialog } from './RenameTicketModal'
import { toast } from '@/lib/toast'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useProjectStore } from '@/stores/useProjectStore'

const initialKanbanState = useKanbanStore.getState()
const initialProjectState = useProjectStore.getState()

const now = '2026-01-01T00:00:00.000Z'

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: 'project-1',
    title: 'Add dark mode toggle',
    description: null,
    attachments: [],
    column: 'todo',
    sort_order: 0,
    current_session_id: null,
    worktree_id: null,
    mode: null,
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

/** An in-progress ticket whose branch and session a rename must leave alone. */
const makeRunningTicket = (): KanbanTicket =>
  makeTicket({
    column: 'in_progress',
    current_session_id: 'session-1',
    worktree_id: 'worktree-1',
    mode: 'build'
  })

const card = (): HTMLElement => screen.getByTestId('kanban-ticket-ticket-1')

/** Puts the ticket in the store (the board-level dialog looks it up there). */
function seedStore(ticket: KanbanTicket): void {
  useKanbanStore.setState({ tickets: new Map([[ticket.project_id, [ticket]]]) })
}

/** The store-held title, as the optimistic update and its rollback would set it. */
function setStoreTitle(ticket: KanbanTicket, title: string): void {
  seedStore({ ...ticket, title })
}

/** Renders the card next to the board-level dialog host, as KanbanBoard does. */
function renderBoard(ticket: KanbanTicket): ReturnType<typeof render> {
  seedStore(ticket)
  return render(
    <>
      <KanbanTicketCard ticket={ticket} />
      <RenameTicketDialog />
    </>
  )
}

async function openRenameDialog(): Promise<HTMLInputElement> {
  fireEvent.contextMenu(card())
  fireEvent.click(await screen.findByTestId('ctx-rename-ticket'))
  return (await screen.findByTestId('rename-ticket-input')) as HTMLInputElement
}

function stubUpdateTicket(): ReturnType<typeof vi.fn> {
  const updateTicket = vi.fn().mockResolvedValue(undefined)
  useKanbanStore.setState({ updateTicket } as never)
  return updateTicket
}

// See ProjectItem.shell-commands.test.tsx: jsdom cannot answer floating-ui's top-layer probes
const TOP_LAYER_PROBES = new Set([':popover-open', ':modal'])
const originalMatches = Element.prototype.matches

beforeAll(() => {
  Element.prototype.matches = function (this: Element, selectors: string): boolean {
    return TOP_LAYER_PROBES.has(selectors) ? false : originalMatches.call(this, selectors)
  }
})

afterAll(() => {
  Element.prototype.matches = originalMatches
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useKanbanStore.setState(initialKanbanState, true)
  useProjectStore.setState(initialProjectState, true)
})

describe('renaming a ticket from the board', () => {
  it('offers Rename for a ticket with a running session', async () => {
    renderBoard(makeRunningTicket())

    const input = await openRenameDialog()

    expect(input.value).toBe('Add dark mode toggle')
  })

  it('updates only the title, leaving the session, worktree and branch alone', async () => {
    const updateTicket = stubUpdateTicket()
    renderBoard(makeRunningTicket())

    const input = await openRenameDialog()
    fireEvent.change(input, { target: { value: '  Dark mode: system follow  ' } })
    fireEvent.click(screen.getByTestId('rename-ticket-save'))

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Ticket renamed'))
    expect(updateTicket).toHaveBeenCalledTimes(1)
    // Strict: nothing but the trimmed title travels in the update
    expect(updateTicket).toHaveBeenCalledWith('ticket-1', 'project-1', {
      title: 'Dark mode: system follow'
    })
    await waitFor(() => expect(screen.queryByTestId('rename-ticket-modal')).toBeNull())
  })

  it('renames on Enter', async () => {
    const updateTicket = stubUpdateTicket()
    renderBoard(makeTicket())

    const input = await openRenameDialog()
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(updateTicket).toHaveBeenCalledTimes(1))
    expect(updateTicket).toHaveBeenCalledWith('ticket-1', 'project-1', { title: 'Renamed' })
  })

  it('ignores Enter that confirms an IME candidate', async () => {
    const updateTicket = stubUpdateTicket()
    renderBoard(makeTicket())

    const input = await openRenameDialog()
    fireEvent.change(input, { target: { value: 'ダークモード' } })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    // Older engines report Enter with keyCode 229 during composition
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })

    expect(updateTicket).not.toHaveBeenCalled()
    expect(screen.getByTestId('rename-ticket-modal')).toBeInTheDocument()

    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(updateTicket).toHaveBeenCalledTimes(1))
    expect(updateTicket).toHaveBeenCalledWith('ticket-1', 'project-1', { title: 'ダークモード' })
  })

  it('refuses an empty or unchanged name', async () => {
    const updateTicket = stubUpdateTicket()
    renderBoard(makeTicket())

    const input = await openRenameDialog()
    const save = screen.getByTestId('rename-ticket-save')
    // Unchanged
    expect(save).toBeDisabled()

    fireEvent.change(input, { target: { value: '   ' } })
    expect(save).toBeDisabled()
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(updateTicket).not.toHaveBeenCalled()
  })

  it('keeps the dialog and draft when the rename fails, even if search drops the card', async () => {
    // Mirror the real store: the title flips optimistically, then reverts on failure. A
    // board search filters cards by title, so the flip can unmount the card mid-save.
    const ticket = makeTicket()
    const updateTicket = vi.fn(async (_id: string, _project: string, data: { title: string }) => {
      setStoreTitle(ticket, data.title)
      rerender(<RenameTicketDialog />)
      await Promise.resolve()
      setStoreTitle(ticket, ticket.title)
      throw new Error('disk full')
    })
    const { rerender } = renderBoard(ticket)
    useKanbanStore.setState({ updateTicket } as never)

    const input = await openRenameDialog()
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByTestId('rename-ticket-save'))

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Failed to rename ticket: disk full')
    )
    expect(screen.queryByTestId('kanban-ticket-ticket-1')).toBeNull()
    expect(screen.getByTestId('rename-ticket-modal')).toBeInTheDocument()
    // The draft survives the revert so the rename can be retried as typed
    expect((screen.getByTestId('rename-ticket-input') as HTMLInputElement).value).toBe('Renamed')
    expect(screen.getByTestId('rename-ticket-save')).toBeEnabled()
  })

  it('re-seeds the draft from the current title each time it opens', async () => {
    const updateTicket = vi.fn().mockResolvedValue(undefined)
    useKanbanStore.setState({ updateTicket } as never)
    renderBoard(makeTicket())

    const input = await openRenameDialog()
    fireEvent.change(input, { target: { value: 'Abandoned draft' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('rename-ticket-modal')).toBeNull())

    const reopened = await openRenameDialog()
    expect(reopened.value).toBe('Add dark mode toggle')
  })
})

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { KanbanTicketCard } from './KanbanTicketCard'
import { useKanbanStore } from '@/stores/useKanbanStore'
import type { SidebarHoverTarget } from '@/stores/useKanbanStore'
import { useSessionStore } from '@/stores/useSessionStore'
import type { Session } from '@/stores/useSessionStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import type { KanbanTicket } from '../../../../main/db/types'

const now = '2026-01-01T00:00:00.000Z'

const baseTicket: KanbanTicket = {
  id: 'ticket-1',
  project_id: 'project-1',
  title: 'Fix the thing',
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
  mark: null,
  total_tokens: 0,
  pending_launch_config: null,
  goal_mode: false,
  goal_success_criteria: null,
  note: null,
  created_from_session: false,
  auto_approve_plan: false,
  unread: false,
  model_provider_id: null,
  model_id: null,
  model_variant: null,
  variant_group_id: null
}

const HIGHLIGHT_ATTR = 'data-sidebar-hover-highlight'
type StoreConnection = ReturnType<typeof useConnectionStore.getState>['connections'][number]

const hover = (target: SidebarHoverTarget | null): void => {
  act(() => useKanbanStore.getState().setHoveredSidebarTarget(target))
}

describe('KanbanTicketCard sidebar hover highlight', () => {
  afterEach(() => {
    cleanup()
    useKanbanStore.setState({ hoveredSidebarTarget: null })
    useSessionStore.setState({ sessionsByConnection: new Map() })
    useConnectionStore.setState({ connections: [] })
  })

  it('highlights the ticket while its project is hovered in the sidebar', () => {
    render(<KanbanTicketCard ticket={baseTicket} />)
    const card = screen.getByTestId('kanban-ticket-ticket-1')
    expect(card).not.toHaveAttribute(HIGHLIGHT_ATTR)

    hover({ kind: 'project', id: 'project-1' })
    expect(card).toHaveAttribute(HIGHLIGHT_ATTR)
    expect(card.className).toContain('!border-sky-400')
    expect(card.className).toContain('ring-2')

    hover({ kind: 'project', id: 'project-2' })
    expect(card).not.toHaveAttribute(HIGHLIGHT_ATTR)

    hover(null)
    expect(card).not.toHaveAttribute(HIGHLIGHT_ATTR)
  })

  it('highlights all of the project’s tickets while any of its worktrees is hovered', () => {
    // Ticket runs on wt-1, but hovering a *different* branch of the same
    // project still highlights it (worktree-agnostic highlight).
    render(<KanbanTicketCard ticket={{ ...baseTicket, worktree_id: 'wt-1' }} isPinnedMode />)
    const card = screen.getByTestId('kanban-ticket-ticket-1')

    hover({ kind: 'worktree', id: 'wt-2', projectId: 'project-1' })
    expect(card).toHaveAttribute(HIGHLIGHT_ATTR)

    hover({ kind: 'worktree', id: 'wt-2', projectId: 'project-2' })
    expect(card).not.toHaveAttribute(HIGHLIGHT_ATTR)
  })

  it('falls back to exact worktree matching when the project is unresolved', () => {
    render(<KanbanTicketCard ticket={{ ...baseTicket, worktree_id: 'wt-1' }} isPinnedMode />)
    const card = screen.getByTestId('kanban-ticket-ticket-1')

    hover({ kind: 'worktree', id: 'wt-1', projectId: null })
    expect(card).toHaveAttribute(HIGHLIGHT_ATTR)

    hover({ kind: 'worktree', id: 'wt-2', projectId: null })
    expect(card).not.toHaveAttribute(HIGHLIGHT_ATTR)
  })

  it('highlights a ticket whose session runs inside the hovered connection', () => {
    useSessionStore.setState({
      sessionsByConnection: new Map([
        ['conn-1', [{ id: 'sess-1', connection_id: 'conn-1' } as unknown as Session]]
      ])
    })
    render(<KanbanTicketCard ticket={{ ...baseTicket, current_session_id: 'sess-1' }} />)
    const card = screen.getByTestId('kanban-ticket-ticket-1')

    hover({ kind: 'connection', id: 'conn-1' })
    expect(card).toHaveAttribute(HIGHLIGHT_ATTR)

    hover({ kind: 'connection', id: 'conn-2' })
    expect(card).not.toHaveAttribute(HIGHLIGHT_ATTR)
  })

  it('highlights a ticket running on a member worktree of the hovered connection', () => {
    useConnectionStore.setState({
      connections: [
        {
          id: 'conn-1',
          members: [{ worktree_id: 'wt-1', project_id: 'project-1' }]
        } as unknown as StoreConnection
      ]
    })
    render(<KanbanTicketCard ticket={{ ...baseTicket, worktree_id: 'wt-1' }} />)
    const card = screen.getByTestId('kanban-ticket-ticket-1')

    hover({ kind: 'connection', id: 'conn-1' })
    expect(card).toHaveAttribute(HIGHLIGHT_ATTR)
  })

  it('does not highlight unrelated tickets', () => {
    render(<KanbanTicketCard ticket={{ ...baseTicket, worktree_id: 'wt-1' }} />)
    const card = screen.getByTestId('kanban-ticket-ticket-1')

    hover({ kind: 'connection', id: 'conn-1' })
    expect(card).not.toHaveAttribute(HIGHLIGHT_ATTR)
    hover({ kind: 'worktree', id: 'other', projectId: 'other-project' })
    expect(card).not.toHaveAttribute(HIGHLIGHT_ATTR)
  })
})

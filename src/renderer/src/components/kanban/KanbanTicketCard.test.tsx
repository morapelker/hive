import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { KanbanTicketCard } from './KanbanTicketCard'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { TooltipProvider } from '@/components/ui/tooltip'
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

describe('KanbanTicketCard model badge', () => {
  afterEach(() => {
    cleanup()
    useSettingsStore.setState({ showModelIcons: false })
  })

  it('renders the model badge for a multi-model duplicate, even with no other badges', () => {
    const ticket: KanbanTicket = {
      ...baseTicket,
      model_provider_id: 'anthropic',
      model_id: 'claude-opus-4-5-20251101',
      model_variant: null,
      variant_group_id: 'group-1'
    }

    render(<KanbanTicketCard ticket={ticket} />)

    expect(screen.getByText('claude-opus-4-5-20251101')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Claude' })).toBeInTheDocument()
  })

  it('does not render a model badge for a single-model launch (no variant_group_id)', () => {
    const ticket: KanbanTicket = {
      ...baseTicket,
      model_provider_id: 'anthropic',
      model_id: 'claude-opus-4-5-20251101',
      model_variant: null,
      variant_group_id: null
    }

    render(<KanbanTicketCard ticket={ticket} />)

    expect(screen.queryByText('claude-opus-4-5-20251101')).toBeNull()
    expect(screen.queryByRole('img', { name: 'Claude' })).toBeNull()
  })

  it('renders the model badge for a single-model launch when showModelIcons is on', () => {
    useSettingsStore.setState({ showModelIcons: true })
    const ticket: KanbanTicket = {
      ...baseTicket,
      model_provider_id: 'anthropic',
      model_id: 'claude-opus-4-5-20251101',
      model_variant: null,
      variant_group_id: null
    }

    render(<KanbanTicketCard ticket={ticket} />)

    expect(screen.getByText('claude-opus-4-5-20251101')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Claude' })).toBeInTheDocument()
  })

  it('does not render a model badge when showModelIcons is on but the ticket has no model_id', () => {
    useSettingsStore.setState({ showModelIcons: true })
    render(<KanbanTicketCard ticket={baseTicket} />)

    expect(screen.queryByRole('img', { name: 'Claude' })).toBeNull()
    expect(screen.queryByRole('img', { name: 'OpenAI' })).toBeNull()
  })

  it('does not render a model badge when the ticket has no model_id', () => {
    render(<KanbanTicketCard ticket={baseTicket} />)

    expect(screen.queryByRole('img', { name: 'Claude' })).toBeNull()
    expect(screen.queryByRole('img', { name: 'OpenAI' })).toBeNull()
  })
})

describe('KanbanTicketCard transition age', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders the time since the last column transition', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    render(<KanbanTicketCard ticket={{ ...baseTicket, column_changed_at: twoHoursAgo }} />)

    expect(screen.getByTestId('ticket-transition-age')).toHaveTextContent('2h')
  })

  it('falls back to updated_at for tickets without a transition date', () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    render(
      <KanbanTicketCard
        ticket={{ ...baseTicket, column_changed_at: null, updated_at: fiveMinutesAgo }}
      />
    )

    expect(screen.getByTestId('ticket-transition-age')).toHaveTextContent('5m')
  })
})

describe('KanbanTicketCard unread indicator', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders the unread dot for an unread review ticket', () => {
    render(<KanbanTicketCard ticket={{ ...baseTicket, column: 'review', unread: true }} />)

    expect(screen.getByTestId('ticket-unread-dot')).toBeInTheDocument()
  })

  it('renders no dot for a read ticket', () => {
    render(<KanbanTicketCard ticket={{ ...baseTicket, column: 'review', unread: false }} />)

    expect(screen.queryByTestId('ticket-unread-dot')).toBeNull()
  })
})

describe('KanbanTicketCard background work badges', () => {
  afterEach(() => {
    cleanup()
    useWorktreeStatusStore.setState({ backgroundWorkBySession: {} })
  })

  const linkedTicket: KanbanTicket = { ...baseTicket, current_session_id: 'session-1' }

  it('renders shell, monitor, and subagent count badges for the linked session', () => {
    useWorktreeStatusStore.setState({
      backgroundWorkBySession: {
        'session-1': { runningShells: 2, runningMonitors: 1, runningSubagents: 3 }
      }
    })

    render(
      <TooltipProvider>
        <KanbanTicketCard ticket={linkedTicket} />
      </TooltipProvider>
    )

    expect(screen.getByTestId('kanban-ticket-running-shells')).toHaveTextContent('2')
    expect(screen.getByTestId('kanban-ticket-running-monitors')).toHaveTextContent('1')
    expect(screen.getByTestId('kanban-ticket-running-subagents')).toHaveTextContent('3')
  })

  it('renders only the badge whose count is non-zero', () => {
    useWorktreeStatusStore.setState({
      backgroundWorkBySession: {
        'session-1': { runningShells: 1, runningMonitors: 0, runningSubagents: 0 }
      }
    })

    render(
      <TooltipProvider>
        <KanbanTicketCard ticket={linkedTicket} />
      </TooltipProvider>
    )

    expect(screen.getByTestId('kanban-ticket-running-shells')).toHaveTextContent('1')
    expect(screen.queryByTestId('kanban-ticket-running-monitors')).toBeNull()
    expect(screen.queryByTestId('kanban-ticket-running-subagents')).toBeNull()
  })

  it('renders the subagent badge alone while a workflow runs its agents', () => {
    useWorktreeStatusStore.setState({
      backgroundWorkBySession: {
        'session-1': { runningShells: 0, runningMonitors: 0, runningSubagents: 2 }
      }
    })

    render(
      <TooltipProvider>
        <KanbanTicketCard ticket={linkedTicket} />
      </TooltipProvider>
    )

    expect(screen.getByTestId('kanban-ticket-running-subagents')).toHaveTextContent('2')
    expect(screen.queryByTestId('kanban-ticket-running-shells')).toBeNull()
    expect(screen.queryByTestId('kanban-ticket-running-monitors')).toBeNull()
  })

  it('renders no badges without counts or for other sessions', () => {
    useWorktreeStatusStore.setState({
      backgroundWorkBySession: {
        'other-session': { runningShells: 3, runningMonitors: 3, runningSubagents: 3 }
      }
    })

    render(
      <TooltipProvider>
        <KanbanTicketCard ticket={linkedTicket} />
      </TooltipProvider>
    )

    expect(screen.queryByTestId('kanban-ticket-running-shells')).toBeNull()
    expect(screen.queryByTestId('kanban-ticket-running-monitors')).toBeNull()
    expect(screen.queryByTestId('kanban-ticket-running-subagents')).toBeNull()
  })
})

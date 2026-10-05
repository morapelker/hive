import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { KanbanTicketCard } from './KanbanTicketCard'
import { useShellCommandRunStore } from '@/stores/useShellCommandRunStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import type { SessionShellCommand } from '@shared/lib/shell-commands'
import type { KanbanTicket } from '../../../../main/db/types'

const initialRunState = useShellCommandRunStore.getState()
const initialWorktreeStatusState = useWorktreeStatusStore.getState()

const now = '2026-01-01T00:00:00.000Z'

const failedRun: SessionShellCommand = {
  commandId: 'cmd-1',
  name: 'Build',
  script: 'make',
  detached: false,
  state: 'failed',
  runId: 'run-1',
  exitCode: 3,
  signal: null,
  reason: null,
  error: null,
  startedAt: now,
  finishedAt: now
}

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: 'project-1',
    title: 'Build',
    description: null,
    attachments: [],
    column: 'review',
    sort_order: 0,
    current_session_id: 'session-1',
    worktree_id: 'worktree-1',
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
    ...overrides
  }
}

describe('KanbanTicketCard shell-command tickets', () => {
  afterEach(() => {
    cleanup()
    useShellCommandRunStore.setState(initialRunState, true)
    useWorktreeStatusStore.setState(initialWorktreeStatusState, true)
  })

  it('shows the Error badge without a Continue button for a failed shell command', () => {
    useShellCommandRunStore.setState({ runsBySession: { 'session-1': failedRun } })
    useWorktreeStatusStore.setState({
      sessionApiErrors: { 'session-1': 'Command failed (exit 3)' }
    })

    render(<KanbanTicketCard ticket={makeTicket()} />)

    const badge = screen.getByTestId('kanban-ticket-error-badge')
    expect(badge.getAttribute('title')).toBe('Session error: Command failed (exit 3)')
    expect(screen.queryByTestId('kanban-ticket-continue')).not.toBeInTheDocument()
  })

  it('still shows Continue for an agent ticket with a session error', () => {
    // Another session's run must not hide this ticket's Continue button
    useShellCommandRunStore.setState({ runsBySession: { 'another-session': failedRun } })
    useWorktreeStatusStore.setState({
      sessionApiErrors: { 'session-1': 'overloaded_error' }
    })

    render(<KanbanTicketCard ticket={makeTicket()} />)

    expect(screen.getByTestId('kanban-ticket-error-badge')).toBeInTheDocument()
    expect(screen.getByTestId('kanban-ticket-continue')).toBeInTheDocument()
  })

  it('shows neither for a shell-command ticket without an error', () => {
    useShellCommandRunStore.setState({
      runsBySession: { 'session-1': { ...failedRun, state: 'succeeded', exitCode: 0 } }
    })

    render(<KanbanTicketCard ticket={makeTicket()} />)

    expect(screen.queryByTestId('kanban-ticket-error-badge')).not.toBeInTheDocument()
    expect(screen.queryByTestId('kanban-ticket-continue')).not.toBeInTheDocument()
  })
})

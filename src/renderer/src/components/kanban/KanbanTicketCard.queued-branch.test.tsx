import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { KanbanTicketCard } from './KanbanTicketCard'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import type { KanbanTicket } from '../../../../main/db/types'

const initialWorktreeState = useWorktreeStore.getState()

const now = '2026-01-01T00:00:00.000Z'

const existingWorktree = {
  id: 'worktree-1',
  project_id: 'project-1',
  name: 'atlanta',
  branch_name: 'feature/login-flow',
  path: '/tmp/worktree-1',
  status: 'active' as const,
  is_default: false,
  branch_renamed: 1,
  last_message_at: null,
  session_titles: '[]',
  last_model_provider_id: null,
  last_model_id: null,
  last_model_variant: null,
  attachments: '[]',
  created_at: now,
  last_accessed_at: now,
  github_pr_number: null,
  github_pr_url: null
}

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: 'project-1',
    title: 'Queued ticket',
    description: null,
    attachments: [],
    column: 'in_progress',
    sort_order: 0,
    current_session_id: null,
    worktree_id: null,
    mode: 'build',
    plan_ready: false,
    created_at: now,
    updated_at: now,
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
    model_provider_id: null,
    model_id: null,
    model_variant: null,
    variant_group_id: null,
    ...overrides
  }
}

function makePendingConfig(
  worktree:
    | { type: 'new'; sourceBranch: string }
    | { type: 'existing'; worktreeId: string }
): string {
  return JSON.stringify({
    worktree,
    prompt: 'do the thing',
    mode: 'build',
    model: null,
    sdk: 'claude-code',
    codexFastMode: false,
    goalMode: false,
    goalSuccessCriteria: null
  })
}

describe('KanbanTicketCard queued branch badge', () => {
  afterEach(() => {
    cleanup()
    useWorktreeStore.setState(initialWorktreeState, true)
  })

  it('shows the target branch name when queued on an existing worktree', () => {
    useWorktreeStore.setState({
      worktreesByProject: new Map([['project-1', [existingWorktree]]])
    })

    render(
      <KanbanTicketCard
        ticket={makeTicket({
          pending_launch_config: makePendingConfig({ type: 'existing', worktreeId: 'worktree-1' })
        })}
      />
    )

    expect(screen.getByTestId('ticket-queued-branch')).toHaveTextContent('feature/login-flow')
  })

  it('shows (new-worktree) when queued to launch on a new worktree', () => {
    render(
      <KanbanTicketCard
        ticket={makeTicket({
          pending_launch_config: makePendingConfig({ type: 'new', sourceBranch: 'main' })
        })}
      />
    )

    expect(screen.getByTestId('ticket-queued-branch')).toHaveTextContent('(new-worktree)')
  })

  it('renders no badge when the ticket has no pending launch config', () => {
    render(<KanbanTicketCard ticket={makeTicket()} />)

    expect(screen.queryByTestId('ticket-queued-branch')).not.toBeInTheDocument()
  })

  it('renders no badge when the pending config is malformed JSON', () => {
    render(
      <KanbanTicketCard ticket={makeTicket({ pending_launch_config: 'not-json{' })} />
    )

    expect(screen.queryByTestId('ticket-queued-branch')).not.toBeInTheDocument()
  })

  it('renders no badge when the queued worktree no longer exists in the store', () => {
    useWorktreeStore.setState({
      worktreesByProject: new Map([['project-1', [existingWorktree]]])
    })

    render(
      <KanbanTicketCard
        ticket={makeTicket({
          pending_launch_config: makePendingConfig({ type: 'existing', worktreeId: 'gone' })
        })}
      />
    )

    expect(screen.queryByTestId('ticket-queued-branch')).not.toBeInTheDocument()
  })
})

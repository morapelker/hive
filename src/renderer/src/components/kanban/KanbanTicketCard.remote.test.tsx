import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KanbanTicketCard } from './KanbanTicketCard'
import { useRemoteLaunchStore } from '@/stores/useRemoteLaunchStore'
import type { RemoteLaunchClientInfo } from '@shared/types/remote-launch'
import type { KanbanTicket } from '../../../../main/db/types'

// Testing the ContextMenu-gated "Open remote terminal"/"Stop remote session"
// actions is skipped here: there is no existing precedent in this codebase
// for driving Radix's right-click ContextMenu through Testing Library (grep
// for `fireEvent.contextMenu` turns up nothing wired to a real Radix
// ContextMenu), and KanbanTicketCard has no prior test file establishing a
// harness for its ~15 zustand-store dependencies. The equivalent
// confirm-then-`remoteLaunchApi.stop` flow is covered cheaply on
// KanbanTicketModal instead, where the action is a plain visible button.
// This file therefore only covers the purely-additive "Remote" badge, per
// the brief's proportionality rule.

const initialRemoteLaunchState = useRemoteLaunchStore.getState()

const now = '2026-01-01T00:00:00.000Z'

const remoteInfo: RemoteLaunchClientInfo = {
  role: 'client',
  url: 'https://remote.example.com',
  remoteSessionId: 'remote-session-1',
  remoteWorktreeId: 'remote-worktree-1',
  remoteProjectId: 'remote-project-1',
  tmuxSession: 'hive-launch-1',
  branch: 'feature/x',
  worktreePath: '/remote/worktree',
  launchedAt: now
}

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: 'project-1',
    title: 'Remote ticket',
    description: null,
    attachments: [],
    column: 'in_progress',
    sort_order: 0,
    current_session_id: 'session-1',
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

describe('KanbanTicketCard remote badge', () => {
  afterEach(() => {
    cleanup()
    useRemoteLaunchStore.setState(initialRemoteLaunchState, true)
  })

  it('renders the Remote badge when the store holds client-role info for the session and worktree_id is null', () => {
    useRemoteLaunchStore.setState({
      remoteBySessionId: { 'session-1': remoteInfo },
      ensureLoaded: vi.fn(async () => undefined)
    })

    render(<KanbanTicketCard ticket={makeTicket()} />)

    expect(screen.getByTestId('ticket-remote-badge')).toBeInTheDocument()
  })

  it('does not render the badge for a ticket with an assigned worktree, even if the session has client info', () => {
    useRemoteLaunchStore.setState({
      remoteBySessionId: { 'session-1': remoteInfo },
      ensureLoaded: vi.fn(async () => undefined)
    })

    render(<KanbanTicketCard ticket={makeTicket({ worktree_id: 'worktree-1' })} />)

    expect(screen.queryByTestId('ticket-remote-badge')).not.toBeInTheDocument()
  })

  it('does not render the badge when the store has no client info for the session', () => {
    useRemoteLaunchStore.setState({
      remoteBySessionId: {},
      ensureLoaded: vi.fn(async () => undefined)
    })

    render(<KanbanTicketCard ticket={makeTicket()} />)

    expect(screen.queryByTestId('ticket-remote-badge')).not.toBeInTheDocument()
  })

  it('does not render the badge for a plain ticket with no current session', () => {
    render(<KanbanTicketCard ticket={makeTicket({ current_session_id: null })} />)

    expect(screen.queryByTestId('ticket-remote-badge')).not.toBeInTheDocument()
  })
})

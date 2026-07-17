import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { KanbanTicketCard } from './KanbanTicketCard'
import { useSettingsStore } from '@/stores/useSettingsStore'
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

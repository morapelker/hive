import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanTicketCard } from './KanbanTicketCard'
import { useProjectStore } from '@/stores/useProjectStore'
import { usePinnedStore } from '@/stores/usePinnedStore'
import { projectApi } from '@/api/project-api'
import type { Project } from '@shared/types/project'
import type { KanbanTicket } from '../../../../main/db/types'

const now = '2026-01-01T00:00:00.000Z'
const ICON_DATA_URL = 'data:image/png;base64,AAAA'

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

const makeProject = (overrides: Partial<Project>): Project => ({
  id: 'project-1',
  name: 'Alpha',
  path: '/tmp/alpha',
  description: null,
  tags: null,
  language: 'typescript',
  custom_icon: null,
  detected_icon: null,
  setup_script: null,
  run_script: null,
  archive_script: null,
  worktree_create_script: null,
  custom_commands: null,
  auto_assign_port: false,
  sort_order: 0,
  created_at: now,
  last_accessed_at: now,
  ...overrides
})

describe('KanbanTicketCard pinned board project icon', () => {
  beforeEach(() => {
    vi.spyOn(projectApi, 'getProjectIconPath').mockImplementation(async (filename) =>
      filename === 'alpha-icon.png' ? ICON_DATA_URL : null
    )
    usePinnedStore.setState({ pinnedProjectIds: new Set(['project-1', 'project-2']) })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    useProjectStore.setState({ projects: [] })
    usePinnedStore.setState({ pinnedProjectIds: new Set() })
  })

  it('shows the customized project icon instead of the color dot on the pinned board', async () => {
    useProjectStore.setState({
      projects: [makeProject({ custom_icon: 'alpha-icon.png' })]
    })

    render(<KanbanTicketCard ticket={baseTicket} isPinnedMode />)

    const icon = await screen.findByTestId('kanban-ticket-project-icon')
    expect(icon).toHaveAttribute('src', ICON_DATA_URL)
    expect(screen.getByText('Alpha')).toBeInTheDocument()
  })

  it('keeps the color dot when the project icon was not customized', async () => {
    useProjectStore.setState({
      projects: [makeProject({ custom_icon: null, detected_icon: '/tmp/alpha/favicon.ico' })]
    })

    render(<KanbanTicketCard ticket={baseTicket} isPinnedMode />)

    expect(screen.getByText('Alpha')).toBeInTheDocument()
    await waitFor(() => expect(projectApi.getProjectIconPath).not.toHaveBeenCalled())
    expect(screen.queryByTestId('kanban-ticket-project-icon')).toBeNull()
  })

  it('keeps the color dot on connection boards even when the project icon is customized', async () => {
    useProjectStore.setState({
      projects: [makeProject({ custom_icon: 'alpha-icon.png' })]
    })

    render(<KanbanTicketCard ticket={baseTicket} connectionId="connection-1" />)

    expect(screen.getByText('Alpha')).toBeInTheDocument()
    await waitFor(() => expect(projectApi.getProjectIconPath).not.toHaveBeenCalled())
    expect(screen.queryByTestId('kanban-ticket-project-icon')).toBeNull()
  })
})

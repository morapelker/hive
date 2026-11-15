import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
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
  awaiting_completion: false,
  model_provider_id: null,
  model_id: null,
  model_variant: null,
  variant_group_id: null,
  ticket_prefix: null,
  ticket_number: null,
  parent_ticket_id: null,
  parent_ticket_key: null
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

const CONNECTION_PROJECT_ID = 'connection-project-1'
const CONNECTION_PROJECT_NAME = 'web-stack'
const TAG = 'kanban-ticket-connection-project-tag'
const STACK = 'kanban-ticket-project-icon-stack'

const connectionTicket: KanbanTicket = {
  ...baseTicket,
  id: 'ticket-connection',
  project_id: CONNECTION_PROJECT_ID
}
const pinnedConnectionCard = <KanbanTicketCard ticket={connectionTicket} isPinnedMode />

/** A git project row with no icon at all unless the overrides give it one. */
const makeMember = (id: string, overrides: Partial<Project> = {}): Project =>
  makeProject({ id, name: id, path: `/tmp/${id}`, language: null, ...overrides })

/** Store the member rows plus the connection project that connects them. */
const seedConnectionProject = (members: Project[], overrides: Partial<Project> = {}): void => {
  useProjectStore.setState({
    projects: [
      ...members,
      makeProject({
        id: CONNECTION_PROJECT_ID,
        name: CONNECTION_PROJECT_NAME,
        path: '',
        kind: 'connection',
        member_project_ids: JSON.stringify(members.map((member) => member.id)),
        language: null,
        ...overrides
      })
    ]
  })
}

// The mocked icon lookups answer with promises: let the ones made on mount land.
const renderSettled = async (ui: React.ReactElement): Promise<void> => {
  render(ui)
  await act(async () => {})
}

/** A project pill's children in DOM order: 'dot' (inline background color), 'stack', or text. */
const pillParts = (pill: HTMLElement): string[] =>
  Array.from(pill.childNodes).map((node) => {
    if (!(node instanceof HTMLElement)) return node.textContent ?? ''
    if (node.dataset.testid === STACK) return 'stack'
    return node.style.backgroundColor ? 'dot' : node.tagName
  })

describe('KanbanTicketCard pinned board connection project tag', () => {
  beforeEach(() => {
    // LanguageIcon caches resolved files at module level, so every test uses its own names.
    vi.spyOn(projectApi, 'getProjectIconPath').mockImplementation(
      async (filename) => `data:custom/${filename}`
    )
    vi.spyOn(projectApi, 'getAbsoluteIconDataUrl').mockImplementation(
      async (iconPath) => `data:detected${iconPath}`
    )
    vi.spyOn(projectApi, 'loadLanguageIcons').mockResolvedValue({})
    usePinnedStore.setState({ pinnedProjectIds: new Set([CONNECTION_PROJECT_ID, 'project-1']) })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    useProjectStore.setState({ projects: [] })
    usePinnedStore.setState({ pinnedProjectIds: new Set() })
  })

  it('shows the color dot, then the member icon strip, then the project name', async () => {
    seedConnectionProject([
      makeMember('api', { custom_icon: 'layout-api.png' }),
      makeMember('web', { detected_icon: '/layout-web/favicon.ico' }),
      makeMember('cli', { language: 'go' })
    ])

    await renderSettled(pinnedConnectionCard)

    expect(pillParts(screen.getByTestId(TAG))).toEqual(['dot', 'stack', CONNECTION_PROJECT_NAME])
    expect(screen.getByTestId(STACK)).toHaveAttribute('data-layout', 'strip')
    expect(screen.queryByTestId('kanban-ticket-project-icon')).toBeNull()
  })

  it('caps the strip at three tiles when five members have unique icons', async () => {
    seedConnectionProject(
      ['typescript', 'python', 'go', 'rust', 'swift'].map((language) =>
        makeMember(language, { language })
      )
    )

    await renderSettled(pinnedConnectionCard)

    expect(screen.getByTestId(STACK).querySelectorAll('[data-tile]')).toHaveLength(3)
  })

  it('keeps the dot and the name, with no strip, when no member has an icon', async () => {
    seedConnectionProject([makeMember('api'), makeMember('web', { language: 'cobol' })])

    await renderSettled(pinnedConnectionCard)

    expect(pillParts(screen.getByTestId(TAG))).toEqual(['dot', CONNECTION_PROJECT_NAME])
    expect(screen.queryByTestId(STACK)).toBeNull()
  })

  it('keeps the dot and the name, with no strip, when its members are missing from the store', async () => {
    seedConnectionProject([], { member_project_ids: JSON.stringify(['ghost-1', 'ghost-2']) })

    await renderSettled(pinnedConnectionCard)

    expect(pillParts(screen.getByTestId(TAG))).toEqual(['dot', CONNECTION_PROJECT_NAME])
    expect(screen.queryByTestId(STACK)).toBeNull()
    // No members to name, so the pill is not a tooltip trigger either
    expect(screen.getByTestId(TAG)).not.toHaveAttribute('data-state')
  })

  it('shows the connection project own custom icon as the single image, with no strip', async () => {
    seedConnectionProject(
      [makeMember('api', { language: 'typescript' }), makeMember('web', { language: 'go' })],
      { custom_icon: 'own-icon.png' }
    )

    render(pinnedConnectionCard)

    expect(await screen.findByTestId('kanban-ticket-project-icon')).toHaveAttribute(
      'src',
      'data:custom/own-icon.png'
    )
    expect(screen.queryByTestId(STACK)).toBeNull()
    expect(screen.queryByTestId(TAG)).toBeNull()
  })

  it('keeps the member strip when the connection project own icon file does not resolve', async () => {
    vi.mocked(projectApi.getProjectIconPath).mockResolvedValue(null)
    seedConnectionProject(
      [makeMember('api', { language: 'typescript' }), makeMember('web', { language: 'go' })],
      { custom_icon: 'missing-own-icon.png' }
    )

    await renderSettled(pinnedConnectionCard)

    expect(projectApi.getProjectIconPath).toHaveBeenCalledWith('missing-own-icon.png')
    expect(pillParts(screen.getByTestId(TAG))).toEqual(['dot', 'stack', CONNECTION_PROJECT_NAME])
    expect(screen.queryByTestId('kanban-ticket-project-icon')).toBeNull()
  })

  it('keeps the plain dot + name tag on a connection board', async () => {
    seedConnectionProject([
      makeMember('api', { custom_icon: 'board-api.png' }),
      makeMember('web', { language: 'go' })
    ])

    await renderSettled(<KanbanTicketCard ticket={connectionTicket} connectionId="connection-1" />)

    expect(pillParts(screen.getByText(CONNECTION_PROJECT_NAME))).toEqual([
      'dot',
      CONNECTION_PROJECT_NAME
    ])
    expect(screen.queryByTestId(STACK)).toBeNull()
    expect(screen.queryByTestId(TAG)).toBeNull()
  })

  it('leaves a git project tag unchanged on the pinned board even when its favicon is set', async () => {
    useProjectStore.setState({
      projects: [makeProject({ detected_icon: '/git-alpha/favicon.ico' })]
    })

    await renderSettled(<KanbanTicketCard ticket={baseTicket} isPinnedMode />)

    expect(pillParts(screen.getByText('Alpha'))).toEqual(['dot', 'Alpha'])
    expect(screen.queryByTestId(STACK)).toBeNull()
    expect(screen.queryByTestId(TAG)).toBeNull()
  })

  it('makes the connection project pill, but not a git project pill, a tooltip trigger', async () => {
    // Alpha is both a member of the connection project and a pinned project with its own ticket
    seedConnectionProject([makeProject({}), makeMember('web', { language: 'go' })])

    await renderSettled(
      <>
        {pinnedConnectionCard}
        <KanbanTicketCard ticket={baseTicket} isPinnedMode />
      </>
    )

    // Radix marks a tooltip trigger with data-state
    expect(screen.getByTestId(TAG)).toHaveAttribute('data-state', 'closed')
    expect(screen.getByText('Alpha')).not.toHaveAttribute('data-state')
  })

  it('shows the strip once a member is given an icon in the store', async () => {
    seedConnectionProject([makeMember('api'), makeMember('web')])
    await renderSettled(pinnedConnectionCard)
    expect(screen.queryByTestId(STACK)).toBeNull()

    await act(async () =>
      seedConnectionProject([makeMember('api', { language: 'go' }), makeMember('web')])
    )

    expect(pillParts(screen.getByTestId(TAG))).toEqual(['dot', 'stack', CONNECTION_PROJECT_NAME])
  })
})

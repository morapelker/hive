import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KanbanTicketCard } from './KanbanTicketCard'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useSessionStore } from '@/stores/useSessionStore'
import type { Session } from '@/stores/useSessionStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { setRendererRpcClient, resetRendererRpcClientForTests } from '@/api/rpc-client'
import type { KanbanTicket } from '../../../../main/db/types'

const now = '2026-01-01T00:00:00.000Z'

type StoreConnection = ReturnType<typeof useConnectionStore.getState>['connections'][number]
type StoreProject = ReturnType<typeof useProjectStore.getState>['projects'][number]
type StoreWorktree = NonNullable<
  ReturnType<ReturnType<typeof useWorktreeStore.getState>['worktreesByProject']['get']>
>[number]

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: 'proj-a',
    title: 'Connection ticket',
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

function makeProject(overrides: Partial<StoreProject>): StoreProject {
  return {
    id: 'proj-a',
    name: 'A',
    path: '/a',
    kind: 'git',
    ...overrides
  } as StoreProject
}

function makeWorktree(overrides: Partial<StoreWorktree>): StoreWorktree {
  return {
    id: 'wt',
    project_id: 'proj-a',
    name: 'main',
    branch_name: 'main',
    path: '/a',
    status: 'active',
    is_default: true,
    branch_renamed: 0,
    last_message_at: null,
    session_titles: '[]',
    last_model_provider_id: null,
    last_model_id: null,
    last_model_variant: null,
    attachments: '[]',
    created_at: now,
    last_accessed_at: now,
    github_pr_number: null,
    github_pr_url: null,
    ...overrides
  } as StoreWorktree
}

function makeConnection(overrides: Partial<StoreConnection>): StoreConnection {
  return {
    id: 'conn-1',
    name: 'A + B',
    custom_name: null,
    status: 'active',
    path: '/connections/conn-1',
    color: null,
    created_at: now,
    updated_at: now,
    members: [
      {
        id: 'm-a',
        connection_id: 'conn-1',
        worktree_id: 'wt-a-feature',
        project_id: 'proj-a',
        symlink_name: 'a',
        added_at: now,
        worktree_name: 'feature',
        worktree_branch: 'feature',
        worktree_path: '/a/feature',
        project_name: 'A'
      },
      {
        id: 'm-b',
        connection_id: 'conn-1',
        worktree_id: 'wt-b-feature',
        project_id: 'proj-b',
        symlink_name: 'b',
        added_at: now,
        worktree_name: 'feature',
        worktree_branch: 'feature',
        worktree_path: '/b/feature',
        project_name: 'B'
      }
    ],
    ...overrides
  }
}

const cmdClick = (el: HTMLElement, shift = false): void => {
  fireEvent.click(el, { metaKey: true, shiftKey: shift })
}

const renderCard = (ticket: KanbanTicket, connectionId?: string): void => {
  render(
    <TooltipProvider>
      <KanbanTicketCard ticket={ticket} connectionId={connectionId} />
    </TooltipProvider>
  )
}

describe('KanbanTicketCard cmd+click on connection tickets', () => {
  beforeEach(() => {
    useProjectStore.setState({
      projects: [
        makeProject({ id: 'proj-a', name: 'A', path: '/a' }),
        makeProject({ id: 'proj-b', name: 'B', path: '/b' }),
        makeProject({
          id: 'conn-proj',
          name: 'A + B',
          path: '/connections/conn-proj',
          kind: 'connection',
          member_project_ids: JSON.stringify(['proj-a', 'proj-b'])
        } as Partial<StoreProject>)
      ],
      selectedProjectId: null
    })
    useWorktreeStore.setState({
      selectedWorktreeId: null,
      worktreesByProject: new Map([
        [
          'proj-a',
          [
            makeWorktree({
              id: 'wt-a-feature',
              name: 'feature',
              branch_name: 'feature',
              path: '/a/feature',
              is_default: false
            }),
            makeWorktree({ id: 'wt-a-main', project_id: 'proj-a' })
          ]
        ],
        ['proj-b', [makeWorktree({ id: 'wt-b-main', project_id: 'proj-b', path: '/b' })]],
        ['conn-proj', []]
      ])
    })
    useConnectionStore.setState({
      loaded: true,
      connections: [makeConnection({})],
      selectedConnectionId: null,
      connectionGitView: 'connection'
    })
    useSessionStore.setState({ sessionsByConnection: new Map() })
    useKanbanStore.setState({ selectedTicketRef: null })
  })

  afterEach(() => {
    cleanup()
    resetRendererRpcClientForTests()
  })

  it('cmd+click on a connection board ticket selects the connection, not a member worktree', () => {
    renderCard(makeTicket(), 'conn-1')
    cmdClick(screen.getByTestId('kanban-ticket-ticket-1'))

    expect(useConnectionStore.getState().selectedConnectionId).toBe('conn-1')
    expect(useConnectionStore.getState().connectionGitView).toBe('connection')
    expect(useWorktreeStore.getState().selectedWorktreeId).toBeNull()
    expect(useKanbanStore.getState().selectedTicketRef).toBeNull()
  })

  it('cmd+shift+click selects the same connection with the git side on the base branches', () => {
    renderCard(makeTicket(), 'conn-1')
    cmdClick(screen.getByTestId('kanban-ticket-ticket-1'), true)

    expect(useConnectionStore.getState().selectedConnectionId).toBe('conn-1')
    expect(useConnectionStore.getState().connectionGitView).toBe('base')
    expect(useWorktreeStore.getState().selectedWorktreeId).toBeNull()
  })

  it('re-selecting the connection from the sidebar returns to its own branches', () => {
    renderCard(makeTicket(), 'conn-1')
    cmdClick(screen.getByTestId('kanban-ticket-ticket-1'), true)
    expect(useConnectionStore.getState().connectionGitView).toBe('base')

    // What ConnectionItem.handleClick does
    useConnectionStore.getState().selectConnection('conn-1')
    expect(useConnectionStore.getState().selectedConnectionId).toBe('conn-1')
    expect(useConnectionStore.getState().connectionGitView).toBe('connection')
  })

  it('a ticket attached to a live worktree stays a worktree ticket on a connection board', () => {
    renderCard(makeTicket({ worktree_id: 'wt-a-feature' }), 'conn-1')
    cmdClick(screen.getByTestId('kanban-ticket-ticket-1'))

    expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-a-feature')
    expect(useConnectionStore.getState().selectedConnectionId).toBeNull()
  })

  it('cmd+click on a connection project ticket selects the instance its session runs on', () => {
    useConnectionStore.setState({
      connections: [
        makeConnection({ id: 'inst-1', saved_project_id: 'conn-proj' }),
        makeConnection({ id: 'base-1', saved_project_id: 'conn-proj', is_base: 1 })
      ]
    })
    useSessionStore.setState({
      sessionsByConnection: new Map([['inst-1', [{ id: 'sess-1' } as Session]]])
    })
    renderCard(makeTicket({ project_id: 'conn-proj', current_session_id: 'sess-1' }))
    cmdClick(screen.getByTestId('kanban-ticket-ticket-1'))

    expect(useConnectionStore.getState().selectedConnectionId).toBe('inst-1')
    expect(useConnectionStore.getState().connectionGitView).toBe('connection')
  })

  it('cmd+shift+click on a connection project ticket keeps its instance and shows base branches', () => {
    useConnectionStore.setState({
      connections: [
        makeConnection({ id: 'inst-1', saved_project_id: 'conn-proj' }),
        makeConnection({ id: 'base-1', saved_project_id: 'conn-proj', is_base: 1 })
      ]
    })
    useSessionStore.setState({
      sessionsByConnection: new Map([['inst-1', [{ id: 'sess-1' } as Session]]])
    })
    renderCard(makeTicket({ project_id: 'conn-proj', current_session_id: 'sess-1' }))
    cmdClick(screen.getByTestId('kanban-ticket-ticket-1'), true)

    expect(useConnectionStore.getState().selectedConnectionId).toBe('inst-1')
    expect(useConnectionStore.getState().connectionGitView).toBe('base')
  })

  it('resolves the instance from the session record when its sessions are not loaded', async () => {
    useConnectionStore.setState({
      connections: [
        makeConnection({ id: 'inst-1', saved_project_id: 'conn-proj' }),
        makeConnection({ id: 'base-1', saved_project_id: 'conn-proj', is_base: 1 })
      ]
    })
    setRendererRpcClient({
      request: async <T,>(method: string, params?: unknown): Promise<T> => {
        if (method === 'db.session.get' && (params as { id: string }).id === 'sess-1') {
          return { id: 'sess-1', worktree_id: null, connection_id: 'inst-1' } as T
        }
        return undefined as T
      },
      subscribe: () => () => {}
    })
    renderCard(makeTicket({ project_id: 'conn-proj', current_session_id: 'sess-1' }))
    cmdClick(screen.getByTestId('kanban-ticket-ticket-1'), true)

    await waitFor(() => expect(useConnectionStore.getState().selectedConnectionId).toBe('inst-1'))
    expect(useConnectionStore.getState().connectionGitView).toBe('base')
  })

  it('falls back to the base instance for a connection project ticket with no live connection', async () => {
    useConnectionStore.setState({
      connections: [makeConnection({ id: 'base-1', saved_project_id: 'conn-proj', is_base: 1 })]
    })
    renderCard(makeTicket({ project_id: 'conn-proj' }))
    cmdClick(screen.getByTestId('kanban-ticket-ticket-1'), true)

    await waitFor(() => expect(useConnectionStore.getState().selectedConnectionId).toBe('base-1'))
    // The base instance already is every member's base branch
    expect(useConnectionStore.getState().connectionGitView).toBe('connection')
    expect(useKanbanStore.getState().selectedTicketRef).toBeNull()
  })

  it('keeps the worktree behavior for plain project tickets', async () => {
    renderCard(makeTicket({ worktree_id: 'wt-a-feature' }))
    cmdClick(screen.getByTestId('kanban-ticket-ticket-1'), true)

    await waitFor(() => expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-a-main'))
    expect(useConnectionStore.getState().selectedConnectionId).toBeNull()
  })
})

/**
 * Cmd+click on the ticket of a document run (an orchestrator) selects the run's integration
 * checkout in the sidebar — its integration worktree on a git project, its integration
 * instance on a connection project — and cmd+shift+click the base branch, as on any ticket.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanTicketCard } from './KanbanTicketCard'
import { TooltipProvider } from '@/components/ui/tooltip'
import { makeDetail } from '@/components/document-flow/test-fixtures'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import type { DocumentRunDetail } from '@shared/types/document-flow'
import type { KanbanTicket } from '../../../../main/db/types'

const api = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('@/api/document-flow-api', () => ({ documentFlowApi: api }))

const initialFlowState = useDocumentFlowStore.getState()

const now = '2026-01-01T00:00:00.000Z'

type StoreConnection = ReturnType<typeof useConnectionStore.getState>['connections'][number]
type StoreProject = ReturnType<typeof useProjectStore.getState>['projects'][number]
type StoreWorktree = NonNullable<
  ReturnType<ReturnType<typeof useWorktreeStore.getState>['worktreesByProject']['get']>
>[number]

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-run',
    project_id: 'proj-a',
    title: 'Checkout redesign',
    description: null,
    attachments: [],
    column: 'review',
    sort_order: 0,
    current_session_id: null,
    worktree_id: null,
    mode: null,
    plan_ready: false,
    created_at: now,
    updated_at: now,
    column_changed_at: null,
    archived_at: null,
    external_provider: 'document-run',
    external_id: 'run-1',
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
    id: 'inst-1',
    name: 'A + B',
    custom_name: null,
    status: 'active',
    path: '/connections/inst-1',
    color: null,
    created_at: now,
    updated_at: now,
    members: [],
    ...overrides
  } as StoreConnection
}

/** A finished run on git project A, integrated on the `wt-a-integration` worktree. */
const gitRun = (): DocumentRunDetail =>
  makeDetail({
    id: 'run-1',
    project_id: 'proj-a',
    status: 'completed',
    base_branch: 'main',
    integration_branch: 'doc-checkout-redesign',
    integration_worktree_id: 'wt-a-integration',
    integration_worktree_path: '/a/doc-checkout-redesign'
  })

/** A finished run on connection project A + B, integrated on the `inst-run` instance. */
const connectionRun = (): DocumentRunDetail =>
  makeDetail({
    id: 'run-1',
    project_id: 'conn-proj',
    status: 'completed',
    integration_branch: 'doc-checkout-redesign',
    integration_connection_id: 'inst-run',
    integration_connection_path: '/connections/inst-run'
  })

function seedRuns(...details: DocumentRunDetail[]): void {
  useDocumentFlowStore.setState({
    runsById: Object.fromEntries(details.map((detail) => [detail.run.id, detail]))
  })
}

const cmdClick = (shift = false): void => {
  fireEvent.click(screen.getByTestId('kanban-ticket-ticket-run'), {
    metaKey: true,
    shiftKey: shift
  })
}

const renderCard = (ticket: KanbanTicket): void => {
  render(
    <TooltipProvider>
      <KanbanTicketCard ticket={ticket} />
    </TooltipProvider>
  )
}

describe('KanbanTicketCard cmd+click on the ticket of a document run', () => {
  beforeEach(() => {
    api.get.mockImplementation(
      async (runId: string) => useDocumentFlowStore.getState().runsById[runId] ?? null
    )
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
              id: 'wt-a-integration',
              name: 'doc-checkout-redesign',
              branch_name: 'doc-checkout-redesign',
              path: '/a/doc-checkout-redesign',
              is_default: false
            }),
            makeWorktree({ id: 'wt-a-main' })
          ]
        ],
        ['proj-b', [makeWorktree({ id: 'wt-b-main', project_id: 'proj-b', path: '/b' })]],
        ['conn-proj', []]
      ])
    })
    useConnectionStore.setState({
      loaded: true,
      connections: [
        makeConnection({ id: 'inst-run', saved_project_id: 'conn-proj' }),
        makeConnection({ id: 'base-1', saved_project_id: 'conn-proj', is_base: 1 })
      ],
      selectedConnectionId: null,
      connectionGitView: 'connection'
    })
    useSessionStore.setState({ sessionsByConnection: new Map() })
    useKanbanStore.setState({ selectedTicketRef: null })
  })

  afterEach(async () => {
    await act(async () => {})
    cleanup()
    vi.resetAllMocks()
    useDocumentFlowStore.setState(initialFlowState, true)
  })

  describe('on a git project', () => {
    it('cmd+click selects the integration worktree the ticket row names', () => {
      seedRuns(gitRun())
      renderCard(makeTicket({ worktree_id: 'wt-a-integration' }))
      cmdClick()

      expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-a-integration')
      expect(useProjectStore.getState().selectedProjectId).toBe('proj-a')
      // The run dashboard and the ticket modal stay closed
      expect(useDocumentFlowStore.getState().dashboardRunId).toBeNull()
      expect(useKanbanStore.getState().selectedTicketRef).toBeNull()
    })

    it("cmd+click selects the run's integration worktree even when the ticket row lost it", () => {
      seedRuns(gitRun())
      renderCard(makeTicket({ worktree_id: null }))
      cmdClick()

      expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-a-integration')
      expect(useDocumentFlowStore.getState().dashboardRunId).toBeNull()
    })

    it("cmd+shift+click selects the project's default worktree instead", () => {
      seedRuns(gitRun())
      renderCard(makeTicket({ worktree_id: 'wt-a-integration' }))
      cmdClick(true)

      expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-a-main')
    })

    it('falls back to the default worktree once the integration worktree was archived', async () => {
      seedRuns(gitRun())
      useWorktreeStore.setState({
        worktreesByProject: new Map([['proj-a', [makeWorktree({ id: 'wt-a-main' })]]])
      })
      renderCard(makeTicket({ worktree_id: 'wt-a-integration' }))
      cmdClick()

      await waitFor(() => expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-a-main'))
    })

    it('fetches a run the flow store has not loaded before deciding', async () => {
      const detail = gitRun()
      api.get.mockResolvedValue(detail)
      renderCard(makeTicket({ worktree_id: null }))
      // The card's own fetch of the run must not have landed yet for this to mean anything;
      // clicking right after mount races it, so clear the store first.
      useDocumentFlowStore.setState({ runsById: {} })
      cmdClick()

      await waitFor(() =>
        expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-a-integration')
      )
      expect(useDocumentFlowStore.getState().dashboardRunId).toBeNull()
    })
  })

  describe('on a connection project', () => {
    it("cmd+click selects the run's integration instance, not the base instance", () => {
      seedRuns(connectionRun())
      renderCard(makeTicket({ project_id: 'conn-proj' }))
      cmdClick()

      expect(useConnectionStore.getState().selectedConnectionId).toBe('inst-run')
      expect(useConnectionStore.getState().connectionGitView).toBe('connection')
      expect(useWorktreeStore.getState().selectedWorktreeId).toBeNull()
      expect(useDocumentFlowStore.getState().dashboardRunId).toBeNull()
      expect(useKanbanStore.getState().selectedTicketRef).toBeNull()
    })

    it('cmd+shift+click keeps the integration instance with the git side on the base branches', () => {
      seedRuns(connectionRun())
      renderCard(makeTicket({ project_id: 'conn-proj' }))
      cmdClick(true)

      expect(useConnectionStore.getState().selectedConnectionId).toBe('inst-run')
      expect(useConnectionStore.getState().connectionGitView).toBe('base')
    })

    it('falls back to the base instance once the integration instance was archived', async () => {
      seedRuns(connectionRun())
      useConnectionStore.setState({
        connections: [makeConnection({ id: 'base-1', saved_project_id: 'conn-proj', is_base: 1 })]
      })
      renderCard(makeTicket({ project_id: 'conn-proj' }))
      cmdClick()

      await waitFor(() =>
        expect(useConnectionStore.getState().selectedConnectionId).toBe('base-1')
      )
      expect(useConnectionStore.getState().connectionGitView).toBe('connection')
    })
  })
})

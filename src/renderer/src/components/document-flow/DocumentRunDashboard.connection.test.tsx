import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from '@/lib/toast'
import { useConnectionStore, type Connection } from '@/stores/useConnectionStore'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import type {
  DocumentRun,
  DocumentRunDetail,
  DocumentRunItem,
  DocumentRunMember,
  DocumentRunReportMember
} from '@shared/types/document-flow'
import { DocumentRunDashboard } from './DocumentRunDashboard'
import { makeDetail, makeReport } from './test-fixtures'

// The dashboard of a run on a CONNECTION project: an integration instance over one worktree
// per member, tickets on instances of their own. The git-run dashboard has its own tests.

const api = vi.hoisted(() => ({
  get: vi.fn(),
  sourceFile: vi.fn(),
  updateRun: vi.fn(),
  updateItem: vi.fn(),
  cancel: vi.fn(),
  finalize: vi.fn(),
  delete: vi.fn(),
  addMember: vi.fn()
}))
const gitApi = vi.hoisted(() => ({ listBranchesWithStatus: vi.fn() }))
const migrations = vi.hoisted(() => ({
  migrationsRefusal: vi.fn(),
  startRunMigrations: vi.fn(),
  stopRunMigrations: vi.fn()
}))

vi.mock('@/api/document-flow-api', () => ({ documentFlowApi: api }))
vi.mock('@/api/project-api', () => ({ projectApi: { openPath: vi.fn() } }))
vi.mock('@/api/git-api', () => ({ gitApi }))
// The gate itself has its own tests (lib/document-flow/migrations); here what it is asked.
vi.mock('@/lib/document-flow/migrations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/document-flow/migrations')>()),
  ...migrations
}))
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

const initialFlowState = useDocumentFlowStore.getState()
const initialProjectState = useProjectStore.getState()
const initialWorktreeState = useWorktreeStore.getState()
const initialSessionState = useSessionStore.getState()
const initialConnectionState = useConnectionStore.getState()

const CONNECTION_PROJECT = {
  id: 'project-conn',
  name: 'Shop stack',
  path: '/connections/shop-stack',
  kind: 'connection',
  member_project_ids: '["web","api"]'
} as const

const MEMBERS: DocumentRunMember[] = [
  {
    project_id: 'web',
    project_name: 'Web',
    project_path: '/repo/web',
    symlink_name: 'web',
    base_branch: 'main',
    base_sha: 'aaaaaaa1111111',
    integration_branch: 'doc-checkout',
    integration_worktree_id: 'wt-web-int',
    integration_worktree_path: '/worktrees/web--doc-checkout'
  },
  {
    project_id: 'api',
    project_name: 'API',
    project_path: '/repo/api',
    symlink_name: 'api',
    base_branch: 'master',
    base_sha: 'bbbbbbb2222222',
    integration_branch: 'doc-checkout',
    integration_worktree_id: 'wt-api-int',
    integration_worktree_path: '/worktrees/api--doc-checkout'
  }
]

const LAUNCHED: Partial<DocumentRun> = {
  project_id: CONNECTION_PROJECT.id,
  status: 'running',
  base_branch: 'main + master',
  base_sha: null,
  integration_branch: 'doc-checkout',
  integration_worktree_id: null,
  integration_worktree_path: null,
  integration_connection_id: 'conn-int',
  integration_connection_path: '/connections/doc-checkout',
  members: MEMBERS,
  started_at: '2026-05-04T10:05:00.000Z'
}

const REPORT_MEMBERS: DocumentRunReportMember[] = [
  {
    project_id: 'web',
    project_name: 'Web',
    symlink_name: 'web',
    integrationBranch: 'doc-checkout',
    integrationWorktreePath: '/worktrees/web--doc-checkout',
    baseBranch: 'main',
    baseSha: 'aaaaaaa1111111',
    headSha: 'ccccccc3333333',
    baseMoved: true,
    stats: { filesChanged: 8, insertions: 300, deletions: 20, commits: 6 }
  },
  {
    project_id: 'api',
    project_name: 'API',
    symlink_name: 'api',
    integrationBranch: 'doc-checkout',
    integrationWorktreePath: '/worktrees/api--doc-checkout',
    baseBranch: 'master',
    baseSha: 'bbbbbbb2222222',
    headSha: 'ddddddd4444444',
    baseMoved: false,
    stats: { filesChanged: 4, insertions: 40, deletions: 5, commits: 3 }
  }
]

const connectionReport = (): ReturnType<typeof makeReport> =>
  makeReport({
    integrationBranch: 'doc-checkout',
    integrationWorktreePath: '/connections/doc-checkout',
    baseBranch: 'main + master',
    baseSha: '',
    headSha: 'ccccccc3333333',
    baseMoved: true,
    migrations: ['web/db/migrations/0004_discounts.sql'],
    verify: { command: 'web: pnpm check; api: make test', ok: true, output: '' },
    members: REPORT_MEMBERS
  })

/** A ticket launched on an instance of its own, with a worktree in every member. */
const launchedItem = (
  key: string,
  overrides: Partial<DocumentRunItem> = {}
): Partial<DocumentRunItem> => ({
  key,
  status: 'running',
  session_id: `session-${key}`,
  connection_id: `conn-${key}`,
  branch_name: `${key.toLowerCase()}-task`,
  members: [
    {
      project_id: 'web',
      worktree_id: `wt-web-${key}`,
      branch_name: `${key.toLowerCase()}-task`,
      pre_merge_sha: null,
      merge_sha: null
    },
    {
      project_id: 'api',
      worktree_id: `wt-api-${key}`,
      branch_name: `${key.toLowerCase()}-task-api`,
      pre_merge_sha: null,
      merge_sha: null
    }
  ],
  ...overrides
})

function makeConnection(overrides: Partial<Connection>): Connection {
  return {
    id: 'conn',
    name: 'connection',
    custom_name: null,
    status: 'active',
    path: '/connections/conn',
    color: null,
    saved_project_id: CONNECTION_PROJECT.id,
    is_base: 0,
    created_at: '2026-05-04T10:00:00.000Z',
    updated_at: '2026-05-04T10:00:00.000Z',
    members: [],
    ...overrides
  } as Connection
}

/** The connection store has its list, with the run's integration instance in `status`. */
function connectionsLoaded(status: Connection['status'] | 'gone' = 'active'): void {
  useConnectionStore.setState({
    loaded: true,
    connections:
      status === 'gone'
        ? [makeConnection({ id: 'conn-other' })]
        : [makeConnection({ id: 'conn-int', status }), makeConnection({ id: 'conn-other' })]
  })
}

const storedDetail = (runId: string): DocumentRunDetail =>
  useDocumentFlowStore.getState().runsById[runId]

async function renderDashboard(detail: DocumentRunDetail): Promise<void> {
  useDocumentFlowStore.setState({
    runsById: { [detail.run.id]: detail },
    dashboardRunId: detail.run.id
  })
  await act(async () => {
    render(<DocumentRunDashboard />)
  })
}

const click = async (testId: string): Promise<void> => {
  await act(async () => {
    fireEvent.click(screen.getByTestId(testId))
  })
}

/** The git projects of the app: the two members, and one the connection project missed. */
const GIT_PROJECTS = [
  { id: 'web', name: 'Web', path: '/repo/web', kind: 'git' },
  { id: 'api', name: 'API', path: '/repo/api', kind: 'git' },
  { id: 'mobile', name: 'Mobile', path: '/repo/mobile', kind: 'git' }
] as const

const MOBILE_MEMBER: DocumentRunMember = {
  project_id: 'mobile',
  project_name: 'Mobile',
  project_path: '/repo/mobile',
  symlink_name: 'mobile',
  base_branch: 'develop',
  base_sha: 'ccccccc3333333',
  integration_branch: 'doc-checkout',
  integration_worktree_id: 'wt-mobile-int',
  integration_worktree_path: '/worktrees/mobile--doc-checkout'
}

beforeEach(() => {
  api.get.mockImplementation(async (runId: string) => storedDetail(runId) ?? null)
  gitApi.listBranchesWithStatus.mockResolvedValue({
    success: true,
    branches: [
      { name: 'main', isRemote: false, isCheckedOut: true, worktreePath: '/repo/mobile' },
      { name: 'develop', isRemote: false, isCheckedOut: false }
    ]
  })
  api.sourceFile.mockImplementation(async (runId: string) => ({
    path: storedDetail(runId).run.source_path,
    exists: true
  }))
  migrations.migrationsRefusal.mockReturnValue(null)
  useProjectStore.setState({ projects: [CONNECTION_PROJECT] } as never)
})

afterEach(async () => {
  await act(async () => {})
  cleanup()
  vi.resetAllMocks()
  useDocumentFlowStore.setState(initialFlowState, true)
  useProjectStore.setState(initialProjectState, true)
  useWorktreeStore.setState(initialWorktreeState, true)
  useSessionStore.setState(initialSessionState, true)
  useConnectionStore.setState(initialConnectionState, true)
})

describe('DocumentRunDashboard — add a repository to the run', () => {
  const change = async (testId: string, value: string): Promise<void> => {
    await act(async () => {
      fireEvent.change(screen.getByTestId(testId), { target: { value } })
    })
  }

  it('offers "Add repository" on a run at work, listing the git projects that are not members', async () => {
    useProjectStore.setState({ projects: [CONNECTION_PROJECT, ...GIT_PROJECTS] } as never)
    await renderDashboard(makeDetail(LAUNCHED, [launchedItem('A1')]))

    await click('docflow-add-member-btn')

    const dialog = screen.getByTestId('docflow-add-member-dialog')
    const options = within(dialog)
      .getAllByRole('option')
      .filter((option) => option.closest('select')?.id === 'docflow-add-member-project')
    expect(options.map((option) => option.textContent)).toEqual(['Mobile'])
    // The repository's branches, with its current branch as the default.
    expect(gitApi.listBranchesWithStatus).toHaveBeenCalledWith('/repo/mobile')
    const branch = screen.getByTestId('docflow-add-member-branch') as HTMLSelectElement
    expect([...branch.options].map((option) => option.textContent)).toEqual([
      'Current branch (main)',
      'develop',
      'main'
    ])
  })

  it('sends the pick to the server, shows the new member and reports it', async () => {
    useProjectStore.setState({ projects: [CONNECTION_PROJECT, ...GIT_PROJECTS] } as never)
    const detail = makeDetail(LAUNCHED, [launchedItem('A1')])
    api.addMember.mockResolvedValue({
      ...detail,
      run: {
        ...detail.run,
        base_branch: 'main + master + develop',
        members: [...MEMBERS, MOBILE_MEMBER]
      }
    })
    await renderDashboard(detail)

    await click('docflow-add-member-btn')
    await change('docflow-add-member-branch', 'develop')
    await click('docflow-add-member-submit')

    expect(api.addMember).toHaveBeenCalledWith({
      runId: detail.run.id,
      projectId: 'mobile',
      baseBranch: 'develop'
    })
    expect(toast.success).toHaveBeenCalledWith('Mobile joined the run on doc-checkout')
    expect(screen.queryByTestId('docflow-add-member-dialog')).toBeNull()
    expect(within(screen.getByTestId('docflow-member-lines')).getAllByRole('listitem')).toHaveLength(3)
    expect(screen.getByTestId('docflow-member-line-mobile')).toHaveTextContent(
      'Mobile · doc-checkout (from develop)'
    )
    expect(screen.getByTestId('docflow-base-branch-line')).toHaveTextContent(
      /^from main \+ master \+ develop$/
    )
  })

  it('sends no branch when the current one is kept, and keeps the dialog open on a refusal', async () => {
    useProjectStore.setState({ projects: [CONNECTION_PROJECT, ...GIT_PROJECTS] } as never)
    api.addMember.mockRejectedValue(new Error('Branch "main" was not found in Mobile.'))
    await renderDashboard(makeDetail(LAUNCHED, [launchedItem('A1')]))

    await click('docflow-add-member-btn')
    await click('docflow-add-member-submit')

    expect(api.addMember).toHaveBeenCalledWith({
      runId: 'run-1',
      projectId: 'mobile',
      baseBranch: null
    })
    expect(toast.error).toHaveBeenCalledWith(
      'Could not add Mobile: Branch "main" was not found in Mobile.'
    )
    expect(screen.getByTestId('docflow-add-member-dialog')).toBeInTheDocument()
    // Behind the open dialog, so hidden to assistive technology
    expect(
      within(screen.getByTestId('docflow-member-lines')).getAllByRole('listitem', { hidden: true })
    ).toHaveLength(2)
  })

  it('says so when every repository is a member already, and hides the button once the run ended', async () => {
    useProjectStore.setState({ projects: [CONNECTION_PROJECT, ...GIT_PROJECTS.slice(0, 2)] } as never)
    await renderDashboard(makeDetail(LAUNCHED, [launchedItem('A1')]))

    await click('docflow-add-member-btn')
    expect(screen.getByTestId('docflow-add-member-none')).toBeInTheDocument()
    expect(screen.getByTestId('docflow-add-member-submit')).toBeDisabled()
    await click('docflow-add-member-cancel')
    expect(screen.queryByTestId('docflow-add-member-dialog')).toBeNull()

    cleanup()
    await renderDashboard(
      makeDetail(
        { ...LAUNCHED, status: 'completed', report: connectionReport() },
        [launchedItem('A1', { status: 'merged' })]
      )
    )
    expect(screen.queryByTestId('docflow-add-member-btn')).toBeNull()
  })
})

describe('DocumentRunDashboard — connection run header', () => {
  it('shows the shared integration branch, the base label and one line per member', async () => {
    await renderDashboard(makeDetail(LAUNCHED, [launchedItem('A1')]))

    expect(screen.getByTestId('docflow-integration-branch')).toHaveTextContent('doc-checkout')
    // No single base commit for a connection run: the label alone.
    expect(screen.getByTestId('docflow-base-branch-line')).toHaveTextContent(
      /^from main \+ master$/
    )
    const lines = screen.getByTestId('docflow-member-lines')
    expect(within(lines).getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByTestId('docflow-member-line-web')).toHaveTextContent(
      'Web · doc-checkout (from main)'
    )
    expect(screen.getByTestId('docflow-member-line-api')).toHaveTextContent(
      'API · doc-checkout (from master)'
    )
  })

  it('offers "Open instance" in place of "Open worktree", selecting the integration instance', async () => {
    connectionsLoaded()
    await renderDashboard(makeDetail(LAUNCHED, [launchedItem('A1')]))

    expect(screen.queryByTestId('docflow-open-worktree')).toBeNull()
    expect(screen.getByTestId('docflow-open-instance')).toHaveTextContent('Open instance')
    await click('docflow-open-instance')

    expect(useConnectionStore.getState().selectedConnectionId).toBe('conn-int')
    expect(useSessionStore.getState().activeConnectionId).toBe('conn-int')
    expect(useProjectStore.getState().selectedProjectId).toBe(CONNECTION_PROJECT.id)
    expect(useDocumentFlowStore.getState().dashboardRunId).toBeNull()
  })

  it('opens the instance while the connections are not loaded yet', async () => {
    expect(useConnectionStore.getState().loaded).toBe(false)
    await renderDashboard(makeDetail(LAUNCHED, [launchedItem('A1')]))

    await click('docflow-open-instance')

    expect(useConnectionStore.getState().selectedConnectionId).toBe('conn-int')
    expect(toast.info).not.toHaveBeenCalled()
  })

  it.each(['archived', 'gone'] as const)(
    'stays open and says so when the integration instance is %s',
    async (state) => {
      connectionsLoaded(state)
      await renderDashboard(
        makeDetail({ ...LAUNCHED, status: 'completed', report: connectionReport() }, [
          launchedItem('A1', { status: 'merged' })
        ])
      )

      await click('docflow-open-instance')

      expect(toast.info).toHaveBeenCalledWith('The instance of doc-checkout was archived.')
      expect(useConnectionStore.getState().selectedConnectionId).toBeNull()
      expect(useDocumentFlowStore.getState().dashboardRunId).not.toBeNull()
      expect(screen.getByTestId('docflow-report')).toBeInTheDocument()
    }
  )

  it('shows no member lines for a git run', async () => {
    await renderDashboard(
      makeDetail(
        {
          status: 'running',
          integration_branch: 'doc-checkout',
          integration_worktree_id: 'wt-int',
          base_branch: 'main'
        },
        [{ key: 'A1' }]
      )
    )

    expect(screen.queryByTestId('docflow-member-lines')).toBeNull()
    expect(screen.queryByTestId('docflow-open-instance')).toBeNull()
    expect(screen.getByTestId('docflow-open-worktree')).toBeInTheDocument()
  })
})

describe('DocumentRunDashboard — connection run tickets', () => {
  it('names the branch in every member in the branch column tooltip', async () => {
    await renderDashboard(makeDetail(LAUNCHED, [launchedItem('A1'), { key: 'A2' }]))

    const branch = screen.getByTestId('docflow-row-branch-A1')
    expect(branch).toHaveTextContent('a1-task')
    expect(branch).toHaveAttribute('title', 'Web: a1-task\nAPI: a1-task-api')
    // Not launched yet: no branch, no tooltip
    expect(screen.getByTestId('docflow-row-branch-A2')).not.toHaveAttribute('title')
  })

  it("opens the ticket session on the ticket's instance", async () => {
    await renderDashboard(makeDetail(LAUNCHED, [launchedItem('A1')]))

    await click('docflow-row-open-A1')

    expect(useConnectionStore.getState().selectedConnectionId).toBe('conn-A1')
    expect(useSessionStore.getState().activeConnectionId).toBe('conn-A1')
    expect(useSessionStore.getState().activeSessionId).toBe('session-A1')
    expect(useSessionStore.getState().activeWorktreeId).toBeNull()
    expect(useDocumentFlowStore.getState().dashboardRunId).toBeNull()
  })

  it('opens the fix session on the integration instance while a failed verify is being fixed', async () => {
    await renderDashboard(
      makeDetail(LAUNCHED, [
        launchedItem('A1', {
          status: 'fixing',
          status_detail: 'Verify failed in API; a fix session is on it.',
          fix_session_id: 'session-fix'
        })
      ])
    )

    await click('docflow-row-open-A1')

    expect(useConnectionStore.getState().selectedConnectionId).toBe('conn-int')
    expect(useSessionStore.getState().activeConnectionId).toBe('conn-int')
    expect(useSessionStore.getState().activeSessionId).toBe('session-fix')
  })
})

describe('DocumentRunDashboard — connection run report and migrations', () => {
  const finished = (): DocumentRunDetail =>
    makeDetail({ ...LAUNCHED, status: 'completed', report: connectionReport() }, [
      launchedItem('A1', { status: 'merged' })
    ])

  it('renders a per-member table above the summed totals, without a single commit range', async () => {
    await renderDashboard(finished())

    const table = screen.getByTestId('docflow-report-members')
    expect(table).toHaveTextContent('Project')
    const web = within(table).getByTestId('docflow-report-member-web')
    expect(web).toHaveTextContent('Web')
    expect(web).toHaveTextContent('doc-checkout')
    expect(web).toHaveTextContent('main')
    expect(web).toHaveTextContent('8 files')
    expect(web).toHaveTextContent('+300')
    expect(web).toHaveTextContent('−20')
    expect(web).toHaveTextContent('yes')
    const apiRow = within(table).getByTestId('docflow-report-member-api')
    expect(apiRow).toHaveTextContent('master')
    expect(apiRow).toHaveTextContent('no')

    // The totals are what the server summed; the range is per member (in the table's tooltip)
    const stats = screen.getByTestId('docflow-report-stats')
    expect(stats).toHaveTextContent('9 commits · 12 files changed · +340 −25')
    expect(stats).not.toHaveTextContent('..')
    expect(screen.getByTestId('docflow-report-next')).toHaveTextContent(
      'merge doc-checkout into main + master in every member repository'
    )
  })

  it('names the members whose base branch moved', async () => {
    await renderDashboard(finished())

    expect(screen.getByTestId('docflow-report-base-moved')).toHaveTextContent(
      'main (Web) has new commits since this run started'
    )
  })

  it('shows the verify line as the server wrote it', async () => {
    await renderDashboard(finished())

    expect(screen.getByTestId('docflow-report-verify')).toHaveTextContent(
      'web: pnpm check; api: make testpassed'
    )
  })

  it('asks the migrations gate with the loaded active connections, none while unloaded', async () => {
    await renderDashboard(finished())

    expect(migrations.migrationsRefusal).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'run-1' }),
      undefined,
      undefined
    )

    act(() => {
      useConnectionStore.setState({
        loaded: true,
        connections: [
          makeConnection({ id: 'conn-int' }),
          makeConnection({ id: 'conn-archived', status: 'archived' })
        ]
      })
    })

    expect(migrations.migrationsRefusal).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'run-1' }),
      undefined,
      new Set(['conn-int'])
    )
  })

  it('does not ask the gate about connections for a git run', async () => {
    useConnectionStore.setState({ loaded: true, connections: [makeConnection({ id: 'conn-x' })] })
    await renderDashboard(
      makeDetail(
        {
          status: 'completed',
          integration_branch: 'doc-checkout',
          integration_worktree_id: 'wt-int',
          base_branch: 'main',
          report: makeReport({ migrations: ['db/0001.sql'] })
        },
        [{ key: 'A1', status: 'merged' }]
      )
    )

    expect(migrations.migrationsRefusal).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'run-1' }),
      undefined,
      undefined
    )
  })

  it('says the migrations session runs in the integration instance', async () => {
    await renderDashboard(finished())

    await click('docflow-execute-migrations-btn')

    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      "It runs in the integration instance of doc-checkout, the branches the run's tickets were merged into in every member repository."
    )
  })

  it('opens the migration session on the integration instance', async () => {
    await renderDashboard(
      makeDetail(
        {
          ...LAUNCHED,
          status: 'completed',
          report: connectionReport(),
          migration_session_id: 'session-mig',
          migration_started_at: '2026-05-04T11:00:00.000Z'
        },
        [launchedItem('A1', { status: 'merged' })]
      )
    )

    await click('docflow-open-migration-session')

    expect(useConnectionStore.getState().selectedConnectionId).toBe('conn-int')
    expect(useSessionStore.getState().activeConnectionId).toBe('conn-int')
    expect(useSessionStore.getState().activeSessionId).toBe('session-mig')
    expect(useDocumentFlowStore.getState().dashboardRunId).toBeNull()
  })
})

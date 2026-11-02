/**
 * Which branches of a document run the shift-drop of its ticket queues for the merge-on-done
 * dialog, and in what order: branches with work the integration branch lacks first (to merge
 * into it), the integration worktree next (to merge into base), every branch to archive last.
 * Anything that cannot be shown to be safe is kept and named.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeDetail } from '@/components/document-flow/test-fixtures'
import { useKanbanStore } from '@/stores/useKanbanStore'
import type {
  DocumentRun,
  DocumentRunDetail,
  DocumentRunItem,
  DocumentRunMember
} from '@shared/types/document-flow'
import type { KanbanTicket } from '../../../../main/db/types'
import { buildRunDoneQueue, queueDocumentRunDone } from './run-done-queue'

const dbApiMocks = vi.hoisted(() => ({
  worktree: { get: vi.fn(), getActiveByProject: vi.fn() }
}))
const gitApiMocks = vi.hoisted(() => ({
  hasUncommittedChanges: vi.fn(),
  branchDiffShortStat: vi.fn(),
  getFileStatuses: vi.fn(),
  syncBranchWithOrigin: vi.fn()
}))
const flowApi = vi.hoisted(() => ({ get: vi.fn() }))
const connectionMerge = vi.hoisted(() => ({ assessConnectionMembers: vi.fn() }))
const signal = vi.hoisted(() => ({ getSessionSignal: vi.fn() }))
const toastMocks = vi.hoisted(() => ({
  warning: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  loading: vi.fn(() => 'toast-1'),
  dismiss: vi.fn()
}))

vi.mock('@/api/db-api', () => ({ dbApi: dbApiMocks }))
vi.mock('@/api/git-api', () => ({ gitApi: gitApiMocks }))
vi.mock('@/api/document-flow-api', () => ({ documentFlowApi: flowApi }))
vi.mock('@/lib/connection-merge', () => connectionMerge)
vi.mock('@/lib/document-flow/session-signal', () => signal)
vi.mock('@/lib/toast', () => ({ toast: toastMocks }))

type Wt = {
  id: string
  project_id: string
  branch_name: string
  path: string
  status: 'active' | 'archived'
  is_default: boolean
  base_branch: string | null
}

const worktrees: Record<string, Wt> = {
  'wt-main': {
    id: 'wt-main',
    project_id: 'proj',
    branch_name: 'main',
    path: '/repo',
    status: 'active',
    is_default: true,
    base_branch: null
  },
  'wt-int': {
    id: 'wt-int',
    project_id: 'proj',
    branch_name: 'doc-run',
    path: '/wt/int',
    status: 'active',
    is_default: false,
    base_branch: 'main'
  },
  'wt-a': {
    id: 'wt-a',
    project_id: 'proj',
    branch_name: 'a1-alpha',
    path: '/wt/a',
    status: 'active',
    is_default: false,
    base_branch: 'main'
  },
  'wt-b': {
    id: 'wt-b',
    project_id: 'proj',
    branch_name: 'a2-beta',
    path: '/wt/b',
    status: 'active',
    is_default: false,
    base_branch: 'main'
  }
}

/** Commits each worktree path is ahead of a branch; everything else is 0. */
let ahead: Record<string, Record<string, number>> = {}

function ticket(id: string, column: KanbanTicket['column'], overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id,
    project_id: 'proj',
    title: `Ticket ${id}`,
    column,
    sort_order: 0,
    archived_at: null,
    parent_ticket_id: 'run-ticket',
    external_provider: null,
    external_id: null,
    ...overrides
  } as KanbanTicket
}

const tickets = (): KanbanTicket[] => [
  ticket('run-ticket', 'review', {
    parent_ticket_id: null,
    external_provider: 'document-run',
    external_id: 'run-1'
  }),
  ticket('t-a', 'merged'),
  ticket('t-b', 'review'),
  ticket('t-fix', 'review'),
  ticket('t-old', 'todo'),
  ticket('t-gone', 'review', { archived_at: '2026-01-01T00:00:00.000Z' })
]

function detail(
  items: Partial<DocumentRunItem>[] = [
    { key: 'A1', title: 'Alpha', status: 'merged', ticket_id: 't-a', worktree_id: 'wt-a', merge_sha: 'sha-a', session_id: 's-a' },
    { key: 'A2', title: 'Beta', status: 'needs_attention', ticket_id: 't-b', worktree_id: 'wt-b', session_id: 's-b' }
  ],
  run: Partial<DocumentRun> = {}
): DocumentRunDetail {
  return makeDetail(
    {
      id: 'run-1',
      project_id: 'proj',
      title: 'The run',
      status: 'completed',
      ticket_id: 'run-ticket',
      base_branch: 'main',
      integration_branch: 'doc-run',
      integration_worktree_id: 'wt-int',
      integration_worktree_path: '/wt/int',
      ...run
    },
    items
  )
}

const labels = (entries: { kind?: string; label?: string }[]): string[] =>
  entries.map((e) => `${e.kind}:${e.label}`)

beforeEach(() => {
  vi.clearAllMocks()
  ahead = {}
  dbApiMocks.worktree.get.mockImplementation(async (id: string) => worktrees[id] ?? null)
  dbApiMocks.worktree.getActiveByProject.mockImplementation(async () =>
    Object.values(worktrees).filter((w) => w.status === 'active')
  )
  gitApiMocks.hasUncommittedChanges.mockResolvedValue(false)
  gitApiMocks.branchDiffShortStat.mockImplementation(async (path: string, base: string) => ({
    success: true,
    filesChanged: 0,
    insertions: 0,
    deletions: 0,
    commitsAhead: ahead[path]?.[base] ?? 0
  }))
  gitApiMocks.getFileStatuses.mockResolvedValue({ success: true, files: [] })
  gitApiMocks.syncBranchWithOrigin.mockResolvedValue({ success: true, updated: false })
  signal.getSessionSignal.mockReturnValue({ kind: 'ended' })
  worktrees['wt-int'].status = 'active'
})

// ── A run on a connection project: two members, every ticket an instance of two worktrees ──
const connectionWorktrees: Record<string, Wt> = {
  'wt-main-web': { id: 'wt-main-web', project_id: 'proj-web', branch_name: 'main', path: '/web', status: 'active', is_default: true, base_branch: null },
  'wt-main-api': { id: 'wt-main-api', project_id: 'proj-api', branch_name: 'main', path: '/api', status: 'active', is_default: true, base_branch: null },
  'wt-int-web': { id: 'wt-int-web', project_id: 'proj-web', branch_name: 'doc-run', path: '/web/int', status: 'active', is_default: false, base_branch: 'main' },
  'wt-int-api': { id: 'wt-int-api', project_id: 'proj-api', branch_name: 'doc-run', path: '/api/int', status: 'active', is_default: false, base_branch: 'main' },
  'wt-a-web': { id: 'wt-a-web', project_id: 'proj-web', branch_name: 'a1-alpha', path: '/web/a1', status: 'active', is_default: false, base_branch: 'main' },
  'wt-a-api': { id: 'wt-a-api', project_id: 'proj-api', branch_name: 'a1-alpha', path: '/api/a1', status: 'active', is_default: false, base_branch: 'main' },
  'wt-b-web': { id: 'wt-b-web', project_id: 'proj-web', branch_name: 'a2-beta', path: '/web/a2', status: 'active', is_default: false, base_branch: 'main' },
  'wt-b-api': { id: 'wt-b-api', project_id: 'proj-api', branch_name: 'a2-beta', path: '/api/a2', status: 'active', is_default: false, base_branch: 'main' }
}

const runMembers: DocumentRunMember[] = [
  { project_id: 'proj-web', project_name: 'Web', project_path: '/web', symlink_name: 'web', base_branch: 'main', base_sha: 'w0', integration_branch: 'doc-run', integration_worktree_id: 'wt-int-web', integration_worktree_path: '/web/int' },
  { project_id: 'proj-api', project_name: 'Api', project_path: '/api', symlink_name: 'api', base_branch: 'main', base_sha: 'a0', integration_branch: 'doc-run', integration_worktree_id: 'wt-int-api', integration_worktree_path: '/api/int' }
]

const instance = (key: string, mergeSha: string | null): DocumentRunItem['members'] => [
  { project_id: 'proj-web', worktree_id: `wt-${key}-web`, branch_name: 'x', pre_merge_sha: null, merge_sha: mergeSha },
  { project_id: 'proj-api', worktree_id: `wt-${key}-api`, branch_name: 'x', pre_merge_sha: null, merge_sha: mergeSha }
]

function connectionDetail(
  items: Partial<DocumentRunItem>[] = [
    { key: 'A1', title: 'Alpha', status: 'merged', ticket_id: 't-a', connection_id: 'conn-a', members: instance('a', 'sha-a'), merge_sha: 'sha-a', session_id: 's-a' },
    { key: 'A2', title: 'Beta', status: 'needs_attention', ticket_id: 't-b', connection_id: 'conn-b', members: instance('b', null), session_id: 's-b' }
  ],
  run: Partial<DocumentRun> = {}
): DocumentRunDetail {
  return detail(items, {
    integration_worktree_id: null,
    integration_worktree_path: null,
    integration_branch: 'doc-run',
    integration_connection_id: 'conn-int',
    integration_connection_path: '/connections/doc-run',
    members: runMembers,
    ...run
  })
}

/** Point the db mock at the connection worktrees (the git-project ones stay reachable). */
function useConnectionWorktrees(): void {
  for (const wt of Object.values(connectionWorktrees)) wt.status = 'active'
  dbApiMocks.worktree.get.mockImplementation(
    async (id: string) => connectionWorktrees[id] ?? worktrees[id] ?? null
  )
  dbApiMocks.worktree.getActiveByProject.mockImplementation(async (projectId: string) =>
    Object.values(connectionWorktrees).filter((w) => w.project_id === projectId && w.status === 'active')
  )
  connectionMerge.assessConnectionMembers.mockResolvedValue({
    targets: [
      { worktreeId: 'wt-int-api', projectId: 'proj-api' },
      { worktreeId: 'wt-int-web', projectId: 'proj-web', alreadyMerged: true }
    ],
    skipped: [],
    found: true
  })
}

describe('buildRunDoneQueue — run on a connection project', () => {
  beforeEach(useConnectionWorktrees)

  it('makes one entry per ticket instance and one integration entry per member, work first', async () => {
    ahead = { '/api/a2': { 'doc-run': 2 } }

    const queue = await buildRunDoneQueue(connectionDetail(), 'run-ticket', tickets())

    expect(labels(queue.entries)).toEqual([
      'run-child:A2 · Beta',
      'run-integration:The run · Api',
      'run-integration:The run · Web',
      'run-child-archive:A1 · Alpha',
      'run-child-archive:A2 · Beta'
    ])
    // The ticket's instance is one entry anchored on its first member worktree
    expect(queue.entries[0]).toMatchObject({
      worktreeId: 'wt-b-web',
      projectId: 'proj-web',
      ticketId: 't-b',
      runId: 'run-1',
      itemId: 'item-A2',
      connectionId: 'conn-b',
      integrationBranch: 'doc-run',
      integrationWorktreeId: 'wt-int-web',
      members: [
        expect.objectContaining({ worktreeId: 'wt-b-web', projectId: 'proj-web', projectName: 'Web', worktreePath: '/web/a2', integrationWorktreeId: 'wt-int-web' }),
        expect.objectContaining({ worktreeId: 'wt-b-api', projectId: 'proj-api', projectName: 'Api', worktreePath: '/api/a2', integrationWorktreeId: 'wt-int-api' })
      ]
    })
    // Its archive twin shares the anchor, so skipping the merge drops both
    expect(queue.entries[4]).toMatchObject({ worktreeId: 'wt-b-web', kind: 'run-child-archive', alreadyMerged: true, ticketId: 't-b' })
    expect(queue.entries[1]).toMatchObject({ worktreeId: 'wt-int-api', projectId: 'proj-api', connectionId: 'conn-int' })
    expect(queue.entries[2]).toMatchObject({ worktreeId: 'wt-int-web', alreadyMerged: true })
    // Every member is measured against ITS integration branch
    expect(gitApiMocks.branchDiffShortStat).toHaveBeenCalledWith('/web/a1', 'doc-run')
    expect(gitApiMocks.branchDiffShortStat).toHaveBeenCalledWith('/api/a1', 'doc-run')
    expect(connectionMerge.assessConnectionMembers).toHaveBeenCalledWith('conn-int', { includeAlreadyMerged: true })
    expect(queue.kept).toEqual([{ label: 'Ticket t-old', reason: 'never started' }])
  })

  it('keeps the whole instance of a landed ticket with leftovers in one member; its ticket rides along', async () => {
    gitApiMocks.hasUncommittedChanges.mockImplementation(async (path: string) => path === '/api/a1')

    const queue = await buildRunDoneQueue(connectionDetail(), 'run-ticket', tickets())

    expect(labels(queue.entries)).toEqual([
      'run-integration:The run · Api',
      'run-integration:The run · Web',
      'run-child-archive:A2 · Beta'
    ])
    expect(queue.kept).toContainEqual({
      label: 'A1 · Alpha',
      reason: 'has uncommitted changes in Api since the run merged it — not archived'
    })
    expect(queue.alsoMoveTicketIds).toContain('t-a')
  })

  it('keeps a ticket with work in a member whose integration worktree is gone', async () => {
    connectionWorktrees['wt-int-api'].status = 'archived'
    ahead = { '/api/a2': { main: 1 } }

    const queue = await buildRunDoneQueue(connectionDetail(), 'run-ticket', tickets())

    // Without its integration worktree the member is measured against its base
    expect(gitApiMocks.branchDiffShortStat).toHaveBeenCalledWith('/api/a2', 'main')
    expect(gitApiMocks.branchDiffShortStat).toHaveBeenCalledWith('/web/a2', 'doc-run')
    expect(queue.kept).toContainEqual({
      label: 'A2 · Beta',
      reason: 'Api: the integration worktree is gone — merge it by hand'
    })
    expect(labels(queue.entries)).not.toContain('run-child:A2 · Beta')
  })

  it('a member worktree that is gone settles the ticket: along if it landed, kept otherwise', async () => {
    connectionWorktrees['wt-a-api'].status = 'archived'
    connectionWorktrees['wt-b-web'].status = 'archived'

    const queue = await buildRunDoneQueue(connectionDetail(), 'run-ticket', tickets())

    expect(labels(queue.entries)).toEqual(['run-integration:The run · Api', 'run-integration:The run · Web'])
    expect(queue.alsoMoveTicketIds).toContain('t-a')
    expect(queue.kept).toContainEqual({
      label: 'A2 · Beta',
      reason: 'its worktree in Web is gone and its work never landed'
    })
  })

  it('a member with no worktree on its base keeps the run entry and every ticket with work there', async () => {
    connectionMerge.assessConnectionMembers.mockResolvedValue({
      targets: [{ worktreeId: 'wt-int-web', projectId: 'proj-web', alreadyMerged: true }],
      skipped: [{ worktreeId: 'wt-int-api', projectId: 'proj-api', reason: 'no-base-worktree' }],
      found: true
    })
    ahead = { '/api/a2': { 'doc-run': 1 } }

    const queue = await buildRunDoneQueue(connectionDetail(), 'run-ticket', tickets())

    expect(queue.kept).toContainEqual({ label: 'The run · Api', reason: 'no worktree on main to merge into' })
    expect(queue.kept).toContainEqual({ label: 'A2 · Beta', reason: 'Api: no worktree on main to merge into' })
    expect(queue.kept).toContainEqual({ label: 'A1 · Alpha', reason: 'Api: no worktree on main to merge into' })
    expect(labels(queue.entries)).toEqual(['run-integration:The run · Web'])
  })

  it('without the integration instance, tickets are measured against their bases and nothing merges', async () => {
    connectionMerge.assessConnectionMembers.mockResolvedValue({ targets: [], skipped: [], found: false })

    const queue = await buildRunDoneQueue(connectionDetail(), 'run-ticket', tickets())

    expect(gitApiMocks.branchDiffShortStat).toHaveBeenCalledWith('/web/a1', 'main')
    expect(labels(queue.entries)).toEqual(['run-child-archive:A1 · Alpha', 'run-child-archive:A2 · Beta'])
    expect(dbApiMocks.worktree.get).not.toHaveBeenCalledWith('wt-int-web')
  })

  it('an integration member a ticket merge will land on is no longer "already merged"', async () => {
    // Web's integration branch is on base now, but A2 has commits for it
    ahead = { '/web/a2': { 'doc-run': 2 } }

    const queue = await buildRunDoneQueue(connectionDetail(), 'run-ticket', tickets())

    expect(labels(queue.entries)).toEqual([
      'run-child:A2 · Beta',
      'run-integration:The run · Api',
      'run-integration:The run · Web',
      'run-child-archive:A1 · Alpha',
      'run-child-archive:A2 · Beta'
    ])
    expect(queue.entries[2]).toMatchObject({ worktreeId: 'wt-int-web' })
    expect(queue.entries[2].alreadyMerged).toBeUndefined()
  })

  it('a landed ticket that cannot be verified in one member is kept with the member named', async () => {
    gitApiMocks.branchDiffShortStat.mockImplementation(async (path: string, base: string) =>
      path === '/api/a1'
        ? { success: false, error: 'boom' }
        : { success: true, filesChanged: 0, insertions: 0, deletions: 0, commitsAhead: ahead[path]?.[base] ?? 0 }
    )

    const queue = await buildRunDoneQueue(connectionDetail(), 'run-ticket', tickets())

    expect(queue.kept).toContainEqual({ label: 'A1 · Alpha', reason: 'could not be verified in Api: boom — not archived' })
    expect(queue.alsoMoveTicketIds).toContain('t-a')
    expect(labels(queue.entries).filter((l) => l.endsWith('A1 · Alpha'))).toEqual([])
  })

  it('a ticket that never landed and cannot be verified refuses the drop', async () => {
    gitApiMocks.branchDiffShortStat.mockImplementation(async (path: string) =>
      path === '/api/a2'
        ? { success: false, error: 'boom' }
        : { success: true, filesChanged: 0, insertions: 0, deletions: 0, commitsAhead: 0 }
    )

    await expect(buildRunDoneQueue(connectionDetail(), 'run-ticket', tickets())).rejects.toThrow('a2-beta: boom')
  })

  it('conflict markers in one member keep the whole instance', async () => {
    gitApiMocks.getFileStatuses.mockImplementation(async (path: string) => ({
      success: true,
      files: path === '/web/a2' ? [{ path: 'x.ts', status: 'C' }] : []
    }))

    const queue = await buildRunDoneQueue(connectionDetail(), 'run-ticket', tickets())

    expect(queue.kept).toContainEqual({ label: 'A2 · Beta', reason: 'has unresolved conflict markers in Web' })
    expect(labels(queue.entries).filter((l) => l.endsWith('A2 · Beta'))).toEqual([])
  })

  it('a landed ticket whose instance is only partly gone is kept with the survivors named', async () => {
    connectionWorktrees['wt-a-api'].status = 'archived'

    const queue = await buildRunDoneQueue(connectionDetail(), 'run-ticket', tickets())

    expect(queue.kept).toContainEqual({
      label: 'A1 · Alpha',
      reason: 'its worktree in Api is gone — Web left as it is'
    })
    expect(queue.alsoMoveTicketIds).toContain('t-a')
    expect(labels(queue.entries).filter((l) => l.endsWith('A1 · Alpha'))).toEqual([])
  })

  it('a clean instance with a worktree in a blocked member is kept, not archived', async () => {
    connectionMerge.assessConnectionMembers.mockResolvedValue({
      targets: [{ worktreeId: 'wt-int-web', projectId: 'proj-web', alreadyMerged: true }],
      skipped: [{ worktreeId: 'wt-int-api', projectId: 'proj-api', reason: 'no-base-worktree' }],
      found: true
    })

    const queue = await buildRunDoneQueue(connectionDetail(), 'run-ticket', tickets())

    expect(queue.kept).toContainEqual({ label: 'A1 · Alpha', reason: 'Api: no worktree on main to merge into' })
    expect(labels(queue.entries)).toEqual(['run-integration:The run · Web'])
  })

  it('a member integration worktree mid-archive counts as gone', async () => {
    connectionMerge.assessConnectionMembers.mockResolvedValue({
      targets: [{ worktreeId: 'wt-int-web', projectId: 'proj-web', alreadyMerged: true }],
      skipped: [{ worktreeId: 'wt-int-api', projectId: 'proj-api', reason: 'inactive' }],
      found: true
    })
    ahead = { '/api/a2': { main: 1 } }

    const queue = await buildRunDoneQueue(connectionDetail(), 'run-ticket', tickets())

    expect(dbApiMocks.worktree.get).not.toHaveBeenCalledWith('wt-int-api')
    expect(gitApiMocks.branchDiffShortStat).toHaveBeenCalledWith('/api/a2', 'main')
    expect(queue.kept).toContainEqual({ label: 'A2 · Beta', reason: 'Api: the integration worktree is gone — merge it by hand' })
  })

  it('a ticket with no instance rides along like a worktree-less one', async () => {
    const queue = await buildRunDoneQueue(
      connectionDetail([{ key: 'A1', title: 'Alpha', status: 'merged', ticket_id: 't-a', members: null }]),
      'run-ticket',
      tickets()
    )

    expect(queue.alsoMoveTicketIds).toContain('t-a')
    expect(labels(queue.entries)).toEqual(['run-integration:The run · Api', 'run-integration:The run · Web'])
  })
})

describe('buildRunDoneQueue — pulling first', () => {
  const pulledBeforeAnyCheck = (): boolean =>
    Math.max(...gitApiMocks.syncBranchWithOrigin.mock.invocationCallOrder) <
    Math.min(...gitApiMocks.branchDiffShortStat.mock.invocationCallOrder)

  it('pulls the base the dialog will check the integration branch against', async () => {
    await buildRunDoneQueue(detail(), 'run-ticket', tickets())

    expect(gitApiMocks.syncBranchWithOrigin).toHaveBeenCalledTimes(1)
    expect(gitApiMocks.syncBranchWithOrigin).toHaveBeenCalledWith('/wt/int', 'main')
    expect(pulledBeforeAnyCheck()).toBe(true)
  })

  it('without an integration worktree, pulls the base once before the branches are checked against it', async () => {
    worktrees['wt-int'].status = 'archived'

    await buildRunDoneQueue(detail(), 'run-ticket', tickets())

    expect(gitApiMocks.syncBranchWithOrigin).toHaveBeenCalledTimes(1)
    expect(gitApiMocks.syncBranchWithOrigin).toHaveBeenCalledWith('/wt/a', 'main')
    expect(pulledBeforeAnyCheck()).toBe(true)
  })

  it('on a connection project, leaves active members to the assessment and pulls the base of one without an integration worktree', async () => {
    useConnectionWorktrees()
    connectionWorktrees['wt-int-api'].status = 'archived'

    await buildRunDoneQueue(connectionDetail(), 'run-ticket', tickets())

    expect(connectionMerge.assessConnectionMembers).toHaveBeenCalled()
    // Web still has its integration worktree: its base was the assessment's to pull
    expect(gitApiMocks.syncBranchWithOrigin).toHaveBeenCalledTimes(1)
    expect(gitApiMocks.syncBranchWithOrigin).toHaveBeenCalledWith('/api/a1', 'main')
    const pullOrder = gitApiMocks.syncBranchWithOrigin.mock.invocationCallOrder[0]
    const checkOfApi = gitApiMocks.branchDiffShortStat.mock.calls.findIndex(
      ([path, base]) => path === '/api/a1' && base === 'main'
    )
    expect(pullOrder).toBeLessThan(
      gitApiMocks.branchDiffShortStat.mock.invocationCallOrder[checkOfApi]
    )
  })
})

describe('buildRunDoneQueue', () => {
  it('queues merges first, the integration worktree next, every archive last', async () => {
    ahead = { '/wt/b': { 'doc-run': 2 } }

    const queue = await buildRunDoneQueue(detail(), 'run-ticket', tickets())

    expect(labels(queue.entries)).toEqual([
      'run-child:A2 · Beta',
      'run-integration:The run',
      'run-child-archive:A1 · Alpha',
      'run-child-archive:A2 · Beta'
    ])
    expect(queue.entries[0]).toMatchObject({
      worktreeId: 'wt-b',
      ticketId: 't-b',
      runId: 'run-1',
      itemId: 'item-A2',
      integrationBranch: 'doc-run',
      integrationWorktreeId: 'wt-int'
    })
    expect(queue.entries[2]).toMatchObject({ worktreeId: 'wt-a', ticketId: 't-a', alreadyMerged: true })
    // Measured against the integration branch, not the branch the worktree records as base
    expect(gitApiMocks.branchDiffShortStat).toHaveBeenCalledWith('/wt/a', 'doc-run')
    expect(gitApiMocks.branchDiffShortStat).toHaveBeenCalledWith('/wt/b', 'doc-run')
    // A ticket the run opened that no item names any more rides along; a never-started
    // one and an archived one do not
    expect(queue.alsoMoveTicketIds).toEqual(['t-fix'])
    expect(queue.kept).toEqual([{ label: 'Ticket t-old', reason: 'never started' }])
  })

  it('rejects when a branch cannot be verified — unchecked work is never treated as clean', async () => {
    gitApiMocks.branchDiffShortStat.mockImplementation(async (path: string) =>
      path === '/wt/b'
        ? { success: false, error: 'not a git repository' }
        : { success: true, filesChanged: 0, insertions: 0, deletions: 0, commitsAhead: 0 }
    )

    await expect(buildRunDoneQueue(detail(), 'run-ticket', tickets())).rejects.toThrow(
      'a2-beta: not a git repository'
    )
  })

  it('never merges again a branch the run already merged: leftovers keep it, its ticket rides along', async () => {
    // A1 landed (status merged, merge_sha); its agent left uncommitted files behind
    gitApiMocks.hasUncommittedChanges.mockImplementation(async (path: string) => path === '/wt/a')

    const queue = await buildRunDoneQueue(detail(), 'run-ticket', tickets())

    expect(labels(queue.entries)).toEqual(['run-integration:The run', 'run-child-archive:A2 · Beta'])
    expect(queue.kept).toContainEqual({
      label: 'A1 · Alpha',
      reason: 'has uncommitted changes since the run merged it — not archived'
    })
    expect(queue.alsoMoveTicketIds).toEqual(['t-a', 't-fix'])
  })

  it('a landed branch with commits the integration branch lacks is a merge step again', async () => {
    ahead = { '/wt/a': { 'doc-run': 1 } }

    const queue = await buildRunDoneQueue(detail(), 'run-ticket', tickets())

    expect(labels(queue.entries)).toEqual([
      'run-child:A1 · Alpha',
      'run-integration:The run',
      'run-child-archive:A1 · Alpha',
      'run-child-archive:A2 · Beta'
    ])
    expect(queue.alsoMoveTicketIds).toEqual(['t-fix'])
  })

  it('a landed branch that cannot be verified is kept, not a reason to refuse the drop', async () => {
    gitApiMocks.branchDiffShortStat.mockImplementation(async (path: string) =>
      path === '/wt/a'
        ? { success: false, error: 'not a git repository' }
        : { success: true, filesChanged: 0, insertions: 0, deletions: 0, commitsAhead: 0 }
    )

    const queue = await buildRunDoneQueue(detail(), 'run-ticket', tickets())

    expect(labels(queue.entries)).toEqual(['run-integration:The run', 'run-child-archive:A2 · Beta'])
    expect(queue.kept).toContainEqual({
      label: 'A1 · Alpha',
      reason: 'could not be verified: not a git repository — not archived'
    })
    expect(queue.alsoMoveTicketIds).toContain('t-a')
  })

  it('without an integration worktree, a landed branch with leftovers is kept and its ticket rides along', async () => {
    worktrees['wt-int'].status = 'archived'
    gitApiMocks.hasUncommittedChanges.mockImplementation(async (path: string) => path === '/wt/a')

    const queue = await buildRunDoneQueue(detail(), 'run-ticket', tickets())

    expect(labels(queue.entries)).toEqual(['run-child-archive:A2 · Beta'])
    expect(queue.kept).toContainEqual({
      label: 'A1 · Alpha',
      reason: 'has uncommitted changes since the run merged it — not archived'
    })
    expect(queue.alsoMoveTicketIds).toContain('t-a')
  })

  it('keeps a branch whose session is still working', async () => {
    signal.getSessionSignal.mockImplementation((id: string) => ({
      kind: id === 's-b' ? 'working' : 'ended'
    }))

    const queue = await buildRunDoneQueue(detail(), 'run-ticket', tickets())

    expect(labels(queue.entries)).toEqual([
      'run-integration:The run',
      'run-child-archive:A1 · Alpha'
    ])
    expect(queue.kept).toContainEqual({
      label: 'A2 · Beta',
      reason: 'its session is still working — stop it first'
    })
  })

  it('keeps a branch with unresolved conflict markers', async () => {
    gitApiMocks.getFileStatuses.mockImplementation(async (path: string) => ({
      success: true,
      files: path === '/wt/b' ? [{ path: 'x.ts', relativePath: 'x.ts', status: 'C', staged: false }] : []
    }))

    const queue = await buildRunDoneQueue(detail(), 'run-ticket', tickets())

    expect(labels(queue.entries)).not.toContain('run-child:A2 · Beta')
    expect(queue.kept).toContainEqual({ label: 'A2 · Beta', reason: 'has unresolved conflict markers' })
  })

  it('moves the ticket of a gone worktree only when its merge landed', async () => {
    dbApiMocks.worktree.get.mockImplementation(async (id: string) =>
      id === 'wt-a' || id === 'wt-b' ? null : (worktrees[id] ?? null)
    )

    const queue = await buildRunDoneQueue(detail(), 'run-ticket', tickets())

    expect(labels(queue.entries)).toEqual(['run-integration:The run'])
    expect(queue.alsoMoveTicketIds).toEqual(['t-a', 't-fix'])
    expect(queue.kept).toContainEqual({
      label: 'A2 · Beta',
      reason: 'its worktree is gone and its work never landed'
    })
  })

  it('without an integration worktree, only branches already on base are archived', async () => {
    worktrees['wt-int'].status = 'archived'
    ahead = { '/wt/b': { main: 3 } }

    const queue = await buildRunDoneQueue(detail(), 'run-ticket', tickets())

    expect(labels(queue.entries)).toEqual(['run-child-archive:A1 · Alpha'])
    expect(gitApiMocks.branchDiffShortStat).toHaveBeenCalledWith('/wt/a', 'main')
    expect(queue.kept).toContainEqual({
      label: 'A2 · Beta',
      reason: 'the integration worktree is gone — merge it by hand'
    })
  })

  it('fix tickets and worktree-less items ride along; the integration worktree is never a child', async () => {
    const queue = await buildRunDoneQueue(
      detail([
        { key: 'A1', title: 'Alpha', status: 'merged', ticket_id: 't-a', worktree_id: 'wt-a', fix_ticket_id: 't-fix' },
        // A fix ticket's own worktree is the integration worktree
        { key: 'A2', title: 'Beta', status: 'merged', ticket_id: 't-b', worktree_id: 'wt-int' }
      ]),
      'run-ticket',
      tickets()
    )

    expect(labels(queue.entries)).toEqual([
      'run-integration:The run',
      'run-child-archive:A1 · Alpha'
    ])
    expect(queue.alsoMoveTicketIds).toEqual(['t-fix', 't-b'])
  })

  it('ignores deselected items', async () => {
    const queue = await buildRunDoneQueue(
      detail([
        { key: 'A1', title: 'Alpha', status: 'merged', ticket_id: 't-a', worktree_id: 'wt-a' },
        { key: 'A2', title: 'Beta', status: 'skipped', ticket_id: 't-b', worktree_id: 'wt-b', selected: false }
      ]),
      'run-ticket',
      tickets()
    )

    expect(labels(queue.entries)).toEqual([
      'run-integration:The run',
      'run-child-archive:A1 · Alpha'
    ])
  })
})

describe('queueDocumentRunDone', () => {
  const moveTicket = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    moveTicket.mockClear()
    useKanbanStore.setState({
      tickets: new Map([['proj', tickets()]]),
      pendingDoneMove: null,
      moveTicket
    })
  })

  const args = {
    runId: 'run-1',
    ticketId: 'run-ticket',
    projectId: 'proj',
    targetColumn: 'done' as const,
    sortOrder: 7
  }

  it('shows that the branches are being checked, and clears it once the queue is built', async () => {
    flowApi.get.mockResolvedValue(detail())

    await queueDocumentRunDone(args)

    expect(toastMocks.loading).toHaveBeenCalledWith('Checking 2 branches of The run…')
    expect(toastMocks.dismiss).toHaveBeenCalledWith('toast-1')
  })

  it('clears the checking toast when a branch cannot be verified', async () => {
    flowApi.get.mockResolvedValue(detail())
    gitApiMocks.branchDiffShortStat.mockResolvedValue({ success: false, error: 'boom' })

    await expect(queueDocumentRunDone(args)).rejects.toThrow()
    expect(toastMocks.dismiss).toHaveBeenCalledWith('toast-1')
  })

  it('hands the queue to the dialog with the run attached', async () => {
    ahead = { '/wt/b': { 'doc-run': 2 } }
    flowApi.get.mockResolvedValue(detail())

    expect(await queueDocumentRunDone(args)).toBe('queued')

    const pending = useKanbanStore.getState().pendingDoneMove
    expect(pending).toMatchObject({
      ticketId: 'run-ticket',
      projectId: 'proj',
      sortOrder: 7,
      targetColumn: 'done',
      worktreeId: 'wt-b',
      worktreeProjectId: 'proj',
      offerArchive: true,
      entry: { kind: 'run-child', worktreeId: 'wt-b' },
      run: { runId: 'run-1', title: 'The run', alsoMoveTicketIds: ['t-fix'] }
    })
    expect(pending?.remainingWorktrees?.map((w) => w.kind)).toEqual([
      'run-integration',
      'run-child-archive',
      'run-child-archive'
    ])
    expect(moveTicket).not.toHaveBeenCalled()
  })

  it('leaves a connection run whose members were never recorded to the plain path', async () => {
    flowApi.get.mockResolvedValue(
      detail([], { integration_worktree_id: null, integration_connection_id: 'conn-1', members: null })
    )

    expect(await queueDocumentRunDone(args)).toBe('nothing')
    expect(useKanbanStore.getState().pendingDoneMove).toBeNull()
    expect(moveTicket).not.toHaveBeenCalled()
  })

  it('counts every member worktree of a connection run in the checking toast', async () => {
    flowApi.get.mockResolvedValue(connectionDetail())

    await queueDocumentRunDone(args)

    expect(toastMocks.loading).toHaveBeenCalledWith('Checking 4 branches of The run…')
  })

  it('moves the worktree-less children along and leaves the run ticket to the caller when nothing is queued', async () => {
    worktrees['wt-int'].status = 'archived'
    flowApi.get.mockResolvedValue(
      detail([{ key: 'A1', title: 'Alpha', status: 'merged', ticket_id: 't-b', worktree_id: null }])
    )

    expect(await queueDocumentRunDone(args)).toBe('nothing')

    expect(useKanbanStore.getState().pendingDoneMove).toBeNull()
    // t-a: a ticket the run opened that no item names any more rides along too
    expect(moveTicket.mock.calls.map((c) => c[0]).sort()).toEqual(['t-a', 't-b', 't-fix'])
    expect(moveTicket).toHaveBeenCalledWith('t-b', 'proj', 'done', expect.any(Number), {
      skipCompletionEffects: true
    })
    expect(toastMocks.warning).toHaveBeenCalledWith(expect.stringContaining('Ticket t-old'))
  })

  it('reports a run that is gone as nothing to batch', async () => {
    flowApi.get.mockResolvedValue(null)

    expect(await queueDocumentRunDone(args)).toBe('nothing')
    expect(moveTicket).not.toHaveBeenCalled()
  })
})

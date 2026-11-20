/**
 * "Move merged tickets to Done" on the ticket of a run: which of the run's merged tickets are
 * finished with, what becomes of their worktrees, and what the move then does. The branch that
 * counts is the run's integration branch, which stays, as does the run's own ticket.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeDetail } from '@/components/document-flow/test-fixtures'
import { forgetBaseBranchPulls } from '@/lib/base-branch-pull'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import type {
  DocumentRun,
  DocumentRunDetail,
  DocumentRunItem,
  DocumentRunMember
} from '@shared/types/document-flow'
import type { KanbanTicket } from '../../../../main/db/types'
import {
  buildMergedChildrenPlan,
  hasMergedRunItems,
  moveMergedChildrenToDone
} from './run-merged-children'

const dbApiMocks = vi.hoisted(() => ({
  worktree: { get: vi.fn(), getActiveByProject: vi.fn() },
  project: { get: vi.fn() }
}))
const gitApiMocks = vi.hoisted(() => ({
  hasUncommittedChanges: vi.fn(),
  branchDiffShortStat: vi.fn(),
  getFileStatuses: vi.fn(),
  syncBranchWithOrigin: vi.fn()
}))
const flowApi = vi.hoisted(() => ({ get: vi.fn() }))
const signal = vi.hoisted(() => ({ getSessionSignal: vi.fn() }))
const connectionArchive = vi.hoisted(() => ({
  closeInstanceSessions: vi.fn(async () => {}),
  trackConnectionArchives: vi.fn(() => ({ settled: vi.fn(), release: vi.fn(), end: vi.fn() }))
}))
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
vi.mock('@/lib/document-flow/session-signal', () => signal)
vi.mock('@/lib/connection-archive', () => connectionArchive)
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

const wt = (id: string, branch: string, path: string, extra: Partial<Wt> = {}): Wt => ({
  id,
  project_id: 'proj',
  branch_name: branch,
  path,
  status: 'active',
  is_default: false,
  base_branch: 'main',
  ...extra
})

let worktrees: Record<string, Wt> = {}
/** Commits each worktree path is ahead of a branch; everything else is 0. */
let ahead: Record<string, Record<string, number>> = {}
/** Worktree paths with uncommitted changes. */
let dirty = new Set<string>()

function ticket(
  id: string,
  column: KanbanTicket['column'],
  overrides: Partial<KanbanTicket> = {}
): KanbanTicket {
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
    current_session_id: null,
    ...overrides
  } as KanbanTicket
}

const runTicket = (): KanbanTicket =>
  ticket('run-ticket', 'in_progress', {
    parent_ticket_id: null,
    external_provider: 'document-run',
    external_id: 'run-1'
  })

/** A1 merged and finished with, A2 merged too, A3 still at work. */
const tickets = (): KanbanTicket[] => [
  runTicket(),
  ticket('t-a', 'merged'),
  ticket('t-b', 'merged'),
  ticket('t-c', 'in_progress')
]

const ITEMS: Partial<DocumentRunItem>[] = [
  { key: 'A1', title: 'Alpha', status: 'merged', ticket_id: 't-a', worktree_id: 'wt-a', merge_sha: 'sha-a', session_id: 's-a', document_update_status: 'done' },
  { key: 'A2', title: 'Beta', status: 'merged', ticket_id: 't-b', worktree_id: 'wt-b', merge_sha: 'sha-b', session_id: 's-b', document_update_status: 'done' },
  { key: 'A3', title: 'Gamma', status: 'running', ticket_id: 't-c', worktree_id: 'wt-c', session_id: 's-c' }
]

function detail(
  items: Partial<DocumentRunItem>[] = ITEMS,
  run: Partial<DocumentRun> = {}
): DocumentRunDetail {
  return makeDetail(
    {
      id: 'run-1',
      project_id: 'proj',
      title: 'The run',
      status: 'running',
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

const plan = (
  d: DocumentRunDetail = detail(),
  rows: KanbanTicket[] = tickets()
): ReturnType<typeof buildMergedChildrenPlan> => buildMergedChildrenPlan(d, 'run-ticket', rows)

beforeEach(() => {
  vi.clearAllMocks()
  worktrees = {
    'wt-main': wt('wt-main', 'main', '/repo', { is_default: true, base_branch: null }),
    'wt-int': wt('wt-int', 'doc-run', '/wt/int'),
    'wt-a': wt('wt-a', 'a1-alpha', '/wt/a'),
    'wt-b': wt('wt-b', 'a2-beta', '/wt/b'),
    'wt-c': wt('wt-c', 'a3-gamma', '/wt/c')
  }
  ahead = {}
  dirty = new Set()
  dbApiMocks.worktree.get.mockImplementation(async (id: string) => worktrees[id] ?? null)
  dbApiMocks.worktree.getActiveByProject.mockImplementation(async () =>
    Object.values(worktrees).filter((w) => w.status === 'active')
  )
  dbApiMocks.project.get.mockResolvedValue({ path: '/repo' })
  gitApiMocks.hasUncommittedChanges.mockImplementation(async (path: string) => dirty.has(path))
  gitApiMocks.branchDiffShortStat.mockImplementation(async (path: string, base: string) => ({
    success: true,
    filesChanged: 0,
    insertions: 0,
    deletions: 0,
    commitsAhead: ahead[path]?.[base] ?? 0
  }))
  gitApiMocks.getFileStatuses.mockResolvedValue({ success: true, files: [] })
  gitApiMocks.syncBranchWithOrigin.mockResolvedValue({ success: true, updated: false })
  forgetBaseBranchPulls()
  signal.getSessionSignal.mockReturnValue({ kind: 'ended' })
  useDocumentFlowStore.setState({ runsById: {} })
})

describe('hasMergedRunItems', () => {
  it('is true once the run merged a selected ticket', () => {
    expect(hasMergedRunItems(detail())).toBe(true)
    expect(hasMergedRunItems(detail([{ key: 'A1', status: 'running' }]))).toBe(false)
    expect(hasMergedRunItems(detail([{ key: 'A1', status: 'merged', selected: false }]))).toBe(false)
    expect(hasMergedRunItems(undefined)).toBe(false)
  })
})

describe('buildMergedChildrenPlan', () => {
  it('takes the merged tickets, mid-run, and leaves the ones still at work unmentioned', async () => {
    const result = await plan()

    expect(result.held).toEqual([])
    expect(result.children).toEqual([
      {
        itemId: 'item-A1',
        label: 'A1 · Alpha',
        ticketIds: ['t-a'],
        worktreeKept: null,
        worktrees: [
          {
            worktreeId: 'wt-a',
            worktreePath: '/wt/a',
            branch: 'a1-alpha',
            projectPath: '/repo',
            compareBranch: 'doc-run'
          }
        ]
      },
      expect.objectContaining({ itemId: 'item-A2', ticketIds: ['t-b'] })
    ])
    // The branch a ticket must be on is the run's, never base; the unmerged one is not looked at
    expect(gitApiMocks.branchDiffShortStat.mock.calls).toEqual([
      ['/wt/a', 'doc-run'],
      ['/wt/b', 'doc-run']
    ])
    // And nothing asks origin for the base branch: it plays no part while the run's branch lives
    expect(gitApiMocks.syncBranchWithOrigin).not.toHaveBeenCalled()
  })

  it('never offers the run\'s own ticket or its integration worktree', async () => {
    const result = await plan(
      detail([{ key: 'A1', title: 'Alpha', status: 'merged', ticket_id: 'run-ticket', worktree_id: 'wt-int' }])
    )

    expect(result).toEqual({ children: [], held: [] })
  })

  it('holds a merged ticket whose session still has the document to update', async () => {
    const result = await plan(
      detail([
        { ...ITEMS[0], document_update_status: 'queued' },
        { ...ITEMS[1], document_update_status: 'updating' }
      ])
    )

    expect(result.children).toEqual([])
    expect(result.held).toEqual([
      { itemId: 'item-A1', label: 'A1 · Alpha', reason: 'its session is still to update the document' },
      { itemId: 'item-A2', label: 'A2 · Beta', reason: 'its session is updating the document' }
    ])
    expect(gitApiMocks.branchDiffShortStat).not.toHaveBeenCalled()
  })

  it('takes one whose document update failed or was skipped: the run is done with its session', async () => {
    const result = await plan(
      detail([
        { ...ITEMS[0], document_update_status: 'failed' },
        { ...ITEMS[1], document_update_status: 'skipped' }
      ])
    )

    expect(result.children.map((c) => c.itemId)).toEqual(['item-A1', 'item-A2'])
  })

  it('does not wait for a document update a run that ended will never make', async () => {
    const result = await plan(
      detail([{ ...ITEMS[0], document_update_status: 'queued' }], { status: 'cancelled' })
    )

    expect(result.children.map((c) => c.itemId)).toEqual(['item-A1'])
  })

  it('holds a ticket whose session is at work', async () => {
    signal.getSessionSignal.mockImplementation((id: string) =>
      id === 's-a' ? { kind: 'working' } : { kind: 'ended' }
    )

    const result = await plan()

    expect(result.children.map((c) => c.itemId)).toEqual(['item-A2'])
    expect(result.held).toEqual([
      { itemId: 'item-A1', label: 'A1 · Alpha', reason: 'its session is still working' }
    ])
  })

  it('holds a ticket that was taken back out of Merged by hand', async () => {
    const result = await plan(detail(), [runTicket(), ticket('t-a', 'review'), ticket('t-b', 'merged')])

    expect(result.children.map((c) => c.itemId)).toEqual(['item-A2'])
    expect(result.held).toEqual([
      { itemId: 'item-A1', label: 'A1 · Alpha', reason: 'its ticket is back in Review' }
    ])
  })

  it('holds a ticket whose branch has commits the run\'s branch lacks', async () => {
    ahead = { '/wt/a': { 'doc-run': 2 } }

    const result = await plan()

    expect(result.children.map((c) => c.itemId)).toEqual(['item-A2'])
    expect(result.held).toEqual([
      { itemId: 'item-A1', label: 'A1 · Alpha', reason: 'it has commits that are not on doc-run' }
    ])
  })

  it('holds a ticket whose worktree has unresolved conflict markers', async () => {
    gitApiMocks.getFileStatuses.mockImplementation(async (path: string) => ({
      success: true,
      files: path === '/wt/a' ? [{ status: 'C', path: 'a.ts' }] : []
    }))

    const result = await plan()

    expect(result.held).toEqual([
      { itemId: 'item-A1', label: 'A1 · Alpha', reason: 'it has unresolved conflict markers' }
    ])
  })

  it('moves a ticket with stray uncommitted files, and keeps its worktree', async () => {
    dirty = new Set(['/wt/a'])

    const result = await plan()

    expect(result.held).toEqual([])
    expect(result.children[0]).toEqual({
      itemId: 'item-A1',
      label: 'A1 · Alpha',
      ticketIds: ['t-a'],
      worktrees: [],
      worktreeKept: 'it has uncommitted changes'
    })
  })

  it('keeps a worktree git could not read, without failing the rest', async () => {
    gitApiMocks.branchDiffShortStat.mockImplementation(async (path: string) =>
      path === '/wt/a'
        ? { success: false, error: 'bad object' }
        : { success: true, filesChanged: 0, insertions: 0, deletions: 0, commitsAhead: 0 }
    )

    const result = await plan()

    expect(result.children[0]).toMatchObject({
      itemId: 'item-A1',
      worktrees: [],
      worktreeKept: 'it could not be checked: bad object'
    })
    expect(result.children[1].worktrees).toHaveLength(1)
  })

  it('moves a ticket whose worktree is archived already, with nothing to archive', async () => {
    worktrees['wt-a'].status = 'archived'

    const result = await plan()

    expect(result.children[0]).toEqual({
      itemId: 'item-A1',
      label: 'A1 · Alpha',
      ticketIds: ['t-a'],
      worktrees: [],
      worktreeKept: null
    })
  })

  it('offers the worktree of a ticket that is in Done already, and drops one with nothing left', async () => {
    worktrees['wt-b'].status = 'archived'

    const result = await plan(detail(), [runTicket(), ticket('t-a', 'done'), ticket('t-b', 'done')])

    expect(result.held).toEqual([])
    expect(result.children).toEqual([
      expect.objectContaining({ itemId: 'item-A1', ticketIds: [], worktrees: [expect.objectContaining({ worktreeId: 'wt-a' })] })
    ])
  })

  it('takes the fix ticket of a merged item along', async () => {
    const result = await plan(
      detail([{ ...ITEMS[0], fix_ticket_id: 't-fix', fix_session_id: 's-fix' }]),
      [...tickets(), ticket('t-fix', 'review')]
    )

    expect(result.children[0].ticketIds).toEqual(['t-a', 't-fix'])
  })

  it('leaves a ticket another run took over, and says which', async () => {
    useDocumentFlowStore.setState({
      runsById: {
        'run-next': makeDetail(
          { id: 'run-next', project_id: 'proj', title: 'Next wave', source_kind: 'tickets', source_path: '', status: 'running' },
          [{ key: 'TD-5', ticket_id: 't-a', status: 'running', session_id: 's-next' }]
        )
      }
    })

    const result = await plan()

    expect(result.children.map((c) => c.itemId)).toEqual(['item-A2'])
    expect(result.held).toEqual([
      { itemId: 'item-A1', label: 'A1 · Alpha', reason: 'now part of “Next wave”' }
    ])
  })

  it('checks against base once the integration worktree is gone', async () => {
    worktrees['wt-int'].status = 'archived'
    ahead = { '/wt/b': { main: 1 } }

    const result = await plan(detail(ITEMS, { status: 'completed' }))

    expect(result.children).toEqual([
      expect.objectContaining({
        itemId: 'item-A1',
        worktrees: [expect.objectContaining({ worktreeId: 'wt-a', compareBranch: 'main' })]
      })
    ])
    expect(result.held).toEqual([
      { itemId: 'item-A2', label: 'A2 · Beta', reason: 'it has commits that are not on main' }
    ])
  })
})

describe('buildMergedChildrenPlan — a run on a connection project', () => {
  const members: DocumentRunMember[] = [
    { project_id: 'proj-web', project_name: 'Web', project_path: '/web', symlink_name: 'web', base_branch: 'main', base_sha: 'w0', integration_branch: 'doc-run', integration_worktree_id: 'wt-int-web', integration_worktree_path: '/web/int' },
    { project_id: 'proj-api', project_name: 'Api', project_path: '/api', symlink_name: 'api', base_branch: 'main', base_sha: 'a0', integration_branch: 'doc-run', integration_worktree_id: 'wt-int-api', integration_worktree_path: '/api/int' }
  ]
  const instance = (key: string): DocumentRunItem['members'] => [
    { project_id: 'proj-web', worktree_id: `wt-${key}-web`, branch_name: 'x', pre_merge_sha: null, merge_sha: 'm' },
    { project_id: 'proj-api', worktree_id: `wt-${key}-api`, branch_name: 'x', pre_merge_sha: null, merge_sha: 'm' }
  ]
  const connectionDetail = (): DocumentRunDetail =>
    detail(
      [
        { key: 'A1', title: 'Alpha', status: 'merged', ticket_id: 't-a', connection_id: 'conn-a', members: instance('a'), merge_sha: 'm' },
        { key: 'A2', title: 'Beta', status: 'merged', ticket_id: 't-b', connection_id: 'conn-b', members: instance('b'), merge_sha: 'm' }
      ],
      { integration_worktree_id: null, integration_connection_id: 'conn-int', members }
    )

  beforeEach(() => {
    worktrees = {
      'wt-int-web': wt('wt-int-web', 'doc-run', '/web/int', { project_id: 'proj-web' }),
      'wt-int-api': wt('wt-int-api', 'doc-run', '/api/int', { project_id: 'proj-api' }),
      'wt-a-web': wt('wt-a-web', 'a1-alpha', '/web/a1', { project_id: 'proj-web' }),
      'wt-a-api': wt('wt-a-api', 'a1-alpha', '/api/a1', { project_id: 'proj-api' }),
      'wt-b-web': wt('wt-b-web', 'a2-beta', '/web/a2', { project_id: 'proj-web' }),
      'wt-b-api': wt('wt-b-api', 'a2-beta', '/api/a2', { project_id: 'proj-api' })
    }
  })

  it('archives a ticket\'s instance whole: one worktree per member repository', async () => {
    const result = await plan(connectionDetail())

    expect(result.held).toEqual([])
    expect(result.children[0]).toEqual({
      itemId: 'item-A1',
      label: 'A1 · Alpha',
      ticketIds: ['t-a'],
      worktreeKept: null,
      connectionId: 'conn-a',
      worktrees: [
        { worktreeId: 'wt-a-web', worktreePath: '/web/a1', branch: 'a1-alpha', projectPath: '/web', compareBranch: 'doc-run', projectName: 'Web' },
        { worktreeId: 'wt-a-api', worktreePath: '/api/a1', branch: 'a1-alpha', projectPath: '/api', compareBranch: 'doc-run', projectName: 'Api' }
      ]
    })
  })

  it('keeps the whole instance when one member has leftovers, and holds it when one has work', async () => {
    dirty = new Set(['/api/a1'])
    ahead = { '/web/a2': { 'doc-run': 1 } }

    const result = await plan(connectionDetail())

    expect(result.children).toEqual([
      { itemId: 'item-A1', label: 'A1 · Alpha', ticketIds: ['t-a'], worktrees: [], worktreeKept: 'it has uncommitted changes in Api' }
    ])
    expect(result.held).toEqual([
      { itemId: 'item-A2', label: 'A2 · Beta', reason: 'it has commits in Web that are not on doc-run' }
    ])
  })
})

describe('moveMergedChildrenToDone', () => {
  const target = { runId: 'run-1', ticketId: 'run-ticket', projectId: 'proj' }
  const moveTicket = vi.fn()
  const archiveWorktree = vi.fn()
  const chosen = [
    { itemId: 'item-A1', label: 'A1 · Alpha' },
    { itemId: 'item-A2', label: 'A2 · Beta' }
  ]

  beforeEach(() => {
    moveTicket.mockReset().mockResolvedValue(undefined)
    archiveWorktree.mockReset().mockResolvedValue({ success: true })
    useKanbanStore.setState({ tickets: new Map([['proj', tickets()]]), moveTicket })
    useWorktreeStore.setState({ archiveWorktree })
    flowApi.get.mockResolvedValue(detail())
  })

  it('moves the chosen tickets to Done and archives their worktrees, leaving the run alone', async () => {
    const result = await moveMergedChildrenToDone(target, chosen, { archiveWorktrees: true })
    await result.archive

    expect(result).toMatchObject({ moved: 2, skipped: [], archiving: 2 })
    expect(moveTicket.mock.calls.map((c) => c[0])).toEqual(['t-a', 't-b'])
    // With the completion effects off: the work is on the run's branch, not on base
    expect(moveTicket).toHaveBeenCalledWith('t-a', 'proj', 'done', expect.any(Number), {
      skipCompletionEffects: true
    })
    expect(archiveWorktree.mock.calls).toEqual([
      ['wt-a', '/wt/a', 'a1-alpha', '/repo'],
      ['wt-b', '/wt/b', 'a2-beta', '/repo']
    ])
    expect(toastMocks.success).toHaveBeenCalledWith('2 tickets moved to Done')
    expect(toastMocks.success).toHaveBeenCalledWith('2 worktrees archived')
  })

  it('moves only what was chosen', async () => {
    const result = await moveMergedChildrenToDone(target, [chosen[1]], { archiveWorktrees: true })
    await result.archive

    expect(moveTicket.mock.calls.map((c) => c[0])).toEqual(['t-b'])
    expect(archiveWorktree.mock.calls.map((c) => c[0])).toEqual(['wt-b'])
  })

  it('keeps every worktree when asked to', async () => {
    const result = await moveMergedChildrenToDone(target, chosen, { archiveWorktrees: false })
    await result.archive

    expect(result).toMatchObject({ moved: 2, archiving: 0 })
    expect(archiveWorktree).not.toHaveBeenCalled()
  })

  it('leaves a ticket that is not finished with any more since the dialog opened', async () => {
    signal.getSessionSignal.mockImplementation((id: string) =>
      id === 's-a' ? { kind: 'working' } : { kind: 'ended' }
    )

    const result = await moveMergedChildrenToDone(target, chosen, { archiveWorktrees: true })
    await result.archive

    expect(result.skipped).toEqual([
      { itemId: 'item-A1', label: 'A1 · Alpha', reason: 'its session is still working' }
    ])
    expect(moveTicket.mock.calls.map((c) => c[0])).toEqual(['t-b'])
    expect(archiveWorktree.mock.calls.map((c) => c[0])).toEqual(['wt-b'])
    expect(toastMocks.warning).toHaveBeenCalledWith(
      'Left as it is: A1 · Alpha (its session is still working)'
    )
  })

  it('does not archive a worktree that picked up changes right before the archive', async () => {
    // Clean when the plan is built, written to by the time its worktree would go
    let looks = 0
    gitApiMocks.hasUncommittedChanges.mockImplementation(async (path: string) => {
      if (path !== '/wt/a') return false
      looks += 1
      return looks > 1
    })

    const result = await moveMergedChildrenToDone(target, chosen, { archiveWorktrees: true })
    await result.archive

    expect(moveTicket.mock.calls.map((c) => c[0])).toEqual(['t-a', 't-b'])
    expect(archiveWorktree.mock.calls.map((c) => c[0])).toEqual(['wt-b'])
    expect(toastMocks.warning).toHaveBeenCalledWith('A1 · Alpha has new changes — not archived')
  })

  it('keeps the worktree of a ticket that would not move', async () => {
    moveTicket.mockImplementation(async (ticketId: string) => {
      if (ticketId === 't-a') throw new Error('board is read-only')
    })

    const result = await moveMergedChildrenToDone(target, chosen, { archiveWorktrees: true })
    await result.archive

    expect(result.moved).toBe(1)
    expect(archiveWorktree.mock.calls.map((c) => c[0])).toEqual(['wt-b'])
    expect(toastMocks.error).toHaveBeenCalledWith('Could not move Ticket t-a: board is read-only')
  })

  it('reports a worktree that could not be archived', async () => {
    archiveWorktree.mockImplementation(async (id: string) =>
      id === 'wt-a' ? { success: false, error: 'locked' } : { success: true }
    )

    const result = await moveMergedChildrenToDone(target, chosen, { archiveWorktrees: true })
    await result.archive

    expect(toastMocks.error).toHaveBeenCalledWith('Failed to archive a1-alpha: locked')
    expect(toastMocks.success).toHaveBeenCalledWith('1 worktree archived')
  })

  it('rejects when the run is gone', async () => {
    flowApi.get.mockResolvedValue(null)

    await expect(
      moveMergedChildrenToDone(target, chosen, { archiveWorktrees: true })
    ).rejects.toThrow('The run no longer exists.')
    expect(moveTicket).not.toHaveBeenCalled()
  })
})

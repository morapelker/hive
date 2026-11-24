/**
 * The override behind a ⌘⇧-drag of a run's ticket to Done/Merged: every branch the run opened
 * is queued for the archive step as it is — nothing is pulled and no branch is checked — while
 * the tickets that are not the run's to move stay where they are, as on its shift-drop.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeDetail } from '@/components/document-flow/test-fixtures'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import type {
  DocumentRun,
  DocumentRunDetail,
  DocumentRunItem,
  DocumentRunMember
} from '@shared/types/document-flow'
import type { KanbanTicket } from '../../../../main/db/types'
import {
  buildRunArchiveOverrideQueue,
  dropRunTicketArchiveOverride,
  queueRunArchiveOverride,
  runArchiveOverrideTargets
} from './run-archive-override'

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
const connectionApiMocks = vi.hoisted(() => ({ get: vi.fn() }))
const signal = vi.hoisted(() => ({ getSessionSignal: vi.fn() }))
const toastMocks = vi.hoisted(() => ({
  warning: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  progress: vi.fn((..._args: unknown[]) => 'toast-1'),
  dismiss: vi.fn()
}))

vi.mock('@/api/db-api', () => ({ dbApi: dbApiMocks }))
vi.mock('@/api/git-api', () => ({ gitApi: gitApiMocks }))
vi.mock('@/api/document-flow-api', () => ({ documentFlowApi: flowApi }))
vi.mock('@/api/connection-api', () => ({ connectionApi: connectionApiMocks }))
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

const wt = (
  id: string,
  project_id: string,
  branch_name: string,
  path: string,
  extra: Partial<Wt> = {}
): Wt => ({ id, project_id, branch_name, path, status: 'active', is_default: false, base_branch: 'main', ...extra })

let worktrees: Record<string, Wt> = {}

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

const runTicket = (column: KanbanTicket['column'] = 'review'): KanbanTicket =>
  ticket('run-ticket', column, {
    parent_ticket_id: null,
    external_provider: 'document-run',
    external_id: 'run-1'
  })

const tickets = (): KanbanTicket[] => [
  runTicket(),
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

const expectNoGit = (): void => {
  expect(gitApiMocks.hasUncommittedChanges).not.toHaveBeenCalled()
  expect(gitApiMocks.branchDiffShortStat).not.toHaveBeenCalled()
  expect(gitApiMocks.getFileStatuses).not.toHaveBeenCalled()
  expect(gitApiMocks.syncBranchWithOrigin).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.clearAllMocks()
  worktrees = {
    'wt-main': wt('wt-main', 'proj', 'main', '/repo', { is_default: true, base_branch: null }),
    'wt-int': wt('wt-int', 'proj', 'doc-run', '/wt/int'),
    'wt-a': wt('wt-a', 'proj', 'a1-alpha', '/wt/a'),
    'wt-b': wt('wt-b', 'proj', 'a2-beta', '/wt/b')
  }
  dbApiMocks.worktree.get.mockImplementation(async (id: string) => worktrees[id] ?? null)
  // Every branch still has work: the override must not care (and must never ask)
  gitApiMocks.hasUncommittedChanges.mockResolvedValue(true)
  gitApiMocks.branchDiffShortStat.mockResolvedValue({ success: false, error: 'not a repository' })
  signal.getSessionSignal.mockReturnValue({ kind: 'ended' })
  useWorktreeStore.setState({ archivingWorktreeIds: new Set() })
  useDocumentFlowStore.setState({ runsById: {} })
  useSettingsStore.setState({ showMergedColumn: false })
})

describe('buildRunArchiveOverrideQueue', () => {
  it('queues the integration worktree and every ticket branch for the archive step, without git', async () => {
    const queue = await buildRunArchiveOverrideQueue(detail(), 'run-ticket', tickets())

    expect(labels(queue.entries)).toEqual([
      'run-integration:The run',
      'run-child-archive:A1 · Alpha',
      'run-child-archive:A2 · Beta'
    ])
    expect(queue.entries[0]).toEqual({
      worktreeId: 'wt-int',
      projectId: 'proj',
      kind: 'run-integration',
      label: 'The run'
    })
    // A branch that never landed is queued like one that did, with its ticket
    expect(queue.entries[2]).toEqual({
      worktreeId: 'wt-b',
      projectId: 'proj',
      kind: 'run-child-archive',
      label: 'A2 · Beta',
      ticketId: 't-b'
    })
    expectNoGit()
  })

  it('moves the ticket of a worktree that is gone along, whether or not its work landed', async () => {
    worktrees['wt-b'].status = 'archived'
    delete worktrees['wt-a']

    const queue = await buildRunArchiveOverrideQueue(detail(), 'run-ticket', tickets())

    expect(labels(queue.entries)).toEqual(['run-integration:The run'])
    expect(queue.alsoMoveTicketIds).toEqual(expect.arrayContaining(['t-a', 't-b']))
    expect(queue.kept).toEqual([{ label: 'Ticket t-old', reason: 'never started' }])
  })

  it('never offers a default worktree, or one already on its way out', async () => {
    worktrees['wt-a'].is_default = true
    useWorktreeStore.setState({ archivingWorktreeIds: new Set(['wt-int']) })

    const queue = await buildRunArchiveOverrideQueue(detail(), 'run-ticket', tickets())

    expect(labels(queue.entries)).toEqual(['run-child-archive:A2 · Beta'])
    expect(queue.alsoMoveTicketIds).toContain('t-a')
  })

  it('keeps a branch whose session is still working, and its ticket', async () => {
    signal.getSessionSignal.mockImplementation((sessionId: string) => ({
      kind: sessionId === 's-b' ? 'working' : 'ended'
    }))

    const queue = await buildRunArchiveOverrideQueue(detail(), 'run-ticket', tickets())

    expect(labels(queue.entries)).toEqual(['run-integration:The run', 'run-child-archive:A1 · Alpha'])
    expect(queue.kept).toContainEqual({
      label: 'A2 · Beta',
      reason: 'its session is still working — stop it first'
    })
    expect(queue.alsoMoveTicketIds).not.toContain('t-b')
  })

  it('fix tickets and worktree-less items ride along; a ticket left in To Do stays', async () => {
    const queue = await buildRunArchiveOverrideQueue(
      detail([
        { key: 'A1', title: 'Alpha', status: 'merged', ticket_id: 't-a', worktree_id: 'wt-a', merge_sha: 'sha-a', fix_ticket_id: 't-fix' },
        { key: 'A2', title: 'Beta', status: 'merged', ticket_id: 't-b', worktree_id: null, merge_sha: 'sha-b' },
        { key: 'A3', title: 'Gamma', status: 'pending', ticket_id: 't-old', worktree_id: null },
        // Ran in the integration checkout itself: never an entry of its own
        { key: 'A4', title: 'Delta', status: 'merged', ticket_id: null, worktree_id: 'wt-int', merge_sha: 'sha-d' }
      ]),
      'run-ticket',
      tickets()
    )

    expect(labels(queue.entries)).toEqual(['run-integration:The run', 'run-child-archive:A1 · Alpha'])
    expect(queue.alsoMoveTicketIds).toEqual(['t-fix', 't-b'])
    expect(queue.kept).toEqual([{ label: 'A3 · Gamma', reason: 'never started' }])
  })

  it('ignores deselected items', async () => {
    const queue = await buildRunArchiveOverrideQueue(
      detail([
        { key: 'A1', title: 'Alpha', status: 'merged', ticket_id: 't-a', worktree_id: 'wt-a', merge_sha: 'sha-a' },
        { key: 'A2', title: 'Beta', selected: false, ticket_id: 't-b', worktree_id: 'wt-b' }
      ]),
      'run-ticket',
      tickets().filter((t) => t.id !== 't-b')
    )

    expect(labels(queue.entries)).toEqual(['run-integration:The run', 'run-child-archive:A1 · Alpha'])
  })

  it('lists the integration instance of a connection run whose members were never recorded', async () => {
    connectionApiMocks.get.mockResolvedValue({
      success: true,
      connection: {
        status: 'active',
        members: [
          { worktree_id: 'wt-a', project_id: 'proj' },
          { worktree_id: 'wt-b', project_id: 'proj' }
        ]
      }
    })

    const queue = await buildRunArchiveOverrideQueue(
      detail([], { integration_worktree_id: null, integration_connection_id: 'conn-int', members: null }),
      'run-ticket',
      tickets()
    )

    expect(connectionApiMocks.get).toHaveBeenCalledWith('conn-int')
    expect(queue.entries).toEqual([
      { worktreeId: 'wt-a', projectId: 'proj', kind: 'run-integration', label: 'The run', connectionId: 'conn-int' },
      { worktreeId: 'wt-b', projectId: 'proj', kind: 'run-integration', label: 'The run', connectionId: 'conn-int' }
    ])
  })
})

describe('buildRunArchiveOverrideQueue — run on a connection project', () => {
  const runMembers: DocumentRunMember[] = [
    { project_id: 'proj-web', project_name: 'Web', project_path: '/web', symlink_name: 'web', base_branch: 'main', base_sha: 'w0', integration_branch: 'doc-run', integration_worktree_id: 'wt-int-web', integration_worktree_path: '/web/int' },
    { project_id: 'proj-api', project_name: 'Api', project_path: '/api', symlink_name: 'api', base_branch: 'main', base_sha: 'a0', integration_branch: 'doc-run', integration_worktree_id: 'wt-int-api', integration_worktree_path: '/api/int' }
  ]
  const instance = (key: string): DocumentRunItem['members'] => [
    { project_id: 'proj-web', worktree_id: `wt-${key}-web`, branch_name: 'x', pre_merge_sha: null, merge_sha: null },
    { project_id: 'proj-api', worktree_id: `wt-${key}-api`, branch_name: 'x', pre_merge_sha: null, merge_sha: null }
  ]
  const connectionDetail = (): DocumentRunDetail =>
    detail(
      [
        { key: 'A1', title: 'Alpha', status: 'merged', ticket_id: 't-a', connection_id: 'conn-a', members: instance('a'), merge_sha: 'sha-a' },
        { key: 'A2', title: 'Beta', status: 'needs_attention', ticket_id: 't-b', connection_id: 'conn-b', members: instance('b') }
      ],
      {
        integration_worktree_id: null,
        integration_worktree_path: null,
        integration_connection_id: 'conn-int',
        integration_connection_path: '/connections/doc-run',
        members: runMembers
      }
    )

  beforeEach(() => {
    worktrees = {
      'wt-int-web': wt('wt-int-web', 'proj-web', 'doc-run', '/web/int'),
      'wt-int-api': wt('wt-int-api', 'proj-api', 'doc-run', '/api/int'),
      'wt-a-web': wt('wt-a-web', 'proj-web', 'a1-alpha', '/web/a1'),
      'wt-a-api': wt('wt-a-api', 'proj-api', 'a1-alpha', '/api/a1'),
      'wt-b-web': wt('wt-b-web', 'proj-web', 'a2-beta', '/web/a2'),
      'wt-b-api': wt('wt-b-api', 'proj-api', 'a2-beta', '/api/a2')
    }
  })

  it('makes one integration entry per member and one entry per ticket instance, without git', async () => {
    const queue = await buildRunArchiveOverrideQueue(connectionDetail(), 'run-ticket', tickets())

    expect(labels(queue.entries)).toEqual([
      'run-integration:The run · Web',
      'run-integration:The run · Api',
      'run-child-archive:A1 · Alpha',
      'run-child-archive:A2 · Beta'
    ])
    expect(queue.entries[0]).toEqual({
      worktreeId: 'wt-int-web',
      projectId: 'proj-web',
      kind: 'run-integration',
      label: 'The run · Web',
      connectionId: 'conn-int'
    })
    expect(queue.entries[3]).toEqual({
      worktreeId: 'wt-b-web',
      projectId: 'proj-web',
      kind: 'run-child-archive',
      label: 'A2 · Beta',
      itemId: 'item-A2',
      connectionId: 'conn-b',
      ticketId: 't-b',
      members: [
        { worktreeId: 'wt-b-web', projectId: 'proj-web', projectName: 'Web', branchName: 'a2-beta', worktreePath: '/web/a2' },
        { worktreeId: 'wt-b-api', projectId: 'proj-api', projectName: 'Api', branchName: 'a2-beta', worktreePath: '/api/a2' }
      ]
    })
    expectNoGit()
  })

  it('queues what is left of an instance, and moves the ticket of one that is gone entirely', async () => {
    worktrees['wt-a-web'].status = 'archived'
    delete worktrees['wt-b-web']
    delete worktrees['wt-b-api']

    const queue = await buildRunArchiveOverrideQueue(connectionDetail(), 'run-ticket', tickets())

    const alpha = queue.entries.find((e) => e.label === 'A1 · Alpha')
    expect(alpha).toMatchObject({ worktreeId: 'wt-a-api', projectId: 'proj-api' })
    expect(alpha?.members?.map((m) => m.worktreeId)).toEqual(['wt-a-api'])
    expect(queue.entries.some((e) => e.label === 'A2 · Beta')).toBe(false)
    expect(queue.alsoMoveTicketIds).toContain('t-b')
  })
})

describe('queueRunArchiveOverride', () => {
  const moveTicket = vi.fn().mockResolvedValue(undefined)
  const args = {
    runId: 'run-1',
    ticketId: 'run-ticket',
    projectId: 'proj',
    targetColumn: 'done' as const,
    sortOrder: 7
  }

  beforeEach(() => {
    moveTicket.mockClear()
    useKanbanStore.setState({
      tickets: new Map([['proj', tickets()]]),
      pendingDoneMove: null,
      moveTicket
    })
  })

  it('hands the dialog the whole run, unchecked, open on the archive step', async () => {
    flowApi.get.mockResolvedValue(
      detail([
        { key: 'A1', title: 'Alpha', status: 'merged', ticket_id: 't-a', worktree_id: 'wt-a', merge_sha: 'sha-a', fix_ticket_id: 't-fix' },
        { key: 'A2', title: 'Beta', status: 'needs_attention', ticket_id: 't-b', worktree_id: 'wt-b' }
      ])
    )

    expect(await queueRunArchiveOverride(args)).toBe('queued')

    const pending = useKanbanStore.getState().pendingDoneMove
    expect(pending).toMatchObject({
      ticketId: 'run-ticket',
      projectId: 'proj',
      sortOrder: 7,
      targetColumn: 'done',
      worktreeId: 'wt-int',
      worktreeProjectId: 'proj',
      offerArchive: true,
      skipMergeChecks: true,
      entry: { kind: 'run-integration', worktreeId: 'wt-int' },
      run: {
        runId: 'run-1',
        title: 'The run',
        kept: [{ label: 'Ticket t-old', reason: 'never started' }],
        alsoMoveTicketIds: ['t-fix']
      }
    })
    expect(pending?.remainingWorktrees?.map((w) => `${w.kind}:${w.worktreeId}`)).toEqual([
      'run-child-archive:wt-a',
      'run-child-archive:wt-b'
    ])
    // Nothing moves before the archive step is answered, and nothing says "checking"
    expect(moveTicket).not.toHaveBeenCalled()
    expect(toastMocks.progress).not.toHaveBeenCalled()
    expectNoGit()
  })

  it('with no worktree left, moves the riders along and leaves the run ticket to the caller', async () => {
    worktrees = {}
    flowApi.get.mockResolvedValue(detail())

    expect(await queueRunArchiveOverride({ ...args, targetColumn: 'merged' })).toBe('nothing')

    expect(useKanbanStore.getState().pendingDoneMove).toBeNull()
    // t-a sits in Merged already; t-b and the run's leftover child follow, and the To Do
    // ticket is named instead
    expect(moveTicket.mock.calls.map((call) => call.slice(0, 3))).toEqual([
      ['t-b', 'proj', 'merged'],
      ['t-fix', 'proj', 'merged']
    ])
    expect(moveTicket.mock.calls[0][4]).toEqual({ skipCompletionEffects: true })
    expect(toastMocks.warning).toHaveBeenCalledWith('Kept: Ticket t-old (never started)')
  })

  it('leaves everything to the caller when the run record is gone', async () => {
    flowApi.get.mockResolvedValue(null)

    expect(await queueRunArchiveOverride(args)).toBe('nothing')
    expect(useKanbanStore.getState().pendingDoneMove).toBeNull()
  })

  it('rejects when a worktree cannot be looked up', async () => {
    flowApi.get.mockResolvedValue(detail())
    dbApiMocks.worktree.get.mockRejectedValue(new Error('db is locked'))

    await expect(queueRunArchiveOverride(args)).rejects.toThrow('db is locked')
    expect(useKanbanStore.getState().pendingDoneMove).toBeNull()
  })
})

describe('runArchiveOverrideTargets', () => {
  it('is Done and Merged, never the column the ticket is in', () => {
    expect(runArchiveOverrideTargets('review')).toEqual(['done', 'merged'])
    expect(runArchiveOverrideTargets('done')).toEqual(['merged'])
  })

  it('leaves out the Done list for a Merged card folded into it', () => {
    expect(runArchiveOverrideTargets('merged')).toEqual([])

    useSettingsStore.setState({ showMergedColumn: true })
    expect(runArchiveOverrideTargets('merged')).toEqual(['done'])
  })
})

describe('dropRunTicketArchiveOverride', () => {
  const moveTicket = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    moveTicket.mockClear()
    useKanbanStore.setState({
      tickets: new Map([['proj', tickets()]]),
      pendingDoneMove: null,
      moveTicket
    })
    flowApi.get.mockResolvedValue(detail())
  })

  it('opens the archive step for the whole run', async () => {
    await dropRunTicketArchiveOverride(runTicket(), 'done')

    expect(useKanbanStore.getState().pendingDoneMove).toMatchObject({
      ticketId: 'run-ticket',
      targetColumn: 'done',
      skipMergeChecks: true,
      run: { runId: 'run-1' }
    })
    expect(moveTicket).not.toHaveBeenCalled()
  })

  it('refuses while the run is still going, with the sentence a plain drop gets', async () => {
    flowApi.get.mockResolvedValue(detail(undefined, { status: 'running' }))

    await dropRunTicketArchiveOverride(runTicket('in_progress'), 'done')

    expect(toastMocks.warning).toHaveBeenCalledWith(
      'The document run is still going. Wait for it to end, or cancel it, before merging it.'
    )
    expect(useKanbanStore.getState().pendingDoneMove).toBeNull()
    expect(moveTicket).not.toHaveBeenCalled()
  })

  it('just moves the run ticket when no worktree is left to archive', async () => {
    worktrees = {}

    await dropRunTicketArchiveOverride(runTicket(), 'done')

    expect(useKanbanStore.getState().pendingDoneMove).toBeNull()
    expect(moveTicket).toHaveBeenLastCalledWith('run-ticket', 'proj', 'done', expect.any(Number), {
      interactive: true
    })
  })

  it('moves the ticket of a run whose record is gone', async () => {
    flowApi.get.mockResolvedValue(null)

    await dropRunTicketArchiveOverride(runTicket(), 'done')

    expect(moveTicket).toHaveBeenCalledWith('run-ticket', 'proj', 'done', expect.any(Number), {
      interactive: true
    })
  })

  it('does nothing for the column the ticket is in, a folded Merged card, or another ticket', async () => {
    await dropRunTicketArchiveOverride(runTicket('done'), 'done')
    await dropRunTicketArchiveOverride(runTicket('merged'), 'done')
    await dropRunTicketArchiveOverride(ticket('t-a', 'review'), 'done')

    expect(flowApi.get).not.toHaveBeenCalled()
    expect(useKanbanStore.getState().pendingDoneMove).toBeNull()
    expect(moveTicket).not.toHaveBeenCalled()
  })

  it('says so, and moves nothing, when the branches cannot be looked up', async () => {
    dbApiMocks.worktree.get.mockRejectedValue(new Error('db is locked'))

    await dropRunTicketArchiveOverride(runTicket(), 'done')

    expect(toastMocks.warning).toHaveBeenCalledWith(
      'Could not look up the branches of the run: db is locked'
    )
    expect(moveTicket).not.toHaveBeenCalled()
  })
})

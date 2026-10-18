/**
 * The merge-on-done queue of a document-run batch (shift-drop of the run's ticket): a
 * ticket branch is queued once to merge into the integration branch and again, at the tail,
 * to be archived; each finished entry moves its own ticket, the run's ticket moves last —
 * never past a branch that hit conflicts; a skipped branch is only named.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useKanbanStore, type PendingDoneMove } from './useKanbanStore'
import type { KanbanTicket } from '../../../main/db/types'

const toastMocks = vi.hoisted(() => ({
  warning: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn()
}))

vi.mock('@/lib/toast', () => ({ toast: toastMocks }))

const moveTicketMock = vi.fn().mockResolvedValue(undefined)

function ticket(id: string, column: KanbanTicket['column'], archived = false): KanbanTicket {
  return {
    id,
    project_id: 'proj',
    title: `Ticket ${id}`,
    column,
    sort_order: 0,
    archived_at: archived ? '2026-01-01T00:00:00.000Z' : null
  } as KanbanTicket
}

const childMerge: PendingDoneMove['entry'] = {
  worktreeId: 'wt-a',
  projectId: 'proj',
  kind: 'run-child',
  ticketId: 't-a',
  label: 'A1 · Alpha',
  runId: 'run-1',
  itemId: 'item-a',
  integrationBranch: 'doc-run',
  integrationWorktreeId: 'wt-int'
}
const integration = {
  worktreeId: 'wt-int',
  projectId: 'proj',
  kind: 'run-integration' as const,
  label: 'The run'
}
const archiveA = {
  worktreeId: 'wt-a',
  projectId: 'proj',
  kind: 'run-child-archive' as const,
  alreadyMerged: true,
  ticketId: 't-a',
  label: 'A1 · Alpha'
}
const archiveB = {
  worktreeId: 'wt-b',
  projectId: 'proj',
  kind: 'run-child-archive' as const,
  alreadyMerged: true,
  ticketId: 't-b',
  label: 'A2 · Beta'
}

function seed(overrides: Partial<PendingDoneMove> = {}): void {
  useKanbanStore.setState({
    moveTicket: moveTicketMock,
    tickets: new Map([
      [
        'proj',
        [
          ticket('run-ticket', 'review'),
          ticket('t-a', 'merged'),
          ticket('t-b', 'merged'),
          ticket('t-fix', 'review')
        ]
      ]
    ]),
    pendingDoneMove: {
      ticketId: 'run-ticket',
      projectId: 'proj',
      sortOrder: 5,
      targetColumn: 'done',
      worktreeId: 'wt-a',
      worktreeProjectId: 'proj',
      remainingWorktrees: [integration, archiveA, archiveB],
      offerArchive: true,
      entry: childMerge,
      run: { runId: 'run-1', title: 'The run', kept: [], alsoMoveTicketIds: ['t-fix'] },
      ...overrides
    }
  })
}

const pending = (): PendingDoneMove | null => useKanbanStore.getState().pendingDoneMove

describe('completeDoneMove — document-run batch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    moveTicketMock.mockResolvedValue(undefined)
    seed()
  })

  it('advances past a merge entry without moving its ticket (its archive twin does that)', async () => {
    expect(await useKanbanStore.getState().completeDoneMove()).toBe(true)

    expect(moveTicketMock).not.toHaveBeenCalled()
    expect(pending()?.worktreeId).toBe('wt-int')
    expect(pending()?.entry).toEqual(integration)
    expect(pending()?.run?.runId).toBe('run-1')
  })

  it('tells the two entries of one worktree apart by kind', async () => {
    const refused = await useKanbanStore.getState().completeDoneMove({
      ticketId: 'run-ticket',
      projectId: 'proj',
      worktreeId: 'wt-a',
      kind: 'run-child-archive'
    })
    expect(refused).toBe(false)
    expect(pending()?.worktreeId).toBe('wt-a')

    const accepted = await useKanbanStore.getState().completeDoneMove({
      ticketId: 'run-ticket',
      projectId: 'proj',
      worktreeId: 'wt-a',
      kind: 'run-child'
    })
    expect(accepted).toBe(true)
  })

  it('moves each archived branch’s ticket, the handled ones too, and the run’s ticket last', async () => {
    const store = useKanbanStore.getState()
    await store.completeDoneMove() // merge A1 → integration
    await store.completeDoneMove() // integration → archive A1
    expect(moveTicketMock).not.toHaveBeenCalled()

    // "Archive all" at A1's archive step handles A2 together with it
    await store.completeDoneMove(undefined, { handledWorktreeIds: new Set(['wt-b']) })

    expect(moveTicketMock.mock.calls).toEqual([
      ['t-a', 'proj', 'done', expect.any(Number), { skipCompletionEffects: true }],
      ['t-b', 'proj', 'done', expect.any(Number), { skipCompletionEffects: true }],
      ['t-fix', 'proj', 'done', expect.any(Number), { skipCompletionEffects: true }],
      ['run-ticket', 'proj', 'done', 5]
    ])
    expect(pending()).toBeNull()
  })

  it('leaves tickets that are archived or already in the target column alone', async () => {
    seed({ worktreeId: 'wt-a', entry: archiveA, remainingWorktrees: [archiveB] })
    useKanbanStore.setState({
      tickets: new Map([
        ['proj', [ticket('run-ticket', 'review'), ticket('t-a', 'done'), ticket('t-b', 'merged', true)]]
      ])
    })

    await useKanbanStore.getState().completeDoneMove(undefined, {
      handledWorktreeIds: new Set(['wt-b'])
    })

    expect(moveTicketMock).toHaveBeenCalledExactlyOnceWith('run-ticket', 'proj', 'done', 5)
  })

  it('skipping a merge entry drops its archive twin; its ticket stays, the run’s ticket still moves', async () => {
    const store = useKanbanStore.getState()
    await store.skipDoneMoveEntry(undefined, 'skipped')

    expect(pending()?.worktreeId).toBe('wt-int')
    expect(pending()?.remainingWorktrees).toEqual([archiveB])
    expect(pending()?.keptWorktrees).toEqual([
      { label: 'A1 · Alpha', reason: 'skipped', worktreeId: 'wt-a' }
    ])

    await store.completeDoneMove() // integration → archive B
    await store.completeDoneMove() // archive B → end

    expect(moveTicketMock.mock.calls).toEqual([
      ['t-b', 'proj', 'done', expect.any(Number), { skipCompletionEffects: true }],
      ['t-fix', 'proj', 'done', expect.any(Number), { skipCompletionEffects: true }],
      ['run-ticket', 'proj', 'done', 5]
    ])
    expect(pending()).toBeNull()
    expect(toastMocks.warning).toHaveBeenCalledWith(expect.stringContaining('A1 · Alpha (skipped)'))
  })

  it('a conflicted merge entry drops its archive twin too and blocks the run’s ticket', async () => {
    const store = useKanbanStore.getState()
    store.continueDoneMoveAfterConflict()

    expect(pending()?.worktreeId).toBe('wt-int')
    expect(pending()?.remainingWorktrees).toEqual([archiveB])

    await store.completeDoneMove()
    await store.completeDoneMove()

    expect(moveTicketMock).not.toHaveBeenCalledWith('run-ticket', 'proj', 'done', 5)
    expect(toastMocks.warning).toHaveBeenCalledWith(expect.stringContaining('1 branch'))
  })

  it('skipping the last entry ends the queue: the skipped ticket stays, the rest move', async () => {
    seed({ worktreeId: 'wt-b', entry: archiveB, remainingWorktrees: [] })

    await useKanbanStore.getState().skipDoneMoveEntry(undefined, 'has new changes since the run')

    expect(pending()).toBeNull()
    expect(moveTicketMock.mock.calls).toEqual([
      ['t-fix', 'proj', 'done', expect.any(Number), { skipCompletionEffects: true }],
      ['run-ticket', 'proj', 'done', 5]
    ])
    expect(toastMocks.warning).toHaveBeenCalledWith(
      expect.stringContaining('A2 · Beta (has new changes since the run)')
    )
  })

  it('a skipped last entry never moves the run’s ticket past conflicts', async () => {
    seed({
      worktreeId: 'wt-b',
      entry: archiveB,
      remainingWorktrees: [],
      conflictedWorktrees: [{ worktreeId: 'wt-a', projectId: 'proj' }]
    })

    await useKanbanStore.getState().skipDoneMoveEntry(undefined, 'skipped')

    expect(pending()).toBeNull()
    expect(moveTicketMock).not.toHaveBeenCalled()
    expect(toastMocks.warning).toHaveBeenCalledWith(expect.stringContaining('1 branch'))
  })
})

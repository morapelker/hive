import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KanbanTicket } from '../../../main/db/types'
import { makeDetail } from '@/components/document-flow/test-fixtures'
import type { DocumentRunItem, DocumentRunStatus } from '@shared/types/document-flow'
import { notifyKanbanNewSession } from './store-coordination'
import { useDocumentFlowStore } from './useDocumentFlowStore'
import { ticketKey, useKanbanStore } from './useKanbanStore'
import { useSettingsStore } from './useSettingsStore'

// Where the board and an orchestrator (a run made from board tickets) meet in the kanban store.
// A ticket queued outside the run on one of the run's tickets cuts from base, so it fires when
// the run's own ticket lands there, not when its blocker reaches the integration branch. And a
// new session does not attach to a ticket the run is holding for its own launch.

const { autoLaunchTicket } = vi.hoisted(() => ({
  autoLaunchTicket: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('../lib/auto-launch', () => ({ autoLaunchTicket }))

vi.mock('@/api/kanban-api', () => ({
  kanbanApi: {
    ticket: {
      move: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(null),
      getBySession: vi.fn().mockResolvedValue([])
    }
  }
}))

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

const PROJECT_ID = 'project-1'
const RUN_ID = 'run-1'
const RUN_TICKET = 'run-ticket'
const WORKTREE = 'wt-pre-assigned'

const initialKanbanState = useKanbanStore.getState()
const initialFlowState = useDocumentFlowStore.getState()
const initialTrigger = useSettingsStore.getState().followUpTriggerColumn

function ticket(id: string, overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id,
    project_id: PROJECT_ID,
    title: `Ticket ${id}`,
    column: 'todo',
    sort_order: 0,
    current_session_id: null,
    worktree_id: null,
    mode: null,
    archived_at: null,
    external_provider: null,
    external_id: null,
    pending_launch_config: null,
    ...overrides
  } as KanbanTicket
}

/** "Save & Queue": it sits In Progress with its launch waiting, and no session. */
const queued = (id: string): KanbanTicket =>
  ticket(id, { column: 'in_progress', pending_launch_config: '{"mode":"build"}' })

/** A ticket the run merged: in Merged, while its work is only on the integration branch. */
const merged = (id: string): KanbanTicket => ticket(id, { column: 'merged' })

const runTicket = (overrides: Partial<KanbanTicket> = {}): KanbanTicket =>
  ticket(RUN_TICKET, {
    column: 'review',
    external_provider: 'document-run',
    external_id: RUN_ID,
    ...overrides
  })

function seedBoard(
  tickets: readonly KanbanTicket[],
  dependencies: Record<string, readonly string[]> = {}
): void {
  useKanbanStore.setState({
    tickets: new Map([[PROJECT_ID, [...tickets]]]),
    dependencyMap: new Map(
      Object.entries(dependencies).map(([dependent, blockers]) => [
        ticketKey(PROJECT_ID, dependent),
        new Set(blockers.map((blocker) => ticketKey(PROJECT_ID, blocker)))
      ])
    )
  })
}

function seedRun(
  items: Partial<DocumentRunItem>[],
  source_kind: 'tickets' | 'document' = 'tickets',
  status: DocumentRunStatus = 'completed'
): void {
  useDocumentFlowStore.setState({
    runsById: {
      [RUN_ID]: makeDetail(
        { id: RUN_ID, project_id: PROJECT_ID, source_kind, status, ticket_id: RUN_TICKET },
        items
      )
    }
  })
}

const mergedItem = (key: string, ticketId: string): Partial<DocumentRunItem> => ({
  key,
  ticket_id: ticketId,
  status: 'merged'
})

const move = (
  ticketId: string,
  column: KanbanTicket['column'],
  opts?: { skipCompletionEffects?: boolean }
): Promise<void> => useKanbanStore.getState().moveTicket(ticketId, PROJECT_ID, column, 0, opts)

// The launch itself runs behind two dynamic imports.
const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const launchedIds = (): string[] => autoLaunchTicket.mock.calls.map(([launched]) => launched.id)

beforeEach(() => {
  autoLaunchTicket.mockClear()
})

afterEach(() => {
  useKanbanStore.setState(initialKanbanState, true)
  useDocumentFlowStore.setState(initialFlowState, true)
  useSettingsStore.setState({ followUpTriggerColumn: initialTrigger })
})

describe('a queued ticket outside an orchestrator, blocked on a ticket the run adopted', () => {
  it.each(['done', 'merged'] as const)(
    'launches when the run’s own ticket moves to %s, its blocker’s work reaching base with it',
    async (column) => {
      seedBoard([runTicket(), merged('x'), queued('y')], { y: ['x'] })
      seedRun([mergedItem('TD-1', 'x')])

      await move(RUN_TICKET, column)
      await flush()

      expect(launchedIds()).toEqual(['y'])
    }
  )

  it('stays queued when its blocker merges, as that only reaches the integration branch', async () => {
    seedBoard(
      [runTicket({ column: 'in_progress' }), ticket('x', { column: 'review' }), queued('y')],
      {
        y: ['x']
      }
    )
    seedRun([{ key: 'TD-1', ticket_id: 'x', status: 'merging' }], 'tickets', 'running')

    // What the runner's `markMerged` does.
    await move('x', 'merged', { skipCompletionEffects: true })
    await flush()

    expect(autoLaunchTicket).not.toHaveBeenCalled()
  })

  it('launches once, though it waits on several of the run’s tickets', async () => {
    seedBoard([runTicket(), merged('x1'), merged('x2'), queued('y')], { y: ['x1', 'x2'] })
    seedRun([mergedItem('TD-1', 'x1'), mergedItem('TD-2', 'x2')])

    await move(RUN_TICKET, 'done')
    await flush()

    expect(launchedIds()).toEqual(['y'])
  })

  it('keeps waiting on a blocker that has not landed', async () => {
    seedBoard([runTicket(), merged('x'), ticket('z', { column: 'in_progress' }), queued('y')], {
      y: ['x', 'z']
    })
    seedRun([mergedItem('TD-1', 'x')])

    await move(RUN_TICKET, 'done')
    await flush()

    expect(autoLaunchTicket).not.toHaveBeenCalled()
  })

  it('keeps waiting on a merged ticket the user took back up', async () => {
    seedBoard([runTicket(), ticket('x', { column: 'in_progress' }), queued('y')], { y: ['x'] })
    seedRun([mergedItem('TD-1', 'x')])

    await move(RUN_TICKET, 'done')
    await flush()

    expect(autoLaunchTicket).not.toHaveBeenCalled()
  })

  it('fires for a skipped item that rode to Done with the run, whose move skipped the effects', async () => {
    seedBoard([runTicket(), ticket('skipped', { column: 'done' }), queued('y')], {
      y: ['skipped']
    })
    seedRun([{ key: 'TD-1', ticket_id: 'skipped', status: 'skipped' }])

    await move(RUN_TICKET, 'done')
    await flush()

    expect(autoLaunchTicket).toHaveBeenCalledTimes(1)
  })

  it('leaves what waits on an item still short of Done, or not part of the run', async () => {
    seedBoard(
      [
        runTicket(),
        ticket('skipped', { column: 'review' }),
        ticket('left-out', { column: 'done' }),
        queued('y1'),
        queued('y2')
      ],
      { y1: ['skipped'], y2: ['left-out'] }
    )
    seedRun([
      { key: 'TD-1', ticket_id: 'skipped', status: 'skipped' },
      { key: 'TD-2', ticket_id: 'left-out', status: 'merged', selected: false }
    ])

    await move(RUN_TICKET, 'done')
    await flush()

    expect(autoLaunchTicket).not.toHaveBeenCalled()
  })

  it('does not fire on a move of the run’s ticket that skips the completion effects', async () => {
    seedBoard([runTicket(), merged('x'), queued('y')], { y: ['x'] })
    seedRun([mergedItem('TD-1', 'x')])

    await move(RUN_TICKET, 'done', { skipCompletionEffects: true })
    await flush()

    expect(autoLaunchTicket).not.toHaveBeenCalled()
  })

  it('does not fire when the run’s ticket reaches Review, under the review trigger', async () => {
    useSettingsStore.setState({ followUpTriggerColumn: 'review' })
    seedBoard([runTicket({ column: 'in_progress', mode: 'build' }), merged('x'), queued('y')], {
      y: ['x']
    })
    seedRun([mergedItem('TD-1', 'x')])

    await move(RUN_TICKET, 'review')
    await flush()

    expect(autoLaunchTicket).not.toHaveBeenCalled()
  })

  describe('through the merge-on-done queue', () => {
    it('fires on the last move of the shift-drop batch, not with the tickets that ride along', async () => {
      seedBoard([runTicket(), ticket('x', { column: 'review' }), queued('y')], { y: ['x'] })
      seedRun([mergedItem('TD-1', 'x')])
      const integration = {
        worktreeId: 'wt-int',
        projectId: PROJECT_ID,
        kind: 'run-integration' as const,
        label: 'The run'
      }
      const archive = {
        worktreeId: 'wt-x',
        projectId: PROJECT_ID,
        kind: 'run-child-archive' as const,
        alreadyMerged: true,
        ticketId: 'x',
        label: 'TD-1'
      }
      useKanbanStore.setState({
        pendingDoneMove: {
          ticketId: RUN_TICKET,
          projectId: PROJECT_ID,
          sortOrder: 0,
          targetColumn: 'done',
          worktreeId: integration.worktreeId,
          worktreeProjectId: PROJECT_ID,
          remainingWorktrees: [archive],
          offerArchive: true,
          entry: integration,
          run: { runId: RUN_ID, title: 'Run', kept: [], alsoMoveTicketIds: [] }
        }
      })

      // The integration branch landed on base; the archive turn is still to come.
      await useKanbanStore.getState().completeDoneMove()
      await flush()
      expect(autoLaunchTicket).not.toHaveBeenCalled()

      await useKanbanStore.getState().completeDoneMove()
      await flush()

      expect(launchedIds()).toEqual(['y'])
    })

    it('fires once every member of a connection run has landed', async () => {
      seedBoard([runTicket(), merged('x'), queued('y')], { y: ['x'] })
      seedRun([mergedItem('TD-1', 'x')])
      useKanbanStore.setState({
        pendingDoneMove: {
          ticketId: RUN_TICKET,
          projectId: PROJECT_ID,
          sortOrder: 0,
          targetColumn: 'merged',
          worktreeId: 'wt-member-a',
          worktreeProjectId: 'member-a',
          remainingWorktrees: [{ worktreeId: 'wt-member-b', projectId: 'member-b' }],
          offerArchive: true
        }
      })

      await useKanbanStore.getState().completeDoneMove()
      await flush()
      expect(autoLaunchTicket).not.toHaveBeenCalled()

      await useKanbanStore.getState().completeDoneMove()
      await flush()

      expect(launchedIds()).toEqual(['y'])
    })

    it('does not fire when a merge hit conflicts, as the run’s ticket does not move', async () => {
      seedBoard([runTicket(), merged('x'), queued('y')], { y: ['x'] })
      seedRun([mergedItem('TD-1', 'x')])
      useKanbanStore.setState({
        pendingDoneMove: {
          ticketId: RUN_TICKET,
          projectId: PROJECT_ID,
          sortOrder: 0,
          targetColumn: 'done',
          worktreeId: 'wt-member-a',
          worktreeProjectId: 'member-a',
          remainingWorktrees: [{ worktreeId: 'wt-member-b', projectId: 'member-b' }],
          offerArchive: true,
          conflictedWorktrees: [{ worktreeId: 'wt-member-a', projectId: 'member-a' }]
        }
      })

      await useKanbanStore.getState().completeDoneMove()
      await useKanbanStore.getState().completeDoneMove()
      await flush()

      expect(autoLaunchTicket).not.toHaveBeenCalled()
    })
  })
})

describe('the board’s own dependent launch', () => {
  it('launches what waits on a moved ticket once all its blockers are satisfied', async () => {
    seedBoard([ticket('x', { column: 'review' }), ticket('z', { column: 'done' }), queued('y')], {
      y: ['x', 'z']
    })

    await move('x', 'done')
    await flush()

    expect(launchedIds()).toEqual(['y'])
  })

  it('leaves a dependent with nothing queued alone', async () => {
    seedBoard([ticket('x', { column: 'review' }), ticket('y', { column: 'todo' })], { y: ['x'] })

    await move('x', 'merged')
    await flush()

    expect(autoLaunchTicket).not.toHaveBeenCalled()
  })

  it('waits for a blocker still open, and skips with the completion effects', async () => {
    seedBoard([ticket('x', { column: 'review' }), ticket('z'), queued('y1'), queued('y2')], {
      y1: ['x', 'z'],
      y2: ['x']
    })

    await move('x', 'done', { skipCompletionEffects: true })
    await flush()
    expect(autoLaunchTicket).not.toHaveBeenCalled()

    await move('x', 'done')
    await flush()
    expect(launchedIds()).toEqual(['y2'])
  })

  it('fires at Review under the review trigger, for a build ticket only', async () => {
    useSettingsStore.setState({ followUpTriggerColumn: 'review' })
    seedBoard(
      [
        ticket('built', { column: 'in_progress', mode: 'build' }),
        ticket('planned', { column: 'in_progress', mode: 'plan' }),
        queued('y1'),
        queued('y2')
      ],
      { y1: ['built'], y2: ['planned'] }
    )

    await move('planned', 'review')
    await flush()
    expect(autoLaunchTicket).not.toHaveBeenCalled()

    await move('built', 'review')
    await flush()
    expect(launchedIds()).toEqual(['y1'])
  })

  it('launches what waits on the ticket of a run itself, whichever kind of run', async () => {
    seedBoard([runTicket(), queued('y')], { y: [RUN_TICKET] })
    seedRun([], 'document')

    await move(RUN_TICKET, 'done')
    await flush()

    expect(launchedIds()).toEqual(['y'])
  })

  it('does nothing new when the ticket of a document run lands', async () => {
    // A ticket queued on one of its tasks stays as it always did, until that task moves itself.
    seedBoard([runTicket(), merged('x'), queued('y')], { y: ['x'] })
    seedRun([mergedItem('A1', 'x')], 'document')

    await move(RUN_TICKET, 'done')
    await flush()

    expect(autoLaunchTicket).not.toHaveBeenCalled()
  })

  it('does nothing when the run’s record is gone, its ticket only moving', async () => {
    seedBoard([runTicket(), merged('x'), queued('y')], { y: ['x'] })

    await move(RUN_TICKET, 'done')
    await flush()

    expect(autoLaunchTicket).not.toHaveBeenCalled()
    expect(useKanbanStore.getState().tickets.get(PROJECT_ID)?.[0].column).toBe('done')
  })
})

describe('a new session in a worktree a ticket was pre-assigned to', () => {
  const preAssigned = (id: string): KanbanTicket => ticket(id, { worktree_id: WORKTREE })

  const attachedSession = (id: string): string | null | undefined =>
    useKanbanStore
      .getState()
      .tickets.get(PROJECT_ID)
      ?.find((candidate) => candidate.id === id)?.current_session_id

  it.each(['preview', 'running', 'paused'] as const)(
    'leaves a ticket waiting for its launch alone, with the run %s',
    (status) => {
      seedBoard([preAssigned('t')])
      seedRun([{ key: 'TD-1', ticket_id: 't', status: 'pending' }], 'tickets', status)

      notifyKanbanNewSession('session-user', WORKTREE, PROJECT_ID, 'build')

      expect(attachedSession('t')).toBeNull()
      expect(useKanbanStore.getState().tickets.get(PROJECT_ID)?.[0].column).toBe('todo')
    }
  )

  it('leaves a ticket the run is launching this moment alone', () => {
    seedBoard([preAssigned('t')])
    seedRun([{ key: 'TD-1', ticket_id: 't', status: 'launching' }], 'tickets', 'running')

    notifyKanbanNewSession('session-user', WORKTREE, PROJECT_ID, 'build')

    expect(attachedSession('t')).toBeNull()
  })

  it('attaches to the next ticket pre-assigned there that no run holds', () => {
    seedBoard([preAssigned('held'), preAssigned('free')])
    seedRun([{ key: 'TD-1', ticket_id: 'held', status: 'pending' }], 'tickets', 'running')

    notifyKanbanNewSession('session-user', WORKTREE, PROJECT_ID, 'build')

    expect(attachedSession('held')).toBeNull()
    expect(attachedSession('free')).toBe('session-user')
  })

  it('attaches as ever to a ticket no run holds', () => {
    seedBoard([preAssigned('t')])

    notifyKanbanNewSession('session-user', WORKTREE, PROJECT_ID, 'plan')

    expect(useKanbanStore.getState().tickets.get(PROJECT_ID)?.[0]).toMatchObject({
      current_session_id: 'session-user',
      column: 'in_progress',
      mode: 'plan'
    })
  })

  it('attaches to a document run’s task ticket as it always did', () => {
    seedBoard([preAssigned('t')])
    seedRun([{ key: 'A1', ticket_id: 't', status: 'pending' }], 'document', 'running')

    notifyKanbanNewSession('session-user', WORKTREE, PROJECT_ID, 'build')

    expect(attachedSession('t')).toBe('session-user')
  })

  it('attaches to the ticket of a run that is over', () => {
    seedBoard([preAssigned('t')])
    seedRun([{ key: 'TD-1', ticket_id: 't', status: 'pending' }], 'tickets', 'cancelled')

    notifyKanbanNewSession('session-user', WORKTREE, PROJECT_ID, 'build')

    expect(attachedSession('t')).toBe('session-user')
  })
})

// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentRunReport, DocumentRunStatus } from '@shared/types/document-flow'
import { getRpcRequestContext, rpcRequestContext } from '../../../server/rpc/request-context'
import type { KanbanTicketColumn } from '../../db/types'

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import { TEST_PROJECT_ID, createServiceHarness, seedRun, type ServiceHarness } from './test-support'

// The session that executes a finished run's migrations: recorded on the run, holding the
// run's board ticket In Progress while it is, and what ends it (its turn, the user, the app).

const STARTED_AT = '2026-10-05T10:00:00.000Z'
const BEFORE_START = '2026-10-05T09:00:00.000Z'
const AFTER_START = '2026-10-05T11:00:00.000Z'

// Several app instances can share one database: this one, and another.
const APP_PID = 4321
const OTHER_APP_PID = 8765

const REPORT: DocumentRunReport = {
  generatedAt: '2026-10-05T09:30:00.000Z',
  integrationBranch: 'doc-factory',
  integrationWorktreePath: '/worktrees/doc-factory',
  baseBranch: 'main',
  baseSha: 'aaa111',
  headSha: 'bbb222',
  baseMoved: false,
  merged: [{ key: 'A1', title: 'Task 1', mergeSha: 'ccc333', summary: null }],
  unmerged: [],
  migrations: ['db/migrations/002_ramp_up.sql'],
  manualSteps: [],
  stats: { filesChanged: 3, insertions: 40, deletions: 2, commits: 2 },
  verify: null
}

let harness: ServiceHarness

beforeEach(() => {
  harness = createServiceHarness()
  harness.worktrees.set('wt-integration', {
    id: 'wt-integration',
    path: '/worktrees/doc-factory',
    branch_name: 'doc-factory',
    status: 'active',
    base_branch: 'main'
  })
  harness.overrides.now = () => new Date(STARTED_AT)
})

afterEach(() => {
  harness.cleanup()
})

/**
 * A run on the integration worktree, finished with a report unless told otherwise; with
 * `ticket`, its board ticket in that column. `session` records a migration session on it,
 * owned by no app instance unless it names one.
 */
function seedFinished(
  options: {
    status?: DocumentRunStatus
    report?: DocumentRunReport | null
    ticket?: KanbanTicketColumn | null
    session?: { id: string; startedAt: string | null; ownerPid?: number | null }
  } = {}
): string {
  const { status = 'completed', report = REPORT, ticket = 'review', session } = options
  const { run } = seedRun(harness, {
    run: {
      status,
      report,
      base_branch: 'main',
      base_sha: 'aaa111',
      integration_branch: 'doc-factory',
      integration_worktree_id: 'wt-integration',
      integration_worktree_path: '/worktrees/doc-factory',
      started_at: '2026-10-05T08:00:00.000Z',
      finished_at: '2026-10-05T09:30:00.000Z',
      ...(session
        ? {
            migration_session_id: session.id,
            migration_started_at: session.startedAt,
            migration_owner_pid: session.ownerPid ?? null
          }
        : {})
    },
    items: [{ key: 'A1', status: 'merged' }]
  })
  if (ticket) {
    const id = `run-ticket-${run.id}`
    harness.boardTickets.set(id, { id, projectId: TEST_PROJECT_ID, column: ticket })
    harness.db.updateDocumentRun(run.id, { ticket_id: id })
  }
  return run.id
}

const ticketOf = (runId: string): string => `run-ticket-${runId}`
const columnOf = (runId: string): string | undefined =>
  harness.boardTickets.get(ticketOf(runId))?.column
const sessionOf = (
  runId: string
): { id: string | null; startedAt: string | null; ownerPid: number | null } => {
  const run = harness.db.getDocumentRun(runId)
  if (!run) throw new Error(`no run ${runId}`)
  return {
    id: run.migration_session_id,
    startedAt: run.migration_started_at,
    ownerPid: run.migration_owner_pid
  }
}
const eventTypes = (runId: string): string[] =>
  harness.db.listDocumentRunEvents(runId).map((event) => event.type)

describe('startMigrations', () => {
  it('records the session on a finished run and takes its ticket back to In Progress', async () => {
    const runId = seedFinished()

    const detail = await harness.service.startMigrations(runId, 'session-1')

    expect(detail.run).toMatchObject({
      id: runId,
      status: 'completed',
      migration_session_id: 'session-1',
      migration_started_at: STARTED_AT
    })
    expect(sessionOf(runId)).toEqual({ id: 'session-1', startedAt: STARTED_AT, ownerPid: null })
    expect(detail.items.map((item) => item.key)).toEqual(['A1'])
    expect(detail.events).toEqual([
      expect.objectContaining({
        run_id: runId,
        item_id: null,
        type: 'migrations_started',
        data: { sessionId: 'session-1' }
      })
    ])
    expect(harness.published).toEqual([
      { runId, projectId: TEST_PROJECT_ID, reason: 'run' },
      { runId, projectId: TEST_PROJECT_ID, reason: 'event' }
    ])
    expect(harness.ticketMoves).toEqual([
      { projectId: TEST_PROJECT_ID, ticketId: ticketOf(runId), column: 'in_progress' }
    ])
    expect(columnOf(runId)).toBe('in_progress')
  })

  it('records which app instance the session belongs to', async () => {
    harness.overrides.getAppPid = () => APP_PID
    const runId = seedFinished()

    const detail = await harness.service.startMigrations(runId, 'session-1')

    expect(detail.run).toMatchObject({
      migration_session_id: 'session-1',
      migration_started_at: STARTED_AT,
      migration_owner_pid: APP_PID
    })
    expect(sessionOf(runId)).toEqual({ id: 'session-1', startedAt: STARTED_AT, ownerPid: APP_PID })
  })

  it('records no owner when nothing says which process the app is', async () => {
    // The harness gives the service no `getAppPid` unless a test supplies one.
    const bare = seedFinished()
    const detail = await harness.service.startMigrations(bare, 'session-1')
    expect(detail.run.migration_owner_pid).toBeNull()
    expect(sessionOf(bare)).toEqual({ id: 'session-1', startedAt: STARTED_AT, ownerPid: null })

    // Nor did the main process hand its id over.
    harness.overrides.getAppPid = () => null
    const unknown = seedFinished()
    await harness.service.startMigrations(unknown, 'session-2')
    expect(sessionOf(unknown)).toEqual({ id: 'session-2', startedAt: STARTED_AT, ownerPid: null })
  })

  it.each<DocumentRunStatus>(['completed', 'completed_with_issues', 'cancelled'])(
    'accepts a %s run that has a report',
    async (status) => {
      const runId = seedFinished({ status })

      await harness.service.startMigrations(runId, 'session-1')

      expect(sessionOf(runId).id).toBe('session-1')
      // The run itself is as finished as it was.
      expect(harness.db.getDocumentRun(runId)?.status).toBe(status)
      expect(columnOf(runId)).toBe('in_progress')
    }
  )

  it.each(['in_progress', 'done', 'merged'] as const)(
    'leaves a ticket the user already moved to %s where it is',
    async (column) => {
      const runId = seedFinished({ ticket: column })

      await harness.service.startMigrations(runId, 'session-1')

      expect(sessionOf(runId).id).toBe('session-1')
      expect(harness.ticketMoves).toEqual([])
      expect(columnOf(runId)).toBe(column)
    }
  )

  it('records the session of a run without a ticket, or whose ticket is gone', async () => {
    const bare = seedFinished({ ticket: null })
    const gone = seedFinished()
    harness.boardTickets.delete(ticketOf(gone))

    await harness.service.startMigrations(bare, 'session-1')
    await harness.service.startMigrations(gone, 'session-2')

    expect(sessionOf(bare).id).toBe('session-1')
    expect(sessionOf(gone).id).toBe('session-2')
    expect(harness.ticketMoves).toEqual([])
  })

  it.each<DocumentRunStatus>(['extracting', 'extract_failed', 'preview', 'running', 'paused'])(
    'refuses a run that is %s',
    async (status) => {
      // Even with a report: only the status says the run is over.
      const runId = seedFinished({ status, ticket: 'in_progress' })

      await expect(harness.service.startMigrations(runId, 'session-1')).rejects.toMatchObject({
        code: 'INVALID_STATE',
        message: 'Only a run that has finished has migrations to execute.'
      })

      expect(sessionOf(runId)).toEqual({ id: null, startedAt: null, ownerPid: null })
      expect(eventTypes(runId)).toEqual([])
      expect(harness.published).toEqual([])
      expect(harness.ticketMoves).toEqual([])
    }
  )

  it.each<DocumentRunStatus>(['cancelled', 'completed'])(
    'refuses a %s run that has no report',
    async (status) => {
      const runId = seedFinished({ status, report: null })

      await expect(harness.service.startMigrations(runId, 'session-1')).rejects.toMatchObject({
        code: 'INVALID_STATE',
        message: 'Only a run that has finished has migrations to execute.'
      })

      expect(sessionOf(runId)).toEqual({ id: null, startedAt: null, ownerPid: null })
      expect(harness.ticketMoves).toEqual([])
      expect(columnOf(runId)).toBe('review')
    }
  )

  it('refuses a second session while one is executing them', async () => {
    const runId = seedFinished()
    await harness.service.startMigrations(runId, 'session-1')
    const published = harness.published.length
    harness.overrides.now = () => new Date(AFTER_START)

    await expect(harness.service.startMigrations(runId, 'session-2')).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message: 'The migrations of this run are already being executed.'
    })

    expect(sessionOf(runId)).toEqual({ id: 'session-1', startedAt: STARTED_AT, ownerPid: null })
    expect(eventTypes(runId)).toEqual(['migrations_started'])
    expect(harness.published).toHaveLength(published)
    expect(harness.ticketMoves).toHaveLength(1)
  })

  it('changes nothing when the same session is recorded again', async () => {
    const runId = seedFinished()
    const first = await harness.service.startMigrations(runId, 'session-1')
    const published = harness.published.length
    // The user dragged the ticket back meanwhile: a repeated call is not a reason to move it.
    harness.boardTickets.get(ticketOf(runId))!.column = 'review'
    harness.overrides.now = () => new Date(AFTER_START)

    const second = await harness.service.startMigrations(runId, 'session-1')

    expect(second.run).toEqual(first.run)
    expect(sessionOf(runId)).toEqual({ id: 'session-1', startedAt: STARTED_AT, ownerPid: null })
    expect(eventTypes(runId)).toEqual(['migrations_started'])
    expect(harness.published).toHaveLength(published)
    expect(harness.ticketMoves).toHaveLength(1)
    expect(columnOf(runId)).toBe('review')
  })

  it('rejects a run that does not exist', async () => {
    await expect(harness.service.startMigrations('no-such-run', 'session-1')).rejects.toMatchObject(
      { code: 'NOT_FOUND' }
    )
  })

  it('moves the ticket outside the calling request, so the caller’s board reloads too', async () => {
    const runId = seedFinished()
    const contexts: unknown[] = []
    harness.overrides.detach = (task) => rpcRequestContext.exit(task)
    harness.overrides.moveTicket = async () => {
      contexts.push(getRpcRequestContext())
    }

    await rpcRequestContext.run({ clientId: 'client-1', principal: null }, () =>
      harness.service.startMigrations(runId, 'session-1')
    )

    expect(contexts).toEqual([undefined])
  })

  it('records the session of a run whose ticket cannot be read or moved', async () => {
    const stuck = seedFinished()
    harness.overrides.moveTicket = async () => {
      throw new Error('database is locked')
    }
    const detail = await harness.service.startMigrations(stuck, 'session-1')
    expect(detail.run.migration_session_id).toBe('session-1')
    expect(sessionOf(stuck)).toEqual({ id: 'session-1', startedAt: STARTED_AT, ownerPid: null })
    expect(columnOf(stuck)).toBe('review')

    const unreadable = seedFinished()
    harness.overrides.getTicket = async () => {
      throw new Error('The card file is gone')
    }
    await expect(harness.service.startMigrations(unreadable, 'session-2')).resolves.toMatchObject({
      run: { migration_session_id: 'session-2' }
    })
    expect(eventTypes(unreadable)).toEqual(['migrations_started'])
  })
})

describe('endMigrations', () => {
  it.each([
    ['finished', 'migrations_finished'],
    ['stopped', 'migrations_stopped']
  ] as const)(
    'clears a session that %s, logs %s and returns the ticket to Review',
    async (outcome, type) => {
      const runId = seedFinished()
      await harness.service.startMigrations(runId, 'session-1')
      harness.published.length = 0

      const detail = await harness.service.endMigrations(runId, 'session-1', outcome)

      expect(detail.run).toMatchObject({
        status: 'completed',
        migration_session_id: null,
        migration_started_at: null,
        migration_owner_pid: null
      })
      expect(sessionOf(runId)).toEqual({ id: null, startedAt: null, ownerPid: null })
      expect(detail.events.map((event) => event.type)).toEqual(['migrations_started', type])
      expect(harness.published).toEqual([
        { runId, projectId: TEST_PROJECT_ID, reason: 'run' },
        { runId, projectId: TEST_PROJECT_ID, reason: 'event' }
      ])
      expect(harness.ticketMoves).toEqual([
        { projectId: TEST_PROJECT_ID, ticketId: ticketOf(runId), column: 'in_progress' },
        { projectId: TEST_PROJECT_ID, ticketId: ticketOf(runId), column: 'review' }
      ])
      expect(columnOf(runId)).toBe('review')
    }
  )

  it.each(['finished', 'stopped'] as const)(
    'forgets the app instance along with a session that %s',
    async (outcome) => {
      harness.overrides.getAppPid = () => APP_PID
      const runId = seedFinished()
      await harness.service.startMigrations(runId, 'session-1')
      expect(sessionOf(runId).ownerPid).toBe(APP_PID)

      const detail = await harness.service.endMigrations(runId, 'session-1', outcome)

      expect(detail.run).toMatchObject({
        migration_session_id: null,
        migration_started_at: null,
        migration_owner_pid: null
      })
      expect(sessionOf(runId)).toEqual({ id: null, startedAt: null, ownerPid: null })
    }
  )

  it('leaves the ticket in Review when the session ended before the ticket was taken back', async () => {
    const runId = seedFinished()

    // Stopped at once: the move to In Progress has not had its turn yet.
    const starting = harness.service.startMigrations(runId, 'session-1')
    const ending = harness.service.endMigrations(runId, 'session-1', 'stopped')
    await Promise.all([starting, ending])

    expect(sessionOf(runId)).toEqual({ id: null, startedAt: null, ownerPid: null })
    expect(eventTypes(runId)).toEqual(['migrations_started', 'migrations_stopped'])
    expect(harness.ticketMoves).toEqual([])
    expect(columnOf(runId)).toBe('review')
  })

  it.each(['finished', 'stopped'] as const)(
    'does nothing for a session that is not the run’s (%s)',
    async (outcome) => {
      const runId = seedFinished()
      await harness.service.startMigrations(runId, 'session-1')
      const before = harness.db.getDocumentRun(runId)
      harness.published.length = 0

      const detail = await harness.service.endMigrations(runId, 'session-stale', outcome)

      expect(detail.run).toEqual(before)
      expect(harness.db.getDocumentRun(runId)).toEqual(before)
      expect(eventTypes(runId)).toEqual(['migrations_started'])
      expect(harness.published).toEqual([])
      expect(harness.ticketMoves).toHaveLength(1)
      expect(columnOf(runId)).toBe('in_progress')
    }
  )

  it('does nothing the second time, or when no session was ever recorded', async () => {
    const runId = seedFinished()
    await harness.service.startMigrations(runId, 'session-1')
    await harness.service.endMigrations(runId, 'session-1', 'stopped')
    harness.published.length = 0
    // Back In Progress for a reason of the user's own: a repeated end must not undo it.
    harness.boardTickets.get(ticketOf(runId))!.column = 'in_progress'

    await harness.service.endMigrations(runId, 'session-1', 'finished')

    expect(eventTypes(runId)).toEqual(['migrations_started', 'migrations_stopped'])
    expect(harness.published).toEqual([])
    expect(columnOf(runId)).toBe('in_progress')

    const untouched = seedFinished({ ticket: 'in_progress' })
    const detail = await harness.service.endMigrations(untouched, 'session-1', 'finished')
    expect(detail.run.id).toBe(untouched)
    expect(eventTypes(untouched)).toEqual([])
    expect(harness.published).toEqual([])
    expect(columnOf(untouched)).toBe('in_progress')
  })

  it('cannot end a session that was started since', async () => {
    const runId = seedFinished()
    await harness.service.startMigrations(runId, 'session-1')
    await harness.service.endMigrations(runId, 'session-1', 'stopped')
    harness.overrides.now = () => new Date(AFTER_START)
    await harness.service.startMigrations(runId, 'session-2')

    // The watcher of the first session reports its end late.
    await harness.service.endMigrations(runId, 'session-1', 'finished')

    expect(sessionOf(runId)).toEqual({ id: 'session-2', startedAt: AFTER_START, ownerPid: null })
    expect(eventTypes(runId)).toEqual([
      'migrations_started',
      'migrations_stopped',
      'migrations_started'
    ])
    expect(columnOf(runId)).toBe('in_progress')
  })

  it.each(['done', 'merged', 'todo'] as const)(
    'leaves a ticket the user moved to %s meanwhile where it is',
    async (column) => {
      const runId = seedFinished()
      await harness.service.startMigrations(runId, 'session-1')
      harness.boardTickets.get(ticketOf(runId))!.column = column

      await harness.service.endMigrations(runId, 'session-1', 'finished')

      expect(sessionOf(runId).id).toBeNull()
      expect(harness.ticketMoves).toHaveLength(1)
      expect(columnOf(runId)).toBe(column)
    }
  )

  it('clears the session of a run whose ticket is gone or cannot be moved', async () => {
    const gone = seedFinished()
    await harness.service.startMigrations(gone, 'session-1')
    harness.boardTickets.delete(ticketOf(gone))
    await expect(
      harness.service.endMigrations(gone, 'session-1', 'finished')
    ).resolves.toMatchObject({ run: { migration_session_id: null } })

    const stuck = seedFinished()
    await harness.service.startMigrations(stuck, 'session-2')
    harness.overrides.moveTicket = async () => {
      throw new Error('database is locked')
    }
    const detail = await harness.service.endMigrations(stuck, 'session-2', 'stopped')
    expect(detail.run.migration_session_id).toBeNull()
    expect(sessionOf(stuck)).toEqual({ id: null, startedAt: null, ownerPid: null })
    expect(eventTypes(stuck)).toEqual(['migrations_started', 'migrations_stopped'])
    expect(columnOf(stuck)).toBe('in_progress')
  })

  it('moves the ticket outside the calling request, so the caller’s board reloads too', async () => {
    const runId = seedFinished()
    await harness.service.startMigrations(runId, 'session-1')
    const contexts: unknown[] = []
    harness.overrides.detach = (task) => rpcRequestContext.exit(task)
    harness.overrides.moveTicket = async () => {
      contexts.push(getRpcRequestContext())
    }

    await rpcRequestContext.run({ clientId: 'client-1', principal: null }, () =>
      harness.service.endMigrations(runId, 'session-1', 'finished')
    )

    expect(contexts).toEqual([undefined])
  })

  it('rejects a run that does not exist', async () => {
    await expect(
      harness.service.endMigrations('no-such-run', 'session-1', 'finished')
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('reconcileRunTickets while migrations are being executed', () => {
  it('keeps the ticket In Progress while the session is one of this app run', async () => {
    harness.overrides.getAppStartedAt = () => BEFORE_START
    const runId = seedFinished()
    await harness.service.startMigrations(runId, 'session-1')
    harness.published.length = 0

    await harness.service.reconcileRunTickets()
    await harness.service.reconcileRunTickets()

    expect(sessionOf(runId)).toEqual({ id: 'session-1', startedAt: STARTED_AT, ownerPid: null })
    expect(eventTypes(runId)).toEqual(['migrations_started'])
    expect(harness.published).toEqual([])
    expect(harness.ticketMoves).toHaveLength(1)
    expect(columnOf(runId)).toBe('in_progress')
  })

  it('keeps a session started the very instant the app did', async () => {
    harness.overrides.getAppStartedAt = () => STARTED_AT
    const runId = seedFinished({
      ticket: 'in_progress',
      session: { id: 'session-1', startedAt: STARTED_AT }
    })

    await harness.service.reconcileRunTickets()

    expect(sessionOf(runId).id).toBe('session-1')
    expect(harness.ticketMoves).toEqual([])
  })

  it('drops a session started before the app did and moves the ticket to Review', async () => {
    harness.overrides.getAppStartedAt = () => AFTER_START
    const runId = seedFinished({
      ticket: 'in_progress',
      session: { id: 'session-1', startedAt: STARTED_AT }
    })
    // The session of another run belongs to this app run: it is left alone.
    const live = seedFinished({
      ticket: 'in_progress',
      session: { id: 'session-2', startedAt: '2026-10-05T11:30:00.000Z' }
    })

    await harness.service.reconcileRunTickets()

    expect(sessionOf(runId)).toEqual({ id: null, startedAt: null, ownerPid: null })
    expect(eventTypes(runId)).toEqual(['migrations_interrupted'])
    expect(harness.published).toEqual([
      { runId, projectId: TEST_PROJECT_ID, reason: 'run' },
      { runId, projectId: TEST_PROJECT_ID, reason: 'event' }
    ])
    expect(harness.ticketMoves).toEqual([
      { projectId: TEST_PROJECT_ID, ticketId: ticketOf(runId), column: 'review' }
    ])
    expect(columnOf(runId)).toBe('review')
    expect(sessionOf(live).id).toBe('session-2')
    expect(columnOf(live)).toBe('in_progress')

    // Safe to repeat: nothing is left to drop.
    await harness.service.reconcileRunTickets()
    expect(eventTypes(runId)).toEqual(['migrations_interrupted'])
    expect(harness.ticketMoves).toHaveLength(1)
  })

  it('drops a dead session without moving a ticket the user already moved on', async () => {
    harness.overrides.getAppStartedAt = () => AFTER_START
    const runId = seedFinished({
      ticket: 'done',
      session: { id: 'session-1', startedAt: STARTED_AT }
    })

    await harness.service.reconcileRunTickets()

    expect(sessionOf(runId)).toEqual({ id: null, startedAt: null, ownerPid: null })
    expect(harness.ticketMoves).toEqual([])
    expect(columnOf(runId)).toBe('done')
  })

  it('drops a session with no start time: nothing says it belongs to this app run', async () => {
    harness.overrides.getAppStartedAt = () => BEFORE_START
    const runId = seedFinished({
      ticket: 'in_progress',
      session: { id: 'session-1', startedAt: null }
    })

    await harness.service.reconcileRunTickets()

    expect(sessionOf(runId)).toEqual({ id: null, startedAt: null, ownerPid: null })
    expect(eventTypes(runId)).toEqual(['migrations_interrupted'])
    expect(columnOf(runId)).toBe('review')
  })

  it('keeps a session started before the app did while the app instance it belongs to is running', async () => {
    // Another instance on the same database: the session is that one's to end.
    harness.overrides.getAppStartedAt = () => AFTER_START
    harness.overrides.getAppPid = () => APP_PID
    const isProcessAlive = vi.fn((pid: number) => pid === OTHER_APP_PID)
    harness.overrides.isProcessAlive = isProcessAlive
    const session = { id: 'session-1', startedAt: STARTED_AT, ownerPid: OTHER_APP_PID }
    const runId = seedFinished({ ticket: 'in_progress', session })

    await harness.service.reconcileRunTickets()

    expect(isProcessAlive.mock.calls).toEqual([[OTHER_APP_PID]])
    expect(sessionOf(runId)).toEqual(session)
    expect(eventTypes(runId)).toEqual([])
    expect(harness.published).toEqual([])
    expect(harness.ticketMoves).toEqual([])
    expect(columnOf(runId)).toBe('in_progress')

    // Until that instance is gone as well.
    isProcessAlive.mockReturnValue(false)
    await harness.service.reconcileRunTickets()

    expect(sessionOf(runId)).toEqual({ id: null, startedAt: null, ownerPid: null })
    expect(eventTypes(runId)).toEqual(['migrations_interrupted'])
    expect(columnOf(runId)).toBe('review')
  })

  it.each([
    ['whose app instance is no longer running', OTHER_APP_PID, false],
    // A process id is handed out again: what started before this app did is not this app's.
    ['recorded under the process id this app instance has', APP_PID, true],
    ['that names no app instance', null, true]
  ] as const)('drops a session started before the app did %s', async (_case, ownerPid, alive) => {
    harness.overrides.getAppStartedAt = () => AFTER_START
    harness.overrides.getAppPid = () => APP_PID
    harness.overrides.isProcessAlive = () => alive
    const runId = seedFinished({
      ticket: 'in_progress',
      session: { id: 'session-1', startedAt: STARTED_AT, ownerPid }
    })

    await harness.service.reconcileRunTickets()

    expect(sessionOf(runId)).toEqual({ id: null, startedAt: null, ownerPid: null })
    expect(eventTypes(runId)).toEqual(['migrations_interrupted'])
    expect(harness.published).toEqual([
      { runId, projectId: TEST_PROJECT_ID, reason: 'run' },
      { runId, projectId: TEST_PROJECT_ID, reason: 'event' }
    ])
    expect(harness.ticketMoves).toEqual([
      { projectId: TEST_PROJECT_ID, ticketId: ticketOf(runId), column: 'review' }
    ])
    expect(columnOf(runId)).toBe('review')
  })

  it('does not ask who owns a session of this app run', async () => {
    harness.overrides.getAppStartedAt = () => BEFORE_START
    harness.overrides.getAppPid = () => APP_PID
    const isProcessAlive = vi.fn(() => false)
    harness.overrides.isProcessAlive = isProcessAlive
    const session = { id: 'session-1', startedAt: STARTED_AT, ownerPid: OTHER_APP_PID }
    const runId = seedFinished({ ticket: 'in_progress', session })

    await harness.service.reconcileRunTickets()

    expect(isProcessAlive).not.toHaveBeenCalled()
    expect(sessionOf(runId)).toEqual(session)
    expect(columnOf(runId)).toBe('in_progress')
  })

  it('asks the operating system whether the owner is running when given no other way', async () => {
    // Neither `getAppPid` nor `isProcessAlive`: any owner is another instance, alive if the OS says so.
    harness.overrides.getAppStartedAt = () => AFTER_START
    const exited = spawnSync(process.execPath, ['-e', '']).pid
    expect(exited).toBeGreaterThan(0)
    const live = seedFinished({
      ticket: 'in_progress',
      session: { id: 'session-1', startedAt: STARTED_AT, ownerPid: process.pid }
    })
    const dead = seedFinished({
      ticket: 'in_progress',
      session: { id: 'session-2', startedAt: STARTED_AT, ownerPid: exited }
    })

    await harness.service.reconcileRunTickets()

    expect(sessionOf(live).id).toBe('session-1')
    expect(columnOf(live)).toBe('in_progress')
    expect(sessionOf(dead).id).toBeNull()
    expect(columnOf(dead)).toBe('review')
  })

  it('does not return a ticket to Review for a session started after the runs were listed', async () => {
    // A session of this app run: the reconcile reads the row again, and must find it alive.
    harness.overrides.now = () => new Date()
    const runs = [seedFinished(), seedFinished()]
    // The reconcile waits on the ticket of the run it settles first: the other is still to come.
    const reached: string[] = []
    let resume = (): void => undefined
    harness.overrides.getTicket = async (_projectId, ticketId) => {
      if (reached.length === 0) {
        reached.push(ticketId)
        await new Promise<void>((resolve) => {
          resume = resolve
        })
      }
      const ticket = harness.boardTickets.get(ticketId)
      return ticket ? { id: ticket.id, column: ticket.column } : null
    }
    const reconciling = harness.service.reconcileRunTickets()
    await vi.waitFor(() => expect(reached).toHaveLength(1))
    const later = runs.find((runId) => ticketOf(runId) !== reached[0])!

    await harness.service.startMigrations(later, 'session-1')
    resume()
    await reconciling

    expect(sessionOf(later).id).toBe('session-1')
    expect(harness.ticketMoves).toEqual([
      { projectId: TEST_PROJECT_ID, ticketId: ticketOf(later), column: 'in_progress' }
    ])
    expect(columnOf(later)).toBe('in_progress')
  })

  it('does not drop a session started since the runs were listed in place of a dead one', async () => {
    harness.overrides.now = () => new Date()
    const first = seedFinished()
    const stale = seedFinished({
      ticket: 'in_progress',
      session: { id: 'session-dead', startedAt: '2020-01-01T00:00:00.000Z' }
    })
    // The reconcile waits on the ticket of the run it settles first: the other is still to come.
    let waiting = false
    let resume = (): void => undefined
    harness.overrides.getTicket = async (_projectId, ticketId) => {
      if (!waiting && ticketId === ticketOf(first)) {
        waiting = true
        await new Promise<void>((resolve) => {
          resume = resolve
        })
      }
      const ticket = harness.boardTickets.get(ticketId)
      return ticket ? { id: ticket.id, column: ticket.column } : null
    }
    const reconciling = harness.service.reconcileRunTickets()
    await vi.waitFor(() => expect(waiting).toBe(true))

    // Meanwhile the user stops the dead session and starts another.
    await harness.service.endMigrations(stale, 'session-dead', 'stopped')
    await harness.service.startMigrations(stale, 'session-live')
    resume()
    await reconciling

    expect(sessionOf(stale).id).toBe('session-live')
    expect(columnOf(stale)).toBe('in_progress')
  })

  it('goes by this server’s own start when the app’s was not stamped', async () => {
    harness.overrides.now = () => new Date()
    const live = seedFinished()
    await harness.service.startMigrations(live, 'session-1')
    const dead = seedFinished({
      ticket: 'in_progress',
      session: { id: 'session-2', startedAt: '2020-01-01T00:00:00.000Z' }
    })

    await harness.service.reconcileRunTickets()

    expect(sessionOf(live).id).toBe('session-1')
    expect(columnOf(live)).toBe('in_progress')
    expect(sessionOf(dead).id).toBeNull()
    expect(columnOf(dead)).toBe('review')
  })

  it('lets a new session be started once the dead one was dropped', async () => {
    harness.overrides.getAppStartedAt = () => STARTED_AT
    const runId = seedFinished({
      ticket: 'in_progress',
      session: { id: 'session-1', startedAt: BEFORE_START }
    })
    await expect(harness.service.startMigrations(runId, 'session-2')).rejects.toMatchObject({
      code: 'INVALID_STATE'
    })

    await harness.service.reconcileRunTickets()
    await harness.service.startMigrations(runId, 'session-2')

    expect(sessionOf(runId)).toEqual({ id: 'session-2', startedAt: STARTED_AT, ownerPid: null })
    expect(columnOf(runId)).toBe('in_progress')
  })
})

describe('deleting while migrations are being executed', () => {
  it('refuses to delete the run, by itself or through its ticket', async () => {
    const runId = seedFinished()
    await harness.service.startMigrations(runId, 'session-1')
    harness.published.length = 0

    await expect(harness.service.delete(runId)).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message: 'Stop the migrations of the run before deleting it.'
    })
    await expect(
      harness.service.deleteRunTicket(TEST_PROJECT_ID, ticketOf(runId), runId)
    ).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message: 'Stop the migrations of the run before deleting it.'
    })

    expect(sessionOf(runId).id).toBe('session-1')
    expect(harness.boardTickets.has(ticketOf(runId))).toBe(true)
    expect(harness.deletedTickets).toEqual([])
    expect(harness.published).toEqual([])
  })

  it('deletes it once the migrations were stopped', async () => {
    const runId = seedFinished()
    await harness.service.startMigrations(runId, 'session-1')
    await harness.service.endMigrations(runId, 'session-1', 'stopped')

    await expect(harness.service.delete(runId)).resolves.toBe(true)

    expect(harness.db.getDocumentRun(runId)).toBeNull()
    expect(harness.deletedTickets).toEqual([ticketOf(runId)])
  })

  it('deletes it regardless when the project is going with it', async () => {
    const runId = seedFinished()
    await harness.service.startMigrations(runId, 'session-1')
    harness.published.length = 0

    await expect(harness.service.delete(runId, { removeFiles: true })).resolves.toBe(true)

    expect(harness.db.getDocumentRun(runId)).toBeNull()
    expect(harness.deletedTickets).toEqual([ticketOf(runId)])
    expect(harness.published).toEqual([{ runId, projectId: TEST_PROJECT_ID, reason: 'deleted' }])
  })
})

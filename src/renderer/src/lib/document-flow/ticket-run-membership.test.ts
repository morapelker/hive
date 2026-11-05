/**
 * Which run a board ticket is part of, as the board asks: the run that still owns it (newest
 * first), whether an orchestrator will launch it (so no one else may), which orchestrators of a
 * project take more tickets, and which finished ones have no checkout left to resume on.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { makeDetail } from '@/components/document-flow/test-fixtures'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import type { DocumentRunDetail } from '@shared/types/document-flow'
import {
  addableTicketRuns,
  integrationCheckoutGone,
  isAwaitingRunLaunch,
  orchestratorLaunchRefusal,
  runItemOfTicket,
  ticketRunOwnerOf
} from './ticket-run-membership'

const initialFlowState = useDocumentFlowStore.getState()

afterEach(() => {
  useDocumentFlowStore.setState(initialFlowState, true)
})

const byId = (...details: DocumentRunDetail[]): Record<string, DocumentRunDetail> =>
  Object.fromEntries(details.map((detail) => [detail.run.id, detail]))

/** An orchestrator made from board tickets, with one item per given ticket. */
function ticketRun(
  id: string,
  run: Partial<DocumentRunDetail['run']>,
  items: Partial<DocumentRunDetail['items'][number]>[]
): DocumentRunDetail {
  return makeDetail(
    {
      id,
      project_id: 'proj-1',
      title: `Run ${id}`,
      source_kind: 'tickets',
      source_path: '',
      ...run
    },
    items
  )
}

describe('runItemOfTicket', () => {
  it('finds the item of a ticket in a run that still owns it', () => {
    const runs = byId(
      ticketRun('run-1', { status: 'running' }, [
        { key: 'TD-1', ticket_id: 't1' },
        { key: 'TD-2', ticket_id: 't2' }
      ])
    )

    const found = runItemOfTicket('t2', runs)

    expect(found?.run.id).toBe('run-1')
    expect(found?.item.key).toBe('TD-2')
    expect(runItemOfTicket('t3', runs)).toBeNull()
    expect(runItemOfTicket('', runs)).toBeNull()
  })

  it('leaves out runs that ended unless any status is asked for', () => {
    const runs = byId(
      ticketRun('run-done', { status: 'completed' }, [{ key: 'TD-1', ticket_id: 't1' }])
    )

    expect(runItemOfTicket('t1', runs)).toBeNull()
    expect(runItemOfTicket('t1', runs, { anyStatus: true })?.run.id).toBe('run-done')
  })

  it('prefers the newest run when two claim the ticket', () => {
    const runs = byId(
      ticketRun('run-old', { status: 'paused', created_at: '2026-01-01T00:00:00.000Z' }, [
        { key: 'TD-1', ticket_id: 't1' }
      ]),
      ticketRun('run-new', { status: 'preview', created_at: '2026-02-01T00:00:00.000Z' }, [
        { key: 'TD-1', ticket_id: 't1' }
      ])
    )

    expect(runItemOfTicket('t1', runs)?.run.id).toBe('run-new')
  })

  it("covers a document run's task tickets as well", () => {
    const runs = byId(
      makeDetail({ id: 'doc-run', status: 'running' }, [{ key: 'A2', ticket_id: 't9' }])
    )

    expect(runItemOfTicket('t9', runs)?.run.source_kind).toBe('document')
    expect(ticketRunOwnerOf('t9', runs)).toEqual({
      runId: 'doc-run',
      title: 'Checkout redesign',
      status: 'running'
    })
  })

  it('reads the flow store when no runs are passed', () => {
    useDocumentFlowStore.setState({
      runsById: byId(ticketRun('run-1', { status: 'running' }, [{ key: 'TD-1', ticket_id: 't1' }]))
    })

    expect(runItemOfTicket('t1')?.run.id).toBe('run-1')
    expect(ticketRunOwnerOf('t1')?.runId).toBe('run-1')
  })
})

describe('orchestratorLaunchRefusal', () => {
  it('refuses a ticket waiting for its turn in a running orchestrator', () => {
    const runs = byId(
      ticketRun('run-1', { status: 'running', title: 'Checkout' }, [
        { key: 'TD-3', ticket_id: 't3', status: 'pending' }
      ])
    )

    expect(orchestratorLaunchRefusal('t3', runs)).toBe(
      'TD-3 is part of the orchestrator “Checkout”: it launches when the run gets to it. Remove it from the orchestrator to launch it yourself.'
    )
  })

  it('refuses every ticket of an orchestrator still in preview', () => {
    const runs = byId(ticketRun('run-1', { status: 'preview' }, [{ key: 'TD-3', ticket_id: 't3' }]))

    expect(orchestratorLaunchRefusal('t3', runs)).toMatch(/^TD-3 is part of the orchestrator/)
  })

  it('refuses a ticket whose launch failed without a session: Retry launches it again', () => {
    const runs = byId(
      ticketRun('run-1', { status: 'running' }, [
        { key: 'TD-3', ticket_id: 't3', status: 'needs_attention', session_id: null }
      ])
    )

    expect(orchestratorLaunchRefusal('t3', runs)).not.toBeNull()
  })

  it.each([
    ['waiting for its turn', 'paused', { status: 'pending' }],
    ['in a preview', 'preview', { status: 'pending' }],
    ['whose launch failed', 'running', { status: 'needs_attention', session_id: null }],
    ['being launched', 'running', { status: 'launching', session_id: null }]
  ] as const)(
    "leaves a document run's task ticket %s to the launch it always had",
    (_l, status, item) => {
      const runs = byId(
        makeDetail({ id: 'doc-run', status, title: 'Spec' }, [
          { key: 'A2', ticket_id: 't9', ...item }
        ])
      )

      expect(orchestratorLaunchRefusal('t9', runs)).toBeNull()
    }
  )

  it.each([
    ['launched', { status: 'running' as const, session_id: 's1' }],
    ['flagged with a session', { status: 'needs_attention' as const, session_id: 's1' }],
    ['skipped', { status: 'skipped' as const }],
    ['merged', { status: 'merged' as const }],
    ['left out of the run', { status: 'pending' as const, selected: false }]
  ])('lets a ticket whose item is %s be launched', (_label, item) => {
    const runs = byId(
      ticketRun('run-1', { status: 'running' }, [{ key: 'TD-3', ticket_id: 't3', ...item }])
    )

    expect(orchestratorLaunchRefusal('t3', runs)).toBeNull()
  })

  it.each(['completed', 'completed_with_issues', 'cancelled'] as const)(
    'lets the tickets of a %s run be launched',
    (status) => {
      const runs = byId(
        ticketRun('run-1', { status }, [{ key: 'TD-3', ticket_id: 't3', status: 'pending' }])
      )

      expect(orchestratorLaunchRefusal('t3', runs)).toBeNull()
    }
  )

  it('refuses a ticket the run is launching this moment (no session on it yet)', () => {
    const runs = byId(
      ticketRun('run-1', { status: 'running', title: 'Checkout' }, [
        { key: 'TD-3', ticket_id: 't3', status: 'launching', session_id: null }
      ])
    )

    expect(orchestratorLaunchRefusal('t3', runs)).toBe(
      'TD-3 is being launched by the orchestrator “Checkout”.'
    )
  })

  it('lets any other ticket be launched', () => {
    expect(orchestratorLaunchRefusal('t-free', {})).toBeNull()
    expect(isAwaitingRunLaunch(null)).toBe(false)
  })

  it("falls back to the run's kind for a run without a title", () => {
    const runs = byId(
      ticketRun('run-1', { status: 'running', title: '  ' }, [{ key: 'T1', ticket_id: 't1' }])
    )

    expect(orchestratorLaunchRefusal('t1', runs)).toMatch(
      /^T1 is part of the orchestrator “Orchestrator”/
    )
  })
})

describe('addableTicketRuns', () => {
  it("lists the project's orchestrators that take tickets, newest first", () => {
    const runs = byId(
      ticketRun('preview', { status: 'preview', created_at: '2026-01-01T00:00:00.000Z' }, []),
      ticketRun('running', { status: 'running', created_at: '2026-01-03T00:00:00.000Z' }, []),
      ticketRun('finished', { status: 'completed', created_at: '2026-01-02T00:00:00.000Z' }, []),
      ticketRun('cancelled', { status: 'cancelled' }, []),
      ticketRun('migrating', { status: 'completed', migration_session_id: 's-mig' }, []),
      ticketRun('elsewhere', { status: 'running', project_id: 'proj-2' }, []),
      makeDetail({ id: 'doc-run', project_id: 'proj-1', status: 'running' }, [])
    )

    expect(addableTicketRuns('proj-1', runs).map((run) => run.id)).toEqual([
      'running',
      'finished',
      'preview'
    ])
    expect(addableTicketRuns('proj-3', runs)).toEqual([])
  })
})

describe('integrationCheckoutGone', () => {
  const run = (
    overrides: Partial<Parameters<typeof integrationCheckoutGone>[0]> = {}
  ): Parameters<typeof integrationCheckoutGone>[0] => ({
    integration_worktree_id: 'wt-int',
    integration_connection_id: null,
    ...overrides
  })

  it("looks for a run's integration worktree in the project's list", () => {
    expect(integrationCheckoutGone(run(), [{ id: 'wt-int' }], undefined)).toBe(false)
    expect(integrationCheckoutGone(run(), [{ id: 'wt-other' }], undefined)).toBe(true)
    expect(integrationCheckoutGone(run(), [], undefined)).toBe(true)
  })

  it("looks for a connection run's instance in the connection list, not the worktrees", () => {
    const connectionRun = run({
      integration_worktree_id: null,
      integration_connection_id: 'conn-int'
    })

    expect(integrationCheckoutGone(connectionRun, [], new Set(['conn-int']))).toBe(false)
    expect(integrationCheckoutGone(connectionRun, [], new Set(['conn-other']))).toBe(true)
  })

  it('refuses nothing while a list has not loaded', () => {
    expect(integrationCheckoutGone(run(), undefined, undefined)).toBe(false)
    expect(
      integrationCheckoutGone(
        run({ integration_worktree_id: null, integration_connection_id: 'conn-int' }),
        [],
        undefined
      )
    ).toBe(false)
  })

  it('knows a run that never had a checkout has none, whatever has loaded', () => {
    expect(
      integrationCheckoutGone(run({ integration_worktree_id: null }), undefined, undefined)
    ).toBe(true)
  })
})

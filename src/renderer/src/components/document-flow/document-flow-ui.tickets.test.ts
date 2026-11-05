// The labels and rules of document-flow-ui for a run made from board tickets (an
// "Orchestrator"): its own wording where a run is named, no document edit lane whatever its
// items say, and what the dashboard may still change on its tickets. Every document-run
// sentence stays byte for byte what it was (document-flow-ui.test.ts pins those without a run;
// here they are pinned again with a document run passed in).
import { describe, expect, it } from 'vitest'
import {
  DOCUMENT_RUN_ITEM_STATUSES,
  DOCUMENT_RUN_STATUSES,
  type DocumentRunDetail
} from '@shared/types/document-flow'
import {
  canEditTicketRunItem,
  canRetryDocumentUpdate,
  canSkipDocumentUpdate,
  describeRunCount,
  describeRunDeletion,
  describeTicketRunItemRemoval,
  documentRunTicketDropRefusal,
  isAddedAfterLaunch,
  isQueuedForDocumentUpdate,
  isUpdatingRunDocument,
  runBoardCardState,
  runDisplayTitle,
  runDocumentEditState,
  runDocumentEditStatus,
  runKindNoun
} from './document-flow-ui'
import { makeDetail, makeItem, makeRun } from './test-fixtures'

const TICKETS = { source_kind: 'tickets', source_path: '', document_path: null } as const
const DOCUMENT = { source_kind: 'document' } as const

describe('naming a run by its kind', () => {
  it('falls back to the document name, or to "Orchestrator" for a run without a document', () => {
    expect(runDisplayTitle(makeRun({ title: 'Checkout' }))).toBe('Checkout')
    expect(runDisplayTitle(makeRun({ title: '', source_path: '/docs/spec (2).html' }))).toBe(
      'spec (2).html'
    )
    expect(runDisplayTitle(makeRun({ ...TICKETS, title: 'Billing' }))).toBe('Billing')
    expect(runDisplayTitle(makeRun({ ...TICKETS, title: '' }))).toBe('Orchestrator')
  })

  it('names the kind inside a sentence', () => {
    expect(runKindNoun(makeRun(DOCUMENT))).toBe('document run')
    expect(runKindNoun(makeRun(TICKETS))).toBe('orchestrator')
    expect(runKindNoun(null)).toBe('document run')
  })

  it('counts the active runs in the words of their kind, and generically for a mix', () => {
    const doc = makeRun(DOCUMENT)
    const orch = makeRun(TICKETS)
    expect(describeRunCount([doc, doc])).toEqual({ label: '2 document runs', kind: 'document' })
    expect(describeRunCount([doc])).toEqual({ label: '1 document run', kind: 'document' })
    expect(describeRunCount([orch])).toEqual({ label: '1 orchestrator', kind: 'tickets' })
    expect(describeRunCount([orch, orch])).toEqual({ label: '2 orchestrators', kind: 'tickets' })
    expect(describeRunCount([doc, orch, doc])).toEqual({ label: '3 runs', kind: 'mixed' })
  })
})

describe('describeRunDeletion', () => {
  const launched = [makeItem({ key: 'A1', ticket_id: 't-1' })]
  const unlaunched = [makeItem({ key: 'A1' })]

  it('reads as it always did for a document run, with or without the run', () => {
    for (const items of [launched, unlaunched]) {
      expect(describeRunDeletion(items, makeRun(DOCUMENT))).toBe(describeRunDeletion(items))
    }
    expect(describeRunDeletion(launched, makeRun(DOCUMENT))).toContain('spec text and figures')
  })

  it('keeps the board tickets of an orchestrator, launched or not, and mentions no files', () => {
    for (const items of [launched, unlaunched, []]) {
      const text = describeRunDeletion(items, makeRun(TICKETS))
      expect(text).toContain(
        'The board tickets stay on the board (they are only taken out of the orchestrator).'
      )
      expect(text).toContain("The run's own ticket is removed from the board")
      expect(text).not.toContain('spec text')
      expect(text).not.toContain('removed from disk')
    }
  })
})

describe('documentRunTicketDropRefusal', () => {
  const COLUMNS = ['todo', 'in_progress', 'review', 'merged', 'done']

  it('says exactly what it said before for a document run', () => {
    for (const status of [...DOCUMENT_RUN_STATUSES, null]) {
      for (const column of COLUMNS) {
        for (const migrating of [false, true]) {
          expect(
            documentRunTicketDropRefusal(status, column, migrating, makeRun(DOCUMENT)),
            `${status} → ${column}${migrating ? ' (migrating)' : ''}`
          ).toBe(documentRunTicketDropRefusal(status, column, migrating))
        }
      }
    }
  })

  it('refuses the same drops for an orchestrator, in its own words', () => {
    const run = makeRun(TICKETS)
    for (const status of [...DOCUMENT_RUN_STATUSES, null]) {
      for (const column of COLUMNS) {
        for (const migrating of [false, true]) {
          const document = documentRunTicketDropRefusal(status, column, migrating)
          const tickets = documentRunTicketDropRefusal(status, column, migrating, run)
          const where = `${status} → ${column}${migrating ? ' (migrating)' : ''}`
          expect(tickets === null, where).toBe(document === null)
          if (tickets) expect(tickets, where).not.toMatch(/document/i)
        }
      }
    }
    expect(documentRunTicketDropRefusal('running', 'todo', false, run)).toBe(
      'The ticket of an orchestrator cannot go back to To Do.'
    )
    expect(documentRunTicketDropRefusal('preview', 'review', false, run)).toBe(
      'This orchestrator has not been launched yet. Drop its ticket on In Progress, or open it, to launch it.'
    )
    expect(documentRunTicketDropRefusal('running', 'review', false, run)).toBe(
      'The orchestrator is still going; its ticket moves to Review when the run ends.'
    )
    expect(documentRunTicketDropRefusal('completed', 'in_progress', false, run)).toBe(
      'This orchestrator is over; its ticket cannot go back to In Progress.'
    )
    expect(documentRunTicketDropRefusal('completed', 'review', true, run)).toBe(
      'The migrations of this orchestrator are being executed. Wait for them to finish, or stop them, before moving its ticket.'
    )
  })
})

describe('no document edit lane for an orchestrator', () => {
  // Items as a document run's would stand in the lane: one editing, one queued, one failed.
  const laneItems = [
    {
      key: 'A1',
      status: 'merged',
      ticket_id: 't-1',
      session_id: 's-1',
      document_update_status: 'updating',
      document_update_queued_at: '2026-05-04T10:10:00.000Z'
    },
    {
      key: 'A2',
      status: 'merged',
      ticket_id: 't-2',
      session_id: 's-2',
      document_update_status: 'queued',
      document_update_queued_at: '2026-05-04T10:11:00.000Z'
    },
    {
      key: 'A3',
      status: 'merged',
      ticket_id: 't-3',
      session_id: 's-3',
      document_update_status: 'failed'
    }
  ] as const

  const runs = (detail: DocumentRunDetail): Record<string, DocumentRunDetail> => ({
    [detail.run.id]: detail
  })

  it('shows the lane of a document run (the control case)', () => {
    const detail = makeDetail({ status: 'running' }, [...laneItems])
    expect(runDocumentEditState(detail.run, detail.items)).not.toBeNull()
    expect(isQueuedForDocumentUpdate(runs(detail), 't-2')).not.toBeNull()
    expect(runDocumentEditStatus(runs(detail), { ticketId: 't-1' })).toBe('editing')
    expect(canRetryDocumentUpdate(detail.run, detail.items[2])).toBe(true)
    expect(canSkipDocumentUpdate(detail.run, detail.items[1])).toBe(true)
  })

  it('is empty for an orchestrator whatever its items say', () => {
    const detail = makeDetail({ ...TICKETS, status: 'running' }, [...laneItems])
    expect(runDocumentEditState(detail.run, detail.items)).toBeNull()
    expect(isQueuedForDocumentUpdate(runs(detail), 't-2')).toBeNull()
    expect(runDocumentEditStatus(runs(detail), { ticketId: 't-1' })).toBeNull()
    expect(isUpdatingRunDocument(runs(detail), { sessionId: 's-1' })).toBe(false)
    for (const item of detail.items) {
      expect(canRetryDocumentUpdate(detail.run, item), item.key).toBe(false)
      expect(canSkipDocumentUpdate(detail.run, item), item.key).toBe(false)
    }
    expect(runBoardCardState(detail).editingDocument).toBeNull()
  })

  it('never puts two orchestrators (both without a path) in one lane', () => {
    const orchestrator = makeDetail({ ...TICKETS, id: 'run-a', status: 'running' }, [
      { ...laneItems[0], run_id: 'run-a' }
    ])
    const other = makeDetail({ ...TICKETS, id: 'run-b', status: 'running' }, [
      { ...laneItems[1], id: 'item-B2', run_id: 'run-b', ticket_id: 't-b2' }
    ])
    expect(isQueuedForDocumentUpdate({ 'run-a': orchestrator, 'run-b': other }, 't-b2')).toBeNull()
  })
})

describe('runBoardCardState of an orchestrator', () => {
  it('says what the run is made from, and is named by its kind until it has a title', () => {
    expect(runBoardCardState(makeDetail({ status: 'running' })).sourceKind).toBe('document')
    expect(
      runBoardCardState(makeDetail({ ...TICKETS, status: 'running', title: '' }))
    ).toMatchObject({ sourceKind: 'tickets', title: 'Orchestrator', phase: 'running' })
    expect(
      runBoardCardState(makeDetail({ ...TICKETS, status: 'preview', title: 'Billing' }), 'todo')
    ).toMatchObject({ sourceKind: 'tickets', title: 'Billing', label: 'Ready to launch' })
  })
})

describe('what the dashboard may still change on an orchestrator ticket', () => {
  it('is only a ticket that has not launched, of an orchestrator that is going', () => {
    for (const runStatus of DOCUMENT_RUN_STATUSES) {
      for (const status of DOCUMENT_RUN_ITEM_STATUSES) {
        for (const session_id of [null, 'session-1']) {
          const item = makeItem({ status, session_id })
          const expected =
            (runStatus === 'running' || runStatus === 'paused') &&
            (status === 'pending' || (status === 'needs_attention' && session_id === null))
          expect(
            canEditTicketRunItem(makeRun({ ...TICKETS, status: runStatus }), item),
            `${runStatus} / ${status} / ${session_id}`
          ).toBe(expected)
          // Never for a document run: its tickets are fixed at launch
          expect(canEditTicketRunItem(makeRun({ status: runStatus }), item)).toBe(false)
        }
      }
    }
  })

  it('leaves a ticket the run left out alone', () => {
    expect(
      canEditTicketRunItem(
        makeRun({ ...TICKETS, status: 'running' }),
        makeItem({ status: 'pending', selected: false })
      )
    ).toBe(false)
  })

  it('tells the tickets that joined after launch', () => {
    const run = makeRun({ ...TICKETS, status: 'running', started_at: '2026-05-04T10:05:00.000Z' })
    expect(isAddedAfterLaunch(run, makeItem({ created_at: '2026-05-04T10:00:00.000Z' }))).toBe(
      false
    )
    expect(isAddedAfterLaunch(run, makeItem({ created_at: '2026-05-04T10:05:00.000Z' }))).toBe(
      false
    )
    expect(isAddedAfterLaunch(run, makeItem({ created_at: '2026-05-04T11:00:00.000Z' }))).toBe(true)
    // Before launch nothing is "added after"; a document run never grows
    expect(
      isAddedAfterLaunch(
        makeRun({ ...TICKETS, status: 'preview', started_at: null }),
        makeItem({ created_at: '2026-05-04T11:00:00.000Z' })
      )
    ).toBe(false)
    expect(
      isAddedAfterLaunch(
        makeRun({ status: 'running', started_at: '2026-05-04T10:05:00.000Z' }),
        makeItem({ created_at: '2026-05-04T11:00:00.000Z' })
      )
    ).toBe(false)
    expect(isAddedAfterLaunch(run, makeItem({ created_at: 'not a date' }))).toBe(false)
  })

  it('says, before a removal, that the ticket stays and who stops waiting for it', () => {
    const items = [
      makeItem({ key: 'TD-1' }),
      makeItem({ key: 'TD-2', depends_on: ['TD-1'] }),
      makeItem({ key: 'TD-3', depends_on: ['TD-1', 'TD-2'] }),
      makeItem({ key: 'TD-4', depends_on: ['TD-1'], selected: false })
    ]
    expect(describeTicketRunItemRemoval(items[0], items)).toBe(
      'TD-1 leaves the run and stays on the board as an ordinary ticket, which you can launch on its own. TD-2, TD-3 start after it and will no longer wait for it.'
    )
    expect(describeTicketRunItemRemoval(items[1], items)).toBe(
      'TD-2 leaves the run and stays on the board as an ordinary ticket, which you can launch on its own. TD-3 starts after it and will no longer wait for it.'
    )
    expect(describeTicketRunItemRemoval(items[2], items)).toBe(
      'TD-3 leaves the run and stays on the board as an ordinary ticket, which you can launch on its own.'
    )
  })
})

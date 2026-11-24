// Deleting a run together with its tickets: the run goes first (a refusal deletes nothing),
// its tickets on the board follow one by one, and the outcome says what could not be deleted.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeDetail } from '@/components/document-flow/test-fixtures'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { usePrdFlowStore } from '@/stores/usePrdFlowStore'
import type { KanbanTicket } from '../../../../main/db/types'
import {
  deleteRunWithTickets,
  describeRunTicketsDeletion,
  runTicketsDeleteLabels,
  runTicketsOnBoard,
  type RunTicketsTarget
} from './delete-run-tickets'

const initialFlowState = useDocumentFlowStore.getState()
const initialKanbanState = useKanbanStore.getState()
const initialPrdFlowState = usePrdFlowStore.getState()

const ticket = (id: string, overrides: Partial<KanbanTicket> = {}): KanbanTicket =>
  ({
    id,
    project_id: 'proj-1',
    title: id,
    column: 'todo',
    sort_order: 0,
    created_at: '2026-06-01T00:00:00.000Z',
    archived_at: null,
    external_provider: null,
    external_id: null,
    parent_ticket_id: null,
    ...overrides
  }) as KanbanTicket

const RUN_TICKET = ticket('ticket-run', {
  external_provider: 'document-run',
  external_id: 'run-1'
})
const TARGET: RunTicketsTarget = { runId: 'run-1', ticketId: 'ticket-run', projectId: 'proj-1' }

/** A finished orchestrator of two board tickets, plus a session it spawned and a bystander. */
function seed(): void {
  useDocumentFlowStore.setState({
    runsById: {
      'run-1': makeDetail(
        { id: 'run-1', project_id: 'proj-1', status: 'completed', ticket_id: 'ticket-run' },
        [
          { key: 'TD-1', status: 'merged', ticket_id: 't-1' },
          { key: 'TD-2', status: 'merged', ticket_id: 't-2' }
        ]
      )
    }
  })
  useKanbanStore.setState({
    tickets: new Map([
      [
        'proj-1',
        [
          RUN_TICKET,
          ticket('t-1', { parent_ticket_id: 'ticket-run' }),
          ticket('t-2'),
          ticket('manual-steps', { parent_ticket_id: 'ticket-run' }),
          ticket('bystander')
        ]
      ]
    ])
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  useDocumentFlowStore.setState(initialFlowState, true)
  useKanbanStore.setState(initialKanbanState, true)
  usePrdFlowStore.setState(initialPrdFlowState, true)
})

describe('runTicketsOnBoard', () => {
  it('reads the tickets of the run from the board and the run as they are now', () => {
    seed()
    expect(runTicketsOnBoard(TARGET).map((t) => t.id)).toEqual(['t-1', 't-2', 'manual-steps'])
  })

  it('still finds the children of a ticket whose run record is gone', () => {
    seed()
    expect(runTicketsOnBoard({ ...TARGET, runId: null }).map((t) => t.id)).toEqual([
      't-1',
      'manual-steps'
    ])
    expect(runTicketsOnBoard({ ...TARGET, projectId: 'proj-unknown' })).toEqual([])
  })
})

describe('deleteRunWithTickets', () => {
  it('deletes the run first, then each of its tickets, and leaves the rest of the board', async () => {
    seed()
    const calls: string[] = []
    const deleteTicket = vi.fn(async (id: string) => {
      calls.push(id)
    })
    useKanbanStore.setState({ deleteTicket })
    const removeDraft = vi.fn()
    usePrdFlowStore.setState({ removeDraft })
    // The server takes the run and its record away: the tickets were read before that
    const deleteRun = vi.fn(async () => {
      calls.push('run')
      useDocumentFlowStore.setState({ runsById: {} })
    })

    await expect(deleteRunWithTickets(TARGET, deleteRun)).resolves.toEqual({
      deleted: 3,
      failed: 0
    })

    expect(calls).toEqual(['run', 't-1', 't-2', 'manual-steps'])
    expect(deleteTicket).toHaveBeenCalledWith('t-1', 'proj-1')
    expect(removeDraft.mock.calls.map(([id]) => id)).toEqual(['t-1', 't-2', 'manual-steps'])
  })

  it('deletes no ticket when the run could not be deleted', async () => {
    seed()
    const deleteTicket = vi.fn()
    useKanbanStore.setState({ deleteTicket })

    await expect(
      deleteRunWithTickets(TARGET, () =>
        Promise.reject(new Error('Cancel the run before deleting its ticket.'))
      )
    ).rejects.toThrow('Cancel the run before deleting its ticket.')

    expect(deleteTicket).not.toHaveBeenCalled()
  })

  it('counts a ticket that could not be deleted and goes on with the others', async () => {
    seed()
    const deleteTicket = vi.fn(async (id: string) => {
      if (id === 't-2') throw new Error('offline')
    })
    useKanbanStore.setState({ deleteTicket })

    await expect(deleteRunWithTickets(TARGET, async () => {})).resolves.toEqual({
      deleted: 2,
      failed: 1
    })
    expect(deleteTicket).toHaveBeenCalledTimes(3)
  })
})

describe('the copy of the question and of its outcome', () => {
  it('labels both ways to delete, counting the tickets', () => {
    expect(runTicketsDeleteLabels('orchestrator', 5)).toEqual({
      runOnly: 'Delete orchestrator only',
      withTickets: 'Delete orchestrator and 5 tickets'
    })
    expect(runTicketsDeleteLabels('run', 1).withTickets).toBe('Delete run and 1 ticket')
  })

  it('reports what was deleted, and warns about what was not', () => {
    expect(describeRunTicketsDeletion('Orchestrator', { deleted: 5, failed: 0 })).toEqual({
      level: 'success',
      message: 'Orchestrator and 5 tickets deleted'
    })
    expect(describeRunTicketsDeletion('Document run', { deleted: 1, failed: 0 }).message).toBe(
      'Document run and 1 ticket deleted'
    )
    // Its tickets were gone by the time it was confirmed
    expect(describeRunTicketsDeletion('Run', { deleted: 0, failed: 0 }).message).toBe('Run deleted')
    expect(describeRunTicketsDeletion('Orchestrator', { deleted: 3, failed: 2 })).toEqual({
      level: 'warning',
      message: 'Orchestrator deleted, but 2 of its 5 tickets could not be deleted.'
    })
  })
})

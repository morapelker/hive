// The board-ticket picker of an orchestrator on its own, and the "Add tickets" dialog that
// reuses it on a run that exists already (the dashboard's, too): the run's own tickets show
// checked and locked, a finished run says it resumes, a cancelled one takes nothing.
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from '@/lib/toast'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { ticketKey, useKanbanStore } from '@/stores/useKanbanStore'
import type { DocumentRunDetail } from '@shared/types/document-flow'
import type { KanbanTicket } from '../../../../main/db/types'
import { AddRunTicketsDialog } from './AddRunTicketsDialog'
import { makeDetail } from './test-fixtures'
import { TicketRunPicker } from './TicketRunPicker'

const api = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  addTickets: vi.fn()
}))

vi.mock('@/api/document-flow-api', () => ({ documentFlowApi: api }))
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

const initialFlowState = useDocumentFlowStore.getState()
const initialKanbanState = useKanbanStore.getState()

const PROJECT = 'project-1'

const ticket = (id: string, number: number | null, extra: Partial<KanbanTicket> = {}) =>
  ({
    id,
    project_id: PROJECT,
    title: `Ticket ${id}`,
    description: '',
    attachments: [],
    column: 'todo',
    sort_order: number ?? 0,
    current_session_id: null,
    archived_at: null,
    external_provider: null,
    external_id: null,
    ticket_prefix: number === null ? null : 'TD',
    ticket_number: number,
    parent_ticket_key: null,
    pending_launch_config: null,
    ...extra
  }) as KanbanTicket

const loadTickets = vi.fn(async () => {})

function seedBoard(tickets: KanbanTicket[], edges: [string, string][] = []): void {
  const dependencyMap = new Map<string, Set<string>>()
  for (const [dependent, blocker] of edges) {
    const key = ticketKey(PROJECT, dependent)
    dependencyMap.set(
      key,
      new Set([...(dependencyMap.get(key) ?? []), ticketKey(PROJECT, blocker)])
    )
  }
  useKanbanStore.setState({
    tickets: new Map([[PROJECT, tickets]]),
    dependencyMap,
    loadTickets
  } as never)
}

function seedRuns(...details: DocumentRunDetail[]): void {
  useDocumentFlowStore.setState({
    runsById: Object.fromEntries(details.map((detail) => [detail.run.id, detail])),
    loadedProjects: { [PROJECT]: true }
  })
}

function ControlledPicker({
  runId = null,
  initial = []
}: {
  runId?: string | null
  initial?: string[]
}): React.JSX.Element {
  const [ids, setIds] = useState<string[]>(initial)
  return (
    <>
      <TicketRunPicker
        projectId={PROJECT}
        runId={runId}
        selectedIds={ids}
        onSelectedIdsChange={setIds}
      />
      <output data-testid="picked">{ids.join(',')}</output>
    </>
  )
}

const orchestrator = (status: DocumentRunDetail['run']['status'] = 'running'): DocumentRunDetail =>
  makeDetail({ id: 'run-t', title: 'Login', source_kind: 'tickets', source_path: '', status }, [
    { key: 'TD-1', ticket_id: 't1', status: status === 'preview' ? 'pending' : 'merged' }
  ])

beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  api.list.mockImplementation(async () => Object.values(useDocumentFlowStore.getState().runsById))
})

afterEach(async () => {
  await act(async () => {})
  cleanup()
  vi.resetAllMocks()
  useDocumentFlowStore.setState(initialFlowState, true)
  useKanbanStore.setState(initialKanbanState, true)
})

describe('TicketRunPicker', () => {
  it('waits for the board, then lists it', async () => {
    useKanbanStore.setState({ tickets: new Map(), dependencyMap: new Map(), loadTickets } as never)
    seedRuns()
    let finish: () => void = () => {}
    loadTickets.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    await act(async () => {
      render(<ControlledPicker />)
    })
    expect(screen.getByTestId('docflow-ticket-picker-loading')).toBeInTheDocument()

    await act(async () => {
      useKanbanStore.setState({ tickets: new Map([[PROJECT, [ticket('t1', 1)]]]) } as never)
      finish()
    })
    expect(screen.getByTestId('docflow-ticket-row-t1')).toBeEnabled()
  })

  it('shows the tickets of the run it would join checked and locked', async () => {
    seedBoard([ticket('t1', 1), ticket('t2', 2)])
    seedRuns(orchestrator('preview'))
    await act(async () => {
      render(<ControlledPicker runId="run-t" />)
    })

    expect(screen.getByTestId('docflow-ticket-row-t1')).toBeDisabled()
    expect(screen.getByTestId('docflow-ticket-row-t1')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('docflow-ticket-row-refusal-t1')).toHaveTextContent(
      'It is already part of this run.'
    )
    // Not counted as picked: nothing new is chosen yet.
    expect(screen.getByTestId('docflow-ticket-picker-count')).toHaveTextContent(
      'No tickets selected'
    )
  })

  it('does not count a preselected ticket that cannot join', async () => {
    seedBoard([ticket('t1', 1, { current_session_id: 'session-1' }), ticket('t2', 2)])
    seedRuns()
    await act(async () => {
      render(<ControlledPicker initial={['t1', 't2']} />)
    })

    expect(screen.getByTestId('docflow-ticket-row-t1')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByTestId('docflow-ticket-picker-count')).toHaveTextContent('1 ticket selected')
  })

  it('adds every blocker left out, through the chain, with one click', async () => {
    seedBoard(
      [
        ticket('t1', 1),
        ticket('t2', 2),
        ticket('t3', 3),
        ticket('t4', null, { title: 'Keyless', sort_order: 4 })
      ],
      [
        ['t1', 't2'],
        ['t2', 't3'],
        ['t1', 't4']
      ]
    )
    seedRuns()
    await act(async () => {
      render(<ControlledPicker initial={['t1']} />)
    })

    expect(screen.getByTestId('docflow-ticket-picker-missing-blockers')).toHaveTextContent(
      'TD-1 waits for 2 tickets you have not picked.'
    )
    expect(screen.getByTestId('docflow-ticket-row-blockers-t1')).toHaveTextContent('blocked by 2')
    fireEvent.click(screen.getByTestId('docflow-ticket-picker-add-blockers'))
    expect(screen.getByTestId('picked')).toHaveTextContent('t1,t2,t3,t4')
  })

  it('keeps a picked ticket in view whatever the column filter says', async () => {
    // A ticket queued from the board sits In Progress with no session: it can join.
    seedBoard([ticket('t1', 1), ticket('t2', 2, { column: 'in_progress' })])
    seedRuns()
    await act(async () => {
      render(<ControlledPicker initial={['t2']} />)
    })

    const row = screen.getByTestId('docflow-ticket-row-t2')
    expect(row).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(row)
    expect(screen.getByTestId('picked')).toHaveTextContent('')
    // Unchecked, the filter applies to it again.
    expect(screen.queryByTestId('docflow-ticket-row-t2')).toBeNull()
  })

  it('finds a ticket by its key across columns once the column filter is cleared', async () => {
    seedBoard([ticket('t1', 1), ticket('t9', 9, { column: 'review' })])
    seedRuns()
    await act(async () => {
      render(<ControlledPicker />)
    })

    expect(screen.queryByTestId('docflow-ticket-row-t9')).toBeNull()
    fireEvent.click(screen.getByTestId('docflow-ticket-picker-column-todo'))
    fireEvent.change(screen.getByTestId('docflow-ticket-picker-search'), {
      target: { value: 'TD-9' }
    })
    expect(screen.getByTestId('docflow-ticket-row-t9')).toBeDisabled()
    expect(screen.queryByTestId('docflow-ticket-row-t1')).toBeNull()
  })
})

describe('AddRunTicketsDialog', () => {
  it('resumes a finished run with the tickets added', async () => {
    seedBoard([ticket('t1', 1, { column: 'merged' }), ticket('t2', 2)])
    const detail = orchestrator('completed')
    seedRuns(detail)
    api.addTickets.mockResolvedValue({ ...detail, run: { ...detail.run, status: 'running' } })
    const onOpenChange = vi.fn()
    await act(async () => {
      render(<AddRunTicketsDialog run={detail.run} open onOpenChange={onOpenChange} />)
    })

    expect(screen.getByTestId('docflow-add-tickets-resume-note')).toHaveTextContent(
      'The run resumes: these tickets launch on its integration branch.'
    )
    fireEvent.click(screen.getByTestId('docflow-ticket-row-t2'))
    expect(screen.getByTestId('docflow-add-tickets-confirm')).toHaveTextContent('Add & resume')
    await act(async () => {
      fireEvent.click(screen.getByTestId('docflow-add-tickets-confirm'))
    })
    expect(api.addTickets).toHaveBeenCalledWith({ runId: 'run-t', ticketIds: ['t2'] })
    expect(toast.success).toHaveBeenCalledWith('Added 1 ticket to Login')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('shows a ticket a finished run skipped as part of it, not as free to add', async () => {
    // TD-2 never launched (skipped) and sits in To Do; the finished run no longer owns it, but
    // the server leaves a ticket the run holds already as it is.
    seedBoard([ticket('t1', 1, { column: 'merged' }), ticket('t2', 2), ticket('t3', 3)])
    const finished = makeDetail(
      { id: 'run-t', title: 'Login', source_kind: 'tickets', source_path: '', status: 'completed' },
      [
        { key: 'TD-1', ticket_id: 't1', status: 'merged' },
        { key: 'TD-2', ticket_id: 't2', status: 'skipped' }
      ]
    )
    seedRuns(finished)
    await act(async () => {
      render(<AddRunTicketsDialog run={finished.run} open onOpenChange={vi.fn()} />)
    })

    expect(screen.getByTestId('docflow-ticket-row-t2')).toBeDisabled()
    expect(screen.getByTestId('docflow-ticket-row-t2')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('docflow-ticket-row-refusal-t2')).toHaveTextContent(
      'It is already part of this run.'
    )
    expect(screen.getByTestId('docflow-ticket-row-t3')).toBeEnabled()
  })

  it('keeps the pick and says why when the run refuses the tickets', async () => {
    seedBoard([ticket('t2', 2)])
    const detail = orchestrator('running')
    seedRuns(detail)
    api.addTickets.mockRejectedValue(new Error('TD-2 has a session now.'))
    const onOpenChange = vi.fn()
    await act(async () => {
      render(<AddRunTicketsDialog run={detail.run} open onOpenChange={onOpenChange} />)
    })

    fireEvent.click(screen.getByTestId('docflow-ticket-row-t2'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('docflow-add-tickets-confirm'))
    })
    expect(toast.error).toHaveBeenCalledWith('Could not add the tickets: TD-2 has a session now.')
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByTestId('docflow-ticket-row-t2')).toHaveAttribute('aria-checked', 'true')
  })

  it('takes nothing on a cancelled run', async () => {
    seedBoard([ticket('t2', 2)])
    const detail = orchestrator('cancelled')
    seedRuns(detail)
    await act(async () => {
      render(<AddRunTicketsDialog run={detail.run} open onOpenChange={vi.fn()} />)
    })

    expect(screen.getByTestId('docflow-add-tickets-refused')).toHaveTextContent(
      'This run was cancelled'
    )
    expect(screen.queryByTestId('docflow-ticket-picker')).toBeNull()
    expect(screen.getByTestId('docflow-add-tickets-confirm')).toBeDisabled()
  })
})

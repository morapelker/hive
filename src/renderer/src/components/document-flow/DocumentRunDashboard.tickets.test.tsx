// The run dashboard of an orchestrator made from board tickets (`source_kind: 'tickets'`): no
// document line and no source-file check, a "Made from N board tickets" line with "Add
// tickets", and — on the tickets that have not launched while the run is going — an editing
// panel (what the ticket starts after, its brief) and "Remove from run". Launched tickets stay
// read-only, and a document run's dashboard reads as it always did. The dialogs and editors the panel hosts have their own
// tests; here they are stand-ins that say they were mounted.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import type { DocumentRun, DocumentRunDetail, DocumentRunItem } from '@shared/types/document-flow'
import { DocumentRunDashboard } from './DocumentRunDashboard'
import { TEST_PROJECT, makeDetail, makeReport } from './test-fixtures'

const api = vi.hoisted(() => ({
  get: vi.fn(),
  sourceFile: vi.fn(),
  updateRun: vi.fn(),
  updateItem: vi.fn(),
  removeItem: vi.fn(),
  cancel: vi.fn(),
  finalize: vi.fn(),
  delete: vi.fn()
}))

vi.mock('@/api/document-flow-api', () => ({ documentFlowApi: api }))
vi.mock('@/api/project-api', () => ({ projectApi: { openPath: vi.fn() } }))
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))
vi.mock('./AddRunTicketsDialog', () => ({
  AddRunTicketsDialog: ({ run, open }: { run: DocumentRun; open: boolean }) =>
    open ? <div data-testid="stub-add-tickets-dialog">{run.id}</div> : null
}))
vi.mock('./RunItemDependencyEditor', () => ({
  RunItemDependencyEditor: ({
    item,
    items
  }: {
    item: DocumentRunItem
    items: readonly DocumentRunItem[]
  }) => (
    <div data-testid={`stub-deps-${item.key}`}>
      {item.depends_on.join(',')} of {items.length}
    </div>
  )
}))
vi.mock('./TicketBriefEditor', () => ({
  TicketBriefEditor: ({ item }: { item: DocumentRunItem }) => (
    <div data-testid={`stub-brief-${item.key}`}>{item.ticket_id}</div>
  )
}))

const initialFlowState = useDocumentFlowStore.getState()
const initialProjectState = useProjectStore.getState()
const initialWorktreeState = useWorktreeStore.getState()

const STARTED_AT = '2026-05-04T10:05:00.000Z'

/** A launched orchestrator: no document, its own ticket, items pointing at board tickets. */
const TICKETS_RUN = {
  source_kind: 'tickets',
  source_path: '',
  document_path: null,
  extraction: null,
  title: '',
  status: 'running',
  base_branch: 'main',
  base_sha: '1111111aaaaaaa',
  integration_branch: 'orch-checkout',
  integration_worktree_id: 'wt-integration',
  integration_worktree_path: '/worktrees/shop--orch-checkout',
  ticket_id: 'ticket-run',
  started_at: STARTED_AT
} as const satisfies Partial<DocumentRun>

const ticketItems = (): Partial<DocumentRunItem>[] => [
  { key: 'TD-1', status: 'merged', ticket_id: 't-1', session_id: 's-1', worktree_id: 'wt-1' },
  {
    key: 'TD-2',
    status: 'running',
    ticket_id: 't-2',
    session_id: 's-2',
    worktree_id: 'wt-2',
    depends_on: []
  },
  { key: 'TD-3', status: 'pending', ticket_id: 't-3', depends_on: ['TD-1'] },
  {
    key: 'TD-4',
    status: 'pending',
    ticket_id: 't-4',
    depends_on: ['TD-3'],
    created_at: '2026-05-04T11:00:00.000Z'
  }
]

const storedDetail = (runId: string): DocumentRunDetail =>
  useDocumentFlowStore.getState().runsById[runId]

async function renderDashboard(detail: DocumentRunDetail): Promise<void> {
  useDocumentFlowStore.setState({
    runsById: { [detail.run.id]: detail },
    dashboardRunId: detail.run.id
  })
  await act(async () => {
    render(<DocumentRunDashboard />)
  })
}

const click = async (testId: string): Promise<void> => {
  await act(async () => {
    fireEvent.click(screen.getByTestId(testId))
  })
}

beforeAll(() => {
  // Radix dialogs rely on these in a real browser; jsdom lacks them.
  Element.prototype.hasPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  api.get.mockImplementation(async (runId: string) => storedDetail(runId) ?? null)
  api.sourceFile.mockImplementation(async (runId: string) => ({
    path: storedDetail(runId).run.source_path,
    exists: true
  }))
  // The server's side of "Remove from run": the item goes, the rest of the run stays.
  api.removeItem.mockImplementation(
    async ({ runId, itemId }: { runId: string; itemId: string }) => {
      const detail = storedDetail(runId)
      return { ...detail, items: detail.items.filter((item) => item.id !== itemId) }
    }
  )
  useProjectStore.setState({ projects: [TEST_PROJECT] } as never)
})

afterEach(async () => {
  await act(async () => {})
  cleanup()
  vi.resetAllMocks()
  useDocumentFlowStore.setState(initialFlowState, true)
  useProjectStore.setState(initialProjectState, true)
  useWorktreeStore.setState(initialWorktreeState, true)
})

describe('DocumentRunDashboard — orchestrator made from board tickets: header', () => {
  it('names the board tickets instead of a document, and never checks a source file', async () => {
    await renderDashboard(makeDetail(TICKETS_RUN, ticketItems()))

    expect(api.sourceFile).not.toHaveBeenCalled()
    expect(screen.queryByTestId('docflow-source-line')).toBeNull()
    expect(screen.queryByTestId('docflow-open-document-btn')).toBeNull()
    expect(screen.queryByTestId('docflow-document-missing')).toBeNull()
    expect(screen.queryByTestId('docflow-document-lane')).toBeNull()
    expect(screen.getByTestId('docflow-tickets-source-count')).toHaveTextContent(
      'Made from 4 board tickets'
    )
    // No file name to fall back on: the run's kind is its name until it has a title
    const dialog = screen.getByTestId('docflow-dashboard')
    expect(within(dialog).getByRole('heading', { name: 'Orchestrator' })).toBeInTheDocument()
    expect(dialog).toHaveAccessibleDescription('Progress of the orchestrator')
    // The engine is the same: the integration branch line is there as for a document run
    expect(screen.getByTestId('docflow-integration-branch')).toHaveTextContent('orch-checkout')
  })

  it('opens "Add tickets" from the header of a running run', async () => {
    await renderDashboard(makeDetail(TICKETS_RUN, ticketItems()))

    const add = screen.getByTestId('docflow-dashboard-add-tickets')
    expect(add).toHaveTextContent('Add tickets')
    expect(add).toBeEnabled()
    expect(screen.queryByTestId('stub-add-tickets-dialog')).toBeNull()

    await click('docflow-dashboard-add-tickets')

    expect(screen.getByTestId('stub-add-tickets-dialog')).toHaveTextContent('run-1')
  })

  it('says that adding tickets resumes a finished run', async () => {
    await renderDashboard(
      makeDetail({ ...TICKETS_RUN, status: 'completed', report: makeReport() }, [
        { key: 'TD-1', status: 'merged', ticket_id: 't-1' }
      ])
    )

    expect(screen.getByTestId('docflow-dashboard-add-tickets')).toHaveTextContent(
      'Add tickets & resume'
    )
    expect(screen.getByTestId('docflow-dashboard-add-tickets')).toBeEnabled()
  })

  it('offers no resume once the integration worktree of a finished run was archived', async () => {
    const finished = makeDetail({ ...TICKETS_RUN, status: 'completed', report: makeReport() }, [
      { key: 'TD-1', status: 'merged', ticket_id: 't-1' }
    ])
    // Merging the run's ticket archived the integration worktree: nothing left to resume on
    useWorktreeStore.setState({ worktreesByProject: new Map([[TEST_PROJECT.id, []]]) })
    await renderDashboard(finished)
    expect(screen.getByTestId('docflow-tickets-source-line')).toBeInTheDocument()
    expect(screen.queryByTestId('docflow-dashboard-add-tickets')).toBeNull()
    cleanup()

    // Still there: the run resumes on it
    useWorktreeStore.setState({
      worktreesByProject: new Map([[TEST_PROJECT.id, [{ id: 'wt-integration' }]]])
    } as never)
    await renderDashboard(finished)
    expect(screen.getByTestId('docflow-dashboard-add-tickets')).toHaveTextContent(
      'Add tickets & resume'
    )
  })

  it('takes no tickets while the migrations run, and offers none to a cancelled run', async () => {
    await renderDashboard(
      makeDetail(
        {
          ...TICKETS_RUN,
          status: 'completed',
          report: makeReport({ migrations: ['db/001.sql'] }),
          migration_session_id: 'session-migrations'
        },
        [{ key: 'TD-1', status: 'merged', ticket_id: 't-1' }]
      )
    )
    expect(screen.getByTestId('docflow-dashboard-add-tickets')).toBeDisabled()
    cleanup()

    await renderDashboard(makeDetail({ ...TICKETS_RUN, status: 'cancelled' }, ticketItems()))
    expect(screen.getByTestId('docflow-tickets-source-line')).toBeInTheDocument()
    expect(screen.queryByTestId('docflow-dashboard-add-tickets')).toBeNull()
  })

  it('says the board tickets stay when the run is deleted', async () => {
    await renderDashboard(makeDetail({ ...TICKETS_RUN, status: 'cancelled' }, ticketItems()))

    await click('docflow-delete-run-btn')

    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'The board tickets stay on the board (they are only taken out of the orchestrator).'
    )
    expect(screen.getByRole('alertdialog')).not.toHaveTextContent('spec text')
  })
})

describe('DocumentRunDashboard — orchestrator made from board tickets: tickets', () => {
  it('offers Edit and Remove on a ticket that has not launched, never on one that did', async () => {
    await renderDashboard(makeDetail(TICKETS_RUN, ticketItems()))

    for (const key of ['TD-3', 'TD-4']) {
      expect(screen.getByTestId(`docflow-item-edit-${key}`)).toBeInTheDocument()
      expect(screen.getByTestId(`docflow-item-remove-${key}`)).toBeInTheDocument()
    }
    for (const key of ['TD-1', 'TD-2']) {
      expect(screen.queryByTestId(`docflow-item-edit-${key}`)).toBeNull()
      expect(screen.queryByTestId(`docflow-item-remove-${key}`)).toBeNull()
    }
  })

  it('opens one editing panel at a time, with what the ticket starts after and its brief', async () => {
    await renderDashboard(makeDetail(TICKETS_RUN, ticketItems()))
    expect(screen.queryByTestId('docflow-item-editor-TD-3')).toBeNull()

    await click('docflow-item-edit-TD-3')

    const panel = screen.getByTestId('docflow-item-editor-TD-3')
    expect(within(panel).getByTestId('stub-deps-TD-3')).toHaveTextContent('TD-1 of 4')
    expect(within(panel).getByTestId('stub-brief-TD-3')).toHaveTextContent('t-3')
    expect(screen.getByTestId('docflow-item-edit-TD-3')).toHaveAttribute('aria-pressed', 'true')
    // A live run says what a change can set off
    expect(panel).toHaveTextContent('Pause the run to make several changes first.')

    await click('docflow-item-edit-TD-4')
    expect(screen.queryByTestId('docflow-item-editor-TD-3')).toBeNull()
    expect(screen.getByTestId('docflow-item-editor-TD-4')).toBeInTheDocument()

    await click('docflow-item-edit-TD-4')
    expect(screen.queryByTestId('docflow-item-editor-TD-4')).toBeNull()
  })

  it('closes the panel once its ticket launched', async () => {
    const detail = makeDetail(TICKETS_RUN, ticketItems())
    await renderDashboard(detail)
    await click('docflow-item-edit-TD-3')
    expect(screen.getByTestId('docflow-item-editor-TD-3')).toBeInTheDocument()

    await act(async () => {
      useDocumentFlowStore.getState().applyDetail({
        ...detail,
        items: detail.items.map((item) =>
          item.key === 'TD-3' ? { ...item, status: 'launching' } : item
        )
      })
    })

    expect(screen.queryByTestId('docflow-item-editor-TD-3')).toBeNull()
    expect(screen.queryByTestId('docflow-item-edit-TD-3')).toBeNull()
  })

  it('removes a ticket from the run only after confirmation, naming who stops waiting', async () => {
    await renderDashboard(makeDetail(TICKETS_RUN, ticketItems()))

    await click('docflow-item-remove-TD-3')
    const confirm = screen.getByTestId('docflow-item-remove-dialog')
    expect(confirm).toHaveTextContent('Remove TD-3 from the run?')
    expect(confirm).toHaveTextContent('TD-3 leaves the run and stays on the board')
    expect(confirm).toHaveTextContent('TD-4 starts after it and will no longer wait for it.')
    expect(api.removeItem).not.toHaveBeenCalled()

    await click('docflow-item-remove-cancel')
    expect(api.removeItem).not.toHaveBeenCalled()
    expect(screen.getByTestId('docflow-row-TD-3')).toBeInTheDocument()

    await click('docflow-item-remove-TD-3')
    await click('docflow-item-remove-confirm')

    expect(api.removeItem).toHaveBeenCalledWith({ runId: 'run-1', itemId: 'item-TD-3' })
    expect(screen.queryByTestId('docflow-row-TD-3')).toBeNull()
  })

  it('drops the confirmation when the ticket launches before it is answered', async () => {
    const detail = makeDetail(TICKETS_RUN, ticketItems())
    await renderDashboard(detail)
    await click('docflow-item-remove-TD-3')
    expect(screen.getByTestId('docflow-item-remove-dialog')).toBeInTheDocument()

    const launched = (status: DocumentRunItem['status']): DocumentRunDetail => ({
      ...detail,
      items: detail.items.map((item) => (item.key === 'TD-3' ? { ...item, status } : item))
    })
    await act(async () => {
      useDocumentFlowStore.getState().applyDetail(launched('launching'))
    })
    expect(screen.queryByTestId('docflow-item-remove-dialog')).toBeNull()

    // Waiting again later (its launch failed without a session) does not bring it back
    await act(async () => {
      useDocumentFlowStore.getState().applyDetail(launched('pending'))
    })
    expect(screen.queryByTestId('docflow-item-remove-dialog')).toBeNull()
    expect(api.removeItem).not.toHaveBeenCalled()
  })

  it('reports a removal the server refused, and keeps the row', async () => {
    const { toast } = await import('@/lib/toast')
    api.removeItem.mockRejectedValue(new Error('TD-3 launched meanwhile'))
    await renderDashboard(makeDetail(TICKETS_RUN, ticketItems()))

    await click('docflow-item-remove-TD-3')
    await click('docflow-item-remove-confirm')

    expect(toast.error).toHaveBeenCalledWith(
      'Could not take TD-3 out of the run: TD-3 launched meanwhile'
    )
    expect(screen.getByTestId('docflow-row-TD-3')).toBeInTheDocument()
  })

  it('marks the tickets that joined after launch, on their row and in the report', async () => {
    await renderDashboard(
      makeDetail(
        {
          ...TICKETS_RUN,
          status: 'completed_with_issues',
          report: makeReport({
            merged: [
              { key: 'TD-1', title: 'Task TD-1', mergeSha: null, summary: null },
              { key: 'TD-4', title: 'Task TD-4', mergeSha: null, summary: null }
            ]
          })
        },
        ticketItems()
      )
    )

    expect(screen.getByTestId('docflow-row-added-TD-4')).toHaveTextContent('added mid-run')
    expect(screen.queryByTestId('docflow-row-added-TD-3')).toBeNull()
    expect(screen.getByTestId('docflow-report-added-TD-4')).toBeInTheDocument()
    expect(screen.queryByTestId('docflow-report-added-TD-1')).toBeNull()
  })

  it('locks every ticket once the run is over', async () => {
    await renderDashboard(
      makeDetail({ ...TICKETS_RUN, status: 'completed', report: makeReport() }, ticketItems())
    )
    expect(screen.queryByTestId('docflow-item-edit-TD-3')).toBeNull()
    expect(screen.queryByTestId('docflow-item-remove-TD-3')).toBeNull()
  })
})

describe('DocumentRunDashboard — a document run is untouched', () => {
  it('still checks its document, and offers no ticket editing on a ticket that waits', async () => {
    await renderDashboard(
      makeDetail(
        {
          status: 'running',
          integration_branch: 'doc-checkout-redesign',
          integration_worktree_id: 'wt-integration',
          started_at: STARTED_AT
        },
        [
          { key: 'A1', status: 'pending' },
          { key: 'A2', status: 'pending', created_at: '2026-05-04T11:00:00.000Z' }
        ]
      )
    )

    expect(api.sourceFile).toHaveBeenCalledWith('run-1')
    expect(screen.getByTestId('docflow-source-line')).toBeInTheDocument()
    expect(screen.queryByTestId('docflow-tickets-source-line')).toBeNull()
    expect(screen.queryByTestId('docflow-dashboard-add-tickets')).toBeNull()
    expect(screen.queryByTestId('docflow-item-edit-A1')).toBeNull()
    expect(screen.queryByTestId('docflow-item-remove-A1')).toBeNull()
    expect(screen.queryByTestId('docflow-row-added-A2')).toBeNull()
    expect(screen.getByTestId('docflow-dashboard')).toHaveAccessibleDescription(
      'Progress of the document run Checkout redesign'
    )
  })
})

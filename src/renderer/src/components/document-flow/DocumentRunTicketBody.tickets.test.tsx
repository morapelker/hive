// The run ticket's card body and the active runs card for an orchestrator made from board
// tickets: the "Orchestrator" marker instead of "Document run", no document footer even when
// the ticket row still carries a path, a title that is not a file name, and a header that
// counts runs in the words of their kind.
import { act, cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import type { DocumentRunDetail } from '@shared/types/document-flow'
import { DocumentRunTicketBody } from './DocumentRunTicketBody'
import { DocumentRunsIndicator } from './DocumentRunsIndicator'
import { runBoardCardState } from './document-flow-ui'
import { makeDetail } from './test-fixtures'

vi.mock('@/api/document-flow-api', () => ({ documentFlowApi: { get: vi.fn(async () => null) } }))

const TICKETS = { source_kind: 'tickets', source_path: '', document_path: null } as const

const initialFlowState = useDocumentFlowStore.getState()

afterEach(async () => {
  await act(async () => {})
  cleanup()
  useDocumentFlowStore.setState(initialFlowState, true)
})

const renderBody = (detail: DocumentRunDetail, documentPath: string | null = null): void => {
  render(
    <DocumentRunTicketBody
      runId={detail.run.id}
      view={{ state: runBoardCardState(detail, 'in_progress'), missing: false }}
      documentPath={documentPath}
    />
  )
}

describe('DocumentRunTicketBody — orchestrator made from board tickets', () => {
  it('wears the Orchestrator marker and names no document', () => {
    // A stale path on the ticket row is not shown: the run has no document
    renderBody(makeDetail({ ...TICKETS, status: 'running' }), '/docs/old.html')

    const marker = screen.getByTestId('kanban-docflow-run-marker-run-1')
    expect(marker).toHaveTextContent('Orchestrator')
    expect(marker).not.toHaveTextContent('Document run')
    expect(marker).toHaveAttribute('data-run-kind', 'tickets')
    expect(screen.queryByTestId('kanban-docflow-run-footer-run-1')).toBeNull()
    expect(screen.getByTestId('kanban-docflow-run-progress-run-1')).toHaveTextContent('0/3 merged')
  })

  it('still says Error in the footer of an orchestrator with issues', () => {
    render(
      <DocumentRunTicketBody
        runId="run-1"
        view={{
          state: runBoardCardState(makeDetail({ ...TICKETS, status: 'completed_with_issues' })),
          missing: false
        }}
        error
      />
    )
    expect(screen.getByTestId('kanban-docflow-run-footer-run-1')).toHaveTextContent('Error')
  })

  it('keeps the document run card as it was', () => {
    renderBody(makeDetail({ status: 'running' }), '/docs/checkout-redesign.html')

    const marker = screen.getByTestId('kanban-docflow-run-marker-run-1')
    expect(marker).toHaveTextContent('Document run')
    expect(marker).not.toHaveAttribute('data-run-kind')
    expect(screen.getByTestId('kanban-docflow-run-footer-run-1')).toHaveTextContent(
      'checkout-redesign.html'
    )
  })
})

describe('DocumentRunsIndicator — orchestrators', () => {
  const seed = (...details: DocumentRunDetail[]): void => {
    useDocumentFlowStore.setState({
      runsById: Object.fromEntries(details.map((detail) => [detail.run.id, detail]))
    })
  }

  it('counts orchestrators as such, and names an untitled one by its kind', () => {
    seed(
      makeDetail({ ...TICKETS, id: 'run-a', status: 'running', title: '' }),
      makeDetail({ ...TICKETS, id: 'run-b', status: 'paused', title: 'Billing' })
    )
    render(<DocumentRunsIndicator />)

    expect(screen.getByTestId('docflow-runs-indicator-toggle')).toHaveTextContent('2 orchestrators')
    expect(screen.getByTestId('docflow-indicator-run-run-a')).toHaveTextContent('Orchestrator')
    expect(screen.getByTestId('docflow-indicator-run-run-b')).toHaveTextContent('Billing')
  })

  it('speaks of runs for a mix, and marks each row with its kind', () => {
    seed(
      makeDetail({ id: 'run-doc', status: 'running', title: '' }),
      makeDetail({ ...TICKETS, id: 'run-orch', status: 'running', title: '' })
    )
    render(<DocumentRunsIndicator />)

    expect(screen.getByTestId('docflow-runs-indicator-toggle')).toHaveTextContent('2 runs')
    const doc = screen.getByTestId('docflow-indicator-run-run-doc')
    expect(doc).toHaveTextContent('checkout-redesign.html')
    expect(within(doc).getByLabelText('Document run')).toBeInTheDocument()
    const orch = screen.getByTestId('docflow-indicator-run-run-orch')
    expect(within(orch).getByLabelText('Orchestrator')).toBeInTheDocument()
  })
})

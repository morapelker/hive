import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PR_STACK_RIGHT_PX } from '@/components/pr/PRNotificationStack'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { useTedoooAgentStore } from '@/stores/useTedoooAgentStore'
import { USER_INTERRUPT_DETAIL, WAITING_PREFIX } from '@shared/document-flow/planning'
import type { DocumentRunDetail } from '@shared/types/document-flow'
import { DocumentRunsIndicator } from './DocumentRunsIndicator'
import { makeDetail } from './test-fixtures'

const api = vi.hoisted(() => ({ get: vi.fn() }))

vi.mock('@/api/document-flow-api', () => ({ documentFlowApi: api }))

const initialFlowState = useDocumentFlowStore.getState()
const initialLayoutState = useLayoutStore.getState()
const initialAgentState = useTedoooAgentStore.getState()

function seedRuns(...details: DocumentRunDetail[]): void {
  useDocumentFlowStore.setState({
    runsById: Object.fromEntries(details.map((detail) => [detail.run.id, detail]))
  })
}

beforeEach(() => {
  api.get.mockImplementation(
    async (runId: string) => useDocumentFlowStore.getState().runsById[runId] ?? null
  )
  useLayoutStore.setState({ rightSidebarCollapsed: true })
  useTedoooAgentStore.setState({ isOpen: false })
})

afterEach(async () => {
  await act(async () => {})
  cleanup()
  vi.resetAllMocks()
  useDocumentFlowStore.setState(initialFlowState, true)
  useLayoutStore.setState(initialLayoutState, true)
  useTedoooAgentStore.setState(initialAgentState, true)
})

describe('DocumentRunsIndicator', () => {
  it('renders nothing without a launched, unfinished run', () => {
    seedRuns(
      makeDetail({ id: 'run-preview', status: 'preview' }),
      makeDetail({ id: 'run-extracting', status: 'extracting' }, []),
      makeDetail({ id: 'run-done', status: 'completed' }, [{ key: 'A1', status: 'merged' }]),
      makeDetail({ id: 'run-cancelled', status: 'cancelled' })
    )
    render(<DocumentRunsIndicator />)

    expect(screen.queryByTestId('docflow-runs-indicator')).toBeNull()
  })

  it('shows title and counts of a running run, without markers when nothing needs the user', () => {
    seedRuns(
      makeDetail({ id: 'run-live', status: 'running', title: 'Checkout redesign' }, [
        { key: 'A1', status: 'merged' },
        { key: 'A2', status: 'running' },
        { key: 'A3', status: 'verifying' },
        { key: 'A4', status: 'pending' },
        { key: 'A5', status: 'pending', selected: false }
      ])
    )
    render(<DocumentRunsIndicator />)

    expect(screen.getByTestId('docflow-indicator-run-run-live')).toHaveTextContent(
      'Checkout redesign'
    )
    expect(screen.getByTestId('docflow-indicator-progress-run-live')).toHaveTextContent(
      '1/4 merged · 2 working'
    )
    expect(screen.queryByTestId('docflow-indicator-needs-you-run-live')).toBeNull()
    expect(screen.queryByTestId('docflow-indicator-paused-run-live')).toBeNull()
  })

  it('marks a run with a ticket that needs the user', () => {
    seedRuns(
      makeDetail({ id: 'run-live', status: 'running' }, [
        { key: 'A1', status: 'needs_input' },
        { key: 'A2', status: 'running' }
      ])
    )
    render(<DocumentRunsIndicator />)

    expect(screen.getByTestId('docflow-indicator-needs-you-run-live')).toHaveTextContent(
      'needs you'
    )
  })

  it('marks a run whose conflict or fix session stopped for the user, by the orchestrator marker only', () => {
    seedRuns(
      makeDetail({ id: 'run-conflict', status: 'running' }, [
        { key: 'A1', status: 'resolving_conflicts', status_detail: USER_INTERRUPT_DETAIL },
        { key: 'A2', status: 'running' }
      ]),
      makeDetail({ id: 'run-fix', status: 'running' }, [
        { key: 'A1', status: 'fixing', status_detail: `${WAITING_PREFIX}a permission request` }
      ]),
      makeDetail({ id: 'run-busy', status: 'running' }, [
        { key: 'A1', status: 'fixing', status_detail: 'Fixing the checks you asked for' }
      ])
    )
    render(<DocumentRunsIndicator />)

    expect(screen.getByTestId('docflow-indicator-needs-you-run-conflict')).toBeInTheDocument()
    expect(screen.getByTestId('docflow-indicator-needs-you-run-fix')).toBeInTheDocument()
    expect(screen.queryByTestId('docflow-indicator-needs-you-run-busy')).toBeNull()
  })

  it('marks a paused run, and lists every active run oldest first', () => {
    seedRuns(
      makeDetail(
        { id: 'run-b', status: 'paused', title: 'Second', created_at: '2026-05-05T10:00:00.000Z' },
        [{ key: 'A1', status: 'running' }]
      ),
      makeDetail(
        { id: 'run-a', status: 'running', title: 'First', created_at: '2026-05-04T10:00:00.000Z' },
        [{ key: 'A1', status: 'running' }]
      )
    )
    render(<DocumentRunsIndicator />)

    expect(screen.getByTestId('docflow-indicator-paused-run-b')).toHaveTextContent('paused')
    expect(screen.queryByTestId('docflow-indicator-paused-run-a')).toBeNull()
    expect(screen.getByTestId('docflow-runs-indicator-toggle')).toHaveTextContent('2 document runs')
    const titles = screen
      .getAllByTestId(/^docflow-indicator-run-/)
      .map((row) => row.getAttribute('data-testid'))
    expect(titles).toEqual(['docflow-indicator-run-run-a', 'docflow-indicator-run-run-b'])
  })

  it('opens the dashboard of the run that is clicked', async () => {
    seedRuns(makeDetail({ id: 'run-live', status: 'running' }, [{ key: 'A1', status: 'running' }]))
    render(<DocumentRunsIndicator />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('docflow-indicator-run-run-live'))
    })

    expect(useDocumentFlowStore.getState().dashboardRunId).toBe('run-live')
  })

  it('collapses to its header, keeping a marker when a run needs the user', () => {
    seedRuns(
      makeDetail({ id: 'run-live', status: 'running' }, [{ key: 'A1', status: 'needs_attention' }])
    )
    render(<DocumentRunsIndicator />)

    fireEvent.click(screen.getByTestId('docflow-runs-indicator-toggle'))

    expect(screen.queryByTestId('docflow-indicator-run-run-live')).toBeNull()
    expect(screen.getByLabelText('Needs you')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('docflow-runs-indicator-toggle'))
    expect(screen.getByTestId('docflow-indicator-run-run-live')).toBeInTheDocument()
  })

  it('disappears when the last active run finishes', () => {
    seedRuns(makeDetail({ id: 'run-live', status: 'running' }, [{ key: 'A1', status: 'running' }]))
    render(<DocumentRunsIndicator />)
    expect(screen.getByTestId('docflow-runs-indicator')).toBeInTheDocument()

    act(() => {
      useDocumentFlowStore
        .getState()
        .applyDetail(
          makeDetail({ id: 'run-live', status: 'completed' }, [{ key: 'A1', status: 'merged' }])
        )
    })

    expect(screen.queryByTestId('docflow-runs-indicator')).toBeNull()
  })

  it('stays clear of the right sidebar and the open agent panel', () => {
    seedRuns(makeDetail({ id: 'run-live', status: 'running' }, [{ key: 'A1', status: 'running' }]))
    useLayoutStore.setState({ rightSidebarCollapsed: false, rightSidebarWidth: 300 })
    useTedoooAgentStore.setState({ isOpen: true, isMinimized: false, width: 400 })
    render(<DocumentRunsIndicator />)

    expect(screen.getByTestId('docflow-runs-indicator')).toHaveStyle({
      right: `${PR_STACK_RIGHT_PX + 400 + 300}px`
    })

    act(() => {
      useLayoutStore.setState({ rightSidebarCollapsed: true })
      useTedoooAgentStore.setState({ isMinimized: true })
    })
    expect(screen.getByTestId('docflow-runs-indicator')).toHaveStyle({
      right: `${PR_STACK_RIGHT_PX}px`
    })
  })
})

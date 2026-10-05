import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getRendererRpcClient, setRendererRpcClient } from '@/api/rpc-client'
import { toast } from '@/lib/toast'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { USER_INTERRUPT_DETAIL, WAITING_PREFIX } from '@shared/document-flow/planning'
import type {
  DocumentRunDetail,
  DocumentRunItemPatch,
  DocumentRunPatch,
  DocumentRunVerdict
} from '@shared/types/document-flow'
import { DocumentRunDashboard } from './DocumentRunDashboard'
import { TEST_PROJECT, makeDetail, makeReport } from './test-fixtures'

const api = vi.hoisted(() => ({
  get: vi.fn(),
  updateRun: vi.fn(),
  updateItem: vi.fn(),
  cancel: vi.fn(),
  finalize: vi.fn(),
  delete: vi.fn()
}))

vi.mock('@/api/document-flow-api', () => ({ documentFlowApi: api }))
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

const defaultRpcClient = getRendererRpcClient()
const initialFlowState = useDocumentFlowStore.getState()
const initialProjectState = useProjectStore.getState()
const initialWorktreeState = useWorktreeStore.getState()
const initialWorktreeStatusState = useWorktreeStatusStore.getState()
const initialSessionState = useSessionStore.getState()
const initialKanbanState = useKanbanStore.getState()

const QUESTION_VERDICT: DocumentRunVerdict = {
  status: 'needs_input',
  reason: 'The agent stopped to ask.',
  question: 'Should guests be able to check out?',
  summary: null,
  migrations: [],
  manualSteps: [],
  confidence: 'high',
  source: 'model',
  classifiedAt: '2026-05-04T10:00:00.000Z'
}

const LAUNCHED = {
  status: 'running',
  base_branch: 'main',
  base_sha: '1111111aaaaaaa',
  integration_branch: 'doc-checkout-redesign',
  integration_worktree_id: 'wt-integration',
  integration_worktree_path: '/worktrees/shop--doc-checkout-redesign',
  started_at: '2026-05-04T10:05:00.000Z'
} as const

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

beforeEach(() => {
  // The server's side of the store actions: apply the patch to the stored row.
  api.updateItem.mockImplementation(
    async (runId: string, itemId: string, patch: DocumentRunItemPatch) => ({
      ...storedDetail(runId).items.find((item) => item.id === itemId),
      ...patch
    })
  )
  api.updateRun.mockImplementation(async (runId: string, patch: DocumentRunPatch) => ({
    ...storedDetail(runId).run,
    status: patch.status ?? storedDetail(runId).run.status
  }))
  api.get.mockImplementation(async (runId: string) => storedDetail(runId) ?? null)
  useProjectStore.setState({ projects: [TEST_PROJECT] } as never)
})

afterEach(async () => {
  await act(async () => {})
  cleanup()
  vi.resetAllMocks()
  setRendererRpcClient(defaultRpcClient)
  useDocumentFlowStore.setState(initialFlowState, true)
  useProjectStore.setState(initialProjectState, true)
  useWorktreeStore.setState(initialWorktreeState, true)
  useWorktreeStatusStore.setState(initialWorktreeStatusState, true)
  useSessionStore.setState(initialSessionState, true)
  useKanbanStore.setState(initialKanbanState, true)
})

describe('DocumentRunDashboard — header', () => {
  it('renders nothing while no run is open', () => {
    render(<DocumentRunDashboard />)
    expect(screen.queryByTestId('docflow-dashboard')).toBeNull()
  })

  it('shows status, branches and merge progress of a running run', async () => {
    await renderDashboard(
      makeDetail(LAUNCHED, [
        { key: 'A1', status: 'merged' },
        { key: 'A2', status: 'running' },
        { key: 'A3', status: 'pending' },
        { key: 'A4', status: 'pending', selected: false }
      ])
    )

    expect(screen.getByTestId('docflow-dashboard-status')).toHaveTextContent('Running')
    expect(screen.getByTestId('docflow-integration-branch')).toHaveTextContent(
      'doc-checkout-redesign'
    )
    expect(screen.getByTestId('docflow-base-branch-line')).toHaveTextContent('from main @ 1111111')
    // Deselected tickets are not part of the total.
    expect(screen.getByTestId('docflow-progress-label')).toHaveTextContent('1 / 3 merged')
    const bar = screen.getByTestId('docflow-progress-bar')
    expect(within(bar).getByTestId('docflow-progress-merged')).toHaveStyle({ flexGrow: '1' })
    expect(within(bar).getByTestId('docflow-progress-inProgress')).toBeInTheDocument()
    expect(within(bar).queryByTestId('docflow-progress-attention')).toBeNull()
  })

  it('reads "Waiting for you" when everything left is behind a question', async () => {
    await renderDashboard(
      makeDetail(LAUNCHED, [
        { key: 'A1', status: 'needs_input' },
        { key: 'A2', depends_on: ['A1'] }
      ])
    )
    expect(screen.getByTestId('docflow-dashboard-status')).toHaveTextContent('Waiting for you')
  })

  it('pauses a running run and resumes a paused one', async () => {
    await renderDashboard(makeDetail(LAUNCHED, [{ key: 'A1', status: 'running' }]))
    expect(screen.queryByTestId('docflow-resume-btn')).toBeNull()

    await click('docflow-pause-btn')
    expect(api.updateRun).toHaveBeenLastCalledWith('run-1', { status: 'paused' })
    expect(screen.getByTestId('docflow-dashboard-status')).toHaveTextContent('Paused')

    await click('docflow-resume-btn')
    expect(api.updateRun).toHaveBeenLastCalledWith('run-1', { status: 'running' })
    expect(screen.getByTestId('docflow-dashboard-status')).toHaveTextContent('Running')
  })

  it('finishes early only after confirmation: skips what is open, then builds the report', async () => {
    const detail = makeDetail(LAUNCHED, [
      { key: 'A1', status: 'merged' },
      { key: 'A2', status: 'running' },
      { key: 'A3', status: 'pending' },
      { key: 'A4', status: 'pending', selected: false }
    ])
    api.finalize.mockImplementation(async (runId: string) => ({
      ...storedDetail(runId),
      run: { ...storedDetail(runId).run, status: 'completed_with_issues', report: makeReport() }
    }))
    await renderDashboard(detail)

    await click('docflow-finish-btn')
    expect(api.finalize).not.toHaveBeenCalled()
    expect(screen.getByText('Finish the run now?')).toBeInTheDocument()
    await click('docflow-confirm-action')

    const skipped = api.updateItem.mock.calls.map(([, itemId, patch]) => [itemId, patch.status])
    expect(skipped).toEqual([
      ['item-A2', 'skipped'],
      ['item-A3', 'skipped']
    ])
    expect(api.finalize).toHaveBeenCalledWith('run-1')
    expect(screen.getByTestId('docflow-dashboard-status')).toHaveTextContent(
      'Completed with issues'
    )
    expect(screen.getByTestId('docflow-report')).toBeInTheDocument()
    // A finished run can no longer be paused, finished or cancelled, but it can be deleted.
    expect(screen.queryByTestId('docflow-pause-btn')).toBeNull()
    expect(screen.queryByTestId('docflow-finish-btn')).toBeNull()
    expect(screen.queryByTestId('docflow-cancel-run-btn')).toBeNull()
    expect(screen.getByTestId('docflow-delete-run-btn')).toBeInTheDocument()
  })

  it('cancels the run only after confirmation', async () => {
    api.cancel.mockImplementation(async (runId: string) => ({
      ...storedDetail(runId),
      run: { ...storedDetail(runId).run, status: 'cancelled' }
    }))
    await renderDashboard(makeDetail(LAUNCHED, [{ key: 'A1', status: 'running' }]))

    await click('docflow-cancel-run-btn')
    expect(screen.getByText(/Sessions, branches and worktrees are kept/)).toBeInTheDocument()
    await click('docflow-confirm-cancel')
    expect(api.cancel).not.toHaveBeenCalled()

    await click('docflow-cancel-run-btn')
    await click('docflow-confirm-action')
    expect(api.cancel).toHaveBeenCalledWith('run-1')
    expect(screen.getByTestId('docflow-dashboard-status')).toHaveTextContent('Cancelled')
  })

  it('offers Delete only for runs that are not live, and closes after deleting', async () => {
    api.delete.mockResolvedValue(true)
    await renderDashboard(makeDetail(LAUNCHED, [{ key: 'A1', status: 'running' }]))
    expect(screen.queryByTestId('docflow-delete-run-btn')).toBeNull()
    cleanup()

    await renderDashboard(
      makeDetail({ ...LAUNCHED, status: 'completed' }, [
        { key: 'A1', status: 'merged', ticket_id: 'ticket-A1' }
      ])
    )
    await click('docflow-delete-run-btn')
    // The run's tickets attach its spec text and figures by path, so those files stay.
    expect(
      screen.getByText(
        /The run and its report are removed from the list\. Branches, worktrees and board tickets are not touched, and the spec text and figures those tickets attach stay on disk\./
      )
    ).toBeInTheDocument()
    await click('docflow-confirm-action')

    expect(api.delete).toHaveBeenCalledWith('run-1')
    expect(useDocumentFlowStore.getState().dashboardRunId).toBeNull()
    expect(screen.queryByTestId('docflow-dashboard')).toBeNull()
  })

  it('says that deleting a run that never launched removes its files too', async () => {
    await renderDashboard(makeDetail({ status: 'preview' }))
    await click('docflow-delete-run-btn')

    expect(
      screen.getByText(/Its spec text and figures are removed from disk as well\./)
    ).toBeInTheDocument()
    await click('docflow-confirm-cancel')
    expect(api.delete).not.toHaveBeenCalled()
  })

  it('reports a failed action instead of failing silently', async () => {
    api.updateRun.mockRejectedValue(new Error('Lease lost'))
    await renderDashboard(makeDetail(LAUNCHED, [{ key: 'A1', status: 'running' }]))

    await click('docflow-pause-btn')

    expect(toast.error).toHaveBeenCalledWith('Could not pause the run: Lease lost')
    expect(screen.getByTestId('docflow-dashboard-status')).toHaveTextContent('Running')
    expect(screen.getByTestId('docflow-pause-btn')).not.toBeDisabled()
  })

  it('selects the integration worktree and closes with "Open worktree"', async () => {
    await renderDashboard(makeDetail(LAUNCHED, [{ key: 'A1', status: 'running' }]))

    await click('docflow-open-worktree')

    expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-integration')
    expect(useProjectStore.getState().selectedProjectId).toBe(TEST_PROJECT.id)
    expect(useDocumentFlowStore.getState().dashboardRunId).toBeNull()
  })

  it('closes when the run it was opened on no longer exists', async () => {
    api.get.mockResolvedValue(null)
    useDocumentFlowStore.setState({ dashboardRunId: 'run-gone' })
    await act(async () => {
      render(<DocumentRunDashboard />)
    })

    expect(api.get).toHaveBeenCalledWith('run-gone')
    expect(useDocumentFlowStore.getState().dashboardRunId).toBeNull()
  })

  it('sends a run that was never launched back to the wizard', async () => {
    await renderDashboard(makeDetail({ status: 'preview' }))

    await click('docflow-dashboard-open-wizard')

    const state = useDocumentFlowStore.getState()
    expect(state.dashboardRunId).toBeNull()
    expect(state.wizard).toEqual({ open: true, projectId: TEST_PROJECT.id, runId: 'run-1' })
  })
})

describe('DocumentRunDashboard — needs you', () => {
  const flagged = (): DocumentRunDetail =>
    makeDetail(LAUNCHED, [
      {
        key: 'A1',
        status: 'needs_input',
        verdict: QUESTION_VERDICT,
        session_id: 'session-A1',
        worktree_id: 'wt-A1'
      },
      { key: 'A2', status: 'needs_attention', status_detail: 'Verify failed twice; rolled back.' },
      { key: 'A3', status: 'running', session_id: 'session-A3', worktree_id: 'wt-A3' }
    ])

  it('lists the flagged tickets with their question or reason', async () => {
    await renderDashboard(flagged())

    const section = screen.getByTestId('docflow-needs-you')
    expect(section).toHaveTextContent('Needs you (2)')
    expect(screen.getByTestId('docflow-needs-you-reason-A1')).toHaveTextContent(
      'Should guests be able to check out?'
    )
    expect(screen.getByTestId('docflow-needs-you-reason-A2')).toHaveTextContent(
      'Verify failed twice; rolled back.'
    )
    expect(within(section).queryByTestId('docflow-needs-you-A3')).toBeNull()
    // Without a session there is nothing to open.
    expect(screen.queryByTestId('docflow-needs-you-open-A2')).toBeNull()
  })

  it('is absent when nothing waits for the user', async () => {
    await renderDashboard(makeDetail(LAUNCHED, [{ key: 'A1', status: 'running' }]))
    expect(screen.queryByTestId('docflow-needs-you')).toBeNull()
  })

  it('retries a ticket: judged again when it has a session, relaunched when it has none', async () => {
    await renderDashboard(flagged())

    await click('docflow-needs-you-retry-A1')
    expect(api.updateItem).toHaveBeenLastCalledWith(
      'run-1',
      'item-A1',
      expect.objectContaining({ status: 'checking', nudge_count: 0, fix_attempts: 0 })
    )

    await click('docflow-needs-you-retry-A2')
    expect(api.updateItem).toHaveBeenLastCalledWith(
      'run-1',
      'item-A2',
      expect.objectContaining({ status: 'pending', status_detail: null })
    )
    // Both left the section once the store applied the new status.
    expect(screen.queryByTestId('docflow-needs-you')).toBeNull()
  })

  it('marks a ticket done so it is queued for merging', async () => {
    await renderDashboard(flagged())

    await click('docflow-needs-you-done-A1')

    expect(api.updateItem).toHaveBeenCalledWith(
      'run-1',
      'item-A1',
      expect.objectContaining({ status: 'ready', status_detail: 'Marked done by you.' })
    )
    expect(screen.getByTestId('docflow-row-status-A1')).toHaveTextContent('Ready to merge')
  })

  it('skips a ticket', async () => {
    await renderDashboard(flagged())

    await click('docflow-needs-you-skip-A2')

    expect(api.updateItem).toHaveBeenCalledWith(
      'run-1',
      'item-A2',
      expect.objectContaining({ status: 'skipped', status_detail: 'Skipped by you.' })
    )
    expect(screen.queryByTestId('docflow-needs-you-A2')).toBeNull()
  })

  it('opens the ticket session in its worktree and closes the dialog', async () => {
    const toggleBoardView = vi.fn()
    useKanbanStore.setState({ isBoardViewActive: true, toggleBoardView } as never)
    await renderDashboard(flagged())

    await click('docflow-needs-you-open-A1')

    expect(toggleBoardView).toHaveBeenCalledTimes(1)
    expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-A1')
    expect(useSessionStore.getState().activeWorktreeId).toBe('wt-A1')
    expect(useSessionStore.getState().activeSessionId).toBe('session-A1')
    expect(useProjectStore.getState().selectedProjectId).toBe(TEST_PROJECT.id)
    expect(useDocumentFlowStore.getState().dashboardRunId).toBeNull()
  })

  it('reopens a session that was closed with its ticket, so the jump does not land on nothing', async () => {
    const reopenSession = vi.fn().mockResolvedValue({ success: true })
    useSessionStore.setState({ reopenSession } as never)
    setRendererRpcClient({
      request: async <T,>(method: string): Promise<T> =>
        (method === 'db.session.get' ? { id: 'session-A2', status: 'completed' } : undefined) as T,
      subscribe: () => () => {}
    })
    await renderDashboard(
      makeDetail(LAUNCHED, [
        { key: 'A1', status: 'running', session_id: 'session-A1', worktree_id: 'wt-A1' },
        { key: 'A2', status: 'merged', session_id: 'session-A2', worktree_id: 'wt-A2' }
      ])
    )

    await click('docflow-row-open-A2')

    expect(useSessionStore.getState().activeSessionId).toBe('session-A2')
    expect(reopenSession).toHaveBeenCalledWith('session-A2', 'wt-A2')
  })

  it('offers only the fix session while a merge that needs the user is in the integration worktree', async () => {
    await renderDashboard(
      makeDetail(LAUNCHED, [
        {
          key: 'A1',
          status: 'fixing',
          status_detail: `${WAITING_PREFIX}a question`,
          session_id: 'session-A1',
          worktree_id: 'wt-A1',
          fix_session_id: 'session-fix'
        }
      ])
    )

    expect(screen.getByTestId('docflow-needs-you-reason-A1')).toHaveTextContent(
      'Waiting for you: a question'
    )
    expect(screen.getByTestId('docflow-dashboard-status')).toHaveTextContent('Waiting for you')
    expect(screen.queryByTestId('docflow-needs-you-retry-A1')).toBeNull()
    expect(screen.queryByTestId('docflow-needs-you-done-A1')).toBeNull()
    expect(screen.queryByTestId('docflow-needs-you-skip-A1')).toBeNull()
    expect(screen.queryByTestId('docflow-row-skip-A1')).toBeNull()

    await click('docflow-needs-you-open-A1')
    expect(useSessionStore.getState().activeSessionId).toBe('session-fix')
    expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-integration')
  })

  it('lists an interrupted conflict session and lets the user retry or skip it', async () => {
    await renderDashboard(
      makeDetail(LAUNCHED, [
        {
          key: 'A1',
          status: 'resolving_conflicts',
          status_detail: USER_INTERRUPT_DETAIL,
          session_id: 'session-A1',
          worktree_id: 'wt-A1',
          conflict_attempts: 1
        },
        // Prose that merely mentions the user is not a stop for the user.
        {
          key: 'A2',
          status: 'resolving_conflicts',
          status_detail: 'Resolving conflicts in the files you listed',
          session_id: 'session-A2'
        }
      ])
    )

    const section = screen.getByTestId('docflow-needs-you')
    expect(section).toHaveTextContent('Needs you (1)')
    expect(screen.getByTestId('docflow-needs-you-reason-A1')).toHaveTextContent(
      USER_INTERRUPT_DETAIL
    )
    expect(within(section).queryByTestId('docflow-needs-you-A2')).toBeNull()
    expect(screen.getByTestId('docflow-needs-you-skip-A1')).toBeInTheDocument()

    // The conflicting merge was aborted, so judging the session again is safe; a fresh set
    // of conflict attempts comes with it.
    await click('docflow-needs-you-retry-A1')
    expect(api.updateItem).toHaveBeenLastCalledWith(
      'run-1',
      'item-A1',
      expect.objectContaining({ status: 'checking', conflict_attempts: 0 })
    )
  })

  it('withholds "Mark done & merge" while the ticket session is visibly working', async () => {
    useWorktreeStatusStore.setState({
      sessionStatuses: { 'session-A1': { status: 'working', timestamp: Date.now() } }
    })
    await renderDashboard(flagged())

    const sectionButton = screen.getByTestId('docflow-needs-you-done-A1')
    expect(sectionButton).toBeDisabled()
    expect(sectionButton).toHaveAttribute('title', expect.stringMatching(/still working/))
    expect(screen.getByTestId('docflow-row-done-A1')).toBeDisabled()
    // Retry and Skip are unaffected, and a ticket whose session is at rest keeps the action.
    expect(screen.getByTestId('docflow-needs-you-retry-A1')).not.toBeDisabled()
    expect(screen.getByTestId('docflow-needs-you-done-A2')).not.toBeDisabled()

    await click('docflow-needs-you-done-A1')
    expect(api.updateItem).not.toHaveBeenCalled()

    // The session comes to rest: the action is back.
    act(() => {
      useWorktreeStatusStore.setState({
        sessionStatuses: { 'session-A1': { status: 'completed', timestamp: Date.now() } }
      })
    })
    expect(screen.getByTestId('docflow-needs-you-done-A1')).not.toBeDisabled()
  })

  it('still shows what a cancelled run was waiting for, without actions that need a live run', async () => {
    await renderDashboard(
      makeDetail({ ...LAUNCHED, status: 'cancelled' }, [
        { key: 'A1', status: 'needs_attention', status_detail: 'Conflicts could not be resolved.' }
      ])
    )

    expect(screen.getByTestId('docflow-needs-you-reason-A1')).toHaveTextContent(
      'Conflicts could not be resolved.'
    )
    expect(screen.queryByTestId('docflow-needs-you-retry-A1')).toBeNull()
    expect(screen.queryByTestId('docflow-needs-you-skip-A1')).toBeNull()
    expect(screen.queryByTestId('docflow-row-skip-A1')).toBeNull()
  })
})

describe('DocumentRunDashboard — tickets', () => {
  it('names the dependencies a pending ticket waits for', async () => {
    await renderDashboard(
      makeDetail(LAUNCHED, [
        { key: 'A1', status: 'running' },
        { key: 'A2', status: 'merged' },
        { key: 'A3', depends_on: ['A1', 'A2'] },
        { key: 'A4' }
      ])
    )

    expect(screen.getByTestId('docflow-row-status-A3')).toHaveTextContent('Waiting for A1')
    expect(screen.getByTestId('docflow-row-status-A4')).toHaveTextContent('Queued')
    expect(screen.getByTestId('docflow-row-status-A1')).toHaveTextContent('Working')
    expect(screen.getByTestId('docflow-row-status-A2')).toHaveTextContent('Merged')
  })

  it('shows detail, branch and row actions that fit the ticket state', async () => {
    await renderDashboard(
      makeDetail(LAUNCHED, [
        {
          key: 'A1',
          status: 'running',
          status_detail: 'Nudged to continue (1 of 2)',
          branch_name: 'a1-task',
          session_id: 'session-A1',
          worktree_id: 'wt-A1'
        },
        { key: 'A2', status: 'merged', session_id: 'session-A2', worktree_id: 'wt-A2' },
        { key: 'A3', status: 'needs_attention' },
        { key: 'A4', status: 'pending' }
      ])
    )

    const detail = screen.getByTestId('docflow-row-detail-A1')
    expect(detail).toHaveTextContent('Nudged to continue (1 of 2)')
    expect(detail).toHaveAttribute('title', 'Nudged to continue (1 of 2)')
    expect(screen.getByTestId('docflow-row-A1')).toHaveTextContent('a1-task')

    // Working: open or skip. Merged: open only. Flagged: retry, mark done, skip. Queued: skip.
    expect(screen.getByTestId('docflow-row-open-A1')).toBeInTheDocument()
    expect(screen.getByTestId('docflow-row-skip-A1')).toBeInTheDocument()
    expect(screen.queryByTestId('docflow-row-retry-A1')).toBeNull()
    expect(screen.getByTestId('docflow-row-open-A2')).toBeInTheDocument()
    expect(screen.queryByTestId('docflow-row-skip-A2')).toBeNull()
    expect(screen.queryByTestId('docflow-row-open-A3')).toBeNull()
    expect(screen.getByTestId('docflow-row-retry-A3')).toBeInTheDocument()
    expect(screen.getByTestId('docflow-row-done-A3')).toBeInTheDocument()
    expect(screen.getByTestId('docflow-row-skip-A4')).toBeInTheDocument()

    await click('docflow-row-skip-A4')
    expect(api.updateItem).toHaveBeenCalledWith(
      'run-1',
      'item-A4',
      expect.objectContaining({ status: 'skipped' })
    )
    await click('docflow-row-done-A3')
    expect(api.updateItem).toHaveBeenLastCalledWith(
      'run-1',
      'item-A3',
      expect.objectContaining({ status: 'ready' })
    )
  })

  it('lists tickets that are not part of the run last, as "Not included"', async () => {
    await renderDashboard(
      makeDetail(LAUNCHED, [
        { key: 'A1', selected: false },
        { key: 'A2', status: 'running' },
        { key: 'A3', status: 'merged' }
      ])
    )

    const rows = within(screen.getByTestId('docflow-items'))
      .getAllByTestId(/^docflow-row-A\d$/)
      .map((row) => row.getAttribute('data-testid'))
    expect(rows).toEqual(['docflow-row-A2', 'docflow-row-A3', 'docflow-row-A1'])
    expect(screen.getByTestId('docflow-row-status-A1')).toHaveTextContent('Not included')
    expect(screen.queryByTestId('docflow-row-skip-A1')).toBeNull()
  })

  it('shows the model each ticket runs with: its own, else the run default', async () => {
    const detail = makeDetail(LAUNCHED, [
      {
        key: 'A1',
        launch_config: {
          sdk: 'claude-code-cli',
          model: { providerID: 'anthropic', modelID: 'opus', variant: 'ultracode' },
          codexFastMode: false
        }
      },
      { key: 'A2' }
    ])
    detail.run.config = {
      ...detail.run.config,
      defaultLaunch: {
        sdk: 'codex',
        model: { providerID: 'codex', modelID: 'gpt-5.5' },
        codexFastMode: false
      }
    }
    await renderDashboard(detail)

    expect(screen.getByTestId('docflow-row-A1')).toHaveTextContent('opus')
    expect(screen.getByTestId('docflow-row-A1')).toHaveTextContent('ultracode')
    expect(screen.getByTestId('docflow-row-A2')).toHaveTextContent('gpt-5.5')
  })
})

describe('DocumentRunDashboard — report and activity', () => {
  it('renders what merged, what did not, and what is left for the user', async () => {
    const report = makeReport({
      baseMoved: true,
      merged: [
        { key: 'A1', title: 'New cart', mergeSha: 'abcdef1234567', summary: 'Rebuilt the cart.' }
      ],
      unmerged: [
        { key: 'A2', title: 'Guest checkout', status: 'skipped', reason: 'Skipped by you.' }
      ],
      migrations: ['drizzle/0066_cart_items.sql', 'drizzle/0067_guest_orders.sql'],
      manualSteps: ['Set STRIPE_WEBHOOK_SECRET in production'],
      verify: { command: 'pnpm check', ok: false, output: 'FAIL src/cart.test.ts' }
    })
    await renderDashboard(
      makeDetail({ ...LAUNCHED, status: 'completed_with_issues', report }, [
        { key: 'A1', status: 'merged' },
        { key: 'A2', status: 'skipped' }
      ])
    )

    const migrations = screen.getByTestId('docflow-report-migrations')
    expect(migrations).toHaveTextContent('Migrations to run (2)')
    expect(
      within(migrations)
        .getAllByRole('listitem')
        .map((item) => item.textContent)
    ).toEqual(['drizzle/0066_cart_items.sql', 'drizzle/0067_guest_orders.sql'])
    expect(screen.getByTestId('docflow-report-manual-steps')).toHaveTextContent(
      'Set STRIPE_WEBHOOK_SECRET in production'
    )
    expect(screen.getByTestId('docflow-report-merged')).toHaveTextContent('A1 New cart abcdef1')
    expect(screen.getByTestId('docflow-report-merged')).toHaveTextContent('Rebuilt the cart.')
    const unmerged = screen.getByTestId('docflow-report-unmerged')
    expect(unmerged).toHaveTextContent('A2 Guest checkout · Skipped')
    expect(unmerged).toHaveTextContent('Skipped by you.')
    expect(screen.getByTestId('docflow-report-stats')).toHaveTextContent(
      '9 commits · 12 files changed · +340 −25 · 1111111..2222222'
    )
    const verify = screen.getByTestId('docflow-report-verify')
    expect(verify).toHaveTextContent('pnpm check')
    expect(verify).toHaveTextContent('failed')
    expect(verify).toHaveTextContent('FAIL src/cart.test.ts')
    expect(screen.getByTestId('docflow-report-base-moved')).toHaveTextContent(
      'main has new commits since this run started — merge or rebase before landing'
    )
    expect(screen.getByTestId('docflow-report-next')).toHaveTextContent(
      'What is left for you: run the migrations, review, and push / merge doc-checkout-redesign into main.'
    )
  })

  it('leaves out report parts that have nothing to say', async () => {
    await renderDashboard(
      makeDetail({ ...LAUNCHED, status: 'completed', report: makeReport() }, [
        { key: 'A1', status: 'merged' }
      ])
    )

    expect(screen.getByTestId('docflow-report')).toBeInTheDocument()
    expect(screen.queryByTestId('docflow-report-migrations')).toBeNull()
    expect(screen.queryByTestId('docflow-report-manual-steps')).toBeNull()
    expect(screen.queryByTestId('docflow-report-base-moved')).toBeNull()
    expect(screen.queryByTestId('docflow-report-verify')).toBeNull()
    expect(screen.queryByTestId('docflow-report-unmerged')).toBeNull()
  })

  it('has no report section while the run is still going', async () => {
    await renderDashboard(makeDetail(LAUNCHED, [{ key: 'A1', status: 'running' }]))
    expect(screen.queryByTestId('docflow-report')).toBeNull()
  })

  it('lists the activity newest first, with the ticket each event is about', async () => {
    const detail = makeDetail(LAUNCHED, [{ key: 'A1', status: 'running' }])
    detail.events = [
      {
        id: 1,
        run_id: 'run-1',
        item_id: null,
        at: '2026-05-04T10:05:00.000Z',
        type: 'started',
        message: 'Run started',
        data: null
      },
      {
        id: 2,
        run_id: 'run-1',
        item_id: 'item-A1',
        at: '2026-05-04T10:06:00.000Z',
        type: 'launched',
        message: 'Launched in its own worktree',
        data: null
      }
    ]
    await renderDashboard(detail)

    expect(screen.queryByTestId('docflow-activity-list')).toBeNull()
    fireEvent.click(screen.getByTestId('docflow-activity-toggle'))

    const entries = within(screen.getByTestId('docflow-activity-list')).getAllByRole('listitem')
    expect(entries).toHaveLength(2)
    expect(entries[0]).toHaveTextContent('A1')
    expect(entries[0]).toHaveTextContent('Launched in its own worktree')
    expect(entries[1]).toHaveTextContent('Run started')
  })
})

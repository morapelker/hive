import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getRendererRpcClient, setRendererRpcClient } from '@/api/rpc-client'
import { clearHandoffModelCatalogCache } from '@/lib/handoffSelection'
import { toast } from '@/lib/toast'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useQuestionStore, type QuestionRequest } from '@/stores/useQuestionStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import {
  DOCUMENT_UPDATE_INTERRUPT_DETAIL,
  USER_INTERRUPT_DETAIL,
  WAITING_PREFIX
} from '@shared/document-flow/planning'
import type {
  DocumentRunDetail,
  DocumentRunItemPatch,
  DocumentRunLaunchConfig,
  DocumentRunPatch,
  DocumentRunVerdict
} from '@shared/types/document-flow'
import { DOCUMENT_DELETED_REASON, DocumentRunDashboard } from './DocumentRunDashboard'
import { PARALLEL_WRITE_DEBOUNCE_MS } from './RunParallelControl'
import { TEST_PROJECT, makeDetail, makeReport } from './test-fixtures'

const api = vi.hoisted(() => ({
  get: vi.fn(),
  sourceFile: vi.fn(),
  updateRun: vi.fn(),
  updateItem: vi.fn(),
  cancel: vi.fn(),
  finalize: vi.fn(),
  delete: vi.fn()
}))

const projectApi = vi.hoisted(() => ({ openPath: vi.fn() }))
const listModels = vi.hoisted(() => vi.fn())
const questionMode = vi.hoisted(() => ({ applyQuestionMode: vi.fn() }))
const migrations = vi.hoisted(() => ({ startRunMigrations: vi.fn(), stopRunMigrations: vi.fn() }))

vi.mock('@/api/document-flow-api', () => ({ documentFlowApi: api }))
vi.mock('@/api/project-api', () => ({ projectApi }))
vi.mock('@/api/opencode-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/opencode-api')>()
  return { ...actual, opencodeApi: { ...actual.opencodeApi, listModels } }
})
// The broadcast to the run's sessions has its own tests; here only the gate in front of it.
vi.mock('@/lib/document-flow/question-mode', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/document-flow/question-mode')>()),
  applyQuestionMode: questionMode.applyQuestionMode
}))
// Launching and stopping the session has its own tests; here only the buttons in front of it.
vi.mock('@/lib/document-flow/migrations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/document-flow/migrations')>()),
  startRunMigrations: migrations.startRunMigrations,
  stopRunMigrations: migrations.stopRunMigrations
}))
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

const defaultRpcClient = getRendererRpcClient()
const initialFlowState = useDocumentFlowStore.getState()
const initialProjectState = useProjectStore.getState()
const initialWorktreeState = useWorktreeStore.getState()
const initialWorktreeStatusState = useWorktreeStatusStore.getState()
const initialSessionState = useSessionStore.getState()
const initialQuestionState = useQuestionStore.getState()
const initialKanbanState = useKanbanStore.getState()
const initialSettingsState = useSettingsStore.getState()

const SONNET_HIGH: DocumentRunLaunchConfig = {
  sdk: 'claude-code-cli',
  model: { providerID: 'anthropic', modelID: 'sonnet', variant: 'high' },
  codexFastMode: false
}
const OPUS_ULTRACODE: DocumentRunLaunchConfig = {
  sdk: 'claude-code-cli',
  model: { providerID: 'anthropic', modelID: 'opus', variant: 'ultracode' },
  codexFastMode: false
}
const CODEX_DEFAULT: DocumentRunLaunchConfig = {
  sdk: 'codex',
  model: { providerID: 'codex', modelID: 'gpt-5.5' },
  codexFastMode: false
}

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

beforeAll(() => {
  // Radix menus rely on these in a real browser; jsdom lacks them.
  Element.prototype.hasPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  listModels.mockResolvedValue({ success: true, providers: [] })
  useSettingsStore.setState({
    defaultAgentSdk: 'claude-code-cli',
    availableAgentSdks: { opencode: true, claude: true, codex: true },
    selectedModel: null,
    selectedModelByProvider: {},
    defaultModels: null,
    customProviders: []
  })
  // The server's side of the store actions: apply the patch to the stored row.
  api.updateItem.mockImplementation(
    async (runId: string, itemId: string, patch: DocumentRunItemPatch) => ({
      ...storedDetail(runId).items.find((item) => item.id === itemId),
      ...patch
    })
  )
  api.updateRun.mockImplementation(async (runId: string, patch: DocumentRunPatch) => ({
    ...storedDetail(runId).run,
    status: patch.status ?? storedDetail(runId).run.status,
    config: { ...storedDetail(runId).run.config, ...patch.config }
  }))
  api.get.mockImplementation(async (runId: string) => storedDetail(runId) ?? null)
  // The document the run was made from is still on disk unless a test says otherwise.
  api.sourceFile.mockImplementation(async (runId: string) => ({
    path: storedDetail(runId).run.source_path,
    exists: true
  }))
  projectApi.openPath.mockResolvedValue('')
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
  useQuestionStore.setState(initialQuestionState, true)
  useKanbanStore.setState(initialKanbanState, true)
  useSettingsStore.setState(initialSettingsState, true)
  clearHandoffModelCatalogCache()
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

  it('changes whether agents may ask only after confirmation, and says who is told', async () => {
    questionMode.applyQuestionMode.mockImplementation(async (runId: string, interactive) => {
      const detail = storedDetail(runId)
      useDocumentFlowStore.setState({
        runsById: {
          [runId]: {
            ...detail,
            run: { ...detail.run, config: { ...detail.run.config, interactive } }
          }
        }
      })
      return interactive
        ? { told: 0, waiting: 0, skipped: 0, failed: 1 }
        : { told: 2, waiting: 1, skipped: 1, failed: 0 }
    })
    await renderDashboard(
      makeDetail(LAUNCHED, [
        { key: 'A1', status: 'running', session_id: 's-1' },
        { key: 'A2', status: 'running', session_id: 's-2' },
        { key: 'A3', status: 'merged', session_id: 's-3' },
        { key: 'A4', status: 'pending' }
      ])
    )
    const toggle = screen.getByTestId('docflow-dashboard-interactive-switch')
    expect(toggle).toHaveAttribute('aria-checked', 'true')

    await click('docflow-dashboard-interactive-switch')
    expect(screen.getByText('Are you sure? Agents will stop asking questions')).toBeInTheDocument()
    expect(
      screen.getByText(/2 tickets are in progress: each session that is working gets the same/)
    ).toBeInTheDocument()
    await click('docflow-confirm-cancel')
    expect(questionMode.applyQuestionMode).not.toHaveBeenCalled()
    expect(toggle).toHaveAttribute('aria-checked', 'true')

    await click('docflow-dashboard-interactive-switch')
    await click('docflow-confirm-action')
    expect(questionMode.applyQuestionMode).toHaveBeenCalledWith('run-1', false)
    expect(screen.getByTestId('docflow-dashboard-interactive-switch')).toHaveAttribute(
      'aria-checked',
      'false'
    )
    expect(toast.success).toHaveBeenCalledWith(
      'Agents are told not to ask questions. Told 2 running sessions. 1 will read it after you answer the question it asked. 1 at rest was not messaged.'
    )

    // And back on: the same gate.
    await click('docflow-dashboard-interactive-switch')
    expect(screen.getByText('Are you sure? Agents will ask questions again')).toBeInTheDocument()
    expect(questionMode.applyQuestionMode).toHaveBeenCalledTimes(1)
    await click('docflow-confirm-action')
    expect(questionMode.applyQuestionMode).toHaveBeenLastCalledWith('run-1', true)
    // A session that could not be reached is not passed off as one at rest.
    expect(toast.warning).toHaveBeenCalledWith(
      'Agents may ask questions again. Told 0 running sessions. 1 could not be reached.'
    )
    expect(screen.getByTestId('docflow-dashboard-interactive-switch')).toHaveAttribute(
      'aria-checked',
      'true'
    )
  })

  it('offers the questions switch on a paused run and says when no session is working', async () => {
    await renderDashboard(
      makeDetail({ ...LAUNCHED, status: 'paused' }, [{ key: 'A1', status: 'pending' }])
    )

    await click('docflow-dashboard-interactive-switch')
    expect(
      screen.getByText(/No ticket of this run is in progress, so no session is messaged/)
    ).toBeInTheDocument()
  })

  it('has no questions switch once the run is over', async () => {
    await renderDashboard(
      makeDetail({ ...LAUNCHED, status: 'completed' }, [{ key: 'A1', status: 'merged' }])
    )
    expect(screen.queryByTestId('docflow-dashboard-interactive-switch')).toBeNull()
  })

  it('reports a questions change that could not be saved and leaves the switch as it was', async () => {
    questionMode.applyQuestionMode.mockRejectedValue(new Error('offline'))
    await renderDashboard(
      makeDetail(LAUNCHED, [{ key: 'A1', status: 'running', session_id: 's-1' }])
    )

    await click('docflow-dashboard-interactive-switch')
    await click('docflow-confirm-action')

    expect(toast.error).toHaveBeenCalledWith('Could not change the questions setting: offline')
    expect(screen.getByTestId('docflow-dashboard-interactive-switch')).toHaveAttribute(
      'aria-checked',
      'true'
    )
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
        /The run and its report are removed from the list\. The run's own ticket is removed from the board\. Branches, worktrees and the tickets of its tasks are not touched, and the spec text and figures those tickets attach stay on disk\./
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

  it('stays open and says so when the integration worktree was archived', async () => {
    // The project's worktrees are loaded, and the integration worktree is not among them.
    useWorktreeStore.setState({ worktreesByProject: new Map([[TEST_PROJECT.id, []]]) })
    await renderDashboard(
      makeDetail({ ...LAUNCHED, status: 'completed', report: makeReport() }, [
        { key: 'A1', status: 'merged' }
      ])
    )

    await click('docflow-open-worktree')

    expect(toast.info).toHaveBeenCalledWith('The worktree of doc-checkout-redesign was archived.')
    expect(useWorktreeStore.getState().selectedWorktreeId).not.toBe('wt-integration')
    expect(useDocumentFlowStore.getState().dashboardRunId).not.toBeNull()
    // The report is still there to read.
    expect(screen.getByTestId('docflow-report')).toBeInTheDocument()
  })

  it('shows the source document and opens it with the default app', async () => {
    await renderDashboard(makeDetail(LAUNCHED, [{ key: 'A1', status: 'running' }]))

    const name = screen.getByTestId('docflow-source-path')
    expect(name).toHaveTextContent('checkout-redesign.html')
    expect(name).toHaveAttribute('title', '/docs/checkout-redesign.html')
    const button = screen.getByTestId('docflow-open-document-btn')
    expect(button).not.toBeDisabled()
    expect(button).toHaveAttribute('title', '/docs/checkout-redesign.html')
    expect(screen.queryByTestId('docflow-document-missing')).toBeNull()

    await click('docflow-open-document-btn')

    expect(projectApi.openPath).toHaveBeenCalledWith('/docs/checkout-redesign.html')
    expect(toast.error).not.toHaveBeenCalled()
    expect(toast.info).not.toHaveBeenCalled()
    // Opening the file is not a navigation: the dashboard stays.
    expect(useDocumentFlowStore.getState().dashboardRunId).toBe('run-1')
  })

  it('withholds "Open document", and says why, when the file was deleted', async () => {
    api.sourceFile.mockResolvedValue({ path: '/docs/checkout-redesign.html', exists: false })
    await renderDashboard(makeDetail(LAUNCHED, [{ key: 'A1', status: 'running' }]))

    const button = screen.getByTestId('docflow-open-document-btn')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', DOCUMENT_DELETED_REASON)
    // In words next to the button: a disabled button shows no tooltip.
    expect(screen.getByTestId('docflow-document-missing')).toHaveTextContent(
      DOCUMENT_DELETED_REASON
    )
    expect(screen.getByTestId('docflow-source-path')).toHaveTextContent('checkout-redesign.html')

    await click('docflow-open-document-btn')
    expect(projectApi.openPath).not.toHaveBeenCalled()
  })

  it('keeps the button disabled, without a reason, while the check is pending', async () => {
    api.sourceFile.mockReturnValue(new Promise(() => undefined))
    await renderDashboard(makeDetail(LAUNCHED, [{ key: 'A1', status: 'running' }]))

    expect(screen.getByTestId('docflow-open-document-btn')).toBeDisabled()
    expect(screen.queryByTestId('docflow-document-missing')).toBeNull()
  })

  it('says so when the document vanished after the dashboard opened', async () => {
    api.sourceFile
      .mockResolvedValueOnce({ path: '/docs/checkout-redesign.html', exists: true })
      .mockResolvedValueOnce({ path: '/docs/checkout-redesign.html', exists: false })
    await renderDashboard(makeDetail(LAUNCHED, [{ key: 'A1', status: 'running' }]))
    expect(screen.getByTestId('docflow-open-document-btn')).not.toBeDisabled()

    await click('docflow-open-document-btn')

    expect(toast.info).toHaveBeenCalledWith(DOCUMENT_DELETED_REASON)
    expect(projectApi.openPath).not.toHaveBeenCalled()
    expect(screen.getByTestId('docflow-open-document-btn')).toBeDisabled()
    expect(screen.getByTestId('docflow-document-missing')).toBeInTheDocument()
  })

  it('reports when the OS could not open the document', async () => {
    projectApi.openPath.mockResolvedValue('No application found')
    await renderDashboard(makeDetail(LAUNCHED, [{ key: 'A1', status: 'running' }]))

    await click('docflow-open-document-btn')

    expect(toast.error).toHaveBeenCalledWith('Could not open the document: No application found')
    expect(screen.getByTestId('docflow-open-document-btn')).not.toBeDisabled()
  })

  it('treats a failed check as a missing document', async () => {
    api.sourceFile.mockRejectedValue(new Error('Lease lost'))
    await renderDashboard(makeDetail(LAUNCHED, [{ key: 'A1', status: 'running' }]))

    expect(screen.getByTestId('docflow-open-document-btn')).toBeDisabled()
    expect(screen.getByTestId('docflow-document-missing')).toHaveTextContent(
      DOCUMENT_DELETED_REASON
    )
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

describe('DocumentRunDashboard — parallel tickets', () => {
  const withLimit = (maxParallel: number, run: Partial<DocumentRunDetail['run']> = {}) => ({
    ...LAUNCHED,
    ...run,
    config: { ...makeDetail().run.config, maxParallel }
  })
  const limitShown = (): string | null =>
    screen.getByTestId('docflow-dashboard-parallel-value').textContent
  const settle = async (ms = PARALLEL_WRITE_DEBOUNCE_MS): Promise<void> => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the limit and how many tickets hold a slot', async () => {
    await renderDashboard(
      makeDetail(withLimit(3), [
        { key: 'A1', status: 'running' },
        { key: 'A2', status: 'needs_input' },
        { key: 'A3', status: 'pending' },
        { key: 'A4', status: 'merged' },
        { key: 'A5', status: 'running', selected: false }
      ])
    )

    expect(limitShown()).toBe('3')
    expect(screen.getByTestId('docflow-dashboard-parallel-in-use')).toHaveTextContent(/^2 in use$/)
  })

  it('raises the limit by writing that one setting', async () => {
    await renderDashboard(makeDetail(withLimit(4), [{ key: 'A1', status: 'running' }]))
    const before = storedDetail('run-1').run.config

    await click('docflow-dashboard-parallel-increase')
    // Shown at once, written after the pause that ends a burst of clicks.
    expect(limitShown()).toBe('5')
    expect(api.updateRun).not.toHaveBeenCalled()
    await settle()

    expect(api.updateRun).toHaveBeenCalledTimes(1)
    expect(api.updateRun).toHaveBeenCalledWith('run-1', { config: { maxParallel: 5 } })
    expect(storedDetail('run-1').run.config).toEqual({ ...before, maxParallel: 5 })
    expect(limitShown()).toBe('5')
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('writes a burst of clicks once, as the value it ends on', async () => {
    await renderDashboard(makeDetail(withLimit(4), [{ key: 'A1', status: 'running' }]))

    // Two clicks before React renders: each steps from the one before it.
    await act(async () => {
      fireEvent.click(screen.getByTestId('docflow-dashboard-parallel-increase'))
      fireEvent.click(screen.getByTestId('docflow-dashboard-parallel-increase'))
    })
    await settle(PARALLEL_WRITE_DEBOUNCE_MS - 1)
    await click('docflow-dashboard-parallel-increase')
    await settle(PARALLEL_WRITE_DEBOUNCE_MS - 1)
    expect(limitShown()).toBe('7')
    expect(api.updateRun).not.toHaveBeenCalled()
    await settle(1)

    expect(api.updateRun).toHaveBeenCalledTimes(1)
    expect(api.updateRun).toHaveBeenCalledWith('run-1', { config: { maxParallel: 7 } })
    expect(storedDetail('run-1').run.config.maxParallel).toBe(7)
  })

  it('lowers the limit under what is in use without touching any ticket', async () => {
    await renderDashboard(
      makeDetail(withLimit(3), [
        { key: 'A1', status: 'running' },
        { key: 'A2', status: 'running' },
        { key: 'A3', status: 'running' },
        { key: 'A4', status: 'pending' }
      ])
    )
    const itemsBefore = storedDetail('run-1').items

    await click('docflow-dashboard-parallel-decrease')
    await click('docflow-dashboard-parallel-decrease')
    await settle()

    expect(api.updateRun).toHaveBeenCalledTimes(1)
    expect(api.updateRun).toHaveBeenCalledWith('run-1', { config: { maxParallel: 1 } })
    expect(api.updateItem).not.toHaveBeenCalled()
    expect(storedDetail('run-1').items).toBe(itemsBefore)
    expect(storedDetail('run-1').run.status).toBe('running')
    expect(screen.getByTestId('docflow-dashboard-status')).toHaveTextContent('Running')
    expect(screen.getByTestId('docflow-dashboard-parallel-in-use')).toHaveTextContent(
      '3 in use: they keep going, and new tickets start once fewer than 1 is in use'
    )
  })

  it('stops at 1 and at the maximum', async () => {
    await renderDashboard(makeDetail(withLimit(1), [{ key: 'A1', status: 'running' }]))
    expect(screen.getByTestId('docflow-dashboard-parallel-decrease')).toBeDisabled()
    expect(screen.getByTestId('docflow-dashboard-parallel-increase')).not.toBeDisabled()
    cleanup()

    await renderDashboard(makeDetail(withLimit(50), [{ key: 'A1', status: 'running' }]))
    expect(screen.getByTestId('docflow-dashboard-parallel-increase')).toBeDisabled()
    expect(screen.getByTestId('docflow-dashboard-parallel-decrease')).not.toBeDisabled()
  })

  it('is offered on a paused run, and not before launch or once the run is over', async () => {
    await renderDashboard(
      makeDetail(withLimit(1, { status: 'paused' }), [
        { key: 'A1', status: 'running' },
        { key: 'A2', status: 'running' },
        { key: 'A3', status: 'pending' }
      ])
    )
    // Paused: being under the limit again is not enough for a launch.
    expect(screen.getByTestId('docflow-dashboard-parallel-in-use')).toHaveTextContent(
      '2 in use: they keep going, and after you resume new tickets start once fewer than 1 is in use'
    )
    await click('docflow-dashboard-parallel-increase')
    await settle()
    expect(api.updateRun).toHaveBeenCalledWith('run-1', { config: { maxParallel: 2 } })
    expect(storedDetail('run-1').run.status).toBe('paused')
    expect(screen.getByTestId('docflow-dashboard-parallel-in-use')).toHaveTextContent(/^2 in use$/)
    cleanup()

    await renderDashboard(
      makeDetail(withLimit(4, { status: 'completed' }), [{ key: 'A1', status: 'merged' }])
    )
    expect(screen.queryByTestId('docflow-dashboard-parallel')).toBeNull()
    cleanup()

    await renderDashboard(makeDetail({ status: 'preview' }))
    expect(screen.queryByTestId('docflow-dashboard-parallel')).toBeNull()
  })

  it('reports a limit that could not be saved and shows the stored one again', async () => {
    api.updateRun.mockRejectedValue(new Error('offline'))
    await renderDashboard(makeDetail(withLimit(4), [{ key: 'A1', status: 'running' }]))

    await click('docflow-dashboard-parallel-increase')
    expect(limitShown()).toBe('5')
    await settle()

    expect(toast.error).toHaveBeenCalledWith('Could not change the parallel tickets: offline')
    expect(limitShown()).toBe('4')
    expect(storedDetail('run-1').run.config.maxParallel).toBe(4)
  })

  it('keeps a step made while an earlier one is being saved, and writes it next', async () => {
    let finishFirst: () => void = () => {}
    const applied = api.updateRun.getMockImplementation() as typeof api.updateRun
    api.updateRun.mockImplementationOnce(async (runId: string, patch: DocumentRunPatch) => {
      const run = await applied(runId, patch)
      await new Promise<void>((resolve) => {
        finishFirst = resolve
      })
      return run
    })
    await renderDashboard(makeDetail(withLimit(4), [{ key: 'A1', status: 'running' }]))

    await click('docflow-dashboard-parallel-increase')
    await settle()
    await click('docflow-dashboard-parallel-increase')
    await act(async () => finishFirst())
    // The first write settled on 5, but 6 is what the user asked for since.
    expect(limitShown()).toBe('6')
    await settle()

    expect(api.updateRun.mock.calls.map(([, patch]) => patch)).toEqual([
      { config: { maxParallel: 5 } },
      { config: { maxParallel: 6 } }
    ])
    expect(storedDetail('run-1').run.config.maxParallel).toBe(6)
    expect(limitShown()).toBe('6')
  })

  it('writes a step back to a value whose earlier write is still being saved', async () => {
    const releases: (() => void)[] = []
    const applied = api.updateRun.getMockImplementation() as typeof api.updateRun
    // A slow server: each write is answered, in order, only when released.
    api.updateRun.mockImplementation(async (runId: string, patch: DocumentRunPatch) => {
      await new Promise<void>((resolve) => releases.push(resolve))
      return applied(runId, patch)
    })
    const release = async (): Promise<void> => {
      await act(async () => releases.shift()?.())
    }
    await renderDashboard(makeDetail(withLimit(4), [{ key: 'A1', status: 'running' }]))

    await click('docflow-dashboard-parallel-increase')
    await settle()
    await click('docflow-dashboard-parallel-increase')
    await settle()
    // Back to 5, which the first write is still saving: this 5 is a new decision.
    await click('docflow-dashboard-parallel-decrease')
    await release()
    await release()
    expect(limitShown()).toBe('5')
    await settle()
    await release()

    expect(api.updateRun.mock.calls.map(([, patch]) => patch)).toEqual([
      { config: { maxParallel: 5 } },
      { config: { maxParallel: 6 } },
      { config: { maxParallel: 5 } }
    ])
    expect(storedDetail('run-1').run.config.maxParallel).toBe(5)
    expect(limitShown()).toBe('5')
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('still writes the limit when the dashboard closes inside the pause', async () => {
    await renderDashboard(makeDetail(withLimit(4), [{ key: 'A1', status: 'running' }]))

    await click('docflow-dashboard-parallel-decrease')
    await act(async () => {
      useDocumentFlowStore.getState().closeDashboard()
    })

    expect(api.updateRun).toHaveBeenCalledTimes(1)
    expect(api.updateRun).toHaveBeenCalledWith('run-1', { config: { maxParallel: 3 } })
    await settle(PARALLEL_WRITE_DEBOUNCE_MS * 2)
    expect(api.updateRun).toHaveBeenCalledTimes(1)
    expect(storedDetail('run-1').run.config.maxParallel).toBe(3)
  })

  it('follows a limit changed from another window', async () => {
    const detail = makeDetail(withLimit(4), [{ key: 'A1', status: 'running' }])
    await renderDashboard(detail)

    await act(async () => {
      useDocumentFlowStore
        .getState()
        .applyRun({ ...detail.run, config: { ...detail.run.config, maxParallel: 9 } })
    })

    expect(limitShown()).toBe('9')
    expect(api.updateRun).not.toHaveBeenCalled()
  })

  it('reads Running again once a raised limit frees a slot for a waiting ticket', async () => {
    await renderDashboard(
      makeDetail(withLimit(1), [
        { key: 'A1', status: 'needs_input' },
        { key: 'A2', status: 'pending' }
      ])
    )
    expect(screen.getByTestId('docflow-dashboard-status')).toHaveTextContent('Waiting for you')

    await click('docflow-dashboard-parallel-increase')
    await settle()

    expect(screen.getByTestId('docflow-dashboard-status')).toHaveTextContent('Running')
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
    useKanbanStore.setState({ isBoardViewActive: true } as never)
    await renderDashboard(flagged())

    await click('docflow-needs-you-open-A1')

    expect(useKanbanStore.getState().isBoardViewActive).toBe(false)
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

describe('DocumentRunDashboard — document edit lane', () => {
  const lane = (overrides: Parameters<typeof makeDetail>[0] = {}): DocumentRunDetail =>
    makeDetail({ ...LAUNCHED, ...overrides }, [
      {
        key: 'A1',
        status: 'merged',
        session_id: 'session-A1',
        worktree_id: 'wt-A1',
        document_update_status: 'updating'
      },
      {
        key: 'A2',
        status: 'merged',
        session_id: 'session-A2',
        document_update_status: 'queued',
        document_update_queued_at: '2026-05-04T10:20:00.000Z'
      },
      {
        key: 'A3',
        status: 'skipped',
        session_id: 'session-A3',
        document_update_status: 'queued',
        document_update_queued_at: '2026-05-04T10:21:00.000Z'
      },
      { key: 'A4', status: 'running', session_id: 'session-A4' }
    ])

  it('says in the header which ticket edits the document and how many wait their turn', async () => {
    await renderDashboard(lane())

    const editing = screen.getByTestId('docflow-document-editing')
    expect(editing).toHaveTextContent(/^Editing document: A1$/)
    expect(editing.className).toContain('text-pink-500')
    expect(screen.getByTestId('docflow-document-edit-queue')).toHaveTextContent(
      '· 2 waiting in document edit queue'
    )
    expect(screen.queryByTestId('docflow-document-editing-waiting')).toBeNull()

    await click('docflow-open-document-session')
    expect(useSessionStore.getState().activeSessionId).toBe('session-A1')
    expect(useDocumentFlowStore.getState().dashboardRunId).toBeNull()
  })

  it('says the editing session waits for the user, in words', async () => {
    const detail = lane()
    detail.items[0] = {
      ...detail.items[0],
      document_update_detail: DOCUMENT_UPDATE_INTERRUPT_DETAIL
    }
    await renderDashboard(detail)

    expect(screen.getByTestId('docflow-document-editing-waiting')).toHaveTextContent(
      'Waiting for you'
    )
    expect(screen.getByTestId('docflow-row-detail-A1')).toHaveTextContent(
      DOCUMENT_UPDATE_INTERRUPT_DETAIL
    )
  })

  it('shows no lane line once nothing waits to edit the document, or the run is over', async () => {
    await renderDashboard(
      makeDetail(LAUNCHED, [{ key: 'A1', status: 'merged', document_update_status: 'done' }])
    )
    expect(screen.queryByTestId('docflow-document-lane')).toBeNull()
    cleanup()

    await renderDashboard(lane({ status: 'completed' }))
    expect(screen.queryByTestId('docflow-document-lane')).toBeNull()
  })

  it('wears the document states on the rows, with their place in the lane', async () => {
    await renderDashboard(lane())

    const editing = screen.getByTestId('docflow-row-status-A1')
    expect(editing).toHaveTextContent('Editing document')
    expect(editing.className).toContain('text-pink-500')
    expect(screen.getByTestId('docflow-row-status-A2')).toHaveTextContent(
      'Waiting in document edit queue'
    )
    expect(screen.getByTestId('docflow-row-detail-A2')).toHaveTextContent(
      '#1 in the document edit queue'
    )
    expect(screen.getByTestId('docflow-row-detail-A3')).toHaveTextContent(
      '#2 in the document edit queue'
    )
    expect(screen.getByTestId('docflow-row-status-A4')).toHaveTextContent('Working')
  })

  it('tells how a finished document update went, in the detail column', async () => {
    await renderDashboard(
      makeDetail(LAUNCHED, [
        {
          key: 'A1',
          status: 'merged',
          document_update_status: 'done',
          document_update_report: {
            outcome: 'updated',
            verified: 'tests: 12 passed',
            followUps: [],
            notes: 'Struck through task A1 and added its notes.'
          }
        },
        {
          key: 'A2',
          status: 'merged',
          document_update_status: 'failed',
          document_update_detail: 'The document was not changed.'
        },
        {
          key: 'A3',
          status: 'merged',
          document_update_status: 'skipped',
          document_update_detail: 'The document is read-only'
        }
      ])
    )

    expect(screen.getByTestId('docflow-row-status-A1')).toHaveTextContent('Merged')
    const done = screen.getByTestId('docflow-row-detail-A1')
    expect(done).toHaveTextContent(/^Document updated$/)
    expect(done).toHaveAttribute(
      'title',
      'Document updated: Struck through task A1 and added its notes.'
    )
    const failed = screen.getByTestId('docflow-row-detail-A2')
    expect(failed).toHaveTextContent('Document update failed: The document was not changed.')
    expect(failed.className).toContain('text-amber-600')
    expect(screen.getByTestId('docflow-row-detail-A3')).toHaveTextContent(
      'Document not updated: The document is read-only'
    )
  })

  it('skips a pending document update and retries a failed one from the row', async () => {
    await renderDashboard(
      makeDetail(LAUNCHED, [
        { key: 'A1', status: 'merged', document_update_status: 'updating' },
        { key: 'A2', status: 'merged', document_update_status: 'queued' },
        { key: 'A3', status: 'merged', session_id: 's-A3', document_update_status: 'failed' },
        { key: 'A4', status: 'merged', document_update_status: 'done' }
      ])
    )

    expect(screen.getByTestId('docflow-row-skip-doc-A1')).toHaveAccessibleName(
      'Skip document update'
    )
    expect(screen.getByTestId('docflow-row-skip-doc-A2')).toBeInTheDocument()
    expect(screen.queryByTestId('docflow-row-retry-doc-A1')).toBeNull()
    expect(screen.getByTestId('docflow-row-retry-doc-A3')).toHaveAccessibleName(
      'Retry document update'
    )
    expect(screen.queryByTestId('docflow-row-skip-doc-A3')).toBeNull()
    expect(screen.queryByTestId('docflow-row-retry-doc-A4')).toBeNull()
    expect(screen.queryByTestId('docflow-row-skip-doc-A4')).toBeNull()

    await click('docflow-row-skip-doc-A1')
    expect(api.updateItem).toHaveBeenLastCalledWith(
      'run-1',
      'item-A1',
      expect.objectContaining({
        document_update_status: 'skipped',
        document_update_detail: 'Skipped by you.'
      })
    )
    expect(api.updateItem.mock.lastCall?.[2]).not.toHaveProperty('status')

    await click('docflow-row-retry-doc-A3')
    expect(api.updateItem).toHaveBeenLastCalledWith(
      'run-1',
      'item-A3',
      expect.objectContaining({ document_update_status: 'queued', document_update_attempts: 0 })
    )
  })

  it('offers no document update actions once the run is over', async () => {
    await renderDashboard(
      makeDetail({ ...LAUNCHED, status: 'completed' }, [
        { key: 'A1', status: 'merged', session_id: 's-A1', document_update_status: 'failed' }
      ])
    )

    expect(screen.queryByTestId('docflow-row-retry-doc-A1')).toBeNull()
  })
})

describe('DocumentRunDashboard — model', () => {
  const chip = (key: string, index = 0): HTMLElement =>
    screen.getByTestId(`docflow-row-quick-model-${key}-${index}`)

  it('opens the picker from the badge of a ticket that has not launched, starting from its model', async () => {
    const detail = makeDetail(LAUNCHED, [
      { key: 'A1', status: 'pending' },
      { key: 'A2', status: 'running' }
    ])
    detail.run.config = { ...detail.run.config, defaultLaunch: CODEX_DEFAULT }
    await renderDashboard(detail)

    // Launched: a badge and nothing to click.
    expect(screen.getByTestId('docflow-row-model-A2')).toHaveTextContent('gpt-5.5')
    expect(screen.queryByTestId('docflow-row-model-trigger-A2')).toBeNull()
    // Waiting: the badge is the trigger; no picker (and no catalog request) until it is clicked.
    expect(screen.getByTestId('docflow-row-model-A1')).toHaveTextContent('gpt-5.5')
    expect(screen.queryByTestId('docflow-row-model-picker-A1')).toBeNull()
    expect(listModels).not.toHaveBeenCalled()

    await click('docflow-row-model-trigger-A1')
    // The picker starts from the model the ticket would launch with, the run default here.
    expect(screen.getByTestId('docflow-row-model-picker-A1-sdk-codex')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await click('docflow-row-model-picker-A1-sdk-claude-code-cli')
    expect(api.updateItem).toHaveBeenLastCalledWith('run-1', 'item-A1', {
      launch_config: {
        sdk: 'claude-code-cli',
        model: { providerID: 'anthropic', modelID: 'sonnet', variant: 'high' },
        codexFastMode: false,
        customProviderId: null
      }
    })
    expect(screen.getByTestId('docflow-row-model-A1')).toHaveTextContent(/sonnet/i)

    await click('docflow-row-model-picker-A1-clear')
    expect(api.updateItem).toHaveBeenLastCalledWith('run-1', 'item-A1', { launch_config: null })
  })

  it('offers to choose a model when the run has no default of its own', async () => {
    await renderDashboard(makeDetail(LAUNCHED, [{ key: 'A1', status: 'pending' }]))

    expect(screen.getByTestId('docflow-row-model-A1')).toHaveTextContent('app default')
    await click('docflow-row-model-trigger-A1')
    await click('docflow-row-model-picker-A1-choose')
    expect(api.updateItem).toHaveBeenLastCalledWith('run-1', 'item-A1', {
      launch_config: expect.objectContaining({ sdk: 'claude-code-cli' })
    })
  })

  it('lets a ticket whose launch failed be changed, not one its agent flagged', async () => {
    await renderDashboard(
      makeDetail(LAUNCHED, [
        { key: 'A1', status: 'needs_attention', session_id: null },
        { key: 'A2', status: 'needs_attention', session_id: 'session-2' },
        // Left out of the run: never launches, so nothing to choose.
        { key: 'A3', status: 'pending', selected: false }
      ])
    )

    expect(screen.getByTestId('docflow-row-model-trigger-A1')).toBeInTheDocument()
    expect(screen.queryByTestId('docflow-row-model-trigger-A2')).toBeNull()
    expect(screen.queryByTestId('docflow-row-model-trigger-A3')).toBeNull()
    expect(screen.getByTestId('docflow-row-model-A3')).toBeInTheDocument()
  })

  it('offers a model one ticket uses as one tap on every ticket that has not launched', async () => {
    await renderDashboard(
      makeDetail(LAUNCHED, [
        { key: 'A1', status: 'running', launch_config: SONNET_HIGH },
        { key: 'A2', status: 'pending' },
        { key: 'A3', status: 'pending', selected: false },
        { key: 'A4', status: 'merged' }
      ])
    )

    expect(chip('A2')).toHaveAttribute('aria-pressed', 'false')
    expect(chip('A2')).toHaveTextContent(/sonnet/i)
    expect(chip('A2')).toHaveTextContent('high')
    for (const key of ['A1', 'A3', 'A4']) {
      expect(screen.queryByTestId(`docflow-row-quick-models-${key}`)).toBeNull()
    }
    // Chips need no picker.
    expect(screen.queryByTestId('model-selector')).toBeNull()

    await click('docflow-row-quick-model-A2-0')
    expect(api.updateItem).toHaveBeenLastCalledWith('run-1', 'item-A2', {
      launch_config: SONNET_HIGH
    })
    expect(chip('A2')).toHaveAttribute('aria-pressed', 'true')
    // The pressed chip names the model, so the trigger only keeps its arrows.
    expect(screen.queryByTestId('docflow-row-model-A2')).toBeNull()
    expect(screen.getByTestId('docflow-row-model-trigger-A2')).toBeInTheDocument()

    await click('docflow-row-quick-model-A2-0')
    expect(api.updateItem).toHaveBeenLastCalledWith('run-1', 'item-A2', { launch_config: null })
    expect(chip('A2')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('docflow-row-model-A2')).toHaveTextContent('app default')
  })

  it('copies a model to every other ticket that has not launched, from the picker', async () => {
    await renderDashboard(
      makeDetail(LAUNCHED, [
        { key: 'A1', status: 'pending', launch_config: OPUS_ULTRACODE },
        { key: 'A2', status: 'pending' },
        { key: 'A3', status: 'pending', launch_config: OPUS_ULTRACODE },
        { key: 'A4', status: 'running' },
        { key: 'A5', status: 'needs_attention', session_id: null, launch_config: SONNET_HIGH },
        { key: 'A6', status: 'pending', selected: false }
      ])
    )

    await click('docflow-row-model-trigger-A1')
    expect(screen.getByTestId('docflow-row-model-apply-A1')).toHaveTextContent(
      'Also use for 2 other pending tickets'
    )
    await click('docflow-row-model-apply-A1')

    expect(api.updateItem).toHaveBeenCalledTimes(2)
    expect(api.updateItem).toHaveBeenCalledWith('run-1', 'item-A2', {
      launch_config: OPUS_ULTRACODE
    })
    expect(api.updateItem).toHaveBeenCalledWith('run-1', 'item-A5', {
      launch_config: OPUS_ULTRACODE
    })
    // Everyone is on it now: nothing left to copy to, and the chip for it is pressed on A2.
    expect(screen.queryByTestId('docflow-row-model-apply-A1')).toBeNull()
    expect(chip('A2')).toHaveAttribute('aria-pressed', 'true')
    expect(chip('A2')).toHaveTextContent('ultracode')
    expect(chip('A5')).toHaveAttribute('aria-pressed', 'true')
  })

  it('copies the run default back to the others once a ticket goes back to it', async () => {
    await renderDashboard(
      makeDetail(LAUNCHED, [
        { key: 'A1', status: 'pending' },
        { key: 'A2', status: 'pending', launch_config: SONNET_HIGH },
        { key: 'A3', status: 'pending' }
      ])
    )

    await click('docflow-row-model-trigger-A1')
    expect(screen.getByTestId('docflow-row-model-apply-A1')).toHaveTextContent(
      'Use the run default for 1 other pending ticket'
    )
    await click('docflow-row-model-apply-A1')
    expect(api.updateItem).toHaveBeenCalledTimes(1)
    expect(api.updateItem).toHaveBeenCalledWith('run-1', 'item-A2', { launch_config: null })
  })

  it('reports a model change that could not be saved', async () => {
    api.updateItem.mockRejectedValue(
      new Error('A2 has launched; its model can no longer be changed.')
    )
    await renderDashboard(
      makeDetail(LAUNCHED, [
        { key: 'A1', status: 'running', launch_config: SONNET_HIGH },
        { key: 'A2', status: 'pending' }
      ])
    )

    await click('docflow-row-quick-model-A2-0')

    expect(toast.error).toHaveBeenCalledWith(
      'Could not change the model of A2: A2 has launched; its model can no longer be changed.'
    )
    expect(chip('A2')).toHaveAttribute('aria-pressed', 'false')
  })

  it('shows the model read-only once the run is over', async () => {
    await renderDashboard(
      makeDetail({ ...LAUNCHED, status: 'completed' }, [
        { key: 'A1', status: 'merged', launch_config: SONNET_HIGH },
        { key: 'A2', status: 'skipped' }
      ])
    )

    expect(screen.getByTestId('docflow-row-model-A1')).toHaveTextContent(/sonnet/i)
    expect(screen.queryByTestId('docflow-row-model-trigger-A1')).toBeNull()
    expect(screen.queryByTestId('docflow-row-model-trigger-A2')).toBeNull()
    expect(screen.queryByTestId('docflow-row-quick-models-A2')).toBeNull()
  })
})

describe('DocumentRunDashboard — verification', () => {
  it('turns verification off for the tickets still to launch, without asking', async () => {
    await renderDashboard(
      makeDetail(LAUNCHED, [
        { key: 'A1', status: 'running', session_id: 's-1' },
        { key: 'A2', status: 'pending' }
      ])
    )
    const toggle = screen.getByTestId('docflow-dashboard-verification-switch')
    expect(toggle).toHaveAttribute('aria-checked', 'true')

    await click('docflow-dashboard-verification-switch')

    expect(screen.queryByTestId('docflow-confirm-action')).toBeNull()
    expect(api.updateRun).toHaveBeenCalledTimes(1)
    expect(api.updateRun).toHaveBeenCalledWith('run-1', { config: { verificationDisabled: true } })
    expect(screen.getByTestId('docflow-dashboard-verification-switch')).toHaveAttribute(
      'aria-checked',
      'false'
    )
    // Every ticket keeps its choice; the chips only stop taking clicks.
    expect(screen.getByTestId('docflow-row-verify-A2')).toHaveAttribute('data-disabled')
    expect(api.updateItem).not.toHaveBeenCalled()

    await click('docflow-dashboard-verification-switch')
    expect(api.updateRun).toHaveBeenLastCalledWith('run-1', {
      config: { verificationDisabled: false }
    })
    expect(screen.getByTestId('docflow-dashboard-verification-switch')).toHaveAttribute(
      'aria-checked',
      'true'
    )
  })

  it('shows the switch off while the run skips verification, on a paused run too', async () => {
    const detail = makeDetail({ ...LAUNCHED, status: 'paused' }, [{ key: 'A1', status: 'pending' }])
    detail.run.config = { ...detail.run.config, verificationDisabled: true }
    await renderDashboard(detail)

    expect(screen.getByTestId('docflow-dashboard-verification-switch')).toHaveAttribute(
      'aria-checked',
      'false'
    )
    expect(screen.getByTestId('docflow-row-verify-A1')).toHaveAttribute('data-disabled')
    expect(screen.getByTestId('docflow-row-verify-A1-tests')).toBeDisabled()
  })

  it('has no verification switch once the run is over', async () => {
    await renderDashboard(
      makeDetail({ ...LAUNCHED, status: 'completed' }, [{ key: 'A1', status: 'merged' }])
    )
    expect(screen.queryByTestId('docflow-dashboard-verification-switch')).toBeNull()
  })

  it('reports a verification change that could not be saved and leaves the switch as it was', async () => {
    api.updateRun.mockRejectedValue(new Error('offline'))
    await renderDashboard(makeDetail(LAUNCHED, [{ key: 'A1', status: 'pending' }]))

    await click('docflow-dashboard-verification-switch')

    expect(toast.error).toHaveBeenCalledWith('Could not change the verification setting: offline')
    expect(screen.getByTestId('docflow-dashboard-verification-switch')).toHaveAttribute(
      'aria-checked',
      'true'
    )
  })

  it('shows what each ticket verifies by, open only while it waits its turn', async () => {
    await renderDashboard(
      makeDetail(LAUNCHED, [
        {
          key: 'A1',
          status: 'running',
          session_id: 's-1',
          verification_suggested: ['tests'],
          verification: ['playwright', 'tests']
        },
        { key: 'A2', status: 'merged', verification: ['tests'] },
        { key: 'A3', status: 'pending', verification_suggested: ['tests'], verification: [] }
      ])
    )

    expect(screen.getByTestId('docflow-items')).toHaveTextContent('Verify by')
    for (const key of ['A1', 'A2', 'A3']) {
      expect(
        within(screen.getByTestId(`docflow-row-verify-${key}`)).getAllByRole('button')
      ).toHaveLength(3)
    }

    // Launched: shown as sent, no toggling.
    expect(screen.getByTestId('docflow-row-verify-A1-playwright')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByTestId('docflow-row-verify-A1-tests')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByTestId('docflow-row-verify-A1-tests')).toHaveAttribute('data-suggested')
    expect(screen.getByTestId('docflow-row-verify-A1-tcu')).toHaveAttribute('aria-pressed', 'false')
    for (const method of ['tcu', 'playwright', 'tests']) {
      expect(screen.getByTestId(`docflow-row-verify-A1-${method}`)).toBeDisabled()
      expect(screen.getByTestId(`docflow-row-verify-A2-${method}`)).toBeDisabled()
      expect(screen.getByTestId(`docflow-row-verify-A3-${method}`)).not.toBeDisabled()
    }
    expect(screen.getByTestId('docflow-row-verify-A2-tests')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByTestId('docflow-row-verify-A3-tests')).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    expect(screen.getByTestId('docflow-row-verify-A3-tests')).toHaveAttribute('data-suggested')
    expect(screen.queryByTestId('docflow-row-verify-A1')).not.toHaveAttribute('data-disabled')

    // A click on a launched ticket's chip writes nothing.
    await click('docflow-row-verify-A1-tcu')
    expect(api.updateItem).not.toHaveBeenCalled()
  })

  it('flips one method of a waiting ticket, writing the whole choice in canonical order', async () => {
    await renderDashboard(
      makeDetail(LAUNCHED, [{ key: 'A1', status: 'pending', verification: ['tests'] }])
    )

    await click('docflow-row-verify-A1-tcu')
    expect(api.updateItem).toHaveBeenCalledTimes(1)
    expect(api.updateItem).toHaveBeenCalledWith('run-1', 'item-A1', {
      verification: ['tcu', 'tests']
    })
    expect(screen.getByTestId('docflow-row-verify-A1-tcu')).toHaveAttribute('aria-pressed', 'true')

    await click('docflow-row-verify-A1-tests')
    expect(api.updateItem).toHaveBeenLastCalledWith('run-1', 'item-A1', {
      verification: ['tcu']
    })
    expect(screen.getByTestId('docflow-row-verify-A1-tests')).toHaveAttribute(
      'aria-pressed',
      'false'
    )
  })

  it('reports a chip change that could not be saved', async () => {
    api.updateItem.mockRejectedValue(
      new Error('A1 has launched; its verification can no longer be changed.')
    )
    await renderDashboard(makeDetail(LAUNCHED, [{ key: 'A1', status: 'pending' }]))

    await click('docflow-row-verify-A1-tests')

    expect(toast.error).toHaveBeenCalledWith(
      'Could not change the verification of A1: A1 has launched; its verification can no longer be changed.'
    )
    expect(screen.getByTestId('docflow-row-verify-A1-tests')).toHaveAttribute(
      'aria-pressed',
      'false'
    )
  })

  it('offers the chips read-only once the run is over', async () => {
    await renderDashboard(
      makeDetail({ ...LAUNCHED, status: 'completed' }, [
        { key: 'A1', status: 'merged', verification: ['tests'] },
        { key: 'A2', status: 'skipped', verification: [] }
      ])
    )

    expect(screen.getByTestId('docflow-row-verify-A1-tests')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    for (const method of ['tcu', 'playwright', 'tests']) {
      expect(screen.getByTestId(`docflow-row-verify-A1-${method}`)).toBeDisabled()
      expect(screen.getByTestId(`docflow-row-verify-A2-${method}`)).toBeDisabled()
    }
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
      'What is left for you: run the migrations, review, then move the run’s ticket to Done on the board to merge doc-checkout-redesign into main.'
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

describe('DocumentRunDashboard — executing migrations', () => {
  const MIGRATIONS = ['drizzle/0066_cart_items.sql', 'drizzle/0067_guest_orders.sql']
  const finished = (run: Partial<DocumentRunDetail['run']> = {}): DocumentRunDetail =>
    makeDetail(
      {
        ...LAUNCHED,
        status: 'completed',
        report: makeReport({ migrations: MIGRATIONS }),
        ...run
      },
      [{ key: 'A1', status: 'merged' }]
    )
  const migrating = (run: Partial<DocumentRunDetail['run']> = {}): DocumentRunDetail =>
    finished({
      migration_session_id: 'session-mig',
      migration_started_at: '2026-05-04T11:00:00.000Z',
      ...run
    })
  const inMigrations = (): ReturnType<typeof within> =>
    within(screen.getByTestId('docflow-report-migrations'))
  // The server's side of start and stop: the run records the session, or lets go of it.
  const recordSession = (runId: string, sessionId: string | null): void => {
    const detail = storedDetail(runId)
    useDocumentFlowStore
      .getState()
      .applyRun({ ...detail.run, migration_session_id: sessionId, migration_started_at: null })
  }
  const QUESTION: QuestionRequest = {
    id: 'question-1',
    sessionID: 'session-mig',
    questions: [{ question: 'Run 0067 as well?', header: 'Migrations', options: [] }]
  }
  const ARCHIVED_REASON =
    'The worktree of doc-checkout-redesign was archived, so there is no checkout of the branch to execute the migrations in.'
  const NO_WORKTREE_REASON = 'The run has no integration worktree to execute the migrations in.'

  beforeEach(() => {
    migrations.startRunMigrations.mockResolvedValue(undefined)
    migrations.stopRunMigrations.mockResolvedValue(undefined)
  })

  it.each(['completed', 'completed_with_issues'] as const)(
    'offers "Execute migrations" next to the migrations of a %s run',
    async (status) => {
      await renderDashboard(finished({ status }))

      const button = inMigrations().getByTestId('docflow-execute-migrations-btn')
      expect(button).toHaveTextContent('Execute migrations')
      expect(button).not.toBeDisabled()
      expect(button).not.toHaveAttribute('title')
      // Nothing stands in the way, so nothing is said about it.
      expect(screen.queryByTestId('docflow-migrations-blocked')).toBeNull()
      // The list it acts on is still there to read.
      expect(
        inMigrations()
          .getAllByRole('listitem')
          .map((item) => item.textContent)
      ).toEqual(MIGRATIONS)
      expect(screen.queryByTestId('docflow-stop-migrations-btn')).toBeNull()
      expect(screen.queryByTestId('docflow-migrations-running')).toBeNull()
      expect(screen.queryByTestId('docflow-migrations-waiting')).toBeNull()
      expect(screen.queryByTestId('docflow-open-migration-session')).toBeNull()
    }
  )

  it('offers nothing to execute when the run reported no migrations', async () => {
    await renderDashboard(finished({ report: makeReport({ manualSteps: ['Rotate the key'] }) }))

    expect(screen.getByTestId('docflow-report-manual-steps')).toBeInTheDocument()
    expect(screen.queryByTestId('docflow-report-migrations')).toBeNull()
    expect(screen.queryByTestId('docflow-execute-migrations-btn')).toBeNull()
    expect(screen.queryByTestId('docflow-stop-migrations-btn')).toBeNull()
  })

  it('starts the session only after a confirmation that names the integration branch', async () => {
    await renderDashboard(finished())

    await click('docflow-execute-migrations-btn')
    expect(screen.getByText('Execute the migrations against production?')).toBeInTheDocument()
    expect(
      screen.getByText(
        /It runs in the worktree of doc-checkout-redesign, the branch the run's tickets were merged into\./
      )
    ).toBeInTheDocument()
    expect(screen.getByTestId('docflow-confirm-action')).toHaveTextContent('Execute migrations')
    await click('docflow-confirm-cancel')
    expect(migrations.startRunMigrations).not.toHaveBeenCalled()
    expect(screen.queryByText('Execute the migrations against production?')).toBeNull()

    await click('docflow-execute-migrations-btn')
    await click('docflow-confirm-action')
    expect(migrations.startRunMigrations).toHaveBeenCalledTimes(1)
    expect(migrations.startRunMigrations).toHaveBeenCalledWith('run-1')
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('cannot be asked twice while the session is being started', async () => {
    let finishStart: () => void = () => {}
    migrations.startRunMigrations.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishStart = resolve
        })
    )
    await renderDashboard(finished())

    await click('docflow-execute-migrations-btn')
    await click('docflow-confirm-action')
    expect(screen.getByTestId('docflow-execute-migrations-btn')).toBeDisabled()
    await click('docflow-execute-migrations-btn')
    expect(screen.queryByText('Execute the migrations against production?')).toBeNull()

    // The server recorded the session, and the launch settled: Stop takes the button's place.
    await act(async () => {
      recordSession('run-1', 'session-mig')
      finishStart()
    })
    expect(migrations.startRunMigrations).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('docflow-execute-migrations-btn')).toBeNull()
    expect(screen.getByTestId('docflow-stop-migrations-btn')).not.toBeDisabled()
  })

  it('reports a session that could not be started and offers to execute again', async () => {
    migrations.startRunMigrations.mockRejectedValue(new Error('Could not create session'))
    await renderDashboard(finished())

    await click('docflow-execute-migrations-btn')
    await click('docflow-confirm-action')

    expect(toast.error).toHaveBeenCalledWith(
      'Could not execute the migrations: Could not create session'
    )
    expect(screen.getByTestId('docflow-execute-migrations-btn')).not.toBeDisabled()
    expect(screen.queryByTestId('docflow-stop-migrations-btn')).toBeNull()
    expect(screen.getByTestId('docflow-dashboard-status')).toHaveTextContent('Completed')
  })

  it('withholds the button, and says why, once the integration worktree was archived', async () => {
    // The project's worktrees are loaded, and the integration worktree is not among them.
    useWorktreeStore.setState({ worktreesByProject: new Map([[TEST_PROJECT.id, []]]) })
    await renderDashboard(finished())

    const button = screen.getByTestId('docflow-execute-migrations-btn')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', ARCHIVED_REASON)
    // In words next to the button: a disabled button shows no tooltip.
    expect(inMigrations().getByTestId('docflow-migrations-blocked')).toHaveTextContent(
      ARCHIVED_REASON
    )
    await click('docflow-execute-migrations-btn')
    expect(screen.queryByText('Execute the migrations against production?')).toBeNull()
    expect(migrations.startRunMigrations).not.toHaveBeenCalled()

    // Loaded with the worktree among them: nothing stands in the way.
    act(() => {
      useWorktreeStore.setState({
        worktreesByProject: new Map([[TEST_PROJECT.id, [{ id: 'wt-integration' }]]])
      } as never)
    })
    expect(screen.getByTestId('docflow-execute-migrations-btn')).not.toBeDisabled()
    expect(screen.getByTestId('docflow-execute-migrations-btn')).not.toHaveAttribute('title')
    expect(screen.queryByTestId('docflow-migrations-blocked')).toBeNull()
  })

  it('withholds the button for a run that has no integration worktree', async () => {
    await renderDashboard(finished({ integration_worktree_id: null }))

    const button = screen.getByTestId('docflow-execute-migrations-btn')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', NO_WORKTREE_REASON)
    expect(inMigrations().getByTestId('docflow-migrations-blocked')).toHaveTextContent(
      NO_WORKTREE_REASON
    )
  })

  it('says nothing stands in the way while the worktrees of the project are still unknown', async () => {
    // Not loaded yet: no list to miss the integration worktree in.
    expect(useWorktreeStore.getState().worktreesByProject.has(TEST_PROJECT.id)).toBe(false)
    await renderDashboard(finished())

    expect(screen.getByTestId('docflow-execute-migrations-btn')).not.toBeDisabled()
    expect(screen.queryByTestId('docflow-migrations-blocked')).toBeNull()
  })

  it('shows Stop, the session and "Running migrations" while the session is at it', async () => {
    await renderDashboard(migrating())

    expect(screen.queryByTestId('docflow-execute-migrations-btn')).toBeNull()
    expect(inMigrations().getByTestId('docflow-stop-migrations-btn')).toHaveTextContent(/^Stop$/)
    expect(inMigrations().getByTestId('docflow-stop-migrations-btn')).not.toBeDisabled()
    const marker = inMigrations().getByTestId('docflow-migrations-running')
    expect(marker).toHaveTextContent(/^Running migrations$/)
    expect(marker.className).toContain('text-fuchsia-500')
    expect(screen.queryByTestId('docflow-migrations-waiting')).toBeNull()
    expect(inMigrations().getByTestId('docflow-open-migration-session')).toHaveTextContent(
      'Open session'
    )
    expect(screen.getByTestId('docflow-dashboard-status')).toHaveTextContent(/^Running migrations$/)
    // Not while a session is working in its integration worktree.
    expect(screen.queryByTestId('docflow-delete-run-btn')).toBeNull()
    expect(inMigrations().getAllByRole('listitem')).toHaveLength(MIGRATIONS.length)
  })

  it('keeps Stop within reach after the integration worktree left the list', async () => {
    useWorktreeStore.setState({ worktreesByProject: new Map([[TEST_PROJECT.id, []]]) })
    await renderDashboard(migrating())

    expect(screen.getByTestId('docflow-stop-migrations-btn')).not.toBeDisabled()
    expect(screen.getByTestId('docflow-stop-migrations-btn')).not.toHaveAttribute('title')
    // Why Execute would be refused is no matter while there is no Execute.
    expect(screen.queryByTestId('docflow-migrations-blocked')).toBeNull()
  })

  it('says the migrations wait for the user while their session has a question pending', async () => {
    useQuestionStore.getState().addQuestion('session-mig', QUESTION)
    await renderDashboard(migrating())

    const marker = inMigrations().getByTestId('docflow-migrations-waiting')
    expect(marker).toHaveTextContent(/^Migrations waiting for you$/)
    expect(marker.className).toContain('text-orange-500')
    expect(screen.queryByTestId('docflow-migrations-running')).toBeNull()
    // The way to the session that asks, and to stop it, stays.
    expect(inMigrations().getByTestId('docflow-open-migration-session')).toBeInTheDocument()
    expect(inMigrations().getByTestId('docflow-stop-migrations-btn')).not.toBeDisabled()
    expect(screen.queryByTestId('docflow-execute-migrations-btn')).toBeNull()

    // Answered: the session is at it again.
    act(() => {
      useQuestionStore.getState().removeQuestion('session-mig', QUESTION.id)
    })
    expect(screen.queryByTestId('docflow-migrations-waiting')).toBeNull()
    expect(inMigrations().getByTestId('docflow-migrations-running')).toHaveTextContent(
      /^Running migrations$/
    )
  })

  it.each(['answering', 'permission', 'command_approval'] as const)(
    'says the migrations wait for the user while their session reports "%s"',
    async (status) => {
      useWorktreeStatusStore.setState({
        sessionStatuses: { 'session-mig': { status, timestamp: Date.now() } }
      })
      await renderDashboard(migrating())

      expect(inMigrations().getByTestId('docflow-migrations-waiting')).toHaveTextContent(
        /^Migrations waiting for you$/
      )
      expect(screen.queryByTestId('docflow-migrations-running')).toBeNull()

      // The session goes on: the marker is the one of migrations at work again.
      act(() => {
        useWorktreeStatusStore.setState({
          sessionStatuses: { 'session-mig': { status: 'working', timestamp: Date.now() } }
        })
      })
      expect(screen.queryByTestId('docflow-migrations-waiting')).toBeNull()
      expect(inMigrations().getByTestId('docflow-migrations-running')).toBeInTheDocument()
    }
  )

  it('keeps "Running migrations" while it is another session that waits on the user', async () => {
    useQuestionStore
      .getState()
      .addQuestion('session-other', { ...QUESTION, sessionID: 'session-other' })
    useWorktreeStatusStore.setState({
      sessionStatuses: {
        'session-mig': { status: 'working', timestamp: Date.now() },
        'session-other': { status: 'permission', timestamp: Date.now() }
      }
    })
    await renderDashboard(migrating())

    expect(inMigrations().getByTestId('docflow-migrations-running')).toHaveTextContent(
      /^Running migrations$/
    )
    expect(screen.queryByTestId('docflow-migrations-waiting')).toBeNull()
  })

  it('shows no marker of a waiting session once the run let go of it', async () => {
    useQuestionStore.getState().addQuestion('session-mig', QUESTION)
    await renderDashboard(finished())

    expect(screen.queryByTestId('docflow-migrations-waiting')).toBeNull()
    expect(screen.queryByTestId('docflow-migrations-running')).toBeNull()
    expect(inMigrations().getByTestId('docflow-execute-migrations-btn')).not.toBeDisabled()
  })

  it('stops the session at once, without asking, and offers to execute again', async () => {
    migrations.stopRunMigrations.mockImplementation(async (runId: string) => {
      recordSession(runId, null)
    })
    await renderDashboard(migrating())

    await click('docflow-stop-migrations-btn')

    expect(migrations.stopRunMigrations).toHaveBeenCalledTimes(1)
    expect(migrations.stopRunMigrations).toHaveBeenCalledWith('run-1')
    expect(screen.queryByTestId('docflow-confirm-action')).toBeNull()
    expect(migrations.startRunMigrations).not.toHaveBeenCalled()
    // The button is what it was before the session was started.
    expect(screen.queryByTestId('docflow-stop-migrations-btn')).toBeNull()
    expect(screen.queryByTestId('docflow-migrations-running')).toBeNull()
    const button = screen.getByTestId('docflow-execute-migrations-btn')
    expect(button).toHaveTextContent('Execute migrations')
    expect(button).not.toBeDisabled()
    expect(screen.getByTestId('docflow-dashboard-status')).toHaveTextContent('Completed')
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('reports a stop that failed and leaves Stop to try again', async () => {
    migrations.stopRunMigrations.mockRejectedValue(new Error('offline'))
    await renderDashboard(migrating())

    await click('docflow-stop-migrations-btn')

    expect(toast.error).toHaveBeenCalledWith('Could not stop the migrations: offline')
    expect(screen.getByTestId('docflow-stop-migrations-btn')).not.toBeDisabled()
    expect(screen.getByTestId('docflow-migrations-running')).toBeInTheDocument()
    expect(screen.queryByTestId('docflow-execute-migrations-btn')).toBeNull()
  })

  it('opens the migration session in the integration worktree and closes the dialog', async () => {
    useKanbanStore.setState({ isBoardViewActive: true } as never)
    await renderDashboard(migrating())

    await click('docflow-open-migration-session')

    expect(useKanbanStore.getState().isBoardViewActive).toBe(false)
    expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-integration')
    expect(useSessionStore.getState().activeWorktreeId).toBe('wt-integration')
    expect(useSessionStore.getState().activeSessionId).toBe('session-mig')
    expect(useProjectStore.getState().selectedProjectId).toBe(TEST_PROJECT.id)
    expect(useDocumentFlowStore.getState().dashboardRunId).toBeNull()
    // Reading the session stops nothing.
    expect(migrations.stopRunMigrations).not.toHaveBeenCalled()
  })

  it('offers to execute again, and to delete, once the run let go of its session', async () => {
    const detail = migrating()
    await renderDashboard(detail)
    expect(screen.getByTestId('docflow-stop-migrations-btn')).toBeInTheDocument()

    // The session ended on its own: the server's push clears it from the run.
    act(() => {
      useDocumentFlowStore
        .getState()
        .applyRun({ ...detail.run, migration_session_id: null, migration_started_at: null })
    })

    expect(screen.queryByTestId('docflow-stop-migrations-btn')).toBeNull()
    expect(screen.queryByTestId('docflow-migrations-running')).toBeNull()
    expect(screen.queryByTestId('docflow-open-migration-session')).toBeNull()
    expect(inMigrations().getByTestId('docflow-execute-migrations-btn')).not.toBeDisabled()
    expect(screen.getByTestId('docflow-dashboard-status')).toHaveTextContent('Completed')
    expect(screen.getByTestId('docflow-delete-run-btn')).toBeInTheDocument()
    expect(migrations.stopRunMigrations).not.toHaveBeenCalled()
  })
})

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import type { DocumentRun, DocumentRunDetail } from '@shared/types/document-flow'
import { DocumentRunDashboard } from './DocumentRunDashboard'
import { TEST_PROJECT, makeDetail, makeReport } from './test-fixtures'

const api = vi.hoisted(() => ({ get: vi.fn(), sourceFile: vi.fn() }))
const listModels = vi.hoisted(() => vi.fn())
const manualSteps = vi.hoisted(() => ({ launchManualStepsSession: vi.fn() }))
const navigation = vi.hoisted(() => ({ openSession: vi.fn() }))

vi.mock('@/api/document-flow-api', () => ({ documentFlowApi: api }))
vi.mock('@/api/project-api', () => ({ projectApi: { openPath: vi.fn() } }))
vi.mock('@/api/opencode-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/opencode-api')>()
  return { ...actual, opencodeApi: { ...actual.opencodeApi, listModels } }
})
vi.mock('@/lib/document-flow/manual-steps', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/document-flow/manual-steps')>()),
  launchManualStepsSession: manualSteps.launchManualStepsSession
}))
vi.mock('./document-flow-navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./document-flow-navigation')>()),
  openSession: navigation.openSession
}))
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

const initialFlow = useDocumentFlowStore.getState()
const initialProjects = useProjectStore.getState()
const initialSettings = useSettingsStore.getState()
const initialWorktrees = useWorktreeStore.getState()

const finished = (manualStepsList: string[], run: Partial<DocumentRun> = {}): DocumentRunDetail =>
  makeDetail(
    {
      status: 'completed',
      base_branch: 'main',
      integration_branch: 'doc-checkout-redesign',
      integration_worktree_id: 'wt-integration',
      report: makeReport({ manualSteps: manualStepsList }),
      ...run
    },
    [{ key: 'A1', status: 'merged' }]
  )

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
  Element.prototype.hasPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  listModels.mockResolvedValue({ success: true, providers: [] })
  api.sourceFile.mockResolvedValue({ path: '/docs/plan.html', exists: true })
  manualSteps.launchManualStepsSession.mockResolvedValue('session-9')
  useProjectStore.setState({ projects: [TEST_PROJECT] } as never)
  useSettingsStore.setState({
    defaultAgentSdk: 'claude-code-cli',
    availableAgentSdks: { opencode: true, claude: true, codex: true },
    customProviders: [],
    manualStepsPromptTemplate: null
  })
  useWorktreeStore.setState({
    worktreesByProject: new Map([
      [
        'project-1',
        [
          { id: 'wt-integration', is_default: false, branch_name: 'doc-checkout-redesign' },
          { id: 'wt-root', is_default: true, branch_name: 'main' }
        ]
      ]
    ]) as never,
    loadedProjectIds: new Set(['project-1']),
    loadWorktrees: vi.fn(async () => undefined)
  })
})

afterEach(async () => {
  await act(async () => {})
  cleanup()
  vi.resetAllMocks()
  useDocumentFlowStore.setState(initialFlow, true)
  useProjectStore.setState(initialProjects, true)
  useSettingsStore.setState(initialSettings, true)
  useWorktreeStore.setState(initialWorktrees, true)
})

describe('DocumentRunDashboard — a new session on the run’s branch', () => {
  it('sits next to the branch, once the run has one', async () => {
    await renderDashboard(finished(['Rotate the key']))
    expect(screen.getByTestId('docflow-new-branch-session')).toHaveTextContent('New session')
  })

  it('is not there before the run has a branch', async () => {
    await renderDashboard(finished([], { integration_branch: null }))
    expect(screen.queryByTestId('docflow-new-branch-session')).toBeNull()
  })

  it('opens over the dashboard and cancels back to it', async () => {
    await renderDashboard(finished(['Rotate the key']))
    await click('docflow-new-branch-session')
    expect(screen.getByTestId('ticket-create-modal')).toBeInTheDocument()

    await click('ticket-cancel-btn')
    expect(screen.queryByTestId('ticket-create-modal')).toBeNull()
    expect(screen.getByTestId('docflow-dashboard')).toBeInTheDocument()
  })
})

describe('DocumentRunDashboard — executing manual steps', () => {
  it('offers "Execute manual steps" next to the manual steps header', async () => {
    await renderDashboard(finished(['Rotate the key']))

    const section = within(screen.getByTestId('docflow-report-manual-steps'))
    expect(section.getByTestId('docflow-execute-manual-steps-btn')).toHaveTextContent(
      'Execute manual steps'
    )
    expect(section.getByTestId('docflow-execute-manual-steps-btn')).toBeEnabled()
    expect(section.queryByTestId('docflow-manual-steps-blocked')).toBeNull()
  })

  it('offers nothing when the run reported no manual steps', async () => {
    await renderDashboard(finished([]))

    expect(screen.queryByTestId('docflow-report-manual-steps')).toBeNull()
    expect(screen.queryByTestId('docflow-execute-manual-steps-btn')).toBeNull()
  })

  it('opens the prompt in a dialog of its own, and closes back to the dashboard', async () => {
    await renderDashboard(finished(['Rotate the key']))
    expect(screen.queryByTestId('docflow-manual-steps-dialog')).toBeNull()

    await click('docflow-execute-manual-steps-btn')
    expect(screen.getByTestId('docflow-manual-steps-dialog')).toBeInTheDocument()

    await click('docflow-manual-steps-cancel')
    expect(screen.queryByTestId('docflow-manual-steps-dialog')).toBeNull()
    expect(screen.getByTestId('docflow-dashboard')).toBeInTheDocument()
  })

  it('withholds the button, and says why, while a session executes the migrations', async () => {
    await renderDashboard(
      finished(['Run migration 0042 against production'], {
        migration_session_id: 'session-mig',
        migration_started_at: '2026-05-04T11:00:00.000Z'
      })
    )

    expect(screen.getByTestId('docflow-execute-manual-steps-btn')).toBeDisabled()
    expect(screen.getByTestId('docflow-manual-steps-blocked')).toHaveTextContent(
      'A session is executing the migrations of this run; execute the manual steps once it is done.'
    )
  })

  it('offers no way to the session before one is launched', async () => {
    await renderDashboard(finished(['Rotate the key']))
    expect(screen.queryByTestId('docflow-open-manual-steps-session')).toBeNull()
  })

  it('leads to the launched session from the manual steps row, closing the dashboard', async () => {
    await renderDashboard(finished(['Rotate the key']))
    await click('docflow-execute-manual-steps-btn')
    await click('docflow-manual-steps-launch')

    expect(screen.queryByTestId('docflow-manual-steps-dialog')).toBeNull()
    const section = within(screen.getByTestId('docflow-report-manual-steps'))
    expect(section.getByTestId('docflow-open-manual-steps-session')).toBeInTheDocument()

    await click('docflow-open-manual-steps-session')
    expect(navigation.openSession).toHaveBeenCalledWith(
      'project-1',
      'wt-integration',
      'session-9',
      null
    )
    expect(useDocumentFlowStore.getState().dashboardRunId).toBeNull()
  })
})

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useGitStore } from '@/stores/useGitStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useProjectStore } from '@/stores/useProjectStore'
import type { DocumentRunDetail, DocumentRunMember } from '@shared/types/document-flow'
import { DocumentRunDashboard } from './DocumentRunDashboard'
import { TEST_PROJECT, makeDetail } from './test-fixtures'

// The PR line of a launched run's dashboard: the PRs of its integration branches, and the
// button that makes them (the run's ticket card only links to them).

const api = vi.hoisted(() => ({ get: vi.fn(), sourceFile: vi.fn() }))
const systemApi = vi.hoisted(() => ({ openInChrome: vi.fn() }))
const runPRs = vi.hoisted(() => ({ createDocumentRunPRs: vi.fn() }))

vi.mock('@/api/document-flow-api', () => ({ documentFlowApi: api }))
vi.mock('@/api/project-api', () => ({ projectApi: { openPath: vi.fn() } }))
vi.mock('@/api/system-api', () => ({ systemApi }))
vi.mock('@/lib/document-flow/run-prs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/document-flow/run-prs')>()),
  createDocumentRunPRs: runPRs.createDocumentRunPRs
}))
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

const initialFlowState = useDocumentFlowStore.getState()
const initialGitState = useGitStore.getState()
const initialKanbanState = useKanbanStore.getState()
const initialProjectState = useProjectStore.getState()

const MEMBERS: DocumentRunMember[] = [
  {
    project_id: 'web',
    project_name: 'Web',
    project_path: '/repo/web',
    symlink_name: 'web',
    base_branch: 'main',
    base_sha: 'aaaaaaa1111111',
    integration_branch: 'doc-checkout',
    integration_worktree_id: 'wt-web-int',
    integration_worktree_path: '/worktrees/web--doc-checkout'
  },
  {
    project_id: 'api',
    project_name: 'API',
    project_path: '/repo/api',
    symlink_name: 'api',
    base_branch: 'master',
    base_sha: 'bbbbbbb2222222',
    integration_branch: 'doc-checkout',
    integration_worktree_id: 'wt-api-int',
    integration_worktree_path: '/worktrees/api--doc-checkout'
  }
]

const gitRun = (): DocumentRunDetail =>
  makeDetail(
    {
      id: 'run-live',
      project_id: TEST_PROJECT.id,
      status: 'completed',
      ticket_id: 'ticket-run',
      base_branch: 'main',
      base_sha: '1111111aaaaaaa',
      integration_branch: 'doc-checkout-redesign',
      integration_worktree_id: 'wt-integration',
      integration_worktree_path: '/worktrees/shop--doc-checkout-redesign'
    },
    [{ key: 'A1', status: 'merged' }]
  )

const connectionRun = (): DocumentRunDetail =>
  makeDetail(
    {
      id: 'run-live',
      project_id: TEST_PROJECT.id,
      status: 'completed',
      base_branch: 'main + master',
      integration_branch: 'doc-checkout',
      integration_connection_id: 'conn-int',
      integration_connection_path: '/connections/doc-checkout',
      members: MEMBERS
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

const prButton = (): HTMLElement => screen.getByTestId('docflow-run-pr-button-run-live')

beforeEach(() => {
  api.get.mockImplementation(
    async (runId: string) => useDocumentFlowStore.getState().runsById[runId] ?? null
  )
  api.sourceFile.mockResolvedValue({ path: '/docs/checkout-redesign.html', exists: true })
  runPRs.createDocumentRunPRs.mockResolvedValue([])
  useProjectStore.setState({ projects: [TEST_PROJECT] } as never)
})

afterEach(async () => {
  await act(async () => {})
  cleanup()
  vi.resetAllMocks()
  useDocumentFlowStore.setState(initialFlowState, true)
  useGitStore.setState(initialGitState, true)
  useKanbanStore.setState(initialKanbanState, true)
  useProjectStore.setState(initialProjectState, true)
})

describe('DocumentRunDashboard — pull requests', () => {
  it('offers nothing before the run is launched: there is no integration branch yet', async () => {
    await renderDashboard(makeDetail({ id: 'run-live', status: 'preview' }))

    expect(screen.queryByTestId('docflow-run-prs-run-live')).toBeNull()
  })

  it('creates a PR from the integration branch of a git run, keeping the dashboard open', async () => {
    await renderDashboard(gitRun())

    expect(screen.getByTestId('docflow-run-prs-run-live')).toHaveTextContent(
      'No pull request yet'
    )
    expect(prButton()).toHaveTextContent(/^Create PR$/)
    expect(prButton()).toBeEnabled()
    fireEvent.click(prButton())

    await waitFor(() => expect(runPRs.createDocumentRunPRs).toHaveBeenCalledTimes(1))
    expect(runPRs.createDocumentRunPRs).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'run-live', integration_worktree_id: 'wt-integration' })
    )
    expect(useDocumentFlowStore.getState().dashboardRunId).toBe('run-live')
  })

  it('creates one PR per member of a connection run', async () => {
    await renderDashboard(connectionRun())

    expect(prButton()).toHaveTextContent(/^Create PRs$/)
    fireEvent.click(prButton())

    await waitFor(() => expect(runPRs.createDocumentRunPRs).toHaveBeenCalledTimes(1))
    expect(runPRs.createDocumentRunPRs).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'run-live', members: MEMBERS })
    )
  })

  it('lists the PRs the integration branches have and opens them; updates once all exist', async () => {
    useGitStore.getState().setAttachedPR('wt-web-int', {
      number: 12,
      url: 'https://github.com/acme/web/pull/12'
    })
    await renderDashboard(connectionRun())

    const webLink = screen.getByTestId('docflow-run-pr-link-run-live-wt-web-int')
    expect(webLink).toHaveTextContent(/^Web #12$/)
    expect(screen.queryByTestId('docflow-run-pr-link-run-live-wt-api-int')).toBeNull()
    // One member still has no PR: the button still creates.
    expect(prButton()).toHaveTextContent(/^Create PRs$/)

    fireEvent.click(webLink)
    expect(systemApi.openInChrome).toHaveBeenCalledWith('https://github.com/acme/web/pull/12')

    act(() => {
      useGitStore.getState().setAttachedPR('wt-api-int', {
        number: 3,
        url: 'https://github.com/acme/api/pull/3'
      })
    })
    expect(screen.getByTestId('docflow-run-pr-link-run-live-wt-api-int')).toHaveTextContent(
      /^API #3$/
    )
    expect(prButton()).toHaveTextContent(/^Update PRs$/)
  })

  it("shows a git run's PR from its ticket", async () => {
    useKanbanStore.setState({
      tickets: new Map([
        [
          TEST_PROJECT.id,
          [
            {
              id: 'ticket-run',
              project_id: TEST_PROJECT.id,
              column: 'review',
              github_pr_number: 7,
              github_pr_url: 'https://github.com/acme/shop/pull/7'
            }
          ]
        ]
      ])
    } as never)
    await renderDashboard(gitRun())

    expect(screen.getByTestId('docflow-run-pr-link-run-live-wt-integration')).toHaveTextContent(
      /^#7$/
    )
    expect(prButton()).toHaveTextContent(/^Update PR$/)
  })

  it('waits while a PR is on its way', async () => {
    useGitStore.getState().setCreatingPR('wt-integration', true)
    await renderDashboard(gitRun())

    expect(prButton()).toBeDisabled()
    expect(prButton()).toHaveTextContent(/^Creating PR…$/)
  })
})

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import {
  DEFAULT_DOCUMENT_RUN_CONFIG,
  type DocumentRunConfig,
  type DocumentRunDetail,
  type DocumentRunMember,
  type DocumentRunPatch
} from '@shared/types/document-flow'
import { ImplementDocumentWizard } from './ImplementDocumentWizard'
import { makeDetail } from './test-fixtures'
import { DOCFLOW_TEXT_DEBOUNCE_MS } from './useDebouncedText'

// The preview of a run on a CONNECTION project: one base branch and one verify command per
// member project. The git-project preview has its own tests (ImplementDocumentWizard.preview).

const api = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
  updateRun: vi.fn(),
  updateItem: vi.fn(),
  start: vi.fn(),
  retryExtraction: vi.fn(),
  suggestVerifyCommand: vi.fn()
}))
const listBranchesWithStatus = vi.hoisted(() => vi.fn())

vi.mock('@/api/document-flow-api', () => ({ documentFlowApi: api }))
vi.mock('@/api/git-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/git-api')>()
  return { ...actual, gitApi: { ...actual.gitApi, listBranchesWithStatus } }
})
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

const initialFlowState = useDocumentFlowStore.getState()
const initialProjectState = useProjectStore.getState()
const initialSettingsState = useSettingsStore.getState()

const CONNECTION_PROJECT = {
  id: 'project-conn',
  name: 'Shop stack',
  path: '/connections/shop-stack',
  kind: 'connection',
  member_project_ids: '["web","api"]'
} as const
const WEB = { id: 'web', name: 'Web', path: '/repo/web', kind: 'git' } as const
const API = { id: 'api', name: 'API', path: '/repo/api', kind: 'git' } as const

const MEMBERS: DocumentRunMember[] = [
  {
    project_id: 'web',
    project_name: 'Web',
    project_path: '/repo/web',
    symlink_name: 'web',
    base_branch: 'main',
    base_sha: 'aaaaaaa1111111',
    integration_branch: 'doc-checkout-redesign',
    integration_worktree_id: 'wt-web-int',
    integration_worktree_path: '/worktrees/web--doc-checkout-redesign'
  },
  {
    project_id: 'api',
    project_name: 'API',
    project_path: '/repo/api',
    symlink_name: 'api',
    base_branch: 'master',
    base_sha: 'bbbbbbb2222222',
    integration_branch: 'doc-checkout-redesign',
    integration_worktree_id: 'wt-api-int',
    integration_worktree_path: '/worktrees/api--doc-checkout-redesign'
  }
]

/** Both members' commands chosen, so no suggestion is asked for unless a test wants one. */
const CHOSEN: Partial<DocumentRunConfig> = {
  verifyCommand: null,
  memberVerifyCommands: { web: 'pnpm check', api: '' }
}

const connectionDetail = (config: Partial<DocumentRunConfig> = CHOSEN): DocumentRunDetail =>
  makeDetail({
    project_id: CONNECTION_PROJECT.id,
    config: { ...DEFAULT_DOCUMENT_RUN_CONFIG, ...config }
  })

const storedDetail = (runId: string): DocumentRunDetail =>
  useDocumentFlowStore.getState().runsById[runId]

async function renderPreview(detail: DocumentRunDetail = connectionDetail()): Promise<void> {
  useDocumentFlowStore.setState({
    runsById: { [detail.run.id]: detail },
    wizard: { open: true, projectId: CONNECTION_PROJECT.id, runId: detail.run.id }
  })
  await act(async () => {
    render(<ImplementDocumentWizard />)
  })
}

const optionsOf = (testId: string): (string | null)[] =>
  within(screen.getByTestId(testId))
    .getAllByRole('option')
    .map((option) => option.textContent)

beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  api.updateRun.mockImplementation(async (runId: string, patch: DocumentRunPatch) => {
    const { run } = storedDetail(runId)
    return { ...run, config: { ...run.config, ...patch.config } }
  })
  api.start.mockImplementation(async (runId: string) => {
    const detail = storedDetail(runId)
    return {
      ...detail,
      run: {
        ...detail.run,
        status: 'running',
        integration_branch: 'doc-checkout-redesign',
        integration_connection_id: 'conn-int',
        members: MEMBERS
      }
    }
  })
  api.get.mockImplementation(async (runId: string) => storedDetail(runId) ?? null)
  api.list.mockResolvedValue([])
  api.suggestVerifyCommand.mockResolvedValue(null)
  // Each member repository has its own branches; the root checkout of web is on main, of api
  // on master.
  listBranchesWithStatus.mockImplementation(async (path: string) => ({
    success: true,
    branches:
      path === WEB.path
        ? [
            { name: 'main', isRemote: false, isCheckedOut: true, worktreePath: WEB.path },
            { name: 'develop', isRemote: false, isCheckedOut: false },
            { name: 'origin/main', isRemote: true, isCheckedOut: false }
          ]
        : [
            { name: 'master', isRemote: false, isCheckedOut: true, worktreePath: API.path },
            { name: 'release', isRemote: false, isCheckedOut: false }
          ]
  }))
  useProjectStore.setState({ projects: [CONNECTION_PROJECT, WEB, API] } as never)
  useSettingsStore.setState({
    defaultAgentSdk: 'claude-code-cli',
    availableAgentSdks: { opencode: true, claude: true, codex: true },
    selectedModel: null,
    selectedModelByProvider: {},
    defaultModels: null,
    customProviders: []
  })
})

afterEach(async () => {
  await act(async () => {})
  cleanup()
  vi.useRealTimers()
  vi.resetAllMocks()
  useDocumentFlowStore.setState(initialFlowState, true)
  useProjectStore.setState(initialProjectState, true)
  useSettingsStore.setState(initialSettingsState, true)
})

describe('ImplementDocumentWizard — connection project settings', () => {
  it('says the run spans the member repositories', async () => {
    await renderPreview()

    expect(screen.getByTestId('docflow-wizard')).toHaveTextContent(
      'Turn a spec document into tickets for Shop stack and run them into one integration branch per member repository.'
    )
  })

  it("offers one base-branch select per member, each with that member's branches", async () => {
    await renderPreview()

    expect(screen.queryByTestId('docflow-base-branch')).toBeNull()
    expect(listBranchesWithStatus).toHaveBeenCalledWith(WEB.path)
    expect(listBranchesWithStatus).toHaveBeenCalledWith(API.path)
    expect(listBranchesWithStatus).not.toHaveBeenCalledWith(CONNECTION_PROJECT.path)
    const panel = screen.getByTestId('docflow-member-base-branches')
    expect(panel).toHaveTextContent('Web')
    expect(panel).toHaveTextContent('API')
    expect(panel).toHaveTextContent('every ticket gets a worktree in every member project')
    expect(optionsOf('docflow-base-branch-web')).toEqual([
      'Current branch (main)',
      'develop',
      'main'
    ])
    expect(optionsOf('docflow-base-branch-api')).toEqual([
      'Current branch (master)',
      'master',
      'release'
    ])
  })

  it('writes a member base branch under the member id, leaving the other members alone', async () => {
    await renderPreview(connectionDetail({ ...CHOSEN, memberBaseBranches: { api: 'release' } }))

    await act(async () => {
      fireEvent.change(screen.getByTestId('docflow-base-branch-web'), {
        target: { value: 'develop' }
      })
    })
    expect(api.updateRun).toHaveBeenLastCalledWith('run-1', {
      config: expect.objectContaining({
        memberBaseBranches: { web: 'develop', api: 'release' },
        baseBranch: null
      })
    })

    await act(async () => {
      fireEvent.change(screen.getByTestId('docflow-base-branch-web'), { target: { value: '' } })
    })
    expect(api.updateRun).toHaveBeenLastCalledWith('run-1', {
      config: expect.objectContaining({ memberBaseBranches: { web: null, api: 'release' } })
    })
  })

  it('offers one verify command per member and writes it after the typing pause', async () => {
    vi.useFakeTimers()
    await renderPreview()

    expect(screen.queryByTestId('docflow-verify-command')).toBeNull()
    expect(screen.getByTestId('docflow-verify-command-web')).toHaveValue('pnpm check')
    expect(screen.getByTestId('docflow-verify-command-api')).toHaveValue('')
    expect(screen.getByTestId('docflow-member-verify-commands')).toHaveTextContent(
      'leave one empty to skip that member'
    )

    fireEvent.change(screen.getByTestId('docflow-verify-command-api'), {
      target: { value: 'make test' }
    })
    expect(api.updateRun).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOCFLOW_TEXT_DEBOUNCE_MS)
    })

    expect(api.updateRun).toHaveBeenCalledTimes(1)
    expect(api.updateRun).toHaveBeenCalledWith('run-1', {
      config: expect.objectContaining({
        memberVerifyCommands: { web: 'pnpm check', api: 'make test' },
        verifyCommand: null
      })
    })
  })

  it('suggests a command per member whose command was never chosen, from that member', async () => {
    api.suggestVerifyCommand.mockImplementation(async (projectId: string) =>
      projectId === 'api' ? 'make test' : null
    )
    await renderPreview(connectionDetail({ verifyCommand: null, memberVerifyCommands: {} }))

    expect(api.suggestVerifyCommand).toHaveBeenCalledTimes(2)
    expect(api.suggestVerifyCommand).toHaveBeenCalledWith('web')
    expect(api.suggestVerifyCommand).toHaveBeenCalledWith('api')
    expect(api.suggestVerifyCommand).not.toHaveBeenCalledWith(CONNECTION_PROJECT.id)
    expect(screen.getByTestId('docflow-verify-command-api')).toHaveValue('make test')
    expect(screen.getByTestId('docflow-verify-command-web')).toHaveValue('')
    expect(api.updateRun).toHaveBeenLastCalledWith('run-1', {
      config: expect.objectContaining({ memberVerifyCommands: { api: 'make test' } })
    })
  })

  it('starts from the commands remembered per member and asks for the rest', async () => {
    useDocumentFlowStore.setState({
      prefs: {
        ...initialFlowState.prefs,
        verifyCommandByProject: { web: 'pnpm typecheck', [CONNECTION_PROJECT.id]: 'ignored' }
      }
    })
    api.suggestVerifyCommand.mockResolvedValue('make test')
    await renderPreview(connectionDetail({ verifyCommand: null, memberVerifyCommands: {} }))

    expect(screen.getByTestId('docflow-verify-command-web')).toHaveValue('pnpm typecheck')
    expect(api.suggestVerifyCommand).toHaveBeenCalledTimes(1)
    expect(api.suggestVerifyCommand).toHaveBeenCalledWith('api')
    expect(screen.getByTestId('docflow-verify-command-api')).toHaveValue('make test')
    expect(api.updateRun).toHaveBeenLastCalledWith('run-1', {
      config: expect.objectContaining({
        memberVerifyCommands: { web: 'pnpm typecheck', api: 'make test' }
      })
    })
  })

  it('keeps a remembered "no verification" for a member instead of asking for a suggestion', async () => {
    useDocumentFlowStore.setState({
      prefs: { ...initialFlowState.prefs, verifyCommandByProject: { web: '', api: 'make' } }
    })
    await renderPreview(connectionDetail({ verifyCommand: null, memberVerifyCommands: {} }))

    expect(api.suggestVerifyCommand).not.toHaveBeenCalled()
    expect(screen.getByTestId('docflow-verify-command-web')).toHaveValue('')
    expect(screen.getByTestId('docflow-verify-command-api')).toHaveValue('make')
  })
})

describe('ImplementDocumentWizard — connection project launch', () => {
  it('lists every member base branch and verify command before launching', async () => {
    await renderPreview(connectionDetail({ ...CHOSEN, memberBaseBranches: { web: 'develop' } }))

    fireEvent.click(screen.getByTestId('docflow-launch-btn'))

    const dialog = screen.getByTestId('docflow-launch-confirm')
    expect(dialog).toHaveTextContent(
      'An integration branch is created in every member repository from its base branch'
    )
    expect(dialog).toHaveTextContent('The base branches themselves are not modified.')
    // web has a branch of its own; api falls back to its root checkout's branch.
    expect(dialog).toHaveTextContent('Base branchesdevelop (Web) · master (API)')
    expect(dialog).toHaveTextContent('Verify commandsWeb: pnpm check · API: none')
    expect(dialog).not.toHaveTextContent('Base branchmain')
  })

  it('says there is no verify command when no member has one', async () => {
    await renderPreview(
      connectionDetail({ verifyCommand: 'pnpm check', memberVerifyCommands: { web: '', api: ' ' } })
    )

    fireEvent.click(screen.getByTestId('docflow-launch-btn'))

    // The git-project command is not read for a connection project.
    expect(screen.getByTestId('docflow-launch-confirm')).toHaveTextContent(
      'Verify commandsno verify command'
    )
  })

  it('launches with the member settings and remembers the verify commands per member', async () => {
    await renderPreview()

    fireEvent.click(screen.getByTestId('docflow-launch-btn'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('docflow-launch-confirm-btn'))
    })

    expect(api.updateRun).toHaveBeenCalledWith('run-1', {
      config: expect.objectContaining({ memberVerifyCommands: { web: 'pnpm check', api: '' } })
    })
    expect(api.start).toHaveBeenCalledWith('run-1', expect.any(String))
    expect(useDocumentFlowStore.getState().prefs.verifyCommandByProject).toEqual({
      web: 'pnpm check',
      api: ''
    })
    expect(useDocumentFlowStore.getState().wizard.open).toBe(false)
    expect(useDocumentFlowStore.getState().dashboardRunId).toBe('run-1')
  })
})

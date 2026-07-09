import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WorktreePickerModal,
  _resetLastSourceBranch,
  buildRemotePrompt
} from './WorktreePickerModal'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { PLAN_MODE_PREFIX } from '@/lib/constants'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useUsageStore } from '@/stores/useUsageStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useRemoteLaunchStore } from '@/stores/useRemoteLaunchStore'
import type { RemoteLaunchPreflightResult, RemoteLaunchStartResult } from '@shared/types/remote-launch'
import type { KanbanTicket, Session } from '../../../../main/db/types'

vi.mock('@/api/hive-enterprise/client', () => ({
  isHiveTelemetryEnabled: vi.fn(() => false),
  recordHivePromptStart: vi.fn(),
  recordHivePromptIdle: vi.fn(),
  recordHiveQuestionsAnswered: vi.fn()
}))

vi.mock('@/components/sessions/ModelSelector', () => ({
  ModelSelector: ({
    onChange
  }: {
    onChange?: (model: {
      agentSdk?: 'opencode' | 'claude-code' | 'claude-code-cli' | 'codex'
      providerID: string
      modelID: string
      variant?: string
    }) => void
  }) => (
    <button
      type="button"
      data-testid="model-selector-pick-opus"
      onClick={() =>
        onChange?.({
          agentSdk: 'claude-code-cli',
          providerID: 'anthropic',
          modelID: 'opus',
          variant: 'high'
        })
      }
    >
      Opus high
    </button>
  )
}))

vi.mock('@/components/sessions/CodexFastToggle', () => ({
  CodexFastToggle: () => <div data-testid="codex-fast-toggle" />
}))

vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

vi.mock('@/api/settings-api', () => ({
  settingsApi: {
    detectEditors: vi.fn(),
    detectTerminals: vi.fn(),
    loadCustomCommandsFile: vi.fn().mockResolvedValue({ commands: [] }),
    onSettingsUpdated: vi.fn(() => vi.fn()),
    openWithTerminal: vi.fn()
  }
}))

vi.mock('@/api/pet-api', () => ({
  petApi: {
    updateSettings: vi.fn().mockResolvedValue({
      success: true,
      value: {
        enabled: true,
        size: 'md',
        position: { x: 0, y: 0 },
        hatched: true
      }
    })
  }
}))

const initialSettingsState = useSettingsStore.getState()
const initialSessionState = useSessionStore.getState()
const initialWorktreeState = useWorktreeStore.getState()
const initialConnectionState = useConnectionStore.getState()
const initialKanbanState = useKanbanStore.getState()
const initialProjectState = useProjectStore.getState()
const initialUsageState = useUsageStore.getState()
const initialWorktreeStatusState = useWorktreeStatusStore.getState()
const initialRemoteLaunchState = useRemoteLaunchStore.getState()

const TELEPORT_SETTINGS = { url: 'https://remote.example.com', bootstrapToken: 'tok-123' }

const baseTicket: KanbanTicket = {
  id: 'ticket-1',
  project_id: 'project-1',
  title: 'Launch on remote',
  description: 'Make ticket launch on a remote machine',
  column: 'todo',
  sort_order: 0,
  worktree_id: null,
  current_session_id: null,
  mode: 'build',
  plan_ready: false,
  goal_mode: false,
  goal_success_criteria: null,
  pending_launch_config: null,
  created_from_session: false,
  auto_approve_plan: false,
  attachments: [],
  archived_at: null,
  external_provider: null,
  external_id: null,
  external_url: null,
  github_pr_number: null,
  github_pr_url: null,
  mark: null,
  note: null,
  total_tokens: 0,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z'
}

const ticketWithAttachments: KanbanTicket = {
  ...baseTicket,
  attachments: [{ type: 'image', url: 'http://example.com/img.png', label: 'img' }]
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    worktree_id: 'worktree-1',
    project_id: 'project-1',
    connection_id: null,
    name: 'Session 1',
    status: 'active',
    opencode_session_id: null,
    claude_session_id: null,
    agent_sdk: 'claude-code-cli',
    mode: 'build',
    session_type: 'default',
    model_provider_id: 'anthropic',
    model_id: 'opus',
    model_variant: 'high',
    remote_launch: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    completed_at: null,
    pinned_to_board: false,
    ...overrides
  }
}

const PASSING_PREFLIGHT: RemoteLaunchPreflightResult = {
  remoteConfigured: true,
  branchOnOrigin: true,
  localAhead: 0,
  localBehind: 0,
  diverged: false,
  transfers: [],
  transferErrors: []
}

function setupStores(options: { teleport?: typeof TELEPORT_SETTINGS | null } = {}): {
  createSession: ReturnType<typeof vi.fn>
  createWorktreeFromBranch: ReturnType<typeof vi.fn>
  updateTicket: ReturnType<typeof vi.fn>
} {
  const createSession = vi.fn(async () => ({ success: true, session: makeSession() }))
  const createWorktreeFromBranch = vi.fn()
  const updateTicket = vi.fn(async () => undefined)

  useSettingsStore.setState({
    availableAgentSdks: { opencode: true, claude: true, codex: true },
    defaultAgentSdk: 'opencode',
    selectedModel: null,
    selectedModelByProvider: {},
    defaultModels: null,
    codexFastMode: false,
    codexFastModeAccepted: true,
    boardMode: 'toggle',
    teleport: options.teleport === undefined ? TELEPORT_SETTINGS : options.teleport
  })
  useProjectStore.setState({
    projects: [
      {
        id: 'project-1',
        name: 'Hive',
        path: '',
        description: null,
        tags: null,
        language: null,
        custom_icon: null,
        detected_icon: null,
        setup_script: null,
        run_script: null,
        archive_script: null,
        worktree_create_script: null,
        custom_commands: null,
        auto_assign_port: false,
        sort_order: 0,
        created_at: '2026-01-01T00:00:00.000Z',
        last_accessed_at: '2026-01-01T00:00:00.000Z'
      }
    ]
  })
  useWorktreeStore.setState({
    worktreesByProject: new Map([
      [
        'project-1',
        [
          {
            id: 'worktree-1',
            project_id: 'project-1',
            name: 'Feature',
            branch_name: 'main',
            path: '/repo/feature',
            status: 'active',
            is_default: true,
            branch_renamed: 0,
            last_message_at: null,
            session_titles: '[]',
            last_model_provider_id: null,
            last_model_id: null,
            last_model_variant: null,
            attachments: '[]',
            created_at: '2026-01-01T00:00:00.000Z',
            last_accessed_at: '2026-01-01T00:00:00.000Z',
            github_pr_number: null,
            github_pr_url: null
          }
        ]
      ]
    ]),
    worktreeOrderByProject: new Map(),
    syncWorktrees: vi.fn(),
    createWorktreeFromBranch
  })
  useConnectionStore.setState({
    connections: [],
    loaded: true
  })
  useKanbanStore.setState({
    tickets: new Map([['project-1', [baseTicket]]]),
    updateTicket,
    computeSortOrder: vi.fn(() => 1),
    getTicketsByColumn: vi.fn(() => []),
    getTicketsByColumnForConnection: vi.fn(() => [])
  })
  useSessionStore.setState({
    sessionsByWorktree: new Map(),
    sessionsByConnection: new Map(),
    modeBySession: new Map(),
    createSession,
    createConnectionSession: vi.fn(),
    setSessionModel: vi.fn(async () => undefined),
    setSessionMode: vi.fn(async () => undefined),
    setOpenCodeSessionId: vi.fn(),
    setActiveSession: vi.fn()
  })
  useWorktreeStatusStore.setState({
    setSessionStatus: vi.fn(),
    setLastMessageTime: vi.fn()
  })
  useUsageStore.setState({
    fetchUsageForProvider: vi.fn()
  })
  useRemoteLaunchStore.setState({
    remoteBySessionId: {},
    ensureLoaded: vi.fn(async () => undefined),
    setRemoteInfo: vi.fn()
  })

  return { createSession, createWorktreeFromBranch, updateTicket }
}

function renderModal(
  props: Partial<React.ComponentProps<typeof WorktreePickerModal>> = {}
): void {
  render(
    <WorktreePickerModal
      ticket={baseTicket}
      projectId="project-1"
      open
      onOpenChange={vi.fn()}
      onSendComplete={vi.fn()}
      {...props}
    />
  )
}

// ── buildRemotePrompt (pure) ─────────────────────────────────────────
describe('buildRemotePrompt', () => {
  it('strips attachments and uses buildPrompt output when the user has not edited the prefill', () => {
    const prefill =
      'Please implement the following ticket.\n\n' +
      '<ticket title="Launch on remote">Make ticket launch on a remote machine' +
      '\n<attachments>\n<file path="http://example.com/img.png">img</file>\n</attachments></ticket>'

    const result = buildRemotePrompt('build', ticketWithAttachments, prefill)

    expect(result).toBe(
      'Please implement the following ticket.\n\n' +
        '<ticket title="Launch on remote">Make ticket launch on a remote machine</ticket>'
    )
    expect(result).not.toContain('<attachments>')
  })

  it('respects user-edited prompt text verbatim (no attachments block present)', () => {
    const edited = 'Do the custom thing the user typed.'

    const result = buildRemotePrompt('plan', baseTicket, edited)

    expect(result).toBe('Do the custom thing the user typed.')
    expect(result).not.toContain(PLAN_MODE_PREFIX)
  })

  it('strips an embedded attachments block even from edited text', () => {
    const edited =
      'Please implement the following ticket.\n\n' +
      '<ticket title="Launch on remote">Make ticket launch on a remote machine' +
      '\n<attachments>\n<file path="http://example.com/img.png">img</file>\n</attachments></ticket>' +
      '\n\nAlso double check the extra file.'

    const result = buildRemotePrompt('build', ticketWithAttachments, edited)

    expect(result).toBe(
      'Please implement the following ticket.\n\n' +
        '<ticket title="Launch on remote">Make ticket launch on a remote machine</ticket>' +
        '\n\nAlso double check the extra file.'
    )
    expect(result).not.toContain('<attachments>')
  })

  it('matches composePromptForSdk claude-cli behavior: no synthetic plan prefix for plan mode', () => {
    const prefill =
      'Please review the following ticket and create a detailed implementation plan.\n\n' +
      '<ticket title="Launch on remote">Make ticket launch on a remote machine</ticket>'

    const result = buildRemotePrompt('plan', baseTicket, prefill)

    expect(result).toBe(prefill)
    expect(result).not.toContain(PLAN_MODE_PREFIX)
  })
})

// ── Component behavior ────────────────────────────────────────────────
describe('WorktreePickerModal remote launch', () => {
  let request: ReturnType<typeof vi.fn>
  let subscribe: ReturnType<typeof vi.fn>

  beforeAll(async () => {
    // useSettingsStore schedules a one-shot 200ms timer on module import that
    // reloads settings and re-detects agent SDKs; with the mocked RPC client
    // it sets availableAgentSdks to null, unmounting the SDK toggle mid-test.
    // Let it fire (against a mock client) before any test renders.
    const bootRequest: ReturnType<typeof vi.fn> = vi.fn(async () => null)
    setRendererRpcClient({ request: bootRequest, subscribe: vi.fn() })
    await new Promise((resolve) => setTimeout(resolve, 400))
    resetRendererRpcClientForTests()
  })

  beforeEach(() => {
    _resetLastSourceBranch()
    vi.clearAllMocks()
    resetRendererRpcClientForTests()
    request = vi.fn(async (method: string) => {
      if (method === 'remoteLaunchOps.preflight') return PASSING_PREFLIGHT
      if (method === 'terminalOps.createClaudeCli') return { success: true }
      return null
    })
    subscribe = vi.fn(() => vi.fn())
    setRendererRpcClient({ request, subscribe })
  })

  afterEach(() => {
    cleanup()
    useSettingsStore.setState(initialSettingsState, true)
    useSessionStore.setState(initialSessionState, true)
    useWorktreeStore.setState(initialWorktreeState, true)
    useConnectionStore.setState(initialConnectionState, true)
    useKanbanStore.setState(initialKanbanState, true)
    useProjectStore.setState(initialProjectState, true)
    useUsageStore.setState(initialUsageState, true)
    useWorktreeStatusStore.setState(initialWorktreeStatusState, true)
    useRemoteLaunchStore.setState(initialRemoteLaunchState, true)
    resetRendererRpcClientForTests()
  })

  it('hides the remote section when teleport settings are absent', () => {
    setupStores({ teleport: null })
    renderModal()

    expect(screen.queryByTestId('remote-launch-toggle')).not.toBeInTheDocument()
  })

  it('hides the remote section when an existing worktree is selected', async () => {
    setupStores()
    renderModal()

    expect(screen.getByTestId('remote-launch-toggle')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('worktree-item-worktree-1'))

    expect(screen.queryByTestId('remote-launch-toggle')).not.toBeInTheDocument()
  })

  it('hides the remote section in saveConfigOnly mode', () => {
    setupStores()
    renderModal({ saveConfigOnly: true })

    expect(screen.queryByTestId('remote-launch-toggle')).not.toBeInTheDocument()
  })

  it('shows the remote section and toggles on when teleport is configured and New worktree is selected', async () => {
    setupStores()
    renderModal()

    const toggle = screen.getByTestId('remote-launch-toggle')
    expect(toggle).toBeInTheDocument()
    expect(toggle).toHaveAttribute('data-state', 'unchecked')

    await userEvent.click(toggle)

    await waitFor(() => expect(toggle).toHaveAttribute('data-state', 'checked'))
  })

  it('hides/disables goal-mode and super-plan and forces claude-cli SDK when remote is toggled on', async () => {
    setupStores()
    renderModal()

    // Pick an SDK that supports goal mode so we can observe it disappearing.
    await userEvent.click(screen.getByTestId('sdk-toggle-claude-code-cli'))
    expect(screen.getByTestId('goal-mode-toggle')).toBeInTheDocument()

    // Arm super-plan mode.
    await userEvent.click(screen.getByTestId('wt-picker-mode-toggle'))
    await userEvent.click(screen.getByTestId('wt-picker-super-toggle'))
    expect(screen.getByTestId('wt-picker-mode-toggle')).toHaveAttribute('data-mode', 'super-plan')

    await userEvent.click(screen.getByTestId('remote-launch-toggle'))

    await waitFor(() =>
      expect(screen.getByTestId('wt-picker-mode-toggle')).toHaveAttribute('data-mode', 'plan')
    )
    expect(screen.queryByTestId('goal-mode-toggle')).not.toBeInTheDocument()
    expect(screen.getByTestId('wt-picker-super-toggle')).toBeDisabled()
    expect(screen.getByTestId('sdk-toggle-opencode')).toBeDisabled()
    expect(screen.getByTestId('sdk-toggle-claude-code-cli')).toHaveAttribute('aria-pressed', 'true')
  })

  it('disables Send with an error when the branch is not on origin', async () => {
    setupStores()
    request.mockImplementation(async (method: string) => {
      if (method === 'remoteLaunchOps.preflight') {
        return {
          ...PASSING_PREFLIGHT,
          branchOnOrigin: false
        } satisfies RemoteLaunchPreflightResult
      }
      return null
    })
    renderModal()

    await userEvent.click(screen.getByTestId('remote-launch-toggle'))

    await waitFor(() => expect(screen.getByTestId('remote-branch-missing')).toBeInTheDocument())
    expect(screen.getByTestId('wt-picker-send-btn')).toBeDisabled()
  })

  it('keeps Send enabled with an amber warning when local commits are ahead of origin', async () => {
    setupStores()
    request.mockImplementation(async (method: string) => {
      if (method === 'remoteLaunchOps.preflight') {
        return {
          ...PASSING_PREFLIGHT,
          localAhead: 2
        } satisfies RemoteLaunchPreflightResult
      }
      return null
    })
    renderModal()

    await userEvent.click(screen.getByTestId('remote-launch-toggle'))

    await waitFor(() => expect(screen.getByTestId('remote-ahead-warning')).toBeInTheDocument())
    expect(screen.getByTestId('wt-picker-send-btn')).not.toBeDisabled()
  })

  it('sends a successful remote launch: calls start with expected params, updates the ticket, skips local session/worktree creation', async () => {
    const { createSession, createWorktreeFromBranch, updateTicket } = setupStores()
    request.mockImplementation(async (method: string) => {
      if (method === 'remoteLaunchOps.preflight') return PASSING_PREFLIGHT
      if (method === 'remoteLaunchOps.start') {
        return {
          success: true,
          localSessionId: 'remote-session-1',
          tmuxSession: 'hive-launch-1'
        } satisfies RemoteLaunchStartResult
      }
      return null
    })
    renderModal()

    await userEvent.click(screen.getByTestId('remote-launch-toggle'))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('remoteLaunchOps.preflight', expect.any(Object))
    )

    await userEvent.click(screen.getByTestId('wt-picker-send-btn'))

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('remoteLaunchOps.start', expect.any(Object))
    )

    const startCall = request.mock.calls.find(([method]) => method === 'remoteLaunchOps.start')
    const startParams = startCall?.[1] as {
      launchId: string
      mode: string
      prompt: string
      branch: string
    }
    expect(startParams.launchId).toEqual(expect.any(String))
    expect(startParams.launchId.length).toBeGreaterThan(0)
    expect(startParams.mode).toBe('build')
    expect(startParams.prompt).toContain('Make ticket launch on a remote machine')
    expect(startParams.branch).toBe('main')

    await waitFor(() =>
      expect(updateTicket).toHaveBeenCalledWith('ticket-1', 'project-1', {
        current_session_id: 'remote-session-1',
        worktree_id: null,
        mode: 'build',
        column: 'in_progress',
        sort_order: 1,
        plan_ready: false,
        goal_mode: false,
        goal_success_criteria: null
      })
    )

    expect(createSession).not.toHaveBeenCalled()
    expect(createWorktreeFromBranch).not.toHaveBeenCalled()
  })

  it('shows a step error on failed send and Retry re-invokes start with the same launchId', async () => {
    setupStores()
    let startCallCount = 0
    request.mockImplementation(async (method: string) => {
      if (method === 'remoteLaunchOps.preflight') return PASSING_PREFLIGHT
      if (method === 'remoteLaunchOps.start') {
        startCallCount += 1
        return {
          success: false,
          step: 'clone',
          error: 'clone failed: disk full'
        } satisfies RemoteLaunchStartResult
      }
      return null
    })
    renderModal()

    await userEvent.click(screen.getByTestId('remote-launch-toggle'))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('remoteLaunchOps.preflight', expect.any(Object))
    )

    await userEvent.click(screen.getByTestId('wt-picker-send-btn'))

    await waitFor(() => expect(screen.getByTestId('remote-step-clone')).toHaveTextContent(/clone failed: disk full/))
    expect(startCallCount).toBe(1)

    const firstLaunchId = (
      request.mock.calls.find(([method]) => method === 'remoteLaunchOps.start')?.[1] as {
        launchId: string
      }
    ).launchId

    const retryButton = screen.getByTestId('wt-picker-send-btn')
    expect(retryButton).toHaveTextContent(/retry/i)
    await userEvent.click(retryButton)

    await waitFor(() => expect(startCallCount).toBe(2))
    const secondLaunchId = (
      request.mock.calls.filter(([method]) => method === 'remoteLaunchOps.start')[1][1] as {
        launchId: string
      }
    ).launchId
    expect(secondLaunchId).toBe(firstLaunchId)
  })
})

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorktreePickerModal, _resetLastSourceBranch } from './WorktreePickerModal'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { PLAN_MODE_PREFIX } from '@/lib/constants'
import { FALLBACK_MODELS } from '@shared/model-resolution'
import { runMultiModelLaunch } from '@/lib/multi-model-launch'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useUsageStore } from '@/stores/useUsageStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import type { KanbanTicket, Session } from '../../../../main/db/types'

vi.mock('@/lib/multi-model-launch', () => ({
  runMultiModelLaunch: vi.fn()
}))

vi.mock('@/api/hive-enterprise/client', () => ({
  isHiveTelemetryEnabled: vi.fn(() => false),
  recordHivePromptStart: vi.fn(),
  recordHivePromptIdle: vi.fn(),
  recordHiveQuestionsAnswered: vi.fn()
}))

// Minimal ModelSelector: exposes the SDK override it was handed and a pick
// button so tests can set an explicit model per row.
vi.mock('@/components/sessions/ModelSelector', () => ({
  ModelSelector: ({
    value,
    onChange,
    agentSdkOverride
  }: {
    value?: { modelID?: string } | null
    onChange?: (model: {
      agentSdk?: 'opencode' | 'claude-code' | 'claude-code-cli' | 'codex'
      providerID: string
      modelID: string
      variant?: string
    }) => void
    agentSdkOverride?: 'opencode' | 'claude-code' | 'claude-code-cli' | 'codex'
  }) => (
    <div data-testid={`model-selector-${agentSdkOverride ?? 'none'}`}>
      <span data-testid={`model-value-${agentSdkOverride ?? 'none'}`}>
        {value?.modelID ?? 'null'}
      </span>
      <button
        type="button"
        data-testid={`pick-model-${agentSdkOverride ?? 'none'}`}
        onClick={() =>
          onChange?.({
            agentSdk: agentSdkOverride,
            providerID: 'anthropic',
            modelID: 'picked-model',
            variant: 'high'
          })
        }
      >
        pick
      </button>
    </div>
  )
}))

vi.mock('@/components/sessions/CodexFastToggle', () => ({
  CodexFastToggle: () => <div data-testid="codex-fast-toggle" />
}))

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() }
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
      value: { enabled: true, size: 'md', position: { x: 0, y: 0 }, hatched: true }
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

type TestAgentSdk = 'opencode' | 'claude-code' | 'claude-code-cli' | 'codex' | 'terminal'
type TestSessionMode = 'build' | 'plan' | 'super-plan'

const baseTicket: KanbanTicket = {
  id: 'ticket-1',
  project_id: 'project-1',
  title: 'Multi model ticket',
  description: 'Ship the multi-model launcher',
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
  model_provider_id: null,
  model_id: null,
  model_variant: null,
  variant_group_id: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z'
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
    model_provider_id: null,
    model_id: null,
    model_variant: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    completed_at: null,
    pinned_to_board: false,
    ...overrides
  }
}

function setupStores(): { updateTicket: ReturnType<typeof vi.fn> } {
  const createSession = vi.fn(
    async (
      worktreeId: string,
      projectId: string,
      sdk: TestAgentSdk = 'opencode',
      mode: TestSessionMode = 'build'
    ) => ({
      success: true,
      session: makeSession({
        worktree_id: worktreeId,
        project_id: projectId,
        agent_sdk: sdk,
        mode: mode === 'super-plan' ? 'plan' : mode
      })
    })
  )
  const updateTicket = vi.fn(async () => undefined)

  useSettingsStore.setState({
    availableAgentSdks: { opencode: true, claude: true, codex: true },
    defaultAgentSdk: 'opencode',
    selectedModel: null,
    selectedModelByProvider: {},
    defaultModels: null,
    codexFastMode: false,
    codexFastModeAccepted: true,
    boardMode: 'toggle'
  })
  useProjectStore.setState({
    projects: [
      {
        id: 'project-1',
        name: 'Hive',
        path: '/repo',
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
            branch_name: 'feature',
            path: '/repo/feature',
            status: 'active',
            is_default: false,
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
    createWorktreeFromBranch: vi.fn()
  })
  useConnectionStore.setState({
    connections: [
      {
        id: 'connection-1',
        name: 'Feature connection',
        custom_name: null,
        status: 'active',
        path: '/repo/connection',
        color: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        members: []
      }
    ],
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
    setActiveSession: vi.fn(),
    dequeuePendingMessage: vi.fn()
  })
  useWorktreeStatusStore.setState({
    setSessionStatus: vi.fn(),
    setLastMessageTime: vi.fn()
  })
  useUsageStore.setState({ fetchUsageForProvider: vi.fn() })

  return { updateTicket }
}

async function renderModal(
  props: Partial<React.ComponentProps<typeof WorktreePickerModal>> = {}
): Promise<void> {
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
  // Flush the modal's async open effects (branch fetch → setBranches /
  // setBranchesLoading) inside act so no state update settles outside it.
  await act(async () => {})
}

describe('WorktreePickerModal multi-model UI', () => {
  let request: ReturnType<typeof vi.fn>

  beforeAll(async () => {
    // Absorb useSettingsStore's one-shot 200ms import timer (nulls
    // availableAgentSdks under the mocked RPC client) before any test renders.
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
      if (method === 'terminalOps.createClaudeCli') return { success: true }
      return null
    })
    setRendererRpcClient({ request, subscribe: vi.fn() })
    setupStores()
    // Never resolves — proves the modal closes without awaiting the orchestrator.
    vi.mocked(runMultiModelLaunch).mockImplementation(() => new Promise<void>(() => {}))
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
    resetRendererRpcClientForTests()
  })

  it('adds and removes model rows and updates the send button label', async () => {
    await renderModal()

    expect(screen.getByTestId('wt-picker-send-btn')).toHaveTextContent('Send')
    expect(screen.queryByTestId('extra-model-row-1')).toBeNull()

    await userEvent.click(screen.getByTestId('add-model-row'))
    expect(screen.getByTestId('extra-model-row-1')).toBeInTheDocument()
    expect(screen.getByTestId('wt-picker-send-btn')).toHaveTextContent('Start 2 sessions')

    await userEvent.click(screen.getByTestId('add-model-row'))
    expect(screen.getByTestId('extra-model-row-2')).toBeInTheDocument()
    expect(screen.getByTestId('wt-picker-send-btn')).toHaveTextContent('Start 3 sessions')

    await userEvent.click(screen.getByTestId('extra-model-row-1-remove'))
    expect(screen.getByTestId('wt-picker-send-btn')).toHaveTextContent('Start 2 sessions')

    await userEvent.click(screen.getByTestId('extra-model-row-1-remove'))
    expect(screen.queryByTestId('extra-model-row-1')).toBeNull()
    expect(screen.getByTestId('wt-picker-send-btn')).toHaveTextContent('Send')
  })

  it('hides the rows for an existing worktree, connection mode, and pre-assign mode', async () => {
    await renderModal()
    await userEvent.click(screen.getByTestId('add-model-row'))
    expect(screen.getByTestId('extra-model-row-1')).toBeInTheDocument()

    // Switching to an existing worktree hides the extra-row UI.
    await userEvent.click(screen.getByTestId('worktree-item-worktree-1'))
    expect(screen.queryByTestId('add-model-row')).toBeNull()
    expect(screen.queryByTestId('extra-model-row-1')).toBeNull()
    // The single-model path is used → label reverts to Send.
    expect(screen.getByTestId('wt-picker-send-btn')).toHaveTextContent('Send')

    cleanup()
    await renderModal({ connectionId: 'connection-1' })
    expect(screen.queryByTestId('add-model-row')).toBeNull()

    cleanup()
    await renderModal({ preAssignOnly: true })
    expect(screen.queryByTestId('add-model-row')).toBeNull()
  })

  it('hands multi-model launches to runMultiModelLaunch with raw prompt and row-ordered entries', async () => {
    const onOpenChange = vi.fn()
    const onSendComplete = vi.fn()
    await renderModal({ onOpenChange, onSendComplete })

    // Row 1 = opencode + plan mode; extra row = codex.
    await userEvent.click(screen.getByTestId('wt-picker-mode-toggle')) // build -> plan
    await userEvent.click(screen.getByTestId('add-model-row'))
    await userEvent.click(screen.getByTestId('extra-model-row-1-sdk-codex'))

    await userEvent.click(screen.getByTestId('wt-picker-send-btn'))

    await waitFor(() => expect(runMultiModelLaunch).toHaveBeenCalledTimes(1))
    const plan = vi.mocked(runMultiModelLaunch).mock.calls[0][0]

    expect(plan.entries.map((e) => e.sdk)).toEqual(['opencode', 'codex'])
    expect(plan.entries[0].model).toBeNull()
    // Unpicked extra rows snapshot the concrete row-resolved model (here the
    // hard SDK fallback) so the launch can't diverge from what was displayed.
    expect(plan.entries[1].model).toEqual(FALLBACK_MODELS.codex)
    expect(plan.mode).toBe('plan')
    expect(plan.sourceBranch).toBe('main')
    expect(plan.goalMode).toBe(false)
    expect(plan.ticket).toEqual({ id: 'ticket-1', title: 'Multi model ticket' })
    // RAW prompt — no per-SDK composition (the opencode plan prefix must be absent).
    expect(plan.prompt).not.toContain(PLAN_MODE_PREFIX)
    expect(plan.prompt).toContain('<ticket title="Multi model ticket">')

    // Modal closes immediately, before the never-resolving orchestrator settles.
    expect(onSendComplete).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)

    // The multi branch mutates nothing itself — the orchestrator owns all of it.
    expect(useKanbanStore.getState().updateTicket).not.toHaveBeenCalled()
    expect(useWorktreeStore.getState().createWorktreeFromBranch).not.toHaveBeenCalled()
  })

  it('resolves an unpicked extra row from the row SDK mode default, not the per-SDK default', async () => {
    // The build-mode default targets codex, and codex ALSO has a per-SDK
    // default. The unpicked codex row must display AND launch the mode default
    // — downstream null-resolution would pick the per-SDK default instead.
    useSettingsStore.setState({
      defaultModels: {
        build: {
          agentSdk: 'codex',
          providerID: 'codex',
          modelID: 'mode-default-model',
          variant: 'fast'
        },
        plan: null,
        ask: null,
        review: null
      },
      selectedModelByProvider: {
        codex: { providerID: 'codex', modelID: 'per-sdk-model' }
      }
    })
    await renderModal()

    // Pin row 1 to opencode so the codex mode default belongs to the extra row only.
    await userEvent.click(screen.getByTestId('sdk-toggle-opencode'))
    await userEvent.click(screen.getByTestId('add-model-row'))
    await userEvent.click(screen.getByTestId('extra-model-row-1-sdk-codex'))

    // The row's ModelSelector displays the mode default...
    expect(screen.getByTestId('model-value-codex')).toHaveTextContent('mode-default-model')

    await userEvent.click(screen.getByTestId('wt-picker-send-btn'))
    await waitFor(() => expect(runMultiModelLaunch).toHaveBeenCalledTimes(1))
    const plan = vi.mocked(runMultiModelLaunch).mock.calls[0][0]

    // ...and the launch entry carries that same concrete model.
    expect(plan.entries[1].model).toMatchObject({
      providerID: 'codex',
      modelID: 'mode-default-model',
      variant: 'fast'
    })
    // Row 1 (opencode) has no default anywhere → stays null; the codex mode
    // default must not leak across SDKs.
    expect(plan.entries[0].sdk).toBe('opencode')
    expect(plan.entries[0].model).toBeNull()
  })

  it('serializes multi-model entries plus legacy row-1 fields in saveConfigOnly mode', async () => {
    const { updateTicket } = setupStores()
    await renderModal({ saveConfigOnly: true })

    await userEvent.click(screen.getByTestId('add-model-row'))
    await userEvent.click(screen.getByTestId('extra-model-row-1-sdk-codex'))
    await userEvent.click(screen.getByTestId('wt-picker-send-btn'))

    await waitFor(() => expect(updateTicket).toHaveBeenCalledTimes(1))
    const update = updateTicket.mock.calls[0][2] as { pending_launch_config: string }
    const parsed = JSON.parse(update.pending_launch_config)

    // Legacy row-1 fields stay for backward compat with old builds.
    expect(parsed.sdk).toBe('opencode')
    expect(parsed.codexFastMode).toBe(false)
    // Multi-model entries, row 1 first. The unpicked extra row snapshots the
    // concrete row-resolved model instead of null.
    expect(parsed.models).toHaveLength(2)
    expect(parsed.models[0].sdk).toBe('opencode')
    expect(parsed.models[0].model).toBeNull()
    expect(parsed.models[1].sdk).toBe('codex')
    expect(parsed.models[1].model).toEqual(FALLBACK_MODELS.codex)
  })

  it('stamps model badge fields on the single-model launch update', async () => {
    const { updateTicket } = setupStores()
    await renderModal()

    await userEvent.click(screen.getByTestId('sdk-toggle-claude-code-cli'))
    await userEvent.click(screen.getByTestId('pick-model-claude-code-cli'))
    await userEvent.click(screen.getByTestId('worktree-item-worktree-1'))
    await userEvent.click(screen.getByTestId('wt-picker-send-btn'))

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('terminalOps.createClaudeCli', expect.any(Object))
    )
    expect(updateTicket).toHaveBeenCalledWith(
      'ticket-1',
      'project-1',
      expect.objectContaining({
        worktree_id: 'worktree-1',
        model_provider_id: 'anthropic',
        model_id: 'picked-model',
        model_variant: 'high'
      })
    )
    expect(runMultiModelLaunch).not.toHaveBeenCalled()
  })

  it('clears goal mode when an added row uses an SDK that does not support goals', async () => {
    await renderModal()

    // Row 1 = codex (goal-capable) → enable goal mode.
    await userEvent.click(screen.getByTestId('sdk-toggle-codex'))
    await userEvent.click(screen.getByTestId('goal-mode-toggle'))
    await userEvent.type(screen.getByTestId('goal-success-criteria'), 'Tests pass')
    expect(screen.getByTestId('goal-success-criteria')).toBeInTheDocument()

    // Add a row (defaults to codex, still goal-capable) then flip it to opencode.
    await userEvent.click(screen.getByTestId('add-model-row'))
    await userEvent.click(screen.getByTestId('extra-model-row-1-sdk-opencode'))

    // Goal mode is no longer available → the block disappears.
    expect(screen.queryByTestId('goal-mode-toggle')).toBeNull()

    // Restore a goal-capable SDK: the toggle returns but goal mode stays OFF
    // (it was cleared, mirroring the row-1 SDK-switch reset).
    await userEvent.click(screen.getByTestId('extra-model-row-1-sdk-codex'))
    expect(screen.getByTestId('goal-mode-toggle')).toBeInTheDocument()
    expect(screen.queryByTestId('goal-success-criteria')).toBeNull()
  })
})

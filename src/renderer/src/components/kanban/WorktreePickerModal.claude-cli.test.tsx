import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorktreePickerModal, _resetLastSourceBranch } from './WorktreePickerModal'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { PLAN_MODE_PREFIX, getSuperPlanModePrefix } from '@/lib/constants'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useUsageStore } from '@/stores/useUsageStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
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

type TestAgentSdk = 'opencode' | 'claude-code' | 'claude-code-cli' | 'codex' | 'terminal'
type TestSessionMode = 'build' | 'plan' | 'super-plan'

const baseTicket: KanbanTicket = {
  id: 'ticket-1',
  project_id: 'project-1',
  title: 'Launch Claude CLI',
  description: 'Make ticket launch use Claude CLI',
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
    model_provider_id: 'anthropic',
    model_id: 'opus',
    model_variant: 'high',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    completed_at: null,
    pinned_to_board: false,
    ...overrides
  }
}

function setupStores(): {
  createSession: ReturnType<typeof vi.fn>
  createConnectionSession: ReturnType<typeof vi.fn>
  setSessionModel: ReturnType<typeof vi.fn>
  setSessionMode: ReturnType<typeof vi.fn>
  updateTicket: ReturnType<typeof vi.fn>
} {
  const createSession = vi.fn(
    async (
      worktreeId: string,
      projectId: string,
      sdk: TestAgentSdk = 'opencode',
      mode: TestSessionMode = 'build',
      _options?: { autoFocus?: boolean; modelOverride?: unknown; pendingMessage?: string | null }
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
  const createConnectionSession = vi.fn(
    async (
      connectionId: string,
      sdk: TestAgentSdk = 'opencode',
      mode: TestSessionMode = 'build',
      _opts?: { autoFocus?: boolean; modelOverride?: unknown; pendingMessage?: string | null }
    ) => ({
      success: true,
      session: makeSession({
        id: 'connection-session-1',
        worktree_id: null,
        connection_id: connectionId,
        project_id: 'project-1',
        agent_sdk: sdk,
        mode: mode === 'super-plan' ? 'plan' : mode
      })
    })
  )
  const setSessionModel = vi.fn(async () => undefined)
  const setSessionMode = vi.fn(async () => undefined)
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
    createConnectionSession,
    setSessionModel,
    setSessionMode,
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

  return { createSession, createConnectionSession, setSessionModel, setSessionMode, updateTicket }
}

async function renderAndSelectClaudeCli(ticket: KanbanTicket = baseTicket): Promise<void> {
  render(
    <WorktreePickerModal
      ticket={ticket}
      projectId="project-1"
      open
      onOpenChange={vi.fn()}
      onSendComplete={vi.fn()}
    />
  )

  const toggle = screen.getByTestId('sdk-toggle')
  expect(within(toggle).getAllByRole('button').map((button) => button.textContent)).toEqual([
    'OpenCode',
    'Claude Code',
    'Codex',
    'Claude CLI'
  ])
  await userEvent.click(screen.getByTestId('sdk-toggle-claude-code-cli'))
}

async function renderAndSelectClaudeCliForConnection(
  ticket: KanbanTicket = baseTicket
): Promise<void> {
  render(
    <WorktreePickerModal
      ticket={ticket}
      projectId="project-1"
      connectionId="connection-1"
      open
      onOpenChange={vi.fn()}
      onSendComplete={vi.fn()}
    />
  )

  const toggle = screen.getByTestId('sdk-toggle')
  expect(within(toggle).getAllByRole('button').map((button) => button.textContent)).toEqual([
    'OpenCode',
    'Claude Code',
    'Codex',
    'Claude CLI'
  ])
  await userEvent.click(screen.getByTestId('sdk-toggle-claude-code-cli'))
}

describe('WorktreePickerModal Claude CLI launch', () => {
  let request: ReturnType<typeof vi.fn>

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

  it('starts a worktree ticket with Claude CLI and does not call OpenCode connect or prompt', async () => {
    const { createSession, setSessionModel } = setupStores()
    await renderAndSelectClaudeCli()

    await userEvent.click(screen.getByTestId('model-selector-pick-opus'))
    await userEvent.click(screen.getByTestId('worktree-item-worktree-1'))
    await userEvent.click(screen.getByTestId('wt-picker-send-btn'))

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('terminalOps.createClaudeCli', expect.any(Object))
    )
    expect(createSession).toHaveBeenCalledWith(
      'worktree-1',
      'project-1',
      'claude-code-cli',
      'build',
      {
        modelOverride: {
          agentSdk: 'claude-code-cli',
          providerID: 'anthropic',
          modelID: 'opus',
          variant: 'high'
        },
        pendingMessage: expect.stringContaining('Please implement the following ticket.')
      }
    )
    expect(setSessionModel).toHaveBeenCalledWith('session-1', {
      agentSdk: 'claude-code-cli',
      providerID: 'anthropic',
      modelID: 'opus',
      variant: 'high'
    })
    expect(request).toHaveBeenCalledWith('terminalOps.createClaudeCli', {
      sessionId: 'session-1',
      opts: { pendingPrompt: expect.stringContaining('Please implement the following ticket.') }
    })
  })

  it('starts a connection ticket with Claude CLI through terminalApi and skips OpenCode', async () => {
    const { createConnectionSession, setSessionModel, updateTicket } = setupStores()
    await renderAndSelectClaudeCliForConnection()

    await userEvent.click(screen.getByTestId('model-selector-pick-opus'))
    await userEvent.click(screen.getByTestId('wt-picker-send-btn'))

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('terminalOps.createClaudeCli', expect.any(Object))
    )
    expect(createConnectionSession).toHaveBeenCalledWith(
      'connection-1',
      'claude-code-cli',
      'build',
      expect.objectContaining({
        modelOverride: {
          agentSdk: 'claude-code-cli',
          providerID: 'anthropic',
          modelID: 'opus',
          variant: 'high'
        },
        pendingMessage: expect.stringContaining('Please implement the following ticket.')
      })
    )
    expect(setSessionModel).toHaveBeenCalledWith('connection-session-1', {
      agentSdk: 'claude-code-cli',
      providerID: 'anthropic',
      modelID: 'opus',
      variant: 'high'
    })
    expect(updateTicket).toHaveBeenCalledWith('ticket-1', 'project-1', {
      current_session_id: 'connection-session-1',
      worktree_id: null,
      mode: 'build',
      column: 'in_progress',
      sort_order: 1,
      plan_ready: false,
      goal_mode: false,
      goal_success_criteria: null,
      // Badge fields are now stamped on every launch (connection path included).
      model_provider_id: 'anthropic',
      model_id: 'opus',
      model_variant: 'high',
      // A single-model (re)launch clears any stale variant_group_id from a
      // prior failed multi-launch of this ticket.
      variant_group_id: null
    })
    expect(request).toHaveBeenCalledWith('terminalOps.createClaudeCli', {
      sessionId: 'connection-session-1',
      opts: { pendingPrompt: expect.stringContaining('Please implement the following ticket.') }
    })
  })

  it('omits the synthetic plan prefix for Claude CLI plan launches', async () => {
    await renderAndSelectClaudeCli()

    await userEvent.click(screen.getByTestId('model-selector-pick-opus'))
    await userEvent.click(screen.getByTestId('wt-picker-mode-toggle'))
    await userEvent.click(screen.getByTestId('worktree-item-worktree-1'))
    await userEvent.click(screen.getByTestId('wt-picker-send-btn'))

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('terminalOps.createClaudeCli', expect.any(Object))
    )
    const createCall = request.mock.calls.find(
      ([method]) => method === 'terminalOps.createClaudeCli'
    )
    const pendingPrompt = createCall?.[1]?.opts?.pendingPrompt
    expect(pendingPrompt).toContain('Please review the following ticket')
    expect(pendingPrompt).not.toContain(PLAN_MODE_PREFIX)
  })

  it('keeps the super-plan instruction prefix for Claude CLI super-plan launches', async () => {
    const { setSessionMode } = setupStores()
    await renderAndSelectClaudeCli()

    await userEvent.click(screen.getByTestId('model-selector-pick-opus'))
    await userEvent.click(screen.getByTestId('wt-picker-mode-toggle'))
    await userEvent.click(screen.getByTestId('wt-picker-super-toggle'))
    await userEvent.click(screen.getByTestId('worktree-item-worktree-1'))
    await userEvent.click(screen.getByTestId('wt-picker-send-btn'))

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('terminalOps.createClaudeCli', expect.any(Object))
    )
    const createCall = request.mock.calls.find(
      ([method]) => method === 'terminalOps.createClaudeCli'
    )
    const pendingPrompt = createCall?.[1]?.opts?.pendingPrompt
    expect(pendingPrompt?.startsWith(getSuperPlanModePrefix('claude-code-cli'))).toBe(true)
    expect(setSessionMode).toHaveBeenCalledWith('session-1', 'plan')
  })

  it('serializes Claude CLI SDK in save-config-only mode', async () => {
    const { updateTicket } = setupStores()
    render(
      <WorktreePickerModal
        ticket={baseTicket}
        projectId="project-1"
        open
        onOpenChange={vi.fn()}
        onSendComplete={vi.fn()}
        saveConfigOnly
      />
    )

    await userEvent.click(screen.getByTestId('sdk-toggle-claude-code-cli'))
    await userEvent.click(screen.getByTestId('wt-picker-send-btn'))

    await waitFor(() => expect(updateTicket).toHaveBeenCalledTimes(1))
    const update = updateTicket.mock.calls[0][2] as { pending_launch_config: string }
    expect(JSON.parse(update.pending_launch_config)).toMatchObject({
      sdk: 'claude-code-cli'
    })
    expect(request).not.toHaveBeenCalledWith('terminalOps.createClaudeCli', expect.anything())
  })
})

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorktreePickerModal, _resetLastSourceBranch } from './WorktreePickerModal'
import { PLAN_MODE_PREFIX, getSuperPlanModePrefix } from '@/lib/constants'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useUsageStore } from '@/stores/useUsageStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import type { KanbanTicket, Session } from '../../../../main/db/types'

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

const initialSettingsState = useSettingsStore.getState()
const initialSessionState = useSessionStore.getState()
const initialWorktreeState = useWorktreeStore.getState()
const initialKanbanState = useKanbanStore.getState()
const initialProjectState = useProjectStore.getState()
const initialUsageState = useUsageStore.getState()
const initialWorktreeStatusState = useWorktreeStatusStore.getState()

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
  attachments: [],
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
  setSessionModel: ReturnType<typeof vi.fn>
  setSessionMode: ReturnType<typeof vi.fn>
  updateTicket: ReturnType<typeof vi.fn>
} {
  const createSession = vi.fn(async (worktreeId: string, projectId: string, sdk: Session['agent_sdk'], mode: Session['mode']) => ({
    success: true,
    session: makeSession({ worktree_id: worktreeId, project_id: projectId, agent_sdk: sdk, mode })
  }))
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

  return { createSession, setSessionModel, setSessionMode, updateTicket }
}

function setupWindowApis(): void {
  Object.defineProperty(window, 'terminalOps', {
    configurable: true,
    writable: true,
    value: {
      createClaudeCli: vi.fn().mockResolvedValue({ success: true, value: { success: true } })
    }
  })
  Object.defineProperty(window, 'opencodeOps', {
    configurable: true,
    writable: true,
    value: {
      connect: vi.fn().mockResolvedValue({ success: true, value: { success: true, sessionId: 'opc-1' } }),
      prompt: vi.fn().mockResolvedValue({ success: true, value: { success: true } }),
      listModels: vi.fn().mockResolvedValue({ success: true, value: { success: true, providers: [] } })
    }
  })
  Object.defineProperty(window, 'db', {
    configurable: true,
    writable: true,
    value: {
      session: {
        update: vi.fn().mockResolvedValue({ success: true, value: undefined })
      }
    }
  })
  Object.defineProperty(window, 'gitOps', {
    configurable: true,
    writable: true,
    value: {
      ...window.gitOps,
      listBranchesWithStatus: vi.fn().mockResolvedValue({ success: true, value: { success: true, branches: [] } })
    }
  })
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

describe('WorktreePickerModal Claude CLI launch', () => {
  beforeEach(() => {
    _resetLastSourceBranch()
    vi.clearAllMocks()
    setupWindowApis()
    setupStores()
  })

  afterEach(() => {
    cleanup()
    useSettingsStore.setState(initialSettingsState, true)
    useSessionStore.setState(initialSessionState, true)
    useWorktreeStore.setState(initialWorktreeState, true)
    useKanbanStore.setState(initialKanbanState, true)
    useProjectStore.setState(initialProjectState, true)
    useUsageStore.setState(initialUsageState, true)
    useWorktreeStatusStore.setState(initialWorktreeStatusState, true)
    delete (window as { terminalOps?: unknown }).terminalOps
    delete (window as { opencodeOps?: unknown }).opencodeOps
    delete (window as { db?: unknown }).db
  })

  it('starts a worktree ticket with Claude CLI and does not call OpenCode connect or prompt', async () => {
    const { createSession, setSessionModel } = setupStores()
    await renderAndSelectClaudeCli()

    await userEvent.click(screen.getByTestId('model-selector-pick-opus'))
    await userEvent.click(screen.getByTestId('worktree-item-worktree-1'))
    await userEvent.click(screen.getByTestId('wt-picker-send-btn'))

    await waitFor(() => expect(window.terminalOps.createClaudeCli).toHaveBeenCalledTimes(1))
    expect(createSession).toHaveBeenCalledWith('worktree-1', 'project-1', 'claude-code-cli', 'build', {
      modelOverride: {
        agentSdk: 'claude-code-cli',
        providerID: 'anthropic',
        modelID: 'opus',
        variant: 'high'
      },
      pendingMessage: expect.stringContaining('Please implement the following ticket.')
    })
    expect(setSessionModel).toHaveBeenCalledWith('session-1', {
      agentSdk: 'claude-code-cli',
      providerID: 'anthropic',
      modelID: 'opus',
      variant: 'high'
    })
    expect(window.terminalOps.createClaudeCli).toHaveBeenCalledWith('session-1', {
      pendingPrompt: expect.stringContaining('Please implement the following ticket.')
    })
    expect(window.opencodeOps.connect).not.toHaveBeenCalled()
    expect(window.opencodeOps.prompt).not.toHaveBeenCalled()
  })

  it('omits the synthetic plan prefix for Claude CLI plan launches', async () => {
    await renderAndSelectClaudeCli()

    await userEvent.click(screen.getByTestId('wt-picker-mode-toggle'))
    await userEvent.click(screen.getByTestId('worktree-item-worktree-1'))
    await userEvent.click(screen.getByTestId('wt-picker-send-btn'))

    await waitFor(() => expect(window.terminalOps.createClaudeCli).toHaveBeenCalledTimes(1))
    const pendingPrompt = vi.mocked(window.terminalOps.createClaudeCli).mock.calls[0][1]?.pendingPrompt
    expect(pendingPrompt).toContain('Please review the following ticket')
    expect(pendingPrompt).not.toContain(PLAN_MODE_PREFIX)
  })

  it('keeps the super-plan instruction prefix for Claude CLI super-plan launches', async () => {
    const { setSessionMode } = setupStores()
    await renderAndSelectClaudeCli()

    await userEvent.click(screen.getByTestId('wt-picker-mode-toggle'))
    await userEvent.click(screen.getByTestId('wt-picker-super-toggle'))
    await userEvent.click(screen.getByTestId('worktree-item-worktree-1'))
    await userEvent.click(screen.getByTestId('wt-picker-send-btn'))

    await waitFor(() => expect(window.terminalOps.createClaudeCli).toHaveBeenCalledTimes(1))
    const pendingPrompt = vi.mocked(window.terminalOps.createClaudeCli).mock.calls[0][1]?.pendingPrompt
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
    expect(window.terminalOps.createClaudeCli).not.toHaveBeenCalled()
    expect(window.opencodeOps.connect).not.toHaveBeenCalled()
  })
})

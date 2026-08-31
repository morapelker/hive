import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorktreePickerModal, _resetLastSourceBranch } from './WorktreePickerModal'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { clearHandoffModelCatalogCache } from '@/lib/handoffSelection'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useUsageStore } from '@/stores/useUsageStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import type { KanbanTicket, Session } from '../../../../main/db/types'

// IMPORTANT: do NOT mock ModelSelector — the Cmd+U shortcut resolves the ultra
// variant through the same cached catalog the real ModelSelector populates.

const PROVIDERS = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    models: {
      opus: {
        id: 'opus',
        name: 'Opus 5',
        variants: { low: {}, medium: {}, high: {}, xhigh: {}, max: {} }
      },
      sonnet: { id: 'sonnet', name: 'Sonnet 4.6', variants: { low: {}, medium: {}, high: {} } }
    }
  }
]

vi.mock('@/api/opencode-api', () => ({
  opencodeApi: {
    listModels: vi.fn(async () => ({ success: true, providers: PROVIDERS })),
    connect: vi.fn(async () => ({ success: true })),
    prompt: vi.fn(async () => ({ success: true }))
  }
}))

vi.mock('@/api/hive-enterprise/client', () => ({
  isHiveTelemetryEnabled: vi.fn(() => false),
  recordHivePromptStart: vi.fn(),
  recordHivePromptIdle: vi.fn(),
  recordHiveQuestionsAnswered: vi.fn()
}))

vi.mock('@/components/sessions/CodexFastToggle', () => ({
  CodexFastToggle: () => <div data-testid="codex-fast-toggle" />
}))

vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

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

const baseTicket: KanbanTicket = {
  id: 'ticket-1',
  project_id: 'project-1',
  title: 'Launch Claude CLI',
  description: 'desc',
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
  unread: false,
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
  updated_at: '2026-01-01T00:00:00.000Z',
  column_changed_at: null
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
    remote_launch: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    completed_at: null,
    pinned_to_board: false,
    ...overrides
  }
}

function setupStores(): void {
  useSettingsStore.setState({
    availableAgentSdks: { opencode: true, claude: true, codex: true },
    defaultAgentSdk: 'codex',
    selectedModel: null,
    selectedModelByProvider: {
      'claude-code-cli': { providerID: 'claude-code', modelID: 'opus', variant: 'xhigh' }
    },
    defaultModels: {
      build: {
        agentSdk: 'claude-code-cli',
        providerID: 'claude-code',
        modelID: 'opus',
        variant: 'high'
      },
      plan: null,
      ask: null,
      review: null
    },
    codexFastMode: false,
    codexFastModeAccepted: true,
    boardMode: 'toggle',
    showModelProvider: false,
    favoriteModels: []
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
  useConnectionStore.setState({ connections: [], loaded: true })
  useKanbanStore.setState({
    tickets: new Map([['project-1', [baseTicket]]]),
    updateTicket: vi.fn(async () => undefined),
    computeSortOrder: vi.fn(() => 1),
    getTicketsByColumn: vi.fn(() => []),
    getTicketsByColumnForConnection: vi.fn(() => [])
  })
  useSessionStore.setState({
    sessionsByWorktree: new Map(),
    sessionsByConnection: new Map(),
    modeBySession: new Map(),
    createSession: vi.fn(async () => ({ success: true, session: makeSession() })),
    createConnectionSession: vi.fn(),
    setSessionModel: vi.fn(async () => undefined),
    setSessionMode: vi.fn(async () => undefined),
    setOpenCodeSessionId: vi.fn(),
    setActiveSession: vi.fn()
  })
  useWorktreeStatusStore.setState({ setSessionStatus: vi.fn(), setLastMessageTime: vi.fn() })
  useUsageStore.setState({ fetchUsageForProvider: vi.fn() })
}

beforeAll(async () => {
  Element.prototype.hasPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
  // useSettingsStore schedules a one-shot 200ms timer on module import that
  // reloads settings against the RPC client and can null availableAgentSdks
  // mid-test. Let it fire against a mock client before any test renders.
  const bootRequest: ReturnType<typeof vi.fn> = vi.fn(async () => null)
  setRendererRpcClient({ request: bootRequest, subscribe: vi.fn(() => () => {}) })
  await new Promise((resolve) => setTimeout(resolve, 400))
  resetRendererRpcClientForTests()
})

beforeEach(() => {
  _resetLastSourceBranch()
  vi.clearAllMocks()
  clearHandoffModelCatalogCache()
  resetRendererRpcClientForTests()
  const request: ReturnType<typeof vi.fn> = vi.fn(async () => null)
  setRendererRpcClient({ request, subscribe: vi.fn(() => () => {}) })
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

function renderModal(): void {
  render(
    <WorktreePickerModal
      ticket={baseTicket}
      projectId="project-1"
      open
      onOpenChange={vi.fn()}
      onSendComplete={vi.fn()}
    />
  )
}

describe('WorktreePickerModal keyboard shortcuts', () => {
  it('Cmd+G toggles goal mode on, focuses the criteria input, and toggles it back off', async () => {
    renderModal()

    // Build-mode default SDK is claude-code-cli (goal-capable) — switch present.
    await screen.findByTestId('goal-mode-toggle')
    expect(screen.queryByTestId('goal-success-criteria')).toBeNull()

    fireEvent.keyDown(window, { key: 'g', metaKey: true })

    const criteria = await screen.findByTestId('goal-success-criteria')
    await waitFor(() => expect(criteria).toHaveFocus())

    fireEvent.keyDown(window, { key: 'g', metaKey: true })
    await waitFor(() => expect(screen.queryByTestId('goal-success-criteria')).toBeNull())
  })

  it('Cmd+U flips the model to ultracode and a second press restores the prior variant', async () => {
    renderModal()

    // Wait for the real ModelSelector to load (and cache) the claude catalog.
    await waitFor(() => expect(screen.getByTestId('variant-indicator')).toHaveTextContent('high'))

    fireEvent.keyDown(window, { key: 'u', metaKey: true })
    await waitFor(() =>
      expect(screen.getByTestId('variant-indicator')).toHaveTextContent('ultracode')
    )

    fireEvent.keyDown(window, { key: 'u', metaKey: true })
    await waitFor(() =>
      expect(screen.getByTestId('variant-indicator')).not.toHaveTextContent('ultracode')
    )
    expect(screen.getByTestId('variant-indicator')).toHaveTextContent('high')
  })

  it('Cmd+Enter confirms and sends', async () => {
    renderModal()

    await userEvent.click(screen.getByTestId('worktree-item-worktree-1'))

    fireEvent.keyDown(window, { key: 'Enter', metaKey: true })

    await waitFor(() => {
      const createSession = useSessionStore.getState().createSession as ReturnType<typeof vi.fn>
      expect(createSession).toHaveBeenCalledTimes(1)
      expect(createSession.mock.calls[0].slice(0, 2)).toEqual(['worktree-1', 'project-1'])
    })
  })

  it('Cmd+Enter does nothing while goal criteria is required but empty', async () => {
    renderModal()

    await userEvent.click(screen.getByTestId('worktree-item-worktree-1'))
    await screen.findByTestId('goal-mode-toggle')

    fireEvent.keyDown(window, { key: 'g', metaKey: true })
    await screen.findByTestId('goal-success-criteria')

    fireEvent.keyDown(window, { key: 'Enter', metaKey: true })

    // Give the (should-be-absent) send flow a beat to run.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(useSessionStore.getState().createSession).not.toHaveBeenCalled()
  })
})

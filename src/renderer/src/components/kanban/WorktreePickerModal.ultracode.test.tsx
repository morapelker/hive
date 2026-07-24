import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorktreePickerModal, _resetLastSourceBranch } from './WorktreePickerModal'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useUsageStore } from '@/stores/useUsageStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import type { KanbanTicket } from '../../../../main/db/types'

// IMPORTANT: do NOT mock ModelSelector here — this test exercises the real
// board-modal -> ModelSelector SDK-resolution path end to end.

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
    listModels: vi.fn(async () => ({ success: true, providers: PROVIDERS }))
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

function setupStores(): void {
  useSettingsStore.setState({
    availableAgentSdks: { opencode: true, claude: true, codex: true },
    defaultAgentSdk: 'codex',
    selectedModel: null,
    // Mirrors the real user's settings: the build-mode default is a claude-code-cli model.
    selectedModelByProvider: {
      'claude-code-cli': { providerID: 'claude-code', modelID: 'opus', variant: 'xhigh' }
    },
    defaultModels: {
      build: { agentSdk: 'claude-code-cli', providerID: 'claude-code', modelID: 'opus', variant: 'high' },
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
    createSession: vi.fn(),
    createConnectionSession: vi.fn(),
    setSessionModel: vi.fn(),
    setSessionMode: vi.fn(),
    setOpenCodeSessionId: vi.fn(),
    setActiveSession: vi.fn()
  })
  useWorktreeStatusStore.setState({ setSessionStatus: vi.fn(), setLastMessageTime: vi.fn() })
  useUsageStore.setState({ fetchUsageForProvider: vi.fn() })
}

beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  _resetLastSourceBranch()
  vi.clearAllMocks()
  resetRendererRpcClientForTests()
  setRendererRpcClient({
    request: vi.fn(async () => null),
    subscribe: vi.fn(() => () => {})
  })
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

describe('WorktreePickerModal ultracode chip (real ModelSelector)', () => {
  it('shows ULTRACODE on Opus when Claude CLI is selected in the ticket modal', async () => {
    render(
      <WorktreePickerModal
        ticket={baseTicket}
        projectId="project-1"
        open
        onOpenChange={vi.fn()}
        onSendComplete={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('sdk-toggle-claude-code-cli'))

    // Open the model picker dropdown (the pill trigger).
    await userEvent.click(await screen.findByTestId('model-selector'))

    await waitFor(() => expect(screen.getByTestId('variant-chips-opus')).toBeInTheDocument())

    const opusChips = screen.getByTestId('variant-chips-opus')
    expect(within(opusChips).getByTestId('variant-chip-ultracode')).toBeInTheDocument()

    const sonnetChips = screen.getByTestId('variant-chips-sonnet')
    expect(within(sonnetChips).queryByTestId('variant-chip-ultracode')).toBeNull()
  })
})

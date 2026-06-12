import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react'

// ── Mock electron and simple-git so git-service can be imported in jsdom ──
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/tmp/mock-home')
  }
}))

vi.mock('simple-git', () => ({
  default: vi.fn().mockReturnValue({
    branch: vi.fn(),
    raw: vi.fn()
  })
}))

const apiMocks = vi.hoisted(() => ({
  kanbanApi: {
    ticket: {
      create: vi.fn(),
      get: vi.fn(),
      getByProject: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn(),
      move: vi.fn().mockResolvedValue(undefined),
      reorder: vi.fn().mockResolvedValue(undefined),
      getBySession: vi.fn(),
      addTokens: vi.fn()
    },
    dependency: {
      removeAll: vi.fn(),
      getForProject: vi.fn().mockResolvedValue([]),
      add: vi.fn(),
      remove: vi.fn()
    },
    simpleMode: {
      toggle: vi.fn()
    }
  },
  dbApi: {
    session: {
      create: vi.fn(),
      update: vi.fn().mockResolvedValue(undefined),
      getActiveByWorktree: vi.fn().mockResolvedValue([]),
      getActiveByConnection: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null)
    },
    worktree: {
      getActiveByProject: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue(undefined),
      touch: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null)
    },
    project: {
      touch: vi.fn().mockResolvedValue(true),
      getAll: vi.fn().mockResolvedValue([])
    },
    setting: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(true),
      getAll: vi.fn().mockResolvedValue([])
    }
  },
  worktreeApi: {
    create: vi.fn(),
    createFromBranch: vi.fn(),
    duplicate: vi.fn(),
    onBranchRenamed: vi.fn(() => vi.fn())
  },
  gitApi: {
    listBranchesWithStatus: vi.fn(),
    onStatusChanged: vi.fn(() => vi.fn()),
    onBranchChanged: vi.fn(() => vi.fn())
  },
  usageApi: {
    fetch: vi.fn().mockResolvedValue({ success: true, data: null }),
    fetchOpenai: vi.fn().mockResolvedValue({ success: true, data: null })
  },
  connectionApi: {
    get: vi.fn(),
    getAll: vi.fn().mockResolvedValue({ success: true, connections: [] })
  },
  opencodeApi: {
    connect: vi.fn(),
    prompt: vi.fn(),
    listModels: vi.fn(),
    commands: vi.fn().mockResolvedValue({ success: true, commands: [] }),
    onStream: vi.fn(() => vi.fn())
  },
  settingsApi: {
    onSettingsUpdated: vi.fn(() => vi.fn())
  },
  systemApi: {
    detectAgentSdks: vi.fn().mockResolvedValue({ opencode: true, claude: true, codex: true }),
    setSessionQueuedState: vi.fn().mockResolvedValue(undefined)
  },
  petApi: {
    updateSettings: vi.fn().mockResolvedValue(undefined),
    show: vi.fn().mockResolvedValue(undefined),
    hide: vi.fn().mockResolvedValue(undefined)
  },
  telegramApi: {
    getConfig: vi.fn().mockResolvedValue(null),
    getStatus: vi.fn().mockResolvedValue({ active: false }),
    onStatusChanged: vi.fn(() => vi.fn()),
    onMessageReceived: vi.fn(() => vi.fn()),
    onPlanImplementRequested: vi.fn(() => vi.fn())
  },
  updaterApi: {
    onUpdateStatus: vi.fn(() => vi.fn())
  },
  fileApi: {
    selectAttachmentFiles: vi.fn().mockResolvedValue([])
  },
  terminalApi: {
    create: vi.fn().mockResolvedValue({ success: true, terminalId: 'terminal-1' }),
    onOutput: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    onCreated: vi.fn(() => vi.fn()),
    onClosed: vi.fn(() => vi.fn())
  },
  scriptApi: {
    onStarted: vi.fn(() => vi.fn()),
    onOutput: vi.fn(() => vi.fn()),
    onFinished: vi.fn(() => vi.fn())
  },
  hiveTelemetry: {
    startHivePromptTelemetry: vi.fn()
  }
}))

vi.mock('@/api/kanban-api', () => ({ kanbanApi: apiMocks.kanbanApi }))
vi.mock('@/api/db-api', () => ({ dbApi: apiMocks.dbApi }))
vi.mock('@/api/worktree-api', () => ({ worktreeApi: apiMocks.worktreeApi }))
vi.mock('@/api/git-api', () => ({ gitApi: apiMocks.gitApi }))
vi.mock('@/api/usage-api', () => ({ usageApi: apiMocks.usageApi }))
vi.mock('@/api/connection-api', () => ({ connectionApi: apiMocks.connectionApi }))
vi.mock('@/api/opencode-api', () => ({ opencodeApi: apiMocks.opencodeApi }))
vi.mock('@/api/settings-api', () => ({ settingsApi: apiMocks.settingsApi }))
vi.mock('@/api/system-api', () => ({ systemApi: apiMocks.systemApi }))
vi.mock('@/api/pet-api', () => ({ petApi: apiMocks.petApi }))
vi.mock('@/api/telegram-api', () => ({ telegramApi: apiMocks.telegramApi }))
vi.mock('@/api/updater-api', () => ({ updaterApi: apiMocks.updaterApi }))
vi.mock('@/api/file-api', () => ({ fileApi: apiMocks.fileApi }))
vi.mock('@/api/terminal-api', () => ({ terminalApi: apiMocks.terminalApi }))
vi.mock('@/api/script-api', () => ({ scriptApi: apiMocks.scriptApi }))
vi.mock('@/lib/hive-enterprise-telemetry', () => apiMocks.hiveTelemetry)

const mockKanban = apiMocks.kanbanApi
const mockDbSession = apiMocks.dbApi.session
const mockDbWorktree = apiMocks.dbApi.worktree
const mockWorktreeOps = apiMocks.worktreeApi
const mockGitOps = apiMocks.gitApi
const mockOpencodeOps = apiMocks.opencodeApi
const mockConnectionOps = apiMocks.connectionApi

// ── Import stores AFTER mocking ─────────────────────────────────────
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { getSuperPlanModePrefix } from '@/lib/constants'

// ── Import component under test ─────────────────────────────────────
import {
  WorktreePickerModal,
  _resetLastSourceBranch
} from '@/components/kanban/WorktreePickerModal'

import type { KanbanTicket } from '../../../src/main/db/types'

// ── Helpers ─────────────────────────────────────────────────────────
function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: 'proj-1',
    title: 'Implement auth flow',
    description: 'Add login and signup pages with JWT tokens',
    attachments: [],
    column: 'todo',
    sort_order: 0,
    current_session_id: null,
    worktree_id: null,
    mode: null,
    plan_ready: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    archived_at: null,
    external_provider: null,
    external_id: null,
    external_url: null,
    github_pr_number: null,
    github_pr_url: null,
    mark: null,
    total_tokens: 0,
    pending_launch_config: null,
    goal_mode: false,
    goal_success_criteria: null,
    note: null,
    ...overrides
  }
}

function makeWorktree(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wt-1',
    project_id: 'proj-1',
    name: 'feature-auth',
    branch_name: 'feature-auth',
    path: '/test/feature-auth',
    status: 'active' as const,
    is_default: false,
    branch_renamed: 0,
    last_message_at: null,
    session_titles: '[]',
    last_model_provider_id: null,
    last_model_id: null,
    last_model_variant: null,
    created_at: '2026-01-01T00:00:00Z',
    last_accessed_at: '2026-01-01T00:00:00Z',
    github_pr_number: null,
    github_pr_url: null,
    ...overrides
  }
}

function makeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proj-1',
    name: 'My Project',
    path: '/test/my-project',
    description: null,
    tags: null,
    language: null,
    custom_icon: null,
    setup_script: null,
    run_script: null,
    archive_script: null,
    auto_assign_port: false,
    sort_order: 0,
    created_at: '2026-01-01T00:00:00Z',
    last_accessed_at: '2026-01-01T00:00:00Z',
    ...overrides
  }
}

function makeCreatedWorktree() {
  return {
    id: 'wt-new',
    project_id: 'proj-1',
    name: 'new-worktree',
    branch_name: 'new-worktree',
    path: '/test/new-worktree',
    status: 'active',
    is_default: false,
    branch_renamed: 0,
    last_message_at: null,
    session_titles: '[]',
    last_model_provider_id: null,
    last_model_id: null,
    last_model_variant: null,
    created_at: '2026-01-01T00:00:00Z',
    last_accessed_at: '2026-01-01T00:00:00Z',
    github_pr_number: null,
    github_pr_url: null
  }
}

function resetApiMocks() {
  mockKanban.ticket.getByProject.mockResolvedValue([])
  mockKanban.ticket.update.mockResolvedValue(undefined)
  mockKanban.ticket.move.mockResolvedValue(undefined)
  mockKanban.ticket.reorder.mockResolvedValue(undefined)
  mockDbSession.create.mockImplementation(async (input: Record<string, unknown>) => ({
    id: 'new-session-1',
    worktree_id: (input.worktree_id as string | null) ?? 'wt-1',
    project_id: (input.project_id as string | null) ?? 'proj-1',
    connection_id: (input.connection_id as string | null) ?? null,
    name: (input.name as string | null) ?? 'Session 1',
    status: 'active',
    opencode_session_id: null,
    agent_sdk: (input.agent_sdk as string | null) ?? 'opencode',
    mode: (input.mode as string | null) ?? 'build',
    model_provider_id: (input.model_provider_id as string | null) ?? null,
    model_id: (input.model_id as string | null) ?? null,
    model_variant: (input.model_variant as string | null) ?? null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    completed_at: null
  }))
  mockDbSession.update.mockResolvedValue(undefined)
  mockDbSession.getActiveByWorktree.mockResolvedValue([])
  mockDbSession.getActiveByConnection.mockResolvedValue([])
  mockDbSession.get.mockResolvedValue(null)
  mockDbWorktree.getActiveByProject.mockResolvedValue([])
  mockDbWorktree.update.mockResolvedValue(undefined)
  mockDbWorktree.touch.mockResolvedValue(undefined)
  mockDbWorktree.get.mockResolvedValue(null)
  mockWorktreeOps.create.mockResolvedValue({
    success: true,
    worktree: makeCreatedWorktree()
  })
  mockWorktreeOps.createFromBranch.mockResolvedValue({
    success: true,
    worktree: makeCreatedWorktree()
  })
  mockWorktreeOps.duplicate.mockResolvedValue({
    success: true,
    worktree: makeCreatedWorktree()
  })
  mockGitOps.listBranchesWithStatus.mockResolvedValue({
    success: true,
    branches: [
      { name: 'main', isRemote: false, isCheckedOut: true },
      { name: 'feature-x', isRemote: false, isCheckedOut: false },
      { name: 'develop', isRemote: true, isCheckedOut: false }
    ]
  })
  mockConnectionOps.get.mockResolvedValue({
    success: true,
    connection: {
      id: 'conn-1',
      members: [{ project_id: 'proj-1' }]
    }
  })
  mockOpencodeOps.connect.mockResolvedValue({
    success: true,
    sessionId: 'oc-session-1'
  })
  mockOpencodeOps.prompt.mockResolvedValue({ success: true })
  mockOpencodeOps.listModels.mockResolvedValue({
    success: true,
    providers: [
      {
        id: 'openai',
        name: 'OpenAI',
        models: {
          'gpt-5.5': { id: 'gpt-5.5', name: 'GPT-5.5' },
          'gpt-5.4': { id: 'gpt-5.4', name: 'GPT-5.4' },
          'gpt-5.4-mini': { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' }
        }
      }
    ]
  })
}

// ── Setup ───────────────────────────────────────────────────────────
describe('Session 9: Worktree Picker Modal', () => {
  const defaultTicket = makeTicket()
  const defaultWorktrees = [
    makeWorktree({ id: 'wt-1', name: 'feature-auth' }),
    makeWorktree({ id: 'wt-2', name: 'feature-api', is_default: false }),
    makeWorktree({ id: 'wt-default', name: 'main', is_default: true, branch_name: 'main' })
  ]

  beforeEach(() => {
    _resetLastSourceBranch()
    act(() => {
      useKanbanStore.setState({
        tickets: new Map([
          [
            'proj-1',
            [
              defaultTicket,
              makeTicket({
                id: 'ticket-ip-1',
                column: 'in_progress',
                worktree_id: 'wt-1',
                sort_order: 0
              }),
              makeTicket({
                id: 'ticket-ip-2',
                column: 'in_progress',
                worktree_id: 'wt-1',
                sort_order: 1
              })
            ]
          ]
        ]),
        isLoading: false,
        isBoardViewActive: true,
        simpleModeByProject: {}
      })
      useWorktreeStore.setState({
        selectedWorktreeId: null,
        worktreesByProject: new Map([['proj-1', defaultWorktrees]])
      })
      useSessionStore.setState({
        activeSessionId: null,
        isLoading: false,
        sessionsByWorktree: new Map(),
        sessionsByConnection: new Map(),
        closedTerminalSessionIds: new Set(),
        inlineConnectionSessionId: null,
        modeBySession: new Map()
      })
      useProjectStore.setState({
        projects: [makeProject()]
      })
      useSettingsStore.setState({
        availableAgentSdks: { opencode: true, claude: true, codex: true },
        defaultAgentSdk: 'opencode',
        defaultModels: {
          build: null,
          plan: null,
          ask: null,
          review: null
        },
        codexFastMode: false,
        codexFastModeAccepted: false
      })
      useConnectionStore.setState({
        connections: [
          {
            id: 'conn-1',
            name: 'Main connection',
            path: '/test/connection',
            status: 'active',
            pinned: false,
            color: null,
            custom_name: null,
            members: [{ project_id: 'proj-1' }],
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z'
          }
        ]
      })
    })
    vi.clearAllMocks()
    resetApiMocks()
  })

  // ── Rendering tests ──────────────────────────────────────────────

  test('modal renders list of project worktrees', () => {
    render(
      <WorktreePickerModal
        ticket={defaultTicket}
        projectId="proj-1"
        open={true}
        onOpenChange={() => {}}
      />
    )

    expect(screen.getByTestId('worktree-picker-modal')).toBeInTheDocument()
    expect(screen.getByText('feature-auth')).toBeInTheDocument()
    expect(screen.getByText('feature-api')).toBeInTheDocument()
    // "main" worktree exists in the list (use worktree-item testid since "main" also
    // appears in the source-branch trigger when "New worktree" is pre-selected)
    expect(screen.getByTestId('worktree-item-wt-default')).toHaveTextContent('main')
  })

  test('each worktree shows active ticket count badge', () => {
    render(
      <WorktreePickerModal
        ticket={defaultTicket}
        projectId="proj-1"
        open={true}
        onOpenChange={() => {}}
      />
    )

    // wt-1 has 2 tickets in_progress
    const wt1Item = screen.getByTestId('worktree-item-wt-1')
    expect(wt1Item).toHaveTextContent('2')

    // wt-2 has 0 in_progress tickets — badge should show 0 or not appear
    const wt2Item = screen.getByTestId('worktree-item-wt-2')
    expect(wt2Item).toBeInTheDocument()
  })

  test('"New worktree" option appears at top of list', () => {
    render(
      <WorktreePickerModal
        ticket={defaultTicket}
        projectId="proj-1"
        open={true}
        onOpenChange={() => {}}
      />
    )

    const newWtOption = screen.getByTestId('worktree-item-new')
    expect(newWtOption).toBeInTheDocument()

    // Should appear before existing worktrees
    const list = screen.getByTestId('worktree-list')
    const items = list.querySelectorAll('[data-testid^="worktree-item-"]')
    expect(items[0].getAttribute('data-testid')).toBe('worktree-item-new')
  })

  // ── Auto-select current worktree tests ──────────────────────────

  test('defaults to "New worktree" when modal opens', () => {
    act(() => {
      useWorktreeStore.setState({ selectedWorktreeId: 'wt-2' })
    })

    render(
      <WorktreePickerModal
        ticket={defaultTicket}
        projectId="proj-1"
        open={true}
        onOpenChange={() => {}}
      />
    )

    // "New worktree" should be auto-selected (has ring highlight), not the global worktree
    const newWtItem = screen.getByTestId('worktree-item-new')
    expect(newWtItem.className).toContain('ring-primary')

    // Existing worktree should NOT be highlighted
    const wt2Item = screen.getByTestId('worktree-item-wt-2')
    expect(wt2Item.className).not.toContain('ring-primary')

    // Send button should be enabled since "New worktree" is auto-selected
    const sendBtn = screen.getByTestId('wt-picker-send-btn')
    expect(sendBtn).not.toBeDisabled()
  })

  test('defaults to "New worktree" even when global worktree is from another project', () => {
    act(() => {
      useWorktreeStore.setState({ selectedWorktreeId: 'wt-other-project' })
    })

    render(
      <WorktreePickerModal
        ticket={defaultTicket}
        projectId="proj-1"
        open={true}
        onOpenChange={() => {}}
      />
    )

    // "New worktree" should still be selected — send button enabled
    const newWtItem = screen.getByTestId('worktree-item-new')
    expect(newWtItem.className).toContain('ring-primary')

    const sendBtn = screen.getByTestId('wt-picker-send-btn')
    expect(sendBtn).not.toBeDisabled()
  })

  // ── Build/Plan toggle tests ──────────────────────────────────────

  test('Build/Plan chip toggle defaults to build', () => {
    render(
      <WorktreePickerModal
        ticket={defaultTicket}
        projectId="proj-1"
        open={true}
        onOpenChange={() => {}}
      />
    )

    const toggle = screen.getByTestId('wt-picker-mode-toggle')
    expect(toggle).toHaveAttribute('data-mode', 'build')
  })

  test('Tab key toggles mode and focuses the prompt textarea', () => {
    render(
      <WorktreePickerModal
        ticket={defaultTicket}
        projectId="proj-1"
        open={true}
        onOpenChange={() => {}}
      />
    )

    const modal = screen.getByTestId('worktree-picker-modal')
    const textarea = screen.getByTestId('wt-picker-prompt')
    const toggle = screen.getByTestId('wt-picker-mode-toggle')

    // Textarea should not be focused initially
    expect(document.activeElement).not.toBe(textarea)
    expect(toggle).toHaveAttribute('data-mode', 'build')

    // Press Tab — should toggle to plan AND focus the textarea
    fireEvent.keyDown(modal, { key: 'Tab' })
    expect(toggle).toHaveAttribute('data-mode', 'plan')
    expect(document.activeElement).toBe(textarea)
  })

  test('Tab to plan mode reflects a cross-SDK mode default in the provider segment', async () => {
    act(() => {
      useSettingsStore.setState({
        defaultAgentSdk: 'opencode',
        defaultModels: {
          build: null,
          plan: {
            agentSdk: 'claude-code',
            providerID: 'anthropic',
            modelID: 'opus-4.5',
            variant: 'high'
          },
          ask: null,
          review: null
        }
      })
    })

    render(
      <WorktreePickerModal
        ticket={defaultTicket}
        projectId="proj-1"
        open={true}
        onOpenChange={() => {}}
      />
    )

    const modal = screen.getByTestId('worktree-picker-modal')

    expect(screen.getByTestId('sdk-toggle-opencode')).toHaveClass('bg-primary')
    fireEvent.keyDown(modal, { key: 'Tab' })

    await waitFor(() => {
      expect(screen.getByTestId('sdk-toggle-claude-code')).toHaveClass('bg-primary')
    })
    expect(screen.getByTestId('sdk-toggle-opencode')).not.toHaveClass('bg-primary')
    await waitFor(() => {
      expect(screen.getByTestId('model-selector')).toHaveTextContent('opus-4.5')
    })
  })

  test('Tab still toggles mode when prompt textarea is already focused', () => {
    render(
      <WorktreePickerModal
        ticket={defaultTicket}
        projectId="proj-1"
        open={true}
        onOpenChange={() => {}}
      />
    )

    const modal = screen.getByTestId('worktree-picker-modal')
    const textarea = screen.getByTestId('wt-picker-prompt') as HTMLTextAreaElement
    const toggle = screen.getByTestId('wt-picker-mode-toggle')

    // Focus the textarea first
    textarea.focus()
    expect(document.activeElement).toBe(textarea)

    // Press Tab — mode should toggle, focus should stay on textarea
    fireEvent.keyDown(modal, { key: 'Tab' })
    expect(toggle).toHaveAttribute('data-mode', 'plan')
    expect(document.activeElement).toBe(textarea)
  })

  // ── Prompt text tests ────────────────────────────────────────────

  test('default prompt changes when toggling build/plan', () => {
    render(
      <WorktreePickerModal
        ticket={defaultTicket}
        projectId="proj-1"
        open={true}
        onOpenChange={() => {}}
      />
    )

    const textarea = screen.getByTestId('wt-picker-prompt') as HTMLTextAreaElement
    const toggle = screen.getByTestId('wt-picker-mode-toggle')

    // Default is build mode
    expect(textarea.value).toContain('Please implement the following ticket')

    // Click chip to toggle to plan
    fireEvent.click(toggle)
    expect(textarea.value).toContain(
      'Please review the following ticket and create a detailed implementation plan'
    )
  })

  test('prompt text area is editable', () => {
    render(
      <WorktreePickerModal
        ticket={defaultTicket}
        projectId="proj-1"
        open={true}
        onOpenChange={() => {}}
      />
    )

    const textarea = screen.getByTestId('wt-picker-prompt') as HTMLTextAreaElement

    fireEvent.change(textarea, { target: { value: 'Custom prompt text' } })
    expect(textarea.value).toBe('Custom prompt text')
  })

  test('ticket content is embedded as XML block in prompt', () => {
    render(
      <WorktreePickerModal
        ticket={defaultTicket}
        projectId="proj-1"
        open={true}
        onOpenChange={() => {}}
      />
    )

    const textarea = screen.getByTestId('wt-picker-prompt') as HTMLTextAreaElement

    expect(textarea.value).toContain(`<ticket title="Implement auth flow">`)
    expect(textarea.value).toContain('Add login and signup pages with JWT tokens')
    expect(textarea.value).toContain('</ticket>')
  })

  test('toggling mode swaps prefix but preserves user edits to body', () => {
    render(
      <WorktreePickerModal
        ticket={defaultTicket}
        projectId="proj-1"
        open={true}
        onOpenChange={() => {}}
      />
    )
    const textarea = screen.getByTestId('wt-picker-prompt') as HTMLTextAreaElement
    const toggle = screen.getByTestId('wt-picker-mode-toggle')

    // Edit only the body portion (append custom text)
    const edited = textarea.value + '\n\nAlso add unit tests.'
    fireEvent.change(textarea, { target: { value: edited } })

    // Toggle build → plan: prefix should swap, appended text preserved
    fireEvent.click(toggle)
    expect(textarea.value).toContain(
      'Please review the following ticket and create a detailed implementation plan.'
    )
    expect(textarea.value).toContain('Also add unit tests.')

    // Toggle plan → build: prefix swaps back, appended text still there
    fireEvent.click(toggle)
    expect(textarea.value).toContain('Please implement the following ticket.')
    expect(textarea.value).toContain('Also add unit tests.')
  })

  test('toggling mode does not change text when prefix was edited by user', () => {
    render(
      <WorktreePickerModal
        ticket={defaultTicket}
        projectId="proj-1"
        open={true}
        onOpenChange={() => {}}
      />
    )
    const textarea = screen.getByTestId('wt-picker-prompt') as HTMLTextAreaElement
    const toggle = screen.getByTestId('wt-picker-mode-toggle')

    // Replace the entire prompt with custom text (no recognizable prefix)
    fireEvent.change(textarea, { target: { value: 'My completely custom prompt' } })

    // Toggle mode — text should not change
    fireEvent.click(toggle)
    expect(textarea.value).toBe('My completely custom prompt')

    // Toggle back — still untouched
    fireEvent.click(toggle)
    expect(textarea.value).toBe('My completely custom prompt')
  })

  // ── Send button state tests ──────────────────────────────────────

  test('Send button is enabled by default (New worktree is pre-selected)', () => {
    render(
      <WorktreePickerModal
        ticket={defaultTicket}
        projectId="proj-1"
        open={true}
        onOpenChange={() => {}}
      />
    )

    // "New worktree" is selected by default, so Send should be enabled
    const sendBtn = screen.getByTestId('wt-picker-send-btn')
    expect(sendBtn).not.toBeDisabled()
  })

  test('Send button stays enabled when switching to an existing worktree', () => {
    render(
      <WorktreePickerModal
        ticket={defaultTicket}
        projectId="proj-1"
        open={true}
        onOpenChange={() => {}}
      />
    )

    // Switch from default "New worktree" to an existing worktree
    const wt1Item = screen.getByTestId('worktree-item-wt-1')
    fireEvent.click(wt1Item)

    const sendBtn = screen.getByTestId('wt-picker-send-btn')
    expect(sendBtn).not.toBeDisabled()
  })

  test('shows Fast toggle only when Codex is selected', async () => {
    render(
      <WorktreePickerModal
        ticket={defaultTicket}
        projectId="proj-1"
        open={true}
        onOpenChange={() => {}}
      />
    )

    expect(screen.queryByTestId('codex-fast-toggle')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('sdk-toggle-codex'))
    expect(await screen.findByTestId('codex-fast-toggle')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('sdk-toggle-opencode'))
    await waitFor(() => {
      expect(screen.queryByTestId('codex-fast-toggle')).not.toBeInTheDocument()
    })
  })

  test('accepting Fast toggle updates shared Codex fast settings', async () => {
    render(
      <WorktreePickerModal
        ticket={defaultTicket}
        projectId="proj-1"
        open={true}
        onOpenChange={() => {}}
      />
    )

    fireEvent.click(screen.getByTestId('sdk-toggle-codex'))
    fireEvent.click(await screen.findByTestId('codex-fast-toggle'))

    expect(screen.getByText('Fast Mode')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))

    await waitFor(() => {
      expect(useSettingsStore.getState().codexFastModeAccepted).toBe(true)
      expect(useSettingsStore.getState().codexFastMode).toBe(true)
    })
  })

  test('Goal switch only renders for codex+build', () => {
    render(
      <WorktreePickerModal
        ticket={defaultTicket}
        projectId="proj-1"
        open={true}
        onOpenChange={() => {}}
      />
    )

    expect(screen.queryByTestId('goal-mode-toggle')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('sdk-toggle-codex'))
    expect(screen.getByTestId('goal-mode-toggle')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('wt-picker-mode-toggle'))
    expect(screen.queryByTestId('goal-mode-toggle')).not.toBeInTheDocument()
  })

  test('Goal switch hides and clears criteria on SDK switch away from codex', async () => {
    render(
      <WorktreePickerModal
        ticket={defaultTicket}
        projectId="proj-1"
        open={true}
        onOpenChange={() => {}}
      />
    )

    fireEvent.click(screen.getByTestId('sdk-toggle-codex'))
    fireEvent.click(screen.getByTestId('goal-mode-toggle'))
    fireEvent.change(screen.getByTestId('goal-success-criteria'), {
      target: { value: 'Ship tested auth flow' }
    })

    fireEvent.click(screen.getByTestId('sdk-toggle-opencode'))
    expect(screen.queryByTestId('goal-mode-toggle')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('sdk-toggle-codex'))
    const goalSwitch = screen.getByTestId('goal-mode-toggle')
    expect(goalSwitch).toHaveAttribute('aria-checked', 'false')
    expect(screen.queryByTestId('goal-success-criteria')).not.toBeInTheDocument()
  })

  test('Goal switch hides and clears criteria on mode switch to plan/super-plan', () => {
    render(
      <WorktreePickerModal
        ticket={defaultTicket}
        projectId="proj-1"
        open={true}
        onOpenChange={() => {}}
      />
    )

    fireEvent.click(screen.getByTestId('sdk-toggle-codex'))
    fireEvent.click(screen.getByTestId('goal-mode-toggle'))
    fireEvent.change(screen.getByTestId('goal-success-criteria'), {
      target: { value: 'Complete the implementation' }
    })

    fireEvent.click(screen.getByTestId('wt-picker-mode-toggle'))
    expect(screen.queryByTestId('goal-mode-toggle')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('wt-picker-super-toggle'))
    expect(screen.queryByTestId('goal-mode-toggle')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('wt-picker-mode-toggle'))
    const goalSwitch = screen.getByTestId('goal-mode-toggle')
    expect(goalSwitch).toHaveAttribute('aria-checked', 'false')
    expect(screen.queryByTestId('goal-success-criteria')).not.toBeInTheDocument()
  })

  test('Send disabled when goalMode is on and criteria is empty', () => {
    render(
      <WorktreePickerModal
        ticket={defaultTicket}
        projectId="proj-1"
        open={true}
        onOpenChange={() => {}}
      />
    )

    fireEvent.click(screen.getByTestId('sdk-toggle-codex'))
    fireEvent.click(screen.getByTestId('goal-mode-toggle'))

    expect(screen.getByText('Required')).toBeInTheDocument()
    expect(screen.getByTestId('wt-picker-send-btn')).toBeDisabled()

    fireEvent.change(screen.getByTestId('goal-success-criteria'), {
      target: { value: 'All tests pass' }
    })
    expect(screen.getByTestId('wt-picker-send-btn')).not.toBeDisabled()
  })

  test('worktree-mode Codex goal launch wraps prompt and persists goal columns', async () => {
    render(
      <WorktreePickerModal
        ticket={defaultTicket}
        projectId="proj-1"
        open={true}
        onOpenChange={() => {}}
      />
    )

    fireEvent.click(screen.getByTestId('sdk-toggle-codex'))
    fireEvent.change(screen.getByTestId('wt-picker-prompt'), {
      target: { value: 'Build auth' }
    })
    fireEvent.click(screen.getByTestId('goal-mode-toggle'))
    fireEvent.change(screen.getByTestId('goal-success-criteria'), {
      target: { value: '  Login and signup work  ' }
    })
    fireEvent.click(screen.getByTestId('worktree-item-wt-1'))

    await act(async () => {
      fireEvent.click(screen.getByTestId('wt-picker-send-btn'))
    })

    await waitFor(() => {
      expect(mockOpencodeOps.prompt).toHaveBeenCalled()
    })

    const promptParts = mockOpencodeOps.prompt.mock.calls.at(-1)?.[2] as Array<{
      type: string
      text: string
    }>
    expect(promptParts[0]?.text).toBe(
      '/goal Build auth. Goal success criteria: Login and signup work'
    )
    expect(apiMocks.hiveTelemetry.startHivePromptTelemetry).toHaveBeenCalledWith({
      sessionId: 'new-session-1',
      prompt: '/goal Build auth. Goal success criteria: Login and signup work',
      worktreeId: 'wt-1',
      modelId: undefined,
      providerId: undefined,
      modelVariant: undefined,
      mode: 'build'
    })
    expect(mockKanban.ticket.update).toHaveBeenCalledWith(
      'proj-1',
      'ticket-1',
      expect.objectContaining({
        column: 'in_progress',
        goal_mode: true,
        goal_success_criteria: 'Login and signup work'
      })
    )
  })

  test('connection-mode Codex goal launch wraps prompt', async () => {
    render(
      <WorktreePickerModal
        ticket={defaultTicket}
        projectId="proj-1"
        open={true}
        onOpenChange={() => {}}
        connectionId="conn-1"
      />
    )

    fireEvent.click(screen.getByTestId('sdk-toggle-codex'))
    fireEvent.change(screen.getByTestId('wt-picker-prompt'), {
      target: { value: 'Build auth' }
    })
    fireEvent.click(screen.getByTestId('goal-mode-toggle'))
    fireEvent.change(screen.getByTestId('goal-success-criteria'), {
      target: { value: 'Auth works end to end' }
    })

    await act(async () => {
      fireEvent.click(screen.getByTestId('wt-picker-send-btn'))
    })

    await waitFor(() => {
      expect(mockOpencodeOps.prompt).toHaveBeenCalled()
    })

    const promptParts = mockOpencodeOps.prompt.mock.calls.at(-1)?.[2] as Array<{
      type: string
      text: string
    }>
    expect(promptParts[0]?.text).toBe(
      '/goal Build auth. Goal success criteria: Auth works end to end'
    )
  })

  test('saveConfigOnly persists goalMode and goalSuccessCriteria in pending config JSON', async () => {
    render(
      <WorktreePickerModal
        ticket={defaultTicket}
        projectId="proj-1"
        open={true}
        onOpenChange={() => {}}
        saveConfigOnly
      />
    )

    fireEvent.click(screen.getByTestId('sdk-toggle-codex'))
    fireEvent.click(screen.getByTestId('goal-mode-toggle'))
    fireEvent.change(screen.getByTestId('goal-success-criteria'), {
      target: { value: '  Criteria are met  ' }
    })

    await act(async () => {
      fireEvent.click(screen.getByTestId('wt-picker-send-btn'))
    })

    await waitFor(() => {
      expect(mockKanban.ticket.update).toHaveBeenCalled()
    })

    const updatePayload = mockKanban.ticket.update.mock.calls.at(-1)?.[2] as {
      pending_launch_config: string
      goal_mode: boolean
      goal_success_criteria: string | null
    }
    expect(JSON.parse(updatePayload.pending_launch_config)).toEqual(
      expect.objectContaining({
        goalMode: true,
        goalSuccessCriteria: 'Criteria are met'
      })
    )
    expect(updatePayload).toEqual(
      expect.objectContaining({
        goal_mode: true,
        goal_success_criteria: 'Criteria are met'
      })
    )
  })

  test('Double-wrap guard: prompt that already starts with /goal produces a single prefix', async () => {
    render(
      <WorktreePickerModal
        ticket={defaultTicket}
        projectId="proj-1"
        open={true}
        onOpenChange={() => {}}
      />
    )

    fireEvent.click(screen.getByTestId('sdk-toggle-codex'))
    fireEvent.change(screen.getByTestId('wt-picker-prompt'), {
      target: { value: '/goal Build auth' }
    })
    fireEvent.click(screen.getByTestId('goal-mode-toggle'))
    fireEvent.change(screen.getByTestId('goal-success-criteria'), {
      target: { value: 'No duplicate goal command' }
    })
    fireEvent.click(screen.getByTestId('worktree-item-wt-1'))

    await act(async () => {
      fireEvent.click(screen.getByTestId('wt-picker-send-btn'))
    })

    await waitFor(() => {
      expect(mockOpencodeOps.prompt).toHaveBeenCalled()
    })

    const promptParts = mockOpencodeOps.prompt.mock.calls.at(-1)?.[2] as Array<{
      type: string
      text: string
    }>
    expect(promptParts[0]?.text).toBe(
      '/goal Build auth. Goal success criteria: No duplicate goal command'
    )
  })

  // ── Submit flow tests ────────────────────────────────────────────

  test('submitting calls session creation with correct mode', async () => {
    const onOpenChange = vi.fn()

    render(
      <WorktreePickerModal
        ticket={defaultTicket}
        projectId="proj-1"
        open={true}
        onOpenChange={onOpenChange}
      />
    )

    // Select a worktree
    const wt1Item = screen.getByTestId('worktree-item-wt-1')
    fireEvent.click(wt1Item)

    // Click send
    const sendBtn = screen.getByTestId('wt-picker-send-btn')
    await act(async () => {
      fireEvent.click(sendBtn)
    })

    // Should have created a session via sessionStore.
    await waitFor(() => {
      expect(mockKanban.ticket.update).toHaveBeenCalled()
    })
  })

  test('submitting updates ticket with session_id, worktree_id, mode', async () => {
    const onOpenChange = vi.fn()

    render(
      <WorktreePickerModal
        ticket={defaultTicket}
        projectId="proj-1"
        open={true}
        onOpenChange={onOpenChange}
      />
    )

    // Select a worktree
    const wt1Item = screen.getByTestId('worktree-item-wt-1')
    fireEvent.click(wt1Item)

    // Click send
    const sendBtn = screen.getByTestId('wt-picker-send-btn')
    await act(async () => {
      fireEvent.click(sendBtn)
    })

    await waitFor(() => {
      expect(mockKanban.ticket.update).toHaveBeenCalledWith(
        'proj-1',
        'ticket-1',
        expect.objectContaining({
          worktree_id: 'wt-1',
          mode: 'build',
          column: 'in_progress'
        })
      )
    })
  })

  test('modal closes after successful send', async () => {
    const onOpenChange = vi.fn()

    render(
      <WorktreePickerModal
        ticket={defaultTicket}
        projectId="proj-1"
        open={true}
        onOpenChange={onOpenChange}
      />
    )

    // Select a worktree
    const wt1Item = screen.getByTestId('worktree-item-wt-1')
    fireEvent.click(wt1Item)

    // Click send
    const sendBtn = screen.getByTestId('wt-picker-send-btn')
    await act(async () => {
      fireEvent.click(sendBtn)
    })

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
  })

  test('submitting a Codex session forwards codexFastMode to the initial prompt', async () => {
    act(() => {
      useSettingsStore.setState({
        codexFastMode: true,
        codexFastModeAccepted: true
      })
    })

    render(
      <WorktreePickerModal
        ticket={defaultTicket}
        projectId="proj-1"
        open={true}
        onOpenChange={() => {}}
      />
    )

    fireEvent.click(screen.getByTestId('sdk-toggle-codex'))
    fireEvent.click(screen.getByTestId('worktree-item-wt-1'))

    await act(async () => {
      fireEvent.click(screen.getByTestId('wt-picker-send-btn'))
    })

    await waitFor(() => {
      expect(mockOpencodeOps.prompt).toHaveBeenCalled()
    })

    expect(mockOpencodeOps.prompt).toHaveBeenLastCalledWith(
      '/test/feature-auth',
      'oc-session-1',
      expect.any(Array),
      undefined,
      { codexFastMode: true }
    )
  })

  test('super-plan prompts use request_user_input wording for Codex sessions', async () => {
    render(
      <WorktreePickerModal
        ticket={defaultTicket}
        projectId="proj-1"
        open={true}
        onOpenChange={() => {}}
      />
    )

    fireEvent.click(screen.getByTestId('sdk-toggle-codex'))
    fireEvent.click(screen.getByTestId('wt-picker-mode-toggle'))
    fireEvent.click(screen.getByTestId('wt-picker-super-toggle'))
    fireEvent.click(screen.getByTestId('worktree-item-wt-1'))

    await act(async () => {
      fireEvent.click(screen.getByTestId('wt-picker-send-btn'))
    })

    await waitFor(() => {
      expect(mockOpencodeOps.prompt).toHaveBeenCalled()
    })

    const promptParts = mockOpencodeOps.prompt.mock.calls.at(-1)?.[2] as Array<{
      type: string
      text: string
    }>
    expect(promptParts[0]?.text).toContain(getSuperPlanModePrefix('codex'))
    expect(promptParts[0]?.text).toContain('request_user_input')
    expect(promptParts[0]?.text).not.toContain('AskUserQuestion')
  })

  test('super-plan prompts keep AskUserQuestion wording for non-Codex sessions', async () => {
    render(
      <WorktreePickerModal
        ticket={defaultTicket}
        projectId="proj-1"
        open={true}
        onOpenChange={() => {}}
      />
    )

    fireEvent.click(screen.getByTestId('wt-picker-mode-toggle'))
    fireEvent.click(screen.getByTestId('wt-picker-super-toggle'))
    fireEvent.click(screen.getByTestId('worktree-item-wt-1'))

    await act(async () => {
      fireEvent.click(screen.getByTestId('wt-picker-send-btn'))
    })

    await waitFor(() => {
      expect(mockOpencodeOps.prompt).toHaveBeenCalled()
    })

    const promptParts = mockOpencodeOps.prompt.mock.calls.at(-1)?.[2] as Array<{
      type: string
      text: string
    }>
    expect(promptParts[0]?.text).toContain(getSuperPlanModePrefix('opencode'))
    expect(promptParts[0]?.text).toContain('AskUserQuestion')
    expect(promptParts[0]?.text).not.toContain('request_user_input')
  })

  // ── Source branch picker tests ──────────────────────────────────

  test('shows source branch selector by default (New worktree is pre-selected)', async () => {
    render(
      <WorktreePickerModal
        ticket={defaultTicket}
        projectId="proj-1"
        open={true}
        onOpenChange={() => {}}
      />
    )

    // Source branch trigger should be visible immediately since "New worktree" is default
    const trigger = screen.getByTestId('source-branch-trigger')
    expect(trigger).toBeInTheDocument()
    expect(trigger).toHaveTextContent('main')
  })

  test('source branch defaults to default worktree branch name', async () => {
    // Override worktrees so the default worktree has a non-'main' branch
    act(() => {
      useWorktreeStore.setState({
        worktreesByProject: new Map([
          [
            'proj-1',
            [
              makeWorktree({ id: 'wt-1', name: 'feature-auth' }),
              makeWorktree({
                id: 'wt-default',
                name: 'develop',
                is_default: true,
                branch_name: 'develop'
              })
            ]
          ]
        ])
      })
    })

    render(
      <WorktreePickerModal
        ticket={defaultTicket}
        projectId="proj-1"
        open={true}
        onOpenChange={() => {}}
      />
    )

    // "New worktree" is selected by default — trigger should show "develop"
    const trigger = screen.getByTestId('source-branch-trigger')
    expect(trigger).toHaveTextContent('develop')
  })

  test('source branch selector loads branches on open (New worktree is default)', async () => {
    render(
      <WorktreePickerModal
        ticket={defaultTicket}
        projectId="proj-1"
        open={true}
        onOpenChange={() => {}}
      />
    )

    // Since "New worktree" is selected by default, branches should load immediately
    await waitFor(() => {
      expect(mockGitOps.listBranchesWithStatus).toHaveBeenCalledWith('/test/my-project')
    })
  })

  test('selecting a branch updates the displayed branch name', async () => {
    render(
      <WorktreePickerModal
        ticket={defaultTicket}
        projectId="proj-1"
        open={true}
        onOpenChange={() => {}}
      />
    )

    // Click "New worktree" and wait for branches to load
    fireEvent.click(screen.getByTestId('worktree-item-new'))
    await waitFor(() => {
      expect(mockGitOps.listBranchesWithStatus).toHaveBeenCalled()
    })

    // Open the branch popover
    fireEvent.click(screen.getByTestId('source-branch-trigger'))

    // Select "feature-x"
    await waitFor(() => {
      expect(screen.getByTestId('source-branch-feature-x')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('source-branch-feature-x'))

    // Trigger should now display "feature-x"
    const trigger = screen.getByTestId('source-branch-trigger')
    expect(trigger).toHaveTextContent('feature-x')
  })

  test('submitting with New worktree calls createFromBranch with selected branch', async () => {
    const onOpenChange = vi.fn()

    render(
      <WorktreePickerModal
        ticket={defaultTicket}
        projectId="proj-1"
        open={true}
        onOpenChange={onOpenChange}
      />
    )

    // Click "New worktree" and wait for branches to load
    fireEvent.click(screen.getByTestId('worktree-item-new'))
    await waitFor(() => {
      expect(mockGitOps.listBranchesWithStatus).toHaveBeenCalled()
    })

    // Open the branch popover and select "feature-x"
    fireEvent.click(screen.getByTestId('source-branch-trigger'))
    await waitFor(() => {
      expect(screen.getByTestId('source-branch-feature-x')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('source-branch-feature-x'))

    // Click send
    const sendBtn = screen.getByTestId('wt-picker-send-btn')
    await act(async () => {
      fireEvent.click(sendBtn)
    })

    // Should have called createFromBranch with the selected branch
    await waitFor(() => {
      expect(mockWorktreeOps.createFromBranch).toHaveBeenCalledWith({
        projectId: 'proj-1',
        projectPath: '/test/my-project',
        projectName: 'My Project',
        branchName: 'feature-x',
        nameHint: 'implement-auth-flow'
      })
    })
  })

  test('submitting with New worktree uses default branch when none selected', async () => {
    const onOpenChange = vi.fn()

    render(
      <WorktreePickerModal
        ticket={defaultTicket}
        projectId="proj-1"
        open={true}
        onOpenChange={onOpenChange}
      />
    )

    // Click "New worktree" (don't change branch)
    fireEvent.click(screen.getByTestId('worktree-item-new'))

    // Click send
    const sendBtn = screen.getByTestId('wt-picker-send-btn')
    await act(async () => {
      fireEvent.click(sendBtn)
    })

    // Should have called createFromBranch with the default branch "main"
    await waitFor(() => {
      expect(mockWorktreeOps.createFromBranch).toHaveBeenCalledWith({
        projectId: 'proj-1',
        projectPath: '/test/my-project',
        projectName: 'My Project',
        branchName: 'main',
        nameHint: 'implement-auth-flow'
      })
    })
  })

  describe('ticket-title worktree naming', () => {
    test('shows canonicalized ticket title preview by default (New worktree pre-selected)', () => {
      const ticket = makeTicket({ title: 'Add dark mode toggle' })

      render(
        <WorktreePickerModal
          ticket={ticket}
          projectId="proj-1"
          open={true}
          onOpenChange={vi.fn()}
        />
      )

      // "New worktree" is selected by default — preview should be visible immediately
      expect(screen.getByText('add-dark-mode-toggle')).toBeInTheDocument()
    })

    test('does not show preview when ticket title produces empty canonical name', () => {
      const ticket = makeTicket({ title: '🔥🚀💥' })

      render(
        <WorktreePickerModal
          ticket={ticket}
          projectId="proj-1"
          open={true}
          onOpenChange={vi.fn()}
        />
      )

      // "New worktree" is selected by default — "from" row should exist but no preview
      const fromRow = screen.getByText('from').closest('div')
      expect(fromRow).toBeInTheDocument()
      const previewSpans = fromRow?.querySelectorAll('.font-mono')
      expect(previewSpans?.length ?? 0).toBe(0)
    })

    test('passes nameHint to createFromBranch when creating new worktree', async () => {
      const ticket = makeTicket({ title: 'Fix login bug' })

      const onSendComplete = vi.fn()
      render(
        <WorktreePickerModal
          ticket={ticket}
          projectId="proj-1"
          open={true}
          onOpenChange={vi.fn()}
          onSendComplete={onSendComplete}
        />
      )

      // "New worktree" is already selected by default — click Send directly
      await act(async () => {
        fireEvent.click(screen.getByTestId('wt-picker-send-btn'))
      })

      // Verify createFromBranch was called with the nameHint
      await waitFor(() => {
        expect(mockWorktreeOps.createFromBranch).toHaveBeenCalledWith({
          projectId: 'proj-1',
          projectPath: '/test/my-project',
          projectName: 'My Project',
          branchName: 'main',
          nameHint: 'fix-login-bug'
        })
      })
    })

    test('sanitizes slash-heavy ticket titles before creating a worktree', async () => {
      const ticket = makeTicket({ title: 'Add keyboard shortcuts for playing/pausing and speed' })

      render(
        <WorktreePickerModal
          ticket={ticket}
          projectId="proj-1"
          open={true}
          onOpenChange={vi.fn()}
        />
      )

      await act(async () => {
        fireEvent.click(screen.getByTestId('wt-picker-send-btn'))
      })

      await waitFor(() => {
        expect(mockWorktreeOps.createFromBranch).toHaveBeenCalledWith({
          projectId: 'proj-1',
          projectPath: '/test/my-project',
          projectName: 'My Project',
          branchName: 'main',
          nameHint: 'add-keyboard-shortcuts-for-playi'
        })
      })
    })
  })
})

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanTicketModal } from './KanbanTicketModal'
import { ClaudeCliSessionPortalProvider } from '@/contexts/ClaudeCliSessionPortalContext'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import type { KanbanTicket } from '../../../../main/db/types'

vi.mock('@/api/hive-enterprise/client', () => ({
  isHiveTelemetryEnabled: vi.fn(() => false),
  recordHivePromptStart: vi.fn(),
  recordHivePromptIdle: vi.fn(),
  recordHiveQuestionsAnswered: vi.fn()
}))

vi.mock('@/components/terminal/TerminalView', () => ({
  TerminalView: () => <div data-testid="mock-terminal-view" />
}))

vi.mock('../sessions/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>
}))

vi.mock('./FollowupInput', () => ({
  FollowupInput: () => <div data-testid="followup-input" />
}))

vi.mock('./TicketRunButton', () => ({
  TicketRunButton: () => null
}))

vi.mock('@/hooks/useTicketRunScript', () => ({
  useTicketRunScript: () => ({ hasRunScript: false }),
  useTicketRunScriptHotkey: vi.fn()
}))

vi.mock('@/hooks/useDropZone', () => ({
  useDropZone: () => ({ isDragging: false })
}))

vi.mock('@/hooks/useConflictFixFlow', () => ({
  useConflictFixFlow: () => ({ startFixFlow: vi.fn(), openAttachedSession: vi.fn() })
}))

vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn()
  }
}))

vi.mock('@/api/remote-launch-api', () => ({
  remoteLaunchApi: { stop: vi.fn() },
  remoteTargetFromUrl: vi.fn()
}))

const dbApiMocks = vi.hoisted(() => ({
  session: {
    get: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue({ success: true, value: undefined })
  },
  worktree: {
    get: vi.fn().mockResolvedValue(null),
    getActiveByProject: vi.fn().mockResolvedValue([])
  },
  setting: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined)
  }
}))

vi.mock('@/api/db-api', () => ({
  dbApi: dbApiMocks
}))

vi.mock('@/api/git-api', () => ({
  gitApi: {
    listBranchesWithStatus: vi.fn().mockResolvedValue({ success: true, branches: [] })
  }
}))

const now = '2026-01-01T00:00:00.000Z'

const ticket: KanbanTicket = {
  id: 'ticket-1',
  project_id: 'project-1',
  title: 'Keyed ticket',
  description: null,
  attachments: [],
  column: 'todo',
  sort_order: 0,
  current_session_id: null,
  worktree_id: null,
  mode: null,
  plan_ready: false,
  created_at: now,
  updated_at: now,
  column_changed_at: null,
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
  created_from_session: false,
  auto_approve_plan: false,
  unread: false,
  awaiting_completion: false,
  model_provider_id: null,
  model_id: null,
  model_variant: null,
  variant_group_id: null,
  ticket_prefix: 'TD',
  ticket_number: 12,
  parent_ticket_id: null,
  parent_ticket_key: null
}

const initialSettingsState = useSettingsStore.getState()
const initialSessionState = useSessionStore.getState()
const initialWorktreeState = useWorktreeStore.getState()
const initialKanbanState = useKanbanStore.getState()
const initialProjectState = useProjectStore.getState()
const initialWorktreeStatusState = useWorktreeStatusStore.getState()

function setupStores(selected: KanbanTicket): void {
  useSettingsStore.setState({
    availableAgentSdks: { opencode: true, claude: true, codex: true },
    defaultAgentSdk: 'opencode',
    selectedModel: null,
    selectedModelByProvider: {},
    defaultModels: null,
    boardMode: 'toggle'
  })
  useProjectStore.setState({
    selectedProjectId: 'project-1',
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
        created_at: now,
        last_accessed_at: now
      }
    ]
  })
  useWorktreeStore.setState({
    selectedWorktreeId: null,
    worktreesByProject: new Map([['project-1', []]]),
    selectWorktree: vi.fn()
  })
  useKanbanStore.setState({
    selectedTicketId: selected.id,
    selectedTicketRef: { projectId: selected.project_id, ticketId: selected.id },
    isBoardViewActive: true,
    tickets: new Map([['project-1', [selected]]]),
    updateTicket: vi.fn(async () => undefined),
    moveTicket: vi.fn(async () => undefined),
    deleteTicket: vi.fn(async () => undefined)
  })
  useSessionStore.setState({
    activeSessionId: null,
    activeWorktreeId: null,
    sessionsByWorktree: new Map(),
    sessionsByConnection: new Map(),
    pendingPlans: new Map(),
    hydrateSession: vi.fn(),
    loadSessions: vi.fn(async () => undefined),
    requestSessionMount: vi.fn(),
    releaseSessionMount: vi.fn(),
    setActiveSession: vi.fn(),
    setActiveWorktree: vi.fn()
  })
  useWorktreeStatusStore.setState({
    sessionStatuses: {},
    clearSessionStatus: vi.fn()
  })
}

function renderModal(): void {
  render(
    <ClaudeCliSessionPortalProvider>
      <KanbanTicketModal />
    </ClaudeCliSessionPortalProvider>
  )
}

describe('KanbanTicketModal ticket key', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
    useSettingsStore.setState(initialSettingsState, true)
    useSessionStore.setState(initialSessionState, true)
    useWorktreeStore.setState(initialWorktreeState, true)
    useKanbanStore.setState(initialKanbanState, true)
    useProjectStore.setState(initialProjectState, true)
    useWorktreeStatusStore.setState(initialWorktreeStatusState, true)
  })

  it('shows the key next to the "Edit Ticket" header', async () => {
    setupStores(ticket)
    renderModal()

    await screen.findByTestId('kanban-ticket-modal')
    const key = screen.getByTestId('ticket-key')
    expect(key).toHaveTextContent('TD-12')
    expect(key).toHaveAttribute('title', 'Ticket TD-12')
    expect(screen.getByText('Edit Ticket')).toBeInTheDocument()
  })

  it('shows the parent run key for an orchestrator child', async () => {
    setupStores({ ...ticket, parent_ticket_id: 'run-ticket', parent_ticket_key: 'TD-7' })
    renderModal()

    await screen.findByTestId('kanban-ticket-modal')
    expect(screen.getByTestId('ticket-parent-key')).toHaveTextContent('TD-7')
    expect(screen.getByTestId('ticket-key')).toHaveTextContent('TD-12')
  })

  it('shows the key in the review-mode title', async () => {
    setupStores({ ...ticket, column: 'review' })
    renderModal()

    await screen.findByTestId('kanban-ticket-modal')
    expect(screen.getByTestId('ticket-key')).toHaveTextContent('TD-12')
    expect(screen.getByText('Keyed ticket')).toBeInTheDocument()
  })

  it('renders no key for a ticket without one', async () => {
    setupStores({ ...ticket, ticket_prefix: null, ticket_number: null })
    renderModal()

    await screen.findByTestId('kanban-ticket-modal')
    expect(screen.queryByTestId('ticket-key')).toBeNull()
    expect(screen.getByText('Edit Ticket')).toBeInTheDocument()
  })
})

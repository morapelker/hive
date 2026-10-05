import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanTicketModal } from './KanbanTicketModal'
import { ClaudeCliSessionPortalProvider } from '@/contexts/ClaudeCliSessionPortalContext'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useRemoteLaunchStore } from '@/stores/useRemoteLaunchStore'
import { useShellCommandRunStore } from '@/stores/useShellCommandRunStore'
import type { SessionShellCommand } from '@shared/lib/shell-commands'
import type { KanbanTicket, Session, Worktree } from '../../../../main/db/types'

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
    warning: vi.fn()
  }
}))

const terminalApiMocks = vi.hoisted(() => ({
  createClaudeCli: vi.fn().mockResolvedValue({ success: true, value: { success: true } }),
  onClaudeSessionId: vi.fn().mockReturnValue(() => {})
}))

vi.mock('@/api/terminal-api', () => ({
  terminalApi: terminalApiMocks
}))

const opencodeApiMocks = vi.hoisted(() => ({
  abort: vi.fn().mockResolvedValue({ success: true, value: { success: true } }),
  commands: vi.fn().mockResolvedValue({ success: true, value: { success: true, commands: [] } }),
  listModels: vi.fn().mockResolvedValue({ success: true, value: { success: true, providers: [] } })
}))

vi.mock('@/api/opencode-api', () => ({
  opencodeApi: opencodeApiMocks
}))

const now = '2026-01-01T00:00:00.000Z'

const run: SessionShellCommand = {
  commandId: 'cmd-1',
  name: 'Build',
  script: 'make',
  detached: false,
  state: 'succeeded',
  runId: 'run-1',
  exitCode: 0,
  signal: null,
  reason: null,
  error: null,
  startedAt: now,
  finishedAt: now
}

const shellSession: Session = {
  id: 'session-1',
  worktree_id: 'worktree-1',
  project_id: 'project-1',
  connection_id: null,
  name: 'Build',
  status: 'active',
  opencode_session_id: null,
  claude_session_id: null,
  agent_sdk: 'terminal',
  mode: 'build',
  session_type: 'shell-command',
  shell_command: JSON.stringify(run),
  model_provider_id: null,
  model_id: null,
  model_variant: null,
  remote_launch: null,
  created_at: now,
  updated_at: now,
  completed_at: null,
  pinned_to_board: false
}

// An agent session of the same ticket shape: it must keep the regular layouts.
const agentSession: Session = {
  ...shellSession,
  name: 'Agent',
  agent_sdk: 'claude-code-cli',
  session_type: 'default',
  shell_command: null
}

const dbApiMocks = vi.hoisted(() => ({
  session: {
    get: vi.fn(),
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

const gitApiMocks = vi.hoisted(() => ({
  listBranchesWithStatus: vi.fn().mockResolvedValue({ success: true, branches: [] })
}))

vi.mock('@/api/git-api', () => ({
  gitApi: gitApiMocks
}))

const baseTicket: KanbanTicket = {
  id: 'ticket-1',
  project_id: 'project-1',
  title: 'Build',
  description: null,
  attachments: [],
  column: 'in_progress',
  sort_order: 0,
  current_session_id: 'session-1',
  worktree_id: 'worktree-1',
  mode: 'build',
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
  variant_group_id: null
}

const worktree: Worktree = {
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
  pinned: 0,
  context: null,
  github_pr_number: null,
  github_pr_url: null,
  base_branch: null,
  created_at: now,
  last_accessed_at: now
}

const initialSettingsState = useSettingsStore.getState()
const initialSessionState = useSessionStore.getState()
const initialWorktreeState = useWorktreeStore.getState()
const initialKanbanState = useKanbanStore.getState()
const initialProjectState = useProjectStore.getState()
const initialWorktreeStatusState = useWorktreeStatusStore.getState()
const initialRemoteLaunchState = useRemoteLaunchStore.getState()
const initialRunState = useShellCommandRunStore.getState()

function setupStores(ticket: KanbanTicket, runs: Record<string, SessionShellCommand>): void {
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
    worktreesByProject: new Map([['project-1', [worktree]]]),
    selectWorktree: vi.fn()
  })
  useKanbanStore.setState({
    selectedTicketId: ticket.id,
    selectedTicketRef: { projectId: ticket.project_id, ticketId: ticket.id },
    isBoardViewActive: true,
    tickets: new Map([['project-1', [ticket]]]),
    updateTicket: vi.fn(async () => undefined),
    moveTicket: vi.fn(async () => undefined),
    deleteTicket: vi.fn(async () => undefined),
    relinkTicketsForHandoff: vi.fn(async () => undefined)
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
  useRemoteLaunchStore.setState({
    remoteBySessionId: {},
    ensureLoaded: vi.fn(async () => undefined),
    setRemoteInfo: vi.fn()
  })
  useShellCommandRunStore.setState({ runsBySession: runs, loaded: true })
}

function renderModal(): void {
  render(
    <ClaudeCliSessionPortalProvider>
      <KanbanTicketModal />
    </ClaudeCliSessionPortalProvider>
  )
}

function hasSpinner(): boolean {
  return screen.getByTestId('kanban-ticket-modal').querySelector('.animate-spin') !== null
}

describe('KanbanTicketModal shell-command tickets', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dbApiMocks.session.get.mockResolvedValue(shellSession)
    dbApiMocks.worktree.get.mockResolvedValue(worktree)
    dbApiMocks.worktree.getActiveByProject.mockResolvedValue([])
    dbApiMocks.setting.get.mockResolvedValue(null)
    dbApiMocks.setting.set.mockResolvedValue(undefined)
    gitApiMocks.listBranchesWithStatus.mockResolvedValue({ success: true, branches: [] })
  })

  afterEach(() => {
    cleanup()
    useSettingsStore.setState(initialSettingsState, true)
    useSessionStore.setState(initialSessionState, true)
    useWorktreeStore.setState(initialWorktreeState, true)
    useKanbanStore.setState(initialKanbanState, true)
    useProjectStore.setState(initialProjectState, true)
    useWorktreeStatusStore.setState(initialWorktreeStatusState, true)
    useRemoteLaunchStore.setState(initialRemoteLaunchState, true)
    useShellCommandRunStore.setState(initialRunState, true)
  })

  // The session is deliberately NOT in the session store: the run index alone must
  // route the ticket to the terminal pane, on the first render.
  it.each(['in_progress', 'review', 'done'] as const)(
    'renders the full-width terminal layout for a shell-command ticket in %s',
    async (column) => {
      setupStores({ ...baseTicket, column }, { 'session-1': run })

      renderModal()

      expect(screen.getByTestId('claude-cli-modal-slot')).toBeInTheDocument()
      expect(screen.getByTestId('go-to-session-btn')).toBeInTheDocument()
      expect(hasSpinner()).toBe(false)
      expect(screen.queryByTestId('followup-input')).not.toBeInTheDocument()
      expect(useSessionStore.getState().requestSessionMount).toHaveBeenCalledWith('session-1')

      // Still the terminal pane once the async session lookup has settled
      await waitFor(() => expect(dbApiMocks.session.get).toHaveBeenCalled())
      expect(screen.getByTestId('claude-cli-modal-slot')).toBeInTheDocument()
      expect(hasSpinner()).toBe(false)
    }
  )

  it('routes by the session row when the run index does not know the session yet', async () => {
    setupStores({ ...baseTicket, column: 'review' }, {})
    useSessionStore.setState({
      sessionsByWorktree: new Map([['worktree-1', [shellSession]]])
    } as never)

    renderModal()

    expect(await screen.findByTestId('claude-cli-modal-slot')).toBeInTheDocument()
    expect(screen.queryByTestId('followup-input')).not.toBeInTheDocument()
  })

  it('keeps the dual-pane review layout for a non-shell ticket in review', async () => {
    dbApiMocks.session.get.mockResolvedValue(agentSession)
    setupStores({ ...baseTicket, column: 'review' }, {})

    renderModal()

    // Dual pane: the review pane on the left, the session on the right
    expect(await screen.findByTestId('followup-input')).toBeInTheDocument()
    expect(await screen.findByTestId('claude-cli-modal-slot')).toBeInTheDocument()
    expect(screen.queryByTestId('go-to-session-btn')).not.toBeInTheDocument()
  })

  it('does not treat an agent ticket as a shell command because of other runs', async () => {
    dbApiMocks.session.get.mockResolvedValue(agentSession)
    setupStores({ ...baseTicket, column: 'review' }, { 'another-session': run })

    renderModal()

    expect(await screen.findByTestId('followup-input')).toBeInTheDocument()
    expect(screen.queryByTestId('go-to-session-btn')).not.toBeInTheDocument()
  })
})

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanTicketModal } from './KanbanTicketModal'
import { ClaudeCliSessionPortalProvider } from '@/contexts/ClaudeCliSessionPortalContext'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useRemoteLaunchStore } from '@/stores/useRemoteLaunchStore'
import { useShellCommandRunStore } from '@/stores/useShellCommandRunStore'
import { toast } from '@/lib/toast'
import { SHELL_COMMAND_TICKET_PROVIDER, type SessionShellCommand } from '@shared/lib/shell-commands'
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

// The two ways Save & Send can start a To Do ticket: an agent launch, or the command
const quickLaunchMocks = vi.hoisted(() => ({
  quickLaunchTicket: vi.fn().mockResolvedValue(true),
  quickLaunchTicketOnConnection: vi.fn().mockResolvedValue(true)
}))

vi.mock('./WorktreePickerModal', () => quickLaunchMocks)

const shellTicketMocks = vi.hoisted(() => ({
  startShellCommandTicket: vi.fn().mockResolvedValue(true)
}))

vi.mock('@/lib/shell-command-ticket', async () => ({
  ...(await vi.importActual<typeof import('@/lib/shell-command-ticket')>(
    '@/lib/shell-command-ticket'
  )),
  startShellCommandTicket: shellTicketMocks.startShellCommandTicket
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

  describe('edit form of a To Do ticket', () => {
    const initialConnectionState = useConnectionStore.getState()

    // A plain ticket waiting in To Do: no session, no worktree
    const plainTodoTicket: KanbanTicket = {
      ...baseTicket,
      title: 'Todo ticket',
      description: 'Original description',
      column: 'todo',
      current_session_id: null,
      worktree_id: null,
      mode: null
    }

    // A duplicated shell ticket: the marker is all that makes it a shell command
    const shellTodoTicket: KanbanTicket = {
      ...plainTodoTicket,
      title: 'Build',
      external_provider: SHELL_COMMAND_TICKET_PROVIDER,
      external_id: 'cmd-1'
    }

    function updateTicketMock(): ReturnType<typeof vi.fn> {
      return useKanbanStore.getState().updateTicket as ReturnType<typeof vi.fn>
    }

    beforeEach(() => {
      useConnectionStore.setState({ selectedConnectionId: null, connections: [] } as never)
    })

    afterEach(() => {
      useConnectionStore.setState(initialConnectionState, true)
    })

    it('reads Save & Run for a session-less shell-command ticket', async () => {
      setupStores(shellTodoTicket, {})
      renderModal()

      const sendBtn = await screen.findByTestId('ticket-edit-save-send-btn')
      expect(sendBtn).toHaveTextContent('Save & Run')
      expect(sendBtn).not.toHaveTextContent('Save & Send')
      expect(sendBtn).toHaveAttribute(
        'title',
        "Save the ticket and run its command now in the project's base worktree"
      )
      // An edit form, not the terminal pane of a running command
      expect(screen.queryByTestId('claude-cli-modal-slot')).not.toBeInTheDocument()
    })

    it('saves the edit, closes, then runs the command instead of launching an agent', async () => {
      setupStores(shellTodoTicket, {})
      renderModal()

      const sendBtn = await screen.findByTestId('ticket-edit-save-send-btn')
      fireEvent.change(screen.getByDisplayValue('Build'), { target: { value: 'Build twice' } })
      fireEvent.click(sendBtn)

      await waitFor(() => expect(shellTicketMocks.startShellCommandTicket).toHaveBeenCalledTimes(1))
      const updateTicket = updateTicketMock()
      expect(updateTicket).toHaveBeenCalledTimes(1)
      expect(updateTicket).toHaveBeenCalledWith(
        'ticket-1',
        'project-1',
        expect.objectContaining({ title: 'Build twice', description: 'Original description' })
      )
      // Saved first: the run must not start from a ticket that failed to save
      expect(updateTicket.mock.invocationCallOrder[0]).toBeLessThan(
        shellTicketMocks.startShellCommandTicket.mock.invocationCallOrder[0]
      )
      // The saved ticket, marker included; no sort order: the run puts it on top of In Progress
      expect(shellTicketMocks.startShellCommandTicket).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'ticket-1',
          project_id: 'project-1',
          title: 'Build twice',
          current_session_id: null,
          external_provider: SHELL_COMMAND_TICKET_PROVIDER,
          external_id: 'cmd-1'
        })
      )
      expect(quickLaunchMocks.quickLaunchTicket).not.toHaveBeenCalled()
      expect(quickLaunchMocks.quickLaunchTicketOnConnection).not.toHaveBeenCalled()
      // Modal closed (selection cleared)
      expect(useKanbanStore.getState().selectedTicketRef).toBeNull()
    })

    it('runs the command on Cmd+Shift+Enter as well', async () => {
      setupStores(shellTodoTicket, {})
      renderModal()

      const titleInput = await screen.findByDisplayValue('Build')
      fireEvent.keyDown(titleInput, { key: 'Enter', ctrlKey: true, shiftKey: true })

      await waitFor(() => expect(shellTicketMocks.startShellCommandTicket).toHaveBeenCalledTimes(1))
      expect(updateTicketMock()).toHaveBeenCalledTimes(1)
      expect(quickLaunchMocks.quickLaunchTicket).not.toHaveBeenCalled()
    })

    it('runs the command on a connection board too, never the connection launcher', async () => {
      setupStores(shellTodoTicket, {})
      useConnectionStore.setState({ selectedConnectionId: 'conn-1' } as never)
      renderModal()

      fireEvent.click(await screen.findByTestId('ticket-edit-save-send-btn'))

      await waitFor(() => expect(shellTicketMocks.startShellCommandTicket).toHaveBeenCalledTimes(1))
      expect(quickLaunchMocks.quickLaunchTicketOnConnection).not.toHaveBeenCalled()
      expect(quickLaunchMocks.quickLaunchTicket).not.toHaveBeenCalled()
    })

    it('only saves on Save: the command does not run', async () => {
      setupStores(shellTodoTicket, {})
      renderModal()

      fireEvent.click(await screen.findByTestId('ticket-edit-save-btn'))

      await waitFor(() => expect(useKanbanStore.getState().selectedTicketRef).toBeNull())
      expect(updateTicketMock()).toHaveBeenCalledTimes(1)
      expect(shellTicketMocks.startShellCommandTicket).not.toHaveBeenCalled()
      expect(quickLaunchMocks.quickLaunchTicket).not.toHaveBeenCalled()
    })

    it('does not run the command when the save fails', async () => {
      setupStores(shellTodoTicket, {})
      updateTicketMock().mockRejectedValueOnce(new Error('disk full'))
      renderModal()

      fireEvent.click(await screen.findByTestId('ticket-edit-save-send-btn'))

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to update ticket'))
      expect(shellTicketMocks.startShellCommandTicket).not.toHaveBeenCalled()
      // Still open, so the edit is not lost
      expect(useKanbanStore.getState().selectedTicketRef).not.toBeNull()
    })

    it('refuses to run a blocked shell-command ticket', async () => {
      const blocker: KanbanTicket = {
        ...plainTodoTicket,
        id: 'blocker-1',
        title: 'Blocker',
        column: 'in_progress'
      }
      setupStores(shellTodoTicket, {})
      useKanbanStore.setState({
        tickets: new Map([['project-1', [shellTodoTicket, blocker]]]),
        dependencyMap: new Map([['project-1:ticket-1', new Set(['project-1:blocker-1'])]]),
        simpleModeByProject: {}
      } as never)
      renderModal()

      fireEvent.click(await screen.findByTestId('ticket-edit-save-send-btn'))

      await waitFor(() =>
        expect(toast.warning).toHaveBeenCalledWith(
          'Ticket is blocked — resolve its dependencies first'
        )
      )
      expect(shellTicketMocks.startShellCommandTicket).not.toHaveBeenCalled()
      expect(updateTicketMock()).not.toHaveBeenCalled()
    })

    // Another session being a shell command says nothing about this ticket
    it.each([
      ['a plain ticket', plainTodoTicket],
      [
        'a ticket from another external source',
        { ...plainTodoTicket, external_provider: 'github', external_id: '42' }
      ],
      [
        'a marker without a command id',
        { ...shellTodoTicket, title: 'Todo ticket', external_id: null }
      ]
    ] as const)('keeps Save & Send and the agent launch for %s', async (_label, ticket) => {
      setupStores(ticket, { 'another-session': run })
      renderModal()

      const sendBtn = await screen.findByTestId('ticket-edit-save-send-btn')
      expect(sendBtn).toHaveTextContent('Save & Send')
      expect(sendBtn).not.toHaveTextContent('Save & Run')
      expect(sendBtn).toHaveAttribute(
        'title',
        'Save the ticket and start it now with the default launch settings'
      )

      fireEvent.change(screen.getByDisplayValue('Todo ticket'), {
        target: { value: 'Edited title' }
      })
      fireEvent.click(sendBtn)

      await waitFor(() => expect(quickLaunchMocks.quickLaunchTicket).toHaveBeenCalledTimes(1))
      expect(updateTicketMock()).toHaveBeenCalledWith(
        'ticket-1',
        'project-1',
        expect.objectContaining({ title: 'Edited title' })
      )
      expect(quickLaunchMocks.quickLaunchTicket).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'ticket-1', title: 'Edited title' })
      )
      expect(shellTicketMocks.startShellCommandTicket).not.toHaveBeenCalled()
    })
  })
})

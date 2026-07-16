import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
import { toast } from '@/lib/toast'
import type { RemoteLaunchClientInfo, RemoteLaunchKillResult } from '@shared/types/remote-launch'
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

const stopMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/remote-launch-api', () => ({
  remoteLaunchApi: { stop: stopMock },
  remoteTargetFromUrl: vi.fn()
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

const remoteInfo: RemoteLaunchClientInfo = {
  role: 'client',
  url: 'https://remote.example.com',
  remoteSessionId: 'remote-session-1',
  remoteWorktreeId: 'remote-worktree-1',
  remoteProjectId: 'remote-project-1',
  tmuxSession: 'hive-launch-1',
  branch: 'feature/x',
  worktreePath: '/remote/worktree',
  launchedAt: now
}

const remoteSession: Session = {
  id: 'session-1',
  worktree_id: null,
  project_id: 'project-1',
  connection_id: null,
  name: 'Remote Claude CLI',
  status: 'active',
  opencode_session_id: null,
  claude_session_id: null,
  agent_sdk: 'claude-code-cli',
  mode: 'build',
  session_type: 'default',
  model_provider_id: 'anthropic',
  model_id: 'opus',
  model_variant: 'high',
  remote_launch: JSON.stringify(remoteInfo),
  created_at: now,
  updated_at: now,
  completed_at: null,
  pinned_to_board: false
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

const remoteTicket: KanbanTicket = {
  id: 'ticket-1',
  project_id: 'project-1',
  title: 'Remote ticket',
  description: null,
  attachments: [],
  column: 'in_progress',
  sort_order: 0,
  current_session_id: 'session-1',
  worktree_id: null,
  mode: 'build',
  plan_ready: false,
  created_at: now,
  updated_at: now,
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

function setupStores(): {
  updateTicket: ReturnType<typeof vi.fn>
} {
  const updateTicket = vi.fn(async () => undefined)

  useSettingsStore.setState({
    availableAgentSdks: { opencode: true, claude: true, codex: true, grok: false },
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
    selectedTicketId: remoteTicket.id,
    selectedTicketRef: { projectId: remoteTicket.project_id, ticketId: remoteTicket.id },
    isBoardViewActive: true,
    tickets: new Map([['project-1', [remoteTicket]]]),
    updateTicket,
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
    remoteBySessionId: { 'session-1': remoteInfo },
    ensureLoaded: vi.fn(async () => undefined),
    setRemoteInfo: vi.fn()
  })

  return { updateTicket }
}

describe('KanbanTicketModal remote launch actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dbApiMocks.session.get.mockResolvedValue(remoteSession)
    dbApiMocks.worktree.get.mockResolvedValue(null)
    dbApiMocks.worktree.getActiveByProject.mockResolvedValue([])
    dbApiMocks.setting.get.mockResolvedValue(null)
    dbApiMocks.setting.set.mockResolvedValue(undefined)
    gitApiMocks.listBranchesWithStatus.mockResolvedValue({ success: true, branches: [] })
    terminalApiMocks.createClaudeCli.mockResolvedValue({ success: true, value: { success: true } })
    terminalApiMocks.onClaudeSessionId.mockReturnValue(() => {})
    stopMock.mockReset()
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
  })

  it('shows "Remote terminal" and "Stop remote" actions for a remote-launched ticket (no worktree, client-role session info)', async () => {
    setupStores()

    render(
      <ClaudeCliSessionPortalProvider>
        <KanbanTicketModal />
      </ClaudeCliSessionPortalProvider>
    )

    expect(await screen.findByTestId('ticket-modal-remote-terminal-btn')).toBeInTheDocument()
    expect(screen.getByTestId('ticket-modal-stop-remote-btn')).toBeInTheDocument()
  })

  it('does not show remote actions for a local ticket with an assigned worktree', async () => {
    setupStores()
    useKanbanStore.setState({
      tickets: new Map([['project-1', [{ ...remoteTicket, worktree_id: 'worktree-1' }]]])
    })
    dbApiMocks.session.get.mockResolvedValue({ ...remoteSession, worktree_id: 'worktree-1' })

    render(
      <ClaudeCliSessionPortalProvider>
        <KanbanTicketModal />
      </ClaudeCliSessionPortalProvider>
    )

    // Give the async session-hydration effect a tick to settle before asserting absence.
    await screen.findByTestId('kanban-ticket-modal')
    await waitFor(() => {
      expect(screen.queryByTestId('ticket-modal-remote-terminal-btn')).not.toBeInTheDocument()
    })
  })

  it('stops the remote session through confirm -> remoteLaunchApi.stop, and toasts success on kill', async () => {
    setupStores()
    stopMock.mockResolvedValue({ killed: true, alreadyDead: false } satisfies RemoteLaunchKillResult)
    const user = userEvent.setup()

    render(
      <ClaudeCliSessionPortalProvider>
        <KanbanTicketModal />
      </ClaudeCliSessionPortalProvider>
    )

    await user.click(await screen.findByTestId('ticket-modal-stop-remote-btn'))
    expect(await screen.findByTestId('ticket-modal-stop-remote-confirm-dialog')).toBeInTheDocument()

    await user.click(screen.getByTestId('ticket-modal-stop-remote-confirm-btn'))

    await waitFor(() => expect(stopMock).toHaveBeenCalledWith({ sessionId: 'session-1' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Remote session stopped'))
  })

  it('does not call remoteLaunchApi.stop without confirmation (Cancel dismisses the dialog)', async () => {
    setupStores()
    const user = userEvent.setup()

    render(
      <ClaudeCliSessionPortalProvider>
        <KanbanTicketModal />
      </ClaudeCliSessionPortalProvider>
    )

    await user.click(await screen.findByTestId('ticket-modal-stop-remote-btn'))
    await user.click(screen.getByTestId('ticket-modal-stop-remote-cancel-btn'))

    expect(stopMock).not.toHaveBeenCalled()
  })

  it('toasts the already-stopped message when the remote tmux session was already dead', async () => {
    setupStores()
    stopMock.mockResolvedValue({ killed: false, alreadyDead: true } satisfies RemoteLaunchKillResult)
    const user = userEvent.setup()

    render(
      <ClaudeCliSessionPortalProvider>
        <KanbanTicketModal />
      </ClaudeCliSessionPortalProvider>
    )

    await user.click(await screen.findByTestId('ticket-modal-stop-remote-btn'))
    await user.click(screen.getByTestId('ticket-modal-stop-remote-confirm-btn'))

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Remote session was already stopped')
    )
  })
})

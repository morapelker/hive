import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
import { useConnectionStore } from '@/stores/useConnectionStore'
import { toast } from '@/lib/toast'
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

vi.mock('@/hooks/useLifecycleActions', () => ({
  useLifecycleActions: () => ({
    hasAttachedPR: false,
    attachedPR: null,
    isGitHub: false,
    loadPRState: vi.fn(),
    openPRInBrowser: vi.fn(),
    createCodeReview: vi.fn()
  })
}))

vi.mock('@/hooks/usePinAndActivateSession', () => ({
  usePinAndActivateSession: () => ({ pinAndActivate: vi.fn(), lifecycleLoading: false })
}))

const quickLaunchMocks = vi.hoisted(() => ({
  quickLaunchTicket: vi.fn().mockResolvedValue(true),
  quickLaunchTicketOnConnection: vi.fn().mockResolvedValue(true)
}))

vi.mock('./WorktreePickerModal', () => quickLaunchMocks)

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
  listBranchesWithStatus: vi.fn().mockResolvedValue({ success: true, branches: [] }),
  getBranchDiffFiles: vi.fn().mockResolvedValue({ success: true, files: [] }),
  onStatusChanged: vi.fn().mockReturnValue(() => {})
}))

vi.mock('@/api/git-api', () => ({
  gitApi: gitApiMocks
}))

const now = '2026-01-01T00:00:00.000Z'

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

function makeSession(agentSdk: Session['agent_sdk']): Session {
  return {
    id: 'session-1',
    worktree_id: 'worktree-1',
    project_id: 'project-1',
    connection_id: null,
    name: 'Review session',
    status: 'active',
    opencode_session_id: null,
    claude_session_id: null,
    agent_sdk: agentSdk,
    mode: 'build',
    session_type: 'default',
    model_provider_id: 'anthropic',
    model_id: 'opus',
    model_variant: 'high',
    remote_launch: null,
    created_at: now,
    updated_at: now,
    completed_at: null,
    pinned_to_board: false
  }
}

const todoTicket: KanbanTicket = {
  id: 'ticket-1',
  project_id: 'project-1',
  title: 'Todo ticket',
  description: 'Original description',
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
  model_provider_id: null,
  model_id: null,
  model_variant: null,
  variant_group_id: null
}

const initialSettingsState = useSettingsStore.getState()
const initialSessionState = useSessionStore.getState()
const initialWorktreeState = useWorktreeStore.getState()
const initialKanbanState = useKanbanStore.getState()
const initialProjectState = useProjectStore.getState()
const initialWorktreeStatusState = useWorktreeStatusStore.getState()
const initialRemoteLaunchState = useRemoteLaunchStore.getState()

function setupStores(session: Session, ticket: KanbanTicket = todoTicket): void {
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
    isPinnedBoardActive: false,
    tickets: new Map([['project-1', [ticket]]]),
    updateTicket: vi.fn(async () => undefined),
    moveTicket: vi.fn(async () => undefined),
    deleteTicket: vi.fn(async () => undefined),
    relinkTicketsForHandoff: vi.fn(async () => undefined)
  })
  useSessionStore.setState({
    activeSessionId: null,
    activeWorktreeId: null,
    sessionsByWorktree: new Map([['worktree-1', [session]]]),
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
}

function renderModal(): void {
  render(
    <ClaudeCliSessionPortalProvider>
      <KanbanTicketModal />
    </ClaudeCliSessionPortalProvider>
  )
}

describe('KanbanTicketModal edit mode — Save & Send', () => {
  const initialConnectionState = useConnectionStore.getState()

  beforeEach(() => {
    vi.clearAllMocks()
    dbApiMocks.worktree.get.mockResolvedValue(null)
    dbApiMocks.worktree.getActiveByProject.mockResolvedValue([])
    dbApiMocks.setting.get.mockResolvedValue(null)
    dbApiMocks.setting.set.mockResolvedValue(undefined)
    gitApiMocks.listBranchesWithStatus.mockResolvedValue({ success: true, branches: [] })
    gitApiMocks.getBranchDiffFiles.mockResolvedValue({ success: true, files: [] })
    gitApiMocks.onStatusChanged.mockReturnValue(() => {})
    quickLaunchMocks.quickLaunchTicket.mockResolvedValue(true)
    quickLaunchMocks.quickLaunchTicketOnConnection.mockResolvedValue(true)
    useConnectionStore.setState({ selectedConnectionId: null, connections: [] } as never)
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
    useConnectionStore.setState(initialConnectionState, true)
  })

  it('shows Save & Send with shortcut hints for To Do tickets', async () => {
    setupStores(makeSession('opencode'))
    renderModal()

    const sendBtn = await screen.findByTestId('ticket-edit-save-send-btn')
    const saveBtn = screen.getByTestId('ticket-edit-save-btn')
    expect(sendBtn.querySelector('kbd')?.textContent).toMatch(/⇧|Shift/)
    expect(saveBtn.querySelector('kbd')?.textContent).toMatch(/↵|Enter/)
    expect(saveBtn.querySelector('kbd')?.textContent).not.toMatch(/⇧|Shift/)
  })

  it('hides Save & Send for tickets that are not in To Do', async () => {
    setupStores(makeSession('opencode'), { ...todoTicket, column: 'done' })
    renderModal()

    await screen.findByTestId('ticket-edit-save-btn')
    expect(screen.queryByTestId('ticket-edit-save-send-btn')).toBeNull()
  })

  it('saves the edited content, closes, then quick-launches with the saved content', async () => {
    setupStores(makeSession('opencode'))
    renderModal()

    const sendBtn = await screen.findByTestId('ticket-edit-save-send-btn')
    const titleInput = screen.getByDisplayValue('Todo ticket')
    fireEvent.change(titleInput, { target: { value: 'Edited title' } })
    fireEvent.click(sendBtn)

    const updateTicket = useKanbanStore.getState().updateTicket as ReturnType<typeof vi.fn>
    await waitFor(() => expect(quickLaunchMocks.quickLaunchTicket).toHaveBeenCalledTimes(1))
    expect(updateTicket).toHaveBeenCalledWith(
      'ticket-1',
      'project-1',
      expect.objectContaining({ title: 'Edited title', description: 'Original description' })
    )
    const launched = quickLaunchMocks.quickLaunchTicket.mock.calls[0][0] as KanbanTicket
    expect(launched.id).toBe('ticket-1')
    expect(launched.title).toBe('Edited title')
    expect(quickLaunchMocks.quickLaunchTicketOnConnection).not.toHaveBeenCalled()
    // Modal closed (selection cleared)
    expect(useKanbanStore.getState().selectedTicketRef).toBeNull()
  })

  it('routes to the connection launcher when a connection board is showing', async () => {
    setupStores(makeSession('opencode'))
    useConnectionStore.setState({ selectedConnectionId: 'conn-1' } as never)
    renderModal()

    fireEvent.click(await screen.findByTestId('ticket-edit-save-send-btn'))

    await waitFor(() =>
      expect(quickLaunchMocks.quickLaunchTicketOnConnection).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'ticket-1' }),
        'conn-1'
      )
    )
    expect(quickLaunchMocks.quickLaunchTicket).not.toHaveBeenCalled()
  })

  it('Cmd+Enter saves only; Cmd+Shift+Enter saves and sends', async () => {
    setupStores(makeSession('opencode'))
    renderModal()

    const titleInput = await screen.findByDisplayValue('Todo ticket')
    fireEvent.keyDown(titleInput, { key: 'Enter', metaKey: true })
    const updateTicket = useKanbanStore.getState().updateTicket as ReturnType<typeof vi.fn>
    await waitFor(() => expect(updateTicket).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(useKanbanStore.getState().selectedTicketRef).toBeNull())
    expect(quickLaunchMocks.quickLaunchTicket).not.toHaveBeenCalled()

    cleanup()
    vi.clearAllMocks()
    setupStores(makeSession('opencode'))
    renderModal()

    const titleInput2 = await screen.findByDisplayValue('Todo ticket')
    fireEvent.keyDown(titleInput2, { key: 'Enter', ctrlKey: true, shiftKey: true })
    await waitFor(() => expect(quickLaunchMocks.quickLaunchTicket).toHaveBeenCalledTimes(1))
    const updateTicket2 = useKanbanStore.getState().updateTicket as ReturnType<typeof vi.fn>
    expect(updateTicket2).toHaveBeenCalledTimes(1)
  })

  it('refuses to send a blocked ticket', async () => {
    const blocker: KanbanTicket = {
      ...todoTicket,
      id: 'blocker-1',
      title: 'Blocker',
      column: 'in_progress'
    }
    setupStores(makeSession('opencode'))
    useKanbanStore.setState({
      tickets: new Map([['project-1', [todoTicket, blocker]]]),
      dependencyMap: new Map([['project-1:ticket-1', new Set(['project-1:blocker-1'])]]),
      simpleModeByProject: {}
    } as never)
    renderModal()

    fireEvent.click(await screen.findByTestId('ticket-edit-save-send-btn'))

    await waitFor(() => expect(toast.warning).toHaveBeenCalled())
    expect(quickLaunchMocks.quickLaunchTicket).not.toHaveBeenCalled()
    expect(useKanbanStore.getState().updateTicket).not.toHaveBeenCalled()
  })
})

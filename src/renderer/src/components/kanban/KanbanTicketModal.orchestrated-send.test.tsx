/**
 * Save & Send on a ticket its run will launch (an orchestrator's, still waiting for its turn):
 * refused before anything is saved, so the edit stays in the form, and nothing is launched.
 * The same ticket once the run let it go launches as before (see save-and-send.test.tsx).
 */
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
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { makeDetail } from '@/components/document-flow/test-fixtures'
import { toast } from '@/lib/toast'
import type { KanbanTicket, Session, Worktree } from '../../../../main/db/types'

vi.mock('@/api/tedooo-code-enterprise/client', () => ({
  isTedoooCodeTelemetryEnabled: vi.fn(() => false),
  recordTedoooCodePromptStart: vi.fn(),
  recordTedoooCodePromptIdle: vi.fn(),
  recordTedoooCodeQuestionsAnswered: vi.fn()
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
  awaiting_completion: false,
  model_provider_id: null,
  model_id: null,
  model_variant: null,
  variant_group_id: null,
  ticket_prefix: null,
  ticket_number: null,
  parent_ticket_id: null,
  parent_ticket_key: null
}

const initialSettingsState = useSettingsStore.getState()
const initialSessionState = useSessionStore.getState()
const initialWorktreeState = useWorktreeStore.getState()
const initialKanbanState = useKanbanStore.getState()
const initialProjectState = useProjectStore.getState()
const initialWorktreeStatusState = useWorktreeStatusStore.getState()
const initialRemoteLaunchState = useRemoteLaunchStore.getState()
const initialFlowState = useDocumentFlowStore.getState()

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
        name: 'Tedooo Code',
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

describe('KanbanTicketModal Save & Send of a ticket its run will launch', () => {
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
    useDocumentFlowStore.setState(initialFlowState, true)
  })

  /** `ticket-1` as the item TD-7 of an orchestrator of project-1. */
  function seedRun(status: 'preview' | 'running' | 'completed'): void {
    useDocumentFlowStore.setState({
      runsById: {
        'run-1': makeDetail(
          {
            id: 'run-1',
            project_id: 'project-1',
            title: 'Checkout',
            source_kind: 'tickets',
            status
          },
          [{ key: 'TD-7', ticket_id: 'ticket-1', status: 'pending' }]
        )
      }
    })
  }

  it('refuses to send, before saving, while the run will launch it', async () => {
    setupStores(makeSession('opencode'))
    seedRun('running')
    renderModal()

    fireEvent.change(await screen.findByDisplayValue('Todo ticket'), {
      target: { value: 'Edited title' }
    })
    fireEvent.click(screen.getByTestId('ticket-edit-save-send-btn'))

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'TD-7 is part of the orchestrator “Checkout”: it launches when the run gets to it. Remove it from the orchestrator to launch it yourself.'
      )
    )
    expect(useKanbanStore.getState().updateTicket).not.toHaveBeenCalled()
    expect(quickLaunchMocks.quickLaunchTicket).not.toHaveBeenCalled()
    expect(quickLaunchMocks.quickLaunchTicketOnConnection).not.toHaveBeenCalled()
    // The form stays open with the edit
    expect(screen.getByDisplayValue('Edited title')).toBeInTheDocument()
  })

  it('still saves without sending', async () => {
    setupStores(makeSession('opencode'))
    seedRun('preview')
    renderModal()

    fireEvent.click(await screen.findByTestId('ticket-edit-save-btn'))

    await waitFor(() => expect(useKanbanStore.getState().updateTicket).toHaveBeenCalledTimes(1))
    expect(toast.error).not.toHaveBeenCalled()
    expect(quickLaunchMocks.quickLaunchTicket).not.toHaveBeenCalled()
  })

  it('sends once the run is over', async () => {
    setupStores(makeSession('opencode'))
    seedRun('completed')
    renderModal()

    fireEvent.click(await screen.findByTestId('ticket-edit-save-send-btn'))

    await waitFor(() => expect(quickLaunchMocks.quickLaunchTicket).toHaveBeenCalledTimes(1))
    expect(toast.error).not.toHaveBeenCalled()
  })
})

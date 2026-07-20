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

const reviewTicket: KanbanTicket = {
  id: 'ticket-1',
  project_id: 'project-1',
  title: 'Review ticket',
  description: null,
  attachments: [],
  column: 'review',
  sort_order: 0,
  current_session_id: 'session-1',
  worktree_id: 'worktree-1',
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

const initialSettingsState = useSettingsStore.getState()
const initialSessionState = useSessionStore.getState()
const initialWorktreeState = useWorktreeStore.getState()
const initialKanbanState = useKanbanStore.getState()
const initialProjectState = useProjectStore.getState()
const initialWorktreeStatusState = useWorktreeStatusStore.getState()
const initialRemoteLaunchState = useRemoteLaunchStore.getState()

function setupStores(session: Session): void {
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
    selectedTicketId: reviewTicket.id,
    selectedTicketRef: { projectId: reviewTicket.project_id, ticketId: reviewTicket.id },
    isBoardViewActive: true,
    tickets: new Map([['project-1', [reviewTicket]]]),
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

describe('KanbanTicketModal review mode Tab handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dbApiMocks.worktree.get.mockResolvedValue(null)
    dbApiMocks.worktree.getActiveByProject.mockResolvedValue([])
    dbApiMocks.setting.get.mockResolvedValue(null)
    dbApiMocks.setting.set.mockResolvedValue(undefined)
    gitApiMocks.listBranchesWithStatus.mockResolvedValue({ success: true, branches: [] })
    gitApiMocks.getBranchDiffFiles.mockResolvedValue({ success: true, files: [] })
    gitApiMocks.onStatusChanged.mockReturnValue(() => {})
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

  it('intercepts Tab to toggle build/plan and shows the mode chip for non-CLI sessions', async () => {
    const session = makeSession('opencode')
    dbApiMocks.session.get.mockResolvedValue(session)
    setupStores(session)

    renderModal()

    const textarea = await screen.findByTestId('review-followup-input')
    const chip = await screen.findByTestId('review-mode-toggle')
    expect(chip).toHaveAttribute('data-mode', 'build')

    textarea.focus()
    const notPrevented = fireEvent.keyDown(textarea, { key: 'Tab' })

    // fireEvent returns false when preventDefault was called — Tab is intercepted
    expect(notPrevented).toBe(false)
    expect(chip).toHaveAttribute('data-mode', 'plan')
  })

  it('leaves Tab/Shift+Tab alone and hides the mode chip for claude-cli sessions', async () => {
    const session = makeSession('claude-code-cli')
    dbApiMocks.session.get.mockResolvedValue(session)
    setupStores(session)

    renderModal()

    const textarea = await screen.findByTestId('review-followup-input')
    // Chip disappears once the session record resolves as claude-cli
    await waitFor(() => {
      expect(screen.queryByTestId('review-mode-toggle')).not.toBeInTheDocument()
    })

    textarea.focus()
    const tabNotPrevented = fireEvent.keyDown(textarea, { key: 'Tab' })
    const shiftTabNotPrevented = fireEvent.keyDown(textarea, { key: 'Tab', shiftKey: true })

    // Neither Tab nor Shift+Tab is intercepted — the terminal gets them
    expect(tabNotPrevented).toBe(true)
    expect(shiftTabNotPrevented).toBe(true)
  })
})

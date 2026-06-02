import { beforeEach, describe, expect, test, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { fireEvent, render, screen, waitFor } from '../utils/render'
import { KanbanTicketCard } from '@/components/kanban/KanbanTicketCard'
import { KanbanTicketModal } from '@/components/kanban/KanbanTicketModal'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useConflictFixFlow } from '@/hooks/useConflictFixFlow'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useGitStore } from '@/stores/useGitStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { usePinnedStore } from '@/stores/usePinnedStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useQuestionStore } from '@/stores/useQuestionStore'
import { useScriptStore } from '@/stores/useScriptStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import type { KanbanTicket } from '../../src/main/db/types'

vi.mock('@/components/kanban/WorktreePickerModal', () => ({
  WorktreePickerModal: () => null
}))

vi.mock('@/components/kanban/AttachPRPopover', () => ({
  AttachPRPopover: () => null
}))

vi.mock('@/components/kanban/UpdateStatusModal', () => ({
  UpdateStatusModal: () => null
}))

vi.mock('@/components/worktrees/PulseAnimation', () => ({
  PulseAnimation: () => null
}))

vi.mock('@/components/kanban/TicketRunButton', () => ({
  TicketRunButton: () => null
}))

vi.mock('@/hooks/useTicketRunScript', () => ({
  useTicketRunScript: () => ({
    isRunning: false,
    isConfigured: false,
    run: vi.fn()
  }),
  useTicketRunScriptHotkey: vi.fn()
}))

vi.mock('@/hooks/useSessionTimer', () => ({
  useSessionTimer: () => null
}))

vi.mock('@/hooks/useSessionTokenDelta', () => ({
  useSessionTokenDelta: () => null
}))

vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

const WORKTREE_PATH = '/tmp/proj-1/feature-auth'

const mockCreateSession = vi.fn()
const mockUpdateSessionName = vi.fn()
const mockSetPendingMessage = vi.fn()
const mockSetActiveSession = vi.fn()
const mockSetActiveWorktree = vi.fn()
const mockRefreshStatuses = vi.fn()

const mockDb = {
  project: {
    touch: vi.fn().mockResolvedValue(undefined)
  },
  worktree: {
    touch: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null)
  },
  session: {
    get: vi.fn().mockResolvedValue(null)
  }
}

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: 'proj-1',
    title: 'Resolve auth conflicts',
    description: null,
    attachments: [],
    column: 'todo',
    sort_order: 0,
    current_session_id: null,
    worktree_id: 'wt-1',
    mode: null,
    plan_ready: false,
    created_at: '2026-05-21T00:00:00.000Z',
    updated_at: '2026-05-21T00:00:00.000Z',
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
    ...overrides
  }
}

function seedStores(ticket = makeTicket()): void {
  useKanbanStore.setState({
    tickets: new Map([['proj-1', [ticket]]]),
    dependencyMap: new Map(),
    selectedTicketId: null,
    isBoardViewActive: true,
    isPinnedBoardActive: false
  })

  useProjectStore.setState({
    projects: [
      {
        id: 'proj-1',
        name: 'Project One',
        path: '/tmp/proj-1',
        description: null,
        tags: null,
        language: null,
        custom_icon: null,
        detected_icon: null,
        setup_script: null,
        run_script: null,
        archive_script: null,
        auto_assign_port: false,
        sort_order: 0,
        created_at: '2026-05-21T00:00:00.000Z',
        last_accessed_at: '2026-05-21T00:00:00.000Z'
      }
    ],
    selectedProjectId: 'proj-1'
  })

  useWorktreeStore.setState({
    selectedWorktreeId: null,
    worktreesByProject: new Map([
      [
        'proj-1',
        [
          {
            id: 'wt-1',
            project_id: 'proj-1',
            name: 'feature-auth',
            branch_name: 'feature-auth',
            path: WORKTREE_PATH,
            status: 'active',
            is_default: false,
            branch_renamed: 0,
            last_message_at: null,
            session_titles: '[]',
            last_model_provider_id: null,
            last_model_id: null,
            last_model_variant: null,
            created_at: '2026-05-21T00:00:00.000Z',
            last_accessed_at: '2026-05-21T00:00:00.000Z',
            github_pr_number: null,
            github_pr_url: null
          },
          {
            id: 'base-wt',
            project_id: 'proj-1',
            name: 'main',
            branch_name: 'main',
            path: '/tmp/proj-1/main',
            status: 'active',
            is_default: true,
            branch_renamed: 0,
            last_message_at: null,
            session_titles: '[]',
            last_model_provider_id: null,
            last_model_id: null,
            last_model_variant: null,
            created_at: '2026-05-21T00:00:00.000Z',
            last_accessed_at: '2026-05-21T00:00:00.000Z',
            github_pr_number: null,
            github_pr_url: null
          }
        ]
      ]
    ]),
    worktreeOrderByProject: new Map()
  })

  useSessionStore.setState({
    activeSessionId: null,
    activeWorktreeId: null,
    sessionsByWorktree: new Map(),
    sessionsByConnection: new Map(),
    createSession: mockCreateSession,
    updateSessionName: mockUpdateSessionName,
    setPendingMessage: mockSetPendingMessage,
    setActiveSession: mockSetActiveSession,
    setActiveWorktree: mockSetActiveWorktree
  })

  useWorktreeStatusStore.setState({
    sessionStatuses: {},
    reviewSessionByWorktree: {},
    completedReviewSessionByWorktree: {},
    mergeConflictSessionByWorktree: {},
    mergeConflictFlowByWorktree: {},
    mergeConflictWorktreeByTicket: {}
  })

  useSettingsStore.setState({
    mergeConflictMode: 'build'
  })

  useGitStore.setState({
    conflictsByWorktree: {
      [WORKTREE_PATH]: true
    },
    remoteInfo: new Map(),
    creatingPRByWorktreeId: new Map(),
    refreshStatuses: mockRefreshStatuses
  })

  useConnectionStore.setState({
    selectedConnectionId: null,
    connections: []
  })

  usePinnedStore.setState({
    loaded: true,
    pinnedProjectIds: new Set(),
    pinnedWorktreeIds: new Set(),
    pinnedConnectionIds: new Set()
  })

  useScriptStore.setState({
    scriptStates: {}
  })

  useQuestionStore.setState({
    pendingBySession: new Map()
  })
}

function renderCard(ticket = makeTicket(), props: { isArchived?: boolean } = {}) {
  return render(
    <TooltipProvider>
      <KanbanTicketCard ticket={ticket} {...props} />
    </TooltipProvider>
  )
}

function ConflictFlowHarness({ worktreeId }: { worktreeId: string | null }) {
  const { startFixFlow } = useConflictFixFlow(worktreeId)
  return (
    <button type="button" data-testid="start-conflict-flow" onClick={() => void startFixFlow()}>
      Start
    </button>
  )
}

describe('merge conflicts ticket button', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateSession.mockResolvedValue({
      success: true,
      session: { id: 'conflict-session-1' }
    })
    mockUpdateSessionName.mockResolvedValue(true)
    mockRefreshStatuses.mockResolvedValue(undefined)

    if (!globalThis.ResizeObserver) {
      class MockResizeObserver {
        observe = vi.fn()
        unobserve = vi.fn()
        disconnect = vi.fn()
      }

      Object.defineProperty(globalThis, 'ResizeObserver', {
        writable: true,
        configurable: true,
        value: MockResizeObserver
      })
    }

    Object.defineProperty(window, 'db', {
      writable: true,
      configurable: true,
      value: mockDb
    })

    Object.defineProperty(window, 'systemOps', {
      writable: true,
      configurable: true,
      value: {
        openInChrome: vi.fn()
      }
    })

    Object.defineProperty(window, 'gitOps', {
      writable: true,
      configurable: true,
      value: {
        listBranchesWithStatus: vi.fn().mockResolvedValue({
          success: true,
          value: { success: true, branches: [] }
        }),
        getChangedFiles: vi.fn().mockResolvedValue({ success: true, files: [] })
      }
    })

    seedStores()
  })

  test('renders Fix conflicts button when the ticket worktree has conflicts', () => {
    renderCard()

    expect(screen.getByTestId('kanban-ticket-fix-conflicts')).toHaveTextContent('Fix conflicts')
  })

  test('hides the Fix conflicts button when the ticket has no worktree', () => {
    renderCard(makeTicket({ worktree_id: null }))

    expect(screen.queryByTestId('kanban-ticket-fix-conflicts')).not.toBeInTheDocument()
  })

  test('hides the Fix conflicts button when the ticket is archived', () => {
    renderCard(makeTicket({ archived_at: '2026-05-21T01:00:00.000Z' }), { isArchived: true })

    expect(screen.queryByTestId('kanban-ticket-fix-conflicts')).not.toBeInTheDocument()
  })

  test('renders conflicts from a merge target worktree linked to the ticket', async () => {
    const user = userEvent.setup()
    useGitStore.setState({
      conflictsByWorktree: {
        [WORKTREE_PATH]: false,
        '/tmp/proj-1/main': true
      }
    })
    useWorktreeStatusStore.setState({
      mergeConflictWorktreeByTicket: { 'ticket-1': 'base-wt' }
    })

    renderCard()

    await user.click(screen.getByTestId('kanban-ticket-fix-conflicts'))

    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledWith('base-wt', 'proj-1', undefined, 'build')
    })
  })

  test('always-ask mode renders Build and Plan choices that start the selected flow', async () => {
    const user = userEvent.setup()
    useSettingsStore.setState({ mergeConflictMode: 'always-ask' })

    const { rerender } = render(
      <TooltipProvider>
        <KanbanTicketCard ticket={makeTicket()} />
      </TooltipProvider>
    )

    await user.click(screen.getByTestId('kanban-ticket-fix-conflicts'))
    await user.click(await screen.findByText('Fix in Plan mode'))

    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledWith('wt-1', 'proj-1', undefined, 'plan')
    })

    mockCreateSession.mockClear()
    useWorktreeStatusStore.setState({
      mergeConflictSessionByWorktree: {},
      mergeConflictFlowByWorktree: {}
    })

    rerender(
      <TooltipProvider>
        <KanbanTicketCard ticket={makeTicket()} />
      </TooltipProvider>
    )

    await user.click(screen.getByTestId('kanban-ticket-fix-conflicts'))
    await user.click(await screen.findByText('Fix in Build mode'))

    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledWith('wt-1', 'proj-1', undefined, 'build')
    })
  })

  test('build mode renders a single button that starts the default flow', async () => {
    const user = userEvent.setup()

    renderCard()

    await user.click(screen.getByTestId('kanban-ticket-fix-conflicts'))

    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledWith('wt-1', 'proj-1', undefined, 'build')
    })
  })

  test('running conflict flow renders a fuchsia progress bar instead of the button', () => {
    useWorktreeStatusStore.setState({
      mergeConflictSessionByWorktree: { 'wt-1': 'conflict-session-1' },
      mergeConflictFlowByWorktree: {
        'wt-1': { phase: 'running', sessionId: 'conflict-session-1', seenBusy: true }
      }
    })

    renderCard(makeTicket({ mode: 'build' }))

    expect(screen.queryByTestId('kanban-ticket-fix-conflicts')).not.toBeInTheDocument()
    const progress = screen.getByTestId('kanban-ticket-conflict-progress')
    expect(progress).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: 'Fixing merge conflicts' })).toHaveClass(
      'bg-fuchsia-500/15'
    )
    expect(progress.querySelector('.bg-fuchsia-500')).toBeInTheDocument()
  })

  test('clicking the running progress bar opens the attached conflict session', () => {
    useWorktreeStatusStore.setState({
      mergeConflictSessionByWorktree: { 'wt-1': 'conflict-session-1' },
      mergeConflictFlowByWorktree: {
        'wt-1': { phase: 'running', sessionId: 'conflict-session-1', seenBusy: true }
      }
    })

    renderCard(makeTicket({ mode: 'build' }))

    fireEvent.click(screen.getByTestId('kanban-ticket-conflict-progress'))

    expect(useKanbanStore.getState().isBoardViewActive).toBe(false)
    expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-1')
    expect(mockSetActiveWorktree).toHaveBeenCalledWith('wt-1')
    expect(mockSetActiveSession).toHaveBeenCalledWith('conflict-session-1')
  })

  test('conflicts slot wins over busy, reviewing, and completed review indicators', () => {
    useSessionStore.setState({
      sessionsByWorktree: new Map([
        [
          'wt-1',
          [
            {
              id: 'session-1',
              worktree_id: 'wt-1',
              project_id: 'proj-1',
              connection_id: null,
              name: 'Session 1',
              status: 'active',
              opencode_session_id: null,
              agent_sdk: 'opencode',
              mode: 'build',
              session_type: 'default',
              model_provider_id: null,
              model_id: null,
              model_variant: null,
              created_at: '2026-05-21T00:00:00.000Z',
              updated_at: '2026-05-21T00:00:00.000Z',
              completed_at: null,
              pinned_to_board: false
            }
          ]
        ]
      ])
    })
    useWorktreeStatusStore.setState({
      sessionStatuses: {
        'session-1': { status: 'working', timestamp: Date.now() }
      },
      reviewSessionByWorktree: { 'wt-1': 'review-session-1' },
      completedReviewSessionByWorktree: { 'wt-1': 'review-session-2' }
    })

    renderCard(
      makeTicket({
        column: 'review',
        current_session_id: 'session-1',
        mode: 'build'
      })
    )

    expect(screen.getByTestId('kanban-ticket-fix-conflicts')).toBeInTheDocument()
    expect(screen.queryByTestId('kanban-ticket-progress')).not.toBeInTheDocument()
    expect(screen.queryByTestId('kanban-ticket-reviewing')).not.toBeInTheDocument()
    expect(screen.queryByTestId('kanban-ticket-go-to-review')).not.toBeInTheDocument()
  })

  test('startFixFlow bails when a flow is already running', async () => {
    const user = userEvent.setup()
    useWorktreeStatusStore.setState({
      mergeConflictSessionByWorktree: { 'wt-1': 'conflict-session-1' },
      mergeConflictFlowByWorktree: {
        'wt-1': { phase: 'running', sessionId: 'conflict-session-1', seenBusy: false }
      }
    })

    render(<ConflictFlowHarness worktreeId="wt-1" />)

    await user.click(screen.getByTestId('start-conflict-flow'))

    expect(mockCreateSession).not.toHaveBeenCalled()
  })

  test('renders a conflict banner at the top of the ticket modal', () => {
    useKanbanStore.setState({
      selectedTicketId: 'ticket-1',
      tickets: new Map([['proj-1', [makeTicket()]]])
    })

    render(
      <TooltipProvider>
        <KanbanTicketModal />
      </TooltipProvider>
    )

    expect(screen.getByTestId('ticket-modal-fix-conflicts-banner')).toBeInTheDocument()
    expect(screen.getByTestId('ticket-modal-fix-conflicts-banner')).toHaveTextContent(
      'Fix conflicts'
    )
  })
})

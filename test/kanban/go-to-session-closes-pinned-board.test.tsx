import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { fireEvent, render, screen } from '../utils/render'
import { KanbanTicketCard } from '@/components/kanban/KanbanTicketCard'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useGitStore } from '@/stores/useGitStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { usePinnedStore } from '@/stores/usePinnedStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useQuestionStore } from '@/stores/useQuestionStore'
import { useScriptStore } from '@/stores/useScriptStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import type { KanbanTicket } from '../../src/main/db/types'
import { leaveBoardViews } from '@/lib/board-navigation'
import { openPlanLink } from '@/components/agent/agent-ui'
import { openSession } from '@/components/document-flow/document-flow-navigation'

vi.mock('@/api/settings-api', () => ({
  settingsApi: {
    onSettingsUpdated: vi.fn(() => vi.fn())
  }
}))

vi.mock('@/api/pet-api', () => ({
  petApi: {
    updateSettings: vi.fn().mockResolvedValue(undefined)
  }
}))

vi.mock('@/api/telegram-api', () => ({
  telegramApi: {
    getConfig: vi.fn().mockResolvedValue(null),
    getStatus: vi.fn().mockResolvedValue({
      active: false,
      sessionId: null,
      worktreeId: null,
      connectionId: null,
      mode: null,
      health: 'ok',
      lastError: null
    }),
    startForwarding: vi.fn().mockResolvedValue({
      ok: true,
      status: {
        active: false,
        sessionId: null,
        worktreeId: null,
        connectionId: null,
        mode: null,
        health: 'ok',
        lastError: null
      }
    }),
    onStatusChanged: vi.fn(() => vi.fn()),
    onMessageReceived: vi.fn(() => vi.fn()),
    onPlanImplementRequested: vi.fn(() => vi.fn())
  }
}))

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

vi.mock('@/components/sessions/IndeterminateProgressBar', () => ({
  IndeterminateProgressBar: () => null
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

let request: ReturnType<typeof vi.fn>

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: 'proj-1',
    title: 'Keep pinned board active',
    description: null,
    attachments: [],
    column: 'todo',
    sort_order: 0,
    current_session_id: null,
    worktree_id: 'wt-1',
    mode: null,
    plan_ready: false,
    created_at: '2026-04-16T00:00:00.000Z',
    updated_at: '2026-04-16T00:00:00.000Z',
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

function seedStores(): void {
  useKanbanStore.setState({
    tickets: new Map([['proj-1', [makeTicket()]]]),
    dependencyMap: new Map(),
    selectedTicketId: null,
    isPinnedBoardActive: true
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
        created_at: '2026-04-16T00:00:00.000Z',
        last_accessed_at: '2026-04-16T00:00:00.000Z'
      }
    ],
    selectedProjectId: null
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
            path: '/tmp/proj-1/feature-auth',
            status: 'active',
            is_default: false,
            branch_renamed: 0,
            last_message_at: null,
            session_titles: '[]',
            last_model_provider_id: null,
            last_model_id: null,
            last_model_variant: null,
            created_at: '2026-04-16T00:00:00.000Z',
            last_accessed_at: '2026-04-16T00:00:00.000Z',
            github_pr_number: null,
            github_pr_url: null
          }
        ]
      ]
    ]),
    worktreeOrderByProject: new Map()
  })

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
            created_at: '2026-04-16T00:00:00.000Z',
            updated_at: '2026-04-16T00:00:00.000Z',
            completed_at: null,
            pinned_to_board: false
          }
        ]
      ]
    ]),
    sessionsByConnection: new Map()
  })

  useWorktreeStatusStore.setState({
    sessionStatuses: {
      'session-1': {
        status: 'unread',
        timestamp: Date.now()
      }
    },
    reviewSessionByWorktree: {},
    completedReviewSessionByWorktree: {},
    mergeConflictSessionByWorktree: {},
    mergeConflictFlowByWorktree: {}
  })

  useConnectionStore.setState({
    selectedConnectionId: null,
    connections: []
  })

  usePinnedStore.setState({
    loaded: true,
    pinnedProjectIds: new Set(['proj-1']),
    pinnedWorktreeIds: new Set(),
    pinnedConnectionIds: new Set()
  })

  useGitStore.setState({
    remoteInfo: new Map(),
    creatingPRByWorktreeId: new Map()
  })

  useScriptStore.setState({
    scriptStates: {}
  })

  useQuestionStore.setState({
    pendingBySession: new Map()
  })
}

describe('go to session closes the pinned board', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRendererRpcClientForTests()
    request = vi.fn(async (method: string) => {
      if (method === 'db.project.touch') return true
      if (method === 'db.worktree.touch') return undefined
      if (method === 'db.session.get') return null
      if (method === 'opencodeOps.command') return { success: true }
      return null
    })
    setRendererRpcClient({
      request,
      subscribe: vi.fn(() => vi.fn())
    })

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

    seedStores()
  })

  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  /** Let the async togglePinnedBoard / toggleBoardView microtasks (if any were queued) settle. */
  const flush = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
  }

  test('leaveBoardViews closes both boards idempotently', async () => {
    useKanbanStore.setState({ isBoardViewActive: true, isPinnedBoardActive: true })

    leaveBoardViews()
    leaveBoardViews()
    await flush()

    expect(useKanbanStore.getState().isBoardViewActive).toBe(false)
    expect(useKanbanStore.getState().isPinnedBoardActive).toBe(false)
    expect(useKanbanStore.getState().isPinnedBoardBehindSession).toBe(false)
  })

  test('leaveBoardViews does not race the close performed by selectWorktree', async () => {
    useKanbanStore.setState({ isPinnedBoardActive: true })

    leaveBoardViews()
    useWorktreeStore.getState().selectWorktree('wt-1')
    await flush()

    expect(useKanbanStore.getState().isPinnedBoardActive).toBe(false)
  })

  test('closeBoardView does not force the board on while the tiled tab holds the pane', async () => {
    useKanbanStore.setState({ isBoardViewActive: true })
    useSessionStore.setState({ isTiledSessionsActive: true })

    leaveBoardViews()
    await flush()

    expect(useKanbanStore.getState().isBoardViewActive).toBe(false)
  })

  test('card "Jump to session" from the pinned board shows the session', async () => {
    render(
      <KanbanTicketCard
        ticket={makeTicket({ column: 'in_progress', current_session_id: 'session-1' })}
        isPinnedMode
      />
    )

    fireEvent.contextMenu(screen.getByTestId('kanban-ticket-ticket-1'))
    const jump = await screen.findByTestId('ctx-jump-to-session')
    await userEvent.click(jump)
    await flush()

    expect(useKanbanStore.getState().isPinnedBoardActive).toBe(false)
    expect(useKanbanStore.getState().isBoardViewActive).toBe(false)
    expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-1')
    expect(useSessionStore.getState().activeWorktreeId).toBe('wt-1')
    expect(useSessionStore.getState().activeSessionId).toBe('session-1')
  })

  test('card "Jump to session" from the project board with the pinned board on shows the session', async () => {
    useKanbanStore.setState({ isBoardViewActive: true, isPinnedBoardActive: true })
    render(
      <KanbanTicketCard
        ticket={makeTicket({ column: 'in_progress', current_session_id: 'session-1' })}
      />
    )

    fireEvent.contextMenu(screen.getByTestId('kanban-ticket-ticket-1'))
    await userEvent.click(await screen.findByTestId('ctx-jump-to-session'))
    await flush()

    expect(useKanbanStore.getState().isPinnedBoardActive).toBe(false)
    expect(useKanbanStore.getState().isBoardViewActive).toBe(false)
    expect(useSessionStore.getState().activeSessionId).toBe('session-1')
  })

  test('card "Jump to session" closes a pinned board that a session was already shown over', async () => {
    useKanbanStore.setState({ isPinnedBoardActive: true, isPinnedBoardBehindSession: true })
    render(
      <KanbanTicketCard
        ticket={makeTicket({ column: 'in_progress', current_session_id: 'session-1' })}
        isPinnedMode
      />
    )

    fireEvent.contextMenu(screen.getByTestId('kanban-ticket-ticket-1'))
    await userEvent.click(await screen.findByTestId('ctx-jump-to-session'))
    await flush()

    expect(useKanbanStore.getState().isPinnedBoardActive).toBe(false)
    expect(useKanbanStore.getState().isPinnedBoardBehindSession).toBe(false)
    expect(useSessionStore.getState().activeSessionId).toBe('session-1')
  })

  test('plan-row session link leaves the pinned board', async () => {
    useKanbanStore.setState({ isPinnedBoardActive: true })

    openPlanLink({ kind: 'session', sessionId: 'session-1' })
    await flush()

    expect(useKanbanStore.getState().isPinnedBoardActive).toBe(false)
    expect(useSessionStore.getState().activeSessionId).toBe('session-1')
  })

  test('document-flow openSession leaves the pinned board', async () => {
    useKanbanStore.setState({ isPinnedBoardActive: true })

    openSession('proj-1', 'wt-1', 'session-1')
    await flush()

    expect(useKanbanStore.getState().isPinnedBoardActive).toBe(false)
    expect(useSessionStore.getState().activeSessionId).toBe('session-1')
  })
})

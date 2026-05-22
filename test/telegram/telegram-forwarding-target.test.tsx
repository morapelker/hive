import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '../utils/render'
import userEvent from '@testing-library/user-event'
import { KanbanTicketCard } from '@/components/kanban/KanbanTicketCard'
import { HeaderTelegramToggle } from '@/components/layout/HeaderTelegramToggle'
import { TooltipProvider } from '@/components/ui/tooltip'
import { BOARD_TAB_ID, useSessionStore } from '@/stores/useSessionStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useTelegramStore } from '@/stores/useTelegramStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useGitStore } from '@/stores/useGitStore'
import { usePinnedStore } from '@/stores/usePinnedStore'
import { useQuestionStore } from '@/stores/useQuestionStore'
import { useScriptStore } from '@/stores/useScriptStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { getTelegramForwardingTarget } from '@/lib/telegramForwardingTarget'
import { startBackgroundSessionPrompt } from '@/lib/backgroundSessionStart'
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

const mockDb = {
  session: {
    update: vi.fn().mockResolvedValue(undefined)
  },
  worktree: {
    touch: vi.fn().mockResolvedValue(undefined)
  }
}

const startForwarding = vi.fn()
const connectPromptSession = vi.fn()
const promptSession = vi.fn()
const getTicketsBySession = vi.fn()
const updateTicket = vi.fn()

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: 'proj-1',
    title: 'Forward this ticket',
    description: null,
    attachments: [],
    column: 'in_progress',
    sort_order: 0,
    current_session_id: 'session-1',
    worktree_id: 'wt-1',
    mode: 'build',
    plan_ready: false,
    created_at: '2026-05-08T00:00:00.000Z',
    updated_at: '2026-05-08T00:00:00.000Z',
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

function seedStores(ticket = makeTicket()): void {
  useKanbanStore.setState({
    tickets: new Map([['proj-1', [ticket]]]),
    dependencyMap: new Map(),
    selectedTicketId: null,
    isBoardViewActive: false,
    isPinnedBoardActive: false,
    boardTelegramTarget: null
  })

  useSettingsStore.setState({
    boardMode: 'sticky-tab'
  })

  useSessionStore.setState({
    activeSessionId: BOARD_TAB_ID,
    activeWorktreeId: 'wt-1',
    activeConnectionId: null,
    activePinnedSessionId: null,
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
            created_at: '2026-05-08T00:00:00.000Z',
            updated_at: '2026-05-08T00:00:00.000Z',
            completed_at: null,
            pinned_to_board: false
          }
        ]
      ]
    ]),
    sessionsByConnection: new Map()
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
            name: 'feature',
            branch_name: 'feature',
            path: '/tmp/project/feature',
            status: 'active',
            is_default: false,
            branch_renamed: 0,
            last_message_at: null,
            session_titles: '[]',
            last_model_provider_id: null,
            last_model_id: null,
            last_model_variant: null,
            created_at: '2026-05-08T00:00:00.000Z',
            last_accessed_at: '2026-05-08T00:00:00.000Z',
            github_pr_number: null,
            github_pr_url: null
          }
        ]
      ]
    ])
  })

  useProjectStore.setState({
    selectedProjectId: 'proj-1',
    projects: [
      {
        id: 'proj-1',
        name: 'Project',
        path: '/tmp/project',
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
        created_at: '2026-05-08T00:00:00.000Z',
        last_accessed_at: '2026-05-08T00:00:00.000Z'
      }
    ]
  })

  useTelegramStore.setState({
    activeForwardingSessionId: null,
    activeForwardingWorktreeId: null,
    activeForwardingMode: null,
    health: 'ok'
  })

  useConnectionStore.setState({ selectedConnectionId: null, connections: [] })
  useGitStore.setState({ remoteInfo: new Map(), creatingPRByWorktreeId: new Map() })
  usePinnedStore.setState({ loaded: true, pinnedProjectIds: new Set(), pinnedWorktreeIds: new Set() })
  useQuestionStore.setState({ pendingBySession: new Map() })
  useScriptStore.setState({ scriptStates: {} })
  useWorktreeStatusStore.setState({
    sessionStatuses: {},
    reviewSessionByWorktree: {},
    completedReviewSessionByWorktree: {},
    mergeConflictSessionByWorktree: {},
    mergeConflictFlowByWorktree: {}
  })
}

describe('Telegram forwarding board target', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    class ResizeObserverMock {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    Object.defineProperty(window, 'ResizeObserver', {
      writable: true,
      configurable: true,
      value: ResizeObserverMock
    })
    Object.defineProperty(window, 'db', {
      writable: true,
      configurable: true,
      value: mockDb
    })
    Object.defineProperty(window, 'telegramOps', {
      writable: true,
      configurable: true,
      value: {
        startForwarding,
        stopForwarding: vi.fn(),
        getConfig: vi.fn().mockResolvedValue({
          botToken: 'token',
          chatId: 123,
          chatName: 'me',
          contextSize: 3
        }),
        getStatus: vi.fn().mockResolvedValue({
          active: false,
          sessionId: null,
          worktreeId: null,
          connectionId: null,
          mode: null,
          health: 'ok',
          lastError: null
        }),
        onStatusChanged: vi.fn(),
        onPlanImplementRequested: vi.fn()
      }
    })
    Object.defineProperty(window, 'kanban', {
      writable: true,
      configurable: true,
      value: {
        ticket: {
          getBySession: getTicketsBySession,
          update: updateTicket
        }
      }
    })
    Object.defineProperty(window, 'opencodeOps', {
      writable: true,
      configurable: true,
      value: {
        connect: connectPromptSession,
        prompt: promptSession
      }
    })
    mockDb.session.update.mockResolvedValue(undefined)
    connectPromptSession.mockResolvedValue({ success: true, sessionId: 'opc-session-new' })
    promptSession.mockResolvedValue({ success: true })
    startForwarding.mockResolvedValue({
      ok: true,
      status: {
        active: true,
        sessionId: 'session-1',
        worktreeId: 'wt-1',
        connectionId: null,
        mode: 'questions',
        health: 'ok',
        lastError: null
      }
    })
    getTicketsBySession.mockResolvedValue([])
    updateTicket.mockResolvedValue(undefined)
  })

  it('records the ticket session as board Telegram target on cmd-click', () => {
    seedStores()

    render(<KanbanTicketCard ticket={makeTicket()} />)
    fireEvent.click(screen.getByTestId('kanban-ticket-ticket-1'), { metaKey: true })

    expect(useKanbanStore.getState().boardTelegramTarget).toEqual({
      ticketId: 'ticket-1',
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      sessionId: 'session-1'
    })
  })

  it('resolves the board ticket session instead of the board pseudo-tab', () => {
    seedStores()
    useKanbanStore.getState().setBoardTelegramTarget({
      ticketId: 'ticket-1',
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      sessionId: 'session-1'
    })

    expect(getTelegramForwardingTarget()).toEqual({
      sessionId: 'session-1',
      worktreeId: 'wt-1',
      connectionId: null,
      source: 'board-ticket'
    })
  })

  it('does not use the board pseudo-tab when no board ticket target exists', () => {
    seedStores()

    expect(getTelegramForwardingTarget()).toEqual({
      sessionId: null,
      worktreeId: null,
      connectionId: null,
      source: 'active-session'
    })
  })

  it('starts forwarding the active connection session from the header toggle', async () => {
    const user = userEvent.setup()
    seedStores()
    useSessionStore.setState({
      activeSessionId: 'conn-session-1',
      activeWorktreeId: null,
      activeConnectionId: 'conn-1',
      sessionsByConnection: new Map([
        [
          'conn-1',
          [
            {
              id: 'conn-session-1',
              worktree_id: null,
              project_id: 'proj-1',
              connection_id: 'conn-1',
              name: 'Session 1',
              status: 'active',
              opencode_session_id: null,
              agent_sdk: 'opencode',
              mode: 'build',
              session_type: 'default',
              model_provider_id: null,
              model_id: null,
              model_variant: null,
              created_at: '2026-05-08T00:00:00.000Z',
              updated_at: '2026-05-08T00:00:00.000Z',
              completed_at: null,
              pinned_to_board: false
            }
          ]
        ]
      ])
    })

    render(
      <TooltipProvider>
        <HeaderTelegramToggle />
      </TooltipProvider>
    )
    act(() => {
      useSettingsStore.getState().setTelegramConfig({
        botToken: 'token',
        chatId: 123,
        chatName: 'me',
        contextSize: 3
      })
    })
    await waitFor(() => {
      expect(screen.getByTestId('telegram-forwarding-toggle')).not.toBeDisabled()
    })
    await user.click(screen.getByTestId('telegram-forwarding-toggle'))
    await user.click(await screen.findByText(/^Questions/))

    await waitFor(() => {
      expect(startForwarding).toHaveBeenCalledWith({
        sessionId: 'conn-session-1',
        worktreeId: null,
        connectionId: 'conn-1',
        mode: 'questions'
      })
    })
  })

  it('shows a Telegram icon on the ticket attached to the forwarded session', () => {
    seedStores()
    useTelegramStore.setState({
      activeForwardingSessionId: 'session-1',
      activeForwardingWorktreeId: 'wt-1',
      activeForwardingMode: 'questions'
    })

    render(<KanbanTicketCard ticket={makeTicket()} />)

    expect(screen.getByTitle('Forwarding to Telegram')).toBeInTheDocument()
  })

  it('starts forwarding the selected board ticket session from the header toggle', async () => {
    const user = userEvent.setup()
    seedStores()
    useKanbanStore.getState().setBoardTelegramTarget({
      ticketId: 'ticket-1',
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      sessionId: 'session-1'
    })

    render(
      <TooltipProvider>
        <HeaderTelegramToggle />
      </TooltipProvider>
    )
    act(() => {
      useSettingsStore.getState().setTelegramConfig({
        botToken: 'token',
        chatId: 123,
        chatName: 'me',
        contextSize: 3
      })
    })
    await waitFor(() => {
      expect(screen.getByTestId('telegram-forwarding-toggle')).not.toBeDisabled()
    })
    await user.click(screen.getByTestId('telegram-forwarding-toggle'))
    await user.click(await screen.findByText(/^Questions/))

    await waitFor(() => {
      expect(startForwarding).toHaveBeenCalledWith({
        sessionId: 'session-1',
        worktreeId: 'wt-1',
        connectionId: null,
        mode: 'questions'
      })
    })
  })

  it('keeps the board Telegram target attached to the new handoff session', async () => {
    const oldTicket = makeTicket({ current_session_id: 'session-old' })
    seedStores(oldTicket)
    useKanbanStore.getState().setBoardTelegramTarget({
      ticketId: 'ticket-1',
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      sessionId: 'session-old'
    })
    getTicketsBySession.mockResolvedValue([oldTicket])

    await useKanbanStore.getState().relinkTicketsForHandoff('session-old', 'session-new')

    expect(useKanbanStore.getState().boardTelegramTarget).toEqual({
      ticketId: 'ticket-1',
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      sessionId: 'session-new'
    })
  })

  it('starts a handoff prompt in the background without focusing the session', async () => {
    seedStores(makeTicket({ current_session_id: 'session-new' }))

    await startBackgroundSessionPrompt({
      worktreePath: '/tmp/project/feature',
      sessionId: 'session-1',
      prompt: 'Implement the following plan\nDo it.',
      bumpTarget: { worktreeId: 'wt-1' }
    })

    expect(connectPromptSession).toHaveBeenCalledWith('/tmp/project/feature', 'session-1')
    expect(mockDb.session.update).toHaveBeenCalledWith('session-1', {
      opencode_session_id: 'opc-session-new'
    })
    expect(promptSession.mock.calls[0]?.slice(0, 3)).toEqual([
      '/tmp/project/feature',
      'opc-session-new',
      [{ type: 'text', text: 'Implement the following plan\nDo it.' }]
    ])
    expect(useWorktreeStatusStore.getState().sessionStatuses['session-1']?.status).toBe('working')
  })
})

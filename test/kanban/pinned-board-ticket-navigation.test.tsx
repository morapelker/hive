import { beforeEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen } from '../utils/render'
import { KanbanTicketCard } from '@/components/kanban/KanbanTicketCard'
import { TooltipProvider } from '@/components/ui/tooltip'
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
  project: {
    touch: vi.fn().mockResolvedValue(undefined)
  },
  worktree: {
    touch: vi.fn().mockResolvedValue(undefined)
  }
}

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
    completedReviewSessionByWorktree: {}
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

describe('pinned board ticket navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks()

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

    seedStores()
  })

  test('cmd-click on a pinned-board ticket keeps the pinned board active', () => {
    render(<KanbanTicketCard ticket={makeTicket()} isPinnedMode />)

    fireEvent.click(screen.getByTestId('kanban-ticket-ticket-1'), { metaKey: true })

    expect(useKanbanStore.getState().isPinnedBoardActive).toBe(true)
    expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-1')
    expect(useProjectStore.getState().selectedProjectId).toBe('proj-1')
    expect(useWorktreeStatusStore.getState().sessionStatuses['session-1']).toBeNull()
  })

  test('middle-click on a pinned-board ticket keeps the pinned board active', () => {
    render(<KanbanTicketCard ticket={makeTicket()} isPinnedMode />)

    fireEvent.mouseDown(screen.getByTestId('kanban-ticket-ticket-1'), { button: 1 })

    expect(useKanbanStore.getState().isPinnedBoardActive).toBe(true)
    expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-1')
    expect(useProjectStore.getState().selectedProjectId).toBe('proj-1')
    expect(useWorktreeStatusStore.getState().sessionStatuses['session-1']).toBeNull()
  })

  test('cmd-click outside pinned mode still closes the pinned board', () => {
    render(<KanbanTicketCard ticket={makeTicket()} />)

    fireEvent.click(screen.getByTestId('kanban-ticket-ticket-1'), { metaKey: true })

    expect(useKanbanStore.getState().isPinnedBoardActive).toBe(false)
    expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-1')
    expect(useProjectStore.getState().selectedProjectId).toBe('proj-1')
    expect(useWorktreeStatusStore.getState().sessionStatuses['session-1']).toBeNull()
  })

  test('renders a goal mode badge and tooltip when the ticket is configured for goal mode', async () => {
    render(
      <TooltipProvider>
        <KanbanTicketCard
          ticket={makeTicket({
            worktree_id: null,
            goal_mode: true,
            goal_success_criteria: 'Acceptance criteria are met'
          })}
        />
      </TooltipProvider>
    )

    const badge = screen.getByTestId('kanban-ticket-goal')
    const icon = badge.querySelector('svg')

    expect(badge).toBeInTheDocument()
    expect(badge).toHaveClass('ml-auto')
    expect(icon).toBeInTheDocument()
    expect(icon?.querySelector('[fill="black"]')).toBeInTheDocument()
    expect(icon?.querySelector('[fill="white"]')).toBeInTheDocument()

    fireEvent.pointerMove(badge)

    expect(await screen.findAllByText('Goal mode')).not.toHaveLength(0)
  })

  test('does not render a goal mode badge for non-goal tickets', () => {
    render(<KanbanTicketCard ticket={makeTicket({ worktree_id: null })} />)

    expect(screen.queryByTestId('kanban-ticket-goal')).not.toBeInTheDocument()
  })
})

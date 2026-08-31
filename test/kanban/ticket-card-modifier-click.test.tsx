import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '../utils/render'
import { KanbanTicketCard } from '@/components/kanban/KanbanTicketCard'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useGitStore } from '@/stores/useGitStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { usePinnedStore } from '@/stores/usePinnedStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useQuestionStore } from '@/stores/useQuestionStore'
import { useScriptStore } from '@/stores/useScriptStore'
import { useSessionStore, type Session } from '@/stores/useSessionStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import type { KanbanTicket } from '../../src/main/db/types'

type Worktree = NonNullable<
  ReturnType<ReturnType<(typeof useWorktreeStore)['getState']>['getDefaultWorktree']>
>
type Connection = ReturnType<(typeof useConnectionStore)['getState']>['connections'][number]
type Project = ReturnType<(typeof useProjectStore)['getState']>['projects'][number]

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
    title: 'Navigate via modifier clicks',
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

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
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
    github_pr_url: null,
    ...overrides
  }
}

function makeConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'conn-live',
    name: 'alpha + beta',
    custom_name: null,
    status: 'active',
    path: '/tmp/conn-live',
    color: null,
    saved_project_id: 'proj-conn',
    is_base: 0,
    created_at: '2026-04-16T00:00:00.000Z',
    updated_at: '2026-04-16T00:00:00.000Z',
    members: [],
    ...overrides
  } as Connection
}

// A connection project ('proj-conn') with a live instance ('conn-live', running
// session 'sess-conn') and its base instance ('conn-base' — each member
// project's default worktree)
function seedConnectionProject(): void {
  useProjectStore.setState((state) => ({
    projects: [
      ...state.projects,
      {
        id: 'proj-conn',
        name: 'Connection Project',
        path: '/tmp/proj-conn',
        kind: 'connection',
        member_project_ids: '["proj-1"]'
      } as unknown as Project
    ]
  }))
  useConnectionStore.setState({
    connections: [
      makeConnection({ id: 'conn-base', is_base: 1 }),
      makeConnection({ id: 'conn-live' })
    ]
  })
  useSessionStore.setState({
    sessionsByConnection: new Map([['conn-live', [{ id: 'sess-conn' } as unknown as Session]]])
  })
}

function makeConnectionTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return makeTicket({
    project_id: 'proj-conn',
    worktree_id: null,
    current_session_id: 'sess-conn',
    ...overrides
  })
}

function seedStores(): void {
  useKanbanStore.setState({
    tickets: new Map([['proj-1', [makeTicket()]]]),
    dependencyMap: new Map(),
    selectedTicketId: null,
    selectedTicketRef: null,
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
          makeWorktree(),
          makeWorktree({
            id: 'wt-base',
            name: 'main',
            branch_name: 'main',
            path: '/tmp/proj-1',
            is_default: true
          })
        ]
      ]
    ]),
    worktreeOrderByProject: new Map()
  })

  useSessionStore.setState({
    sessionsByWorktree: new Map(),
    sessionsByConnection: new Map()
  })

  useWorktreeStatusStore.setState({
    sessionStatuses: {},
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
    pinnedProjectIds: new Set(),
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

describe('ticket card modifier clicks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRendererRpcClientForTests()
    request = vi.fn(async (method: string) => {
      if (method === 'db.project.touch') return true
      if (method === 'db.worktree.touch') return undefined
      if (method === 'db.worktree.getActiveByProject') return []
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

  test('cmd-click selects the attached worktree', () => {
    render(<KanbanTicketCard ticket={makeTicket()} />)

    fireEvent.click(screen.getByTestId('kanban-ticket-ticket-1'), { metaKey: true })

    expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-1')
    expect(useProjectStore.getState().selectedProjectId).toBe('proj-1')
    expect(useKanbanStore.getState().selectedTicketRef).toBeNull()
  })

  test('cmd-shift-click selects the base worktree even when a worktree is attached', () => {
    render(<KanbanTicketCard ticket={makeTicket()} />)

    fireEvent.click(screen.getByTestId('kanban-ticket-ticket-1'), {
      metaKey: true,
      shiftKey: true
    })

    expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-base')
    expect(useProjectStore.getState().selectedProjectId).toBe('proj-1')
    expect(useKanbanStore.getState().selectedTicketRef).toBeNull()
  })

  test('cmd-click falls back to the base worktree when the ticket has no worktree', () => {
    // Archiving a worktree detaches its tickets, leaving worktree_id null
    render(<KanbanTicketCard ticket={makeTicket({ worktree_id: null })} />)

    fireEvent.click(screen.getByTestId('kanban-ticket-ticket-1'), { metaKey: true })

    expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-base')
    expect(useProjectStore.getState().selectedProjectId).toBe('proj-1')
    expect(useKanbanStore.getState().selectedTicketRef).toBeNull()
  })

  test('cmd-click falls back to the base worktree when the attached worktree is gone', () => {
    // A stale worktree_id (e.g. the worktree was archived) no longer resolves
    render(<KanbanTicketCard ticket={makeTicket({ worktree_id: 'wt-archived' })} />)

    fireEvent.click(screen.getByTestId('kanban-ticket-ticket-1'), { metaKey: true })

    expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-base')
    expect(useProjectStore.getState().selectedProjectId).toBe('proj-1')
  })

  test('cmd-click and cmd-shift-click work on archived tickets', () => {
    render(
      <KanbanTicketCard
        ticket={makeTicket({ worktree_id: null, archived_at: '2026-04-17T00:00:00.000Z' })}
        isArchived
      />
    )

    fireEvent.click(screen.getByTestId('kanban-ticket-ticket-1'), { metaKey: true })
    expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-base')

    useWorktreeStore.setState({ selectedWorktreeId: null })
    fireEvent.click(screen.getByTestId('kanban-ticket-ticket-1'), {
      metaKey: true,
      shiftKey: true
    })
    expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-base')
    expect(useKanbanStore.getState().selectedTicketRef).toBeNull()
  })

  test('cmd-click loads worktrees first when the project has none in the store', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'db.worktree.getActiveByProject') {
        return [makeWorktree({ id: 'wt-base', is_default: true })]
      }
      if (method === 'db.project.touch') return true
      if (method === 'db.worktree.touch') return undefined
      return null
    })
    useWorktreeStore.setState({ worktreesByProject: new Map() })
    render(<KanbanTicketCard ticket={makeTicket({ worktree_id: null })} />)

    fireEvent.click(screen.getByTestId('kanban-ticket-ticket-1'), { metaKey: true })

    await waitFor(() => {
      expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-base')
    })
    expect(useKanbanStore.getState().selectedTicketRef).toBeNull()
  })

  test('cmd-click on a connection project ticket selects its live instance', () => {
    seedConnectionProject()
    // TooltipProvider: a live connection session renders a connection badge tooltip
    render(
      <TooltipProvider>
        <KanbanTicketCard ticket={makeConnectionTicket()} />
      </TooltipProvider>
    )

    fireEvent.click(screen.getByTestId('kanban-ticket-ticket-1'), { metaKey: true })

    expect(useConnectionStore.getState().selectedConnectionId).toBe('conn-live')
    expect(useKanbanStore.getState().selectedTicketRef).toBeNull()
  })

  test('cmd-shift-click on a connection project ticket selects the base instance', () => {
    seedConnectionProject()
    render(
      <TooltipProvider>
        <KanbanTicketCard ticket={makeConnectionTicket()} />
      </TooltipProvider>
    )

    fireEvent.click(screen.getByTestId('kanban-ticket-ticket-1'), {
      metaKey: true,
      shiftKey: true
    })

    expect(useConnectionStore.getState().selectedConnectionId).toBe('conn-base')
    expect(useKanbanStore.getState().selectedTicketRef).toBeNull()
  })

  test('cmd-click falls back to the base instance when the connection instance is gone', () => {
    // Archiving a connection instance removes its sessions, so the ticket no
    // longer resolves to a live connection
    seedConnectionProject()
    useSessionStore.setState({ sessionsByConnection: new Map() })
    render(<KanbanTicketCard ticket={makeConnectionTicket()} />)

    fireEvent.click(screen.getByTestId('kanban-ticket-ticket-1'), { metaKey: true })

    expect(useConnectionStore.getState().selectedConnectionId).toBe('conn-base')
    expect(useKanbanStore.getState().selectedTicketRef).toBeNull()
  })

  test('cmd-shift-click loads connections first when none are in the store', async () => {
    seedConnectionProject()
    useConnectionStore.setState({ connections: [] })
    request.mockImplementation(async (method: string) => {
      if (method === 'connectionOps.getAll') {
        return { success: true, connections: [makeConnection({ id: 'conn-base', is_base: 1 })] }
      }
      if (method === 'db.project.touch') return true
      if (method === 'db.worktree.touch') return undefined
      if (method === 'db.worktree.getActiveByProject') return []
      return null
    })
    render(<KanbanTicketCard ticket={makeConnectionTicket()} />)

    fireEvent.click(screen.getByTestId('kanban-ticket-ticket-1'), {
      metaKey: true,
      shiftKey: true
    })

    await waitFor(() => {
      expect(useConnectionStore.getState().selectedConnectionId).toBe('conn-base')
    })
    expect(useKanbanStore.getState().selectedTicketRef).toBeNull()
  })

  test('plain click still opens the ticket modal', () => {
    render(<KanbanTicketCard ticket={makeTicket()} />)

    fireEvent.click(screen.getByTestId('kanban-ticket-ticket-1'))

    expect(useKanbanStore.getState().selectedTicketRef).toEqual({
      projectId: 'proj-1',
      ticketId: 'ticket-1'
    })
    expect(useWorktreeStore.getState().selectedWorktreeId).toBeNull()
  })
})

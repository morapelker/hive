import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { fireEvent, render, screen, waitFor } from '../utils/render'
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
    startForwarding: vi.fn().mockResolvedValue({ ok: true }),
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

const BASE_WT = 'wt-base'
const FEATURE_WT = 'wt-feature'
const BASE_CONN = 'conn-base'

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: 'proj-1',
    title: 'Pin the base, not my worktree',
    description: null,
    attachments: [],
    column: 'todo',
    sort_order: 0,
    current_session_id: null,
    worktree_id: FEATURE_WT,
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

function makeWorktree(id: string, isDefault: boolean) {
  return {
    id,
    project_id: 'proj-1',
    name: isDefault ? 'main' : 'feature',
    branch_name: isDefault ? 'main' : 'feature',
    path: `/tmp/proj-1/${id}`,
    status: 'active' as const,
    is_default: isDefault,
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
}

function seedStores(kind: 'git' | 'connection' = 'git'): void {
  useKanbanStore.setState({
    tickets: new Map([['proj-1', [makeTicket()]]]),
    dependencyMap: new Map(),
    selectedTicketId: null,
    isPinnedBoardActive: false
  })

  useProjectStore.setState({
    projects: [
      {
        id: 'proj-1',
        name: 'Project One',
        path: '/tmp/proj-1',
        kind,
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
    selectedProjectId: 'proj-1'
  })

  useWorktreeStore.setState({
    selectedWorktreeId: null,
    worktreesByProject: new Map(
      kind === 'git'
        ? [['proj-1', [makeWorktree(FEATURE_WT, false), makeWorktree(BASE_WT, true)]]]
        : []
    ),
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
    connections:
      kind === 'connection'
        ? [
            {
              id: 'conn-user',
              name: 'a + b',
              custom_name: null,
              status: 'active',
              path: '/tmp/conn-user',
              color: null,
              saved_project_id: 'proj-1',
              is_base: 0,
              created_at: '2026-04-16T00:00:00.000Z',
              updated_at: '2026-04-16T00:00:00.000Z',
              members: []
            },
            {
              id: BASE_CONN,
              name: 'main',
              custom_name: null,
              status: 'active',
              path: '/tmp/conn-base',
              color: null,
              saved_project_id: 'proj-1',
              is_base: 1,
              created_at: '2026-04-16T00:00:00.000Z',
              updated_at: '2026-04-16T00:00:00.000Z',
              members: []
            }
          ]
        : []
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

async function openPinItem(): Promise<HTMLElement> {
  fireEvent.contextMenu(screen.getByTestId('kanban-ticket-ticket-1'))
  return screen.findByTestId('ctx-toggle-base-pin')
}

describe('ticket card: pin/unpin the project base', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRendererRpcClientForTests()
    request = vi.fn(async (method: string) => {
      if (method === 'db.worktree.setPinned') return { success: true }
      if (method === 'connectionOps.setPinned') return { success: true }
      if (method === 'db.project.touch') return true
      if (method === 'db.worktree.touch') return undefined
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

  test('pins the project base worktree, not the ticket worktree', async () => {
    const user = userEvent.setup()
    render(<KanbanTicketCard ticket={makeTicket()} />)

    const item = await openPinItem()
    expect(item).toHaveTextContent('Pin base worktree')
    expect(screen.queryByTestId('ctx-toggle-pin')).not.toBeInTheDocument()

    await user.click(item)

    await waitFor(() => {
      expect(request).toHaveBeenCalledWith('db.worktree.setPinned', {
        worktreeId: BASE_WT,
        pinned: true
      })
    })
    expect(request).not.toHaveBeenCalledWith(
      'db.worktree.setPinned',
      expect.objectContaining({ worktreeId: FEATURE_WT })
    )
    expect(usePinnedStore.getState().pinnedWorktreeIds.has(BASE_WT)).toBe(true)
    expect(usePinnedStore.getState().pinnedProjectIds.has('proj-1')).toBe(true)
  })

  test('reads Unpin from the base worktree state even when the ticket worktree is pinned', async () => {
    const user = userEvent.setup()
    usePinnedStore.setState({
      pinnedProjectIds: new Set(['proj-1']),
      pinnedWorktreeIds: new Set([BASE_WT, FEATURE_WT])
    })
    render(<KanbanTicketCard ticket={makeTicket()} />)

    const item = await openPinItem()
    expect(item).toHaveTextContent('Unpin base worktree')

    await user.click(item)

    await waitFor(() => {
      expect(request).toHaveBeenCalledWith('db.worktree.setPinned', {
        worktreeId: BASE_WT,
        pinned: false
      })
    })
    const pinned = usePinnedStore.getState()
    expect(pinned.pinnedWorktreeIds.has(BASE_WT)).toBe(false)
    // The feature worktree pin is untouched (and still keeps the project on the board)
    expect(pinned.pinnedWorktreeIds.has(FEATURE_WT)).toBe(true)
    expect(pinned.pinnedProjectIds.has('proj-1')).toBe(true)
  })

  test('shows Pin when only a non-base worktree of the project is pinned', async () => {
    usePinnedStore.setState({
      pinnedProjectIds: new Set(['proj-1']),
      pinnedWorktreeIds: new Set([FEATURE_WT])
    })
    render(<KanbanTicketCard ticket={makeTicket()} />)

    const item = await openPinItem()
    expect(item).toHaveTextContent('Pin base worktree')
  })

  test('is available on tickets without an assigned worktree', async () => {
    const user = userEvent.setup()
    render(<KanbanTicketCard ticket={makeTicket({ worktree_id: null })} />)

    const item = await openPinItem()
    expect(item).toHaveTextContent('Pin base worktree')
    expect(screen.queryByTestId('ctx-edit-context')).not.toBeInTheDocument()

    await user.click(item)

    await waitFor(() => {
      expect(request).toHaveBeenCalledWith('db.worktree.setPinned', {
        worktreeId: BASE_WT,
        pinned: true
      })
    })
  })

  test('connection-project tickets pin/unpin the base instance', async () => {
    const user = userEvent.setup()
    seedStores('connection')
    render(<KanbanTicketCard ticket={makeTicket({ worktree_id: null })} />)

    const item = await openPinItem()
    expect(item).toHaveTextContent('Pin base instance')

    await user.click(item)

    await waitFor(() => {
      expect(request).toHaveBeenCalledWith('connectionOps.setPinned', {
        connectionId: BASE_CONN,
        pinned: true
      })
    })
    expect(request).not.toHaveBeenCalledWith('db.worktree.setPinned', expect.anything())
    expect(usePinnedStore.getState().pinnedConnectionIds.has(BASE_CONN)).toBe(true)
  })
})

import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { KanbanTicket } from '../../src/main/db/types'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { usePinnedStore } from '@/stores/usePinnedStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

const mockKanban = {
  ticket: {
    getByProject: vi.fn()
  },
  dependency: {
    getForProject: vi.fn()
  }
}

const mockConnectionOps = {
  getAll: vi.fn(),
  getPinned: vi.fn()
}

const mockDb = {
  worktree: {
    getPinned: vi.fn()
  }
}

Object.defineProperty(window, 'kanban', {
  writable: true,
  configurable: true,
  value: mockKanban
})

Object.defineProperty(window, 'connectionOps', {
  writable: true,
  configurable: true,
  value: mockConnectionOps
})

Object.defineProperty(window, 'db', {
  writable: true,
  configurable: true,
  value: mockDb
})

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: 'proj-1',
    title: 'Startup ticket',
    description: null,
    attachments: [],
    column: 'todo',
    sort_order: 0,
    current_session_id: null,
    worktree_id: null,
    mode: null,
    plan_ready: false,
    created_at: '2026-05-05T00:00:00.000Z',
    updated_at: '2026-05-05T00:00:00.000Z',
    archived_at: null,
    external_provider: null,
    external_id: null,
    external_url: null,
    github_pr_number: null,
    github_pr_url: null,
    mark: null,
    total_tokens: 0,
    pending_launch_config: null,
    ...overrides
  }
}

const connection = {
  id: 'conn-1',
  name: 'Connection One',
  custom_name: null,
  status: 'active',
  path: '/tmp/conn-1',
  color: null,
  created_at: '2026-05-05T00:00:00.000Z',
  updated_at: '2026-05-05T00:00:00.000Z',
  members: [
    {
      id: 'member-1',
      connection_id: 'conn-1',
      worktree_id: 'wt-1',
      project_id: 'proj-1',
      symlink_name: 'wt-1',
      added_at: '2026-05-05T00:00:00.000Z',
      worktree_name: 'Worktree One',
      worktree_branch: 'main',
      worktree_path: '/tmp/proj-1/wt-1',
      project_name: 'Project One'
    }
  ]
}

const pinnedWorktree = {
  id: 'wt-1',
  project_id: 'proj-1',
  name: 'Worktree One',
  branch_name: 'main',
  path: '/tmp/proj-1/wt-1',
  status: 'active',
  is_default: false,
  branch_renamed: 0,
  last_message_at: null,
  session_titles: '[]',
  last_model_provider_id: null,
  last_model_id: null,
  last_model_variant: null,
  created_at: '2026-05-05T00:00:00.000Z',
  last_accessed_at: '2026-05-05T00:00:00.000Z',
  github_pr_number: null,
  github_pr_url: null
}

describe('aggregate kanban board startup hydration', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    useKanbanStore.setState({
      tickets: new Map(),
      isLoading: false,
      showArchivedByProject: {},
      dependencyMap: new Map()
    })
    useConnectionStore.setState({
      connections: [],
      isLoading: false,
      error: null,
      selectedConnectionId: null,
      loaded: false
    } as never)
    usePinnedStore.setState({
      loaded: false,
      pinnedWorktreeIds: new Set(),
      pinnedConnectionIds: new Set(),
      pinnedProjectIds: new Set()
    })
    useWorktreeStore.setState({
      worktreesByProject: new Map([['proj-1', [pinnedWorktree]]])
    } as never)

    mockKanban.ticket.getByProject.mockResolvedValue([makeTicket()])
    mockKanban.dependency.getForProject.mockResolvedValue([])
    mockConnectionOps.getAll.mockResolvedValue({ success: true, connections: [connection] })
    mockConnectionOps.getPinned.mockResolvedValue([])
    mockDb.worktree.getPinned.mockResolvedValue([pinnedWorktree])
  })

  test('loadTicketsForConnection hydrates connections and retries when called before connections load', async () => {
    await useKanbanStore.getState().loadTicketsForConnection('conn-1')

    expect(mockConnectionOps.getAll).toHaveBeenCalledTimes(1)
    expect(mockKanban.ticket.getByProject).toHaveBeenCalledWith('proj-1', false)
    expect(useKanbanStore.getState().tickets.get('proj-1')).toEqual([makeTicket()])
  })

  test('loadTicketsForPinnedProjects hydrates pinned state and retries when called before pinned projects load', async () => {
    await useKanbanStore.getState().loadTicketsForPinnedProjects()

    expect(mockDb.worktree.getPinned).toHaveBeenCalledTimes(1)
    expect(mockKanban.ticket.getByProject).toHaveBeenCalledWith('proj-1', false)
    expect(useKanbanStore.getState().tickets.get('proj-1')).toEqual([makeTicket()])
  })
})

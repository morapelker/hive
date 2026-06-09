import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { KanbanTicket } from '../../src/main/db/types'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { usePinnedStore } from '@/stores/usePinnedStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

vi.mock('@/api/settings-api', () => ({
  settingsApi: {
    onSettingsUpdated: vi.fn(() => vi.fn())
  }
}))

vi.mock('@/api/pet-api', () => ({
  petApi: {
    updateSettings: vi.fn()
  }
}))

let request: ReturnType<typeof vi.fn>

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
    resetRendererRpcClientForTests()
    request = vi.fn(async (method: string) => {
      if (method === 'db.worktree.getPinned') return [pinnedWorktree]
      if (method === 'connectionOps.getAll') return { success: true, connections: [connection] }
      if (method === 'connectionOps.getPinned') return []
      if (method === 'kanban.ticket.getByProject') return [makeTicket()]
      if (method === 'kanban.dependency.getForProject') return []
      return null
    })
    setRendererRpcClient({ request, subscribe: vi.fn() })

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
  })

  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  test('loadTicketsForConnection hydrates connections and retries when called before connections load', async () => {
    await useKanbanStore.getState().loadTicketsForConnection('conn-1')

    expect(request).toHaveBeenCalledWith('connectionOps.getAll', {})
    expect(request).toHaveBeenCalledWith('kanban.ticket.getByProject', {
      projectId: 'proj-1',
      includeArchived: false
    })
    expect(useKanbanStore.getState().tickets.get('proj-1')).toEqual([makeTicket()])
  })

  test('loadTicketsForPinnedProjects hydrates pinned state and retries when called before pinned projects load', async () => {
    await useKanbanStore.getState().loadTicketsForPinnedProjects()

    expect(request).toHaveBeenCalledWith('db.worktree.getPinned', {})
    expect(request).toHaveBeenCalledWith('connectionOps.getPinned', {})
    expect(request).toHaveBeenCalledWith('kanban.ticket.getByProject', {
      projectId: 'proj-1',
      includeArchived: false
    })
    expect(useKanbanStore.getState().tickets.get('proj-1')).toEqual([makeTicket()])
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'

vi.mock('@/api/settings-api', () => ({
  settingsApi: { onSettingsUpdated: vi.fn(() => vi.fn()) }
}))
vi.mock('@/api/pet-api', () => ({
  petApi: { updateSettings: vi.fn() }
}))
vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn() }
}))

const worktreeStoreMocks = vi.hoisted(() => ({
  selectWorktreeOnly: vi.fn(),
  loadWorktrees: vi.fn()
}))
vi.mock('./useWorktreeStore', () => ({
  useWorktreeStore: {
    getState: vi.fn(() => ({
      worktreesByProject: new Map(),
      loadWorktrees: worktreeStoreMocks.loadWorktrees,
      selectWorktreeOnly: worktreeStoreMocks.selectWorktreeOnly
    }))
  },
  fireSetupScript: vi.fn()
}))
vi.mock('./useKanbanStore', () => ({
  useKanbanStore: {
    getState: vi.fn(() => ({ isPinnedBoardActive: false, togglePinnedBoard: vi.fn() }))
  }
}))

const projectStoreMocks = vi.hoisted(() => ({
  selectProject: vi.fn(),
  setState: vi.fn(),
  state: { projects: [] as unknown[], expandedProjectIds: new Set<string>() }
}))
vi.mock('./useProjectStore', () => ({
  useProjectStore: {
    getState: vi.fn(() => ({ ...projectStoreMocks.state, selectProject: projectStoreMocks.selectProject })),
    setState: projectStoreMocks.setState
  }
}))

import { useConnectionStore } from './useConnectionStore'
import { usePinnedStore } from './usePinnedStore'

const PROJECT_ID = 'saved-project-1'

const makeConnection = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: 'a + b',
  custom_name: null,
  status: 'active' as const,
  path: `/tmp/connections/${id}`,
  color: null,
  pinned: 0,
  saved_project_id: null as string | null,
  is_base: 0,
  created_at: '2026-01-01',
  updated_at: '2026-01-01',
  members: [],
  ...extra
})

const project = { id: PROJECT_ID, name: 'a + b', kind: 'connection', path: '/tmp/cp/x' }

describe('useConnectionStore.saveConnectionAsProject', () => {
  let request: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    request = vi.fn(async (method: string) => {
      if (method === 'connectionOps.saveAsProject') {
        return {
          success: true,
          project,
          connection: makeConnection('source', { saved_project_id: PROJECT_ID }),
          baseConnection: makeConnection('base', { saved_project_id: PROJECT_ID, is_base: 1 })
        }
      }
      if (method === 'db.worktree.getPinned') return []
      if (method === 'connectionOps.getPinned') {
        // Server view after the save: the (pinned) source is now an instance
        return [makeConnection('source', { saved_project_id: PROJECT_ID, pinned: 1 })]
      }
      return null
    })
    setRendererRpcClient({ request, subscribe: vi.fn() })
    useConnectionStore.setState({
      connections: [makeConnection('source'), makeConnection('other')],
      selectedConnectionId: 'source'
    })
    usePinnedStore.setState({
      pinnedConnectionIds: new Set(),
      pinnedWorktreeIds: new Set(),
      pinnedProjectIds: new Set(),
      loaded: true
    })
  })

  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  it('links the source, inserts the base instance locally and selects the new project', async () => {
    const id = await useConnectionStore.getState().saveConnectionAsProject('source')
    expect(id).toBe(PROJECT_ID)

    const connections = useConnectionStore.getState().connections
    expect(connections.find((c) => c.id === 'source')?.saved_project_id).toBe(PROJECT_ID)
    const base = connections.find((c) => c.id === 'base')
    expect(base?.is_base).toBe(1)
    expect(base?.saved_project_id).toBe(PROJECT_ID)
    expect(connections.find((c) => c.id === 'other')?.saved_project_id).toBeNull()

    // Board-first: project selected, connection/worktree selection cleared
    expect(projectStoreMocks.selectProject).toHaveBeenCalledWith(PROJECT_ID)
    expect(useConnectionStore.getState().selectedConnectionId).toBeNull()
    expect(worktreeStoreMocks.selectWorktreeOnly).toHaveBeenCalledWith(null)
    // Source was not pinned → no pinned refetch
    expect(request).not.toHaveBeenCalledWith('connectionOps.getPinned', expect.anything())
  })

  it('does not duplicate an already-present base instance', async () => {
    useConnectionStore.setState({
      connections: [
        makeConnection('source'),
        makeConnection('base', { saved_project_id: PROJECT_ID, is_base: 1 })
      ]
    })

    await useConnectionStore.getState().saveConnectionAsProject('source')

    expect(useConnectionStore.getState().connections.filter((c) => c.id === 'base')).toHaveLength(1)
  })

  it('refreshes the pinned scope when the source connection was already pinned', async () => {
    usePinnedStore.setState({ pinnedConnectionIds: new Set(['source']) })

    await useConnectionStore.getState().saveConnectionAsProject('source')
    // loadPinned is fire-and-forget — let it settle
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    expect(request).toHaveBeenCalledWith('connectionOps.getPinned', expect.anything())
    expect(usePinnedStore.getState().pinnedProjectIds.has(PROJECT_ID)).toBe(true)
  })

  it('surfaces a failed save without touching local state', async () => {
    request.mockImplementation(async (method: string) =>
      method === 'connectionOps.saveAsProject' ? { success: false, error: 'nope' } : null
    )

    const id = await useConnectionStore.getState().saveConnectionAsProject('source')

    expect(id).toBeNull()
    expect(useConnectionStore.getState().connections.find((c) => c.id === 'source')?.saved_project_id).toBeNull()
    expect(useConnectionStore.getState().connections.some((c) => c.id === 'base')).toBe(false)
  })
})

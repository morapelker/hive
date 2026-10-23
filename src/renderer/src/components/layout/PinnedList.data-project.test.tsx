// Pinned data projects (database connections) in the sidebar's Pinned list: listed with or
// without pinned worktrees, counted in the header, and one click opens the database client in
// front of the Pinned Board. A pinned connection row clicked while the open database client has
// staged table edits asks before anything changes.

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setRendererRpcClient } from '@/api/rpc-client'
import { TooltipProvider } from '@/components/ui/tooltip'
import { sampleDataProject } from '@/components/data-projects/data-project.sample'

vi.mock('@/api/settings-api', () => ({
  settingsApi: { onSettingsUpdated: vi.fn(() => vi.fn()) }
}))
vi.mock('@/api/pet-api', () => ({ petApi: { updateSettings: vi.fn() } }))

const { PinnedList } = await import('./PinnedList')
const { usePinnedStore } = await import('@/stores/usePinnedStore')
const { useDataProjectStore } = await import('@/stores/useDataProjectStore')
const { useKanbanStore } = await import('@/stores/useKanbanStore')
const { useConnectionStore } = await import('@/stores/useConnectionStore')
const { useDataWorkspaceStore } = await import('@/stores/useDataWorkspaceStore')

const initialPinned = usePinnedStore.getState()
const initialKanban = useKanbanStore.getState()
const initialConnection = useConnectionStore.getState()
let pinnedConnections: Array<Record<string, unknown>> = []

beforeEach(() => {
  setRendererRpcClient({
    request: (async (method: string) => {
      if (method === 'db.worktree.getPinned') return []
      if (method === 'connectionOps.getPinned') return pinnedConnections
      return undefined
    }) as never,
    subscribe: () => () => {}
  })
  useDataProjectStore.getState().reset()
  usePinnedStore.setState({
    pinnedWorktreeIds: new Set(),
    pinnedConnectionIds: new Set(),
    pinnedProjectIds: new Set(),
    loaded: true
  })
})

afterEach(() => {
  cleanup()
  pinnedConnections = []
  usePinnedStore.setState(initialPinned, true)
  useKanbanStore.setState(initialKanban, true)
  useConnectionStore.setState(initialConnection, true)
  useDataWorkspaceStore.getState().reset()
})

const renderList = async (): Promise<void> => {
  await act(async () => {
    render(
      <TooltipProvider>
        <PinnedList />
      </TooltipProvider>
    )
  })
}

describe('PinnedList with data projects', () => {
  it('renders nothing when nothing is pinned', async () => {
    useDataProjectStore.setState({ projects: [sampleDataProject({ pinned: false })] })
    await renderList()
    expect(screen.queryByTestId('pinned-list')).not.toBeInTheDocument()
  })

  it('lists a pinned database on its own and opens it over the Pinned Board', async () => {
    useKanbanStore.setState({ isPinnedBoardActive: true, isPinnedBoardBehindSession: false })
    useDataProjectStore.setState({
      projects: [
        sampleDataProject({ pinned: true }),
        sampleDataProject({ id: 'dp-2', pinned: false })
      ]
    })
    await renderList()

    expect(screen.getByTestId('pinned-list')).toBeInTheDocument()
    expect(screen.getByTestId('pinned-data-project-dp-1')).toBeInTheDocument()
    expect(screen.queryByTestId('pinned-data-project-dp-2')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('pinned-data-project-dp-1'))
    expect(useDataProjectStore.getState().selectedDataProjectId).toBe('dp-1')
    expect(useKanbanStore.getState().isPinnedBoardActive).toBe(true)
    expect(useKanbanStore.getState().isPinnedBoardBehindSession).toBe(true)
  })
})

describe('PinnedList rows while a database has staged edits', () => {
  it('asks before a pinned connection replaces the database client', async () => {
    const connection = {
      id: 'c-1',
      name: 'feature',
      custom_name: null,
      status: 'active',
      path: '/tmp/c-1',
      color: null,
      saved_project_id: null,
      is_base: 0,
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
      members: []
    }
    pinnedConnections = [connection]
    usePinnedStore.setState({ pinnedConnectionIds: new Set(['c-1']) })
    useConnectionStore.setState({ connections: [connection] as never })
    useDataProjectStore.setState({ projects: [sampleDataProject()] })
    useDataProjectStore.getState().select('dp-1')
    const workspace = useDataWorkspaceStore.getState()
    workspace.setStagedEditCount(workspace.openTable('dp-1', { name: 'users' }), 2)
    const unregister = workspace.registerDiscardHost('dp-1')
    try {
      await renderList()
      // The data store's reference to the workspace chunk is in place by now.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })

      fireEvent.click(screen.getByTestId('pinned-connection-c-1'))
      const asked = useDataWorkspaceStore.getState().discardRequest
      expect(asked?.count).toBe(2)
      // Nothing changed yet.
      expect(useConnectionStore.getState().selectedConnectionId).toBeNull()
      expect(useDataProjectStore.getState().selectedDataProjectId).toBe('dp-1')

      await act(async () => {
        useDataWorkspaceStore.getState().answerDiscardEdits(asked!.id, false)
      })
      expect(useConnectionStore.getState().selectedConnectionId).toBeNull()
      expect(useDataProjectStore.getState().selectedDataProjectId).toBe('dp-1')

      fireEvent.click(screen.getByTestId('pinned-connection-c-1'))
      await act(async () => {
        const request = useDataWorkspaceStore.getState().discardRequest
        useDataWorkspaceStore.getState().answerDiscardEdits(request!.id, true)
      })
      expect(useConnectionStore.getState().selectedConnectionId).toBe('c-1')
      expect(useDataProjectStore.getState().selectedDataProjectId).toBeNull()
    } finally {
      unregister()
    }
  })
})

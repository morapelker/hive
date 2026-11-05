import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { TooltipProvider } from '@/components/ui/tooltip'

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

import { PinnedList } from './PinnedList'
import { usePinnedStore } from '@/stores/usePinnedStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

type Connection = ReturnType<typeof useConnectionStore.getState>['connections'][number]
type Project = ReturnType<typeof useProjectStore.getState>['projects'][number]
type Worktree = NonNullable<
  ReturnType<ReturnType<typeof useWorktreeStore.getState>['worktreesByProject']['get']>
>[number]

const gitProject = {
  id: 'proj-git',
  name: 'git-proj',
  path: '/tmp/git-proj'
} as unknown as Project

const connectionProject = {
  id: 'proj-conn',
  name: 'conn-proj',
  kind: 'connection'
} as unknown as Project

const featureWorktree = {
  id: 'wt-feature',
  project_id: 'proj-git',
  name: 'feature',
  branch_name: 'feature',
  path: '/tmp/git-proj-feature',
  status: 'active',
  is_default: false,
  created_at: '2026-01-01',
  last_accessed_at: '2026-01-01',
  attachments: '[]'
} as unknown as Worktree

const baseConnection = {
  id: 'conn-base',
  name: 'connection',
  custom_name: null,
  status: 'active',
  path: '/tmp/conn',
  color: null,
  saved_project_id: 'proj-conn',
  is_base: 1,
  created_at: '2026-01-01',
  updated_at: '2026-01-01',
  members: []
} as unknown as Connection

const member = (projectId: string, worktreeId: string) => ({
  connection_id: 'conn-adhoc',
  worktree_id: worktreeId,
  project_id: projectId,
  symlink_name: projectId,
  worktree_name: 'main',
  worktree_branch: 'main',
  worktree_path: `/tmp/${projectId}`,
  project_name: projectId
})

// An ad-hoc connection (no project) spanning two member projects
const adHocConnection = {
  id: 'conn-adhoc',
  name: 'web + api',
  custom_name: null,
  status: 'active',
  path: '/tmp/conn-adhoc',
  color: null,
  saved_project_id: null,
  is_base: 0,
  created_at: '2026-01-01',
  updated_at: '2026-01-01',
  members: [member('web', 'wt-web'), member('api', 'wt-api')]
} as unknown as Connection

// Role queries cost seconds per call on this tree under jsdom: read the menu with selectors
const menuItems = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))

const menuItemNames = (): string[] => menuItems().map((item) => item.textContent ?? '')

// floating-ui probes every positioned element with matches(':popover-open') and
// matches(':modal'). jsdom's selector engine does not know them and recurses until the
// stack overflows before throwing, which costs seconds per opened menu. Answer the two
// probes directly (false is what the fallback returns anyway).
const TOP_LAYER_PROBES = new Set([':popover-open', ':modal'])
const originalMatches = Element.prototype.matches

const initialFlowState = useDocumentFlowStore.getState()
const initialConnectionState = useConnectionStore.getState()

beforeAll(() => {
  Element.prototype.matches = function (this: Element, selectors: string): boolean {
    return TOP_LAYER_PROBES.has(selectors) ? false : originalMatches.call(this, selectors)
  }
})

afterAll(() => {
  Element.prototype.matches = originalMatches
})

describe('PinnedList implement document', () => {
  beforeEach(() => {
    setRendererRpcClient({
      request: async <T,>(method: string): Promise<T> => {
        if (method === 'db.worktree.getPinned') return [featureWorktree] as T
        if (method === 'connectionOps.getPinned') return [baseConnection, adHocConnection] as T
        return null as T
      },
      subscribe: () => () => {}
    })

    usePinnedStore.setState({
      pinnedWorktreeIds: new Set(['wt-feature']),
      pinnedConnectionIds: new Set(['conn-base', 'conn-adhoc']),
      pinnedProjectIds: new Set(['proj-conn']),
      loaded: true
    })
    useConnectionStore.setState({
      connections: [baseConnection, adHocConnection],
      connectionModeActive: false
    })
    useProjectStore.setState({ projects: [gitProject, connectionProject] })
    useWorktreeStore.setState({
      worktreesByProject: new Map([['proj-git', [featureWorktree]]])
    })
  })

  afterEach(() => {
    cleanup()
    resetRendererRpcClientForTests()
    useDocumentFlowStore.setState(initialFlowState, true)
    useConnectionStore.setState(initialConnectionState, true)
  })

  async function renderList(): Promise<void> {
    render(
      <TooltipProvider>
        <PinnedList />
      </TooltipProvider>
    )
    // Flush the mount-effect loadPinned() so its state update lands inside act
    await act(async () => {})
  }

  it("opens the wizard for the pinned worktree's project", async () => {
    await renderList()

    // Radix renders the items synchronously on contextmenu
    fireEvent.contextMenu(screen.getByTestId('pinned-worktree-wt-feature'))

    const item = menuItems().find((entry) => entry.textContent === 'Implement Document…')
    expect(item).toBeDefined()
    fireEvent.click(item as HTMLElement)

    expect(useDocumentFlowStore.getState().wizard).toEqual({
      open: true,
      projectId: 'proj-git',
      runId: null
    })
  })

  it("opens the wizard for a pinned instance's connection project", async () => {
    await renderList()

    fireEvent.contextMenu(screen.getByTestId('pinned-connection-conn-base'))

    expect(menuItemNames()).toContain('Implement Document…')
    fireEvent.click(screen.getByTestId('docflow-pinned-connection-menu-item'))

    expect(useDocumentFlowStore.getState().wizard).toEqual({
      open: true,
      projectId: 'proj-conn',
      runId: null
    })
  })

  it('saves a pinned ad-hoc connection as a project, then opens the wizard on it', async () => {
    const saveConnectionAsProject = vi.fn(async () => 'proj-new')
    useConnectionStore.setState({ saveConnectionAsProject })
    await renderList()

    fireEvent.contextMenu(screen.getByTestId('pinned-connection-conn-adhoc'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('docflow-pinned-connection-menu-item'))
    })

    expect(saveConnectionAsProject).toHaveBeenCalledWith('conn-adhoc')
    expect(useDocumentFlowStore.getState().wizard).toEqual({
      open: true,
      projectId: 'proj-new',
      runId: null
    })
  })

  it('offers "Orchestrate tickets…" next to it on a pinned worktree', async () => {
    await renderList()

    fireEvent.contextMenu(screen.getByTestId('pinned-worktree-wt-feature'))
    const names = menuItemNames()
    expect(names[names.indexOf('Implement Document…') + 1]).toBe('Orchestrate tickets…')
    fireEvent.click(screen.getByTestId('docflow-orchestrate-pinned-worktree-menu-item'))

    expect(useDocumentFlowStore.getState().wizard).toEqual({
      open: true,
      projectId: 'proj-git',
      runId: null,
      source: 'tickets'
    })
  })

  it('offers "Orchestrate tickets…" on a pinned ad-hoc connection, saved as a project first', async () => {
    const saveConnectionAsProject = vi.fn(async () => 'proj-new')
    useConnectionStore.setState({ saveConnectionAsProject })
    await renderList()

    fireEvent.contextMenu(screen.getByTestId('pinned-connection-conn-adhoc'))
    const names = menuItemNames()
    expect(names[names.indexOf('Implement Document…') + 1]).toBe('Orchestrate tickets…')
    await act(async () => {
      fireEvent.click(screen.getByTestId('docflow-orchestrate-pinned-connection-menu-item'))
    })

    expect(saveConnectionAsProject).toHaveBeenCalledWith('conn-adhoc')
    expect(useDocumentFlowStore.getState().wizard).toEqual({
      open: true,
      projectId: 'proj-new',
      runId: null,
      source: 'tickets'
    })
  })

  it('has no such item on a pinned ad-hoc connection within a single project', async () => {
    const single = {
      ...adHocConnection,
      members: [member('web', 'wt-web'), member('web', 'wt-web-2')]
    } as unknown as Connection
    useConnectionStore.setState({ connections: [baseConnection, single] })
    await renderList()

    fireEvent.contextMenu(screen.getByTestId('pinned-connection-conn-adhoc'))

    const names = menuItemNames()
    expect(names.length).toBeGreaterThan(0)
    expect(names).not.toContain('Implement Document…')
    expect(names).not.toContain('Orchestrate tickets…')
  })
})

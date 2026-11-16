// Opening a project from the "Go to project" switcher while a database has unsaved (staged)
// table edits asks first, like every other way of leaving it: "Keep editing" changes nothing,
// "Discard" opens what was picked. With nothing staged it happens at once.
//
// Opening also puts the project where the sidebar shows it first: on top of "All projects",
// opened "now" for the Recent section, and scrolled to.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { sampleDataProject, sampleGitProject } from '@/components/data-projects/data-project.sample'

const api = vi.hoisted(() => ({
  touch: vi.fn(),
  update: vi.fn(),
  reorderSidebar: vi.fn(),
  status: vi.fn(),
  onStatus: vi.fn()
}))
vi.mock('@/api/data-projects-api', () => ({ dataProjectsApi: api }))
const reveal = vi.hoisted(() => ({ revealProjectInSidebar: vi.fn() }))
vi.mock('@/lib/sidebar-reveal', () => reveal)
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
}))

const { setRendererRpcClient } = await import('@/api/rpc-client')
const { useDataProjectStore } = await import('@/stores/useDataProjectStore')
const { useDataWorkspaceStore } = await import('@/stores/useDataWorkspaceStore')
const { useProjectStore } = await import('@/stores/useProjectStore')
const { useWorktreeStore } = await import('@/stores/useWorktreeStore')
const { useConnectionStore } = await import('@/stores/useConnectionStore')
const { useKanbanStore } = await import('@/stores/useKanbanStore')
const { mergeSidebarEntries } = await import('@/lib/project-filter')
const { openSwitcherProject } = await import('./open-switcher-project')

const initialProjectState = useProjectStore.getState()
const initialWorktreeState = useWorktreeStore.getState()
const initialConnectionState = useConnectionStore.getState()
const initialKanbanState = useKanbanStore.getState()

const workspace = () => useDataWorkspaceStore.getState()
const selectedDatabase = () => useDataProjectStore.getState().selectedDataProjectId
/** The sidebar's "All projects" order, top to bottom. */
const sidebarOrder = (): string[] =>
  mergeSidebarEntries(
    useProjectStore.getState().projects,
    useDataProjectStore.getState().projects
  ).map((entry) => entry.id)
const rpcRequest = vi.fn(async () => undefined)
let unregisterHost: (() => void) | null = null

/** `db-a` is open with three staged edits in a table tab, and its view can ask. */
function openDatabaseWithStagedEdits(): void {
  useDataProjectStore.getState().select('db-a')
  const tab = workspace().openTable('db-a', { name: 'users' })
  workspace().setStagedEditCount(tab, 3)
  unregisterHost = workspace().registerDiscardHost('db-a')
}

async function answer(discard: boolean): Promise<void> {
  const request = workspace().discardRequest
  if (!request) throw new Error('nothing was asked')
  workspace().answerDiscardEdits(request.id, discard)
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeAll(async () => {
  // The data store keeps a reference to the lazily imported workspace chunk.
  await new Promise((resolve) => setTimeout(resolve, 0))
})

beforeEach(() => {
  vi.clearAllMocks()
  rpcRequest.mockImplementation(async () => undefined)
  api.touch.mockResolvedValue(undefined)
  api.reorderSidebar.mockResolvedValue(undefined)
  setRendererRpcClient({
    request: rpcRequest as never,
    subscribe: () => () => {}
  })
  useDataProjectStore.getState().reset()
  useDataProjectStore.setState({
    projects: [
      sampleDataProject({ id: 'db-a', name: 'orders-db' }),
      sampleDataProject({ id: 'db-b', name: 'events-db', sortOrder: 1 })
    ]
  })
  useProjectStore.setState({ projects: [sampleGitProject('ledger-worker', 2)] as never })
  workspace().reset()
})

afterEach(() => {
  unregisterHost?.()
  unregisterHost = null
  useProjectStore.setState(initialProjectState, true)
  useWorktreeStore.setState(initialWorktreeState, true)
  useConnectionStore.setState(initialConnectionState, true)
  useKanbanStore.setState(initialKanbanState, true)
})

describe('opening a database from the switcher', () => {
  it('opens its client at once when nothing is staged', () => {
    useProjectStore.setState({ selectedProjectId: 'ledger-worker' })
    openSwitcherProject({ kind: 'data', id: 'db-b' })
    expect(selectedDatabase()).toBe('db-b')
    expect(useProjectStore.getState().selectedProjectId).toBeNull()
    expect(workspace().discardRequest).toBeNull()
  })

  it('keeps the Pinned Board on, behind the client, so Cmd+P returns to it', () => {
    useKanbanStore.setState({ isPinnedBoardActive: true, isPinnedBoardBehindSession: false })
    openSwitcherProject({ kind: 'data', id: 'db-a' })
    expect(selectedDatabase()).toBe('db-a')
    expect(useKanbanStore.getState().isPinnedBoardActive).toBe(true)
    expect(useKanbanStore.getState().isPinnedBoardBehindSession).toBe(true)
  })

  it('asks first when another database has unsaved edits', async () => {
    openDatabaseWithStagedEdits()

    openSwitcherProject({ kind: 'data', id: 'db-b' })
    expect(workspace().discardRequest?.count).toBe(3)
    expect(selectedDatabase()).toBe('db-a')
    await answer(false)
    expect(selectedDatabase()).toBe('db-a')
    expect(workspace().pendingEditCount('db-a')).toBe(3)

    openSwitcherProject({ kind: 'data', id: 'db-b' })
    await answer(true)
    expect(selectedDatabase()).toBe('db-b')
  })
})

describe('opening a git project from the switcher over a database', () => {
  it('replaces the client at once when nothing is staged', () => {
    useDataProjectStore.getState().select('db-a')
    openSwitcherProject({ kind: 'git', id: 'ledger-worker' })
    expect(useProjectStore.getState().selectedProjectId).toBe('ledger-worker')
    expect(selectedDatabase()).toBeNull()
  })

  it('asks first when the database has unsaved edits', async () => {
    openDatabaseWithStagedEdits()

    openSwitcherProject({ kind: 'git', id: 'ledger-worker' })
    expect(workspace().discardRequest?.count).toBe(3)
    await answer(false)
    expect(useProjectStore.getState().selectedProjectId).toBeNull()
    expect(selectedDatabase()).toBe('db-a')

    openSwitcherProject({ kind: 'git', id: 'ledger-worker' })
    await answer(true)
    expect(useProjectStore.getState().selectedProjectId).toBe('ledger-worker')
    expect(selectedDatabase()).toBeNull()
  })
})

describe('what a project opened from the switcher shows', () => {
  const worktree = (id: string, projectId: string, isDefault = false) =>
    ({
      id,
      project_id: projectId,
      name: isDefault ? '(no-worktree)' : id,
      branch_name: isDefault ? 'main' : id,
      path: `/repo/${projectId}/${id}`,
      status: 'active',
      is_default: isDefault,
      created_at: '2026-03-01T00:00:00.000Z',
      last_accessed_at: '2026-03-01T00:00:00.000Z'
    }) as never
  const withStack = (): void => {
    useProjectStore.setState({
      projects: [
        sampleGitProject('ledger-worker', 2),
        sampleGitProject('stack', 3, { kind: 'connection' })
      ] as never
    })
  }
  const settle = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0))

  it('opens a git project on its base branch, as a click on its "(no-worktree)" row does', () => {
    useWorktreeStore.setState({
      worktreesByProject: new Map([
        [
          'ledger-worker',
          [worktree('wt-feature', 'ledger-worker'), worktree('wt-main', 'ledger-worker', true)]
        ]
      ]),
      loadedProjectIds: new Set(['ledger-worker']),
      selectedWorktreeId: 'wt-other'
    })
    useConnectionStore.setState({ selectedConnectionId: 'conn-1' })
    useKanbanStore.setState({ isPinnedBoardActive: true })

    openSwitcherProject({ kind: 'git', id: 'ledger-worker' })

    expect(useProjectStore.getState().selectedProjectId).toBe('ledger-worker')
    expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-main')
    expect(useConnectionStore.getState().selectedConnectionId).toBeNull()
    expect(useKanbanStore.getState().isPinnedBoardActive).toBe(false)
    expect(rpcRequest).toHaveBeenCalledWith('db.worktree.touch', { id: 'wt-main' })
  })

  it('reads the worktrees of a project that was never expanded, then selects its base branch', async () => {
    rpcRequest.mockImplementation((async (method: string) =>
      method === 'db.worktree.getActiveByProject'
        ? [worktree('wt-main', 'ledger-worker', true)]
        : undefined) as never)
    useWorktreeStore.setState({ selectedWorktreeId: 'wt-other' })

    openSwitcherProject({ kind: 'git', id: 'ledger-worker' })
    await settle()

    expect(useProjectStore.getState().selectedProjectId).toBe('ledger-worker')
    expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-main')
  })

  it('expands the project in the sidebar, and leaves the others as they are', () => {
    useProjectStore.setState({ expandedProjectIds: new Set(['other']) })

    openSwitcherProject({ kind: 'git', id: 'ledger-worker' })

    expect([...useProjectStore.getState().expandedProjectIds].sort()).toEqual([
      'ledger-worker',
      'other'
    ])
  })

  it('never collapses a project that is already expanded', () => {
    useProjectStore.setState({ expandedProjectIds: new Set(['ledger-worker']) })

    openSwitcherProject({ kind: 'git', id: 'ledger-worker' })
    openSwitcherProject({ kind: 'git', id: 'ledger-worker' })

    expect(useProjectStore.getState().expandedProjectIds.has('ledger-worker')).toBe(true)
  })

  it('expands a connection project too', () => {
    withStack()

    openSwitcherProject({ kind: 'connection', id: 'stack' })

    expect(useProjectStore.getState().expandedProjectIds.has('stack')).toBe(true)
  })

  it('expands no project for a database', () => {
    const expandedBefore = useProjectStore.getState().expandedProjectIds

    openSwitcherProject({ kind: 'data', id: 'db-a' })

    expect(useProjectStore.getState().expandedProjectIds).toBe(expandedBefore)
  })

  it('opens a connection project on its base instance', () => {
    withStack()
    useConnectionStore.setState({
      connections: [
        { id: 'conn-feature', saved_project_id: 'stack', is_base: 0, members: [] },
        { id: 'conn-base', saved_project_id: 'stack', is_base: 1, members: [] }
      ] as never,
      selectedConnectionId: 'conn-feature'
    })
    useWorktreeStore.setState({ selectedWorktreeId: 'wt-other' })

    openSwitcherProject({ kind: 'connection', id: 'stack' })

    expect(useProjectStore.getState().selectedProjectId).toBe('stack')
    expect(useConnectionStore.getState().selectedConnectionId).toBe('conn-base')
    expect(useWorktreeStore.getState().selectedWorktreeId).toBeNull()
  })

  it('opens a connection project with no base instance on its own board', async () => {
    withStack()
    rpcRequest.mockImplementation((async (method: string) =>
      method === 'connectionOps.getAll' ? { success: true, connections: [] } : undefined) as never)
    useConnectionStore.setState({ selectedConnectionId: 'conn-1' })
    useWorktreeStore.setState({ selectedWorktreeId: 'wt-other' })

    openSwitcherProject({ kind: 'connection', id: 'stack' })
    await settle()

    expect(useProjectStore.getState().selectedProjectId).toBe('stack')
    expect(useConnectionStore.getState().selectedConnectionId).toBeNull()
    expect(useWorktreeStore.getState().selectedWorktreeId).toBeNull()
  })
})

describe('where the sidebar shows the opened project', () => {
  it('moves a git project to the top of All projects and stores the order', () => {
    expect(sidebarOrder()).toEqual(['db-a', 'db-b', 'ledger-worker'])
    openSwitcherProject({ kind: 'git', id: 'ledger-worker' })
    expect(sidebarOrder()).toEqual(['ledger-worker', 'db-a', 'db-b'])
    expect(api.reorderSidebar).toHaveBeenCalledWith([
      { kind: 'project', id: 'ledger-worker' },
      { kind: 'data', id: 'db-a' },
      { kind: 'data', id: 'db-b' }
    ])
  })

  it('moves a database to the top of All projects', () => {
    openSwitcherProject({ kind: 'data', id: 'db-b' })
    expect(sidebarOrder()).toEqual(['db-b', 'db-a', 'ledger-worker'])
    expect(api.reorderSidebar).toHaveBeenCalledTimes(1)
  })

  it('stores nothing when the project leads the list already', () => {
    openSwitcherProject({ kind: 'data', id: 'db-a' })
    expect(sidebarOrder()).toEqual(['db-a', 'db-b', 'ledger-worker'])
    expect(api.reorderSidebar).not.toHaveBeenCalled()
  })

  it('reorders the git projects alone when there are no databases', () => {
    useDataProjectStore.setState({ projects: [] })
    useProjectStore.setState({
      projects: [
        sampleGitProject('ads-api', 0),
        sampleGitProject('ledger-worker', 1),
        sampleGitProject('orders-web', 2)
      ] as never
    })
    openSwitcherProject({ kind: 'git', id: 'orders-web' })
    expect(sidebarOrder()).toEqual(['orders-web', 'ads-api', 'ledger-worker'])
    expect(rpcRequest).toHaveBeenCalledWith('db.project.reorder', {
      orderedIds: ['orders-web', 'ads-api', 'ledger-worker']
    })
    expect(api.reorderSidebar).not.toHaveBeenCalled()
  })

  it('records the opening at once, so Recent has the project in the same render', () => {
    const before = Date.now()
    openSwitcherProject({ kind: 'git', id: 'ledger-worker' })
    const git = useProjectStore.getState().projects.find((p) => p.id === 'ledger-worker')
    expect(Date.parse(git!.last_accessed_at)).toBeGreaterThanOrEqual(before)

    openSwitcherProject({ kind: 'data', id: 'db-b' })
    const database = useDataProjectStore.getState().projects.find((p) => p.id === 'db-b')
    expect(Date.parse(database!.lastAccessedAt)).toBeGreaterThanOrEqual(before)
  })

  it('scrolls the sidebar to the project', () => {
    openSwitcherProject({ kind: 'git', id: 'ledger-worker' })
    expect(reveal.revealProjectInSidebar).toHaveBeenLastCalledWith({
      kind: 'git',
      id: 'ledger-worker'
    })
    openSwitcherProject({ kind: 'data', id: 'db-b' })
    expect(reveal.revealProjectInSidebar).toHaveBeenLastCalledWith({ kind: 'data', id: 'db-b' })
  })

  it('leaves the sidebar as it is until unsaved edits are discarded', async () => {
    openDatabaseWithStagedEdits()
    vi.clearAllMocks()

    openSwitcherProject({ kind: 'git', id: 'ledger-worker' })
    await answer(false)
    expect(sidebarOrder()).toEqual(['db-a', 'db-b', 'ledger-worker'])
    expect(api.reorderSidebar).not.toHaveBeenCalled()
    expect(reveal.revealProjectInSidebar).not.toHaveBeenCalled()

    openSwitcherProject({ kind: 'git', id: 'ledger-worker' })
    await answer(true)
    expect(sidebarOrder()).toEqual(['ledger-worker', 'db-a', 'db-b'])
    expect(reveal.revealProjectInSidebar).toHaveBeenCalledTimes(1)
  })

  it('opens a database picked again over its own unsaved edits without asking', () => {
    openDatabaseWithStagedEdits()
    openSwitcherProject({ kind: 'data', id: 'db-a' })
    expect(workspace().discardRequest).toBeNull()
    expect(selectedDatabase()).toBe('db-a')
    expect(workspace().pendingEditCount('db-a')).toBe(3)
  })
})

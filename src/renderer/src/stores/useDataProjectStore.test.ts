// useDataProjectStore: selection deconfliction with git projects / worktrees / connections, the
// Pinned Board interplay (a data project shows in front of the board and steps aside when the
// board comes back), connection statuses (server events, connect outcomes incl. the credentials
// prompt, one connect at a time), the merged sidebar order (incl. "sort by last message" and a
// newly added git project), what the clients keep about removed projects, and the defaults
// setting.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataConnectionStatus, DataProject } from '@shared/data-projects/types'
import { sampleDataProject, sampleGitProject } from '@/components/data-projects/data-project.sample'

const gitProject = (id: string, sortOrder: number): never =>
  sampleGitProject(id, sortOrder) as never

const api = vi.hoisted(() => ({
  list: vi.fn(),
  status: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  touch: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  duplicate: vi.fn(),
  reorderSidebar: vi.fn(),
  provideSessionSecrets: vi.fn(),
  onStatus: vi.fn()
}))
vi.mock('@/api/data-projects-api', () => ({ dataProjectsApi: api }))

const settingApi = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }))
vi.mock('@/api/db-api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/api/db-api')>()
  return { dbApi: { ...original.dbApi, setting: { ...original.dbApi.setting, ...settingApi } } }
})

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
}))

const { useDataProjectStore, parseDataProjectDefaults, BUILTIN_DATA_PROJECT_DEFAULTS } =
  await import('./useDataProjectStore')
const { useProjectStore } = await import('./useProjectStore')
const { useWorktreeStore } = await import('./useWorktreeStore')
const { useConnectionStore } = await import('./useConnectionStore')
const { useKanbanStore } = await import('./useKanbanStore')
const { useDataWorkspaceStore, flushDataWorkspacePersistence } =
  await import('./useDataWorkspaceStore')
const { useMongoWorkspaceStore, filterHistoryKey } = await import('./useMongoWorkspaceStore')
const { useDataAssistantStore, emptyConversation } = await import('./useDataAssistantStore')
const { dbApi } = await import('@/api/db-api')
const { projectApi } = await import('@/api/project-api')

const initialProjectState = useProjectStore.getState()
const initialWorktreeState = useWorktreeStore.getState()
const initialConnectionState = useConnectionStore.getState()
const initialKanbanState = useKanbanStore.getState()

let statusListener: ((status: DataConnectionStatus) => void) | null = null

beforeEach(() => {
  vi.clearAllMocks()
  useDataProjectStore.getState().reset()
  api.touch.mockResolvedValue(undefined)
  api.status.mockImplementation(async (id: string) => ({
    dataProjectId: id,
    state: 'disconnected'
  }))
  api.reorderSidebar.mockResolvedValue(undefined)
  api.onStatus.mockImplementation((cb: (status: DataConnectionStatus) => void) => {
    statusListener = cb
    return () => {
      statusListener = null
    }
  })
})

afterEach(() => {
  useProjectStore.setState(initialProjectState, true)
  useWorktreeStore.setState(initialWorktreeState, true)
  useConnectionStore.setState(initialConnectionState, true)
  useKanbanStore.setState(initialKanbanState, true)
})

describe('selection deconfliction', () => {
  it('select() clears the git project, worktree and connection selection', () => {
    useProjectStore.setState({ selectedProjectId: 'p-1' })
    useWorktreeStore.setState({ selectedWorktreeId: 'wt-1' })
    useConnectionStore.setState({ selectedConnectionId: 'c-1' })

    useDataProjectStore.getState().select('dp-1')

    expect(useDataProjectStore.getState().selectedDataProjectId).toBe('dp-1')
    expect(useProjectStore.getState().selectedProjectId).toBeNull()
    expect(useWorktreeStore.getState().selectedWorktreeId).toBeNull()
    expect(useConnectionStore.getState().selectedConnectionId).toBeNull()
    expect(api.touch).toHaveBeenCalledWith('dp-1')
  })

  it('selecting a git project clears the data project', () => {
    useDataProjectStore.getState().select('dp-1')
    useProjectStore.getState().selectProject('p-1')
    expect(useDataProjectStore.getState().selectedDataProjectId).toBeNull()
    expect(useProjectStore.getState().selectedProjectId).toBe('p-1')
  })

  it('selecting a worktree clears the data project', () => {
    useDataProjectStore.getState().select('dp-1')
    useWorktreeStore.getState().selectWorktree('wt-1')
    expect(useDataProjectStore.getState().selectedDataProjectId).toBeNull()
  })

  it('selecting a connection clears the data project', () => {
    useDataProjectStore.getState().select('dp-1')
    useConnectionStore.getState().selectConnection('c-1')
    expect(useDataProjectStore.getState().selectedDataProjectId).toBeNull()
  })

  it('clearing a selection elsewhere (null) leaves the data project open', () => {
    useDataProjectStore.getState().select('dp-1')
    useProjectStore.getState().selectProject(null)
    useWorktreeStore.getState().selectWorktree(null)
    useConnectionStore.getState().selectConnection(null)
    expect(useDataProjectStore.getState().selectedDataProjectId).toBe('dp-1')
  })
})

describe('Pinned Board interplay', () => {
  it('shows the data project in front of an active Pinned Board without turning pinned mode off', () => {
    useKanbanStore.setState({ isPinnedBoardActive: true, isPinnedBoardBehindSession: false })

    useDataProjectStore.getState().select('dp-1')

    const kanban = useKanbanStore.getState()
    expect(kanban.isPinnedBoardActive).toBe(true)
    expect(kanban.isPinnedBoardBehindSession).toBe(true)
    expect(useDataProjectStore.getState().selectedDataProjectId).toBe('dp-1')
  })

  it('steps aside when the Pinned Board is toggled back to the front', async () => {
    useKanbanStore.setState({ isPinnedBoardActive: true, isPinnedBoardBehindSession: false })
    useDataProjectStore.getState().select('dp-1')

    useKanbanStore.getState().togglePinnedBoard()

    await vi.waitFor(() => {
      expect(useKanbanStore.getState().isPinnedBoardBehindSession).toBe(false)
    })
    expect(useKanbanStore.getState().isPinnedBoardActive).toBe(true)
    expect(useDataProjectStore.getState().selectedDataProjectId).toBeNull()
  })

  it('steps aside when the Pinned Board is switched on while the data project is open', () => {
    useKanbanStore.setState({ isPinnedBoardActive: false, isPinnedBoardBehindSession: false })
    useDataProjectStore.getState().select('dp-1')
    expect(useKanbanStore.getState().isPinnedBoardActive).toBe(false)

    useKanbanStore.setState({ isPinnedBoardActive: true })

    expect(useDataProjectStore.getState().selectedDataProjectId).toBeNull()
  })

  it('steps aside when the board view is opened', () => {
    useKanbanStore.setState({ isBoardViewActive: false })
    useDataProjectStore.getState().select('dp-1')
    useKanbanStore.setState({ isBoardViewActive: true })
    expect(useDataProjectStore.getState().selectedDataProjectId).toBeNull()
  })
})

describe('connection statuses', () => {
  it('load() subscribes to status events and asks for unknown statuses', async () => {
    api.list.mockResolvedValue([
      sampleDataProject(),
      sampleDataProject({ id: 'dp-2', sortOrder: 1 })
    ])
    api.status.mockImplementation(async (id: string) => ({
      dataProjectId: id,
      state: id === 'dp-2' ? 'connected' : 'disconnected'
    }))

    await useDataProjectStore.getState().load()

    expect(useDataProjectStore.getState().projects.map((p) => p.id)).toEqual(['dp-1', 'dp-2'])
    await vi.waitFor(() =>
      expect(useDataProjectStore.getState().statuses['dp-2']?.state).toBe('connected')
    )
    expect(statusListener).not.toBeNull()

    statusListener?.({ dataProjectId: 'dp-1', state: 'connected', serverVersion: 'PostgreSQL 17' })
    const state = useDataProjectStore.getState()
    expect(state.statuses['dp-1']).toMatchObject({
      state: 'connected',
      serverVersion: 'PostgreSQL 17'
    })
    expect(state.everConnected['dp-1']).toBe(true)

    statusListener?.({ dataProjectId: 'dp-1', state: 'error', error: 'connection reset' })
    expect(useDataProjectStore.getState().statuses['dp-1']?.state).toBe('error')
    // The workspace stays: the view shows a banner instead of tearing it down.
    expect(useDataProjectStore.getState().everConnected['dp-1']).toBe(true)
  })

  it('treats a non-array list answer as empty', async () => {
    api.list.mockResolvedValue(undefined)
    await useDataProjectStore.getState().load()
    expect(useDataProjectStore.getState().projects).toEqual([])
    expect(useDataProjectStore.getState().loaded).toBe(true)
  })

  it('connect() records success and shares one in-flight connect', async () => {
    let resolve: (status: DataConnectionStatus) => void = () => {}
    api.connect.mockImplementation(() => new Promise<DataConnectionStatus>((r) => (resolve = r)))

    const first = useDataProjectStore.getState().ensureConnected('dp-1')
    const second = useDataProjectStore.getState().ensureConnected('dp-1')
    expect(useDataProjectStore.getState().statuses['dp-1']?.state).toBe('connecting')
    resolve({ dataProjectId: 'dp-1', state: 'connected', serverVersion: '8.4.0' })

    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(true)
    expect(api.connect).toHaveBeenCalledTimes(1)
    expect(useDataProjectStore.getState().everConnected['dp-1']).toBe(true)

    // Already connected: no new round trip.
    await expect(useDataProjectStore.getState().ensureConnected('dp-1')).resolves.toBe(true)
    expect(api.connect).toHaveBeenCalledTimes(1)
  })

  it('a connection failure becomes an error status with the server message', async () => {
    api.connect.mockRejectedValue(
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
        name: 'DATA_CONNECTION_FAILED'
      })
    )
    await expect(useDataProjectStore.getState().connect('dp-1')).resolves.toBe(false)
    expect(useDataProjectStore.getState().statuses['dp-1']).toMatchObject({
      state: 'error',
      error: 'connect ECONNREFUSED 127.0.0.1:5432'
    })
  })

  it('DATA_CREDENTIALS_REQUIRED opens the credentials prompt and stops auto-retries', async () => {
    api.connect.mockRejectedValue(
      Object.assign(new Error('Saved password cannot be read'), {
        name: 'DATA_CREDENTIALS_REQUIRED'
      })
    )
    await expect(useDataProjectStore.getState().ensureConnected('dp-1')).resolves.toBe(false)

    const state = useDataProjectStore.getState()
    expect(state.credentialsRequired['dp-1']).toBe('Saved password cannot be read')
    expect(state.credentialsPrompt).toEqual({
      projectId: 'dp-1',
      message: 'Saved password cannot be read'
    })
    await expect(useDataProjectStore.getState().ensureConnected('dp-1')).resolves.toBe(false)
    expect(api.connect).toHaveBeenCalledTimes(1)
  })

  it('submitCredentials hands the secrets to the server and reconnects', async () => {
    useDataProjectStore.setState({
      projects: [sampleDataProject({ secretState: 'unavailable' })],
      credentialsRequired: { 'dp-1': 'needed' },
      credentialsPrompt: { projectId: 'dp-1' }
    })
    api.provideSessionSecrets.mockResolvedValue(sampleDataProject({ secretState: 'stored' }))
    api.connect.mockResolvedValue({ dataProjectId: 'dp-1', state: 'connected' })

    await expect(
      useDataProjectStore.getState().submitCredentials('dp-1', { password: 'pw' }, true)
    ).resolves.toBe(true)

    expect(api.provideSessionSecrets).toHaveBeenCalledWith('dp-1', { password: 'pw' }, true)
    const state = useDataProjectStore.getState()
    expect(state.credentialsPrompt).toBeNull()
    expect(state.credentialsRequired['dp-1']).toBeUndefined()
    expect(state.projects[0].secretState).toBe('stored')
    expect(state.statuses['dp-1']?.state).toBe('connected')
  })

  it('a config change bumps the connection epoch so the view reconnects', async () => {
    useDataProjectStore.setState({
      projects: [sampleDataProject()],
      everConnected: { 'dp-1': true },
      statuses: { 'dp-1': { dataProjectId: 'dp-1', state: 'connected' } }
    })
    api.update.mockResolvedValue(sampleDataProject({ config: { host: 'db2' } }))

    await useDataProjectStore.getState().update('dp-1', { config: { host: 'db2' } })

    const state = useDataProjectStore.getState()
    expect(state.connectionEpoch['dp-1']).toBe(1)
    expect(state.everConnected['dp-1']).toBeUndefined()
    expect(state.statuses['dp-1']?.state).toBe('disconnected')
  })
})

describe('sidebar order', () => {
  it('applySidebarOrder rewrites both stores and persists the merged order', () => {
    useProjectStore.setState({ projects: [gitProject('a', 0), gitProject('b', 1)] })
    useDataProjectStore.setState({ projects: [sampleDataProject({ id: 'd', sortOrder: 0 })] })

    const entries = [
      { kind: 'project' as const, id: 'b' },
      { kind: 'data' as const, id: 'd' },
      { kind: 'project' as const, id: 'a' }
    ]
    useDataProjectStore.getState().applySidebarOrder(entries)

    const git = useProjectStore.getState().projects as unknown as Array<{
      id: string
      sort_order: number
    }>
    expect(git.map((p) => [p.id, p.sort_order])).toEqual([
      ['b', 0],
      ['a', 2]
    ])
    expect(useDataProjectStore.getState().projects[0].sortOrder).toBe(1)
    expect(api.reorderSidebar).toHaveBeenCalledWith(entries)
  })

  it('create() puts the new connection on top and shifts both kinds down', async () => {
    useProjectStore.setState({ projects: [gitProject('a', 0)] })
    useDataProjectStore.setState({ projects: [sampleDataProject({ id: 'old', sortOrder: 1 })] })
    api.create.mockResolvedValue(sampleDataProject({ id: 'new', sortOrder: 0 }))

    const created = await useDataProjectStore.getState().create({
      name: 'new',
      engine: 'postgres',
      config: { host: 'localhost' }
    })

    expect(created.id).toBe('new')
    expect(useDataProjectStore.getState().projects.map((p) => [p.id, p.sortOrder])).toEqual([
      ['new', 0],
      ['old', 2]
    ])
    const git = useProjectStore.getState().projects as unknown as Array<{ sort_order: number }>
    expect(git[0].sort_order).toBe(1)
  })
})

describe('remove', () => {
  it('drops the project, its state and the selection', async () => {
    useDataProjectStore.setState({
      projects: [sampleDataProject()],
      selectedDataProjectId: 'dp-1',
      statuses: { 'dp-1': { dataProjectId: 'dp-1', state: 'connected' } },
      assistantOpenById: { 'dp-1': true }
    })
    api.delete.mockResolvedValue({ success: true })

    await expect(useDataProjectStore.getState().remove('dp-1')).resolves.toBe(true)

    const state = useDataProjectStore.getState()
    expect(state.projects).toEqual([])
    expect(state.selectedDataProjectId).toBeNull()
    expect(state.statuses['dp-1']).toBeUndefined()
    expect(state.assistantOpenById['dp-1']).toBeUndefined()
  })
})

describe('what the clients keep about removed projects', () => {
  const PII = "SELECT * FROM payroll WHERE ssn = '123-45-6789'"

  /** dp-1 and dp-2 each have a SQL workspace, Mongo state and an assistant conversation. */
  function seedWorkspaces(): void {
    const workspace = (id: string, text: string) => ({
      tabs: [{ id: `${id}-q`, kind: 'query' as const, title: 'Query 1', text, baseline: '' }],
      activeTabId: `${id}-q`,
      lastQueryTabId: `${id}-q`,
      queryCounter: 2
    })
    useDataWorkspaceStore.setState({
      workspaces: {
        'dp-1': workspace('dp-1', PII),
        'dp-2': workspace('dp-2', 'SELECT 1'),
        'dp-stale': workspace('dp-stale', 'SELECT 2')
      }
    })
    useMongoWorkspaceStore.setState({
      workspaces: {},
      filterHistory: {
        [filterHistoryKey('dp-1', 'shop', 'users')]: ['{ ssn: "123-45-6789" }'],
        [filterHistoryKey('dp-2', 'shop', 'users')]: ['{}'],
        [filterHistoryKey('dp-stale', 'shop', 'users')]: ['{}']
      }
    })
    useDataAssistantStore.setState({
      conversations: { 'dp-1': emptyConversation(), 'dp-2': emptyConversation() }
    })
  }

  afterEach(() => {
    useDataWorkspaceStore.getState().reset()
    useMongoWorkspaceStore.getState().reset()
    useDataAssistantStore.setState({ conversations: {} })
  })

  it('remove() forgets the tabs, drafts, filters and conversation of that project only', async () => {
    seedWorkspaces()
    useDataProjectStore.setState({
      projects: [sampleDataProject(), sampleDataProject({ id: 'dp-2', sortOrder: 1 })]
    })
    api.delete.mockResolvedValue({ success: true })
    flushDataWorkspacePersistence()
    expect(localStorage.getItem('hive-data-workspace')).toContain('123-45-6789')

    await expect(useDataProjectStore.getState().remove('dp-1')).resolves.toBe(true)

    await vi.waitFor(() => {
      expect(Object.keys(useDataWorkspaceStore.getState().workspaces).sort()).toEqual([
        'dp-2',
        'dp-stale'
      ])
      expect(Object.keys(useMongoWorkspaceStore.getState().filterHistory)).toHaveLength(2)
      expect(Object.keys(useDataAssistantStore.getState().conversations)).toEqual(['dp-2'])
    })
    // Written through at once: the draft is gone from disk too.
    expect(localStorage.getItem('hive-data-workspace') ?? '').not.toContain('123-45-6789')
  })

  it('a failed removal keeps everything', async () => {
    seedWorkspaces()
    useDataProjectStore.setState({ projects: [sampleDataProject()] })
    api.delete.mockResolvedValue({ success: false })

    await expect(useDataProjectStore.getState().remove('dp-1')).resolves.toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(useDataWorkspaceStore.getState().workspaces['dp-1']).toBeDefined()
    expect(useDataAssistantStore.getState().conversations['dp-1']).toBeDefined()
  })

  it('load() prunes leftovers of projects that no longer exist, and forgets ones removed elsewhere', async () => {
    seedWorkspaces()
    api.list.mockResolvedValue([
      sampleDataProject(),
      sampleDataProject({ id: 'dp-2', sortOrder: 1 })
    ])
    await useDataProjectStore.getState().load()
    await vi.waitFor(() => {
      expect(Object.keys(useDataWorkspaceStore.getState().workspaces).sort()).toEqual([
        'dp-1',
        'dp-2'
      ])
      expect(Object.keys(useMongoWorkspaceStore.getState().filterHistory)).toHaveLength(2)
    })

    // dp-2 was removed in another window: the next load drops what this one kept for it.
    api.list.mockResolvedValue([sampleDataProject()])
    await useDataProjectStore.getState().load()
    await vi.waitFor(() => {
      expect(Object.keys(useDataWorkspaceStore.getState().workspaces)).toEqual(['dp-1'])
      expect(Object.keys(useDataAssistantStore.getState().conversations)).toEqual(['dp-1'])
    })
  })

  it('never prunes on a malformed list answer', async () => {
    seedWorkspaces()
    api.list.mockResolvedValue(undefined)
    await useDataProjectStore.getState().load()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(Object.keys(useDataWorkspaceStore.getState().workspaces)).toHaveLength(3)
  })
})

describe('git projects next to data projects', () => {
  it('adding a git project replaces an open data project', async () => {
    useDataProjectStore.getState().select('dp-1')
    const newProject = { ...sampleGitProject('git-new', 0) }
    vi.spyOn(projectApi, 'validateProject').mockResolvedValue({
      success: true,
      name: 'newproj',
      path: '/tmp/newproj'
    } as never)
    vi.spyOn(projectApi, 'detectLanguage').mockResolvedValue(null as never)
    vi.spyOn(projectApi, 'detectFavicon').mockResolvedValue(null as never)
    vi.spyOn(dbApi.project, 'getByPath').mockResolvedValue(null as never)
    vi.spyOn(dbApi.project, 'create').mockResolvedValue(newProject as never)
    vi.spyOn(dbApi.project, 'update').mockResolvedValue(newProject as never)

    await expect(useProjectStore.getState().addProject('/tmp/newproj')).resolves.toEqual({
      success: true
    })

    expect(useProjectStore.getState().selectedProjectId).toBe('git-new')
    expect(useDataProjectStore.getState().selectedDataProjectId).toBeNull()
  })

  it('sort by last message keeps every data project in its slot and persists both kinds', async () => {
    // Sidebar: D1(0), Pa(1), Pb(2), D2(3), Pc(4).
    useProjectStore.setState({
      projects: [gitProject('Pa', 1), gitProject('Pb', 2), gitProject('Pc', 4)]
    })
    useDataProjectStore.setState({
      projects: [
        sampleDataProject({ id: 'D1', sortOrder: 0 }),
        sampleDataProject({ id: 'D2', sortOrder: 3 })
      ]
    })
    vi.spyOn(dbApi.project, 'sortByLastMessage').mockResolvedValue(['Pc', 'Pa', 'Pb'])
    const reorder = vi.spyOn(dbApi.project, 'reorder').mockResolvedValue(undefined as never)

    await useProjectStore.getState().sortProjectsByLastMessage()

    const expected = [
      { kind: 'data', id: 'D1' },
      { kind: 'project', id: 'Pc' },
      { kind: 'project', id: 'Pa' },
      { kind: 'data', id: 'D2' },
      { kind: 'project', id: 'Pb' }
    ]
    expect(api.reorderSidebar).toHaveBeenCalledWith(expected)
    expect(reorder).not.toHaveBeenCalled()
    // Both stores carry the persisted order, so the merged sidebar shows it now and after reload.
    const git = useProjectStore.getState().projects as unknown as Array<{
      id: string
      sort_order: number
    }>
    expect(git.map((p) => [p.id, p.sort_order])).toEqual([
      ['Pc', 1],
      ['Pa', 2],
      ['Pb', 4]
    ])
    expect(useDataProjectStore.getState().projects.map((p) => [p.id, p.sortOrder])).toEqual([
      ['D1', 0],
      ['D2', 3]
    ])
  })

  it('sort by last message without data projects keeps the git-only path', async () => {
    useProjectStore.setState({ projects: [gitProject('Pa', 0), gitProject('Pb', 1)] })
    vi.spyOn(dbApi.project, 'sortByLastMessage').mockResolvedValue(['Pb', 'Pa'])
    const reorder = vi.spyOn(dbApi.project, 'reorder').mockResolvedValue(undefined as never)

    await useProjectStore.getState().sortProjectsByLastMessage()

    expect(reorder).toHaveBeenCalledWith(['Pb', 'Pa'])
    expect(api.reorderSidebar).not.toHaveBeenCalled()
    expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual(['Pb', 'Pa'])
  })
})

describe('environment and safe mode', () => {
  it('moving a connection to production raises its safe mode to the production default', async () => {
    useDataProjectStore.setState({ projects: [sampleDataProject({ safeMode: 'off' })] })
    api.update.mockImplementation(async (_id: string, patch: Partial<DataProject>) =>
      sampleDataProject({ ...patch })
    )

    await useDataProjectStore.getState().setEnvironment('dp-1', 'production')

    expect(api.update).toHaveBeenCalledWith('dp-1', {
      environment: 'production',
      safeMode: 'half-safe'
    })
    expect(useDataProjectStore.getState().projects[0]).toMatchObject({
      environment: 'production',
      safeMode: 'half-safe'
    })
  })

  it('a failed safe-mode change rolls back', async () => {
    useDataProjectStore.setState({ projects: [sampleDataProject({ safeMode: 'safe' })] })
    api.update.mockRejectedValue(new Error('boom'))

    await expect(useDataProjectStore.getState().setSafeMode('dp-1', 'off')).resolves.toBe(false)
    expect(useDataProjectStore.getState().projects[0].safeMode).toBe('safe')
  })
})

describe('defaults for new connections', () => {
  it('parses partial or broken settings field by field', () => {
    expect(parseDataProjectDefaults(null)).toEqual(BUILTIN_DATA_PROJECT_DEFAULTS)
    expect(parseDataProjectDefaults('{not json')).toEqual(BUILTIN_DATA_PROJECT_DEFAULTS)
    expect(
      parseDataProjectDefaults(
        JSON.stringify({ environment: 'staging', safeMode: 'nonsense', defaultLimit: 500 })
      )
    ).toEqual({ ...BUILTIN_DATA_PROJECT_DEFAULTS, environment: 'staging', defaultLimit: 500 })
  })

  it('saves under its own setting key, never app_settings', async () => {
    settingApi.set.mockResolvedValue(true)
    await useDataProjectStore.getState().saveDefaults({ safeMode: 'safe' })
    expect(settingApi.set).toHaveBeenCalledWith(
      'data_projects_defaults',
      JSON.stringify({ ...BUILTIN_DATA_PROJECT_DEFAULTS, safeMode: 'safe' })
    )
    expect(useDataProjectStore.getState().defaults.safeMode).toBe('safe')
  })
})

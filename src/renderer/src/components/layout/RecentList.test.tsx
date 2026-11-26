// The sidebar's Recent section: on unless turned off in Settings, the five most recently opened projects that are not
// pinned (every kind, every Space), each a one-line row with an age, an agent indicator, a pin
// button and the project's own right-click menu. Hidden when empty and while filtering.

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setRendererRpcClient } from '@/api/rpc-client'
import { sampleDataProject, sampleGitProject } from '@/components/data-projects/data-project.sample'

vi.mock('@/api/settings-api', () => ({
  settingsApi: { onSettingsUpdated: vi.fn(() => vi.fn()) }
}))
vi.mock('@/api/pet-api', () => ({ petApi: { updateSettings: vi.fn() } }))

const { RecentList } = await import('./RecentList')
const { ProjectItem } = await import('@/components/projects/ProjectItem')
const { toast } = await import('@/lib/toast')
const { usePinnedStore } = await import('@/stores/usePinnedStore')
const { useProjectStore } = await import('@/stores/useProjectStore')
const { useDataProjectStore } = await import('@/stores/useDataProjectStore')
const { useWorktreeStore } = await import('@/stores/useWorktreeStore')
const { useWorktreeStatusStore } = await import('@/stores/useWorktreeStatusStore')
const { useSessionStore } = await import('@/stores/useSessionStore')
const { useConnectionStore } = await import('@/stores/useConnectionStore')
const { useFilterStore } = await import('@/stores/useFilterStore')
const { useSpaceStore } = await import('@/stores/useSpaceStore')
const { useKanbanStore } = await import('@/stores/useKanbanStore')
const { useHintStore } = await import('@/stores/useHintStore')
const { useSettingsStore } = await import('@/stores/useSettingsStore')

const NOW = Date.parse('2026-03-01T12:00:00.000Z')
const MINUTE = 60_000
const minutesAgo = (minutes: number): string => new Date(NOW - minutes * MINUTE).toISOString()

type GitProject = ReturnType<typeof useProjectStore.getState>['projects'][number]

const gitProject = (
  id: string,
  openedMinutesAgo: number,
  overrides: Record<string, unknown> = {}
): GitProject =>
  sampleGitProject(id, 0, {
    last_accessed_at: minutesAgo(openedMinutesAgo),
    ...overrides
  }) as unknown as GitProject

const worktree = (id: string, projectId: string, isDefault = false) =>
  ({
    id,
    project_id: projectId,
    name: isDefault ? '(no-worktree)' : id,
    branch_name: isDefault ? 'main' : id,
    path: `/repo/${projectId}/${id}`,
    status: 'active',
    is_default: isDefault,
    created_at: minutesAgo(1000),
    last_accessed_at: minutesAgo(1000)
  }) as never

/** Seven git projects, opened 10, 20 … 70 minutes ago, listed out of that order. */
const SEVEN = [
  gitProject('p-40', 40),
  gitProject('p-10', 10),
  gitProject('p-70', 70),
  gitProject('p-20', 20),
  gitProject('p-60', 60),
  gitProject('p-30', 30),
  gitProject('p-50', 50)
]

let rpcCalls: Array<{ method: string; params: unknown }> = []
let rpcHandlers: Record<string, (params: unknown) => unknown> = {}

/** The projects of the rows, top to bottom. */
const rowIds = (): string[] =>
  Array.from(
    screen.getByTestId('recent-list-rows').querySelectorAll<HTMLElement>('[data-recent-project]')
  ).map((row) => row.dataset.recentProject!)

const menuItemNames = (): string[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).map(
    (item) => item.textContent ?? ''
  )

const renderList = async (): Promise<void> => {
  await act(async () => {
    render(<RecentList />)
  })
}

// floating-ui probes positioned elements with selectors jsdom does not know; answering them
// directly keeps an opened menu from costing seconds (see ProjectItem.shell-commands.test).
const TOP_LAYER_PROBES = new Set([':popover-open', ':modal'])
const originalMatches = Element.prototype.matches

beforeAll(() => {
  Element.prototype.matches = function (this: Element, selectors: string): boolean {
    return TOP_LAYER_PROBES.has(selectors) ? false : originalMatches.call(this, selectors)
  }
})

afterAll(() => {
  Element.prototype.matches = originalMatches
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(NOW)
  rpcCalls = []
  rpcHandlers = {}
  setRendererRpcClient({
    request: (async (method: string, params: unknown) => {
      rpcCalls.push({ method, params })
      return rpcHandlers[method]?.(params)
    }) as never,
    subscribe: () => () => {}
  })
  useSettingsStore.setState({ tipsEnabled: false, showRecentProjects: true })
  useDataProjectStore.getState().reset()
  useProjectStore.setState({
    projects: SEVEN,
    selectedProjectId: null,
    expandedProjectIds: new Set(),
    editingProjectId: null
  })
  usePinnedStore.setState({
    pinnedWorktreeIds: new Set(),
    pinnedConnectionIds: new Set(),
    pinnedProjectIds: new Set(),
    loaded: true
  })
  useWorktreeStore.setState({
    worktreesByProject: new Map(),
    loadedProjectIds: new Set(),
    worktreeOrderByProject: new Map(),
    archivingWorktreeIds: new Set(),
    selectedWorktreeId: null
  })
  useWorktreeStatusStore.setState({ sessionStatuses: {} })
  useSessionStore.setState({ sessionsByWorktree: new Map(), sessionsByConnection: new Map() })
  useConnectionStore.setState({
    connections: [],
    connectionModeActive: false,
    selectedConnectionId: null
  })
  useFilterStore.setState({ filterQuery: '', debouncedFilterQuery: '', activeLanguages: [] })
  useSpaceStore.setState({ activeSpaceId: null, projectSpaceMap: {} })
  useKanbanStore.setState({ isPinnedBoardActive: false })
  useHintStore.setState({ filterActive: false, inputFocused: false })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('Recent section: what it shows', () => {
  it('lists the five most recently opened projects, newest first, under a counted heading', async () => {
    await renderList()

    expect(rowIds()).toEqual(['p-10', 'p-20', 'p-30', 'p-40', 'p-50'])
    const section = screen.getByTestId('recent-list')
    expect(section).toHaveTextContent('Recent')
    expect(section.querySelector('[data-testid="recent-list-rows"]')!.children).toHaveLength(5)
    // The heading carries the number of rows.
    expect(section.firstElementChild).toHaveTextContent(/^Recent\s*5$/)
  })

  it('needs no switch: it shows with no saved preference, and drops the old one', async () => {
    localStorage.setItem('hive-recent-visible', 'false')

    await renderList()

    expect(screen.getByTestId('recent-list')).toBeInTheDocument()
    expect(localStorage.getItem('hive-recent-visible')).toBeNull()
  })

  it('leaves out pinned projects and fills up with the next most recent', async () => {
    usePinnedStore.setState({ pinnedProjectIds: new Set(['p-10', 'p-30']) })

    await renderList()

    expect(rowIds()).toEqual(['p-20', 'p-40', 'p-50', 'p-60', 'p-70'])
  })

  it('counts connection projects and databases, and leaves out the pinned ones', async () => {
    useProjectStore.setState({
      projects: [
        gitProject('repo', 30),
        gitProject('stack', 10, { kind: 'connection' }),
        gitProject('pinned-stack', 5, { kind: 'connection' })
      ]
    })
    useDataProjectStore.setState({
      projects: [
        sampleDataProject({ id: 'db', name: 'fixtures-db', lastAccessedAt: minutesAgo(20) }),
        sampleDataProject({ id: 'db-pinned', pinned: true, lastAccessedAt: minutesAgo(1) })
      ]
    })
    usePinnedStore.setState({ pinnedProjectIds: new Set(['pinned-stack']) })

    await renderList()

    expect(rowIds()).toEqual(['stack', 'db', 'repo'])
    expect(screen.getByTestId('recent-project-name-db')).toHaveTextContent('fixtures-db')
  })

  it('does not change with the active Space', async () => {
    await renderList()
    const before = rowIds()

    act(() => {
      useSpaceStore.setState({ activeSpaceId: 'mobile', projectSpaceMap: { 'p-70': ['mobile'] } })
    })

    expect(rowIds()).toEqual(before)
  })

  it('is hidden when no project qualifies', async () => {
    useProjectStore.setState({ projects: [gitProject('only', 5)] })
    usePinnedStore.setState({ pinnedProjectIds: new Set(['only']) })

    await renderList()

    expect(screen.queryByTestId('recent-list')).not.toBeInTheDocument()
  })

  it('is hidden with no projects at all', async () => {
    useProjectStore.setState({ projects: [] })

    await renderList()

    expect(screen.queryByTestId('recent-list')).not.toBeInTheDocument()
  })

  it('waits for the pins before showing anything', async () => {
    usePinnedStore.setState({ loaded: false })
    await renderList()
    expect(screen.queryByTestId('recent-list')).not.toBeInTheDocument()

    act(() => {
      usePinnedStore.setState({ loaded: true, pinnedProjectIds: new Set(['p-10']) })
    })

    expect(rowIds()).toEqual(['p-20', 'p-30', 'p-40', 'p-50', 'p-60'])
  })

  it('hides while a sidebar filter is active and returns when it is cleared', async () => {
    await renderList()
    expect(screen.getByTestId('recent-list')).toBeInTheDocument()

    act(() => {
      useFilterStore.getState().setFilterQuery('ledg')
    })
    expect(screen.queryByTestId('recent-list')).not.toBeInTheDocument()

    act(() => {
      useFilterStore.getState().setFilterQuery('')
    })
    expect(rowIds()).toEqual(['p-10', 'p-20', 'p-30', 'p-40', 'p-50'])
  })

  it('hides while a language filter is active', async () => {
    await renderList()

    act(() => {
      useFilterStore.setState({ activeLanguages: ['typescript'] })
    })

    expect(screen.queryByTestId('recent-list')).not.toBeInTheDocument()
  })

  it('hides when Recent projects is turned off in Settings and returns when turned on', async () => {
    await renderList()
    expect(screen.getByTestId('recent-list')).toBeInTheDocument()

    act(() => {
      useSettingsStore.getState().updateSetting('showRecentProjects', false)
    })
    expect(screen.queryByTestId('recent-list')).not.toBeInTheDocument()

    act(() => {
      useSettingsStore.getState().updateSetting('showRecentProjects', true)
    })
    expect(rowIds()).toEqual(['p-10', 'p-20', 'p-30', 'p-40', 'p-50'])
  })
})

describe('Recent section: a row', () => {
  it('shows how long ago each project was opened', async () => {
    useProjectStore.setState({
      projects: [
        gitProject('just-now', 0),
        gitProject('five-minutes', 5),
        gitProject('two-hours', 120),
        gitProject('three-days', 3 * 24 * 60)
      ]
    })

    await renderList()

    expect(screen.getByTestId('recent-project-age-just-now')).toHaveTextContent(/^now$/)
    expect(screen.getByTestId('recent-project-age-five-minutes')).toHaveTextContent(/^5m$/)
    expect(screen.getByTestId('recent-project-age-two-hours')).toHaveTextContent(/^2h$/)
    expect(screen.getByTestId('recent-project-age-three-days')).toHaveTextContent(/^3d$/)
  })

  it('moves the age on as time passes', async () => {
    useProjectStore.setState({ projects: [gitProject('p', 0)] })
    await renderList()
    expect(screen.getByTestId('recent-project-age-p')).toHaveTextContent(/^now$/)

    act(() => {
      vi.advanceTimersByTime(3 * MINUTE)
    })

    expect(screen.getByTestId('recent-project-age-p')).toHaveTextContent(/^3m$/)
  })

  it('shows an indicator for a project with a working worktree and none for one without', async () => {
    useWorktreeStore.setState({
      worktreesByProject: new Map([
        ['p-10', [worktree('wt-busy', 'p-10'), worktree('wt-main', 'p-10', true)]],
        ['p-20', [worktree('wt-idle', 'p-20', true)]]
      ]),
      loadedProjectIds: new Set(['p-10', 'p-20'])
    })
    useSessionStore.setState({
      sessionsByWorktree: new Map([
        ['wt-busy', [{ id: 's-busy' }]],
        ['wt-idle', [{ id: 's-idle' }]]
      ]) as never
    })
    useWorktreeStatusStore.setState({
      sessionStatuses: {
        's-busy': { status: 'working', timestamp: 1 },
        's-idle': { status: 'completed', timestamp: 1 }
      }
    })

    await renderList()

    expect(screen.getByTestId('recent-project-agent-p-10')).toHaveAttribute('data-state', 'working')
    expect(screen.queryByTestId('recent-project-agent-p-20')).not.toBeInTheDocument()
    expect(screen.queryByTestId('recent-project-agent-p-30')).not.toBeInTheDocument()
  })

  it('shows the indicator as waiting when an agent needs the user, and follows the status', async () => {
    useWorktreeStore.setState({
      worktreesByProject: new Map([['p-10', [worktree('wt-main', 'p-10', true)]]]),
      loadedProjectIds: new Set(['p-10'])
    })
    useSessionStore.setState({
      sessionsByWorktree: new Map([['wt-main', [{ id: 's-1' }]]]) as never
    })
    await renderList()
    expect(screen.queryByTestId('recent-project-agent-p-10')).not.toBeInTheDocument()

    act(() => {
      useWorktreeStatusStore.setState({
        sessionStatuses: { 's-1': { status: 'answering', timestamp: 1 } }
      })
    })
    expect(screen.getByTestId('recent-project-agent-p-10')).toHaveAttribute(
      'data-state',
      'question'
    )

    act(() => {
      useWorktreeStatusStore.setState({
        sessionStatuses: { 's-1': { status: 'completed', timestamp: 2 } }
      })
    })
    expect(screen.queryByTestId('recent-project-agent-p-10')).not.toBeInTheDocument()
  })

  it('shows the indicator for a connection project with a working instance', async () => {
    useProjectStore.setState({ projects: [gitProject('stack', 10, { kind: 'connection' })] })
    useConnectionStore.setState({
      connections: [{ id: 'conn-1', saved_project_id: 'stack', is_base: 1, members: [] }] as never
    })
    useSessionStore.setState({
      sessionsByConnection: new Map([['conn-1', [{ id: 's-1' }]]]) as never
    })
    useWorktreeStatusStore.setState({
      sessionStatuses: { 's-1': { status: 'planning', timestamp: 1 } }
    })

    await renderList()

    expect(screen.getByTestId('recent-project-agent-stack')).toHaveAttribute(
      'data-state',
      'working'
    )
  })

  it('opens the project on a click: selected, expanded, recorded as opened, first in Recent', async () => {
    await renderList()

    await act(async () => {
      fireEvent.click(screen.getByTestId('recent-project-p-30'))
    })

    expect(useProjectStore.getState().selectedProjectId).toBe('p-30')
    expect(useProjectStore.getState().expandedProjectIds.has('p-30')).toBe(true)
    expect(rpcCalls).toContainEqual({ method: 'db.project.touch', params: { id: 'p-30' } })
    expect(rowIds()).toEqual(['p-30', 'p-10', 'p-20', 'p-40', 'p-50'])
    expect(screen.getByTestId('recent-project-p-30')).toHaveAttribute('aria-current', 'page')
  })

  it('opens a git project on its base branch, as a click on its "(no-worktree)" row does', async () => {
    useWorktreeStore.setState({
      worktreesByProject: new Map([
        ['p-10', [worktree('wt-10-main', 'p-10', true)]],
        ['p-30', [worktree('wt-30-feature', 'p-30'), worktree('wt-30-main', 'p-30', true)]]
      ]),
      loadedProjectIds: new Set(['p-10', 'p-30']),
      selectedWorktreeId: 'wt-10-main'
    })
    useProjectStore.setState({ selectedProjectId: 'p-10' })
    useConnectionStore.setState({ selectedConnectionId: 'conn-1' } as never)
    useKanbanStore.setState({ isPinnedBoardActive: true })
    const clearUnread = vi.spyOn(useWorktreeStatusStore.getState(), 'clearWorktreeUnread')
    await renderList()

    await act(async () => {
      fireEvent.click(screen.getByTestId('recent-project-p-30'))
    })

    expect(useProjectStore.getState().selectedProjectId).toBe('p-30')
    expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-30-main')
    // What selecting a worktree does: it takes the main pane and is recorded as opened.
    expect(useConnectionStore.getState().selectedConnectionId).toBeNull()
    expect(useKanbanStore.getState().isPinnedBoardActive).toBe(false)
    expect(rpcCalls).toContainEqual({ method: 'db.worktree.touch', params: { id: 'wt-30-main' } })
    expect(clearUnread).toHaveBeenCalledWith('wt-30-main')
    // The worktrees were in the store: nothing was read for them.
    expect(rpcCalls.map((call) => call.method)).not.toContain('db.worktree.getActiveByProject')
  })

  it('reads the worktrees of a project that was never expanded, then selects its base branch', async () => {
    rpcHandlers['db.worktree.getActiveByProject'] = (params) => {
      const { projectId } = params as { projectId: string }
      return [worktree('wt-feature', projectId), worktree('wt-main', projectId, true)]
    }
    useWorktreeStore.setState({ selectedWorktreeId: 'wt-other' })
    await renderList()

    await act(async () => {
      fireEvent.click(screen.getByTestId('recent-project-p-30'))
    })

    expect(rpcCalls).toContainEqual({
      method: 'db.worktree.getActiveByProject',
      params: { projectId: 'p-30' }
    })
    expect(useProjectStore.getState().selectedProjectId).toBe('p-30')
    expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-main')
  })

  it('leaves a selection made while the worktrees were being read', async () => {
    let answer: (rows: unknown[]) => void = () => {}
    rpcHandlers['db.worktree.getActiveByProject'] = () =>
      new Promise<unknown[]>((resolve) => {
        answer = resolve
      })
    useWorktreeStore.setState({
      worktreesByProject: new Map([['p-10', [worktree('wt-10-main', 'p-10', true)]]]),
      loadedProjectIds: new Set(['p-10'])
    })
    await renderList()

    await act(async () => {
      fireEvent.click(screen.getByTestId('recent-project-p-30'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('recent-project-p-10'))
    })
    expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-10-main')

    await act(async () => {
      answer([worktree('wt-30-main', 'p-30', true)])
    })

    expect(useProjectStore.getState().selectedProjectId).toBe('p-10')
    expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-10-main')
  })

  it('keeps to the project while a connection is being put together', async () => {
    useWorktreeStore.setState({
      worktreesByProject: new Map([['p-30', [worktree('wt-30-main', 'p-30', true)]]]),
      loadedProjectIds: new Set(['p-30']),
      selectedWorktreeId: 'wt-other'
    })
    useConnectionStore.setState({ connectionModeActive: true })
    await renderList()

    await act(async () => {
      fireEvent.click(screen.getByTestId('recent-project-p-30'))
    })

    expect(useProjectStore.getState().selectedProjectId).toBe('p-30')
    expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-other')
  })

  it('opens a connection project on its base instance, as a click on that instance does', async () => {
    useProjectStore.setState({
      projects: [...SEVEN, gitProject('stack', 5, { kind: 'connection' })]
    })
    useConnectionStore.setState({
      connections: [
        { id: 'conn-feature', saved_project_id: 'stack', is_base: 0, members: [] },
        { id: 'conn-base', saved_project_id: 'stack', is_base: 1, members: [] },
        { id: 'conn-other-base', saved_project_id: 'other-stack', is_base: 1, members: [] }
      ] as never
    })
    useWorktreeStore.setState({ selectedWorktreeId: 'wt-other' })
    useKanbanStore.setState({ isPinnedBoardActive: true })
    await renderList()

    await act(async () => {
      fireEvent.click(screen.getByTestId('recent-project-stack'))
    })

    expect(useProjectStore.getState().selectedProjectId).toBe('stack')
    expect(useConnectionStore.getState().selectedConnectionId).toBe('conn-base')
    expect(useWorktreeStore.getState().selectedWorktreeId).toBeNull()
    expect(useKanbanStore.getState().isPinnedBoardActive).toBe(false)
    // The instances were in the store: nothing was read for them.
    expect(rpcCalls.map((call) => call.method)).not.toContain('connectionOps.getAll')
  })

  it('reads the connections when the base instance is not in the store, then selects it', async () => {
    rpcHandlers['connectionOps.getAll'] = () => ({
      success: true,
      connections: [{ id: 'conn-base', saved_project_id: 'stack', is_base: 1, members: [] }]
    })
    useProjectStore.setState({
      projects: [...SEVEN, gitProject('stack', 5, { kind: 'connection' })]
    })
    useWorktreeStore.setState({ selectedWorktreeId: 'wt-other' })
    await renderList()

    await act(async () => {
      fireEvent.click(screen.getByTestId('recent-project-stack'))
    })

    expect(useProjectStore.getState().selectedProjectId).toBe('stack')
    expect(useConnectionStore.getState().selectedConnectionId).toBe('conn-base')
    expect(useWorktreeStore.getState().selectedWorktreeId).toBeNull()
  })

  it('opens a connection project with no base instance on its own board', async () => {
    rpcHandlers['connectionOps.getAll'] = () => ({ success: true, connections: [] })
    useProjectStore.setState({
      projects: [...SEVEN, gitProject('stack', 5, { kind: 'connection' })]
    })
    useWorktreeStore.setState({ selectedWorktreeId: 'wt-other' })
    useConnectionStore.setState({ selectedConnectionId: 'conn-elsewhere' } as never)
    await renderList()

    await act(async () => {
      fireEvent.click(screen.getByTestId('recent-project-stack'))
    })

    expect(useProjectStore.getState().selectedProjectId).toBe('stack')
    expect(useWorktreeStore.getState().selectedWorktreeId).toBeNull()
    expect(useConnectionStore.getState().selectedConnectionId).toBeNull()
    expect(rpcCalls.map((call) => call.method)).not.toContain('db.worktree.getActiveByProject')
  })

  it('keeps a connection project to its own board while a connection is being put together', async () => {
    useProjectStore.setState({
      projects: [...SEVEN, gitProject('stack', 5, { kind: 'connection' })]
    })
    useConnectionStore.setState({
      connections: [
        { id: 'conn-base', saved_project_id: 'stack', is_base: 1, members: [] }
      ] as never,
      connectionModeActive: true
    })
    await renderList()

    await act(async () => {
      fireEvent.click(screen.getByTestId('recent-project-stack'))
    })

    expect(useProjectStore.getState().selectedProjectId).toBe('stack')
    expect(useConnectionStore.getState().selectedConnectionId).toBeNull()
  })

  it('never collapses a project that is already expanded', async () => {
    useProjectStore.setState({ expandedProjectIds: new Set(['p-30']) })
    await renderList()

    await act(async () => {
      fireEvent.click(screen.getByTestId('recent-project-p-30'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('recent-project-p-30'))
    })

    expect(useProjectStore.getState().selectedProjectId).toBe('p-30')
    expect(useProjectStore.getState().expandedProjectIds.has('p-30')).toBe(true)
  })

  it('renders no worktrees, drag handle or list row of its own', async () => {
    useProjectStore.setState({ expandedProjectIds: new Set(['p-10']) })
    useWorktreeStore.setState({
      worktreesByProject: new Map([['p-10', [worktree('wt-main', 'p-10', true)]]]),
      loadedProjectIds: new Set(['p-10'])
    })

    await renderList()

    expect(screen.queryByTestId('project-item-p-10')).not.toBeInTheDocument()
    expect(document.querySelector('[data-project-group]')).toBeNull()
    expect(screen.getByTestId('recent-project-p-10')).not.toHaveAttribute('draggable')
    // No worktree list was mounted, so nothing was loaded or synced for it.
    expect(rpcCalls.filter((call) => call.method.startsWith('worktree'))).toEqual([])
  })

  it('pins the project from the row: a toast, and the next project takes its place', async () => {
    rpcHandlers['db.worktree.getActiveByProject'] = (params) => [
      worktree('wt-main', (params as { projectId: string }).projectId, true)
    ]
    rpcHandlers['db.worktree.setPinned'] = () => ({ success: true })
    const success = vi.spyOn(toast, 'success').mockReturnValue('toast')
    await renderList()
    const selectedBefore = useProjectStore.getState().selectedProjectId

    await act(async () => {
      fireEvent.click(screen.getByTestId('recent-project-pin-p-20'))
    })

    expect(rpcCalls).toContainEqual({
      method: 'db.worktree.setPinned',
      params: { worktreeId: 'wt-main', pinned: true }
    })
    expect(success).toHaveBeenCalledWith('Pinned p-20')
    expect(usePinnedStore.getState().pinnedProjectIds.has('p-20')).toBe(true)
    expect(rowIds()).toEqual(['p-10', 'p-30', 'p-40', 'p-50', 'p-60'])
    // Pinning is not opening: nothing was selected and no time was recorded.
    expect(useProjectStore.getState().selectedProjectId).toBe(selectedBefore)
    expect(rpcCalls.map((call) => call.method)).not.toContain('db.project.touch')
  })

  it('keeps the project in Recent when the pin fails', async () => {
    rpcHandlers['db.worktree.getActiveByProject'] = () => [worktree('wt-main', 'p-20', true)]
    rpcHandlers['db.worktree.setPinned'] = () => ({ success: false, error: 'nope' })
    const success = vi.spyOn(toast, 'success').mockReturnValue('toast')
    const error = vi.spyOn(toast, 'error').mockReturnValue('toast')
    await renderList()

    await act(async () => {
      fireEvent.click(screen.getByTestId('recent-project-pin-p-20'))
    })

    expect(error).toHaveBeenCalledWith('Failed to pin p-20', { description: 'nope' })
    expect(success).not.toHaveBeenCalled()
    expect(rowIds()).toEqual(['p-10', 'p-20', 'p-30', 'p-40', 'p-50'])
  })

  it('shows the same right-click menu as the project row in the list', async () => {
    useSpaceStore.setState({
      spaces: [{ id: 'mobile', name: 'Mobile' }] as never,
      projectSpaceMap: {}
    })
    const project = SEVEN[1] // p-10

    render(<ProjectItem project={project} />)
    fireEvent.contextMenu(screen.getByTestId('project-item-p-10'))
    const listMenu = menuItemNames()
    cleanup()

    await renderList()
    fireEvent.contextMenu(screen.getByTestId('recent-project-p-10'))
    const recentMenu = menuItemNames()

    expect(listMenu.length).toBeGreaterThan(5)
    expect(listMenu).toContain('Remove from Hive')
    expect(recentMenu).toEqual(listMenu)
  })
})

describe('Recent section: a database row', () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [gitProject('repo', 30)] })
    useDataProjectStore.setState({
      projects: [
        sampleDataProject({ id: 'db', name: 'fixtures-db', lastAccessedAt: minutesAgo(5) })
      ]
    })
  })

  it('opens the database client on a click', async () => {
    await renderList()

    await act(async () => {
      fireEvent.click(screen.getByTestId('recent-project-db'))
    })

    expect(useDataProjectStore.getState().selectedDataProjectId).toBe('db')
    expect(rpcCalls.map((call) => call.method)).toContain('dataProjects.touch')
  })

  it('pins with the database’s own Pin and leaves Recent', async () => {
    rpcHandlers['dataProjects.update'] = () =>
      sampleDataProject({ id: 'db', name: 'fixtures-db', pinned: true })
    const success = vi.spyOn(toast, 'success').mockReturnValue('toast')
    await renderList()
    expect(rowIds()).toEqual(['db', 'repo'])

    await act(async () => {
      fireEvent.click(screen.getByTestId('recent-project-pin-db'))
    })

    expect(useDataProjectStore.getState().projects[0].pinned).toBe(true)
    expect(success).toHaveBeenCalledWith('Pinned fixtures-db')
    expect(rowIds()).toEqual(['repo'])
    expect(useDataProjectStore.getState().selectedDataProjectId).toBeNull()
  })

  it('shows the database’s own menu', async () => {
    await renderList()

    fireEvent.contextMenu(screen.getByTestId('recent-project-db'))

    expect(screen.getByTestId('data-project-menu-open')).toBeInTheDocument()
    expect(screen.getByTestId('data-project-menu-pin')).toHaveTextContent('Pin')
    expect(screen.getByTestId('data-project-menu-remove')).toBeInTheDocument()
  })
})

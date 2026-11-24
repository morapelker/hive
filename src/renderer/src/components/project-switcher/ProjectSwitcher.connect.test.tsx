// Picking several projects in the "Go to project" switcher: Shift+Enter (or a Shift+click)
// picks the highlighted project instead of opening it, Cmd+Shift+Enter picks it on its base
// branch (no new worktree), the picked ones stay on top, and plain Enter then connects them
// together with the project it is pressed on; Cmd+Enter connects the picked ones alone. The
// creation itself is
// the store's quickCreateConnection (tested with lib/connection-create); here it is a stand-in
// the tests drive step by step. Its glue is tested in connect-switcher-projects.test.ts.

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/projects/LanguageIcon', () => ({
  LanguageIcon: () => <span data-testid="language-icon" />
}))
vi.mock('@/components/data-projects/DataProjectIcon', () => ({
  DataProjectIcon: () => <span data-testid="data-project-icon" />
}))
const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn()
}))
vi.mock('@/lib/toast', () => ({ toast: toastMock, gitToast: {} }))

const platform = vi.hoisted(() => ({ mac: true }))
vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  isMac: () => platform.mac
}))

import { setRendererRpcClient } from '@/api/rpc-client'
import { useProjectSwitcherStore } from '@/stores/useProjectSwitcherStore'
import { useCommandPaletteStore } from '@/stores/useCommandPaletteStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useConnectionStore, type QuickCreateConnectionOptions } from '@/stores/useConnectionStore'
import { usePinnedStore } from '@/stores/usePinnedStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useDataProjectStore } from '@/stores/useDataProjectStore'
import { sampleDataProject, sampleGitProject } from '@/components/data-projects/data-project.sample'
import { ProjectSwitcher } from './ProjectSwitcher'

const NOW = Date.UTC(2026, 5, 15, 12, 0, 0)
const minutesAgo = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString()

/** name → minutes since it was last opened; the array order is the sidebar order. */
const GIT_PROJECTS: [name: string, openedMinutesAgo: number][] = [
  ['ads-api', 500],
  ['checkout-api', 9000],
  ['ledger-api', 40],
  ['ledger-core', 3],
  ['ledger-worker', 200],
  ['orders-web', 8000],
  ['pricing-api', 60],
  ['returns-web', 30],
  ['search-worker', 20],
  ['seller-ios', 10]
]

/** A member as the switcher hands it to quickCreateConnection: the folder is not shortened. */
const member = (name: string): { id: string; name: string; path: string } => ({
  id: name,
  name,
  path: `/Users/ana/code/${name}`
})

/** A member picked on its base branch. */
const baseMember = (name: string): ReturnType<typeof member> & { useBase: true } => ({
  ...member(name),
  useBase: true
})

const worktree = (id: string, projectId: string): never =>
  ({ id, project_id: projectId, name: id, path: `/repo/${projectId}`, is_default: true }) as never

const realQuickCreateConnection = useConnectionStore.getState().quickCreateConnection

function seedStores(): void {
  useProjectStore.setState({
    projects: [
      ...GIT_PROJECTS.map(([name, minutes], i) =>
        sampleGitProject(name, i, {
          path: `/Users/ana/code/${name}`,
          last_accessed_at: minutesAgo(minutes)
        })
      ),
      sampleGitProject('checkout-stack', 20, {
        kind: 'connection',
        path: '/Users/ana/.hive/connections/checkout-stack',
        last_accessed_at: minutesAgo(7000)
      })
    ] as never,
    selectedProjectId: null,
    expandedProjectIds: new Set()
  })
  useDataProjectStore.getState().reset()
  useDataProjectStore.setState({
    projects: [
      sampleDataProject({
        id: 'fixtures-db',
        name: 'fixtures-db',
        engine: 'sqlite',
        config: { filePath: '/Users/ana/data/fixtures.sqlite' },
        sortOrder: 21,
        lastAccessedAt: minutesAgo(6000)
      })
    ]
  })
  useWorktreeStore.setState({
    worktreesByProject: new Map([
      // Pinned section order: orders-web first, then checkout-api.
      ['orders-web', [worktree('wt-orders', 'orders-web')]],
      ['checkout-api', [worktree('wt-checkout', 'checkout-api')]]
    ]),
    selectedWorktreeId: null,
    hydrateAllWorktrees: vi.fn(async () => {})
  })
  usePinnedStore.setState({
    pinnedWorktreeIds: new Set(['wt-orders', 'wt-checkout']),
    pinnedConnectionIds: new Set(),
    pinnedProjectIds: new Set(['orders-web', 'checkout-api']),
    loaded: true
  })
  useConnectionStore.setState({ connections: [], selectedConnectionId: null })
  useKanbanStore.setState({ isPinnedBoardActive: false, isPinnedBoardBehindSession: false })
  useSessionStore.setState({ sessionsByWorktree: new Map(), sessionsByConnection: new Map() })
  useWorktreeStatusStore.setState({ sessionStatuses: {} })
  useCommandPaletteStore.setState({ isOpen: false })
  useSettingsStore.setState({
    vimModeEnabled: false,
    autoPullBeforeWorktree: true,
    pullBeforeConnection: true
  })
}

function openSwitcher(): HTMLInputElement {
  render(<ProjectSwitcher />)
  act(() => useProjectSwitcherStore.getState().open())
  return screen.getByTestId('project-switcher-input') as HTMLInputElement
}

const nameOf = (row: HTMLElement): string =>
  within(row).getByTestId('project-switcher-row-name').textContent ?? ''

/** Every row, the picked ones first. */
const rowNames = (): string[] => screen.queryAllByTestId('project-switcher-row').map(nameOf)

/** The rows that stay on top: the projects picked so far. */
const pickedNames = (): string[] => {
  const group = screen.queryByTestId('project-switcher-selected')
  return group ? within(group).getAllByTestId('project-switcher-row').map(nameOf) : []
}

/** The rows of the list under the picked ones. */
const listNames = (): string[] =>
  within(screen.getByTestId('project-switcher-list'))
    .queryAllByTestId('project-switcher-row')
    .map(nameOf)

const activeRowName = (): string | null => {
  const active = screen
    .queryAllByTestId('project-switcher-row')
    .filter((row) => row.getAttribute('aria-selected') === 'true')
  expect(active.length).toBeLessThanOrEqual(1)
  return active[0] ? nameOf(active[0]) : null
}

const rowOf = (name: string): HTMLElement => {
  const row = screen.getAllByTestId('project-switcher-row').find((r) => nameOf(r) === name)
  if (!row) throw new Error(`No row for ${name}`)
  return row
}

const hint = (id: 'enter' | 'select' | 'base' | 'connect-picked' | 'pin'): string | null =>
  screen.queryByTestId(`project-switcher-${id}-hint`)?.textContent ?? null

const type = (input: HTMLInputElement, value: string): void => {
  fireEvent.change(input, { target: { value } })
}

const press = (input: HTMLElement, key: string, init: KeyboardEventInit = {}): void => {
  fireEvent.keyDown(input, { key, ...init })
}

/** Types a project's name and picks it with Shift+Enter. */
const pick = (input: HTMLInputElement, name: string): void => {
  type(input, name)
  expect(activeRowName()).toBe(name)
  press(input, 'Enter', { shiftKey: true })
}

/** Types a project's name and picks it on its base branch with Cmd+Shift+Enter. */
const pickOnBase = (input: HTMLInputElement, name: string): void => {
  type(input, name)
  expect(activeRowName()).toBe(name)
  press(input, 'Enter', { metaKey: true, shiftKey: true })
}

/** How a picked row says it joins the connection; null for a row that is not picked. */
const pickModeOf = (name: string): string | null =>
  within(rowOf(name)).queryByTestId('project-switcher-row-pick-mode')?.textContent ?? null

/** A quickCreateConnection the test drives step by step: `finish` ends it with a result. */
function controllableCreate(): {
  quickCreateConnection: ReturnType<typeof vi.fn>
  options: (call?: number) => QuickCreateConnectionOptions
  finish: (connectionId: string | null) => Promise<void>
} {
  const finishers: Array<(id: string | null) => void> = []
  const quickCreateConnection = vi.fn(
    () =>
      new Promise<string | null>((resolve) => {
        finishers.push(resolve)
      })
  )
  useConnectionStore.setState({ quickCreateConnection } as never)
  return {
    quickCreateConnection,
    options: (call = 0) => quickCreateConnection.mock.calls[call][1 as never],
    finish: async (connectionId) => {
      await act(async () => {
        finishers.shift()?.(connectionId)
      })
    }
  }
}

const createTask = (
  projectId: string,
  step: 'base' | 'pull' | 'worktree' = 'worktree'
): HTMLElement => screen.getByTestId(`project-switcher-create-task-${step}-${projectId}`)

/** The steps listed while the connection is created, top to bottom. */
const createSteps = (): (string | null)[] =>
  within(screen.getByTestId('project-switcher-create-progress'))
    .getAllByRole('listitem')
    .map((li) => li.textContent)

/** The "Pull latest from origin" switch in the heading of the picked projects. */
const pullSwitch = (): HTMLElement => screen.getByTestId('project-switcher-auto-pull-switch')

const expectNothingOpened = (): void => {
  expect(useProjectStore.getState().selectedProjectId).toBeNull()
  expect(useWorktreeStore.getState().selectedWorktreeId).toBeNull()
  expect(useConnectionStore.getState().selectedConnectionId).toBeNull()
  expect(useDataProjectStore.getState().selectedDataProjectId).toBeNull()
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  setRendererRpcClient({
    request: (async () => undefined) as never,
    subscribe: () => () => {}
  })
  seedStores()
})

afterEach(() => {
  act(() => useProjectSwitcherStore.getState().close())
  cleanup()
  vi.useRealTimers()
  platform.mac = true
  useConnectionStore.setState({ quickCreateConnection: realQuickCreateConnection })
})

describe('Shift+Enter', () => {
  it('picks the highlighted project, clears the field, and opens nothing', () => {
    const create = controllableCreate()
    const input = openSwitcher()
    type(input, 'ledger-co')
    press(input, 'Enter', { shiftKey: true })

    expect(screen.getByTestId('project-switcher')).toBeInTheDocument()
    expect(input.value).toBe('')
    expect(document.activeElement).toBe(input)
    expect(input.placeholder).toBe('Add another project…')
    expect(pickedNames()).toEqual(['ledger-core'])
    expect(screen.getByTestId('project-switcher-group-selected').textContent).toBe(
      'New connection1'
    )
    expectNothingOpened()
    expect(create.quickCreateConnection).not.toHaveBeenCalled()
  })

  it('keeps the picked project on top and lists the others that can join under it', () => {
    const input = openSwitcher()
    pick(input, 'ledger-core')

    // The groups of what is left. A connection project and a database cannot be members.
    expect(rowNames()).toEqual([
      'ledger-core',
      'orders-web',
      'checkout-api',
      'seller-ios',
      'search-worker',
      'returns-web',
      'ledger-api',
      'pricing-api',
      'ledger-worker',
      'ads-api'
    ])
    expect(screen.getByTestId('project-switcher-group-pinned').textContent).toBe('Pinned2')
    expect(screen.getByTestId('project-switcher-group-recent').textContent).toBe('Recent5')
    expect(screen.getByTestId('project-switcher-group-all').textContent).toBe('All projects2')
    expect(screen.getByTestId('project-switcher-count').textContent).toBe('9 projects')
    // Ready for the next one: the highlight is on the first project left, not on the picked.
    expect(activeRowName()).toBe('orders-web')
  })

  it('keeps the picked projects in view while the next one is typed', () => {
    const input = openSwitcher()
    pick(input, 'ledger-core')
    type(input, 'ledg')

    expect(pickedNames()).toEqual(['ledger-core'])
    // The picked project is not offered a second time.
    expect(listNames()).toEqual(['ledger-api', 'ledger-worker'])
    expect(screen.getByTestId('project-switcher-count').textContent).toBe('2 of 9')
    expect(activeRowName()).toBe('ledger-api')
    // The picked rows are outside the list that scrolls.
    expect(
      screen
        .getByTestId('project-switcher-list')
        .contains(screen.getByTestId('project-switcher-selected'))
    ).toBe(false)
  })

  it('picks several, in the order they were picked', () => {
    const input = openSwitcher()
    pick(input, 'seller-ios')
    pick(input, 'ads-api')
    pick(input, 'ledger-core')
    expect(pickedNames()).toEqual(['seller-ios', 'ads-api', 'ledger-core'])
    expect(screen.getByTestId('project-switcher-group-selected').textContent).toBe(
      'New connection3'
    )
    expect(input.value).toBe('')
    expectNothingOpened()
  })

  it('takes a picked project out again, and the highlight goes back into the list with it', () => {
    const input = openSwitcher()
    pick(input, 'seller-ios')
    pick(input, 'ads-api')
    press(input, 'ArrowUp')
    expect(activeRowName()).toBe('ads-api')
    press(input, 'ArrowUp')
    expect(activeRowName()).toBe('seller-ios')

    press(input, 'Enter', { shiftKey: true })
    expect(pickedNames()).toEqual(['ads-api'])
    expect(listNames()).toContain('seller-ios')
    expect(activeRowName()).toBe('seller-ios')

    // The last one out: the switcher is as it was before anything was picked.
    fireEvent.mouseMove(rowOf('ads-api'))
    expect(activeRowName()).toBe('ads-api')
    press(input, 'Enter', { shiftKey: true })
    expect(screen.queryByTestId('project-switcher-selected')).toBeNull()
    expect(input.placeholder).toBe('Go to project…')
    expect(rowNames()).toContain('checkout-stack')
    expect(rowNames()).toContain('fixtures-db')
    expect(screen.getByTestId('project-switcher-count').textContent).toBe('12 projects')
  })

  it('does nothing on a connection project or a database', () => {
    const input = openSwitcher()
    for (const name of ['checkout-stack', 'fixtures-db']) {
      type(input, name)
      expect(activeRowName()).toBe(name)
      expect(hint('select')).toBeNull()
      press(input, 'Enter', { shiftKey: true })
      expect(input.value).toBe(name)
      expect(screen.queryByTestId('project-switcher-selected')).toBeNull()
    }
    expectNothingOpened()
    expect(screen.getByTestId('project-switcher')).toBeInTheDocument()
  })

  it('does nothing with another modifier, with no result, or while the key is held', () => {
    const input = openSwitcher()
    for (const modifier of ['altKey', 'ctrlKey'] as const) {
      press(input, 'Enter', { shiftKey: true, [modifier]: true })
    }
    expect(screen.queryByTestId('project-switcher-selected')).toBeNull()

    type(input, 'zzqq')
    press(input, 'Enter', { shiftKey: true })
    expect(screen.queryByTestId('project-switcher-selected')).toBeNull()

    // A held Shift+Enter picks one project, not the list from the top down.
    type(input, '')
    press(input, 'Enter', { shiftKey: true })
    press(input, 'Enter', { shiftKey: true, repeat: true })
    press(input, 'Enter', { shiftKey: true, repeat: true })
    expect(pickedNames()).toEqual(['orders-web'])
  })

  it('never reaches the app shortcuts', () => {
    const seen: string[] = []
    const appShortcuts = (event: KeyboardEvent): void => {
      seen.push(event.key)
    }
    document.addEventListener('keydown', appShortcuts, true)
    try {
      const input = openSwitcher()
      press(input, 'Enter', { shiftKey: true })
      expect(pickedNames()).toEqual(['orders-web'])
      expect(seen).toEqual([])
    } finally {
      document.removeEventListener('keydown', appShortcuts, true)
    }
  })

  it('starts with nothing picked the next time the switcher is opened', () => {
    const input = openSwitcher()
    pick(input, 'seller-ios')
    press(input, 'Escape')
    expect(screen.queryByTestId('project-switcher')).toBeNull()
    expectNothingOpened()

    act(() => useProjectSwitcherStore.getState().open())
    expect(screen.queryByTestId('project-switcher-selected')).toBeNull()
    expect(rowNames()).toContain('checkout-stack')
  })
})

describe('the "Pull latest from origin" switch', () => {
  it('is there once a project is picked, and gone with the last one', () => {
    const input = openSwitcher()
    expect(screen.queryByTestId('project-switcher-auto-pull-switch')).toBeNull()

    pick(input, 'seller-ios')
    // With the picked projects, above the list.
    const picked = screen.getByTestId('project-switcher-selected')
    expect(within(picked).getByTestId('project-switcher-auto-pull-switch')).toBeInTheDocument()
    expect(picked).toHaveTextContent('Pull latest from origin')

    fireEvent.click(within(rowOf('seller-ios')).getByTestId('project-switcher-row-deselect'))
    expect(pickedNames()).toEqual([])
    expect(screen.queryByTestId('project-switcher-auto-pull-switch')).toBeNull()
  })

  it('is there for a project picked on its base branch too', () => {
    const input = openSwitcher()
    pickOnBase(input, 'seller-ios')
    expect(pullSwitch()).toBeChecked()
  })

  it('starts on', () => {
    const input = openSwitcher()
    pick(input, 'seller-ios')
    expect(pullSwitch()).toBeChecked()
  })

  it('starts on with the "auto-pull before worktree" setting off', () => {
    useSettingsStore.setState({ autoPullBeforeWorktree: false })
    const input = openSwitcher()
    pick(input, 'seller-ios')
    expect(pullSwitch()).toBeChecked()
  })

  it('is switched off with a click, which is kept as the setting and picks nothing', () => {
    const input = openSwitcher()
    pick(input, 'seller-ios')
    type(input, 'ads')

    fireEvent.click(pullSwitch())

    expect(pullSwitch()).not.toBeChecked()
    expect(useSettingsStore.getState().pullBeforeConnection).toBe(false)
    // The other pull setting is not this switch.
    expect(useSettingsStore.getState().autoPullBeforeWorktree).toBe(true)
    // Nothing else moved: the picked project, the query and the highlight are as they were.
    expect(pickedNames()).toEqual(['seller-ios'])
    expect(input.value).toBe('ads')
    expect(activeRowName()).toBe('ads-api')
    expect(screen.getByTestId('project-switcher')).toBeInTheDocument()

    fireEvent.click(pullSwitch())
    expect(pullSwitch()).toBeChecked()
    expect(useSettingsStore.getState().pullBeforeConnection).toBe(true)
  })

  it('is still off the next time the switcher is opened', () => {
    const input = openSwitcher()
    pick(input, 'seller-ios')
    fireEvent.click(pullSwitch())
    act(() => useProjectSwitcherStore.getState().close())
    expect(screen.queryByTestId('project-switcher')).toBeNull()

    act(() => useProjectSwitcherStore.getState().open())
    pick(screen.getByTestId('project-switcher-input') as HTMLInputElement, 'ads-api')
    expect(input).not.toBeInTheDocument()
    expect(pullSwitch()).not.toBeChecked()
  })

  it('is off when it was switched off in the New Connection dialog', () => {
    useSettingsStore.setState({ pullBeforeConnection: false })
    const input = openSwitcher()
    pick(input, 'seller-ios')
    expect(pullSwitch()).not.toBeChecked()
  })

  it('is not shown while the connection is created', async () => {
    const create = controllableCreate()
    const input = openSwitcher()
    pick(input, 'seller-ios')
    type(input, 'ads')
    press(input, 'Enter')

    expect(screen.queryByTestId('project-switcher-auto-pull-switch')).toBeNull()
    await create.finish('conn-1')
  })

  it('is back, as it was left, when the creation fails', async () => {
    const create = controllableCreate()
    const input = openSwitcher()
    pick(input, 'seller-ios')
    fireEvent.click(pullSwitch())
    type(input, 'ads')
    press(input, 'Enter')

    act(() => create.options().onError?.('Failed to create worktree in "ads-api": disk full'))
    await create.finish(null)

    expect(screen.getByTestId('project-switcher-create-error')).toBeInTheDocument()
    expect(pullSwitch()).not.toBeChecked()
  })
})

describe('Enter with projects picked', () => {
  it('connects the picked projects and the highlighted one, in that order', async () => {
    const create = controllableCreate()
    const input = openSwitcher()
    pick(input, 'seller-ios')
    pick(input, 'ads-api')
    type(input, 'ledger-co')
    press(input, 'Enter')

    expect(create.quickCreateConnection).toHaveBeenCalledTimes(1)
    expect(create.quickCreateConnection.mock.calls[0][0 as never]).toEqual([
      member('seller-ios'),
      member('ads-api'),
      member('ledger-core')
    ])
    // The pull is asked for outright, so it is a step of its own and not something the
    // worktree create does out of sight.
    expect(create.options().autoPull).toBe(true)
    // Nothing is opened as a project.
    expect(useProjectStore.getState().selectedProjectId).toBeNull()

    await create.finish('conn-1')
    expect(screen.queryByTestId('project-switcher')).toBeNull()
  })

  it('shows each step while the connection is created, then closes', async () => {
    const create = controllableCreate()
    const input = openSwitcher()
    pick(input, 'seller-ios')
    type(input, 'ads')
    press(input, 'Enter')

    expect(createSteps()).toEqual([
      'Pull seller-ios from origin',
      'Pull ads-api from origin',
      'Create worktree in seller-ios',
      'Create worktree in ads-api'
    ])
    expect(createTask('seller-ios', 'pull')).toHaveAttribute('data-status', 'pending')
    expect(createTask('seller-ios')).toHaveAttribute('data-status', 'pending')
    expect(screen.queryAllByTestId('project-switcher-row')).toHaveLength(0)
    expect(input.placeholder).toBe('Creating the connection…')
    expect(input.value).toBe('')

    // The pulls run side by side, ahead of the first worktree.
    act(() => {
      create.options().onProgress?.({ projectId: 'seller-ios', step: 'pull', status: 'running' })
      create.options().onProgress?.({ projectId: 'ads-api', step: 'pull', status: 'running' })
    })
    expect(createTask('seller-ios', 'pull')).toHaveAttribute('data-status', 'running')
    expect(createTask('ads-api', 'pull')).toHaveAttribute('data-status', 'running')
    expect(createTask('seller-ios')).toHaveAttribute('data-status', 'pending')
    act(() => {
      create.options().onProgress?.({ projectId: 'ads-api', step: 'pull', status: 'done' })
      create.options().onProgress?.({ projectId: 'seller-ios', step: 'pull', status: 'done' })
    })
    expect(createTask('seller-ios', 'pull')).toHaveAttribute('data-status', 'done')
    expect(createTask('ads-api', 'pull')).toHaveAttribute('data-status', 'done')

    act(() => {
      create
        .options()
        .onProgress?.({ projectId: 'seller-ios', step: 'worktree', status: 'running' })
    })
    expect(createTask('seller-ios')).toHaveAttribute('data-status', 'running')
    expect(createTask('ads-api')).toHaveAttribute('data-status', 'pending')
    act(() => {
      create.options().onProgress?.({ projectId: 'seller-ios', step: 'worktree', status: 'done' })
      create.options().onProgress?.({ projectId: 'ads-api', step: 'worktree', status: 'running' })
    })
    expect(createTask('seller-ios')).toHaveAttribute('data-status', 'done')
    expect(createTask('ads-api')).toHaveAttribute('data-status', 'running')

    await create.finish('conn-1')
    expect(screen.queryByTestId('project-switcher')).toBeNull()
  })

  it('pulls, and lists each pull, with the "auto-pull before worktree" setting off too', async () => {
    // That setting is about a single new worktree. Here the switch decides, as in the New
    // Connection dialog.
    useSettingsStore.setState({ autoPullBeforeWorktree: false })
    const create = controllableCreate()
    const input = openSwitcher()
    pick(input, 'seller-ios')
    type(input, 'ads')
    press(input, 'Enter')

    expect(createSteps()).toEqual([
      'Pull seller-ios from origin',
      'Pull ads-api from origin',
      'Create worktree in seller-ios',
      'Create worktree in ads-api'
    ])
    expect(create.options().autoPull).toBe(true)
    await create.finish('conn-1')
  })

  it('pulls nothing, and lists no pull, with "Pull latest from origin" switched off', async () => {
    const create = controllableCreate()
    const input = openSwitcher()
    pick(input, 'seller-ios')
    fireEvent.click(pullSwitch())
    type(input, 'ads')
    press(input, 'Enter')

    expect(createSteps()).toEqual(['Create worktree in seller-ios', 'Create worktree in ads-api'])
    // Said outright: left out, each worktree create would decide for itself.
    expect(create.options().autoPull).toBe(false)
    await create.finish('conn-1')
  })

  it('ignores Enter and typing while the connection is created', async () => {
    const create = controllableCreate()
    const input = openSwitcher()
    pick(input, 'seller-ios')
    type(input, 'ads')
    press(input, 'Enter')

    press(input, 'Enter')
    press(input, 'Enter', { shiftKey: true })
    press(input, 'ArrowDown')
    type(input, 'ledger')
    expect(create.quickCreateConnection).toHaveBeenCalledTimes(1)
    expect(input.value).toBe('')
    expect(screen.getByTestId('project-switcher-create-progress')).toBeInTheDocument()
    await create.finish('conn-1')
  })

  it('connects exactly the picked projects when it is pressed on one of them', async () => {
    const create = controllableCreate()
    const input = openSwitcher()
    pick(input, 'seller-ios')
    pick(input, 'ads-api')
    press(input, 'ArrowUp')
    expect(activeRowName()).toBe('ads-api')
    expect(hint('enter')).toBe('↵ connect 2 projects')
    press(input, 'Enter')

    expect(create.quickCreateConnection.mock.calls[0][0 as never]).toEqual([
      member('seller-ios'),
      member('ads-api')
    ])
    await create.finish('conn-1')
  })

  it('opens the project when it is the only one picked and Enter is pressed on it', () => {
    const create = controllableCreate()
    const input = openSwitcher()
    pick(input, 'seller-ios')
    press(input, 'ArrowUp')
    expect(activeRowName()).toBe('seller-ios')
    expect(hint('enter')).toBe('↵ open')
    press(input, 'Enter')

    expect(create.quickCreateConnection).not.toHaveBeenCalled()
    expect(useProjectStore.getState().selectedProjectId).toBe('seller-ios')
    expect(screen.queryByTestId('project-switcher')).toBeNull()
  })

  it('connects nothing when the text typed matches no project', () => {
    const create = controllableCreate()
    const input = openSwitcher()
    pick(input, 'seller-ios')
    pick(input, 'ads-api')
    type(input, 'zzqq')

    expect(screen.getByTestId('project-switcher-empty').textContent).toBe(
      'No project matches “zzqq”'
    )
    expect(pickedNames()).toEqual(['seller-ios', 'ads-api'])
    expect(activeRowName()).toBeNull()
    expect(input.getAttribute('aria-activedescendant')).toBeNull()
    press(input, 'Enter')
    press(input, 'ArrowDown')
    press(input, 'Enter')
    expect(create.quickCreateConnection).not.toHaveBeenCalled()
    expect(screen.getByTestId('project-switcher')).toBeInTheDocument()

    // The picked projects are above: the arrow reaches them.
    press(input, 'ArrowUp')
    expect(activeRowName()).toBe('ads-api')
  })

  it('does not connect from an Enter held since the pick before it', () => {
    const create = controllableCreate()
    const input = openSwitcher()
    pick(input, 'seller-ios')
    press(input, 'Enter', { repeat: true })
    expect(create.quickCreateConnection).not.toHaveBeenCalled()
    expect(pickedNames()).toEqual(['seller-ios'])
  })

  it('leaves the Pinned Board for the new connection', async () => {
    useKanbanStore.setState({ isPinnedBoardActive: true, isPinnedBoardBehindSession: false })
    const create = controllableCreate()
    const input = openSwitcher()
    pick(input, 'seller-ios')
    type(input, 'ads')
    press(input, 'Enter')
    expect(useKanbanStore.getState().isPinnedBoardActive).toBe(true)
    await create.finish('conn-1')
    expect(useKanbanStore.getState().isPinnedBoardActive).toBe(false)
  })
})

describe('when the connection is not created', () => {
  it('comes back to the picker with every project still picked and says why', async () => {
    const create = controllableCreate()
    const input = openSwitcher()
    pick(input, 'seller-ios')
    type(input, 'ads')
    press(input, 'Enter')
    act(() => {
      create.options().onError?.('Failed to create worktree in "ads-api": disk full')
    })
    await create.finish(null)

    expect(screen.getByTestId('project-switcher')).toBeInTheDocument()
    expect(screen.queryByTestId('project-switcher-create-progress')).toBeNull()
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('Connection not created')
    expect(alert.textContent).toContain('Failed to create worktree in "ads-api": disk full')
    // The project Enter was pressed on is picked too: the same Enter tries again.
    expect(pickedNames()).toEqual(['seller-ios', 'ads-api'])
    expect(activeRowName()).toBe('ads-api')
    expect(toastMock.error).not.toHaveBeenCalled()
    expect(useKanbanStore.getState().isPinnedBoardActive).toBe(false)

    press(input, 'Enter')
    expect(create.quickCreateConnection).toHaveBeenCalledTimes(2)
    expect(create.quickCreateConnection.mock.calls[1][0 as never]).toEqual([
      member('seller-ios'),
      member('ads-api')
    ])
    expect(screen.queryByRole('alert')).toBeNull()
    await create.finish('conn-2')
    expect(screen.queryByTestId('project-switcher')).toBeNull()
  })

  it('shows which pull failed, then says why over the picker', async () => {
    const create = controllableCreate()
    const input = openSwitcher()
    pick(input, 'seller-ios')
    type(input, 'ads')
    press(input, 'Enter')
    const reason =
      'local main has commits that origin/main does not, so it cannot be fast-forwarded'
    act(() => {
      create.options().onProgress?.({ projectId: 'seller-ios', step: 'pull', status: 'done' })
      create
        .options()
        .onProgress?.({ projectId: 'ads-api', step: 'pull', status: 'failed', error: reason })
    })
    expect(createTask('seller-ios', 'pull')).toHaveAttribute('data-status', 'done')
    expect(createTask('ads-api', 'pull')).toHaveAttribute('data-status', 'failed')
    // No worktree was started.
    expect(createTask('seller-ios')).toHaveAttribute('data-status', 'pending')
    expect(createTask('ads-api')).toHaveAttribute('data-status', 'pending')

    act(() => create.options().onError?.(`Could not pull "ads-api": ${reason}`))
    await create.finish(null)
    expect(screen.queryByTestId('project-switcher-create-progress')).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain(`Could not pull "ads-api": ${reason}`)
    expect(pickedNames()).toEqual(['seller-ios', 'ads-api'])
  })

  it('drops the reason once the picked projects change', async () => {
    const create = controllableCreate()
    const input = openSwitcher()
    pick(input, 'seller-ios')
    type(input, 'ads')
    press(input, 'Enter')
    act(() => create.options().onError?.('disk full'))
    await create.finish(null)
    expect(screen.getByRole('alert')).toBeInTheDocument()

    pick(input, 'ledger-core')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(pickedNames()).toEqual(['seller-ios', 'ads-api', 'ledger-core'])
  })

  it('says it in a toast when the switcher was closed meanwhile', async () => {
    const create = controllableCreate()
    const input = openSwitcher()
    pick(input, 'seller-ios')
    type(input, 'ads')
    press(input, 'Enter')
    press(input, 'Escape')
    expect(screen.queryByTestId('project-switcher')).toBeNull()

    act(() => create.options().onError?.('disk full'))
    await create.finish(null)
    expect(toastMock.error).toHaveBeenCalledWith('disk full')
    expect(screen.queryByTestId('project-switcher')).toBeNull()
  })
})

describe('the mouse', () => {
  it('picks with a Shift+click and connects with a plain click', async () => {
    const create = controllableCreate()
    openSwitcher()
    fireEvent.click(rowOf('seller-ios'), { shiftKey: true })
    expect(pickedNames()).toEqual(['seller-ios'])
    expect(screen.getByTestId('project-switcher')).toBeInTheDocument()
    expectNothingOpened()

    fireEvent.click(rowOf('pricing-api'))
    expect(create.quickCreateConnection.mock.calls[0][0 as never]).toEqual([
      member('seller-ios'),
      member('pricing-api')
    ])
    await create.finish('conn-1')
  })

  it('takes a picked project out with its remove button, which replaces the pin button', () => {
    const create = controllableCreate()
    const input = openSwitcher()
    pick(input, 'seller-ios')
    pick(input, 'ads-api')

    const picked = rowOf('seller-ios')
    expect(within(picked).queryByTestId('project-switcher-row-pin')).toBeNull()
    const remove = within(picked).getByTestId('project-switcher-row-deselect')
    expect(remove).toHaveAccessibleName('Remove from the new connection: seller-ios')
    expect(within(rowOf('ledger-core')).queryByTestId('project-switcher-row-deselect')).toBeNull()

    fireEvent.click(remove)
    expect(pickedNames()).toEqual(['ads-api'])
    expect(within(rowOf('seller-ios')).getByTestId('project-switcher-row-pin')).toBeInTheDocument()
    expect(create.quickCreateConnection).not.toHaveBeenCalled()
    expect(screen.getByTestId('project-switcher')).toBeInTheDocument()
  })
})

describe('the footer hints', () => {
  it('say what Enter and Shift+Enter do on the highlighted row', () => {
    const input = openSwitcher()
    expect(hint('enter')).toBe('↵ open')
    expect(hint('select')).toBe('⇧↵ pick several')

    pick(input, 'seller-ios')
    // On a project that is not picked yet.
    expect(hint('enter')).toBe('↵ connect 2 projects')
    expect(hint('select')).toBe('⇧↵ add')

    pick(input, 'ads-api')
    expect(hint('enter')).toBe('↵ connect 3 projects')
    press(input, 'ArrowUp')
    // On a picked one.
    expect(hint('enter')).toBe('↵ connect 2 projects')
    expect(hint('select')).toBe('⇧↵ remove')
  })

  it('say what Cmd+Shift+Enter does on the highlighted row', () => {
    const input = openSwitcher()
    expect(hint('base')).toBe('⌘⇧↵ pick base branch')

    pickOnBase(input, 'seller-ios')
    // On a project that is not picked yet.
    expect(hint('base')).toBe('⌘⇧↵ add base branch')

    press(input, 'ArrowUp')
    // On one picked on its base branch: the other key gives it a new worktree instead.
    expect(hint('base')).toBe('⌘⇧↵ remove')
    expect(hint('select')).toBe('⇧↵ new worktree')

    press(input, 'Enter', { shiftKey: true })
    // On one picked for a new worktree.
    expect(hint('base')).toBe('⌘⇧↵ base branch')
    expect(hint('select')).toBe('⇧↵ remove')

    // Not a key of a connection project or a database.
    press(input, 'Enter', { shiftKey: true })
    type(input, 'checkout-stack')
    expect(hint('base')).toBeNull()
  })

  it('say that Cmd+Enter connects the picked projects instead of pinning', () => {
    const input = openSwitcher()
    expect(hint('pin')).toBe('⌘↵ unpin')
    expect(hint('connect-picked')).toBeNull()

    pick(input, 'seller-ios')
    // One project is not a connection: it is opened.
    expect(hint('pin')).toBeNull()
    expect(hint('connect-picked')).toBe('⌘↵ open picked')

    pickOnBase(input, 'ads-api')
    expect(hint('connect-picked')).toBe('⌘↵ connect 2 picked')
    // Whatever is highlighted, and with nothing highlighted.
    type(input, 'zzqq')
    expect(hint('connect-picked')).toBe('⌘↵ connect 2 picked')

    // Nothing picked any more: the key pins again.
    type(input, '')
    press(input, 'ArrowUp')
    expect(activeRowName()).toBe('ads-api')
    press(input, 'Enter', { metaKey: true, shiftKey: true })
    type(input, 'zzqq')
    type(input, '')
    press(input, 'ArrowUp')
    expect(activeRowName()).toBe('seller-ios')
    press(input, 'Enter', { shiftKey: true })
    expect(pickedNames()).toEqual([])
    expect(hint('connect-picked')).toBeNull()
    expect(hint('pin')).not.toBeNull()
  })
})

describe('Cmd+Shift+Enter', () => {
  it('picks the highlighted project on its base branch, clears the field, and opens nothing', () => {
    const create = controllableCreate()
    const input = openSwitcher()
    pickOnBase(input, 'seller-ios')

    expect(pickedNames()).toEqual(['seller-ios'])
    expect(pickModeOf('seller-ios')).toBe('base branch')
    expect(input.value).toBe('')
    expect(input.placeholder).toBe('Add another project…')
    expect(screen.getByTestId('project-switcher')).toBeInTheDocument()
    expect(create.quickCreateConnection).not.toHaveBeenCalled()
    expectNothingOpened()
    // The rows that are not picked say nothing about how they would join.
    expect(pickModeOf('ads-api')).toBeNull()
  })

  it('tells a project picked on its base branch from one picked for a new worktree', () => {
    const input = openSwitcher()
    pickOnBase(input, 'seller-ios')
    pick(input, 'ads-api')

    expect(pickedNames()).toEqual(['seller-ios', 'ads-api'])
    expect(pickModeOf('seller-ios')).toBe('base branch')
    expect(pickModeOf('ads-api')).toBe('new worktree')
  })

  it('connects the base branch of the projects picked with it, and a new worktree of the others', async () => {
    const create = controllableCreate()
    const input = openSwitcher()
    pickOnBase(input, 'seller-ios')
    pick(input, 'ads-api')
    pickOnBase(input, 'pricing-api')
    type(input, 'ledger-co')
    press(input, 'Enter')

    // The project Enter is pressed on gets a new worktree, as it always did.
    expect(create.quickCreateConnection.mock.calls[0][0 as never]).toEqual([
      baseMember('seller-ios'),
      member('ads-api'),
      baseMember('pricing-api'),
      member('ledger-core')
    ])
    expect(create.quickCreateConnection.mock.calls[0][0 as never][1]).not.toHaveProperty('useBase')
    await create.finish('conn-1')
    expect(screen.queryByTestId('project-switcher')).toBeNull()
  })

  it('lists the base branches first, and pulls and creates a worktree only for the others', async () => {
    const create = controllableCreate()
    const input = openSwitcher()
    pick(input, 'ads-api')
    pickOnBase(input, 'seller-ios')
    type(input, 'ledger-co')
    press(input, 'Enter')

    expect(createSteps()).toEqual([
      'Use the base branch of seller-ios',
      'Pull ads-api from origin',
      'Pull ledger-core from origin',
      'Create worktree in ads-api',
      'Create worktree in ledger-core'
    ])
    expect(screen.getByTestId('project-switcher-creating-hint').textContent).toBe(
      'Creating the worktrees, then the connection'
    )
    expect(createTask('seller-ios', 'base')).toHaveAttribute('data-status', 'pending')
    act(() => {
      create.options().onProgress?.({ projectId: 'seller-ios', step: 'base', status: 'done' })
    })
    expect(createTask('seller-ios', 'base')).toHaveAttribute('data-status', 'done')
    await create.finish('conn-1')
  })

  it('takes a project picked on its base branch out again, and the highlight goes back with it', () => {
    const input = openSwitcher()
    pickOnBase(input, 'seller-ios')
    pickOnBase(input, 'ads-api')
    press(input, 'ArrowUp')
    expect(activeRowName()).toBe('ads-api')

    press(input, 'Enter', { metaKey: true, shiftKey: true })
    expect(pickedNames()).toEqual(['seller-ios'])
    expect(activeRowName()).toBe('ads-api')
    expect(listNames()).toContain('ads-api')
  })

  it('changes how a picked project joins when the other key is pressed on it', async () => {
    const create = controllableCreate()
    const input = openSwitcher()
    pick(input, 'seller-ios')
    pickOnBase(input, 'ads-api')

    // Shift+Enter on the one picked on its base branch: a new worktree instead.
    press(input, 'ArrowUp')
    expect(activeRowName()).toBe('ads-api')
    press(input, 'Enter', { shiftKey: true })
    expect(pickedNames()).toEqual(['seller-ios', 'ads-api'])
    expect(pickModeOf('ads-api')).toBe('new worktree')
    expect(activeRowName()).toBe('ads-api')

    // Cmd+Shift+Enter on the one picked for a new worktree: its base branch instead.
    press(input, 'ArrowUp')
    expect(activeRowName()).toBe('seller-ios')
    press(input, 'Enter', { metaKey: true, shiftKey: true })
    expect(pickedNames()).toEqual(['seller-ios', 'ads-api'])
    expect(pickModeOf('seller-ios')).toBe('base branch')

    press(input, 'Enter')
    expect(create.quickCreateConnection.mock.calls[0][0 as never]).toEqual([
      baseMember('seller-ios'),
      member('ads-api')
    ])
    await create.finish('conn-1')
  })

  it('does nothing on a connection project or a database, with Alt, or while the key is held', () => {
    const input = openSwitcher()
    for (const name of ['checkout-stack', 'fixtures-db']) {
      type(input, name)
      press(input, 'Enter', { metaKey: true, shiftKey: true })
      expect(input.value).toBe(name)
      expect(screen.queryByTestId('project-switcher-selected')).toBeNull()
    }

    type(input, '')
    press(input, 'Enter', { metaKey: true, shiftKey: true, altKey: true })
    press(input, 'Enter', { metaKey: true, ctrlKey: true, shiftKey: true })
    expect(screen.queryByTestId('project-switcher-selected')).toBeNull()

    // A held key picks one project, not the list from the top down.
    press(input, 'Enter', { metaKey: true, shiftKey: true })
    press(input, 'Enter', { metaKey: true, shiftKey: true, repeat: true })
    press(input, 'Enter', { metaKey: true, shiftKey: true, repeat: true })
    expect(pickedNames()).toEqual(['orders-web'])
    expectNothingOpened()
  })

  it('is Ctrl+Shift+Enter off macOS', () => {
    platform.mac = false
    const input = openSwitcher()
    expect(hint('base')).toBe('ctrl ⇧↵ pick base branch')

    press(input, 'Enter', { metaKey: true, shiftKey: true })
    expect(screen.queryByTestId('project-switcher-selected')).toBeNull()

    press(input, 'Enter', { ctrlKey: true, shiftKey: true })
    expect(pickedNames()).toEqual(['orders-web'])
    expect(pickModeOf('orders-web')).toBe('base branch')
  })

  it('never reaches the app shortcuts', () => {
    const seen: string[] = []
    const appShortcuts = (event: KeyboardEvent): void => {
      seen.push(event.key)
    }
    document.addEventListener('keydown', appShortcuts, true)
    try {
      const input = openSwitcher()
      press(input, 'Enter', { metaKey: true, shiftKey: true })
      expect(seen).toEqual([])
    } finally {
      document.removeEventListener('keydown', appShortcuts, true)
    }
  })

  it('is a Cmd+Shift+click with the mouse', async () => {
    const create = controllableCreate()
    openSwitcher()
    fireEvent.click(rowOf('seller-ios'), { shiftKey: true, metaKey: true })
    expect(pickedNames()).toEqual(['seller-ios'])
    expect(pickModeOf('seller-ios')).toBe('base branch')
    expectNothingOpened()

    fireEvent.click(rowOf('pricing-api'))
    expect(create.quickCreateConnection.mock.calls[0][0 as never]).toEqual([
      baseMember('seller-ios'),
      member('pricing-api')
    ])
    await create.finish('conn-1')
  })
})

describe('Cmd+Enter with projects picked', () => {
  it('connects the picked projects alone, without the highlighted one', async () => {
    const create = controllableCreate()
    const input = openSwitcher()
    pick(input, 'seller-ios')
    pick(input, 'ads-api')
    type(input, 'ledger-co')
    expect(activeRowName()).toBe('ledger-core')
    press(input, 'Enter', { metaKey: true })

    expect(create.quickCreateConnection).toHaveBeenCalledTimes(1)
    expect(create.quickCreateConnection.mock.calls[0][0 as never]).toEqual([
      member('seller-ios'),
      member('ads-api')
    ])
    expect(createSteps()).toEqual([
      'Pull seller-ios from origin',
      'Pull ads-api from origin',
      'Create worktree in seller-ios',
      'Create worktree in ads-api'
    ])
    expect(useProjectStore.getState().selectedProjectId).toBeNull()

    await create.finish('conn-1')
    expect(screen.queryByTestId('project-switcher')).toBeNull()
  })

  it('connects the base branches of two projects with no worktree and no pull', async () => {
    const create = controllableCreate()
    const input = openSwitcher()
    pickOnBase(input, 'seller-ios')
    pickOnBase(input, 'ads-api')
    // The first project left is highlighted and stays out of the connection.
    expect(activeRowName()).toBe('orders-web')
    press(input, 'Enter', { metaKey: true })

    expect(create.quickCreateConnection.mock.calls[0][0 as never]).toEqual([
      baseMember('seller-ios'),
      baseMember('ads-api')
    ])
    expect(createSteps()).toEqual([
      'Use the base branch of seller-ios',
      'Use the base branch of ads-api'
    ])
    expect(screen.getByTestId('project-switcher-creating-hint').textContent).toBe(
      'Connecting the base branches'
    )
    await create.finish('conn-1')
    expect(screen.queryByTestId('project-switcher')).toBeNull()
  })

  it('does not pin the highlighted project', async () => {
    const request = vi.fn(async () => undefined)
    setRendererRpcClient({ request: request as never, subscribe: () => () => {} })
    const create = controllableCreate()
    const input = openSwitcher()
    pick(input, 'seller-ios')
    pick(input, 'ads-api')
    type(input, 'ledger-worker')
    const pinnedBefore = usePinnedStore.getState().pinnedProjectIds
    request.mockClear()
    press(input, 'Enter', { metaKey: true })
    await create.finish('conn-1')

    expect(request).not.toHaveBeenCalled()
    expect(usePinnedStore.getState().pinnedProjectIds).toBe(pinnedBefore)
    expect(toastMock.success).not.toHaveBeenCalled()
  })

  it('connects them when the text typed matches no project', async () => {
    const create = controllableCreate()
    const input = openSwitcher()
    pick(input, 'seller-ios')
    pick(input, 'ads-api')
    type(input, 'zzqq')
    expect(activeRowName()).toBeNull()
    press(input, 'Enter', { metaKey: true })

    expect(create.quickCreateConnection.mock.calls[0][0 as never]).toEqual([
      member('seller-ios'),
      member('ads-api')
    ])
    await create.finish('conn-1')
  })

  it('opens the project when it is the only one picked', () => {
    const create = controllableCreate()
    const input = openSwitcher()
    pickOnBase(input, 'seller-ios')
    type(input, 'ads')
    expect(activeRowName()).toBe('ads-api')
    press(input, 'Enter', { metaKey: true })

    expect(create.quickCreateConnection).not.toHaveBeenCalled()
    expect(useProjectStore.getState().selectedProjectId).toBe('seller-ios')
    expect(screen.queryByTestId('project-switcher')).toBeNull()
  })

  it('does nothing held since the pick before it, with Alt, or while the connection is created', async () => {
    const create = controllableCreate()
    const input = openSwitcher()
    pickOnBase(input, 'seller-ios')
    pickOnBase(input, 'ads-api')
    // Shift let go first: the key repeats as Cmd+Enter.
    press(input, 'Enter', { metaKey: true, repeat: true })
    press(input, 'Enter', { metaKey: true, altKey: true })
    press(input, 'Enter', { ctrlKey: true })
    expect(create.quickCreateConnection).not.toHaveBeenCalled()
    expect(pickedNames()).toEqual(['seller-ios', 'ads-api'])

    press(input, 'Enter', { metaKey: true })
    press(input, 'Enter', { metaKey: true })
    expect(create.quickCreateConnection).toHaveBeenCalledTimes(1)
    await create.finish('conn-1')
  })

  it('is Ctrl+Enter off macOS', async () => {
    platform.mac = false
    const create = controllableCreate()
    const input = openSwitcher()
    press(input, 'Enter', { ctrlKey: true, shiftKey: true })
    press(input, 'Enter', { ctrlKey: true, shiftKey: true })
    expect(pickedNames()).toEqual(['orders-web', 'checkout-api'])
    expect(hint('connect-picked')).toBe('ctrl ↵ connect 2 picked')

    press(input, 'Enter', { metaKey: true })
    expect(create.quickCreateConnection).not.toHaveBeenCalled()
    press(input, 'Enter', { ctrlKey: true })
    expect(create.quickCreateConnection.mock.calls[0][0 as never]).toEqual([
      baseMember('orders-web'),
      baseMember('checkout-api')
    ])
    await create.finish('conn-1')
  })

  it('comes back with the projects picked as they were when the connection is not created', async () => {
    const create = controllableCreate()
    const input = openSwitcher()
    pickOnBase(input, 'seller-ios')
    pick(input, 'ads-api')
    press(input, 'Enter', { metaKey: true })
    act(() => {
      create
        .options()
        .onError?.('Could not use the base branch of "seller-ios": its base worktree was not found')
    })
    await create.finish(null)

    expect(screen.getByRole('alert').textContent).toContain(
      'Could not use the base branch of "seller-ios"'
    )
    expect(pickedNames()).toEqual(['seller-ios', 'ads-api'])
    expect(pickModeOf('seller-ios')).toBe('base branch')
    expect(pickModeOf('ads-api')).toBe('new worktree')

    press(input, 'Enter', { metaKey: true })
    expect(create.quickCreateConnection.mock.calls[1][0 as never]).toEqual([
      baseMember('seller-ios'),
      member('ads-api')
    ])
    await create.finish('conn-2')
  })
})

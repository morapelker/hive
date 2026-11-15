// Pinning from the "Go to project" switcher: Cmd+Enter on the highlighted row and a row's pin
// button put a project on the Pinned Board or take it off, without opening it and without
// closing the switcher. Runs against the real pinned, worktree, connection and database
// stores, with a small in-memory stand-in for the database behind the RPC client. The pin
// action's own rules are tested in lib/project-pin.test.ts.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { useProjectSwitcherStore } from '@/stores/useProjectSwitcherStore'
import { useCommandPaletteStore } from '@/stores/useCommandPaletteStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { usePinnedStore } from '@/stores/usePinnedStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useDataProjectStore } from '@/stores/useDataProjectStore'
import { sampleDataProject, sampleGitProject } from '@/components/data-projects/data-project.sample'
import type { DataProject } from '@shared/data-projects/types'
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

interface WorktreeRow {
  id: string
  project_id: string
  name: string
  branch_name: string
  path: string
  status: 'active'
  is_default: boolean
  pinned: number
  created_at: string
  last_accessed_at: string
}

interface ConnectionRow {
  id: string
  name: string
  status: 'active'
  path: string
  pinned: number
  saved_project_id: string | null
  is_base: number
  members: never[]
}

const worktree = (
  id: string,
  projectId: string,
  extra: Partial<WorktreeRow> = {}
): WorktreeRow => ({
  id,
  project_id: projectId,
  name: id,
  branch_name: id,
  path: `/repo/${projectId}/${id}`,
  status: 'active',
  is_default: false,
  pinned: 0,
  created_at: '2026-01-01T00:00:00.000Z',
  last_accessed_at: '2026-01-01T00:00:00.000Z',
  ...extra
})

let worktrees: WorktreeRow[]
let connections: ConnectionRow[]
let databases: DataProject[]
/** Pin writes for these worktree, connection or database ids fail. */
let failing: Set<string>
let calls: Array<{ method: string; params: Record<string, unknown> }>

function installDatabase(): void {
  setRendererRpcClient({
    request: (async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      switch (method) {
        case 'db.worktree.getActiveByProject':
          return worktrees.filter((wt) => wt.project_id === params.projectId)
        case 'db.worktree.getAllActive':
          return worktrees
        case 'db.worktree.getPinned':
          return worktrees.filter((wt) => wt.pinned === 1)
        case 'db.worktree.setPinned': {
          const id = params.worktreeId as string
          if (failing.has(id)) return { success: false, error: 'database is locked' }
          const row = worktrees.find((wt) => wt.id === id)
          if (row) row.pinned = params.pinned ? 1 : 0
          return { success: true }
        }
        case 'connectionOps.getAll':
          return { success: true, connections: connections.map((c) => ({ ...c })) }
        case 'connectionOps.getPinned':
          return connections.filter((c) => c.pinned === 1).map((c) => ({ ...c }))
        case 'connectionOps.setPinned': {
          const id = params.connectionId as string
          if (failing.has(id)) return { success: false, error: 'database is locked' }
          const row = connections.find((c) => c.id === id)
          if (row) row.pinned = params.pinned ? 1 : 0
          return { success: true }
        }
        case 'dataProjects.update': {
          const id = params.id as string
          if (failing.has(id)) throw new Error('database is locked')
          const index = databases.findIndex((p) => p.id === id)
          databases[index] = { ...databases[index], ...(params.patch as Partial<DataProject>) }
          return databases[index]
        }
        default:
          return null
      }
    }) as never,
    subscribe: vi.fn(() => () => {})
  })
}

const pinnedInDatabase = (): string[] =>
  [
    ...worktrees.filter((wt) => wt.pinned === 1).map((wt) => wt.id),
    ...connections.filter((c) => c.pinned === 1).map((c) => c.id),
    ...databases.filter((p) => p.pinned).map((p) => p.id)
  ].sort()

const pinWrites = (): number =>
  calls.filter(
    (c) =>
      c.method === 'db.worktree.setPinned' ||
      c.method === 'connectionOps.setPinned' ||
      c.method === 'dataProjects.update'
  ).length

function seedStores(): void {
  worktrees = [
    // Pinned section order: orders-web first, then checkout-api (two pinned worktrees).
    worktree('wt-orders', 'orders-web', { is_default: true, pinned: 1 }),
    worktree('wt-checkout', 'checkout-api', { is_default: true, pinned: 1 }),
    worktree('wt-checkout-2', 'checkout-api', { pinned: 1 }),
    worktree('wt-checkout-3', 'checkout-api'),
    worktree('wt-ledger-worker', 'ledger-worker', { is_default: true }),
    // In the database only: these projects were never expanded.
    worktree('wt-ledger-core', 'ledger-core', { is_default: true }),
    worktree('wt-ledger-api', 'ledger-api', { is_default: true }),
    worktree('wt-pricing', 'pricing-api', { is_default: true }),
    worktree('wt-ads', 'ads-api', { is_default: true })
  ]
  connections = [
    {
      id: 'stack-base',
      name: 'stack-base',
      status: 'active',
      path: '/Users/ana/.hive/connections/stack-base',
      pinned: 0,
      saved_project_id: 'checkout-stack',
      is_base: 1,
      members: []
    }
  ]
  databases = [
    sampleDataProject({
      id: 'fixtures-db',
      name: 'fixtures-db',
      engine: 'sqlite',
      config: { filePath: '/Users/ana/data/fixtures.sqlite' },
      sortOrder: 21,
      lastAccessedAt: minutesAgo(6000)
    })
  ]

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
  useDataProjectStore.setState({ projects: [...databases] })
  const loaded = (projectId: string): [string, never[]] => [
    projectId,
    worktrees.filter((wt) => wt.project_id === projectId) as never[]
  ]
  useWorktreeStore.setState({
    worktreesByProject: new Map([
      loaded('orders-web'),
      loaded('checkout-api'),
      loaded('ledger-worker')
    ]),
    loadedProjectIds: new Set(['orders-web', 'checkout-api', 'ledger-worker']),
    selectedWorktreeId: null,
    hydrateAllWorktrees: vi.fn(async () => {})
  })
  usePinnedStore.setState({
    pinnedWorktreeIds: new Set(['wt-orders', 'wt-checkout', 'wt-checkout-2']),
    pinnedConnectionIds: new Set(),
    pinnedProjectIds: new Set(['orders-web', 'checkout-api']),
    loaded: true
  })
  useConnectionStore.setState({ connections: connections as never, selectedConnectionId: null })
  useKanbanStore.setState({ isPinnedBoardActive: false, isPinnedBoardBehindSession: false })
  useSessionStore.setState({ sessionsByWorktree: new Map(), sessionsByConnection: new Map() })
  useWorktreeStatusStore.setState({ sessionStatuses: {} })
  useCommandPaletteStore.setState({ isOpen: false })
  useSettingsStore.setState({ vimModeEnabled: false })
}

function openSwitcher(): HTMLInputElement {
  render(<ProjectSwitcher />)
  act(() => useProjectSwitcherStore.getState().open())
  return screen.getByTestId('project-switcher-input') as HTMLInputElement
}

const rowNames = (): string[] =>
  screen
    .queryAllByTestId('project-switcher-row')
    .map((row) => within(row).getByTestId('project-switcher-row-name').textContent ?? '')

const activeRowName = (): string | null => {
  const active = screen
    .queryAllByTestId('project-switcher-row')
    .filter((row) => row.getAttribute('aria-selected') === 'true')
  expect(active.length).toBeLessThanOrEqual(1)
  return active[0] ? within(active[0]).getByTestId('project-switcher-row-name').textContent : null
}

const rowOf = (name: string): HTMLElement => {
  const row = screen
    .getAllByTestId('project-switcher-row')
    .find((r) => within(r).getByTestId('project-switcher-row-name').textContent === name)
  if (!row) throw new Error(`No row for ${name}`)
  return row
}

const isMarkedPinned = (name: string): boolean =>
  within(rowOf(name)).queryByTestId('project-switcher-row-pinned') !== null

const pinButtonOf = (name: string): HTMLElement =>
  within(rowOf(name)).getByTestId('project-switcher-row-pin')

const groupCount = (id: 'pinned' | 'recent' | 'all'): string | null =>
  screen.queryByTestId(`project-switcher-group-${id}`)?.textContent ?? null

const pinHint = (): string | null =>
  screen.queryByTestId('project-switcher-pin-hint')?.textContent ?? null

const type = (input: HTMLInputElement, value: string): void => {
  fireEvent.change(input, { target: { value } })
}

const press = (input: HTMLElement, key: string, init: KeyboardEventInit = {}): void => {
  fireEvent.keyDown(input, { key, ...init })
}

/** Cmd+Enter, then everything the pin action awaits. */
const pressPin = async (input: HTMLElement, init: KeyboardEventInit = {}): Promise<void> => {
  const writes = pinWrites()
  press(input, 'Enter', { metaKey: true, ...init })
  await waitFor(() => expect(pinWrites()).toBeGreaterThan(writes))
  // The last write's result reaches the stores a few promise turns later.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/** Nothing was opened: no project, worktree or database is selected and the board is as it was. */
const expectNothingOpened = (): void => {
  expect(useProjectStore.getState().selectedProjectId).toBeNull()
  expect(useWorktreeStore.getState().selectedWorktreeId).toBeNull()
  expect(useDataProjectStore.getState().selectedDataProjectId).toBeNull()
  expect(screen.getByTestId('project-switcher')).toBeInTheDocument()
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  platform.mac = true
  calls = []
  failing = new Set()
  seedStores()
  installDatabase()
})

afterEach(() => {
  act(() => useProjectSwitcherStore.getState().close())
  cleanup()
  vi.useRealTimers()
  resetRendererRpcClientForTests()
})

describe('Cmd+Enter', () => {
  it('pins the highlighted project, keeps the switcher open and opens nothing', async () => {
    const input = openSwitcher()
    type(input, 'ledg')
    expect(activeRowName()).toBe('ledger-core')
    expect(isMarkedPinned('ledger-core')).toBe(false)

    await pressPin(input)

    // ledger-core was never expanded: its default worktree was read from the database.
    expect(pinnedInDatabase()).toContain('wt-ledger-core')
    expect(usePinnedStore.getState().pinnedProjectIds.has('ledger-core')).toBe(true)
    expect(isMarkedPinned('ledger-core')).toBe(true)
    expect(toastMock.success).toHaveBeenCalledWith('Pinned ledger-core')
    expectNothingOpened()
    // The query, the results and the highlight are as they were.
    expect(input.value).toBe('ledg')
    expect(rowNames()).toEqual(['ledger-core', 'ledger-api', 'ledger-worker'])
    expect(activeRowName()).toBe('ledger-core')
    expect(document.activeElement).toBe(input)
  })

  it('unpins the highlighted project when it is pinned, on every one of its worktrees', async () => {
    const input = openSwitcher()
    type(input, 'checkout-api')
    expect(activeRowName()).toBe('checkout-api')
    expect(isMarkedPinned('checkout-api')).toBe(true)

    await pressPin(input)

    expect(pinnedInDatabase()).toEqual(['wt-orders'])
    expect(usePinnedStore.getState().pinnedProjectIds.has('checkout-api')).toBe(false)
    expect(isMarkedPinned('checkout-api')).toBe(false)
    expect(toastMock.success).toHaveBeenCalledWith('Unpinned checkout-api')
    expectNothingOpened()
  })

  it('moves the project into the Pinned group and keeps the highlight on it', async () => {
    const input = openSwitcher()
    expect(rowNames().slice(0, 3)).toEqual(['orders-web', 'checkout-api', 'ledger-core'])
    // Down to ledger-worker, the second row of All projects.
    for (let i = 0; i < 8; i++) press(input, 'ArrowDown')
    expect(activeRowName()).toBe('ledger-worker')
    expect(rowNames().indexOf('ledger-worker')).toBe(8)

    await pressPin(input)

    expect(groupCount('pinned')).toBe('Pinned3')
    expect(rowNames().slice(0, 4)).toEqual([
      'orders-web',
      'checkout-api',
      'ledger-worker',
      'ledger-core'
    ])
    expect(activeRowName()).toBe('ledger-worker')
    expect(input.getAttribute('aria-activedescendant')).toBe(rowOf('ledger-worker').id)

    // The arrows go on from where the project is now.
    press(input, 'ArrowDown')
    expect(activeRowName()).toBe('ledger-core')
    press(input, 'ArrowUp')
    press(input, 'ArrowUp')
    expect(activeRowName()).toBe('checkout-api')
  })

  it('moves an unpinned project out of the Pinned group and keeps the highlight on it', async () => {
    const input = openSwitcher()
    press(input, 'ArrowDown')
    expect(activeRowName()).toBe('checkout-api')

    await pressPin(input)

    expect(groupCount('pinned')).toBe('Pinned1')
    // Opened longest ago: it is now the last row of All projects.
    expect(rowNames().at(-1)).toBe('checkout-api')
    expect(activeRowName()).toBe('checkout-api')
    expect(isMarkedPinned('checkout-api')).toBe(false)

    // And back in again, at the end of the Pinned group.
    await pressPin(input)
    expect(rowNames().slice(0, 2)).toEqual(['orders-web', 'checkout-api'])
    expect(activeRowName()).toBe('checkout-api')
  })

  it('pins several projects in a row without closing', async () => {
    const input = openSwitcher()
    for (const name of ['ledger-core', 'pricing-api', 'ads-api']) {
      type(input, name)
      expect(activeRowName()).toBe(name)
      await pressPin(input)
    }
    expectNothingOpened()
    expect(pinnedInDatabase()).toEqual(
      ['wt-ads', 'wt-checkout', 'wt-checkout-2', 'wt-ledger-core', 'wt-orders', 'wt-pricing'].sort()
    )

    type(input, '')
    expect(groupCount('pinned')).toBe('Pinned5')
    expect(rowNames().slice(0, 5)).toEqual([
      'orders-web',
      'checkout-api',
      'ledger-core',
      'pricing-api',
      'ads-api'
    ])
  })

  it('pins a connection project through its base instance', async () => {
    const input = openSwitcher()
    type(input, 'checkout-stack')
    await pressPin(input)
    expect(pinnedInDatabase()).toContain('stack-base')
    expect(isMarkedPinned('checkout-stack')).toBe(true)
    expect(toastMock.success).toHaveBeenCalledWith('Pinned checkout-stack')

    await pressPin(input)
    expect(pinnedInDatabase()).not.toContain('stack-base')
    expect(isMarkedPinned('checkout-stack')).toBe(false)
  })

  it("toggles a database's own Pin", async () => {
    const input = openSwitcher()
    type(input, 'fixtures')
    expect(activeRowName()).toBe('fixtures-db')

    await pressPin(input)
    expect(calls).toContainEqual({
      method: 'dataProjects.update',
      params: { id: 'fixtures-db', patch: { pinned: true } }
    })
    expect(useDataProjectStore.getState().projects[0].pinned).toBe(true)
    expect(isMarkedPinned('fixtures-db')).toBe(true)
    // Not the project action: no worktree or connection pin was written.
    expect(pinnedInDatabase()).toEqual(['fixtures-db', 'wt-checkout', 'wt-checkout-2', 'wt-orders'])
    expectNothingOpened()

    type(input, '')
    expect(groupCount('pinned')).toBe('Pinned3')
    expect(rowNames().slice(0, 3)).toEqual(['orders-web', 'checkout-api', 'fixtures-db'])

    type(input, 'fixtures')
    await pressPin(input)
    expect(useDataProjectStore.getState().projects[0].pinned).toBe(false)
    expect(isMarkedPinned('fixtures-db')).toBe(false)
    expect(pinnedInDatabase()).not.toContain('fixtures-db')
  })

  it('leaves the Pinned Board showing behind the switcher', async () => {
    useKanbanStore.setState({ isPinnedBoardActive: true })
    const input = openSwitcher()
    type(input, 'ledger-worker')
    await pressPin(input)
    expect(usePinnedStore.getState().pinnedProjectIds.has('ledger-worker')).toBe(true)
    expect(useKanbanStore.getState().isPinnedBoardActive).toBe(true)
    expectNothingOpened()

    press(input, 'Escape')
    expect(screen.queryByTestId('project-switcher')).toBeNull()
    expect(useKanbanStore.getState().isPinnedBoardActive).toBe(true)
    expect(useProjectStore.getState().selectedProjectId).toBeNull()
  })

  it('leaves the row unchanged and shows the error toast when the pin fails', async () => {
    failing.add('wt-ledger-worker')
    const input = openSwitcher()
    for (let i = 0; i < 8; i++) press(input, 'ArrowDown')
    expect(activeRowName()).toBe('ledger-worker')
    const before = rowNames()

    await pressPin(input)

    expect(toastMock.error).toHaveBeenCalledWith('Failed to pin ledger-worker', {
      description: 'database is locked'
    })
    expect(toastMock.success).not.toHaveBeenCalled()
    expect(isMarkedPinned('ledger-worker')).toBe(false)
    expect(rowNames()).toEqual(before)
    expect(groupCount('pinned')).toBe('Pinned2')
    expect(activeRowName()).toBe('ledger-worker')
    expect(pinHint()).toBe('⌘↵ pin')
    expectNothingOpened()
  })

  it('does not flip the pin while the key is held', async () => {
    const input = openSwitcher()
    type(input, 'ledger-worker')
    await pressPin(input)
    press(input, 'Enter', { metaKey: true, repeat: true })
    press(input, 'Enter', { metaKey: true, repeat: true })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(pinWrites()).toBe(1)
    expect(isMarkedPinned('ledger-worker')).toBe(true)
  })

  it('does nothing with another modifier, with Ctrl on macOS, or with no result', async () => {
    const input = openSwitcher()
    type(input, 'ledger-worker')
    press(input, 'Enter', { metaKey: true, shiftKey: true })
    press(input, 'Enter', { metaKey: true, altKey: true })
    press(input, 'Enter', { ctrlKey: true })
    type(input, 'zzqq')
    press(input, 'Enter', { metaKey: true })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(pinWrites()).toBe(0)
    expect(toastMock.success).not.toHaveBeenCalled()
    expectNothingOpened()
  })

  it('is Ctrl+Enter off macOS', async () => {
    platform.mac = false
    const input = openSwitcher()
    type(input, 'ledger-worker')
    expect(pinHint()).toBe('ctrl ↵ pin')

    press(input, 'Enter', { metaKey: true })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(pinWrites()).toBe(0)

    await pressPin(input, { metaKey: false, ctrlKey: true })
    expect(isMarkedPinned('ledger-worker')).toBe(true)
    expect(pinHint()).toBe('ctrl ↵ unpin')
    expectNothingOpened()
  })

  it('never reaches the app shortcuts', async () => {
    const seen: string[] = []
    const appShortcuts = (event: KeyboardEvent): void => {
      seen.push(event.key)
    }
    document.addEventListener('keydown', appShortcuts, true)
    try {
      const input = openSwitcher()
      type(input, 'ledger-worker')
      await pressPin(input)
      expect(seen).toEqual([])
    } finally {
      document.removeEventListener('keydown', appShortcuts, true)
    }
  })
})

describe('the footer hint', () => {
  it('reads "pin" or "unpin" according to the highlighted row', async () => {
    const input = openSwitcher()
    // orders-web, pinned, is highlighted first.
    expect(pinHint()).toBe('⌘↵ unpin')
    press(input, 'ArrowDown')
    press(input, 'ArrowDown')
    expect(activeRowName()).toBe('ledger-core')
    expect(pinHint()).toBe('⌘↵ pin')
    fireEvent.mouseMove(rowOf('checkout-api'))
    expect(pinHint()).toBe('⌘↵ unpin')

    type(input, 'ledger-worker')
    expect(pinHint()).toBe('⌘↵ pin')
    await pressPin(input)
    expect(pinHint()).toBe('⌘↵ unpin')
  })

  it('is not shown when nothing matches', () => {
    const input = openSwitcher()
    type(input, 'zzqq')
    expect(pinHint()).toBeNull()
    expect(screen.getByTestId('project-switcher').textContent).toContain('↵ open')
  })
})

describe('the pin button of a row', () => {
  it('is on every row, named for what it does', () => {
    openSwitcher()
    expect(screen.getAllByTestId('project-switcher-row-pin')).toHaveLength(rowNames().length)
    expect(pinButtonOf('ledger-worker').getAttribute('aria-label')).toBe(
      'Pin to board: ledger-worker'
    )
    expect(pinButtonOf('checkout-api').getAttribute('aria-label')).toBe(
      'Unpin from board: checkout-api'
    )
    expect(pinButtonOf('checkout-stack').getAttribute('aria-label')).toBe(
      'Pin to board: checkout-stack'
    )
    expect(pinButtonOf('fixtures-db').getAttribute('aria-label')).toBe('Pin: fixtures-db')
    expect(pinButtonOf('ledger-worker').getAttribute('data-pinned')).toBe('false')
    expect(pinButtonOf('checkout-api').getAttribute('data-pinned')).toBe('true')
  })

  it('shows on the highlighted row and on hover; a pinned row always shows it', () => {
    const input = openSwitcher()
    const hidden = (name: string): boolean => pinButtonOf(name).className.includes('opacity-0')
    // Hidden until the row is hovered (the class brings it back under the pointer).
    expect(hidden('ledger-worker')).toBe(true)
    expect(pinButtonOf('ledger-worker').className).toContain('group-hover/row:opacity-100')
    // A pinned row keeps its marker.
    expect(hidden('checkout-api')).toBe(false)

    for (let i = 0; i < 8; i++) press(input, 'ArrowDown')
    expect(activeRowName()).toBe('ledger-worker')
    expect(hidden('ledger-worker')).toBe(false)
    press(input, 'ArrowUp')
    expect(hidden('ledger-worker')).toBe(true)
  })

  it('pins on click without opening the project or closing the switcher', async () => {
    const input = openSwitcher()
    const writes = pinWrites()
    fireEvent.mouseMove(rowOf('pricing-api'))
    fireEvent.click(pinButtonOf('pricing-api'))
    await waitFor(() => expect(pinWrites()).toBeGreaterThan(writes))
    await waitFor(() => expect(isMarkedPinned('pricing-api')).toBe(true))

    expect(pinnedInDatabase()).toContain('wt-pricing')
    expect(toastMock.success).toHaveBeenCalledWith('Pinned pricing-api')
    expectNothingOpened()
    // It moved into the Pinned group, and the highlight went with it.
    expect(rowNames().slice(0, 3)).toEqual(['orders-web', 'checkout-api', 'pricing-api'])
    expect(activeRowName()).toBe('pricing-api')
    expect(document.activeElement).toBe(input)
  })

  it('unpins a pinned project on click, and toggles a database', async () => {
    openSwitcher()
    fireEvent.click(pinButtonOf('orders-web'))
    await waitFor(() => expect(isMarkedPinned('orders-web')).toBe(false))
    expect(pinnedInDatabase()).not.toContain('wt-orders')
    expect(toastMock.success).toHaveBeenCalledWith('Unpinned orders-web')

    fireEvent.click(pinButtonOf('fixtures-db'))
    await waitFor(() => expect(isMarkedPinned('fixtures-db')).toBe(true))
    expect(pinnedInDatabase()).toContain('fixtures-db')
    expectNothingOpened()
  })
})

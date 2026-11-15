// The "Go to project" switcher: what it lists, how the keys and the mouse work, and what
// opening a project does. The ranking and grouping rules have their own tests
// (lib/project-switcher.test.ts); here they are checked through the rendered overlay.
// Pinning from the switcher is in ProjectSwitcher.pin.test.tsx.

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/projects/LanguageIcon', () => ({
  LanguageIcon: () => <span data-testid="language-icon" />
}))
vi.mock('@/components/data-projects/DataProjectIcon', () => ({
  DataProjectIcon: () => <span data-testid="data-project-icon" />
}))
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

import { setRendererRpcClient } from '@/api/rpc-client'
import { useVimNavigation } from '@/hooks/useVimNavigation'
import { useProjectSwitcherStore } from '@/stores/useProjectSwitcherStore'
import { useCommandPaletteStore } from '@/stores/useCommandPaletteStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { usePinnedStore } from '@/stores/usePinnedStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useSpaceStore } from '@/stores/useSpaceStore'
import { useFilterStore } from '@/stores/useFilterStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useVimModeStore } from '@/stores/useVimModeStore'
import { useHintStore } from '@/stores/useHintStore'
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

const worktree = (id: string, projectId: string): never =>
  ({ id, project_id: projectId, name: id, path: `/repo/${projectId}`, is_default: true }) as never

function seedStores(): void {
  const projects = [
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
  ]
  useProjectStore.setState({
    projects: projects as never,
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
      [
        'checkout-api',
        [
          worktree('wt-checkout', 'checkout-api'),
          worktree('wt-checkout-2', 'checkout-api'),
          worktree('wt-checkout-3', 'checkout-api')
        ]
      ],
      ['ledger-worker', [worktree('wt-ledger-worker', 'ledger-worker')]]
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
  useSpaceStore.setState({ activeSpaceId: null, projectSpaceMap: {} })
  useFilterStore.setState({ filterQuery: '', debouncedFilterQuery: '' })
  useSessionStore.setState({ sessionsByWorktree: new Map(), sessionsByConnection: new Map() })
  useWorktreeStatusStore.setState({ sessionStatuses: {} })
  useCommandPaletteStore.setState({ isOpen: false })
  useSettingsStore.setState({ vimModeEnabled: false })
}

function openSwitcher(): HTMLInputElement {
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

const type = (input: HTMLInputElement, value: string): void => {
  fireEvent.change(input, { target: { value } })
}

const press = (input: HTMLElement, key: string, init: KeyboardEventInit = {}): void => {
  fireEvent.keyDown(input, { key, ...init })
}

beforeEach(() => {
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
})

describe('opening the switcher', () => {
  it('renders nothing until it is opened', () => {
    render(<ProjectSwitcher />)
    expect(screen.queryByTestId('project-switcher')).toBeNull()
  })

  it('opens with the focus in the field and the placeholder "Go to project…"', () => {
    render(<ProjectSwitcher />)
    const input = openSwitcher()
    expect(document.activeElement).toBe(input)
    expect(input.placeholder).toBe('Go to project…')
    expect(input.value).toBe('')
    expect(screen.getByRole('dialog', { name: 'Go to project' })).toBeInTheDocument()
  })

  it('closes when it is triggered while open, and only one is ever open', () => {
    render(<ProjectSwitcher />)
    act(() => useProjectSwitcherStore.getState().toggle())
    expect(screen.getAllByTestId('project-switcher')).toHaveLength(1)
    act(() => useProjectSwitcherStore.getState().open())
    expect(screen.getAllByTestId('project-switcher')).toHaveLength(1)
    act(() => useProjectSwitcherStore.getState().toggle())
    expect(screen.queryByTestId('project-switcher')).toBeNull()
  })

  it('gives way to the command palette', () => {
    render(<ProjectSwitcher />)
    openSwitcher()
    act(() => useCommandPaletteStore.setState({ isOpen: true }))
    expect(screen.queryByTestId('project-switcher')).toBeNull()
  })

  it('starts empty again the next time it is opened', () => {
    render(<ProjectSwitcher />)
    const input = openSwitcher()
    type(input, 'ledg')
    press(input, 'Escape')
    expect(openSwitcher().value).toBe('')
    expect(screen.getByTestId('project-switcher-group-pinned')).toBeInTheDocument()
  })
})

describe('with nothing typed', () => {
  it('shows Pinned, Recent and All projects, in that order, with their counts', () => {
    render(<ProjectSwitcher />)
    openSwitcher()
    expect(screen.getByTestId('project-switcher-group-pinned').textContent).toBe('Pinned2')
    expect(screen.getByTestId('project-switcher-group-recent').textContent).toBe('Recent5')
    expect(screen.getByTestId('project-switcher-group-all').textContent).toBe('All projects5')
    expect(rowNames()).toEqual([
      // Pinned, in the Pinned section's order
      'orders-web',
      'checkout-api',
      // Recent: the five most recently opened that are not pinned
      'ledger-core',
      'seller-ios',
      'search-worker',
      'returns-web',
      'ledger-api',
      // All projects: the rest, most recently opened first
      'pricing-api',
      'ledger-worker',
      'ads-api',
      'fixtures-db',
      'checkout-stack'
    ])
    expect(screen.getByTestId('project-switcher-count').textContent).toBe('12 projects')
    expect(activeRowName()).toBe('orders-web')
  })

  it('lists every project whatever the active Space and the sidebar filter are', () => {
    useSpaceStore.setState({
      activeSpaceId: 'mobile',
      projectSpaceMap: { 'seller-ios': ['mobile'] }
    })
    useFilterStore.setState({ filterQuery: 'zzz', debouncedFilterQuery: 'zzz' })
    render(<ProjectSwitcher />)
    openSwitcher()
    expect(rowNames()).toHaveLength(12)
    expect(rowNames()).toContain('ledger-worker')
  })

  it('shows on a row its path, worktree count, last-opened age and pinned marker', () => {
    render(<ProjectSwitcher />)
    openSwitcher()

    const checkout = within(rowOf('checkout-api'))
    expect(checkout.getByTestId('project-switcher-row-path').textContent).toBe(
      '~/code/checkout-api'
    )
    expect(checkout.getByTestId('project-switcher-row-worktrees').textContent).toBe('3')
    expect(checkout.getByTestId('project-switcher-row-age').textContent).toBe('6d')
    expect(checkout.getByLabelText('Pinned')).toBeInTheDocument()
    expect(checkout.getByTestId('language-icon')).toBeInTheDocument()

    // One worktree: no count. Not pinned: no marker.
    const ledgerWorker = within(rowOf('ledger-worker'))
    expect(ledgerWorker.queryByTestId('project-switcher-row-worktrees')).toBeNull()
    expect(ledgerWorker.queryByLabelText('Pinned')).toBeNull()
    expect(ledgerWorker.getByTestId('project-switcher-row-age').textContent).toBe('3h')
    expect(within(rowOf('ledger-core')).getByTestId('project-switcher-row-age').textContent).toBe(
      '3m'
    )

    // A database shows what it connects to and its own icon.
    const database = within(rowOf('fixtures-db'))
    expect(database.getByTestId('project-switcher-row-path').textContent).toBe('fixtures.sqlite')
    expect(database.getByTestId('data-project-icon')).toBeInTheDocument()
  })

  it('marks a project whose worktree is working or waiting on the user', () => {
    useSessionStore.setState({
      sessionsByWorktree: new Map([
        ['wt-ledger-worker', [{ id: 's-working' }]],
        ['wt-checkout-2', [{ id: 's-waiting' }]],
        ['wt-orders', [{ id: 's-done' }]]
      ]) as never
    })
    useWorktreeStatusStore.setState({
      sessionStatuses: {
        's-working': { status: 'working', timestamp: 1 },
        's-waiting': { status: 'permission', timestamp: 1 },
        's-done': { status: 'completed', timestamp: 1 }
      }
    })
    render(<ProjectSwitcher />)
    openSwitcher()
    const agent = (name: string): string | null =>
      within(rowOf(name)).queryByTestId('project-switcher-row-agent')?.getAttribute('data-state') ??
      null
    expect(agent('ledger-worker')).toBe('working')
    expect(agent('checkout-api')).toBe('question')
    expect(agent('orders-web')).toBeNull()
    expect(agent('ads-api')).toBeNull()
  })

  it('counts a pinned database in the Pinned group', () => {
    useDataProjectStore.setState((state) => ({
      projects: state.projects.map((p) => ({ ...p, pinned: true }))
    }))
    render(<ProjectSwitcher />)
    openSwitcher()
    expect(screen.getByTestId('project-switcher-group-pinned').textContent).toBe('Pinned3')
    expect(rowNames().slice(0, 3)).toEqual(['orders-web', 'checkout-api', 'fixtures-db'])
  })
})

describe('with text typed', () => {
  it('shows one ranked list, a "N of TOTAL" header and the matched characters', () => {
    render(<ProjectSwitcher />)
    const input = openSwitcher()
    type(input, 'ledg')

    expect(screen.queryByTestId('project-switcher-group-pinned')).toBeNull()
    expect(screen.getByTestId('project-switcher-count').textContent).toBe('3 of 12')
    // Equally good (prefix) matches: the more recently opened first.
    expect(rowNames()).toEqual(['ledger-core', 'ledger-api', 'ledger-worker'])
    for (const row of screen.getAllByTestId('project-switcher-row')) {
      const marks = [...row.querySelectorAll('mark')].map((m) => m.textContent)
      expect(marks).toEqual(['ledg'])
    }
  })

  it('ranks a better match above a more recent one and highlights scattered letters', () => {
    render(<ProjectSwitcher />)
    const input = openSwitcher()
    type(input, 'api')
    // "ads-api", "checkout-api", "ledger-api", "pricing-api": "api" starts a word in each,
    // so the most recently opened leads. No other name or path has the letters.
    expect(rowNames()).toEqual(['ledger-api', 'pricing-api', 'ads-api', 'checkout-api'])

    type(input, 'lgwk')
    expect(rowNames()).toEqual(['ledger-worker'])
    const marks = [...rowOf('ledger-worker').querySelectorAll('mark')].map((m) => m.textContent)
    expect(marks).toEqual(['l', 'g', 'w', 'k'])
  })

  it('finds a project by its path and highlights the path', () => {
    render(<ProjectSwitcher />)
    const input = openSwitcher()
    type(input, 'sqlite')
    expect(rowNames()).toEqual(['fixtures-db'])
    const row = rowOf('fixtures-db')
    expect(
      within(row).getByTestId('project-switcher-row-name').querySelectorAll('mark')
    ).toHaveLength(0)
    expect(
      [...within(row).getByTestId('project-switcher-row-path').querySelectorAll('mark')].map(
        (m) => m.textContent
      )
    ).toEqual(['sqlite'])
  })

  it('says so when nothing matches', () => {
    render(<ProjectSwitcher />)
    const input = openSwitcher()
    type(input, 'zzqq')
    expect(screen.getByTestId('project-switcher-empty').textContent).toBe(
      'No project matches “zzqq”'
    )
    expect(screen.getByTestId('project-switcher-count').textContent).toBe('0 of 12')
    expect(screen.queryAllByTestId('project-switcher-row')).toHaveLength(0)
  })

  it('shows the groups again when the text is cleared', () => {
    render(<ProjectSwitcher />)
    const input = openSwitcher()
    type(input, 'ledg')
    type(input, '')
    expect(screen.getByTestId('project-switcher-group-pinned')).toBeInTheDocument()
    expect(rowNames()).toHaveLength(12)
  })
})

describe('keys and mouse', () => {
  it('moves the highlight with the arrows and stops at both ends', () => {
    render(<ProjectSwitcher />)
    const input = openSwitcher()
    type(input, 'ledg')
    expect(activeRowName()).toBe('ledger-core')

    press(input, 'ArrowUp')
    expect(activeRowName()).toBe('ledger-core')
    press(input, 'ArrowDown')
    expect(activeRowName()).toBe('ledger-api')
    press(input, 'ArrowDown')
    press(input, 'ArrowDown')
    press(input, 'ArrowDown')
    expect(activeRowName()).toBe('ledger-worker')
    press(input, 'ArrowUp')
    expect(activeRowName()).toBe('ledger-api')
    expect(input.getAttribute('aria-activedescendant')).toBe(
      screen.getAllByTestId('project-switcher-row')[1].id
    )
  })

  it('highlights the first result again after every keystroke', () => {
    render(<ProjectSwitcher />)
    const input = openSwitcher()
    type(input, 'ledg')
    press(input, 'ArrowDown')
    press(input, 'ArrowDown')
    expect(activeRowName()).toBe('ledger-worker')
    type(input, 'ledge')
    expect(activeRowName()).toBe('ledger-core')
  })

  it('opens the highlighted project with Enter and closes', () => {
    render(<ProjectSwitcher />)
    const input = openSwitcher()
    type(input, 'ledg')
    press(input, 'ArrowDown')
    press(input, 'ArrowDown')
    press(input, 'Enter')
    expect(useProjectStore.getState().selectedProjectId).toBe('ledger-worker')
    expect(screen.queryByTestId('project-switcher')).toBeNull()
  })

  it('opens the clicked project', () => {
    render(<ProjectSwitcher />)
    openSwitcher()
    fireEvent.click(rowOf('pricing-api'))
    expect(useProjectStore.getState().selectedProjectId).toBe('pricing-api')
    expect(screen.queryByTestId('project-switcher')).toBeNull()
  })

  it('moves the highlight to the row under the moving pointer', () => {
    render(<ProjectSwitcher />)
    openSwitcher()
    fireEvent.mouseMove(rowOf('seller-ios'))
    expect(activeRowName()).toBe('seller-ios')
  })

  // Cmd+Enter pins instead of opening: ProjectSwitcher.pin.test.tsx.
  it('opens nothing on Enter with a modifier or with no result', () => {
    render(<ProjectSwitcher />)
    const input = openSwitcher()
    for (const modifier of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey'] as const) {
      press(input, 'Enter', { [modifier]: true })
      expect(useProjectStore.getState().selectedProjectId).toBeNull()
      expect(screen.getByTestId('project-switcher')).toBeInTheDocument()
    }

    type(input, 'zzqq')
    press(input, 'Enter')
    expect(useProjectStore.getState().selectedProjectId).toBeNull()
    expect(screen.getByTestId('project-switcher')).toBeInTheDocument()
  })

  it('closes on Escape, changes nothing and returns the focus to where it was', () => {
    render(
      <>
        <textarea data-testid="chat-input" />
        <ProjectSwitcher />
      </>
    )
    const chat = screen.getByTestId('chat-input')
    chat.focus()
    const before = useProjectStore.getState()
    const input = openSwitcher()
    expect(document.activeElement).toBe(input)
    type(input, 'ledg')
    press(input, 'ArrowDown')

    press(input, 'Escape')
    expect(screen.queryByTestId('project-switcher')).toBeNull()
    expect(document.activeElement).toBe(chat)
    expect(useProjectStore.getState().selectedProjectId).toBe(before.selectedProjectId)
    expect(useProjectStore.getState().expandedProjectIds).toBe(before.expandedProjectIds)
  })

  it('closes on a click outside and returns the focus', () => {
    render(
      <>
        <textarea data-testid="chat-input" />
        <ProjectSwitcher />
      </>
    )
    const chat = screen.getByTestId('chat-input')
    chat.focus()
    openSwitcher()
    fireEvent.mouseDown(screen.getByTestId('project-switcher-backdrop'))
    expect(screen.queryByTestId('project-switcher')).toBeNull()
    expect(document.activeElement).toBe(chat)
    expect(useProjectStore.getState().selectedProjectId).toBeNull()
  })

  it('shows the key hints in a footer', () => {
    render(<ProjectSwitcher />)
    openSwitcher()
    const dialog = screen.getByTestId('project-switcher')
    expect(dialog.textContent).toContain('↑↓ navigate')
    expect(dialog.textContent).toContain('↵ open')
    // The highlighted row, orders-web, is pinned.
    expect(dialog.textContent).toContain('⌘↵ unpin')
    expect(dialog.textContent).toContain('esc close')
  })

  it('keeps plain keys from the app while typing, and lets modified keys through', () => {
    const seen: string[] = []
    const appShortcuts = (event: KeyboardEvent): void => {
      seen.push(`${event.metaKey ? 'cmd+' : ''}${event.key}`)
    }
    // Where the app's shortcut, vim and jump-hint handlers listen.
    document.addEventListener('keydown', appShortcuts, true)
    try {
      render(<ProjectSwitcher />)
      const input = openSwitcher()
      for (const key of ['j', 'k', 'G', ':', ' ', 'Backspace', 'Tab', 'ArrowDown', 'Enter']) {
        press(input, key)
      }
      expect(seen).toEqual([])

      // Enter opened the highlighted project and closed the switcher: open it again.
      const again = openSwitcher()
      press(again, 'p', { metaKey: true })
      expect(seen).toEqual(['cmd+p'])
      press(again, 'Escape')
      expect(seen).toEqual(['cmd+p'])
    } finally {
      document.removeEventListener('keydown', appShortcuts, true)
    }
  })
})

describe('vim mode', () => {
  function VimHarness(): React.JSX.Element {
    useVimNavigation()
    return <ProjectSwitcher />
  }

  it('typing letters in the field only edits the query', () => {
    useSettingsStore.setState({ vimModeEnabled: true })
    useVimModeStore.setState({ mode: 'normal', helpOverlayOpen: false })
    useHintStore.setState({ mode: 'idle', pendingChar: null })
    render(<VimHarness />)
    const input = openSwitcher()
    // The field is part of an overlay: focusing it does not switch vim to insert mode.
    expect(useVimModeStore.getState().mode).toBe('normal')

    // In normal mode these would scroll, open the help overlay and start a jump hint.
    for (const key of ['j', 'k', '?', 'I', 'A', 'L']) press(input, key)
    type(input, 'ledg')

    expect(useVimModeStore.getState().mode).toBe('normal')
    expect(useVimModeStore.getState().helpOverlayOpen).toBe(false)
    expect(useHintStore.getState().mode).toBe('idle')
    expect(input.value).toBe('ledg')
    expect(rowNames()).toEqual(['ledger-core', 'ledger-api', 'ledger-worker'])

    press(input, 'Escape')
    expect(screen.queryByTestId('project-switcher')).toBeNull()
    expect(useVimModeStore.getState().mode).toBe('normal')
  })
})

describe('opening a project', () => {
  it('selects it without collapsing or expanding anything in the sidebar', async () => {
    useProjectStore.setState({ expandedProjectIds: new Set(['ledger-worker', 'ads-api']) })
    render(<ProjectSwitcher />)

    // An expanded project stays expanded (its row click would collapse it).
    let input = openSwitcher()
    type(input, 'ledger-worker')
    press(input, 'Enter')
    expect(useProjectStore.getState().selectedProjectId).toBe('ledger-worker')
    expect([...useProjectStore.getState().expandedProjectIds].sort()).toEqual([
      'ads-api',
      'ledger-worker'
    ])

    // A collapsed one is not expanded either: the sidebar does not move.
    input = openSwitcher()
    type(input, 'pricing')
    press(input, 'Enter')
    expect(useProjectStore.getState().selectedProjectId).toBe('pricing-api')
    expect([...useProjectStore.getState().expandedProjectIds].sort()).toEqual([
      'ads-api',
      'ledger-worker'
    ])
  })

  it('updates the last-opened time, so the project leads Recent the next time', async () => {
    render(<ProjectSwitcher />)
    const input = openSwitcher()
    type(input, 'ads-api')
    vi.setSystemTime(NOW + 60_000)
    await act(async () => {
      press(input, 'Enter')
    })
    const opened = useProjectStore.getState().projects.find((p) => p.id === 'ads-api')
    expect(Date.parse(opened!.last_accessed_at)).toBe(NOW + 60_000)

    openSwitcher()
    const recentHeading = screen.getByTestId('project-switcher-group-recent')
    const firstRecent = recentHeading.parentElement!
    expect(within(firstRecent).getByTestId('project-switcher-row-name').textContent).toBe('ads-api')
  })

  it('leaves the Pinned Board, also for a pinned project', async () => {
    useKanbanStore.setState({ isPinnedBoardActive: true, isPinnedBoardBehindSession: false })
    render(<ProjectSwitcher />)
    const input = openSwitcher()
    type(input, 'checkout-api')
    await act(async () => {
      press(input, 'Enter')
    })
    expect(useProjectStore.getState().selectedProjectId).toBe('checkout-api')
    expect(useKanbanStore.getState().isPinnedBoardActive).toBe(false)
  })

  it('opens a connection project on its own board', () => {
    useWorktreeStore.setState({ selectedWorktreeId: 'wt-orders' })
    useConnectionStore.setState({ selectedConnectionId: 'some-connection' })
    render(<ProjectSwitcher />)
    const input = openSwitcher()
    type(input, 'checkout-stack')
    press(input, 'Enter')
    expect(useProjectStore.getState().selectedProjectId).toBe('checkout-stack')
    expect(useConnectionStore.getState().selectedConnectionId).toBeNull()
    expect(useWorktreeStore.getState().selectedWorktreeId).toBeNull()
  })

  it('opens a database in its client', () => {
    useProjectStore.setState({ selectedProjectId: 'ads-api' })
    render(<ProjectSwitcher />)
    const input = openSwitcher()
    type(input, 'fixtures')
    press(input, 'Enter')
    expect(useDataProjectStore.getState().selectedDataProjectId).toBe('fixtures-db')
    expect(screen.queryByTestId('project-switcher')).toBeNull()
  })
})

// The ways into "New PRD → orchestrator ticket…": the To Do column header's right-click menu
// (a single project's board only, next to "New orchestrator from tickets…"), the command
// palette, and a connection row's two menus (an ad-hoc connection is saved as a project on the
// way in, as "Implement Document…" does). Each of them opens the form through usePrdFlowStore
// for the right project; the form itself is PrdFlowDialog.test.tsx's.
import type { PropsWithChildren } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setRendererRpcClient } from '@/api/rpc-client'
import { ConnectionItem } from '@/components/connections/ConnectionItem'
import { KanbanColumn } from '@/components/kanban/KanbanColumn'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useCommands } from '@/hooks/useCommands'
import { commandRegistry } from '@/lib/command-registry'
import { useCommandPaletteStore } from '@/stores/useCommandPaletteStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useHintStore } from '@/stores/useHintStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { usePrdFlowStore } from '@/stores/usePrdFlowStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))
vi.mock('@/api/document-flow-api', () => ({ documentFlowApi: { get: vi.fn() } }))
vi.mock('@/components/kanban/KanbanTicketCard', () => ({ KanbanTicketCard: () => null }))
vi.mock('@/components/kanban/WorktreePickerModal', () => ({ WorktreePickerModal: () => null }))
vi.mock('@/components/kanban/TicketCreateModal', () => ({ TicketCreateModal: () => null }))
vi.mock('motion/react', () => ({
  LayoutGroup: ({ children }: PropsWithChildren) => <>{children}</>,
  motion: {
    div: ({
      children,
      layoutId: _layoutId,
      layout: _layout,
      layoutScroll: _layoutScroll,
      transition: _transition,
      ...props
    }: PropsWithChildren<Record<string, unknown>>) => <div {...props}>{children}</div>
  }
}))

const project = (id: string, kind?: 'git' | 'connection') => ({
  id,
  name: id,
  path: `/tmp/${id}`,
  ...(kind ? { kind } : {}),
  description: null,
  tags: null,
  language: null,
  custom_icon: null,
  detected_icon: 'none',
  setup_script: null,
  run_script: null,
  archive_script: null,
  worktree_create_script: null,
  custom_commands: null,
  auto_assign_port: false,
  sort_order: 0,
  created_at: '2026-01-01',
  last_accessed_at: '2026-01-01'
})

type Connection = ReturnType<typeof useConnectionStore.getState>['connections'][number]

const member = (projectId: string, worktreeId: string) => ({
  id: `member-${worktreeId}`,
  connection_id: 'conn-1',
  worktree_id: worktreeId,
  added_at: '2026-01-01',
  project_id: projectId,
  symlink_name: projectId,
  worktree_name: 'main',
  worktree_branch: 'main',
  worktree_path: `/tmp/${projectId}`,
  project_name: projectId
})

const connection = (overrides: Partial<Connection> = {}): Connection =>
  ({
    id: 'conn-1',
    name: 'alpha + beta',
    custom_name: null,
    status: 'active',
    path: '/tmp/conn-1',
    color: null,
    saved_project_id: null,
    is_base: 0,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    members: [member('alpha', 'wt-alpha'), member('beta', 'wt-beta')],
    ...overrides
  }) as unknown as Connection

// floating-ui probes every positioned element with matches(':popover-open') and
// matches(':modal'); jsdom recurses on them for seconds per menu. Answer them directly.
const TOP_LAYER_PROBES = new Set([':popover-open', ':modal'])
const originalMatches = Element.prototype.matches

const initialPrdFlowState = usePrdFlowStore.getState()
const initialFlowState = useDocumentFlowStore.getState()
const initialConnectionState = useConnectionStore.getState()
const initialKanbanState = useKanbanStore.getState()

beforeAll(() => {
  Element.prototype.matches = function (this: Element, selectors: string): boolean {
    return TOP_LAYER_PROBES.has(selectors) ? false : originalMatches.call(this, selectors)
  }
})

afterAll(() => {
  Element.prototype.matches = originalMatches
})

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  )
  setRendererRpcClient({
    request: async <T,>(): Promise<T> => ({ success: true }) as T,
    subscribe: () => () => {}
  })
  useSettingsStore.setState({ tipsEnabled: false })
  useProjectStore.setState({
    projects: [project('alpha'), project('linked', 'connection')],
    expandedProjectIds: new Set(),
    selectedProjectId: null
  })
  useWorktreeStore.setState({
    worktreesByProject: new Map(),
    loadedProjectIds: new Set(),
    worktreeOrderByProject: new Map()
  })
  useConnectionStore.setState({
    connectionModeActive: false,
    selectedConnectionId: null,
    connections: []
  })
  useHintStore.setState({ filterActive: false, inputFocused: false })
})

afterEach(async () => {
  await act(async () => {})
  cleanup()
  vi.unstubAllGlobals()
  usePrdFlowStore.setState(initialPrdFlowState, true)
  useDocumentFlowStore.setState(initialFlowState, true)
  useConnectionStore.setState(initialConnectionState, true)
  useKanbanStore.setState(initialKanbanState, true)
  useCommandPaletteStore.setState({ isOpen: false })
})

/** The menu items now rendered, by their text (role queries are slow on these trees). */
const menuItemNames = (): string[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).map(
    (item) => item.textContent ?? ''
  )

const CLOSED = { open: false, projectId: null }

describe('the To Do header menu', () => {
  const header = (): HTMLElement =>
    screen.getByRole('heading', { name: 'To Do' }).parentElement!.parentElement!

  function renderTodo(board: { connectionId?: string; isPinnedMode?: boolean } = {}): void {
    render(
      <TooltipProvider>
        <KanbanColumn column="todo" projectId="proj-1" tickets={[]} {...board} />
      </TooltipProvider>
    )
  }

  it("opens the form for the board's project, right after the orchestrator item", () => {
    renderTodo()

    fireEvent.contextMenu(header())
    const names = menuItemNames()
    expect(names[names.indexOf('New orchestrator from tickets…') + 1]).toBe(
      'New PRD → orchestrator ticket…'
    )
    fireEvent.click(screen.getByTestId('ctx-new-prd-flow'))

    expect(usePrdFlowStore.getState().dialog).toEqual({ open: true, projectId: 'proj-1' })
    // It is its own form, not the "Implement document" wizard
    expect(useDocumentFlowStore.getState().wizard.open).toBe(false)
  })

  it.each([
    ['a pinned board', { isPinnedMode: true }],
    ['a connection board', { connectionId: 'conn-1' }]
  ])('is not offered on %s, which mixes projects', (_label, board) => {
    renderTodo(board)

    fireEvent.contextMenu(header())

    expect(screen.getByTestId('ctx-new-ticket')).toBeTruthy()
    expect(screen.queryByTestId('ctx-new-prd-flow')).toBeNull()
  })

  it('is not offered on another column', () => {
    render(
      <TooltipProvider>
        <KanbanColumn column="done" projectId="proj-1" tickets={[]} />
      </TooltipProvider>
    )

    fireEvent.contextMenu(
      screen.getByRole('heading', { name: 'Done' }).parentElement!.parentElement!
    )

    expect(screen.getByTestId('ctx-archive-all')).toBeTruthy()
    expect(screen.queryByTestId('ctx-new-prd-flow')).toBeNull()
  })
})

describe('command palette', () => {
  function CommandsHarness(): null {
    useCommands()
    return null
  }

  /** Register the commands and let the hook's own startup requests settle. */
  async function registerCommands(): Promise<void> {
    await act(async () => {
      render(<CommandsHarness />)
    })
  }

  const command = () => {
    const found = commandRegistry.get('action:prd-flow')
    if (!found) throw new Error('action:prd-flow is not registered')
    return found
  }

  it('opens the form for the selected project and closes the palette', async () => {
    useProjectStore.setState({ selectedProjectId: 'alpha' })
    useCommandPaletteStore.setState({ isOpen: true })
    await registerCommands()

    expect(command()).toMatchObject({
      label: 'New PRD → orchestrator ticket…',
      description:
        'Describe what to build: a session writes the PRD and the tasks document, which becomes an orchestrator ticket',
      category: 'action',
      // An icon the palette can draw (CommandItem's icon map)
      icon: 'FileText'
    })
    expect(command().keywords).toEqual([
      'prd',
      'tasks',
      'orchestrator',
      'document',
      'spec',
      'plan',
      'ticket'
    ])
    expect(command().isEnabled?.()).toBe(true)
    await act(async () => {
      await command().action()
    })

    expect(usePrdFlowStore.getState().dialog).toEqual({ open: true, projectId: 'alpha' })
    expect(useCommandPaletteStore.getState().isOpen).toBe(false)
  })

  it('sits right after "Orchestrate tickets…"', async () => {
    await registerCommands()

    const ids = commandRegistry.getAll().map((entry) => entry.id)
    expect(ids[ids.indexOf('action:orchestrate-tickets') + 1]).toBe('action:prd-flow')
  })

  it("uses the selected instance's connection project when no project is selected", async () => {
    useConnectionStore.setState({
      selectedConnectionId: 'conn-1',
      connections: [connection({ saved_project_id: 'linked' })]
    })
    await registerCommands()

    expect(command().isEnabled?.()).toBe(true)
    await act(async () => {
      await command().action()
    })

    expect(usePrdFlowStore.getState().dialog).toEqual({ open: true, projectId: 'linked' })
  })

  // Selecting a connection row leaves the git project that was selected before it selected,
  // and the main pane shows the connection: the form is for what is on screen.
  it("uses the selected instance's connection project, not the git project selected before it", async () => {
    useProjectStore.setState({ selectedProjectId: 'alpha' })
    useConnectionStore.setState({
      selectedConnectionId: 'conn-1',
      connections: [connection({ saved_project_id: 'linked' })]
    })
    await registerCommands()

    expect(command().isEnabled?.()).toBe(true)
    await act(async () => {
      await command().action()
    })

    expect(usePrdFlowStore.getState().dialog).toEqual({ open: true, projectId: 'linked' })
  })

  it('is disabled on an ad-hoc connection, also with a git project selected before it', async () => {
    useProjectStore.setState({ selectedProjectId: 'alpha' })
    useConnectionStore.setState({ selectedConnectionId: 'conn-1', connections: [connection()] })
    await registerCommands()

    expect(command().isEnabled?.()).toBe(false)
    // Even if it is run anyway, nothing opens: not for the project that is not on screen.
    await act(async () => {
      await command().action()
    })
    expect(usePrdFlowStore.getState().dialog).toEqual(CLOSED)

    // Back on the git project, the command is its again.
    await act(async () => {
      useConnectionStore.setState({ selectedConnectionId: null })
    })
    expect(command().isEnabled?.()).toBe(true)
  })

  it('is disabled without a project and on an ad-hoc connection', async () => {
    await registerCommands()
    expect(command().isEnabled?.()).toBe(false)

    await act(async () => {
      useConnectionStore.setState({ selectedConnectionId: 'conn-1', connections: [connection()] })
    })
    expect(command().isEnabled?.()).toBe(false)
    // Even if it is run anyway, nothing opens.
    await act(async () => {
      await command().action()
    })
    expect(usePrdFlowStore.getState().dialog).toEqual(CLOSED)
  })
})

describe('connection row context menu', () => {
  const renderRow = (row: Connection): void => {
    render(
      <TooltipProvider>
        <ConnectionItem connection={row} />
      </TooltipProvider>
    )
  }

  it('opens the form for an instance\'s connection project, right after "Orchestrate tickets…"', () => {
    const instance = connection({ saved_project_id: 'linked' })
    useConnectionStore.setState({ connections: [instance] })
    renderRow(instance)

    fireEvent.contextMenu(screen.getByTestId('connection-item-conn-1'))
    const names = menuItemNames()
    expect(names[names.indexOf('Orchestrate tickets…') + 1]).toBe('New PRD → orchestrator ticket…')
    fireEvent.click(screen.getByTestId('prd-flow-connection-menu-item'))

    expect(usePrdFlowStore.getState().dialog).toEqual({ open: true, projectId: 'linked' })
    expect(useDocumentFlowStore.getState().wizard.open).toBe(false)
  })

  it('saves an ad-hoc connection as a project first, then opens the form for it', async () => {
    const adHoc = connection()
    const saveConnectionAsProject = vi.fn(async () => 'proj-new')
    useConnectionStore.setState({ connections: [adHoc], saveConnectionAsProject })
    renderRow(adHoc)

    fireEvent.contextMenu(screen.getByTestId('connection-item-conn-1'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('prd-flow-connection-menu-item'))
    })

    expect(saveConnectionAsProject).toHaveBeenCalledWith('conn-1')
    expect(usePrdFlowStore.getState().dialog).toEqual({ open: true, projectId: 'proj-new' })
  })

  it('opens nothing when saving the ad-hoc connection fails', async () => {
    const adHoc = connection()
    useConnectionStore.setState({ connections: [adHoc], saveConnectionAsProject: async () => null })
    renderRow(adHoc)

    fireEvent.contextMenu(screen.getByTestId('connection-item-conn-1'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('prd-flow-connection-menu-item'))
    })

    expect(usePrdFlowStore.getState().dialog).toEqual(CLOSED)
  })

  it('is not offered where "Implement Document…" is not', () => {
    const single = connection({ members: [member('alpha', 'wt-a'), member('alpha', 'wt-b')] })
    useConnectionStore.setState({ connections: [single] })
    renderRow(single)

    fireEvent.contextMenu(screen.getByTestId('connection-item-conn-1'))

    expect(menuItemNames()).toContain('Copy Path')
    expect(screen.queryByTestId('prd-flow-connection-menu-item')).toBeNull()
  })
})

describe('connection row "⋯" menu', () => {
  /** The row's more-options button: the one control of the row that opens a menu. */
  const moreButton = (): HTMLElement => {
    const button = screen
      .getByTestId('connection-item-conn-1')
      .querySelector<HTMLElement>('button[aria-haspopup="menu"]')
    if (!button) throw new Error('The row has no more-options button')
    return button
  }

  it('offers the same item, right after "Orchestrate tickets…"', async () => {
    const instance = connection({ saved_project_id: 'linked' })
    useConnectionStore.setState({ connections: [instance] })
    render(
      <TooltipProvider>
        <ConnectionItem connection={instance} />
      </TooltipProvider>
    )

    await act(async () => {
      fireEvent.keyDown(moreButton(), { key: 'Enter' })
    })
    const names = menuItemNames()
    expect(names[names.indexOf('Orchestrate tickets…') + 1]).toBe('New PRD → orchestrator ticket…')
    await act(async () => {
      fireEvent.click(screen.getByTestId('prd-flow-connection-menu-item'))
    })

    expect(usePrdFlowStore.getState().dialog).toEqual({ open: true, projectId: 'linked' })
  })
})

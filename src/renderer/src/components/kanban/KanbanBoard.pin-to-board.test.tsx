/**
 * "Pin to board" on a project's own board (BoardPinButton), as the board mounts it: which
 * boards have the button and where it sits, what it reads in each state, what a click does (the
 * real project pin action of lib/project-pin, over a fake RPC client), and that it follows pins
 * made anywhere else.
 */
import type { PropsWithChildren } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  loading: vi.fn(),
  dismiss: vi.fn(),
  info: vi.fn(),
  warning: vi.fn()
}))
vi.mock('@/lib/toast', () => ({ toast: toastMock, gitToast: {} }))

vi.mock('@/api/kanban-api', () => ({
  kanbanApi: {
    watch: {
      start: vi.fn().mockResolvedValue({ success: true }),
      stop: vi.fn().mockResolvedValue({ success: true }),
      onChanged: vi.fn(() => () => {})
    }
  }
}))

vi.mock('motion/react', () => ({
  LayoutGroup: ({ children }: PropsWithChildren) => <>{children}</>,
  motion: {
    div: ({
      children,
      layoutScroll: _layoutScroll,
      ...props
    }: PropsWithChildren<{
      layoutScroll?: boolean
      [key: string]: unknown
    }>) => <div {...props}>{children}</div>
  }
}))

vi.mock('@/components/kanban/KanbanColumn', () => ({
  KanbanColumn: ({ column }: { column: string }) => <div data-testid={`kanban-column-${column}`} />
}))
vi.mock('@/components/kanban/KanbanTicketModal', () => ({ KanbanTicketModal: () => null }))
vi.mock('@/components/kanban/MergeOnDoneDialog', () => ({ MergeOnDoneDialog: () => null }))
vi.mock('@/components/kanban/BoardChatLauncher', () => ({
  BoardChatLauncher: () => <button data-testid="board-chat-launcher" />
}))

import { setRendererRpcClient } from '@/api/rpc-client'
import { KanbanBoard } from '@/components/kanban/KanbanBoard'
import { TooltipProvider } from '@/components/ui/tooltip'
import { setProjectPinned } from '@/lib/project-pin'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { usePinnedStore } from '@/stores/usePinnedStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

// The board's dependency lines and Radix's popper measure with it; jsdom has none.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub

// See ProjectItem.shell-commands.test.tsx: jsdom cannot answer floating-ui's top-layer probes
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

const worktreeRow = (id: string, projectId: string, isDefault: boolean) => ({
  id,
  project_id: projectId,
  name: id,
  branch_name: isDefault ? 'main' : id,
  path: `/tmp/${projectId}/${id}`,
  status: 'active',
  is_default: isDefault,
  created_at: '2026-01-01',
  last_accessed_at: '2026-01-01'
})

const baseInstance = {
  id: 'stack-base',
  name: 'stack-base',
  status: 'active',
  path: '/tmp/connections/stack-base',
  pinned: 0,
  saved_project_id: 'stack',
  is_base: 1,
  members: []
}

const pinWrites: Array<{ method: string; params: unknown }> = []
const pinnedInDatabase = new Set<string>()
/** The ids whose pin write the backend refuses. */
const failingPinWrites = new Set<string>()

const renderBoard = (
  props: Parameters<typeof KanbanBoard>[0] = { projectId: 'alpha' }
): ReturnType<typeof render> =>
  render(
    <TooltipProvider>
      <KanbanBoard {...props} />
    </TooltipProvider>
  )

const row = (): HTMLElement | null => screen.queryByTestId('board-top-row')
const pinButton = (): HTMLElement => screen.getByTestId('board-pin-button')
const queryPinButton = (): HTMLElement | null => screen.queryByTestId('board-pin-button')
const pinIcon = (): HTMLElement => screen.getByTestId('board-pin-icon')
const pinLabel = (): HTMLElement => screen.getByTestId('board-pin-label')

const initialKanban = useKanbanStore.getState()

beforeEach(() => {
  vi.clearAllMocks()
  pinWrites.length = 0
  pinnedInDatabase.clear()
  failingPinWrites.clear()
  setRendererRpcClient({
    request: async <T,>(method: string, params?: unknown): Promise<T> => {
      const p = (params ?? {}) as Record<string, unknown>
      if (method === 'db.worktree.getActiveByProject') {
        return [
          worktreeRow(`${p.projectId}-feature`, p.projectId as string, false),
          worktreeRow(`${p.projectId}-main`, p.projectId as string, true)
        ] as T
      }
      if (method === 'db.worktree.getPinned') {
        return [...pinnedInDatabase].map((id) => ({
          id,
          project_id: id.replace(/-(main|feature)$/, '')
        })) as T
      }
      if (method === 'connectionOps.getPinned') return [] as T
      if (method === 'connectionOps.getAll') {
        return { success: true, connections: [baseInstance] } as T
      }
      if (method === 'db.worktree.setPinned' || method === 'connectionOps.setPinned') {
        const id = (p.worktreeId ?? p.connectionId) as string
        if (failingPinWrites.has(id)) return { success: false, error: 'disk is full' } as T
        pinWrites.push({ method, params })
        if (p.pinned) pinnedInDatabase.add(id)
        else pinnedInDatabase.delete(id)
      }
      return { success: true } as T
    },
    subscribe: () => () => {}
  })
  useProjectStore.setState({
    projects: [project('alpha'), project('beta'), project('stack', 'connection')] as never,
    selectedProjectId: 'alpha',
    expandedProjectIds: new Set()
  })
  useWorktreeStore.setState({
    worktreesByProject: new Map(),
    loadedProjectIds: new Set(),
    worktreeOrderByProject: new Map()
  })
  useConnectionStore.setState({ connectionModeActive: false, connections: [] })
  usePinnedStore.setState({
    pinnedWorktreeIds: new Set(),
    pinnedConnectionIds: new Set(),
    pinnedProjectIds: new Set(),
    loaded: true
  })
  useKanbanStore.setState({
    tickets: new Map(),
    isPinnedBoardActive: false,
    loadTickets: vi.fn().mockResolvedValue(undefined),
    loadTicketsForConnection: vi.fn().mockResolvedValue(undefined),
    loadTicketsForPinnedProjects: vi.fn().mockResolvedValue(undefined),
    loadTicketsForProjectInAggregate: vi.fn().mockResolvedValue(undefined)
  })
})

afterEach(() => {
  cleanup()
  useKanbanStore.setState(initialKanban, true)
  useProjectStore.setState({ projects: [], selectedProjectId: null })
})

describe('which boards have the button', () => {
  it('a git project’s board has it, above the columns, out of what scrolls sideways', () => {
    renderBoard({ projectId: 'alpha' })

    const scroller = screen.getByTestId('kanban-board')
    expect(row()).toContainElement(pinButton())
    expect(scroller).not.toContainElement(pinButton())
    expect(pinButton().compareDocumentPosition(scroller)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('a connection project’s board has it', () => {
    renderBoard({ projectId: 'stack' })
    expect(row()).toContainElement(pinButton())
  })

  it('the Pinned Board has none', () => {
    usePinnedStore.setState({ pinnedProjectIds: new Set(['alpha', 'beta']) })
    renderBoard({ isPinnedMode: true })

    expect(screen.getByRole('heading', { name: 'Pinned Projects (2)' })).toBeInTheDocument()
    expect(queryPinButton()).toBeNull()
  })

  it('the board of a connection that was not saved as a project has none, nor a row for it', () => {
    renderBoard({ connectionId: 'connection-1' })

    expect(queryPinButton()).toBeNull()
    expect(row()).toBeNull()
    expect(screen.getByTestId('kanban-column-todo')).toBeInTheDocument()
  })

  it('a board with no project, or one that is not in the list, has none', () => {
    const { unmount } = renderBoard({})
    expect(queryPinButton()).toBeNull()
    expect(row()).toBeNull()
    unmount()

    renderBoard({ projectId: 'gone' })
    expect(queryPinButton()).toBeNull()
    expect(row()).toBeNull()
  })

  it('appears when the project reaches the list, and leaves with it', () => {
    useProjectStore.setState({ projects: [] })
    renderBoard({ projectId: 'alpha' })
    expect(queryPinButton()).toBeNull()

    act(() => useProjectStore.setState({ projects: [project('alpha')] as never }))
    expect(pinButton()).toHaveTextContent('Pin to board')

    act(() => useProjectStore.setState({ projects: [] }))
    expect(queryPinButton()).toBeNull()
  })
})

describe('where it sits', () => {
  it('ends the row at the right', () => {
    renderBoard({ projectId: 'alpha' })

    expect(row()?.lastElementChild).toBe(pinButton())
    expect(pinButton()).toHaveClass('ml-auto', 'shrink-0')
  })

  it('leaves the board assistant button and the search bar where they were', () => {
    useKanbanStore.setState({
      boardSearch: { ...useKanbanStore.getState().boardSearch, open: true }
    })
    renderBoard({ projectId: 'alpha' })

    const search = screen.getByTestId('board-search-bar')
    expect(row()).not.toContainElement(search)
    expect(row()?.compareDocumentPosition(search)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(row()).not.toContainElement(screen.getByTestId('board-chat-launcher'))
  })

  it('gives up its label, not its place', () => {
    renderBoard({ projectId: 'alpha' })
    expect(pinLabel()).toHaveClass('@max-[260px]/board:hidden')
    expect(pinButton()).toHaveClass('whitespace-nowrap')
    expect(row()).toHaveClass('@container/board')
    // The icon is outside the label, so it is what stays
    expect(pinLabel()).not.toContainElement(pinIcon())
    expect(pinButton()).toContainElement(pinIcon())
  })
})

describe('what it says', () => {
  it('not pinned: "Pin to board" with a pin in outline', async () => {
    renderBoard({ projectId: 'alpha' })

    expect(pinButton()).toHaveTextContent('Pin to board')
    expect(pinButton()).toHaveAccessibleName('Pin to board')
    expect(pinButton()).toHaveAttribute('data-pinned', 'false')
    expect(pinIcon()).not.toHaveClass('fill-current')
    fireEvent.focus(pinButton())
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Pin to board')
  })

  it('pinned: "Pinned" with a filled pin, and a tooltip that says a click unpins', async () => {
    usePinnedStore.setState({ pinnedProjectIds: new Set(['alpha']) })
    renderBoard({ projectId: 'alpha' })

    expect(pinButton()).toHaveTextContent('Pinned')
    expect(pinButton()).not.toHaveTextContent('Pin to board')
    expect(pinButton()).toHaveAccessibleName('Pinned · Unpin from board')
    expect(pinButton()).toHaveAttribute('data-pinned', 'true')
    expect(pinIcon()).toHaveClass('fill-current')
    fireEvent.focus(pinButton())
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Unpin from board')
  })

  it('says it of the board’s own project, not of another pinned one', () => {
    usePinnedStore.setState({ pinnedProjectIds: new Set(['beta']) })
    renderBoard({ projectId: 'alpha' })
    expect(pinButton()).toHaveTextContent('Pin to board')
  })

  it('is a button in the tab order, in a row where Tab moves the focus', () => {
    renderBoard({ projectId: 'alpha' })

    expect(pinButton().tagName).toBe('BUTTON')
    expect(pinButton()).toHaveAttribute('type', 'button')
    expect(pinButton()).not.toHaveAttribute('tabindex')
    expect(pinButton()).toBeEnabled()
    pinButton().focus()
    expect(pinButton()).toHaveFocus()
    expect(pinButton().closest('[data-tab-navigates]')).toBe(row())
  })

  it('keeps its place unseen, and out of reach, until the pins are read', () => {
    usePinnedStore.setState({ loaded: false })
    renderBoard({ projectId: 'alpha' })

    expect(pinButton()).toBeDisabled()
    expect(pinButton()).toHaveClass('invisible')

    act(() => usePinnedStore.setState({ pinnedProjectIds: new Set(['alpha']), loaded: true }))
    expect(pinButton()).toBeEnabled()
    expect(pinButton()).not.toHaveClass('invisible')
    expect(pinButton()).toHaveTextContent('Pinned')
  })
})

describe('a click', () => {
  it('pins the project: its default worktree, a toast with its name, and the board stays', async () => {
    renderBoard({ projectId: 'alpha' })

    fireEvent.click(pinButton())

    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Pinned alpha'))
    expect(pinWrites).toEqual([
      { method: 'db.worktree.setPinned', params: { worktreeId: 'alpha-main', pinned: true } }
    ])
    expect(usePinnedStore.getState().pinnedProjectIds.has('alpha')).toBe(true)
    expect(pinButton()).toHaveTextContent('Pinned')
    expect(pinIcon()).toHaveClass('fill-current')

    // Still the project's own board: nothing was selected, expanded or switched
    expect(screen.getByTestId('kanban-board')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /Pinned Projects/ })).toBeNull()
    expect(useProjectStore.getState().selectedProjectId).toBe('alpha')
    expect(useProjectStore.getState().expandedProjectIds.has('alpha')).toBe(false)
    expect(useWorktreeStore.getState().selectedWorktreeId).toBeNull()
    expect(useKanbanStore.getState().isPinnedBoardActive).toBe(false)
  })

  it('on "Pinned" unpins it: every pinned worktree, and the same toast as the menu', async () => {
    await useWorktreeStore.getState().loadWorktrees('alpha', { force: true })
    await act(async () => {
      await usePinnedStore.getState().pinWorktree('alpha-main')
      await usePinnedStore.getState().pinWorktree('alpha-feature')
    })
    pinWrites.length = 0
    renderBoard({ projectId: 'alpha' })
    expect(pinButton()).toHaveTextContent('Pinned')

    fireEvent.click(pinButton())

    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Unpinned alpha'))
    expect(pinWrites.map((write) => write.params)).toEqual(
      expect.arrayContaining([
        { worktreeId: 'alpha-main', pinned: false },
        { worktreeId: 'alpha-feature', pinned: false }
      ])
    )
    expect(pinWrites).toHaveLength(2)
    expect(usePinnedStore.getState().pinnedProjectIds.has('alpha')).toBe(false)
    expect(pinButton()).toHaveTextContent('Pin to board')
    expect(pinIcon()).not.toHaveClass('fill-current')
  })

  it('pins and unpins a connection project through its base instance', async () => {
    renderBoard({ projectId: 'stack' })

    fireEvent.click(pinButton())
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Pinned stack'))
    expect(pinWrites).toEqual([
      { method: 'connectionOps.setPinned', params: { connectionId: 'stack-base', pinned: true } }
    ])
    expect(pinButton()).toHaveTextContent('Pinned')

    fireEvent.click(pinButton())
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Unpinned stack'))
    expect(pinWrites[1]).toEqual({
      method: 'connectionOps.setPinned',
      params: { connectionId: 'stack-base', pinned: false }
    })
    expect(pinButton()).toHaveTextContent('Pin to board')
  })

  it('that fails says so and leaves the button as it was', async () => {
    failingPinWrites.add('alpha-main')
    renderBoard({ projectId: 'alpha' })

    fireEvent.click(pinButton())

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith('Failed to pin alpha', {
        description: 'disk is full'
      })
    )
    expect(toastMock.success).not.toHaveBeenCalled()
    expect(usePinnedStore.getState().pinnedProjectIds.has('alpha')).toBe(false)
    expect(pinButton()).toHaveTextContent('Pin to board')
  })
})

describe('pins made elsewhere', () => {
  it('follows the sidebar menu’s action both ways, with the board open', async () => {
    renderBoard({ projectId: 'alpha' })
    expect(pinButton()).toHaveTextContent('Pin to board')

    // What the project's right-click menu runs
    await act(async () => {
      await setProjectPinned({ id: 'alpha', name: 'alpha' }, true)
    })
    expect(pinButton()).toHaveTextContent('Pinned')

    await act(async () => {
      await setProjectPinned({ id: 'alpha', name: 'alpha' }, false)
    })
    expect(pinButton()).toHaveTextContent('Pin to board')
  })

  it('follows a worktree’s own Pin and Unpin', async () => {
    await useWorktreeStore.getState().loadWorktrees('alpha', { force: true })
    renderBoard({ projectId: 'alpha' })

    await act(() => usePinnedStore.getState().pinWorktree('alpha-feature'))
    expect(pinButton()).toHaveTextContent('Pinned')

    await act(() => usePinnedStore.getState().unpinWorktree('alpha-feature'))
    expect(pinButton()).toHaveTextContent('Pin to board')
  })

  it('is not moved by another project being pinned', async () => {
    renderBoard({ projectId: 'alpha' })

    await act(async () => {
      await setProjectPinned({ id: 'beta', name: 'beta' }, true)
    })
    expect(pinButton()).toHaveTextContent('Pin to board')
  })
})

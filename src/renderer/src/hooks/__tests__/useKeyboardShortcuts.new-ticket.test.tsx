/**
 * Cmd+N starts a new ticket on the board on screen: it opens the To Do column's creation
 * modal, as the column's "New ticket" button does. It only acts on a board — with none on
 * screen, with something open over the board, while a search filters the board, or with the
 * terminal focused, the key is left alone (not swallowed). Rendered with the real column.
 */
import type { PropsWithChildren } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// useKeyboardShortcuts side effects (same set as the board-top-row test)
vi.mock('@/api/settings-api', () => ({
  settingsApi: {
    onSettingsUpdated: vi.fn(() => vi.fn()),
    loadCustomCommandsFile: vi.fn().mockResolvedValue({ success: false })
  }
}))
vi.mock('@/api/db-api', () => ({
  dbApi: {
    setting: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) }
  }
}))
vi.mock('@/api/pet-api', () => ({
  petApi: { updateSettings: vi.fn().mockResolvedValue(undefined) }
}))
vi.mock('@/api/system-api', () => ({
  systemApi: {
    onNewSessionShortcut: vi.fn(() => vi.fn()),
    onFileSearchShortcut: vi.fn(() => vi.fn()),
    onCloseSessionShortcut: vi.fn(() => vi.fn()),
    onMenuAction: vi.fn(() => vi.fn()),
    updateMenuState: vi.fn().mockResolvedValue(undefined)
  }
}))
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/kanban/KanbanTicketCard', () => ({ KanbanTicketCard: () => null }))
vi.mock('@/components/kanban/WorktreePickerModal', () => ({ WorktreePickerModal: () => null }))
// The real modal is a Radix dialog: role="dialog" while open
vi.mock('@/components/kanban/TicketCreateModal', () => ({
  TicketCreateModal: ({ open }: { open: boolean }) =>
    open ? <div role="dialog" data-testid="ticket-create-modal" /> : null
}))
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

import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
import { KanbanColumn } from '@/components/kanban/KanbanColumn'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useDataProjectStore } from '@/stores/useDataProjectStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useShortcutStore } from '@/stores/useShortcutStore'

function Harness({ board = true }: { board?: boolean }): React.JSX.Element {
  useKeyboardShortcuts()
  return (
    <TooltipProvider>
      <input data-testid="board-search-input" />
      <div className="xterm">
        <textarea data-testid="terminal-input" />
      </div>
      {board && (
        <>
          <KanbanColumn column="todo" projectId="proj-1" tickets={[]} />
          <KanbanColumn column="in_progress" projectId="proj-1" tickets={[]} />
        </>
      )}
    </TooltipProvider>
  )
}

const CMD_N = { key: 'n', metaKey: true }

/** Dispatches the key where the focus is, as the browser does. `true` = the app took it. */
const press = (init: KeyboardEventInit): boolean => {
  const target = document.activeElement ?? document.body
  let notPrevented = true
  act(() => {
    notPrevented = fireEvent.keyDown(target, init)
  })
  return !notPrevented
}

const createModal = (): HTMLElement | null => screen.queryByTestId('ticket-create-modal')
const focusOn = (testId: string): void => {
  const element = screen.getByTestId(testId)
  act(() => element.focus())
  expect(document.activeElement).toBe(element)
}

const initialKanbanState = useKanbanStore.getState()

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

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  )
  useShortcutStore.setState({ customBindings: {} })
  useDataProjectStore.getState().reset()
})

afterEach(() => {
  cleanup()
  useKanbanStore.setState(initialKanbanState, true)
  useShortcutStore.setState({ customBindings: {} })
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('Cmd+N on a board', () => {
  it('opens the create-ticket modal', () => {
    render(<Harness />)
    expect(createModal()).toBeNull()

    expect(press(CMD_N)).toBe(true)
    expect(createModal()).not.toBeNull()
  })

  it('works with Ctrl+N too, and while typing in a field of the board', () => {
    render(<Harness />)
    focusOn('board-search-input')

    expect(press({ key: 'n', ctrlKey: true })).toBe(true)
    expect(createModal()).not.toBeNull()
  })

  it('names its key on the New ticket button', () => {
    render(<Harness />)

    expect(screen.getByTestId('kanban-column-add-ticket-btn').getAttribute('title')).toMatch(
      /^New ticket \(.*N\)$/
    )
  })

  it('follows the key the user chose for it', () => {
    useShortcutStore.setState({
      customBindings: { 'board:new-ticket': { key: 'j', modifiers: ['meta'] } }
    })
    render(<Harness />)

    expect(press(CMD_N)).toBe(false)
    expect(createModal()).toBeNull()

    expect(press({ key: 'j', metaKey: true })).toBe(true)
    expect(createModal()).not.toBeNull()
  })

  it('leaves Cmd+Shift+N (New Worktree) alone', () => {
    render(<Harness />)

    press({ key: 'N', code: 'KeyN', metaKey: true, shiftKey: true })
    expect(createModal()).toBeNull()
  })
})

describe('Cmd+N is left alone', () => {
  it('with no board on screen', () => {
    render(<Harness board={false} />)

    expect(press(CMD_N)).toBe(false)
    expect(createModal()).toBeNull()
  })

  it('once the board is gone', () => {
    const { rerender } = render(<Harness />)
    rerender(<Harness board={false} />)

    expect(press(CMD_N)).toBe(false)
    expect(createModal()).toBeNull()
  })

  it('while a search filters the board, as the New ticket button is hidden', () => {
    render(<Harness />)
    act(() =>
      useKanbanStore.setState({
        boardSearch: { ...initialKanbanState.boardSearch, open: true, query: 'x' }
      })
    )

    expect(press(CMD_N)).toBe(false)
    expect(createModal()).toBeNull()

    // The search cleared, the shortcut is back
    act(() => useKanbanStore.setState({ boardSearch: initialKanbanState.boardSearch }))
    expect(press(CMD_N)).toBe(true)
    expect(createModal()).not.toBeNull()
  })

  it('while a dialog is open over the board', () => {
    render(
      <>
        <Harness />
        <div role="dialog" data-testid="some-dialog" />
      </>
    )

    expect(press(CMD_N)).toBe(false)
    expect(createModal()).toBeNull()
  })

  it('while the ticket is being written', () => {
    render(<Harness />)
    expect(press(CMD_N)).toBe(true)

    expect(press(CMD_N)).toBe(false)
    expect(screen.getAllByTestId('ticket-create-modal')).toHaveLength(1)
  })

  it('in the terminal, where Ctrl+N is next-history', () => {
    render(<Harness />)
    focusOn('terminal-input')

    expect(press({ key: 'n', ctrlKey: true })).toBe(false)
    expect(createModal()).toBeNull()
  })
})

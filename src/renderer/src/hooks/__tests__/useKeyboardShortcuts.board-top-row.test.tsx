/**
 * Bare Tab / Shift+Tab are global shortcuts (the active session's mode and super toggles),
 * caught on the document in the capture phase. On a board they would flip the mode of a session
 * nobody is looking at, so the board's top row (BoardTopRow) takes them instead:
 * - with nothing focused, Tab moves the focus to the row's first control and Shift+Tab to its
 *   last, which on a project's board is the "Pin to board" button;
 * - with the focus in the row (data-tab-navigates) the keys are left to the browser, which walks
 *   to the next control.
 * Anywhere else the session shortcuts keep the keys.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

// useKeyboardShortcuts side effects (same set as the document-flow test)
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

import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
import { BoardTopRow } from '@/components/kanban/BoardTopRow'
import { TooltipProvider } from '@/components/ui/tooltip'
import { usePinnedStore } from '@/stores/usePinnedStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useShortcutStore } from '@/stores/useShortcutStore'

// Radix's popper (the tooltips) measures with a ResizeObserver, which jsdom lacks.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub

// A focused button opens its tooltip, which floating-ui positions after probing `:popover-open`
// and `:modal`. jsdom's selector engine takes seconds over each probe; "not in the top layer"
// is the answer here anyway (see ProjectItem.shell-commands.test.tsx).
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

const initialSessionState = useSessionStore.getState()

type RowProps = Parameters<typeof BoardTopRow>[0]

/** The global shortcut listener beside a board's top row, and a button outside the row. */
function Harness({
  row = { projectId: 'project-1' },
  showRow = true,
  dialogOpen = false
}: {
  row?: RowProps
  showRow?: boolean
  dialogOpen?: boolean
}): React.JSX.Element {
  useKeyboardShortcuts()
  return (
    <TooltipProvider>
      <button data-testid="outside-button" />
      {showRow && <BoardTopRow {...row} />}
      {dialogOpen && <div role="dialog" />}
    </TooltipProvider>
  )
}

/** Presses the key with nothing focused; true when nothing prevented its default. */
function pressOnPage(shiftKey = false): boolean {
  ;(document.activeElement as HTMLElement | null)?.blur?.()
  expect(document.body).toHaveFocus()
  return fireEvent.keyDown(document.body, { key: 'Tab', shiftKey })
}

const toggleSessionMode = vi.fn()
const toggleSuperPlanShortcut = vi.fn()

/** Presses Tab and Shift+Tab on `element`; true for each whose default nothing prevented. */
function pressTabs(element: Element): { tab: boolean; shiftTab: boolean } {
  return {
    tab: fireEvent.keyDown(element, { key: 'Tab' }),
    shiftTab: fireEvent.keyDown(element, { key: 'Tab', shiftKey: true })
  }
}

beforeEach(() => {
  useShortcutStore.setState({ customBindings: {} })
  useSessionStore.setState({
    activeSessionId: 'session-behind',
    toggleSessionMode,
    toggleSuperPlanShortcut
  } as never)
  useProjectStore.setState({ projects: [{ id: 'project-1', name: 'project-1' }] as never })
  usePinnedStore.setState({ pinnedProjectIds: new Set(), loaded: true })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useSessionStore.setState(initialSessionState, true)
  useProjectStore.setState({ projects: [] })
  usePinnedStore.setState({ pinnedProjectIds: new Set(), loaded: false })
})

describe('Tab on a board with nothing focused', () => {
  it('moves the focus to the pin button, and toggles no session mode', () => {
    render(<Harness />)

    expect(pressOnPage()).toBe(false)

    expect(screen.getByTestId('board-pin-button')).toHaveFocus()
    expect(toggleSessionMode).not.toHaveBeenCalled()
    expect(toggleSuperPlanShortcut).not.toHaveBeenCalled()
  })

  it('stays the session shortcut while the row has no control: before the pins are read', () => {
    act(() => usePinnedStore.setState({ loaded: false }))
    render(<Harness />)

    pressOnPage(true)

    expect(screen.getByTestId('board-pin-button')).not.toHaveFocus()
    expect(document.body).toHaveFocus()
  })

  it('stays the session shortcut while a dialog is open over the board', () => {
    render(<Harness dialogOpen />)

    expect(pressOnPage()).toBe(false)

    expect(document.body).toHaveFocus()
    expect(toggleSessionMode).toHaveBeenCalledWith('session-behind')
  })

  it('stays the session shortcut on a board with no row, and once the board is gone', () => {
    // A connection that was not saved as a project: no row
    const { rerender } = render(<Harness row={{ connectionId: 'connection-1' }} />)
    expect(screen.queryByTestId('board-top-row')).toBeNull()
    pressOnPage()
    expect(toggleSessionMode).toHaveBeenCalledTimes(1)

    rerender(<Harness />)
    pressOnPage()
    expect(screen.getByTestId('board-pin-button')).toHaveFocus()
    expect(toggleSessionMode).toHaveBeenCalledTimes(1)

    rerender(<Harness showRow={false} />)
    pressOnPage()
    expect(document.body).toHaveFocus()
    expect(toggleSessionMode).toHaveBeenCalledTimes(2)
  })

  it('leaves Ctrl+Tab and ⌘Tab alone', () => {
    render(<Harness />)
    fireEvent.keyDown(document.body, { key: 'Tab', ctrlKey: true })
    fireEvent.keyDown(document.body, { key: 'Tab', metaKey: true })
    expect(document.body).toHaveFocus()
  })
})

describe('Tab in the board’s top row', () => {
  it('is left to the browser on the pin button, never toggling the session mode', () => {
    render(<Harness />)
    const pin = screen.getByTestId('board-pin-button')
    pin.focus()

    // Nothing prevents the default: the browser moves the focus
    expect(pressTabs(pin)).toEqual({ tab: true, shiftTab: true })
    expect(toggleSessionMode).not.toHaveBeenCalled()
    expect(toggleSuperPlanShortcut).not.toHaveBeenCalled()
  })

  it('still toggles the session mode from a button outside the row', () => {
    render(<Harness />)
    const outside = screen.getByTestId('outside-button')
    outside.focus()

    const tab = fireEvent.keyDown(outside, { key: 'Tab' })

    expect(tab).toBe(false)
    expect(toggleSessionMode).toHaveBeenCalledWith('session-behind')
  })
})

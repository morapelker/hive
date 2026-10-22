/**
 * Bare Tab / Shift+Tab are global shortcuts (the active session's mode and super toggles),
 * caught on the document in the capture phase. The ticket label dialogs (and the Manage
 * dialog's colour popover, portaled outside it) opt out with data-tab-navigates, so Tab moves
 * focus between their fields instead of flipping the mode of the session behind the board.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { KanbanTicket } from '../../../../main/db/types'
import type { SavedTicketLabel } from '@shared/lib/ticket-labels'

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
vi.mock('@/lib/ticket-label-toggle', () => ({
  setTicketLabel: vi.fn(async () => 'applied')
}))

import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
import { TicketLabelDialog } from '@/components/kanban/TicketLabelDialog'
import { ManageTicketLabelsDialog } from '@/components/kanban/ManageTicketLabelsDialog'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useShortcutStore } from '@/stores/useShortcutStore'
import { useTicketLabelsStore } from '@/stores/useTicketLabelsStore'

const initialKanbanState = useKanbanStore.getState()
const initialLabelsState = useTicketLabelsStore.getState()
const initialSessionState = useSessionStore.getState()

// The colour popover is positioned by floating-ui, which probes `:popover-open` and `:modal`.
// jsdom's selector engine takes seconds over each probe; floating-ui reads a throw as "not in
// the top layer", which is the answer here anyway.
const nativeMatches = Element.prototype.matches
beforeAll(() => {
  Element.prototype.matches = function (this: Element, selector: string): boolean {
    if (selector === ':popover-open' || selector === ':modal') {
      throw new SyntaxError(`Unsupported selector ${selector}`)
    }
    return nativeMatches.call(this, selector)
  }
})
afterAll(() => {
  Element.prototype.matches = nativeMatches
})

const now = '2026-01-01T00:00:00.000Z'
const joySaved: SavedTicketLabel = {
  id: 'lbl-joy',
  name: 'Waiting for Joy',
  color: 'yellow',
  sort_order: 0,
  created_at: now,
  updated_at: now
}
const blockedSaved: SavedTicketLabel = {
  ...joySaved,
  id: 'lbl-blocked',
  name: 'Blocked',
  sort_order: 1
}

/** The global shortcut listener beside the board's label dialogs, and a field outside them. */
function Harness(): React.JSX.Element {
  useKeyboardShortcuts()
  return (
    <>
      <input data-testid="outside-field" />
      <TicketLabelDialog />
      <ManageTicketLabelsDialog />
    </>
  )
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

/**
 * The Tab keys pressed on `element` that bubbled up to the window. A shortcut the capture-phase
 * layer acts on stops there, so a key that arrives was left to the page.
 */
function tabsReachingWindow(element: Element): string[] {
  const reached: string[] = []
  const record = (e: KeyboardEvent): void => {
    if (e.key === 'Tab') reached.push(e.shiftKey ? 'Shift+Tab' : 'Tab')
  }
  window.addEventListener('keydown', record)
  try {
    pressTabs(element)
  } finally {
    window.removeEventListener('keydown', record)
  }
  return reached
}

beforeEach(() => {
  useShortcutStore.setState({ customBindings: {} })
  useSessionStore.setState({
    activeSessionId: 'session-behind',
    toggleSessionMode,
    toggleSuperPlanShortcut
  } as never)
  useKanbanStore.setState({
    tickets: new Map([
      [
        'project-1',
        [
          {
            id: 'ticket-1',
            project_id: 'project-1',
            title: 'Add dark mode',
            labels: []
          } as never as KanbanTicket
        ]
      ]
    ])
  })
  useTicketLabelsStore.setState({
    labels: [joySaved, blockedSaved],
    loaded: true,
    usage: vi.fn(async () => ({ 'lbl-joy': 1 }))
  } as never)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useKanbanStore.setState(initialKanbanState, true)
  useTicketLabelsStore.setState(initialLabelsState, true)
  useSessionStore.setState(initialSessionState, true)
})

describe('Tab inside the ticket label dialogs', () => {
  it('moves focus in the New label / One-off label dialog, never toggling the session mode', () => {
    useTicketLabelsStore.setState({
      dialog: { kind: 'create', projectId: 'project-1', ticketId: 'ticket-1', mode: 'once' }
    })
    render(<Harness />)

    // From a field inside the dialog nothing prevents the default: the browser moves focus
    const swatch = screen.getByTestId('ticket-label-color-gray')
    swatch.focus()
    expect(pressTabs(swatch)).toEqual({ tab: true, shiftTab: true })

    // At the ends the keys reach Radix's focus trap, which wraps around: Shift+Tab from the
    // name field (the first stop) lands on the last one, still inside the dialog
    const name = screen.getByTestId('ticket-label-name-input')
    name.focus()
    fireEvent.keyDown(name, { key: 'Tab', shiftKey: true })
    expect(name).not.toHaveFocus()
    expect(screen.getByTestId('ticket-label-dialog')).toContainElement(
      document.activeElement as HTMLElement
    )

    expect(toggleSessionMode).not.toHaveBeenCalled()
    expect(toggleSuperPlanShortcut).not.toHaveBeenCalled()
  })

  it('moves focus in the Manage labels dialog and in its colour popover', () => {
    useTicketLabelsStore.setState({ dialog: { kind: 'manage' } })
    render(<Harness />)
    const rename = screen.getByTestId('manage-label-name-lbl-joy')
    rename.focus()

    expect(pressTabs(rename)).toEqual({ tab: true, shiftTab: true })

    // The popover is portaled outside the dialog's element: it carries the opt-out itself.
    // Its only tab stop is the selected swatch, so Radix's focus loop keeps the focus there
    // (that is Radix preventing the default, not the shortcut layer): the keys go on to it.
    fireEvent.click(screen.getByTestId('manage-label-color-lbl-joy'))
    const swatch = screen.getByTestId('manage-label-swatch-lbl-joy-yellow')
    expect(screen.getByTestId('manage-ticket-labels-dialog').contains(swatch)).toBe(false)
    swatch.focus()

    expect(tabsReachingWindow(swatch)).toEqual(['Tab', 'Shift+Tab'])
    expect(swatch).toHaveFocus()
    expect(toggleSessionMode).not.toHaveBeenCalled()
    expect(toggleSuperPlanShortcut).not.toHaveBeenCalled()
  })

  it('still toggles the session mode from a field outside the dialogs', () => {
    render(<Harness />)
    const field = screen.getByTestId('outside-field')
    field.focus()

    const tab = fireEvent.keyDown(field, { key: 'Tab' })

    expect(tab).toBe(false)
    expect(toggleSessionMode).toHaveBeenCalledWith('session-behind')
  })
})

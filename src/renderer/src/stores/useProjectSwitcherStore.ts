import { create } from 'zustand'

// The "Go to project" switcher (components/project-switcher). One overlay for the whole
// window: every way of triggering it goes through `toggle`, so triggering it while it is open
// closes it and two can never be open.
//
// Closing puts the keyboard focus back where it was when the switcher opened, caret included,
// unless the element is gone by then (the main pane changed).

/**
 * Projects to connect as soon as the switcher shows them, as if they had been picked there
 * and Enter pressed (a `hive://connection/new` link). The panel takes it and clears it.
 */
export interface SwitcherConnectRequest {
  members: { projectId: string; useBase: boolean }[]
  /** Sets the "Pull latest from origin" switch first; undefined leaves it as it is. */
  pull?: boolean
}

interface ProjectSwitcherState {
  isOpen: boolean
  pendingConnect: SwitcherConnectRequest | null
  /** Opens the switcher (or uses the open one) and connects the projects in it. */
  openAndConnect: (request: SwitcherConnectRequest) => void
  takePendingConnect: () => SwitcherConnectRequest | null
  open: () => void
  /** `restoreFocus: false` when something else takes the focus (another overlay opening). */
  close: (options?: { restoreFocus?: boolean }) => void
  toggle: () => void
}

interface FocusSnapshot {
  element: HTMLElement
  /** The selection inside a contenteditable element; inputs keep theirs on their own. */
  range: Range | null
}

let focusBeforeOpen: FocusSnapshot | null = null

function captureFocus(): FocusSnapshot | null {
  const element = document.activeElement
  if (!(element instanceof HTMLElement) || element === document.body) return null
  let range: Range | null = null
  if (element.isContentEditable) {
    const selection = window.getSelection()
    if (selection && selection.rangeCount > 0) range = selection.getRangeAt(0).cloneRange()
  }
  return { element, range }
}

function restoreFocus(snapshot: FocusSnapshot | null): void {
  if (!snapshot || !snapshot.element.isConnected) return
  snapshot.element.focus({ preventScroll: true })
  if (snapshot.range && document.activeElement === snapshot.element) {
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(snapshot.range)
  }
}

export const useProjectSwitcherStore = create<ProjectSwitcherState>()((set, get) => ({
  isOpen: false,
  pendingConnect: null,

  openAndConnect: (request) => {
    set({ pendingConnect: request })
    get().open()
  },

  takePendingConnect: () => {
    const request = get().pendingConnect
    if (request) set({ pendingConnect: null })
    return request
  },

  open: () => {
    if (get().isOpen) return
    focusBeforeOpen = captureFocus()
    set({ isOpen: true })
  },

  close: (options) => {
    if (!get().isOpen) return
    set({ isOpen: false, pendingConnect: null })
    const snapshot = focusBeforeOpen
    focusBeforeOpen = null
    if (options?.restoreFocus !== false) restoreFocus(snapshot)
  },

  toggle: () => {
    if (get().isOpen) get().close()
    else get().open()
  }
}))

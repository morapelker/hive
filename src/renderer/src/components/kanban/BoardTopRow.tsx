/**
 * The board's top row. At the left: the pinned board's label. At the right, on the board of one
 * project: its "Pin to board" button (BoardPinButton). A board with neither (a connection that
 * was not saved as a project) has no row at all. It sits above the column scroller, so it stays
 * put while the columns scroll sideways.
 *
 * The row is a size container: the pin button loses its label below 260px.
 *
 * The keyboard reaches the row with Tab. Bare Tab and Shift+Tab are session shortcuts everywhere
 * (the mode toggles of useKeyboardShortcuts), which on a board would flip the mode of a session
 * nobody is looking at. So while nothing has the focus, Tab enters the row at its first control
 * and Shift+Tab at its last (useTabEntersRow); and the row is marked `data-tab-navigates`, so
 * with the focus in it the two keys walk its controls as in any toolbar.
 */
import { useEffect, useRef, type RefObject } from 'react'
import { Pin } from 'lucide-react'
import { BoardPinButton } from './BoardPinButton'
import { useBoardPinProject } from './board-pin-project'

const ROW_TAB_STOPS = 'button:not([disabled]), [tabindex="0"]'

/** The row's controls the keyboard can land on, in order; what a narrow row hides is left out. */
function rowTabStops(row: HTMLElement): HTMLElement[] {
  return [...row.querySelectorAll<HTMLElement>(ROW_TAB_STOPS)].filter(
    // jsdom has no checkVisibility: there everything counts as shown
    (stop) => stop.checkVisibility?.() ?? true
  )
}

/**
 * Tab, pressed on a board while nothing has the focus, moves the focus into the row: to its
 * first control, or with Shift to its last. From there the keys walk the row natively
 * (`data-tab-navigates`). Anything focused, an open dialog or a row with no control leaves the
 * key to whoever had it before.
 *
 * Window capture, like BoardSearchBar: the session shortcuts listen on the document's capture
 * phase and would otherwise take the key first.
 */
function useTabEntersRow(rowRef: RefObject<HTMLDivElement | null>, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    const handler = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey) return
      if (event.defaultPrevented) return
      const focused = document.activeElement
      if (focused && focused !== document.body && focused !== document.documentElement) return
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return
      const row = rowRef.current
      if (!row) return
      const stops = rowTabStops(row)
      const stop = event.shiftKey ? stops[stops.length - 1] : stops[0]
      if (!stop) return
      event.preventDefault()
      event.stopImmediatePropagation()
      stop.focus()
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [rowRef, enabled])
}

interface BoardTopRowProps {
  projectId?: string
  connectionId?: string
  isPinnedMode?: boolean
  /** The pinned board's label. */
  pinnedProjectCount?: number
}

export function BoardTopRow({
  projectId,
  connectionId,
  isPinnedMode,
  pinnedProjectCount = 0
}: BoardTopRowProps) {
  const pinProject = useBoardPinProject({ projectId, connectionId, isPinnedMode })
  const hasRow = Boolean(isPinnedMode) || pinProject !== null
  const rowRef = useRef<HTMLDivElement>(null)
  useTabEntersRow(rowRef, hasRow)
  if (!hasRow) return null
  return (
    <div
      ref={rowRef}
      data-testid="board-top-row"
      data-tab-navigates
      className="@container/board flex h-8 shrink-0 items-center gap-2 px-4 pt-1.5"
    >
      {isPinnedMode && (
        <div className="flex shrink-0 items-center gap-2">
          <Pin className="h-4 w-4 text-muted-foreground" />
          <h2 className="whitespace-nowrap text-sm font-medium text-muted-foreground">
            Pinned Projects ({pinnedProjectCount})
          </h2>
        </div>
      )}
      {pinProject && <BoardPinButton project={pinProject} className="ml-auto" />}
    </div>
  )
}

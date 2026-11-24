import { useCallback, useEffect, useRef } from 'react'
import type React from 'react'
import { isMac } from '@/lib/platform'

/** Pixels the pointer must travel before a ⌘⇧ press becomes a drag. */
const DRAG_THRESHOLD_PX = 6

/**
 * Set on the columns the gesture can be released on while it is on: `target` for each of
 * them, `over` for the one under the pointer (KanbanColumn styles both).
 */
export const ARCHIVE_DRAG_ATTR = 'data-archive-drag'

type ChordEvent = Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>

/**
 * ⌘⇧ on macOS, Ctrl+Shift elsewhere. Never Ctrl on macOS: a Ctrl-click is the context menu
 * there, and a press under an open menu must not turn into a drag.
 */
export const isArchiveOverrideChord = (e: ChordEvent): boolean =>
  e.shiftKey && (isMac() ? e.metaKey && !e.ctrlKey : e.ctrlKey)

/**
 * The chip under the gesture's ghost: what a release on a marked column does, so the drag
 * never reads as an ordinary move.
 */
export function buildArchiveOverrideGhostChip(): HTMLElement {
  const chip = document.createElement('div')
  chip.setAttribute('data-testid', 'archive-override-drag-chip')
  chip.className =
    'absolute left-0 top-full mt-1.5 inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-medium leading-none text-foreground shadow-md'

  const action = document.createElement('span')
  action.textContent = 'Archive all'
  chip.appendChild(action)

  const detail = document.createElement('span')
  detail.className = 'truncate text-muted-foreground'
  detail.textContent = 'no branch checks'
  chip.appendChild(detail)
  return chip
}

interface ArchiveOverrideDragOptions {
  enabled: boolean
  /**
   * The `data-kanban-column` values a release counts on, read at the press. With none of
   * them on the board there is no gesture: the card keeps its native drag.
   */
  targets: () => readonly string[]
  /** Called with the target column the card was released on. */
  onDrop: (column: string) => void
  /** Called with the ghost right after it is cloned from the card, before it is attached. */
  decorateGhost?: (ghost: HTMLElement) => void
}

interface ArchiveOverrideDragHandlers {
  onMouseDown: (e: React.MouseEvent) => void
  /** True when the gesture took the drag over: the native drag was cancelled. */
  onDragStart: (e: React.DragEvent) => boolean
}

/**
 * A card drag with ⌘⇧ held, run on mouse events instead of the native drag. It has to be:
 * AppKit narrows a drag to its "generic" operation while ⌘ is held, Chromium maps that to no
 * operation at all, and the drop is refused before any drop event fires — whatever
 * `effectAllowed` says (the same holds for Ctrl, the copy modifier, on Windows and Linux). So
 * the native drag is cancelled the moment it starts with the chord held and this gesture takes
 * its place: a ghost of the card follows the pointer, the columns it can be released on are
 * marked, and `onDrop` hears the one it was released on. Escape, or a release anywhere else,
 * cancels. The chord only has to be held when the drag starts.
 */
export function useArchiveOverrideDrag({
  enabled,
  targets,
  onDrop,
  decorateGhost
}: ArchiveOverrideDragOptions): ArchiveOverrideDragHandlers {
  const onDropRef = useRef(onDrop)
  onDropRef.current = onDrop
  const targetsRef = useRef(targets)
  targetsRef.current = targets
  const decorateGhostRef = useRef(decorateGhost)
  decorateGhostRef.current = decorateGhost

  const pressRef = useRef<{ x: number; y: number; el: HTMLElement } | null>(null)
  /** Promotes the press to a drag (set while a press is on). */
  const startDragRef = useRef<(() => void) | null>(null)
  const draggingRef = useRef(false)
  const ghostRef = useRef<HTMLElement | null>(null)
  const markedColumnsRef = useRef<HTMLElement[]>([])
  const hoveredColumnRef = useRef<HTMLElement | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)

  /** Everything the drag shows: the ghost, the marked columns, the cursor. */
  const clearDragVisuals = (): void => {
    ghostRef.current?.remove()
    ghostRef.current = null
    for (const column of markedColumnsRef.current) column.removeAttribute(ARCHIVE_DRAG_ATTR)
    markedColumnsRef.current = []
    hoveredColumnRef.current = null
    document.body.style.removeProperty('cursor')
    document.body.style.removeProperty('user-select')
  }

  const endGesture = (): void => {
    cleanupRef.current?.()
    cleanupRef.current = null
    clearDragVisuals()
    pressRef.current = null
    startDragRef.current = null
    draggingRef.current = false
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => endGesture, [])

  /** False when the board shows no column the card could be released on: no gesture then. */
  const begin = (el: HTMLElement, x: number, y: number): boolean => {
    const targetNames = targetsRef.current()
    const targetColumns = Array.from(
      document.querySelectorAll<HTMLElement>('[data-kanban-column]')
    ).filter((column) => targetNames.includes(column.getAttribute('data-kanban-column') ?? ''))
    if (targetColumns.length === 0) return false

    pressRef.current = { x, y, el }
    draggingRef.current = false
    const pointer = { x, y }
    // Escape gives the drag up while the button is still down: the release is then nothing
    let cancelled = false

    const columnAt = (px: number, py: number): HTMLElement | null => {
      const column = document
        .elementFromPoint(px, py)
        ?.closest<HTMLElement>('[data-kanban-column]')
      return column && markedColumnsRef.current.includes(column) ? column : null
    }

    const setHoveredColumn = (column: HTMLElement | null): void => {
      if (hoveredColumnRef.current === column) return
      hoveredColumnRef.current?.setAttribute(ARCHIVE_DRAG_ATTR, 'target')
      hoveredColumnRef.current = column
      column?.setAttribute(ARCHIVE_DRAG_ATTR, 'over')
    }

    const positionGhost = (): void => {
      const ghost = ghostRef.current
      if (!ghost) return
      ghost.style.transform = `translate(${pointer.x - ghost.offsetWidth / 2}px, ${pointer.y - ghost.offsetHeight / 2}px) rotate(3deg)`
    }

    const startDrag = (): void => {
      if (draggingRef.current || cancelled) return
      draggingRef.current = true

      const ghost = el.cloneNode(true) as HTMLElement
      ghost.style.width = `${el.offsetWidth}px`
      ghost.style.position = 'fixed'
      ghost.style.left = '0'
      ghost.style.top = '0'
      ghost.style.pointerEvents = 'none'
      ghost.style.zIndex = '9999'
      ghost.style.opacity = '0.85'
      ghost.style.margin = '0'
      ghost.style.overflow = 'visible'
      decorateGhostRef.current?.(ghost)
      document.body.appendChild(ghost)
      ghostRef.current = ghost
      positionGhost()

      markedColumnsRef.current = targetColumns
      for (const column of targetColumns) column.setAttribute(ARCHIVE_DRAG_ATTR, 'target')

      // No native drag holds the selection off any more: a press that moves would select text
      document.body.style.cursor = 'grabbing'
      document.body.style.userSelect = 'none'
      window.getSelection()?.removeAllRanges()
      setHoveredColumn(columnAt(pointer.x, pointer.y))
    }
    startDragRef.current = startDrag

    // The click a release is followed by must not reach the card (⌘⇧-click opens its
    // checkout) or whatever else sits under the pointer: eat that one click only
    const swallowNextClick = (): void => {
      const swallow = (ev: MouseEvent): void => {
        ev.preventDefault()
        ev.stopPropagation()
      }
      window.addEventListener('click', swallow, true)
      setTimeout(() => window.removeEventListener('click', swallow, true), 0)
    }

    const handleMove = (ev: MouseEvent): void => {
      const press = pressRef.current
      if (!press || cancelled) return
      pointer.x = ev.clientX
      pointer.y = ev.clientY
      if (!draggingRef.current) {
        if (Math.hypot(ev.clientX - press.x, ev.clientY - press.y) < DRAG_THRESHOLD_PX) return
        startDrag()
      }
      positionGhost()
      setHoveredColumn(columnAt(ev.clientX, ev.clientY))
    }

    const handleUp = (ev: MouseEvent): void => {
      if (ev.button !== 0) return
      const wasDragging = draggingRef.current
      const column = wasDragging && !cancelled ? columnAt(ev.clientX, ev.clientY) : null
      const name = column?.getAttribute('data-kanban-column') ?? null
      endGesture()
      // A press that never moved is a plain ⌘⇧-click: the card's own click handles it
      if (!wasDragging) return
      swallowNextClick()
      if (name) onDropRef.current(name)
    }

    const handleKeyDown = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape' || !draggingRef.current || cancelled) return
      ev.preventDefault()
      ev.stopPropagation()
      cancelled = true
      clearDragVisuals()
    }

    window.addEventListener('mousemove', handleMove, true)
    window.addEventListener('mouseup', handleUp, true)
    window.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('blur', endGesture)
    cleanupRef.current = () => {
      window.removeEventListener('mousemove', handleMove, true)
      window.removeEventListener('mouseup', handleUp, true)
      window.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('blur', endGesture)
    }
    return true
  }

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!enabled || e.button !== 0 || pressRef.current || !isArchiveOverrideChord(e)) return
      begin(e.currentTarget as HTMLElement, e.clientX, e.clientY)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enabled]
  )

  const onDragStart = useCallback(
    (e: React.DragEvent): boolean => {
      // The chord went down after the button did: the drag starts here instead of at the press
      if (!pressRef.current) {
        if (!enabled || !isArchiveOverrideChord(e)) return false
        if (!begin(e.currentTarget as HTMLElement, e.clientX, e.clientY)) return false
      }
      // The native drag would be refused at the drop with ⌘ held: this gesture is the drag
      e.preventDefault()
      startDragRef.current?.()
      return true
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enabled]
  )

  return { onMouseDown, onDragStart }
}

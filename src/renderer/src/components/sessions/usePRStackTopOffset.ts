import { useEffect, useState } from 'react'
import { usePRNotificationStore } from '@/stores/usePRNotificationStore'

/**
 * The PR notification stack is rendered at `top-4 right-4` inside `MainPane`.
 * Its stacked cards can grow well past 80px (single card with description ≈
 * 60–100px; two cards + 8px gap easily exceeds 150px), so a fixed `top-20`
 * (=80px) offset for the TaskListWidget visibly overlaps the stack whenever a
 * notification has any description or when more than one is queued.
 *
 * This hook measures the stack's actual rendered height via
 * `data-testid="pr-notification-stack"` and returns an offset (in px) that
 * clears it with an 8px gap. Without any notifications (stack unmounted) it
 * returns the baseline 16px — the same position as `top-4`.
 *
 * It re-measures in response to:
 *   - `notifications.length` changes (card added or removed)
 *   - `ResizeObserver` callbacks (a single card's own height changed, e.g.
 *     a status transition that added or removed an action row)
 *
 * If `ResizeObserver` is unavailable (older runtime, some test environments)
 * the hook still performs the initial measurement and gracefully skips
 * observation.
 */

/** Matches the stack's own `top-4` (=16px) position inside MainPane. */
export const BASELINE_TOP_PX = 16
/** Vertical gap between the stack's bottom edge and the widget. */
const STACK_TO_WIDGET_GAP_PX = 8
/** Selector for the stack element. Kept in sync with PRNotificationStack. */
const PR_STACK_SELECTOR = '[data-testid="pr-notification-stack"]'

export function usePRStackTopOffset(): number {
  const notificationCount = usePRNotificationStore((s) => s.notifications.length)
  const [stackHeightPx, setStackHeightPx] = useState(0)

  useEffect(() => {
    if (notificationCount === 0) {
      setStackHeightPx(0)
      return
    }

    const stack = document.querySelector(PR_STACK_SELECTOR)
    if (!(stack instanceof HTMLElement)) {
      // Stack hasn't committed to the DOM yet for this render pass. Retry
      // once on the next animation frame to close the race without relying on
      // the next notificationCount change to trigger a re-measure.
      let observer: ResizeObserver | null = null
      const raf = requestAnimationFrame(() => {
        const retryStack = document.querySelector(PR_STACK_SELECTOR)
        if (!(retryStack instanceof HTMLElement)) return
        setStackHeightPx(retryStack.offsetHeight)
        if (typeof ResizeObserver === 'undefined') return
        observer = new ResizeObserver(() => setStackHeightPx(retryStack.offsetHeight))
        observer.observe(retryStack)
      })
      return () => {
        cancelAnimationFrame(raf)
        observer?.disconnect()
      }
    }

    const measure = (): void => {
      setStackHeightPx(stack.offsetHeight)
    }
    measure()

    if (typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(measure)
    observer.observe(stack)
    return () => observer.disconnect()
  }, [notificationCount])

  return stackHeightPx > 0 ? BASELINE_TOP_PX + stackHeightPx + STACK_TO_WIDGET_GAP_PX : BASELINE_TOP_PX
}

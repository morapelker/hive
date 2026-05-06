import { useCallback, useRef } from 'react'
import type * as React from 'react'

export function usePetHover(isDraggingRef: React.MutableRefObject<boolean>): {
  onMouseEnter: () => void
  onMouseLeave: () => void
} {
  const leaveTimerRef = useRef<number | null>(null)

  const clearLeaveTimer = useCallback(() => {
    if (leaveTimerRef.current !== null) {
      window.clearTimeout(leaveTimerRef.current)
      leaveTimerRef.current = null
    }
  }, [])

  const onMouseEnter = useCallback(() => {
    clearLeaveTimer()
    window.petOps.setIgnoreMouse(false)
  }, [clearLeaveTimer])

  const onMouseLeave = useCallback(() => {
    clearLeaveTimer()
    leaveTimerRef.current = window.setTimeout(() => {
      if (!isDraggingRef.current) {
        window.petOps.setIgnoreMouse(true)
      }
    }, 50)
  }, [clearLeaveTimer, isDraggingRef])

  return { onMouseEnter, onMouseLeave }
}

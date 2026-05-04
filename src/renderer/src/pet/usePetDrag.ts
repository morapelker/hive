import { useCallback, useRef } from 'react'
import type * as React from 'react'
import type { PetPosition } from '@shared/types/pet'

export function usePetDrag(initialPosition: PetPosition | null): {
  isDraggingRef: React.MutableRefObject<boolean>
  wasDraggedRef: React.MutableRefObject<boolean>
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void
} {
  const positionRef = useRef<PetPosition>(initialPosition ?? { x: 0, y: 0 })
  const dragRef = useRef<{
    pointerId: number
    startScreenX: number
    startScreenY: number
    startX: number
    startY: number
    raf: number | null
    pending: PetPosition | null
  } | null>(null)
  const isDraggingRef = useRef(false)
  const wasDraggedRef = useRef(false)

  if (initialPosition) {
    positionRef.current = initialPosition
  }

  const flushMove = useCallback(() => {
    const drag = dragRef.current
    if (!drag?.pending) return
    const next = drag.pending
    drag.pending = null
    drag.raf = null
    positionRef.current = next
    window.petOps.move(next)
  }, [])

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return

      event.currentTarget.setPointerCapture(event.pointerId)
      isDraggingRef.current = true
      wasDraggedRef.current = false
      window.petOps.setIgnoreMouse(false)

      dragRef.current = {
        pointerId: event.pointerId,
        startScreenX: event.screenX,
        startScreenY: event.screenY,
        startX: positionRef.current.x,
        startY: positionRef.current.y,
        raf: null,
        pending: null
      }

      const handlePointerMove = (moveEvent: PointerEvent): void => {
        const drag = dragRef.current
        if (!drag || moveEvent.pointerId !== drag.pointerId) return

        const x = Math.round(drag.startX + moveEvent.screenX - drag.startScreenX)
        const y = Math.round(drag.startY + moveEvent.screenY - drag.startScreenY)
        if (x !== drag.startX || y !== drag.startY) {
          wasDraggedRef.current = true
        }
        drag.pending = { x, y }

        if (drag.raf === null) {
          drag.raf = window.requestAnimationFrame(flushMove)
        }
      }

      const stopDrag = (upEvent: PointerEvent): void => {
        const drag = dragRef.current
        if (!drag || upEvent.pointerId !== drag.pointerId) return

        if (drag.raf !== null) {
          window.cancelAnimationFrame(drag.raf)
        }
        if (drag.pending) {
          positionRef.current = drag.pending
          window.petOps.move(drag.pending)
        }
        dragRef.current = null
        isDraggingRef.current = false
        window.petOps.setIgnoreMouse(true)
        window.removeEventListener('pointermove', handlePointerMove)
        window.removeEventListener('pointerup', stopDrag)
        window.removeEventListener('pointercancel', stopDrag)
      }

      window.addEventListener('pointermove', handlePointerMove)
      window.addEventListener('pointerup', stopDrag)
      window.addEventListener('pointercancel', stopDrag)
    },
    [flushMove, isDraggingRef, wasDraggedRef]
  )

  return { isDraggingRef, wasDraggedRef, onPointerDown }
}

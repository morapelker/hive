import { useCallback, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

interface ResizeHandleProps {
  onResize: (delta: number) => void
  direction: 'left' | 'right' | 'up' | 'down'
  className?: string
}

export function ResizeHandle({
  onResize,
  direction,
  className
}: ResizeHandleProps): React.JSX.Element {
  const isVertical = direction === 'up' || direction === 'down'
  const [isDragging, setIsDragging] = useState(false)
  const [startPos, setStartPos] = useState(0)

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      setIsDragging(true)
      setStartPos(isVertical ? e.clientY : e.clientX)
    },
    [isVertical]
  )

  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent): void => {
      const pos = isVertical ? e.clientY : e.clientX
      const delta = pos - startPos
      const adjustedDelta =
        direction === 'right' || direction === 'down' ? -delta : delta
      onResize(adjustedDelta)
      setStartPos(pos)
    }

    const handleMouseUp = (): void => {
      setIsDragging(false)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging, startPos, onResize, direction, isVertical])

  return (
    <div
      className={cn(
        isVertical
          ? 'h-[3px] cursor-row-resize border-t border-border hover:bg-primary/20 active:bg-primary/30 transition-colors flex-shrink-0'
          : 'w-1 cursor-col-resize hover:bg-primary/20 active:bg-primary/30 transition-colors flex-shrink-0',
        isDragging && 'bg-primary/30',
        className
      )}
      onMouseDown={handleMouseDown}
      role="separator"
      aria-orientation={isVertical ? 'horizontal' : 'vertical'}
      data-testid={`resize-handle-${direction}`}
    />
  )
}

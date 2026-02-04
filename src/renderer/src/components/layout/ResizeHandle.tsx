import { useCallback, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

interface ResizeHandleProps {
  onResize: (delta: number) => void
  direction: 'left' | 'right'
  className?: string
}

export function ResizeHandle({ onResize, direction, className }: ResizeHandleProps): React.JSX.Element {
  const [isDragging, setIsDragging] = useState(false)
  const [startX, setStartX] = useState(0)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsDragging(true)
    setStartX(e.clientX)
  }, [])

  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent): void => {
      const delta = e.clientX - startX
      const adjustedDelta = direction === 'right' ? -delta : delta
      onResize(adjustedDelta)
      setStartX(e.clientX)
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
  }, [isDragging, startX, onResize, direction])

  return (
    <div
      className={cn(
        'w-1 cursor-col-resize hover:bg-primary/20 active:bg-primary/30 transition-colors flex-shrink-0',
        isDragging && 'bg-primary/30',
        className
      )}
      onMouseDown={handleMouseDown}
      role="separator"
      aria-orientation="vertical"
      data-testid={`resize-handle-${direction}`}
    />
  )
}

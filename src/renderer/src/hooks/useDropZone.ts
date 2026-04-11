import { useCallback, useEffect, useRef, useState } from 'react'

interface UseDropZoneProps {
  onDrop: (files: FileList) => void
  /** When provided, listen on this element instead of `window` (scoped drop zone). */
  containerRef?: React.RefObject<HTMLElement>
}

export function useDropZone({ onDrop, containerRef }: UseDropZoneProps) {
  const [isDragging, setIsDragging] = useState(false)
  const dragCounterRef = useRef(0)

  const handleDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault()
    if (!e.dataTransfer?.types.includes('Files')) return
    dragCounterRef.current++
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault()
    if (!e.dataTransfer?.types.includes('Files')) return
    dragCounterRef.current--
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0
      setIsDragging(false)
    }
  }, [])

  const handleDragOver = useCallback((e: DragEvent) => {
    // Only intercept file drags — let kanban (and other in-app) drags propagate
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }, [])

  const handleDrop = useCallback(
    (e: DragEvent) => {
      dragCounterRef.current = 0
      setIsDragging(false)
      // Only intercept file drops — let kanban (and other in-app) drops propagate
      if (e.dataTransfer?.files.length) {
        e.preventDefault()
        onDrop(e.dataTransfer.files)
      }
    },
    [onDrop]
  )

  useEffect(() => {
    const target: Window | HTMLElement = containerRef?.current ?? window
    target.addEventListener('dragenter', handleDragEnter as EventListener)
    target.addEventListener('dragleave', handleDragLeave as EventListener)
    target.addEventListener('dragover', handleDragOver as EventListener)
    target.addEventListener('drop', handleDrop as EventListener)

    return () => {
      target.removeEventListener('dragenter', handleDragEnter as EventListener)
      target.removeEventListener('dragleave', handleDragLeave as EventListener)
      target.removeEventListener('dragover', handleDragOver as EventListener)
      target.removeEventListener('drop', handleDrop as EventListener)
    }
  }, [handleDragEnter, handleDragLeave, handleDragOver, handleDrop, containerRef])

  return { isDragging }
}

import { useCallback, useEffect, useRef, useState } from 'react'

interface UseDropZoneProps {
  onDrop: (files: FileList) => void
}

export function useDropZone({ onDrop }: UseDropZoneProps) {
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
    window.addEventListener('dragenter', handleDragEnter)
    window.addEventListener('dragleave', handleDragLeave)
    window.addEventListener('dragover', handleDragOver)
    window.addEventListener('drop', handleDrop)

    return () => {
      window.removeEventListener('dragenter', handleDragEnter)
      window.removeEventListener('dragleave', handleDragLeave)
      window.removeEventListener('dragover', handleDragOver)
      window.removeEventListener('drop', handleDrop)
    }
  }, [handleDragEnter, handleDragLeave, handleDragOver, handleDrop])

  return { isDragging }
}

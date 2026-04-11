import { useCallback, useRef, useState } from 'react'
import { toast } from '@/lib/toast'

const MAX_IMAGE_SIZE = 10 * 1024 * 1024 // 10MB
const IMAGE_MIME_PREFIXES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg']

interface ImageAttachment {
  type: 'image'
  url: string
  label: string
}

function isImageMime(mime: string): boolean {
  return IMAGE_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix))
}

function extensionFromMime(mime: string): string {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg'
  }
  return map[mime] ?? 'png'
}

interface UseImagePasteOptions {
  maxAttachments: number
  currentCount: number
  onAttach: (attachment: ImageAttachment) => void
}

export function useImagePaste({ maxAttachments, currentCount, onAttach }: UseImagePasteOptions) {
  const [isDragOver, setIsDragOver] = useState(false)
  const dragCountRef = useRef(0)

  const saveAndAttach = useCallback(
    async (file: File) => {
      if (currentCount >= maxAttachments) {
        toast.error(`Maximum ${maxAttachments} attachments allowed`)
        return
      }
      if (file.size > MAX_IMAGE_SIZE) {
        toast.error('Image too large (max 10MB)')
        return
      }
      if (!isImageMime(file.type)) {
        return // Silently ignore non-images
      }

      try {
        const arrayBuffer = await file.arrayBuffer()
        const name = file.name || `pasted-image.${extensionFromMime(file.type)}`
        const result = await window.attachmentOps.saveImage(arrayBuffer, name)

        if (!result.success || !result.filePath) {
          toast.error(result.error ?? 'Failed to save image')
          return
        }

        onAttach({ type: 'image', url: result.filePath, label: name })
      } catch {
        toast.error('Failed to save image')
      }
    },
    [currentCount, maxAttachments, onAttach]
  )

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return

      for (const item of Array.from(items)) {
        if (isImageMime(item.type)) {
          e.preventDefault()
          const file = item.getAsFile()
          if (file) saveAndAttach(file)
          return // Only handle the first image
        }
      }
      // No image found — let the paste propagate (text paste)
    },
    [saveAndAttach]
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCountRef.current++
    if (dragCountRef.current === 1) setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCountRef.current--
    if (dragCountRef.current === 0) setIsDragOver(false)
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCountRef.current = 0
      setIsDragOver(false)

      const files = e.dataTransfer?.files
      if (!files) return

      // Filter to images and cap at remaining slots to avoid exceeding the limit
      const imageFiles = Array.from(files).filter((f) => isImageMime(f.type))
      const remaining = maxAttachments - currentCount
      for (const file of imageFiles.slice(0, remaining)) {
        saveAndAttach(file)
      }
      if (imageFiles.length > remaining) {
        toast.error(`Maximum ${maxAttachments} attachments allowed`)
      }
    },
    [saveAndAttach, maxAttachments, currentCount]
  )

  return {
    isDragOver,
    handlePaste,
    handleDragOver,
    handleDragEnter,
    handleDragLeave,
    handleDrop
  }
}

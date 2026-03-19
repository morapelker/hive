import { useState, useEffect, useCallback, useRef } from 'react'
import { Loader2 } from 'lucide-react'
import { CodeMirrorEditor } from './CodeMirrorEditor'
import { ImagePreview } from './ImagePreview'
import { UnsavedChangesDialog } from './UnsavedChangesDialog'
import { ExternalChangesBanner } from './ExternalChangesBanner'
import { MarkdownRenderer } from '@/components/sessions/MarkdownRenderer'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { useFileViewerStore } from '@/stores/useFileViewerStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useGitStore } from '@/stores/useGitStore'
import { isBinaryImageFile, isSvgFile, getImageMimeType } from '@shared/types/file-utils'

// Time window after a save during which file watcher events are suppressed
// to avoid treating our own writes as external changes.
const OWN_SAVE_SUPPRESSION_MS = 500

export function isMarkdownFile(filePath: string): boolean {
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase()
  return ext === '.md' || ext === '.mdx'
}

interface FileViewerProps {
  filePath: string
}

export function FileViewer({ filePath }: FileViewerProps): React.JSX.Element {
  const [content, setContent] = useState<string | null>(null)
  const [imageDataUri, setImageDataUri] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const isMarkdown = isMarkdownFile(filePath)
  const isBinaryImage = isBinaryImageFile(filePath)
  const isSvg = isSvgFile(filePath)
  const [viewMode, setViewMode] = useState<'preview' | 'source'>(
    isMarkdown || isSvg ? 'preview' : 'source'
  )

  // Load file content
  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    setError(null)
    setContent(null)
    setImageDataUri(null)

    if (isBinaryImage) {
      const mimeType = getImageMimeType(filePath) || 'image/png'
      window.fileOps.readImageAsBase64(filePath).then((result) => {
        if (cancelled) return
        if (result.success && result.data) {
          setImageDataUri(`data:${mimeType};base64,${result.data}`)
        } else {
          setError(result.error || 'Failed to read image')
        }
        setIsLoading(false)
      })
    } else {
      window.fileOps.readFile(filePath).then((result) => {
        if (cancelled) return
        if (result.success && result.content !== undefined) {
          setContent(result.content)
          useFileViewerStore.getState().setOriginalContent(filePath, result.content)
          if (isSvg) {
            setImageDataUri(
              `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(result.content)))}`
            )
          }
        } else {
          setError(result.error || 'Failed to read file')
        }
        setIsLoading(false)
      })
    }

    return () => {
      cancelled = true
    }
  }, [filePath, isBinaryImage, isSvg])

  const [reloadKey, setReloadKey] = useState(0)
  const lastSaveTimestampRef = useRef<number>(0)

  const isExternallyChanged = useFileViewerStore((s) => s.externallyChanged.has(filePath))
  const markExternallyChanged = useFileViewerStore((s) => s.markExternallyChanged)
  const clearExternallyChanged = useFileViewerStore((s) => s.clearExternallyChanged)

  const pendingClose = useFileViewerStore((s) => s.pendingClose)
  const latestContentRef = useRef<string | null>(null)

  const handleSave = useCallback(
    async (newContent: string) => {
      lastSaveTimestampRef.current = Date.now()
      const result = await window.fileOps.writeFile(filePath, newContent)
      if (result.success) {
        toast.success('File saved')
        const store = useFileViewerStore.getState()
        store.markClean(filePath)
        store.setOriginalContent(filePath, newContent)
        const tab = store.openFiles.get(filePath)
        if (tab && tab.type === 'file') {
          const worktree = useWorktreeStore
            .getState()
            .worktrees.find((w) => w.id === tab.worktreeId)
          if (worktree?.path) {
            useGitStore.getState().refreshStatuses(worktree.path)
          }
        }
      } else {
        toast.error('Failed to save: ' + result.error)
      }
    },
    [filePath]
  )

  const handleContentChange = useCallback(
    (newContent: string) => {
      latestContentRef.current = newContent
      const original = useFileViewerStore.getState().getOriginalContent(filePath)
      if (original !== undefined && newContent !== original) {
        useFileViewerStore.getState().markDirty(filePath)
      } else {
        useFileViewerStore.getState().markClean(filePath)
      }
    },
    [filePath]
  )

  const handleDialogSave = useCallback(async () => {
    if (pendingClose && latestContentRef.current !== null) {
      lastSaveTimestampRef.current = Date.now()
      const result = await window.fileOps.writeFile(pendingClose, latestContentRef.current)
      if (result.success) {
        toast.success('File saved')
        const tab = useFileViewerStore.getState().openFiles.get(pendingClose)
        if (tab && tab.type === 'file') {
          const worktree = useWorktreeStore
            .getState()
            .worktrees.find((w) => w.id === tab.worktreeId)
          if (worktree?.path) {
            useGitStore.getState().refreshStatuses(worktree.path)
          }
        }
      } else {
        toast.error('Failed to save: ' + result.error)
        return
      }
      useFileViewerStore.getState().confirmCloseFile(pendingClose)
    }
  }, [pendingClose])

  const handleDialogDontSave = useCallback(() => {
    if (pendingClose) {
      useFileViewerStore.getState().confirmCloseFile(pendingClose)
    }
  }, [pendingClose])

  const handleDialogCancel = useCallback(() => {
    useFileViewerStore.getState().cancelCloseFile()
  }, [])

  // Subscribe to file watcher for external change detection and deletion
  useEffect(() => {
    const unsubscribe = window.fileTreeOps.onChange((event) => {
      // Check if the current file was deleted
      const wasDeleted = event.events.some(
        (e) => e.changedPath === filePath && e.eventType === 'unlink'
      )
      if (wasDeleted) {
        setError('File was deleted from disk')
        setContent(null)
        setImageDataUri(null)
        return
      }

      const hasChange = event.events.some(
        (e) => e.changedPath === filePath && e.eventType === 'change'
      )
      if (!hasChange) return
      // Suppress if this was our own save
      if (Date.now() - lastSaveTimestampRef.current < OWN_SAVE_SUPPRESSION_MS) return
      // Re-read from disk and compare with original
      window.fileOps.readFile(filePath).then((result) => {
        if (!result.success || result.content === undefined) return
        const original = useFileViewerStore.getState().getOriginalContent(filePath)
        if (original !== undefined && result.content !== original) {
          markExternallyChanged(filePath)
        }
      })
    })
    return () => {
      unsubscribe()
    }
  }, [filePath, markExternallyChanged])

  const handleReload = useCallback(async () => {
    const result = await window.fileOps.readFile(filePath)
    if (result.success && result.content !== undefined) {
      setContent(result.content)
      const store = useFileViewerStore.getState()
      store.setOriginalContent(filePath, result.content)
      store.markClean(filePath)
      clearExternallyChanged(filePath)
      setReloadKey((k) => k + 1)
    }
  }, [filePath, clearExternallyChanged])

  const handleKeepMine = useCallback(async () => {
    clearExternallyChanged(filePath)
    // Update originalContents to disk content so future changes are detected correctly
    const result = await window.fileOps.readFile(filePath)
    if (result.success && result.content !== undefined) {
      useFileViewerStore.getState().setOriginalContent(filePath, result.content)
    }
  }, [filePath, clearExternallyChanged])

  // Reset view mode when file changes
  useEffect(() => {
    if (isMarkdownFile(filePath) || isSvgFile(filePath)) {
      setViewMode('preview')
    } else {
      setViewMode('source')
    }
  }, [filePath])

  // Regenerate SVG data URI from edited content when switching to preview
  useEffect(() => {
    if (isSvg && viewMode === 'preview') {
      const svgContent = latestContentRef.current ?? content
      if (svgContent) {
        setImageDataUri(
          `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svgContent)))}`
        )
      }
    }
  }, [viewMode, isSvg, content])

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center" data-testid="file-viewer-loading">
        <div className="text-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground mx-auto" />
          <p className="text-sm text-muted-foreground mt-2">Loading file...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center" data-testid="file-viewer-error">
        <div className="text-center text-destructive">
          <p className="text-sm font-medium">Error loading file</p>
          <p className="text-xs mt-1 opacity-75">{error}</p>
        </div>
      </div>
    )
  }

  if (content === null && !imageDataUri) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-muted-foreground">No content</p>
      </div>
    )
  }

  const fileName = filePath.substring(filePath.lastIndexOf('/') + 1)

  return (
    <div className="flex-1 flex flex-col min-h-0" data-testid="file-viewer">
      {/* File path bar */}
      <div className="px-3 py-1.5 text-xs text-muted-foreground border-b border-border bg-muted/30 flex items-center justify-between">
        <span className="truncate">{filePath}</span>
        {(isMarkdown || isSvg) && (
          <div className="flex items-center gap-1 shrink-0 ml-2">
            <button
              onClick={() => setViewMode('source')}
              className={cn(
                'px-2 py-0.5 rounded text-xs transition-colors',
                viewMode === 'source' ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
              )}
              data-testid="source-toggle"
            >
              Source
            </button>
            <button
              onClick={() => setViewMode('preview')}
              className={cn(
                'px-2 py-0.5 rounded text-xs transition-colors',
                viewMode === 'preview' ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
              )}
              data-testid="preview-toggle"
            >
              Preview
            </button>
          </div>
        )}
      </div>

      {/* External changes banner */}
      {isExternallyChanged && (
        <ExternalChangesBanner onReload={handleReload} onKeepMine={handleKeepMine} />
      )}

      {/* Content area */}
      {isBinaryImage && imageDataUri ? (
        <div className="flex-1 overflow-auto" data-testid="file-viewer-image">
          <ImagePreview src={imageDataUri} fileName={fileName} />
        </div>
      ) : isSvg && viewMode === 'preview' && imageDataUri ? (
        <div className="flex-1 overflow-auto" data-testid="file-viewer-image">
          <ImagePreview src={imageDataUri} fileName={fileName} />
        </div>
      ) : viewMode === 'preview' && isMarkdown ? (
        <div
          className="flex-1 overflow-auto p-6 prose prose-sm dark:prose-invert max-w-none"
          data-testid="file-viewer-markdown-preview"
        >
          <MarkdownRenderer content={latestContentRef.current ?? content!} />
        </div>
      ) : (
        <CodeMirrorEditor
          key={`${filePath}-${reloadKey}`}
          content={content!}
          filePath={filePath}
          onContentChange={handleContentChange}
          onSave={handleSave}
        />
      )}

      {pendingClose && (
        <UnsavedChangesDialog
          open={!!pendingClose}
          fileName={pendingClose.substring(pendingClose.lastIndexOf('/') + 1)}
          onSave={handleDialogSave}
          onDontSave={handleDialogDontSave}
          onCancel={handleDialogCancel}
        />
      )}
    </div>
  )
}

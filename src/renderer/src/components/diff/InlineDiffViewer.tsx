import { useState, useEffect, useCallback, useRef } from 'react'
import {
  ChevronUp,
  ChevronDown,
  Columns2,
  AlignJustify,
  Copy,
  X,
  Loader2,
  ChevronsUpDown
} from 'lucide-react'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { DiffViewer, type DiffViewMode } from './DiffViewer'
import { cn } from '@/lib/utils'

interface InlineDiffViewerProps {
  worktreePath: string
  filePath: string
  fileName: string
  staged: boolean
  isUntracked: boolean
  onClose: () => void
}

export function InlineDiffViewer({
  worktreePath,
  filePath,
  fileName,
  staged,
  isUntracked,
  onClose
}: InlineDiffViewerProps): React.JSX.Element {
  const [diff, setDiff] = useState<string>('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<DiffViewMode>('unified')
  const [contextLines, setContextLines] = useState(3)
  const [currentHunkIndex, setCurrentHunkIndex] = useState(-1)
  const contentRef = useRef<HTMLDivElement>(null)

  // Fetch diff
  const fetchDiff = useCallback(
    async (ctx: number) => {
      setIsLoading(true)
      setError(null)
      try {
        const result = await window.gitOps.getDiff(worktreePath, filePath, staged, isUntracked, ctx)
        if (result.success && result.diff) {
          setDiff(result.diff)
        } else {
          setError(result.error || 'Failed to load diff')
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load diff')
      } finally {
        setIsLoading(false)
      }
    },
    [worktreePath, filePath, staged, isUntracked]
  )

  // Load on mount and when contextLines changes
  useEffect(() => {
    fetchDiff(contextLines)
  }, [fetchDiff, contextLines])

  // Get hunk elements
  const getHunkElements = useCallback((): Element[] => {
    if (!contentRef.current) return []
    return Array.from(
      contentRef.current.querySelectorAll('.d2h-info, .d2h-code-linenumber.d2h-info')
    )
  }, [])

  // Navigate to next hunk
  const goToNextHunk = useCallback(() => {
    const hunks = getHunkElements()
    if (hunks.length === 0) return
    const nextIndex = currentHunkIndex + 1 < hunks.length ? currentHunkIndex + 1 : 0
    setCurrentHunkIndex(nextIndex)
    hunks[nextIndex].scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [getHunkElements, currentHunkIndex])

  // Navigate to previous hunk
  const goToPrevHunk = useCallback(() => {
    const hunks = getHunkElements()
    if (hunks.length === 0) return
    const prevIndex = currentHunkIndex - 1 >= 0 ? currentHunkIndex - 1 : hunks.length - 1
    setCurrentHunkIndex(prevIndex)
    hunks[prevIndex].scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [getHunkElements, currentHunkIndex])

  // Expand context
  const handleExpandContext = useCallback(() => {
    setContextLines((prev) => prev + 10)
  }, [])

  // Copy diff to clipboard
  const handleCopyDiff = useCallback(async () => {
    if (diff) {
      await window.projectOps.copyToClipboard(diff)
      toast.success('Diff copied to clipboard')
    }
  }, [diff])

  // Toggle view mode
  const toggleViewMode = useCallback(() => {
    setViewMode((prev) => (prev === 'unified' ? 'split' : 'unified'))
  }, [])

  // Keyboard shortcuts for hunk navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.altKey && e.key === 'ArrowDown') {
        e.preventDefault()
        goToNextHunk()
      } else if (e.altKey && e.key === 'ArrowUp') {
        e.preventDefault()
        goToPrevHunk()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [goToNextHunk, goToPrevHunk, onClose])

  const statusLabel = staged ? 'Staged' : isUntracked ? 'New file' : 'Unstaged'

  return (
    <div className="flex-1 flex flex-col min-h-0" data-testid="inline-diff-viewer">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b bg-muted/30 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium truncate" data-testid="inline-diff-filename">
            {fileName}
          </span>
          <span className="text-xs text-muted-foreground shrink-0">{statusLabel}</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {/* Hunk navigation */}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={goToPrevHunk}
            title="Previous hunk (Alt+Up)"
            data-testid="diff-prev-hunk"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={goToNextHunk}
            title="Next hunk (Alt+Down)"
            data-testid="diff-next-hunk"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>

          <div className="w-px h-4 bg-border mx-1" />

          {/* Context expansion */}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={handleExpandContext}
            title="Show more context"
            data-testid="diff-expand-context"
          >
            <ChevronsUpDown className="h-3.5 w-3.5 mr-1" />
            More context
          </Button>

          <div className="w-px h-4 bg-border mx-1" />

          {/* View mode toggle */}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={toggleViewMode}
            title={viewMode === 'unified' ? 'Switch to split view' : 'Switch to unified view'}
            data-testid="diff-view-toggle"
          >
            {viewMode === 'unified' ? (
              <Columns2 className="h-3.5 w-3.5" />
            ) : (
              <AlignJustify className="h-3.5 w-3.5" />
            )}
          </Button>

          {/* Copy */}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={handleCopyDiff}
            disabled={!diff}
            title="Copy diff to clipboard"
            data-testid="diff-copy-button"
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>

          <div className="w-px h-4 bg-border mx-1" />

          {/* Close */}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={onClose}
            title="Close diff (Esc)"
            data-testid="diff-close-button"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Diff content */}
      <div ref={contentRef} className="flex-1 overflow-auto min-h-0">
        {isLoading && (
          <div className="flex items-center justify-center h-full" data-testid="diff-loading">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        )}

        {error && (
          <div
            className="flex items-center justify-center h-full text-destructive"
            data-testid="diff-error"
          >
            {error}
          </div>
        )}

        {!isLoading && !error && (
          <DiffViewer
            diff={diff}
            viewMode={viewMode}
            className={cn('h-full', viewMode === 'split' && 'min-w-[800px]')}
          />
        )}
      </div>
    </div>
  )
}

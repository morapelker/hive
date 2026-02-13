import { useState, useCallback, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { DiffViewer, type DiffViewMode } from './DiffViewer'
import { Columns2, AlignJustify, Copy, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface DiffModalProps {
  isOpen: boolean
  onClose: () => void
  worktreePath: string
  filePath: string
  fileName: string
  staged: boolean
  isUntracked: boolean
}

export function DiffModal({
  isOpen,
  onClose,
  worktreePath,
  filePath,
  fileName,
  staged,
  isUntracked
}: DiffModalProps): React.JSX.Element {
  const [diff, setDiff] = useState<string>('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<DiffViewMode>('unified')

  // Load diff when modal opens
  useEffect(() => {
    if (!isOpen) {
      return
    }

    const loadDiff = async (): Promise<void> => {
      setIsLoading(true)
      setError(null)
      setDiff('')

      try {
        const result = await window.gitOps.getDiff(worktreePath, filePath, staged, isUntracked)

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
    }

    loadDiff()
  }, [isOpen, worktreePath, filePath, staged, isUntracked])

  // Copy diff content to clipboard
  const handleCopyDiff = useCallback(async () => {
    if (diff) {
      await window.projectOps.copyToClipboard(diff)
    }
  }, [diff])

  // Toggle view mode
  const toggleViewMode = useCallback(() => {
    setViewMode((prev) => (prev === 'unified' ? 'split' : 'unified'))
  }, [])

  const statusLabel = staged ? 'Staged changes' : isUntracked ? 'New file' : 'Unstaged changes'

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-w-[90vw] max-h-[90vh] w-full h-[85vh] flex flex-col"
        data-testid="diff-modal"
      >
        <DialogHeader className="flex-shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex-1 min-w-0 mr-4">
              <DialogTitle className="truncate" data-testid="diff-modal-title">
                {fileName}
              </DialogTitle>
              <DialogDescription data-testid="diff-modal-description">
                {statusLabel}
              </DialogDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={toggleViewMode}
                title={viewMode === 'unified' ? 'Switch to split view' : 'Switch to unified view'}
                data-testid="diff-view-toggle"
              >
                {viewMode === 'unified' ? (
                  <>
                    <Columns2 className="h-4 w-4 mr-1" />
                    Split
                  </>
                ) : (
                  <>
                    <AlignJustify className="h-4 w-4 mr-1" />
                    Unified
                  </>
                )}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleCopyDiff}
                disabled={!diff}
                title="Copy diff to clipboard"
                data-testid="diff-copy-button"
              >
                <Copy className="h-4 w-4 mr-1" />
                Copy
              </Button>
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-hidden border rounded-md">
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
      </DialogContent>
    </Dialog>
  )
}

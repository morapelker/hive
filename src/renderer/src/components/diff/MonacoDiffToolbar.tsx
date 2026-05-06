import { useCallback } from 'react'
import { ChevronUp, ChevronDown, Columns2, AlignJustify, Copy, Rows3, X } from 'lucide-react'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import type { DiffViewMode } from '@/stores/useDiffPrefsStore'

interface MonacoDiffToolbarProps {
  fileName: string
  staged: boolean
  isUntracked: boolean
  compareBranch?: string
  viewMode: DiffViewMode
  onSetViewMode: (viewMode: DiffViewMode) => void
  splitDisabled?: boolean
  onPrevHunk: () => void
  onNextHunk: () => void
  onCopy: () => void
  onClose: () => void
}

export function MonacoDiffToolbar({
  fileName,
  staged,
  isUntracked,
  compareBranch,
  viewMode,
  onSetViewMode,
  splitDisabled = false,
  onPrevHunk,
  onNextHunk,
  onCopy,
  onClose
}: MonacoDiffToolbarProps): React.JSX.Element {
  const statusLabel = compareBranch
    ? `vs ${compareBranch}`
    : staged
      ? 'Staged'
      : isUntracked
        ? 'New file'
        : 'Unstaged'

  const handleCopy = useCallback(async () => {
    onCopy()
    toast.success('Diff content copied to clipboard')
  }, [onCopy])

  return (
    <div className="flex items-center justify-between px-3 py-1.5 border-b bg-muted/30 shrink-0">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-sm font-medium truncate" data-testid="monaco-diff-filename">
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
          onClick={onPrevHunk}
          title="Previous change (Alt+Up)"
          data-testid="monaco-diff-prev-hunk"
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={onNextHunk}
          title="Next change (Alt+Down)"
          data-testid="monaco-diff-next-hunk"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </Button>

        <div className="w-px h-4 bg-border mx-1" />

        {/* View mode segmented control */}
        <div
          className="flex items-center rounded-sm bg-muted p-0.5"
          data-testid="monaco-diff-view-mode"
        >
          <Button
            variant={viewMode === 'split' ? 'secondary' : 'ghost'}
            size="icon"
            className="h-6 w-6"
            onClick={() => onSetViewMode('split')}
            disabled={splitDisabled}
            title={splitDisabled ? 'Split view is unavailable in PR review' : 'Split view'}
            data-testid="monaco-diff-view-split"
          >
            <Columns2 className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant={viewMode === 'inline' ? 'secondary' : 'ghost'}
            size="icon"
            className="h-6 w-6"
            onClick={() => onSetViewMode('inline')}
            title="Inline view"
            data-testid="monaco-diff-view-inline"
          >
            <AlignJustify className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant={viewMode === 'hunk' ? 'secondary' : 'ghost'}
            size="icon"
            className="h-6 w-6"
            onClick={() => onSetViewMode('hunk')}
            title="Hunk view"
            data-testid="monaco-diff-view-hunk"
          >
            <Rows3 className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* Copy */}
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={handleCopy}
          title="Copy diff to clipboard"
          data-testid="monaco-diff-copy-button"
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
          data-testid="monaco-diff-close-button"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}

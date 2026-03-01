import { useCallback } from 'react'
import {
  ChevronUp,
  ChevronDown,
  Columns2,
  AlignJustify,
  Copy,
  X
} from 'lucide-react'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'

interface MonacoDiffToolbarProps {
  fileName: string
  staged: boolean
  isUntracked: boolean
  compareBranch?: string
  sideBySide: boolean
  onToggleSideBySide: () => void
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
  sideBySide,
  onToggleSideBySide,
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

        {/* View mode toggle */}
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={onToggleSideBySide}
          title={sideBySide ? 'Switch to inline view' : 'Switch to side-by-side view'}
          data-testid="monaco-diff-view-toggle"
        >
          {sideBySide ? (
            <AlignJustify className="h-3.5 w-3.5" />
          ) : (
            <Columns2 className="h-3.5 w-3.5" />
          )}
        </Button>

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

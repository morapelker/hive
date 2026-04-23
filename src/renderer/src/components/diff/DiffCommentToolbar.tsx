import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import {
  MessageSquare,
  ChevronUp,
  ChevronDown,
  Paperclip,
  Trash2,
  PanelRightOpen,
  PanelRightClose
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { useDiffCommentStore, jumpTo } from '@/stores/useDiffCommentStore'
import { toast } from '@/lib/toast'

const EMPTY_COMMENTS: DiffComment[] = []

interface DiffCommentToolbarProps {
  worktreeId: string
  onToggleSidePanel?: () => void
  sidePanelOpen?: boolean
}

export function DiffCommentToolbar({
  worktreeId,
  onToggleSidePanel,
  sidePanelOpen
}: DiffCommentToolbarProps): React.JSX.Element | null {
  // ---------------------------------------------------------------------------
  // Store subscriptions — stable-reference pattern (see DiffCommentGutter)
  // ---------------------------------------------------------------------------

  const allComments = useDiffCommentStore(
    (s) => worktreeId ? s.comments.get(worktreeId) : undefined
  ) ?? EMPTY_COMMENTS

  const attachedCommentIds = useDiffCommentStore((s) => s.attachedCommentIds)
  const { clearAll, attachAllToChat } = useDiffCommentStore()

  // ---------------------------------------------------------------------------
  // Sorted flat list
  // ---------------------------------------------------------------------------

  const sortedComments = useMemo(() => {
    return [...allComments].sort((a, b) => {
      const fileCmp = a.file_path.localeCompare(b.file_path)
      if (fileCmp !== 0) return fileCmp
      return a.line_start - b.line_start
    })
  }, [allComments])

  // ---------------------------------------------------------------------------
  // Navigation state
  // ---------------------------------------------------------------------------

  const currentIndexRef = useRef<number>(-1)

  // Reset navigation index on worktreeId change
  useEffect(() => {
    currentIndexRef.current = -1
  }, [worktreeId])

  const handleNext = useCallback(() => {
    if (sortedComments.length === 0) return
    // Clamp if list shrank
    if (currentIndexRef.current >= sortedComments.length) {
      currentIndexRef.current = sortedComments.length - 1
    }
    currentIndexRef.current = (currentIndexRef.current + 1) % sortedComments.length
    jumpTo(sortedComments[currentIndexRef.current].id)
  }, [sortedComments])

  const handlePrev = useCallback(() => {
    if (sortedComments.length === 0) return
    // Clamp if list shrank
    if (currentIndexRef.current >= sortedComments.length) {
      currentIndexRef.current = sortedComments.length - 1
    }
    currentIndexRef.current = currentIndexRef.current <= 0
      ? sortedComments.length - 1
      : currentIndexRef.current - 1
    jumpTo(sortedComments[currentIndexRef.current].id)
  }, [sortedComments])

  // ---------------------------------------------------------------------------
  // Attach-all logic
  // ---------------------------------------------------------------------------

  const nonOutdated = useMemo(() => sortedComments.filter((c) => !c.is_outdated), [sortedComments])
  const allAttached = nonOutdated.length > 0 &&
    nonOutdated.every((c) => attachedCommentIds.has(c.id))

  const handleAttachAll = useCallback(() => {
    if (nonOutdated.length > 20) {
      toast.warning('Attaching more than 20 comments may use significant context')
    }
    attachAllToChat(worktreeId)
  }, [nonOutdated.length, attachAllToChat, worktreeId])

  // ---------------------------------------------------------------------------
  // Clear-all with AlertDialog
  // ---------------------------------------------------------------------------

  const [clearDialogOpen, setClearDialogOpen] = useState(false)

  const handleClearConfirm = useCallback(() => {
    clearAll(worktreeId)
    currentIndexRef.current = -1
    setClearDialogOpen(false)
  }, [clearAll, worktreeId])

  // ---------------------------------------------------------------------------
  // Early return — toolbar only visible when comments exist
  // ---------------------------------------------------------------------------

  if (sortedComments.length === 0) return null

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const PanelIcon = sidePanelOpen ? PanelRightClose : PanelRightOpen

  return (
    <div className="absolute bottom-3 right-3 z-10 flex items-center gap-1 px-2 py-1 bg-background/95 backdrop-blur-sm border border-border rounded-lg shadow-sm">
      {/* Comment count */}
      <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="text-xs text-muted-foreground tabular-nums">
        {sortedComments.length}
      </span>

      {/* Divider */}
      <div className="w-px h-4 bg-border mx-1" />

      {/* Navigation */}
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        onClick={handlePrev}
        title="Previous comment"
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        onClick={handleNext}
        title="Next comment"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </Button>

      {/* Divider */}
      <div className="w-px h-4 bg-border mx-1" />

      {/* Attach all */}
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        disabled={allAttached}
        onClick={handleAttachAll}
        title="Attach all to chat"
      >
        <Paperclip className="h-3.5 w-3.5" />
      </Button>

      {/* Clear all */}
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        onClick={() => setClearDialogOpen(true)}
        title="Clear all comments"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>

      {/* Side-panel toggle (conditional) */}
      {onToggleSidePanel && (
        <>
          <div className="w-px h-4 bg-border mx-1" />
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={onToggleSidePanel}
            title={sidePanelOpen ? 'Close side panel' : 'Open side panel'}
          >
            <PanelIcon className="h-3.5 w-3.5" />
          </Button>
        </>
      )}

      {/* Clear-all confirmation dialog */}
      <AlertDialog open={clearDialogOpen} onOpenChange={(isOpen) => !isOpen && setClearDialogOpen(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear all comments?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete {sortedComments.length} comment(s) across all files.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setClearDialogOpen(false)}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleClearConfirm}>
              Clear all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

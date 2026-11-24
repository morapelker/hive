import { useEffect, useMemo } from 'react'
import { PinOff } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useKanbanStore } from '@/stores/useKanbanStore'
import {
  dismissUnpinOnDone,
  settledUnpinScope,
  unpinIdleProject,
  useUnpinOffer,
  useUnpinOnDoneStore,
  watchDoneMovesForUnpin
} from '@/lib/auto-unpin'

/**
 * Auto-unpin for a move to Done that never shows the archive step of MergeOnDoneDialog (the
 * ticket ran on the base branch, its worktree is archived already, "Move to Done anyway"...):
 * once the ticket is in Done and nothing else of its pinned project is being worked on, this
 * asks the question "Archive & Unpin" asks there. Mounted next to MergeOnDoneDialog, and
 * shown after it when another move opens that one meanwhile.
 *
 * The question follows the board: a ticket that is opened or moved back out of Done, or a
 * project that leaves the pinned board some other way, closes it.
 */
export function UnpinOnDoneDialog(): React.JSX.Element {
  const offer = useUnpinOnDoneStore((s) => s.offer)
  const mergeDialogOpen = useKanbanStore((s) => s.pendingDoneMove !== null)
  const scope = useMemo(() => (offer ? settledUnpinScope(offer.projectId) : null), [offer])
  const project = useUnpinOffer(scope)

  useEffect(() => watchDoneMovesForUnpin(), [])

  // The project stopped qualifying while the question was up: nothing left to ask
  useEffect(() => {
    if (offer && !project) dismissUnpinOnDone()
  }, [offer, project])

  return (
    <Dialog
      open={!!offer && !!project && !mergeDialogOpen}
      onOpenChange={(open) => {
        if (!open) dismissUnpinOnDone()
      }}
    >
      <DialogContent className="max-w-md" data-testid="unpin-on-done-dialog">
        {offer && project && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-sm">
                <PinOff className="h-4 w-4" />
                Unpin project?
              </DialogTitle>
              <DialogDescription className="break-words text-xs">
                <span className="font-medium text-foreground">{offer.ticketTitle}</span> is in
                Done, and no other ticket of{' '}
                <span className="font-medium text-foreground">{project.name}</span> is being
                worked on. Take the project off the pinned board?
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center justify-between gap-2">
              <Button variant="outline" size="sm" onClick={dismissUnpinOnDone}>
                Keep pinned
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  dismissUnpinOnDone()
                  void unpinIdleProject(project)
                }}
              >
                <PinOff className="h-3 w-3 mr-1" />
                Unpin
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

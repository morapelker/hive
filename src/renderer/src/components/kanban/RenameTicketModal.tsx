import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pencil } from 'lucide-react'
import type { KanbanTicket } from '../../../../main/db/types'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { toast } from '@/lib/toast'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { isComposingKeyboardEvent } from '@/lib/message-composer-shortcuts'

/**
 * Board-level host for the Rename dialog, driven by the store's renameTicketRef (the card's
 * menu item sets it). Mounted once per board, beside KanbanTicketModal, rather than inside
 * the card: a board search filters cards by their current title, and the optimistic update
 * would unmount a card-owned dialog mid-save, losing the draft if persistence then failed.
 */
export function RenameTicketDialog() {
  const renameTicketRef = useKanbanStore((s) => s.renameTicketRef)
  const setRenameTicketRef = useKanbanStore((s) => s.setRenameTicketRef)
  const tickets = useKanbanStore((s) => s.tickets)

  // Ticket ids are project-local in markdown mode, so the lookup is project-scoped
  const ticket = useMemo<KanbanTicket | null>(() => {
    if (!renameTicketRef) return null
    return (
      tickets.get(renameTicketRef.projectId)?.find((t) => t.id === renameTicketRef.ticketId) ?? null
    )
  }, [renameTicketRef, tickets])

  const close = useCallback(
    (open: boolean) => {
      if (!open) setRenameTicketRef(null)
    },
    [setRenameTicketRef]
  )

  // Only the title travels: the branch, worktree and session are untouched
  const handleSave = useCallback(
    async (title: string) => {
      if (!ticket) return
      try {
        await useKanbanStore.getState().updateTicket(ticket.id, ticket.project_id, { title })
        toast.success('Ticket renamed')
      } catch (err) {
        toast.error(`Failed to rename ticket: ${err instanceof Error ? err.message : String(err)}`)
        throw err
      }
    },
    [ticket]
  )

  if (!ticket) return null

  return (
    <RenameTicketModal open onOpenChange={close} currentTitle={ticket.title} onSave={handleSave} />
  )
}

interface RenameTicketModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The ticket's current title, shown as the starting value. */
  currentTitle: string
  /**
   * Receives the trimmed new title. Only the title changes: the ticket keeps its
   * branch, worktree and session, so renaming is safe in any column.
   */
  onSave: (title: string) => Promise<void> | void
}

/**
 * Renames a ticket from the board without opening its full editor. In-progress and
 * review tickets open on their session or review pane, which has no title field; this
 * dialog is the one place every ticket can be renamed from.
 */
export function RenameTicketModal({
  open,
  onOpenChange,
  currentTitle,
  onSave
}: RenameTicketModalProps) {
  const [value, setValue] = useState(currentTitle)
  const [saving, setSaving] = useState(false)

  // Seed the draft only when the dialog opens. The store's optimistic update changes
  // currentTitle mid-save and reverts it on failure; following those changes would wipe
  // the user's draft right when they need it to retry.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) setValue(currentTitle)
    wasOpen.current = open
  }, [open, currentTitle])

  const trimmed = value.trim()
  const canSave = trimmed.length > 0 && trimmed !== currentTitle.trim() && !saving

  const handleSave = useCallback(async () => {
    if (!canSave) return
    setSaving(true)
    try {
      await onSave(trimmed)
      onOpenChange(false)
    } catch {
      // The caller reports the failure; the dialog stays open with the draft so it can be retried
    } finally {
      setSaving(false)
    }
  }, [canSave, trimmed, onSave, onOpenChange])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    // Enter that confirms an IME candidate (Japanese, Chinese…) must not submit the rename
    if (isComposingKeyboardEvent(e.nativeEvent)) return
    if (e.key === 'Enter') {
      e.preventDefault()
      void handleSave()
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="rename-ticket-modal">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Pencil className="h-4 w-4" />
            Rename ticket
          </DialogTitle>
          <DialogDescription className="text-xs">
            Changes only the name on the board. The branch, worktree and session stay as they are.
          </DialogDescription>
        </DialogHeader>

        <div className="py-2">
          <Input
            autoFocus
            data-testid="rename-ticket-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={(e) => e.currentTarget.select()}
            placeholder="Ticket name"
            disabled={saving}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            size="sm"
            data-testid="rename-ticket-save"
            onClick={() => void handleSave()}
            disabled={!canSave}
          >
            {saving ? 'Renaming...' : 'Rename'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

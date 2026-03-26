import { useState, useCallback, useRef, Fragment } from 'react'
import { ChevronRight, ChevronDown, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { KanbanTicketCard } from '@/components/kanban/KanbanTicketCard'
import { TicketCreateModal } from '@/components/kanban/TicketCreateModal'
import { WorktreePickerModal } from '@/components/kanban/WorktreePickerModal'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel
} from '@/components/ui/alert-dialog'
import { useKanbanStore, getKanbanDragData, setKanbanDragData } from '@/stores/useKanbanStore'
import type { KanbanTicket, KanbanTicketColumn as ColumnType } from '../../../../main/db/types'

// ── Column display names ────────────────────────────────────────────
const COLUMN_TITLES: Record<ColumnType, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done'
}

interface KanbanColumnProps {
  column: ColumnType
  tickets: KanbanTicket[]
  projectId: string
}

export function KanbanColumn({ column, tickets, projectId }: KanbanColumnProps) {
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const dropIndexRef = useRef<number | null>(null)
  const [worktreePickerTicket, setWorktreePickerTicket] = useState<KanbanTicket | null>(null)
  const [pendingBackwardDrag, setPendingBackwardDrag] = useState<{
    ticketId: string
    targetIndex: number
  } | null>(null)

  const isDoneColumn = column === 'done'
  const isTodoColumn = column === 'todo'
  const isInProgressColumn = column === 'in_progress'

  const handleToggleCollapse = useCallback(() => {
    setIsCollapsed((prev) => !prev)
  }, [])

  // ── Drag & Drop handlers ──────────────────────────────────────────

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setIsDragOver(true)

      // Calculate drop index from cursor Y position relative to card elements
      const container = e.currentTarget
      const cards = container.querySelectorAll<HTMLElement>('[data-card-index]')
      let index = tickets.length // default: end of list

      for (const card of cards) {
        const rect = card.getBoundingClientRect()
        const midY = rect.top + rect.height / 2
        if (e.clientY < midY) {
          index = parseInt(card.getAttribute('data-card-index')!, 10)
          break
        }
      }

      dropIndexRef.current = index
      setDropIndex(index)
    },
    [tickets.length]
  )

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Only reset when truly leaving the drop area (not entering a child)
    const container = e.currentTarget
    const relatedTarget = e.relatedTarget as Node | null
    if (!relatedTarget || !container.contains(relatedTarget)) {
      setIsDragOver(false)
      setDropIndex(null)
      dropIndexRef.current = null
    }
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragOver(false)
      setDropIndex(null)

      // Read drag data from module-level state (avoids DataTransfer issues in Electron)
      const dragData = getKanbanDragData()
      if (!dragData) return

      const { ticketId, sourceColumn, sourceIndex } = dragData
      setKanbanDragData(null) // Clear after reading

      const targetIndex = dropIndexRef.current ?? tickets.length
      dropIndexRef.current = null

      const store = useKanbanStore.getState()

      if (sourceColumn !== column) {
        // ── Cross-column move ─────────────────────────────────
        const isSimpleMode = store.simpleModeByProject[projectId] ?? false

        // S9: when dropping on In Progress and simple mode is off,
        //   open the worktree picker modal instead of moving directly.
        if (isInProgressColumn && !isSimpleMode) {
          const allTickets = store.tickets.get(projectId) ?? []
          const draggedTicket = allTickets.find((t) => t.id === ticketId)
          if (draggedTicket) {
            setWorktreePickerTicket(draggedTicket)
            return // Don't move yet — modal handles the move
          }
        }

        // S11: backward drag from In Progress to To Do — confirm if ticket has active session
        if (isTodoColumn && sourceColumn === 'in_progress') {
          const allTickets = store.tickets.get(projectId) ?? []
          const draggedTicket = allTickets.find((t) => t.id === ticketId)
          if (draggedTicket?.current_session_id) {
            // Show confirmation dialog
            setPendingBackwardDrag({ ticketId, targetIndex })
            return
          }
        }

        // Default: move directly
        const sortOrder = store.computeSortOrder(tickets, targetIndex)
        store.moveTicket(ticketId, projectId, column, sortOrder)
      } else {
        // ── Same-column reorder ───────────────────────────────
        const filteredTickets = tickets.filter((t) => t.id !== ticketId)
        const adjustedIndex =
          targetIndex > sourceIndex ? targetIndex - 1 : targetIndex
        const sortOrder = store.computeSortOrder(filteredTickets, adjustedIndex)
        store.reorderTicket(ticketId, projectId, sortOrder)
      }
    },
    [column, projectId, tickets, isInProgressColumn, isTodoColumn]
  )

  // ── Backward drag confirmation handler ───────────────────────────
  const handleConfirmBackwardDrag = useCallback(async () => {
    if (!pendingBackwardDrag) return
    const { ticketId, targetIndex } = pendingBackwardDrag

    const store = useKanbanStore.getState()

    try {
      // Clear session link on the ticket
      await store.updateTicket(ticketId, projectId, {
        current_session_id: null,
        worktree_id: null,
        mode: null,
        plan_ready: false
      })

      // Move to todo
      const sortOrder = store.computeSortOrder(
        store.getTicketsByColumn(projectId, 'todo'),
        targetIndex
      )
      await store.moveTicket(ticketId, projectId, 'todo', sortOrder)

      toast.success('Session stopped and ticket moved to To Do')
    } catch {
      toast.error('Failed to move ticket')
    }

    setPendingBackwardDrag(null)
  }, [pendingBackwardDrag, projectId])

  // ── Drop indicator element ────────────────────────────────────────
  const dropIndicator = (
    <div
      data-testid={`drop-indicator-${column}`}
      className="h-0.5 rounded-full bg-primary mx-1 shrink-0 transition-opacity duration-150"
    />
  )

  return (
    <div
      data-testid={`kanban-column-${column}`}
      className="flex flex-1 min-w-[240px] max-w-[360px] flex-col"
    >
      {/* Column header */}
      <div className="flex items-center gap-2 px-2 pb-3">
        {/* Collapse toggle for Done column */}
        {isDoneColumn && (
          <button
            data-testid="kanban-column-done-toggle"
            onClick={handleToggleCollapse}
            className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted/40 transition-colors"
          >
            {isCollapsed ? (
              <ChevronRight className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
          </button>
        )}

        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {COLUMN_TITLES[column]}
        </h3>

        {/* Ticket count pill */}
        <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-muted/40 px-1.5 text-[11px] font-medium text-muted-foreground">
          {tickets.length}
        </span>

        {/* Add ticket button — only for To Do column */}
        {isTodoColumn && (
          <button
            data-testid="kanban-add-ticket-btn"
            onClick={() => setIsCreateModalOpen(true)}
            className="ml-auto flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted/40 hover:text-foreground transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Drop area — scrollable card list, doubles as drop target */}
      {!(isDoneColumn && isCollapsed) && (
        <div
          data-testid={`kanban-drop-area-${column}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={cn(
            'flex flex-col gap-2 overflow-y-auto px-1 pb-2 transition-all duration-200 rounded-md min-h-[60px]',
            isDragOver && 'bg-primary/5 ring-1 ring-primary/20'
          )}
        >
          {tickets.length === 0 ? (
            isDragOver ? (
              dropIndicator
            ) : (
              <p className="px-2 py-4 text-center text-xs text-muted-foreground/60">
                No tickets
              </p>
            )
          ) : (
            <>
              {tickets.map((ticket, index) => (
                <Fragment key={ticket.id}>
                  {isDragOver && dropIndex === index && dropIndicator}
                  <div data-card-index={index}>
                    <KanbanTicketCard ticket={ticket} index={index} />
                  </div>
                </Fragment>
              ))}
              {isDragOver && dropIndex === tickets.length && dropIndicator}
            </>
          )}
        </div>
      )}

      {/* Ticket creation modal — only for To Do column */}
      {isTodoColumn && (
        <TicketCreateModal
          open={isCreateModalOpen}
          onOpenChange={setIsCreateModalOpen}
          projectId={projectId}
        />
      )}

      {/* Worktree picker modal — for In Progress column drops */}
      {isInProgressColumn && worktreePickerTicket && (
        <WorktreePickerModal
          ticket={worktreePickerTicket}
          projectId={projectId}
          open={true}
          onOpenChange={(open) => {
            if (!open) setWorktreePickerTicket(null)
          }}
        />
      )}

      {/* Backward drag confirmation dialog — To Do column */}
      <AlertDialog
        open={!!pendingBackwardDrag}
        onOpenChange={(open) => {
          if (!open) setPendingBackwardDrag(null)
        }}
      >
        <AlertDialogContent data-testid="backward-drag-confirm-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Stop active session?</AlertDialogTitle>
            <AlertDialogDescription>
              This ticket has an active session. Stop the session and move to To Do?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="backward-drag-cancel-btn">Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="backward-drag-confirm-btn"
              onClick={handleConfirmBackwardDrag}
            >
              Stop &amp; Move
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

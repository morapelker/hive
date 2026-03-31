import { useState, useCallback, useRef, Fragment } from 'react'
import { motion } from 'motion/react'
import { ChevronRight, ChevronDown, Plus, Zap, Archive } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { Switch } from '@/components/ui/switch'
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
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem
} from '@/components/ui/context-menu'
import { useKanbanStore, getKanbanDragData, setKanbanDragData, suppressLayoutAnimation, isLayoutAnimationSuppressed } from '@/stores/useKanbanStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import type { KanbanTicket, KanbanTicketColumn as ColumnType } from '../../../../main/db/types'

// ── Layout animation spring ─────────────────────────────────────────
const CARD_LAYOUT_SPRING = {
  type: 'spring' as const,
  stiffness: 350,
  damping: 30,
  mass: 0.8,
}

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
  archivedTickets?: KanbanTicket[]
  projectId: string
  connectionId?: string
}

export function KanbanColumn({ column, tickets, archivedTickets, projectId, connectionId }: KanbanColumnProps) {
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
  const [showArchiveAllConfirm, setShowArchiveAllConfirm] = useState(false)

  const isDoneColumn = column === 'done'
  const isTodoColumn = column === 'todo'
  const isInProgressColumn = column === 'in_progress'

  // ── Connection-mode helpers ────────────────────────────────────────
  // In connection mode, tickets come from different projects, so we look
  // up each ticket's own project_id instead of using the column-level prop.

  const findTicket = useCallback(
    (ticketId: string): KanbanTicket | undefined => {
      if (connectionId) {
        // In connection mode, search across ALL tickets from all projects
        // (the dragged ticket may come from a different column/project)
        const allTickets = useKanbanStore.getState().tickets
        for (const projectTickets of allTickets.values()) {
          const found = projectTickets.find((t) => t.id === ticketId)
          if (found) return found
        }
        return undefined
      }
      const allTickets = useKanbanStore.getState().tickets.get(projectId) ?? []
      return allTickets.find((t) => t.id === ticketId)
    },
    [connectionId, projectId]
  )

  const findTicketProjectId = useCallback(
    (ticketId: string): string => {
      if (connectionId) {
        const ticket = findTicket(ticketId)
        if (ticket) return ticket.project_id
      }
      return projectId
    },
    [connectionId, projectId, findTicket]
  )

  // Global drag state — true when ANY ticket is being dragged
  const isDragging = useKanbanStore((state) => state.isDragging)
  const draggingTicketId = useKanbanStore((state) => state.draggingTicketId)

  // ── Simple mode toggle (In Progress column only) ───────────────
  // In connection mode, projectId is '' — acts as a single toggle for the connection board
  const isSimpleMode = useKanbanStore(
    useCallback(
      (state) => state.simpleModeByProject[projectId] ?? false,
      [projectId]
    )
  )

  const handleSimpleModeToggle = useCallback(
    (checked: boolean) => {
      useKanbanStore.getState().setSimpleMode(projectId, checked)
    },
    [projectId]
  )

  // ── Archive toggle (Done column only) ───────────────────────────
  // In connection mode, projectId is '' — acts as a single toggle for the connection board
  const showArchived = useKanbanStore(
    useCallback(
      (state) => state.showArchivedByProject[projectId] ?? false,
      [projectId]
    )
  )

  const handleToggleShowArchived = useCallback(
    (checked: boolean) => {
      useKanbanStore.getState().setShowArchived(projectId, checked)
    },
    [projectId]
  )

  const handleArchiveAll = useCallback(async () => {
    try {
      if (connectionId) {
        // In connection mode, archive done tickets across all member projects.
        // Step 11 will fully implement a dedicated connection-aware archive method;
        // for now, iterate over each member project individually.
        const projectIds = useKanbanStore.getState().getConnectionProjectIds(connectionId)
        let total = 0
        for (const pid of projectIds) {
          total += await useKanbanStore.getState().archiveAllDone(pid)
        }
        toast.success(`Archived ${total} ticket${total !== 1 ? 's' : ''}`)
      } else {
        const count = await useKanbanStore.getState().archiveAllDone(projectId)
        toast.success(`Archived ${count} ticket${count !== 1 ? 's' : ''}`)
      }
    } catch {
      toast.error('Failed to archive tickets')
    }
    setShowArchiveAllConfirm(false)
  }, [projectId, connectionId])

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

      // Suppress layout animation for drag-and-drop (instant placement across all columns)
      suppressLayoutAnimation()

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
        const ticketProjectId = findTicketProjectId(ticketId)
        const isSimpleMode = store.simpleModeByProject[projectId] ?? false

        // S9: when dropping on In Progress and simple mode is off,
        //   open the worktree picker modal instead of moving directly.
        if (isInProgressColumn && !isSimpleMode) {
          const draggedTicket = findTicket(ticketId)
          if (draggedTicket) {
            setWorktreePickerTicket(draggedTicket)
            return // Don't move yet — modal handles the move
          }
        }

        // S11: backward drag from In Progress to To Do — confirm if ticket has active session
        if (isTodoColumn && sourceColumn === 'in_progress') {
          const draggedTicket = findTicket(ticketId)
          if (draggedTicket?.current_session_id) {
            // Show confirmation dialog
            setPendingBackwardDrag({ ticketId, targetIndex })
            return
          }
        }

        // Default: move directly
        const sortOrder = store.computeSortOrder(tickets, targetIndex)
        store.moveTicket(ticketId, ticketProjectId, column, sortOrder)
      } else {
        // ── Same-column reorder ───────────────────────────────
        const ticketProjectId = findTicketProjectId(ticketId)
        const filteredTickets = tickets.filter((t) => t.id !== ticketId)
        const adjustedIndex =
          targetIndex > sourceIndex ? targetIndex - 1 : targetIndex
        const sortOrder = store.computeSortOrder(filteredTickets, adjustedIndex)
        store.reorderTicket(ticketId, ticketProjectId, sortOrder)
      }
    },
    [column, projectId, tickets, isInProgressColumn, isTodoColumn, findTicketProjectId, findTicket]
  )

  // ── Backward drag confirmation handler ───────────────────────────
  const handleConfirmBackwardDrag = useCallback(async () => {
    if (!pendingBackwardDrag) return
    // Suppress layout animation for drag-and-drop (instant placement across all columns)
    suppressLayoutAnimation()
    const { ticketId, targetIndex } = pendingBackwardDrag

    const store = useKanbanStore.getState()
    const ticketProjectId = findTicketProjectId(ticketId)

    try {
      // Stop the actual session
      const draggedTicket = findTicket(ticketId)
      if (draggedTicket?.current_session_id) {
        // Abort the running agent process (not just the DB status)
        const session = await window.db.session.get(draggedTicket.current_session_id)
        if (session?.opencode_session_id && session.worktree_id) {
          const worktree = await window.db.worktree.get(session.worktree_id)
          if (worktree?.path) {
            try {
              await window.opencodeOps.abort(worktree.path, session.opencode_session_id)
            } catch {
              // Non-critical — session may already be idle
            }
          }
        }

        await window.db.session.update(draggedTicket.current_session_id, {
          status: 'completed',
          completed_at: new Date().toISOString()
        })
        useWorktreeStatusStore.getState().clearSessionStatus(draggedTicket.current_session_id)
      }

      // Clear session link on the ticket
      await store.updateTicket(ticketId, ticketProjectId, {
        current_session_id: null,
        worktree_id: null,
        mode: null,
        plan_ready: false
      })

      // Move to todo
      const sortOrder = store.computeSortOrder(
        store.getTicketsByColumn(ticketProjectId, 'todo'),
        targetIndex
      )
      await store.moveTicket(ticketId, ticketProjectId, 'todo', sortOrder)

      toast.success('Session stopped and ticket moved to To Do')
    } catch {
      toast.error('Failed to move ticket')
    }

    setPendingBackwardDrag(null)
  }, [pendingBackwardDrag, projectId, findTicketProjectId, findTicket])

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
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={cn(
        'flex flex-1 min-w-[240px] max-w-[360px] flex-col rounded-lg border-2 bg-card/50 p-2 transition-all duration-200',
        isDragOver
          ? 'border-dashed border-primary bg-primary/[0.03]'
          : isDragging
            ? 'border-dashed border-muted-foreground/25'
            : 'border-solid border-border/20'
      )}
    >
      {/* Column header */}
      <ContextMenu>
        <ContextMenuTrigger asChild disabled={!isDoneColumn}>
          <div className="relative flex items-center px-2 pb-3">
            {/* Title group — centered */}
            <div className="flex w-full items-center justify-center gap-2">
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

              <span className="inline-flex h-5 min-w-[20px] items-center justify-center gap-0.5 rounded-full bg-muted/40 px-1.5 text-[11px] font-medium text-muted-foreground">
                {showArchived && archivedTickets && archivedTickets.length > 0
                  ? <>{tickets.length}+{archivedTickets.length}<Archive className="h-2.5 w-2.5" /></>
                  : tickets.length}
              </span>
            </div>

            {/* Flow mode toggle — top-right, vertically centered with title.
                ON (default) = flow mode: automated worktree picker on drop.
                OFF = simple mode: direct drop, no modal. */}
            {isInProgressColumn && (
              <div className="absolute right-2 flex items-center gap-1.5">
                <Zap className={cn('h-3 w-3', !isSimpleMode ? 'text-amber-500' : 'text-muted-foreground/50')} />
                <Switch
                  data-testid="simple-mode-toggle"
                  size="sm"
                  checked={!isSimpleMode}
                  onCheckedChange={(checked) => handleSimpleModeToggle(!checked)}
                />
              </div>
            )}

            {/* Archive toggle — top-right, vertically centered with title */}
            {isDoneColumn && (
              <div className="absolute right-2 flex items-center gap-1.5">
                <Archive className={cn('h-3 w-3', showArchived ? 'text-muted-foreground' : 'text-muted-foreground/50')} />
                <Switch
                  data-testid="archive-toggle"
                  size="sm"
                  checked={showArchived}
                  onCheckedChange={handleToggleShowArchived}
                />
              </div>
            )}
          </div>
        </ContextMenuTrigger>

        {isDoneColumn && (
          <ContextMenuContent>
            <ContextMenuItem
              data-testid="ctx-archive-all"
              disabled={tickets.length === 0}
              onClick={() => setShowArchiveAllConfirm(true)}
              className="gap-2"
            >
              <Archive className="h-3.5 w-3.5" />
              Archive all
            </ContextMenuItem>
          </ContextMenuContent>
        )}
      </ContextMenu>

      {/* Drop area — scrollable card list, doubles as drop target */}
      {!(isDoneColumn && isCollapsed) && (
        <motion.div
          layoutScroll
          data-testid={`kanban-drop-area-${column}`}
          className="flex flex-1 flex-col gap-2 overflow-y-auto px-1 pb-2 rounded-md min-h-[60px]"
        >
          {tickets.length === 0 && !(isDoneColumn && showArchived && archivedTickets && archivedTickets.length > 0) ? (
            isDragOver ? (
              dropIndicator
            ) : (
              /* Empty state: show the add-ticket card as the only item */
              isTodoColumn ? (
                <button
                  data-testid="kanban-add-ticket-card"
                  onClick={() => setIsCreateModalOpen(true)}
                  className="flex items-center justify-center gap-1.5 rounded-md border border-dashed border-border/60 p-3 text-sm text-muted-foreground/60 hover:border-primary/40 hover:text-muted-foreground hover:bg-muted/20 transition-colors cursor-pointer"
                >
                  <Plus className="h-4 w-4" />
                  <span>New ticket</span>
                </button>
              ) : (
                <p className="px-2 py-4 text-center text-xs text-muted-foreground/60">
                  No tickets
                </p>
              )
            )
          ) : (
            <>
              {tickets.map((ticket, index) => (
                <motion.div
                  key={ticket.id}
                  data-card-index={index}
                  layoutId={ticket.id}
                  layout
                  transition={isLayoutAnimationSuppressed() ? { duration: 0 } : CARD_LAYOUT_SPRING}
                >
                  {isDragOver && dropIndex === index && dropIndicator}
                  <div data-card-index={index} className={draggingTicketId === ticket.id ? 'h-0 min-h-0 overflow-hidden' : undefined}>
                    <KanbanTicketCard ticket={ticket} index={index} connectionId={connectionId} />
                  </div>
                </motion.div>
              ))}
              {isDragOver && dropIndex === tickets.length && dropIndicator}

              {/* Archived tickets (Done column, toggle ON) */}
              {isDoneColumn && showArchived && archivedTickets && archivedTickets.length > 0 && (
                <>
                  <div className="flex items-center gap-2 px-2 py-1">
                    <div className="flex-1 border-t border-border/40" />
                    <span className="text-[10px] font-medium text-muted-foreground/50 uppercase tracking-wider">Archived</span>
                    <div className="flex-1 border-t border-border/40" />
                  </div>
                  {archivedTickets.map((ticket) => (
                    <div key={ticket.id}>
                      <KanbanTicketCard ticket={ticket} index={-1} isArchived connectionId={connectionId} />
                    </div>
                  ))}
                </>
              )}

              {/* Add-ticket card at the end of the To Do column */}
              {isTodoColumn && (
                <button
                  data-testid="kanban-add-ticket-card"
                  onClick={() => setIsCreateModalOpen(true)}
                  className="flex items-center justify-center gap-1.5 rounded-md border border-dashed border-border/60 p-3 text-sm text-muted-foreground/60 hover:border-primary/40 hover:text-muted-foreground hover:bg-muted/20 transition-colors cursor-pointer"
                >
                  <Plus className="h-4 w-4" />
                  <span>New ticket</span>
                </button>
              )}
            </>
          )}
        </motion.div>
      )}

      {/* Ticket creation modal — To Do column */}
      {isTodoColumn && (
        <TicketCreateModal
          open={isCreateModalOpen}
          onOpenChange={setIsCreateModalOpen}
          projectId={projectId}
          connectionId={connectionId}
        />
      )}

      {/* Worktree picker modal — for In Progress column drops */}
      {isInProgressColumn && worktreePickerTicket && (
        <WorktreePickerModal
          ticket={worktreePickerTicket}
          projectId={connectionId ? worktreePickerTicket.project_id : projectId}
          open={true}
          onOpenChange={(open) => {
            if (!open) setWorktreePickerTicket(null)
          }}
          connectionId={connectionId}
        />
      )}

      {/* Backward drag confirmation dialog — To Do column */}
      {isTodoColumn && (
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
      )}

      {/* Archive All confirmation dialog — Done column */}
      {isDoneColumn && (
        <AlertDialog
          open={showArchiveAllConfirm}
          onOpenChange={setShowArchiveAllConfirm}
        >
          <AlertDialogContent data-testid="archive-all-confirm-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle>Archive all done tickets?</AlertDialogTitle>
              <AlertDialogDescription>
                Archive all {tickets.length} ticket{tickets.length !== 1 ? 's' : ''} in Done?
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="archive-all-cancel-btn">Cancel</AlertDialogCancel>
              <AlertDialogAction
                data-testid="archive-all-confirm-btn"
                onClick={handleArchiveAll}
              >
                Archive all
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  )
}

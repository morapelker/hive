import { memo, useCallback, useMemo, useRef, useState } from 'react'
import { Paperclip, AlertCircle, Trash2, Archive, ArchiveRestore, GitBranch, ExternalLink, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator
} from '@/components/ui/context-menu'
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
import { WorktreePickerModal } from '@/components/kanban/WorktreePickerModal'
import { IndeterminateProgressBar } from '@/components/sessions/IndeterminateProgressBar'
import { PulseAnimation } from '@/components/worktrees/PulseAnimation'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { setKanbanDragData, useKanbanStore } from '@/stores/useKanbanStore'
import { useScriptStore } from '@/stores/useScriptStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useQuestionStore } from '@/stores/useQuestionStore'
import { useSessionTimer } from '@/hooks/useSessionTimer'
import type { KanbanTicket } from '../../../../main/db/types'

interface KanbanTicketCardProps {
  ticket: KanbanTicket
  /** Position index within the column (used for drag transfer data) */
  index?: number
  /** Whether this ticket is archived (shown in archived section) */
  isArchived?: boolean
}

export const KanbanTicketCard = memo(function KanbanTicketCard({
  ticket,
  index = 0,
  isArchived = false
}: KanbanTicketCardProps) {
  const [isDragging, setIsDragging] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showWorktreePicker, setShowWorktreePicker] = useState(false)
  const [showPreAssignPicker, setShowPreAssignPicker] = useState(false)
  const dragCloneRef = useRef<HTMLElement | null>(null)

  // ── Lookup worktree name ────────────────────────────────────────
  const worktreeName = useWorktreeStore(
    useCallback(
      (state) => {
        if (!ticket.worktree_id) return null
        for (const worktrees of state.worktreesByProject.values()) {
          const found = worktrees.find((w) => w.id === ticket.worktree_id)
          if (found) return found.name
        }
        return null
      },
      [ticket.worktree_id]
    )
  )

  // ── Lookup linked session status ────────────────────────────────
  const sessionStatus = useSessionStore(
    useCallback(
      (state) => {
        if (!ticket.current_session_id) return null
        for (const sessions of state.sessionsByWorktree.values()) {
          const found = sessions.find((s) => s.id === ticket.current_session_id)
          if (found) return found.status
        }
        for (const sessions of state.sessionsByConnection.values()) {
          const found = sessions.find((s) => s.id === ticket.current_session_id)
          if (found) return found.status
        }
        return null
      },
      [ticket.current_session_id]
    )
  )

  // ── Real-time "agent is busy" from worktree status store ────────
  const isBusy = useWorktreeStatusStore(
    useCallback(
      (state) => {
        if (!ticket.current_session_id) return false
        const entry = state.sessionStatuses[ticket.current_session_id]
        return entry?.status === 'working' || entry?.status === 'planning'
      },
      [ticket.current_session_id]
    )
  )

  // ── Detect pending questions for this ticket's session ─────────
  const isAsking = useQuestionStore(
    useCallback(
      (state) => {
        if (!ticket.current_session_id) return false
        const questions = state.pendingBySession.get(ticket.current_session_id)
        return (questions?.length ?? 0) > 0
      },
      [ticket.current_session_id]
    )
  )

  const timerText = useSessionTimer(
    ticket.current_session_id,
    (isBusy || isAsking) && ticket.column === 'in_progress'
  )

  // ── Detect if the linked worktree has a live run process ──────
  const isRunProcessAlive = useScriptStore(
    useCallback(
      (s) => {
        if (!ticket.worktree_id) return false
        return s.scriptStates[ticket.worktree_id]?.runRunning ?? false
      },
      [ticket.worktree_id]
    )
  )

  const isActive = sessionStatus === 'active'
  const isError = sessionStatus === 'error'
  const hasAttachments = ticket.attachments.length > 0

  // ── Border state computation ────────────────────────────────────
  const borderState = useMemo(() => {
    if (ticket.column !== 'in_progress') return 'default'
    if (ticket.plan_ready) return 'violet'
    if (ticket.current_session_id && ticket.mode === 'build') return 'blue'
    if (ticket.current_session_id && ticket.mode === 'plan') return 'violet'
    return 'default'
  }, [ticket.column, ticket.mode, ticket.plan_ready, ticket.current_session_id])

  // ── Drag handlers ──────────────────────────────────────────────
  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      // Store drag data
      setKanbanDragData({ ticketId: ticket.id, sourceColumn: ticket.column, sourceIndex: index })
      e.dataTransfer.setData('text/plain', ticket.id)
      e.dataTransfer.effectAllowed = 'move'

      // Create rotated clone for drag image
      const el = e.currentTarget as HTMLElement
      const clone = el.cloneNode(true) as HTMLElement
      clone.style.width = `${el.offsetWidth}px`
      clone.style.transform = 'rotate(3deg)'
      clone.style.position = 'fixed'
      clone.style.top = '-9999px'
      clone.style.left = '-9999px'
      clone.style.pointerEvents = 'none'
      clone.style.zIndex = '9999'
      document.body.appendChild(clone)
      e.dataTransfer.setDragImage(clone, el.offsetWidth / 2, el.offsetHeight / 2)
      dragCloneRef.current = clone

      // Clean up clone after browser captures it — double-rAF ensures
      // Chromium/Electron has finished reading the drag image before removal
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (dragCloneRef.current) {
            dragCloneRef.current.remove()
            dragCloneRef.current = null
          }
        })
      })

      setIsDragging(true)
    },
    [ticket.id, ticket.column, index]
  )

  const handleDragEnd = useCallback(() => {
    // Safety cleanup
    if (dragCloneRef.current) {
      dragCloneRef.current.remove()
      dragCloneRef.current = null
    }
    setKanbanDragData(null)
    setIsDragging(false)
  }, [])

  // ── Click handler — open ticket detail modal ───────────────────
  const handleClick = useCallback(() => {
    useKanbanStore.getState().setSelectedTicketId(ticket.id)
  }, [ticket.id])

  const isDone = ticket.column === 'done'

  // ── Context menu handlers ─────────────────────────────────────
  const handleDelete = useCallback(async () => {
    try {
      await useKanbanStore.getState().deleteTicket(ticket.id, ticket.project_id)
      toast.success('Ticket deleted')
    } catch {
      toast.error('Failed to delete ticket')
    }
    setShowDeleteConfirm(false)
  }, [ticket.id, ticket.project_id])

  const handleArchive = useCallback(async () => {
    try {
      await useKanbanStore.getState().archiveTicket(ticket.id, ticket.project_id)
      toast.success('Ticket archived')
    } catch {
      toast.error('Failed to archive ticket')
    }
  }, [ticket.id, ticket.project_id])

  const handleUnarchive = useCallback(async () => {
    try {
      await useKanbanStore.getState().unarchiveTicket(ticket.id, ticket.project_id)
      toast.success('Ticket unarchived')
    } catch {
      toast.error('Failed to unarchive ticket')
    }
  }, [ticket.id, ticket.project_id])

  const handleJumpToSession = useCallback(() => {
    if (!ticket.current_session_id) return
    const kanbanStore = useKanbanStore.getState()
    if (kanbanStore.isBoardViewActive) kanbanStore.toggleBoardView()
    if (ticket.worktree_id) {
      useWorktreeStore.getState().selectWorktree(ticket.worktree_id)
      useSessionStore.getState().setActiveWorktree(ticket.worktree_id)
    }
    useSessionStore.getState().setActiveSession(ticket.current_session_id)
  }, [ticket.current_session_id, ticket.worktree_id])

  const isSimpleTicket = ticket.current_session_id === null
  const isFlowTicket = ticket.current_session_id !== null
  const isTodo = ticket.column === 'todo'

  const handleUnassignWorktree = useCallback(async () => {
    try {
      await useKanbanStore.getState().updateTicket(ticket.id, ticket.project_id, {
        worktree_id: null
      })
      toast.success('Worktree unassigned')
    } catch {
      toast.error('Failed to unassign worktree')
    }
  }, [ticket.id, ticket.project_id])

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            data-testid={`kanban-ticket-${ticket.id}`}
            draggable={!isArchived}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onClick={handleClick}
            className={cn(
              'group cursor-pointer rounded-md border bg-card shadow-sm p-3 transition-all duration-200',
              'hover:bg-muted/40',
              isDragging && 'invisible',
              isArchived && 'opacity-50 cursor-default',
              borderState === 'default' && 'border-border/60',
              borderState === 'blue' && 'border-blue-500/60',
              borderState === 'violet' && 'border-violet-500/60'
            )}
          >
            {/* Title */}
            <p className="text-sm font-medium leading-snug text-foreground">{ticket.title}</p>

            {/* Badges + progress row */}
            {(hasAttachments || worktreeName || ticket.plan_ready || isError || isBusy || isAsking || isArchived || isRunProcessAlive) && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {/* Archived badge */}
                {isArchived && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                    <Archive className="h-3 w-3" />
                    Archived
                  </span>
                )}
                {/* Attachment badge */}
                {hasAttachments && (
                  <span
                    data-testid="kanban-ticket-attachments"
                    className="inline-flex items-center gap-1 rounded-full bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
                  >
                    <Paperclip className="h-3 w-3" />
                    {ticket.attachments.length}
                  </span>
                )}

                {/* Worktree name badge */}
                {worktreeName && (
                  <span className="inline-flex items-center rounded-full bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                    {worktreeName}
                  </span>
                )}

                {/* Run process alive indicator */}
                {isRunProcessAlive && (
                  <PulseAnimation className="h-3 w-3 text-green-500 shrink-0" />
                )}

                {/* Plan ready badge */}
                {ticket.plan_ready && (
                  <span className="inline-flex items-center rounded-full bg-violet-500/10 border border-violet-500/30 px-2 py-0.5 text-[11px] font-medium text-violet-500">
                    Plan ready
                  </span>
                )}

                {/* Error badge */}
                {isError && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 border border-red-500/30 px-2 py-0.5 text-[11px] font-medium text-red-500">
                    <AlertCircle className="h-3 w-3" />
                    Error
                  </span>
                )}

                {(isBusy || isAsking) && ticket.mode && (
                  <span data-testid="kanban-ticket-progress" className="ml-auto flex items-center gap-1.5">
                    {timerText && (
                      <span className={cn(
                        'text-[11px] tabular-nums font-semibold',
                        isAsking
                          ? 'text-amber-500'
                          : ticket.mode === 'build'
                            ? 'text-blue-500'
                            : 'text-violet-500'
                      )}>
                        {timerText}
                      </span>
                    )}
                    <IndeterminateProgressBar mode={ticket.mode} isAsking={isAsking} className="w-20" />
                  </span>
                )}
              </div>
            )}
          </div>
        </ContextMenuTrigger>

        <ContextMenuContent>
          {/* Todo tickets without worktree: pre-assign */}
          {isSimpleTicket && isTodo && !ticket.worktree_id && (
            <ContextMenuItem
              data-testid="ctx-assign-worktree"
              onClick={() => setShowPreAssignPicker(true)}
              className="gap-2"
            >
              <GitBranch className="h-3.5 w-3.5" />
              Assign worktree
            </ContextMenuItem>
          )}

          {/* Todo tickets WITH pre-assigned worktree: change or unassign */}
          {isSimpleTicket && isTodo && ticket.worktree_id && (
            <>
              <ContextMenuItem
                data-testid="ctx-change-worktree"
                onClick={() => setShowPreAssignPicker(true)}
                className="gap-2"
              >
                <GitBranch className="h-3.5 w-3.5" />
                Change worktree
              </ContextMenuItem>
              <ContextMenuItem
                data-testid="ctx-unassign-worktree"
                onClick={handleUnassignWorktree}
                className="gap-2"
              >
                <X className="h-3.5 w-3.5" />
                Unassign worktree
              </ContextMenuItem>
            </>
          )}

          {/* Non-todo simple tickets: full assign flow (existing behavior) */}
          {isSimpleTicket && !isTodo && (
            <ContextMenuItem
              data-testid="ctx-assign-worktree"
              onClick={() => setShowWorktreePicker(true)}
              className="gap-2"
            >
              <GitBranch className="h-3.5 w-3.5" />
              Assign to worktree
            </ContextMenuItem>
          )}

          {/* Jump to session — only for flow tickets (has session) */}
          {isFlowTicket && (
            <ContextMenuItem
              data-testid="ctx-jump-to-session"
              onClick={handleJumpToSession}
              className="gap-2"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Jump to session
            </ContextMenuItem>
          )}

          <ContextMenuSeparator />

          {/* Archive/Unarchive (done tickets) or Delete (all others) */}
          {isDone ? (
            isArchived ? (
              <ContextMenuItem
                data-testid="ctx-unarchive-ticket"
                onClick={handleUnarchive}
                className="gap-2"
              >
                <ArchiveRestore className="h-3.5 w-3.5" />
                Unarchive
              </ContextMenuItem>
            ) : (
              <ContextMenuItem
                data-testid="ctx-archive-ticket"
                onClick={handleArchive}
                className="gap-2"
              >
                <Archive className="h-3.5 w-3.5" />
                Archive
              </ContextMenuItem>
            )
          ) : (
            <ContextMenuItem
              data-testid="ctx-delete-ticket"
              onClick={() => setShowDeleteConfirm(true)}
              className="gap-2 text-red-500 focus:text-red-500"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>

      {/* Delete confirmation dialog (not used for done/archive tickets) */}
      {!isDone && (
        <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
          <AlertDialogContent data-testid="ctx-delete-confirm-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle>Delete ticket</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete &ldquo;{ticket.title}&rdquo;? This action cannot be
                undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="ctx-delete-cancel-btn">Cancel</AlertDialogCancel>
              <AlertDialogAction
                data-testid="ctx-delete-confirm-btn"
                variant="destructive"
                onClick={handleDelete}
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      {/* Worktree picker modal for full assign (non-todo) */}
      <WorktreePickerModal
        ticket={ticket}
        projectId={ticket.project_id}
        open={showWorktreePicker}
        onOpenChange={setShowWorktreePicker}
      />

      {/* Pre-assign worktree picker (todo column) */}
      <WorktreePickerModal
        ticket={ticket}
        projectId={ticket.project_id}
        open={showPreAssignPicker}
        onOpenChange={setShowPreAssignPicker}
        preAssignOnly
      />
    </>
  )
})

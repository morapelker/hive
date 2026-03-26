import { memo, useCallback, useMemo, useRef, useState } from 'react'
import { Paperclip, AlertCircle, Trash2, GitBranch, ExternalLink } from 'lucide-react'
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
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { setKanbanDragData, useKanbanStore } from '@/stores/useKanbanStore'
import type { KanbanTicket } from '../../../../main/db/types'

// ── Pulsing border keyframes (injected once) ────────────────────────
const STYLE_ID = 'kanban-pulse-keyframes'
if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    @property --kanban-angle {
      syntax: "<angle>";
      inherits: false;
      initial-value: 0deg;
    }

    @keyframes kanban-gradient-rotate {
      to { --kanban-angle: 360deg; }
    }

    [data-gradient-border] {
      position: relative;
    }

    [data-gradient-border]::before {
      content: '';
      position: absolute;
      inset: -1.5px;
      border-radius: inherit;
      padding: 1.5px;
      background: conic-gradient(
        from var(--kanban-angle) at 50% 50%,
        var(--grad-dim) 0%,
        var(--grad-bright) 12.5%,
        var(--grad-dim) 25%,
        transparent 50%,
        var(--grad-dim) 75%,
        var(--grad-bright) 87.5%,
        var(--grad-dim) 100%
      );
      -webkit-mask:
        linear-gradient(#fff 0 0) content-box,
        linear-gradient(#fff 0 0);
      -webkit-mask-composite: xor;
      mask:
        linear-gradient(#fff 0 0) content-box,
        linear-gradient(#fff 0 0);
      mask-composite: exclude;
      animation: kanban-gradient-rotate 3s linear infinite;
      pointer-events: none;
    }
  `
  document.head.appendChild(style)
}

interface KanbanTicketCardProps {
  ticket: KanbanTicket
  /** Position index within the column (used for drag transfer data) */
  index?: number
}

export const KanbanTicketCard = memo(function KanbanTicketCard({
  ticket,
  index = 0
}: KanbanTicketCardProps) {
  const [isDragging, setIsDragging] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showWorktreePicker, setShowWorktreePicker] = useState(false)
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

  const isActive = sessionStatus === 'active'
  const isError = sessionStatus === 'error'
  const hasAttachments = ticket.attachments.length > 0

  // ── Border state computation ────────────────────────────────────
  // gradient-*  → session actively working (rotating gradient border)
  // static-*    → session attached but idle / plan ready (solid color border)
  // default     → no session attached
  const borderState = useMemo(() => {
    if (isActive && ticket.mode === 'build') return 'gradient-blue'
    if (isActive && ticket.mode === 'plan') return 'gradient-violet'
    if (ticket.plan_ready) return 'static-violet'
    if (ticket.current_session_id && ticket.mode === 'build') return 'static-blue'
    if (ticket.current_session_id && ticket.mode === 'plan') return 'static-violet'
    return 'default'
  }, [isActive, ticket.mode, ticket.plan_ready, ticket.current_session_id])

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

  const handleJumpToSession = useCallback(() => {
    if (!ticket.current_session_id) return
    const kanbanStore = useKanbanStore.getState()
    if (kanbanStore.isBoardViewActive) kanbanStore.toggleBoardView()
    if (ticket.worktree_id) useWorktreeStore.getState().selectWorktree(ticket.worktree_id)
    useSessionStore.getState().setActiveSession(ticket.current_session_id)
  }, [ticket.current_session_id, ticket.worktree_id])

  const isSimpleTicket = ticket.current_session_id === null
  const isFlowTicket = ticket.current_session_id !== null

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            data-testid={`kanban-ticket-${ticket.id}`}
            data-gradient-border={
              borderState === 'gradient-blue' || borderState === 'gradient-violet'
                ? ''
                : undefined
            }
            draggable={true}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onClick={handleClick}
            className={cn(
              'group cursor-pointer rounded-md border bg-card shadow-sm p-3 transition-all duration-200',
              'hover:bg-muted/40',
              isDragging && 'invisible',
              borderState === 'default' && 'border-border/60',
              borderState === 'static-blue' && 'border-blue-500/60',
              borderState === 'static-violet' && 'border-violet-500/60',
              (borderState === 'gradient-blue' || borderState === 'gradient-violet') &&
                'border-transparent'
            )}
            style={
              borderState === 'gradient-blue'
                ? ({
                    '--grad-bright': 'rgb(59 130 246)',
                    '--grad-dim': 'rgb(59 130 246 / 0.3)'
                  } as React.CSSProperties)
                : borderState === 'gradient-violet'
                  ? ({
                      '--grad-bright': 'rgb(139 92 246)',
                      '--grad-dim': 'rgb(139 92 246 / 0.3)'
                    } as React.CSSProperties)
                  : undefined
            }
          >
            {/* Title */}
            <p className="text-sm font-medium leading-snug text-foreground">{ticket.title}</p>

            {/* Badges row */}
            {(hasAttachments || worktreeName || ticket.plan_ready || isError) && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
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
              </div>
            )}
          </div>
        </ContextMenuTrigger>

        <ContextMenuContent>
          {/* Assign to worktree — only for simple tickets (no session) */}
          {isSimpleTicket && (
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

          {/* Delete */}
          <ContextMenuItem
            data-testid="ctx-delete-ticket"
            onClick={() => setShowDeleteConfirm(true)}
            className="gap-2 text-red-500 focus:text-red-500"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* Delete confirmation dialog */}
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

      {/* Worktree picker modal for assigning */}
      <WorktreePickerModal
        ticket={ticket}
        projectId={ticket.project_id}
        open={showWorktreePicker}
        onOpenChange={setShowWorktreePicker}
      />
    </>
  )
})

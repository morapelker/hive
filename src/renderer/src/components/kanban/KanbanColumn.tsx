import { useState, useCallback, useRef, useLayoutEffect } from 'react'
import { motion } from 'motion/react'
import { AlertTriangle, ChevronRight, ChevronDown, FileText, Plus, Zap, Archive } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { lastSendMode } from '@/lib/message-send-times'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
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
import {
  useKanbanStore,
  getKanbanDragData,
  setKanbanDragData,
  suppressLayoutAnimation,
  isLayoutAnimationSuppressed,
  parseTicketKey,
  ticketKey
} from '@/stores/useKanbanStore'
import type { MarkdownCardPlaceholder } from '@/stores/useKanbanStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useUsageStore, resolveDefaultUsageProvider } from '@/stores/useUsageStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { isBlockerSatisfied } from '@/lib/blocker-utils'
import type {
  KanbanTicket,
  KanbanTicketColumn as ColumnType,
  MarkdownCardDiagnostic,
  Session,
  Worktree
} from '../../../../main/db/types'
import { unwrapEnvelope } from '@/lib/ipc-envelope'
import { dbApi } from '@/api/db-api'
import { gitApi } from '@/api/git-api'
import { opencodeApi } from '@/api/opencode-api'
import { remoteLaunchApi } from '@/api/remote-launch-api'
import { useRemoteLaunchStore } from '@/stores/useRemoteLaunchStore'
import { parseRemoteLaunch } from '@shared/types/remote-launch'

// ── Layout animation spring ─────────────────────────────────────────
const CARD_LAYOUT_SPRING = {
  type: 'spring' as const,
  stiffness: 350,
  damping: 30,
  mass: 0.8
}

// ── Column display names ────────────────────────────────────────────
const COLUMN_TITLES: Record<ColumnType, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  review: 'Review',
  merged: 'Merged',
  done: 'Done'
}

function fileNameFromPath(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath
}

function MarkdownInvalidCardPlaceholder({ placeholder }: { placeholder: MarkdownCardPlaceholder }) {
  const [isConverting, setIsConverting] = useState(false)

  const handleConvert = useCallback(async () => {
    setIsConverting(true)
    try {
      const ticket = await useKanbanStore
        .getState()
        .convertMarkdownPlaceholder(placeholder.projectId, placeholder.filePath)
      toast.success(`Converted "${ticket.title}" to a kanban card`)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Failed to convert markdown file to kanban card'
      )
    } finally {
      setIsConverting(false)
    }
  }, [placeholder.filePath, placeholder.projectId])

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-testid="kanban-invalid-card-placeholder"
          className="rounded-md border border-destructive/35 bg-destructive/5 p-2 text-sm shadow-sm"
          title={`${placeholder.filePath}\n${placeholder.message}`}
        >
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5 font-medium text-destructive">
                <FileText className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{fileNameFromPath(placeholder.filePath)}</span>
              </div>
              <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                {placeholder.message}
              </p>
              <p className="mt-1 truncate text-[10px] text-muted-foreground/70">
                {placeholder.filePath}
              </p>
            </div>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          data-testid="ctx-convert-markdown-card"
          disabled={isConverting}
          onClick={handleConvert}
          className="gap-2"
        >
          <FileText className="h-3.5 w-3.5" />
          {isConverting ? 'Converting...' : 'Convert to kanban card'}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function fallbackCardIdentityKeys(
  tickets: KanbanTicket[],
  diagnosticsByProject: Map<string, MarkdownCardDiagnostic[]>,
  column: ColumnType,
  listKind: 'active' | 'archived'
): string[] {
  const occurrenceCounts = new Map<string, number>()
  return tickets.map((ticket) => {
    const logicalKey = ticketKey(ticket.project_id, ticket.id)
    const hasDuplicateDiagnostic = (diagnosticsByProject.get(ticket.project_id) ?? []).some(
      (diagnostic) => diagnostic.kind === 'duplicate_id' && diagnostic.ticketId === ticket.id
    )
    if (!hasDuplicateDiagnostic) return logicalKey

    const occurrenceIndex = occurrenceCounts.get(logicalKey) ?? 0
    occurrenceCounts.set(logicalKey, occurrenceIndex + 1)
    return `${logicalKey}:duplicate:${listKind}:${column}:local-${occurrenceIndex}`
  })
}

interface KanbanColumnProps {
  column: ColumnType
  tickets: KanbanTicket[]
  archivedTickets?: KanbanTicket[]
  activeCardIdentityKeys?: string[]
  archivedCardIdentityKeys?: string[]
  invalidPlaceholders?: MarkdownCardPlaceholder[]
  projectId: string
  connectionId?: string
  isPinnedMode?: boolean
}

export function KanbanColumn({
  column,
  tickets,
  archivedTickets,
  activeCardIdentityKeys,
  archivedCardIdentityKeys,
  invalidPlaceholders = [],
  projectId,
  connectionId,
  isPinnedMode
}: KanbanColumnProps) {
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const dropIndexRef = useRef<number | null>(null)
  const [worktreePickerTicket, setWorktreePickerTicket] = useState<KanbanTicket | null>(null)
  const [saveConfigTicket, setSaveConfigTicket] = useState<KanbanTicket | null>(null)
  const [pendingBackwardDrag, setPendingBackwardDrag] = useState<{
    ticketId: string
    projectId: string
    targetIndex: number
  } | null>(null)
  const [showArchiveAllConfirm, setShowArchiveAllConfirm] = useState(false)

  // ── In Progress header title fit mode ───────────────────────────
  // 'centered'    = default; title centered with 50px left spacer
  // 'right'       = title right-aligned with 8px gap from toggle
  // 'abbreviated' = title shows "In Prog" right-aligned
  type TitleMode = 'centered' | 'right' | 'abbreviated'
  const [titleMode, setTitleMode] = useState<TitleMode>('centered')
  const headerRef = useRef<HTMLDivElement>(null)
  const badgeRef = useRef<HTMLSpanElement>(null)
  const toggleRef = useRef<HTMLDivElement>(null)
  const fullTextMeasureRef = useRef<HTMLSpanElement>(null)
  const shortTextMeasureRef = useRef<HTMLSpanElement>(null)

  const isDoneColumn = column === 'done'
  const isMergedColumn = column === 'merged'
  const isTodoColumn = column === 'todo'
  const isInProgressColumn = column === 'in_progress'
  // Done and Merged share date-sorted behavior (no manual reordering)
  const isDateSortedColumn = isDoneColumn || isMergedColumn
  const isMultiProjectMode = !!connectionId || !!isPinnedMode

  // ── Multi-project helpers ─────────────────────────────────────────
  // In multi-project mode (connection or pinned), tickets come from different
  // projects, so we look up each ticket's own project_id instead of using
  // the column-level prop.

  const findTicket = useCallback(
    (ticketId: string, ticketProjectId?: string): KanbanTicket | undefined => {
      if (ticketProjectId) {
        return useKanbanStore.getState().tickets.get(ticketProjectId)?.find((t) => t.id === ticketId)
      }
      if (isMultiProjectMode) {
        // In multi-project mode (connection or pinned), search across ALL tickets
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
    [isMultiProjectMode, projectId]
  )

  const findTicketProjectId = useCallback(
    (ticketId: string, ticketProjectId?: string): string => {
      if (ticketProjectId) return ticketProjectId
      if (isMultiProjectMode) {
        const ticket = findTicket(ticketId)
        if (ticket) return ticket.project_id
      }
      return projectId
    },
    [isMultiProjectMode, projectId, findTicket]
  )

  const projectTicketsForColumn = useCallback(
    (ticketProjectId: string): KanbanTicket[] =>
      tickets.filter((ticket) => ticket.project_id === ticketProjectId),
    [tickets]
  )

  const projectLocalDropIndex = useCallback(
    (ticketProjectId: string, mergedDropIndex: number): number =>
      tickets
        .slice(0, Math.max(0, mergedDropIndex))
        .filter((ticket) => ticket.project_id === ticketProjectId).length,
    [tickets]
  )

  // Global drag state — true when ANY ticket is being dragged
  const isDragging = useKanbanStore((state) => state.isDragging)
  const draggingTicketKey = useKanbanStore((state) => state.draggingTicketKey)
  const markdownDiagnostics = useKanbanStore((state) => state.markdownDiagnostics)
  const fallbackActiveCardIdentityKeys =
    activeCardIdentityKeys ?? fallbackCardIdentityKeys(tickets, markdownDiagnostics, column, 'active')
  const fallbackArchivedCardIdentityKeys =
    archivedTickets && !archivedCardIdentityKeys
      ? fallbackCardIdentityKeys(archivedTickets, markdownDiagnostics, column, 'archived')
      : archivedCardIdentityKeys

  // ── Simple mode toggle (In Progress column only) ───────────────
  // In connection mode, projectId is '' — acts as a single toggle for the connection board
  const isSimpleMode = useKanbanStore(
    useCallback((state) => state.simpleModeByProject[projectId] ?? false, [projectId])
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
    useCallback((state) => state.showArchivedByProject[projectId] ?? false, [projectId])
  )

  // ── Measure header and pick title fit mode (In Progress column only) ─────
  useLayoutEffect(() => {
    if (!isInProgressColumn) return
    const header = headerRef.current
    const badge = badgeRef.current
    const toggle = toggleRef.current
    const fullMeasure = fullTextMeasureRef.current
    if (!header || !badge || !toggle || !fullMeasure) return

    const LEFT_SPACER_PX = 50
    const TITLE_BADGE_GAP_PX = 8 // gap-2 in title group
    const TITLE_TOGGLE_GAP_PX = 8 // ml-2 between title group and toggle
    const RIGHT_MIN_PADDING_PX = 8 // min gap in 'right' mode

    const compute = (): void => {
      const cs = window.getComputedStyle(header)
      const innerWidth =
        header.clientWidth - parseFloat(cs.paddingLeft || '0') - parseFloat(cs.paddingRight || '0')

      const fullTextW = fullMeasure.offsetWidth
      const badgeW = badge.offsetWidth
      const toggleW = toggle.offsetWidth

      // Mode 1: centered with full text (needs left spacer)
      const centeredNeeded =
        LEFT_SPACER_PX + fullTextW + TITLE_BADGE_GAP_PX + badgeW + TITLE_TOGGLE_GAP_PX + toggleW
      if (centeredNeeded <= innerWidth) {
        setTitleMode('centered')
        return
      }

      // Mode 2: right-aligned full text (no spacer, 8px min padding on left of title)
      const rightNeeded =
        RIGHT_MIN_PADDING_PX +
        fullTextW +
        TITLE_BADGE_GAP_PX +
        badgeW +
        TITLE_TOGGLE_GAP_PX +
        toggleW
      if (rightNeeded <= innerWidth) {
        setTitleMode('right')
        return
      }

      // Mode 3: abbreviated, right-aligned
      setTitleMode('abbreviated')
    }

    compute()

    const ro = new ResizeObserver(compute)
    ro.observe(header)
    ro.observe(badge)
    ro.observe(toggle)

    // Re-measure after web fonts finish loading (fallback-metric guard)
    let cancelled = false
    document.fonts?.ready
      ?.then(() => {
        if (!cancelled) compute()
      })
      .catch(() => {})
    return () => {
      cancelled = true
      ro.disconnect()
    }
  }, [isInProgressColumn, tickets.length, showArchived, archivedTickets?.length])

  const handleToggleShowArchived = useCallback(
    (checked: boolean) => {
      useKanbanStore.getState().setShowArchived(projectId, checked)
    },
    [projectId]
  )

  const handleArchiveAll = useCallback(async () => {
    // When the Merged column is hidden, merged tickets display inside Done, so
    // "Archive all" must archive them too (WYSIWYG with the confirm count)
    const includeMerged = !useSettingsStore.getState().showMergedColumn
    try {
      if (isPinnedMode) {
        // In pinned mode, archive done tickets across all pinned-derived projects
        const projectIds = useKanbanStore.getState().getPinnedProjectIdsArray()
        let total = 0
        for (const pid of projectIds) {
          total += await useKanbanStore.getState().archiveAllDone(pid, includeMerged)
        }
        toast.success(`Archived ${total} ticket${total !== 1 ? 's' : ''}`)
      } else if (connectionId) {
        // In connection mode, archive done tickets across all member projects.
        const projectIds = useKanbanStore.getState().getConnectionProjectIds(connectionId)
        let total = 0
        for (const pid of projectIds) {
          total += await useKanbanStore.getState().archiveAllDone(pid, includeMerged)
        }
        toast.success(`Archived ${total} ticket${total !== 1 ? 's' : ''}`)
      } else {
        const count = await useKanbanStore.getState().archiveAllDone(projectId, includeMerged)
        toast.success(`Archived ${count} ticket${count !== 1 ? 's' : ''}`)
      }
    } catch {
      toast.error('Failed to archive tickets')
    }
    setShowArchiveAllConfirm(false)
  }, [projectId, connectionId, isPinnedMode])

  const handleToggleCollapse = useCallback(() => {
    setIsCollapsed((prev) => !prev)
  }, [])

  // ── Drag & Drop handlers ──────────────────────────────────────────

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      // Done/Merged are date-sorted (newest first): reordering within them is disabled,
      // and cross-column drops always land at the top regardless of cursor position
      if (isDateSortedColumn) {
        const sourceColumn = getKanbanDragData()?.sourceColumn
        if (sourceColumn === column) return
        // Folded merged cards render inside Done when the Merged column is
        // hidden — dragging them within Done is a same-column no-op, not a
        // promotion to done
        if (
          isDoneColumn &&
          sourceColumn === 'merged' &&
          !useSettingsStore.getState().showMergedColumn
        ) {
          return
        }
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setIsDragOver(true)
        dropIndexRef.current = 0
        setDropIndex(0)
        return
      }

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
    [tickets.length, isDateSortedColumn, column]
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
    async (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragOver(false)
      setDropIndex(null)

      // Suppress layout animation for drag-and-drop (instant placement across all columns)
      suppressLayoutAnimation()

      // Read drag data from module-level state (avoids DataTransfer issues in Electron)
      const dragData = getKanbanDragData()
      if (!dragData) return

      const { ticketId, sourceColumn, projectId: draggedProjectId } = dragData
      setKanbanDragData(null) // Clear after reading

      const targetIndex = dropIndexRef.current ?? tickets.length
      dropIndexRef.current = null

      const store = useKanbanStore.getState()

      if (sourceColumn !== column) {
        // ── Cross-column move ─────────────────────────────────
        // Folded merged card dropped back on the visual Done list — no-op so
        // merged-but-unverified work isn't silently marked done
        if (
          column === 'done' &&
          sourceColumn === 'merged' &&
          !useSettingsStore.getState().showMergedColumn
        ) {
          return
        }
        const ticketProjectId = findTicketProjectId(ticketId, draggedProjectId)
        const simpleModeKey = isMultiProjectMode ? projectId : ticketProjectId
        const isSimpleMode =
          store.simpleModeByProject[simpleModeKey] ??
          store.simpleModeByProject[ticketProjectId] ??
          false

        // S9: when dropping on In Progress and simple mode is off,
        //   open the worktree picker modal instead of moving directly.
        if (isInProgressColumn && !isSimpleMode) {
          const draggedTicket = findTicket(ticketId, ticketProjectId)
          if (draggedTicket) {
            // Check if ticket has unresolved blockers
            const blockerIds = store.dependencyMap.get(ticketKey(ticketProjectId ?? draggedProjectId, ticketId))
            const triggerColumn = useSettingsStore.getState().followUpTriggerColumn
            let isBlocked = false
            if (blockerIds?.size) {
              for (const blockerKey of blockerIds) {
                const blockerRef = parseTicketKey(blockerKey)
                const blockerTicket = store.tickets
                  .get(blockerRef.projectId)
                  ?.find((t) => t.id === blockerRef.ticketId)
                if (blockerTicket && !isBlockerSatisfied(blockerTicket.column, blockerTicket.mode, triggerColumn)) {
                  isBlocked = true
                  break
                }
              }
            }

            if (isBlocked) {
              // Blocked ticket — open picker in save-config-only mode
              setSaveConfigTicket(draggedTicket)
            } else {
              // Normal unblocked ticket — open regular picker
              setWorktreePickerTicket(draggedTicket)
            }
            return // Don't move yet — modal handles the move
          }
        }

        // S11: backward drag from In Progress to To Do — confirm if ticket has active session
        if (isTodoColumn && sourceColumn === 'in_progress') {
          const draggedTicket = findTicket(ticketId, ticketProjectId)
          if (draggedTicket?.current_session_id) {
            // Show confirmation dialog
            setPendingBackwardDrag({
              ticketId,
              projectId: ticketProjectId,
              targetIndex: projectLocalDropIndex(ticketProjectId, targetIndex)
            })
            return
          }
        }

        // Merge-on-done: intercept drops to Done/Merged for feature-branch worktrees
        if (column === 'done' || column === 'merged') {
          const draggedTicket = findTicket(ticketId, ticketProjectId)
          if (draggedTicket?.worktree_id) {
            try {
              const worktree = await dbApi.worktree.get<Worktree>(draggedTicket.worktree_id)
              if (worktree) {
                // Resolve the effective base branch
                const defaultWorktrees =
                  await dbApi.worktree.getActiveByProject<Worktree>(ticketProjectId)
                const defaultWt = defaultWorktrees.find((w) => w.is_default)
                const resolvedBaseBranch = worktree.base_branch ?? defaultWt?.branch_name

                if (resolvedBaseBranch && worktree.branch_name !== resolvedBaseBranch) {
                  // Verify an active base worktree exists
                  const baseWorktree = defaultWorktrees.find(
                    (w) => w.branch_name === resolvedBaseBranch && w.status === 'active'
                  )

                  if (baseWorktree) {
                    // Pre-check: does the feature branch actually have work to merge?
                    const [hasUncommitted, branchStatResult] = await Promise.all([
                      gitApi.hasUncommittedChanges(worktree.path),
                      gitApi.branchDiffShortStat(worktree.path, resolvedBaseBranch)
                    ])

                    const commitsAhead = branchStatResult.success
                      ? branchStatResult.commitsAhead
                      : 0

                    if (!branchStatResult.success) {
                      toast.warning(
                        `Could not verify merge status: ${branchStatResult.error ?? 'unknown error'}`
                      )
                      return
                    }

                    if (hasUncommitted || commitsAhead > 0) {
                      const sortOrder = store.computeSortOrder(
                        projectTicketsForColumn(ticketProjectId),
                        projectLocalDropIndex(ticketProjectId, targetIndex)
                      )
                      store.setPendingDoneMove({
                        ticketId,
                        projectId: ticketProjectId,
                        sortOrder,
                        targetColumn: column
                      })
                      return
                    }
                  }
                  // No base worktree OR nothing to commit/merge — fall through to normal move
                }
              }
            } catch (err) {
              toast.warning(
                `Could not verify merge status: ${err instanceof Error ? err.message : String(err)}`
              )
              return
            }
          }
        }

        // Default: move directly
        const sortOrder = store.computeSortOrder(
          projectTicketsForColumn(ticketProjectId),
          projectLocalDropIndex(ticketProjectId, targetIndex)
        )
        store.moveTicket(ticketId, ticketProjectId, column, sortOrder)

        // Trigger usage refresh when simple-mode drops a ticket into In Progress
        if (column === 'in_progress') {
          const sdk = useSettingsStore.getState().defaultAgentSdk ?? 'opencode'
          const usageProvider = resolveDefaultUsageProvider(sdk)
          if (usageProvider) useUsageStore.getState().fetchUsageForProvider(usageProvider)
        }
      } else {
        // ── Same-column reorder ───────────────────────────────
        // Done/Merged are always date-sorted — manual reordering is disabled
        if (isDateSortedColumn) return
        const ticketProjectId = findTicketProjectId(ticketId, draggedProjectId)
        const draggedKey = ticketKey(ticketProjectId, ticketId)
        const projectTickets = projectTicketsForColumn(ticketProjectId)
        const sourceProjectIndex = projectTickets.findIndex(
          (ticket) => ticketKey(ticket.project_id, ticket.id) === draggedKey
        )
        const filteredTickets = projectTickets.filter(
          (ticket) => ticketKey(ticket.project_id, ticket.id) !== draggedKey
        )
        const targetProjectIndex = projectLocalDropIndex(ticketProjectId, targetIndex)
        const adjustedIndex =
          sourceProjectIndex >= 0 && targetProjectIndex > sourceProjectIndex
            ? targetProjectIndex - 1
            : targetProjectIndex
        const sortOrder = store.computeSortOrder(filteredTickets, adjustedIndex)
        store.reorderTicket(ticketId, ticketProjectId, sortOrder)
      }
    },
    [
      column,
      tickets.length,
      isInProgressColumn,
      isTodoColumn,
      isDateSortedColumn,
      isMultiProjectMode,
      projectId,
      findTicketProjectId,
      findTicket,
      projectTicketsForColumn,
      projectLocalDropIndex
    ]
  )

  // ── Backward drag confirmation handler ───────────────────────────
  const handleConfirmBackwardDrag = useCallback(async () => {
    if (!pendingBackwardDrag) return
    // Suppress layout animation for drag-and-drop (instant placement across all columns)
    suppressLayoutAnimation()
    const { ticketId, projectId: ticketProjectId, targetIndex } = pendingBackwardDrag

    const store = useKanbanStore.getState()

    try {
      // Stop the actual session
      const draggedTicket = findTicket(ticketId, ticketProjectId)
      if (draggedTicket?.current_session_id) {
        // Abort the running agent process (not just the DB status)
        const session = await dbApi.session.get<Session>(draggedTicket.current_session_id)
        if (session?.opencode_session_id && session.worktree_id) {
          const worktree = await dbApi.worktree.get<Worktree>(session.worktree_id)
          if (worktree?.path) {
            try {
              unwrapEnvelope(
                await opencodeApi.abort(worktree.path, session.opencode_session_id)
              )
            } catch {
              // Non-critical — session may already be idle
            }
          }
        }

        // Remote-launched sessions have no local worktree/process — the agent
        // runs in a tmux session on the remote host. Kill it there; if the
        // remote can't be reached, abort the whole move rather than severing
        // the ticket's only link to a still-running remote session.
        const remoteInfo = parseRemoteLaunch(session?.remote_launch)
        if (remoteInfo?.role === 'client' && !remoteInfo.stoppedAt) {
          try {
            await remoteLaunchApi.stop({ sessionId: draggedTicket.current_session_id })
            useRemoteLaunchStore.getState().markStopped(draggedTicket.current_session_id)
          } catch (err) {
            toast.error(
              `Could not stop the remote session — ticket not moved: ${err instanceof Error ? err.message : String(err)}`
            )
            setPendingBackwardDrag(null)
            return
          }
        }

        await dbApi.session.update(draggedTicket.current_session_id, {
          status: 'completed',
          completed_at: new Date().toISOString()
        })
        useWorktreeStatusStore.getState().clearSessionStatus(draggedTicket.current_session_id)
        lastSendMode.delete(draggedTicket.current_session_id)
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
  }, [pendingBackwardDrag, findTicket])

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
        'flex flex-1 min-w-[220px] max-w-[300px] flex-col rounded-lg border-2 bg-card/50 p-2 transition-all duration-200',
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
          <div
            ref={headerRef}
            data-title-mode={isInProgressColumn ? titleMode : 'centered'}
            className="relative flex items-center px-2 pb-3"
          >
            {/* Left spacer — mirrors right toggle width to keep title centered.
                For In Progress, only rendered in 'centered' mode so that
                'right'/'abbreviated' modes can reclaim that space. */}
            {(isDoneColumn || (isInProgressColumn && titleMode === 'centered')) && (
              <div className="w-[50px] shrink" aria-hidden="true" />
            )}

            {/* Title group — centered, or right-aligned when In Progress can't fit centered */}
            <div
              className={cn(
                'flex flex-1 items-center gap-2',
                isInProgressColumn && titleMode !== 'centered' ? 'justify-end' : 'justify-center'
              )}
            >
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

              <h3 className="whitespace-nowrap text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {isInProgressColumn && titleMode === 'abbreviated'
                  ? 'In Prog'
                  : COLUMN_TITLES[column]}
              </h3>

              <span
                ref={badgeRef}
                className="inline-flex h-5 min-w-[20px] items-center justify-center gap-0.5 rounded-full bg-muted/40 px-1.5 text-[11px] font-medium text-muted-foreground"
              >
                {showArchived && archivedTickets && archivedTickets.length > 0 ? (
                  <>
                    {tickets.length}+<span className="italic">{archivedTickets.length}</span>
                  </>
                ) : (
                  tickets.length
                )}
              </span>
            </div>

            {/* Flow mode toggle — right of title, vertically centered.
                ON (default) = flow mode: automated worktree picker on drop.
                OFF = simple mode: direct drop, no modal. */}
            {isInProgressColumn && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div ref={toggleRef} className="ml-2 flex shrink-0 items-center gap-1.5">
                    <Zap
                      className={cn(
                        'h-3 w-3',
                        !isSimpleMode ? 'text-amber-500' : 'text-muted-foreground/50'
                      )}
                    />
                    <Switch
                      data-testid="simple-mode-toggle"
                      size="sm"
                      checked={!isSimpleMode}
                      onCheckedChange={(checked) => handleSimpleModeToggle(!checked)}
                    />
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={8}>
                  Send to agent when dragged to this column
                </TooltipContent>
              </Tooltip>
            )}

            {/* Archive toggle — right of title, vertically centered */}
            {isDoneColumn && (
              <div className="ml-2 flex shrink-0 items-center gap-1.5">
                <Archive
                  className={cn(
                    'h-3 w-3',
                    showArchived ? 'text-muted-foreground' : 'text-muted-foreground/50'
                  )}
                />
                <Switch
                  data-testid="archive-toggle"
                  size="sm"
                  checked={showArchived}
                  onCheckedChange={handleToggleShowArchived}
                />
              </div>
            )}

            {/* Hidden measurement spans — inherit font styles via cascade; used
                by useLayoutEffect to decide titleMode. Absolute-positioned off-screen. */}
            {isInProgressColumn && (
              <span
                aria-hidden="true"
                className="pointer-events-none invisible absolute -left-[9999px] top-0 whitespace-nowrap"
              >
                <span
                  ref={fullTextMeasureRef}
                  className="text-xs font-semibold uppercase tracking-wider"
                >
                  In Progress
                </span>
                <span
                  ref={shortTextMeasureRef}
                  className="text-xs font-semibold uppercase tracking-wider"
                >
                  In Prog
                </span>
              </span>
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
          {tickets.length === 0 &&
          invalidPlaceholders.length === 0 &&
          !(isDoneColumn && showArchived && archivedTickets && archivedTickets.length > 0) ? (
            isDragOver ? (
              dropIndicator
            ) : /* Empty state: show the add-ticket card as the only item */
            isTodoColumn ? (
              <button
                data-testid="kanban-add-ticket-card"
                onClick={() => setIsCreateModalOpen(true)}
                className="flex items-center justify-center gap-1.5 rounded-md border border-dashed border-border/60 p-2 text-sm text-muted-foreground/60 hover:border-primary/40 hover:text-muted-foreground hover:bg-muted/20 transition-colors cursor-pointer"
              >
                <Plus className="h-4 w-4" />
                <span>New ticket</span>
              </button>
            ) : (
              <p className="px-2 py-4 text-center text-xs text-muted-foreground/60">No tickets</p>
            )
          ) : (
            <>
              {isTodoColumn && invalidPlaceholders.map((placeholder) => (
                <MarkdownInvalidCardPlaceholder
                  key={`${placeholder.projectId}:${placeholder.filePath}`}
                  placeholder={placeholder}
                />
              ))}

              {tickets.map((ticket, index) => {
                const occurrenceKey = fallbackActiveCardIdentityKeys[index] ?? ticketKey(ticket.project_id, ticket.id)
                return (
                  <motion.div
                    key={occurrenceKey}
                    data-card-index={index}
                    layoutId={occurrenceKey}
                    layout
                    transition={isLayoutAnimationSuppressed() ? { duration: 0 } : CARD_LAYOUT_SPRING}
                  >
                    {isDragOver && dropIndex === index && dropIndicator}
                    <div
                      data-card-index={index}
                      className={
                        draggingTicketKey === ticketKey(ticket.project_id, ticket.id)
                          ? 'h-0 min-h-0 overflow-hidden'
                          : undefined
                      }
                    >
                      <KanbanTicketCard
                        ticket={ticket}
                        index={index}
                        connectionId={connectionId}
                        isPinnedMode={isPinnedMode}
                        cardIdentityKey={occurrenceKey}
                      />
                    </div>
                  </motion.div>
                )
              })}
              {isDragOver && dropIndex === tickets.length && dropIndicator}

              {/* Archived tickets (Done column, toggle ON) */}
              {isDoneColumn && showArchived && archivedTickets && archivedTickets.length > 0 && (
                <>
                  <div className="flex items-center gap-2 px-2 py-1">
                    <div className="flex-1 border-t border-border/40" />
                    <span className="text-[10px] font-medium text-muted-foreground/50 uppercase tracking-wider">
                      Archived
                    </span>
                    <div className="flex-1 border-t border-border/40" />
                  </div>
                  {archivedTickets.map((ticket, index) => {
                    const occurrenceKey = fallbackArchivedCardIdentityKeys?.[index] ?? ticketKey(ticket.project_id, ticket.id)
                    return (
                      <div key={occurrenceKey}>
                        <KanbanTicketCard
                          ticket={ticket}
                          index={-1}
                          isArchived
                          connectionId={connectionId}
                          isPinnedMode={isPinnedMode}
                          cardIdentityKey={occurrenceKey}
                        />
                      </div>
                    )
                  })}
                </>
              )}

              {/* Add-ticket card at the end of the To Do column */}
              {isTodoColumn && (
                <button
                  data-testid="kanban-add-ticket-card"
                  onClick={() => setIsCreateModalOpen(true)}
                  className="flex items-center justify-center gap-1.5 rounded-md border border-dashed border-border/60 p-2 text-sm text-muted-foreground/60 hover:border-primary/40 hover:text-muted-foreground hover:bg-muted/20 transition-colors cursor-pointer"
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
          isPinnedMode={isPinnedMode}
        />
      )}

      {/* Worktree picker modal — for In Progress column drops */}
      {isInProgressColumn && worktreePickerTicket && (
        <WorktreePickerModal
          ticket={worktreePickerTicket}
          projectId={isMultiProjectMode ? worktreePickerTicket.project_id : projectId}
          open={true}
          onOpenChange={(open) => {
            if (!open) setWorktreePickerTicket(null)
          }}
          connectionId={connectionId}
        />
      )}

      {/* Worktree picker modal — save-config-only for blocked tickets */}
      {saveConfigTicket && (
        <WorktreePickerModal
          ticket={saveConfigTicket}
          projectId={saveConfigTicket.project_id}
          open={!!saveConfigTicket}
          onOpenChange={(open) => {
            if (!open) setSaveConfigTicket(null)
          }}
          saveConfigOnly
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
        <AlertDialog open={showArchiveAllConfirm} onOpenChange={setShowArchiveAllConfirm}>
          <AlertDialogContent data-testid="archive-all-confirm-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle>Archive all done tickets?</AlertDialogTitle>
              <AlertDialogDescription>
                Archive all {tickets.length} ticket{tickets.length !== 1 ? 's' : ''} in Done?
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="archive-all-cancel-btn">Cancel</AlertDialogCancel>
              <AlertDialogAction data-testid="archive-all-confirm-btn" onClick={handleArchiveAll}>
                Archive all
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  )
}

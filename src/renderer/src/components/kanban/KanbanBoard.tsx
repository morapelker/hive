import { useCallback, useEffect, useRef, useState } from 'react'
import { LayoutGroup, motion } from 'motion/react'
import { Pin } from 'lucide-react'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { usePinnedStore } from '@/stores/usePinnedStore'
import { useBoardChatStore } from '@/stores/useBoardChatStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { KanbanColumn } from '@/components/kanban/KanbanColumn'
import { KanbanTicketModal } from '@/components/kanban/KanbanTicketModal'
import { BoardChatLauncher } from '@/components/kanban/BoardChatLauncher'
import { MergeOnDoneDialog } from './MergeOnDoneDialog'
import { toast } from '@/lib/toast'
import type { KanbanTicketColumn } from '../../../../main/db/types'

const COLUMNS: KanbanTicketColumn[] = ['todo', 'in_progress', 'review', 'done']

interface KanbanBoardProps {
  projectId?: string
  projectPath?: string
  connectionId?: string
  isPinnedMode?: boolean
}

export function KanbanBoard({ projectId, projectPath, connectionId, isPinnedMode }: KanbanBoardProps) {
  const loadTickets = useKanbanStore((state) => state.loadTickets)
  const loadTicketsForConnection = useKanbanStore((state) => state.loadTicketsForConnection)
  const loadTicketsForPinnedProjects = useKanbanStore((state) => state.loadTicketsForPinnedProjects)
  const getTicketsByColumn = useKanbanStore((state) => state.getTicketsByColumn)
  const getTicketsByColumnForConnection = useKanbanStore((state) => state.getTicketsByColumnForConnection)
  const getTicketsByColumnForPinned = useKanbanStore((state) => state.getTicketsByColumnForPinned)
  const getArchivedTicketsByColumn = useKanbanStore((state) => state.getArchivedTicketsByColumn)
  const getConnectionProjectIds = useKanbanStore((state) => state.getConnectionProjectIds)
  const getPinnedProjectIdsArray = useKanbanStore((state) => state.getPinnedProjectIdsArray)
  const pinnedProjectIds = usePinnedStore((state) => state.pinnedProjectIds)
  const boardChatStatus = useBoardChatStore((state) => {
    if (!projectId) return 'idle'
    const key = `project:${projectId}`
    if (state.activeScopeKey === key) return state.status
    return state.snapshots[key]?.status ?? 'idle'
  })
  const boardAssistantByProject = useSessionStore((state) => state.boardAssistantByProject)
  const createBoardAssistantSession = useSessionStore((s) => s.createBoardAssistantSession)
  const focusBoardAssistantSession = useSessionStore((s) => s.focusBoardAssistantSession)

  // Dependency mode subscriptions
  const dependencyMode = useKanbanStore((state) => state.dependencyMode)
  const exitDependencyMode = useKanbanStore((state) => state.exitDependencyMode)
  const addDependency = useKanbanStore((state) => state.addDependency)
  const removeDependency = useKanbanStore((state) => state.removeDependency)
  const dependencyMap = useKanbanStore((state) => state.dependencyMap)
  const hoveredBlockedTicketId = useKanbanStore((state) => state.hoveredBlockedTicketId)

  // Subscribe to the multi-project archive toggle ('' key used by pinned/connection boards)
  const showArchivedAll = useKanbanStore(
    useCallback((s) => s.showArchivedByProject[''] ?? false, [])
  )

  // Derived: source ticket title for dependency mode overlay
  const sourceTicketTitle = useKanbanStore(
    useCallback((state) => {
      if (!dependencyMode?.sourceTicketId) return ''
      for (const [, projectTickets] of state.tickets) {
        const found = projectTickets.find(t => t.id === dependencyMode.sourceTicketId)
        if (found) return found.title
      }
      return ''
    }, [dependencyMode?.sourceTicketId])
  )

  // Ref for board container (SVG line rendering)
  const boardRef = useRef<HTMLDivElement>(null)

  // SVG dependency line state
  const [svgPaths, setSvgPaths] = useState<Array<{ key: string; d: string }>>([])
  const [svgSize, setSvgSize] = useState({ width: 0, height: 0 })

  useKanbanStore((state) => state.tickets)

  const isConnectionMode = !!connectionId

  useEffect(() => {
    if (isPinnedMode) {
      loadTicketsForPinnedProjects()
    } else if (isConnectionMode) {
      loadTicketsForConnection(connectionId)
    } else if (projectId) {
      loadTickets(projectId)
    }
  }, [projectId, connectionId, isConnectionMode, isPinnedMode, pinnedProjectIds, showArchivedAll, loadTickets, loadTicketsForConnection, loadTicketsForPinnedProjects])

  // ESC key handler for dependency mode
  useEffect(() => {
    if (!dependencyMode?.active) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') exitDependencyMode()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [dependencyMode?.active, exitDependencyMode])

  // Click handler for toggling dependencies during dependency mode
  const handleBoardClick = useCallback((e: React.MouseEvent) => {
    if (!dependencyMode?.active || !dependencyMode.sourceTicketId) return

    // Find the closest ticket card element
    const ticketEl = (e.target as HTMLElement).closest('[data-ticket-id]')
    if (!ticketEl) return

    const targetTicketId = ticketEl.getAttribute('data-ticket-id')
    if (!targetTicketId || targetTicketId === dependencyMode.sourceTicketId) return

    // Same-project check: only allow dependencies within the same project
    const sourceTicket = (() => {
      for (const [, projectTickets] of useKanbanStore.getState().tickets) {
        const found = projectTickets.find(t => t.id === dependencyMode.sourceTicketId)
        if (found) return found
      }
      return null
    })()

    const targetTicket = (() => {
      for (const [, projectTickets] of useKanbanStore.getState().tickets) {
        const found = projectTickets.find(t => t.id === targetTicketId)
        if (found) return found
      }
      return null
    })()

    if (!sourceTicket || !targetTicket || sourceTicket.project_id !== targetTicket.project_id) {
      return // Different projects — ignore click
    }

    e.stopPropagation()
    e.preventDefault()

    // Toggle: if already a dep, remove; otherwise add
    const existingBlockers = dependencyMap.get(dependencyMode.sourceTicketId)
    if (existingBlockers?.has(targetTicketId)) {
      removeDependency(dependencyMode.sourceTicketId, targetTicketId)
    } else {
      addDependency(dependencyMode.sourceTicketId, targetTicketId).then(result => {
        if (!result.success && result.error) {
          toast.error(result.error)
        }
      })
    }
  }, [dependencyMode, dependencyMap, addDependency, removeDependency])

  // Compute SVG bezier paths between dependent tickets
  const computePaths = useCallback(() => {
    if (!boardRef.current) return

    const activeTicketId = hoveredBlockedTicketId || (dependencyMode?.active ? dependencyMode.sourceTicketId : null)
    if (!activeTicketId) {
      setSvgPaths([])
      return
    }

    const boardRect = boardRef.current.getBoundingClientRect()
    setSvgSize({ width: boardRect.width, height: boardRect.height })

    // Get blocker IDs for this ticket
    const blockerIds = dependencyMap.get(activeTicketId)
    if (!blockerIds?.size) {
      setSvgPaths([])
      return
    }

    const sourceEl = boardRef.current.querySelector(`[data-ticket-id="${activeTicketId}"]`)
    if (!sourceEl) {
      setSvgPaths([])
      return
    }

    const sourceRect = sourceEl.getBoundingClientRect()
    const sourceCx = sourceRect.left + sourceRect.width / 2 - boardRect.left
    const sy = sourceRect.top + sourceRect.height / 2 - boardRect.top

    const paths: Array<{ key: string; d: string }> = []

    for (const blockerId of blockerIds) {
      const targetEl = boardRef.current.querySelector(`[data-ticket-id="${blockerId}"]`)
      if (!targetEl) continue

      const targetRect = targetEl.getBoundingClientRect()
      const targetCx = targetRect.left + targetRect.width / 2 - boardRect.left
      const ty = targetRect.top + targetRect.height / 2 - boardRect.top

      let sx: number, tx: number, d: string

      // Treat tickets as same-column when their centers are within half a card-width
      const SAME_COLUMN_THRESHOLD_PX = 50
      if (Math.abs(sourceCx - targetCx) < SAME_COLUMN_THRESHOLD_PX) {
        // Same-column case: both endpoints exit from the left edge, arc leftward
        sx = sourceRect.left - boardRect.left
        tx = targetRect.left - boardRect.left
        // Arc depth: at least 40px, scaling to 40% of vertical distance
        const offset = Math.max(40, Math.abs(ty - sy) * 0.4)
        d = `M ${sx},${sy} C ${sx - offset},${sy} ${tx - offset},${ty} ${tx},${ty}`
      } else {
        // Use the closest side: if target is to the right, exit from source's right → target's left
        sx = targetCx > sourceCx
          ? sourceRect.right - boardRect.left
          : sourceRect.left - boardRect.left
        tx = targetCx > sourceCx
          ? targetRect.left - boardRect.left
          : targetRect.right - boardRect.left

        // Cubic bezier with horizontal-aware control points
        const cx = (sx + tx) / 2
        d = `M ${sx},${sy} C ${cx},${sy} ${cx},${ty} ${tx},${ty}`
      }

      paths.push({ key: `${activeTicketId}-${blockerId}`, d })
    }

    setSvgPaths(paths)
  }, [hoveredBlockedTicketId, dependencyMode, dependencyMap])

  // Recompute paths when relevant state changes
  useEffect(() => {
    computePaths()
  }, [computePaths])

  // Recompute on scroll
  useEffect(() => {
    const el = boardRef.current
    if (!el) return
    const handler = () => computePaths()
    el.addEventListener('scroll', handler)
    return () => el.removeEventListener('scroll', handler)
  }, [computePaths])

  // Aggregate archived tickets across all connection member projects for the done column
  const connectionArchivedDoneTickets = isConnectionMode
    ? getConnectionProjectIds(connectionId!).flatMap((pid) => getArchivedTicketsByColumn(pid, 'done'))
    : undefined

  const pinnedProjectIdsArray = isPinnedMode ? getPinnedProjectIdsArray() : []

  const pinnedArchivedDoneTickets = isPinnedMode
    ? pinnedProjectIdsArray.flatMap((pid) => getArchivedTicketsByColumn(pid, 'done'))
    : undefined

  return (
    <LayoutGroup>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {dependencyMode?.active && (
          <>
            {/* Dark overlay */}
            <div className="fixed inset-0 bg-black/40 z-30 pointer-events-none" />
            {/* Floating instruction bar — no-drag overrides Electron header drag region */}
            <div
              className="fixed top-4 left-1/2 -translate-x-1/2 z-50 bg-card border border-border rounded-lg shadow-lg px-4 py-2 flex items-center gap-3"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            >
              <span className="text-sm">
                Selecting dependencies for: <strong>{sourceTicketTitle}</strong> — click tickets to toggle
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  exitDependencyMode()
                }}
                className="px-3 py-1 text-sm font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
              >
                Done
              </button>
            </div>
          </>
        )}
        {isPinnedMode && (
          <div className="flex items-center gap-2 px-3 pt-3 pb-0">
            <Pin className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-medium text-muted-foreground">
              Pinned Projects ({pinnedProjectIdsArray.length})
            </h2>
          </div>
        )}
        {/* Columns */}
        {isPinnedMode && pinnedProjectIdsArray.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <Pin className="h-8 w-8 mx-auto mb-3 opacity-50" />
              <p className="text-sm">Pin worktrees to see their projects here</p>
            </div>
          </div>
        ) : (
          <motion.div
            ref={boardRef}
            layoutScroll
            data-testid="kanban-board"
            className="flex flex-1 min-h-0 gap-3 overflow-x-auto p-3"
            onClick={handleBoardClick}
          >
            {COLUMNS.map((column) => {
              const tickets = isPinnedMode
                ? getTicketsByColumnForPinned(column)
                : isConnectionMode
                  ? getTicketsByColumnForConnection(connectionId, column)
                  : projectId
                    ? getTicketsByColumn(projectId, column)
                    : []

              const archivedTickets = column === 'done'
                ? isPinnedMode
                  ? pinnedArchivedDoneTickets
                  : isConnectionMode
                    ? connectionArchivedDoneTickets
                    : projectId
                      ? getArchivedTicketsByColumn(projectId, 'done')
                      : undefined
                : undefined

              return (
                <KanbanColumn
                  key={column}
                  column={column}
                  tickets={tickets}
                  archivedTickets={archivedTickets}
                  projectId={projectId ?? ''}
                  connectionId={connectionId}
                  isPinnedMode={isPinnedMode}
                />
              )
            })}
            <KanbanTicketModal />
            <MergeOnDoneDialog />
            {/* SVG dependency lines */}
            {svgPaths.length > 0 && (
              <svg
                className="absolute inset-0 pointer-events-none z-25"
                width={svgSize.width}
                height={svgSize.height}
                style={{ overflow: 'visible' }}
              >
                {svgPaths.map(({ key, d }) => (
                  <path
                    key={key}
                    d={d}
                    stroke="rgb(245, 158, 11)"
                    strokeWidth="2"
                    fill="none"
                    strokeDasharray="6 3"
                    opacity="0.7"
                  />
                ))}
              </svg>
            )}
          </motion.div>
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-end p-4">
          <BoardChatLauncher
            disabled={Boolean(isPinnedMode) || !projectId}
            disabledReason={
              isPinnedMode
                ? 'Board Assistant is not available on pinned multi-project boards yet.'
                : !projectId
                  ? 'No project selected.'
                  : undefined
            }
            onClick={() => {
              if (!projectId) return
              const existing = boardAssistantByProject.get(projectId)
              if (existing) {
                focusBoardAssistantSession(projectId)
              } else {
                void createBoardAssistantSession(projectId)
              }
            }}
            status={boardChatStatus}
          />
        </div>
      </div>
    </LayoutGroup>
  )
}

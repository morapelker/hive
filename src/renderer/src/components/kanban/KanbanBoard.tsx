import { useCallback, useEffect } from 'react'
import { LayoutGroup, motion } from 'motion/react'
import { Pin } from 'lucide-react'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { usePinnedStore } from '@/stores/usePinnedStore'
import { KanbanColumn } from '@/components/kanban/KanbanColumn'
import { KanbanTicketModal } from '@/components/kanban/KanbanTicketModal'
import { MergeOnDoneDialog } from './MergeOnDoneDialog'
import type { KanbanTicketColumn } from '../../../../main/db/types'

const COLUMNS: KanbanTicketColumn[] = ['todo', 'in_progress', 'review', 'done']

interface KanbanBoardProps {
  projectId?: string
  projectPath?: string
  connectionId?: string
  isPinnedMode?: boolean
}

export function KanbanBoard({ projectId, projectPath: _projectPath, connectionId, isPinnedMode }: KanbanBoardProps) {
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

  // Subscribe to the multi-project archive toggle ('' key used by pinned/connection boards)
  const showArchivedAll = useKanbanStore(
    useCallback((s) => s.showArchivedByProject[''] ?? false, [])
  )

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
      <div className="flex flex-1 flex-col min-h-0">
        {isPinnedMode && (
          <div className="flex items-center gap-2 px-4 pt-3 pb-0">
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
            layoutScroll
            data-testid="kanban-board"
            className="flex flex-1 min-h-0 gap-4 overflow-x-auto p-4"
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
          </motion.div>
        )}
      </div>
    </LayoutGroup>
  )
}

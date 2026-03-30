import { useEffect } from 'react'
import { LayoutGroup, motion } from 'motion/react'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { KanbanColumn } from '@/components/kanban/KanbanColumn'
import { KanbanTicketModal } from '@/components/kanban/KanbanTicketModal'
import type { KanbanTicketColumn } from '../../../../main/db/types'

const COLUMNS: KanbanTicketColumn[] = ['todo', 'in_progress', 'review', 'done']

interface KanbanBoardProps {
  projectId?: string
  projectPath?: string
  connectionId?: string
}

export function KanbanBoard({ projectId, projectPath: _projectPath, connectionId }: KanbanBoardProps) {
  const loadTickets = useKanbanStore((state) => state.loadTickets)
  const loadTicketsForConnection = useKanbanStore((state) => state.loadTicketsForConnection)
  const getTicketsByColumn = useKanbanStore((state) => state.getTicketsByColumn)
  const getTicketsByColumnForConnection = useKanbanStore((state) => state.getTicketsByColumnForConnection)
  const getArchivedTicketsByColumn = useKanbanStore((state) => state.getArchivedTicketsByColumn)
  const getConnectionProjectIds = useKanbanStore((state) => state.getConnectionProjectIds)

  useKanbanStore((state) => state.tickets)

  const isConnectionMode = !!connectionId

  useEffect(() => {
    if (isConnectionMode) {
      loadTicketsForConnection(connectionId)
    } else if (projectId) {
      loadTickets(projectId)
    }
  }, [projectId, connectionId, isConnectionMode, loadTickets, loadTicketsForConnection])

  // Aggregate archived tickets across all connection member projects for the done column
  const connectionArchivedDoneTickets = isConnectionMode
    ? getConnectionProjectIds(connectionId!).flatMap((pid) => getArchivedTicketsByColumn(pid, 'done'))
    : undefined

  return (
    <LayoutGroup>
      <div className="flex flex-1 flex-col min-h-0">
        {/* Columns */}
        <motion.div
          layoutScroll
          data-testid="kanban-board"
          className="flex flex-1 min-h-0 gap-4 overflow-x-auto p-4"
        >
          {COLUMNS.map((column) => {
            const tickets = isConnectionMode
              ? getTicketsByColumnForConnection(connectionId, column)
              : projectId
                ? getTicketsByColumn(projectId, column)
                : []

            const archivedTickets = column === 'done'
              ? isConnectionMode
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
              />
            )
          })}
          <KanbanTicketModal />
        </motion.div>
      </div>
    </LayoutGroup>
  )
}

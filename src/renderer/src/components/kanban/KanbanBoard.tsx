import { useEffect } from 'react'
import { LayoutGroup, motion } from 'motion/react'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { KanbanColumn } from '@/components/kanban/KanbanColumn'
import { KanbanTicketModal } from '@/components/kanban/KanbanTicketModal'
import type { KanbanTicketColumn } from '../../../../main/db/types'

const COLUMNS: KanbanTicketColumn[] = ['todo', 'in_progress', 'review', 'done']

interface KanbanBoardProps {
  projectId: string
}

export function KanbanBoard({ projectId }: KanbanBoardProps) {
  const loadTickets = useKanbanStore((state) => state.loadTickets)
  const getTicketsByColumn = useKanbanStore((state) => state.getTicketsByColumn)
  const getArchivedTicketsByColumn = useKanbanStore((state) => state.getArchivedTicketsByColumn)

  // Trigger a re-render when the tickets map changes
  useKanbanStore((state) => state.tickets)

  // Load tickets on mount and when projectId changes
  useEffect(() => {
    loadTickets(projectId)
  }, [projectId, loadTickets])

  return (
    <LayoutGroup>
      <motion.div
        layoutScroll
        data-testid="kanban-board"
        className="flex flex-1 min-h-0 gap-4 overflow-x-auto p-4"
      >
        {COLUMNS.map((column) => (
          <KanbanColumn
            key={column}
            column={column}
            tickets={getTicketsByColumn(projectId, column)}
            archivedTickets={column === 'done' ? getArchivedTicketsByColumn(projectId, 'done') : undefined}
            projectId={projectId}
          />
        ))}
        <KanbanTicketModal />
      </motion.div>
    </LayoutGroup>
  )
}

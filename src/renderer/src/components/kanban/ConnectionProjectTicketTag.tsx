import { cn } from '@/lib/utils'
import {
  ConnectionMembersTooltip,
  ConnectionProjectIcon
} from '@/components/projects/ConnectionProjectIcon'
import { useConnectionIconMembers } from '@/hooks/useConnectionProjectIcon'
import { ticketPillClass } from './pill'

interface ConnectionProjectTicketTagProps {
  /** Id of the connection project the ticket belongs to. */
  projectId: string
  name: string
  /** The project's tag color on this board (the dot every project tag carries). */
  color: string
}

/**
 * Project tag of a connection project's ticket on a multi-project board: the usual color dot
 * (it groups a project's cards at a glance), then the project's member icons, then its name.
 * Hovering lists every member. With no member icon to show it is the plain dot + name tag.
 */
export function ConnectionProjectTicketTag({
  projectId,
  name,
  color
}: ConnectionProjectTicketTagProps): React.JSX.Element {
  const hasMembers = useConnectionIconMembers(projectId).length > 0

  return (
    <ConnectionMembersTooltip projectId={projectId}>
      <span
        data-testid="kanban-ticket-connection-project-tag"
        className={cn(ticketPillClass, hasMembers && 'cursor-help')}
      >
        <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
        <ConnectionProjectIcon
          projectId={projectId}
          layout="strip"
          data-testid="kanban-ticket-project-icon-stack"
        />
        {name}
      </span>
    </ConnectionMembersTooltip>
  )
}

import { useMemo, useState } from 'react'
import { useConnectionStore } from '@/stores'
import { sortInstancesBaseLast } from '@/lib/connection-project'
import { ConnectionItem } from '@/components/connections/ConnectionItem'
import { ManageConnectionWorktreesDialog } from '@/components/connections/ManageConnectionWorktreesDialog'

interface ConnectionInstanceListProps {
  projectId: string
}

/**
 * The expanded body of a connection project (projects.kind === 'connection')
 * in the sidebar: its live connection instances — one per active worktree set —
 * rendered with the same cards as the Connections section. The base instance
 * (member default worktrees) sits last, like a project's default worktree.
 */
export function ConnectionInstanceList({
  projectId
}: ConnectionInstanceListProps): React.JSX.Element {
  const connections = useConnectionStore((s) => s.connections)
  const instances = useMemo(
    () => sortInstancesBaseLast(connections.filter((c) => c.saved_project_id === projectId)),
    [connections, projectId]
  )

  const [manageConnectionId, setManageConnectionId] = useState<string | null>(null)

  if (instances.length === 0) {
    return (
      <div
        className="px-3 py-1.5 text-[11px] text-muted-foreground"
        data-testid={`connection-instance-empty-${projectId}`}
      >
        No active connections — launch a ticket to create one
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5" data-testid={`connection-instance-list-${projectId}`}>
      {instances.map((connection) => (
        <ConnectionItem
          key={connection.id}
          connection={connection}
          onManageWorktrees={setManageConnectionId}
        />
      ))}

      {manageConnectionId && (
        <ManageConnectionWorktreesDialog
          connectionId={manageConnectionId}
          open={!!manageConnectionId}
          onOpenChange={(open) => {
            if (!open) setManageConnectionId(null)
          }}
        />
      )}
    </div>
  )
}

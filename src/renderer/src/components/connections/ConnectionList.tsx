import { useEffect, useState, useCallback } from 'react'
import { ChevronRight, Link } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useConnectionStore } from '@/stores'
import { ConnectionItem } from './ConnectionItem'
import { ManageConnectionWorktreesDialog } from './ManageConnectionWorktreesDialog'

export function ConnectionList(): React.JSX.Element | null {
  const connections = useConnectionStore((s) => s.connections)
  const loadConnections = useConnectionStore((s) => s.loadConnections)
  const [isCollapsed, setIsCollapsed] = useState(false)

  // State for managing worktrees of an existing connection
  const [manageConnectionId, setManageConnectionId] = useState<string | null>(null)

  useEffect(() => {
    loadConnections()
  }, [loadConnections])

  const handleManageWorktrees = useCallback((connectionId: string) => {
    setManageConnectionId(connectionId)
  }, [])

  const handleCloseManageDialog = useCallback(() => {
    setManageConnectionId(null)
  }, [])

  const connectionModeActive = useConnectionStore((s) => s.connectionModeActive)

  if (connections.length === 0 || connectionModeActive) {
    return null
  }

  return (
    <div data-testid="connection-list" className="mb-2">
      {/* Section header */}
      <button
        className="flex items-center gap-1 w-full px-2 py-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
        onClick={() => setIsCollapsed(!isCollapsed)}
        data-testid="connections-section-header"
      >
        <ChevronRight className={cn('h-3 w-3 transition-transform', !isCollapsed && 'rotate-90')} />
        <Link className="h-3 w-3" />
        <span>Connections</span>
        <span className="ml-auto text-[10px] tabular-nums">{connections.length}</span>
      </button>

      {/* Connection items */}
      {!isCollapsed && (
        <div className="mt-0.5 space-y-0.5" data-testid="connections-list-items">
          {connections.map((connection) => (
            <ConnectionItem
              key={connection.id}
              connection={connection}
              onManageWorktrees={handleManageWorktrees}
            />
          ))}
        </div>
      )}

      {/* Manage connection worktrees dialog */}
      {manageConnectionId && (
        <ManageConnectionWorktreesDialog
          connectionId={manageConnectionId}
          open={!!manageConnectionId}
          onOpenChange={(open) => {
            if (!open) handleCloseManageDialog()
          }}
        />
      )}
    </div>
  )
}

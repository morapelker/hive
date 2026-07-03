import { useState, useEffect, useCallback } from 'react'
import { Loader2, Link } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useConnectionStore } from '@/stores'
import { connectionApi } from '@/api/connection-api'
import { formatRelativeTime } from '@/lib/format-utils'
import type { RecentConnectionEntry } from '@shared/types/connection'

interface RecentConnectionsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function RecentConnectionsDialog({
  open,
  onOpenChange
}: RecentConnectionsDialogProps): React.JSX.Element {
  const quickCreateConnection = useConnectionStore((s) => s.quickCreateConnection)

  const [entries, setEntries] = useState<RecentConnectionEntry[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return

    setSelectedId(null)
    setIsCreating(false)
    setError(null)
    setIsLoading(true)

    connectionApi
      .getRecentConnections()
      .then((result) => {
        if (result.success) {
          setEntries(result.entries ?? [])
        } else {
          setEntries([])
          setError(result.error || 'Failed to load recent connections')
        }
      })
      .catch((err) => {
        setEntries([])
        setError(err instanceof Error ? err.message : 'Failed to load recent connections')
      })
      .finally(() => {
        setIsLoading(false)
      })
  }, [open])

  const handleCreate = useCallback(async () => {
    const entry = entries.find((e) => e.id === selectedId)
    if (!entry) return

    setIsCreating(true)
    try {
      const id = await quickCreateConnection(entry.projects)
      if (id) {
        onOpenChange(false)
      }
    } finally {
      setIsCreating(false)
    }
  }, [entries, selectedId, quickCreateConnection, onOpenChange])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="recent-connections-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link className="h-4 w-4" />
            Recent Connections
          </DialogTitle>
          <DialogDescription>
            Recreate a connection with fresh worktrees in each project.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[300px] overflow-y-auto border rounded-md">
          {error ? (
            <div
              className="px-4 py-8 text-center text-sm text-destructive"
              data-testid="recent-connections-error"
            >
              {error}
            </div>
          ) : !isLoading && entries.length === 0 ? (
            <div
              className="px-4 py-8 text-center text-sm text-muted-foreground"
              data-testid="recent-connections-empty"
            >
              No recent connections yet. Create one by right-clicking a worktree and choosing
              Connect to…
            </div>
          ) : (
            <div className="py-1">
              {entries.map((entry) => (
                <button
                  key={entry.id}
                  className={cn(
                    'flex flex-col w-full px-3 py-2 text-sm text-left',
                    'hover:bg-accent/50 transition-colors',
                    selectedId === entry.id && 'bg-accent/30'
                  )}
                  onClick={() => setSelectedId(entry.id)}
                  data-testid={`recent-connection-row-${entry.id}`}
                >
                  <span className="truncate">{entry.projects.map((p) => p.name).join(' + ')}</span>
                  <span className="text-xs text-muted-foreground truncate">
                    {formatRelativeTime(Date.parse(entry.last_used_at))}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            onClick={handleCreate}
            disabled={!selectedId || isCreating}
            data-testid="recent-connections-create-button"
          >
            {isCreating ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Creating...
              </>
            ) : (
              <>
                <Link className="h-4 w-4 mr-2" />
                Create
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

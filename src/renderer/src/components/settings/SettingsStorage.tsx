import { useEffect, useState } from 'react'
import { Database, RefreshCw, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { unwrapEnvelope } from '@/lib/ipc-envelope'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'

type EnvelopeValue<T> =
  T extends Promise<infer Envelope>
    ? Envelope extends { success: true; value: infer Value }
      ? Value
      : never
    : never

type StorageStatsState = EnvelopeValue<ReturnType<Window['storageOps']['getStats']>>
type CompactionPreviewState = EnvelopeValue<ReturnType<Window['storageOps']['previewCompaction']>>

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** exponent
  const digits = value >= 10 || exponent === 0 ? 0 : 1
  return `${value.toFixed(digits)} ${units[exponent]}`
}

function BreakdownRow({
  label,
  detail,
  value
}: {
  label: string
  detail: string
  value: string
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">{detail}</div>
      </div>
      <div className="shrink-0 text-sm font-medium tabular-nums">{value}</div>
    </div>
  )
}

export function SettingsStorage(): React.JSX.Element {
  const [stats, setStats] = useState<StorageStatsState | null>(null)
  const [preview, setPreview] = useState<CompactionPreviewState | null>(null)
  const [loadingStats, setLoadingStats] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [compacting, setCompacting] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)

  const loadStats = async (): Promise<void> => {
    setLoadingStats(true)
    try {
      setStats(unwrapEnvelope(await window.storageOps.getStats()))
    } catch (error) {
      toast.error('Failed to load storage stats', {
        description: error instanceof Error ? error.message : String(error)
      })
    } finally {
      setLoadingStats(false)
    }
  }

  useEffect(() => {
    void loadStats()
  }, [])

  const handleAnalyze = async (): Promise<void> => {
    setAnalyzing(true)
    try {
      const nextPreview = unwrapEnvelope(await window.storageOps.previewCompaction())
      setPreview(nextPreview)
      setDialogOpen(true)
    } catch (error) {
      toast.error('Failed to analyze database', {
        description: error instanceof Error ? error.message : String(error)
      })
    } finally {
      setAnalyzing(false)
    }
  }

  const handleCompact = async (): Promise<void> => {
    setCompacting(true)
    try {
      const result = unwrapEnvelope(await window.storageOps.compact())
      toast.success(
        `Database compressed: saved ${formatBytes(result.savedBytes)}; new size ${formatBytes(
          result.afterBytes
        )}`
      )
      setDialogOpen(false)
      setPreview(null)
      await loadStats()
    } catch (error) {
      toast.error('Database compression failed', {
        description: error instanceof Error ? error.message : String(error)
      })
    } finally {
      setCompacting(false)
    }
  }

  const estimatedSavedBytes = preview?.estimatedSavedBytes ?? 0
  const canCompact = estimatedSavedBytes > 0 && !compacting

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-medium mb-1">Storage</h3>
        <p className="text-sm text-muted-foreground">Manage Hive database storage</p>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <Database className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <div className="text-sm font-medium">Hive database</div>
              <div className="text-xs text-muted-foreground">
                {stats
                  ? `${formatBytes(stats.dbFileBytes)} DB, ${formatBytes(
                      stats.walFileBytes
                    )} WAL, ${formatBytes(
                      stats.freeBytes
                    )} free pages`
                  : loadingStats
                    ? 'Loading...'
                    : 'Size unavailable'}
              </div>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={loadStats} disabled={loadingStats}>
            <RefreshCw className={cn('h-3.5 w-3.5', loadingStats && 'animate-spin')} />
            Refresh
          </Button>
        </div>

        {stats && (
          <div className="grid grid-cols-3 gap-3 text-xs">
            <div>
              <div className="text-muted-foreground">DB</div>
              <div className="font-medium tabular-nums">{formatBytes(stats.dbFileBytes)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">WAL</div>
              <div className="font-medium tabular-nums">{formatBytes(stats.walFileBytes)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Pages</div>
              <div className="font-medium tabular-nums">{stats.pageCount.toLocaleString()}</div>
            </div>
          </div>
        )}
      </div>

      <div className="border-t pt-4">
        <Button
          variant="outline"
          size="sm"
          onClick={handleAnalyze}
          disabled={analyzing || compacting}
          data-testid="storage-analyze"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', analyzing && 'animate-spin')} />
          {analyzing ? 'Analyzing...' : 'Analyze'}
        </Button>
      </div>

      <AlertDialog open={dialogOpen} onOpenChange={(open) => !compacting && setDialogOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Compress DB</AlertDialogTitle>
            <AlertDialogDescription>
              Preview estimate for data that can be pruned and disk pages that can be reclaimed.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {preview && (
            <div className="divide-y rounded-md border px-3">
              <BreakdownRow
                label="Orphaned records"
                detail={`${preview.orphaned.rows.messages.toLocaleString()} messages, ${preview.orphaned.rows.activities.toLocaleString()} activities`}
                value={formatBytes(preview.orphaned.bytes)}
              />
              <BreakdownRow
                label="Archived worktree sessions"
                detail={`${preview.archivedWorktrees.rows.sessions.toLocaleString()} sessions, ${preview.archivedWorktrees.rows.messages.toLocaleString()} messages, ${preview.archivedWorktrees.rows.activities.toLocaleString()} activities`}
                value={formatBytes(preview.archivedWorktrees.bytes)}
              />
              <BreakdownRow
                label="Reclaimable free space"
                detail="Free SQLite pages currently retained by the DB file"
                value={formatBytes(preview.reclaimableFreeBytes)}
              />
              <BreakdownRow
                label="Estimated saved"
                detail={estimatedSavedBytes > 0 ? 'Actual result is reported after VACUUM' : 'Already compact'}
                value={formatBytes(estimatedSavedBytes)}
              />
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={compacting}>Cancel</AlertDialogCancel>
            <Button onClick={handleCompact} disabled={!canCompact} data-testid="storage-compact">
              {compacting ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              {compacting ? 'Compressing...' : 'Compress'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

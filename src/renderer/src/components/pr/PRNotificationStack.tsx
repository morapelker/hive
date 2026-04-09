import { useCallback, useState } from 'react'
import { Loader2, Check, AlertCircle, AlertTriangle, Info, X, ExternalLink, GitMerge, Archive } from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePRNotificationStore } from '@/stores/usePRNotificationStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { toast } from '@/lib/toast'

// ---------------------------------------------------------------------------
// Status icon
// ---------------------------------------------------------------------------

function StatusIcon({ status }: { status: string }): React.JSX.Element {
  switch (status) {
    case 'loading':
      return <Loader2 className="h-4 w-4 animate-spin text-blue-400" />
    case 'success':
      return <Check className="h-4 w-4 text-emerald-400" />
    case 'error':
      return <AlertCircle className="h-4 w-4 text-red-400" />
    case 'warning':
      return <AlertTriangle className="h-4 w-4 text-amber-400" />
    case 'info':
      return <Info className="h-4 w-4 text-blue-400" />
    default:
      return <Loader2 className="h-4 w-4 animate-spin text-blue-400" />
  }
}

// ---------------------------------------------------------------------------
// Single notification card
// ---------------------------------------------------------------------------

type MergePhase = 'idle' | 'merging' | 'merged' | 'archiving'

function PRNotificationCard({
  id,
  status,
  message,
  description,
  prUrl,
  prNumber,
  worktreeId
}: {
  id: string
  status: string
  message: string
  description?: string
  prUrl?: string
  prNumber?: number
  worktreeId?: string
}): React.JSX.Element {
  const dismiss = usePRNotificationStore((s) => s.dismiss)
  const isDone = status === 'success' || status === 'error' || status === 'info' || status === 'warning'

  const [mergePhase, setMergePhase] = useState<MergePhase>('idle')
  const showMergeButton = !!(prNumber && worktreeId && (status === 'success' || status === 'info'))

  const handleClose = useCallback(() => {
    dismiss(id)
  }, [id, dismiss])

  const handleMerge = useCallback(async () => {
    if (!prNumber || !worktreeId) return

    // Resolve worktree path from store
    const worktreeStore = useWorktreeStore.getState()
    let worktreePath: string | null = null
    for (const worktrees of worktreeStore.worktreesByProject.values()) {
      const match = worktrees.find((w) => w.id === worktreeId)
      if (match) {
        worktreePath = match.path
        break
      }
    }
    if (!worktreePath) {
      toast.error('Worktree not found')
      return
    }

    setMergePhase('merging')
    try {
      const result = await window.gitOps.prMerge(worktreePath, prNumber)
      if (result.success) {
        setMergePhase('merged')
      } else {
        toast.error(`Merge failed: ${result.error}`)
        setMergePhase('idle')
      }
    } catch {
      toast.error('Failed to merge PR')
      setMergePhase('idle')
    }
  }, [prNumber, worktreeId])

  const handleArchive = useCallback(async () => {
    if (!worktreeId) return

    // Resolve worktree and project path from stores
    const worktreeStore = useWorktreeStore.getState()
    let worktree: { id: string; path: string; branch_name: string } | null = null
    let projectId: string | null = null
    for (const [projId, worktrees] of worktreeStore.worktreesByProject) {
      const match = worktrees.find((w) => w.id === worktreeId)
      if (match) {
        worktree = match
        projectId = projId
        break
      }
    }
    if (!worktree || !projectId) {
      toast.error('Worktree not found')
      return
    }

    const project = useProjectStore.getState().projects.find((p) => p.id === projectId)
    const projectPath = project?.path
    if (!projectPath) {
      toast.error('Project not found')
      return
    }

    setMergePhase('archiving')
    try {
      const result = await worktreeStore.archiveWorktree(
        worktreeId,
        worktree.path,
        worktree.branch_name,
        projectPath
      )
      if (result.success) {
        dismiss(id)
      } else {
        toast.error(result.error || 'Archive failed')
        setMergePhase('merged')
      }
    } catch {
      toast.error('Failed to archive worktree')
      setMergePhase('merged')
    }
  }, [worktreeId, id, dismiss])

  return (
    <div
      className={cn(
        // Layout
        'relative flex items-start gap-3 px-4 py-3 min-w-[300px] max-w-[380px]',
        // Glass morphism
        'rounded-xl border border-white/[0.08] shadow-xl shadow-black/20',
        'bg-background/70 backdrop-blur-xl backdrop-saturate-150',
        // Entry animation
        'animate-in slide-in-from-right-5 fade-in-0 duration-300',
        // Accent strip
        status === 'success' && 'border-l-2 border-l-emerald-500/60',
        status === 'error' && 'border-l-2 border-l-red-500/60',
        status === 'warning' && 'border-l-2 border-l-amber-500/60',
        status === 'info' && 'border-l-2 border-l-blue-500/60',
        status === 'loading' && 'border-l-2 border-l-blue-500/40'
      )}
    >
      {/* Icon */}
      <div className="mt-0.5 shrink-0">
        <StatusIcon status={status} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 space-y-1">
        <p className="text-sm font-medium text-foreground leading-snug">{message}</p>
        {description && (
          <p className="text-xs text-muted-foreground leading-snug line-clamp-2">
            {description}
          </p>
        )}
        {prUrl && isDone && (
          <a
            href={prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              'inline-flex items-center gap-1.5 mt-1 text-xs font-medium',
              'text-blue-400 hover:text-blue-300 transition-colors'
            )}
          >
            <ExternalLink className="h-3 w-3" />
            Open on GitHub
          </a>
        )}
        {showMergeButton && (
          <div className="mt-1.5">
            {mergePhase === 'idle' && (
              <button
                type="button"
                onClick={handleMerge}
                className={cn(
                  'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium',
                  'bg-emerald-600/10 border border-emerald-600/30 text-emerald-500',
                  'hover:bg-emerald-600/20 transition-colors'
                )}
              >
                <GitMerge className="h-3 w-3" />
                Merge PR
              </button>
            )}
            {mergePhase === 'merging' && (
              <button
                type="button"
                disabled
                className={cn(
                  'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium',
                  'bg-emerald-600/10 border border-emerald-600/30 text-emerald-500',
                  'opacity-60 cursor-not-allowed'
                )}
              >
                <Loader2 className="h-3 w-3 animate-spin" />
                Merging...
              </button>
            )}
            {mergePhase === 'merged' && (
              <button
                type="button"
                onClick={handleArchive}
                className={cn(
                  'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium',
                  'bg-secondary text-secondary-foreground',
                  'hover:bg-secondary/80 transition-colors'
                )}
              >
                <Archive className="h-3 w-3" />
                Archive
              </button>
            )}
            {mergePhase === 'archiving' && (
              <button
                type="button"
                disabled
                className={cn(
                  'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium',
                  'bg-secondary text-secondary-foreground',
                  'opacity-60 cursor-not-allowed'
                )}
              >
                <Loader2 className="h-3 w-3 animate-spin" />
                Archiving...
              </button>
            )}
          </div>
        )}
      </div>

      {/* Close button — always rendered but only visible when done */}
      {isDone && (
        <button
          type="button"
          onClick={handleClose}
          className={cn(
            'shrink-0 p-0.5 rounded-md -mt-0.5 -mr-1',
            'text-muted-foreground hover:text-foreground hover:bg-white/[0.06]',
            'transition-colors'
          )}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Stack — mounts once in AppLayout
// ---------------------------------------------------------------------------

export function PRNotificationStack(): React.JSX.Element | null {
  const notifications = usePRNotificationStore((s) => s.notifications)

  if (notifications.length === 0) return null

  return (
    <div
      className="absolute top-4 right-4 z-[60] flex flex-col gap-2 pointer-events-auto"
      data-testid="pr-notification-stack"
    >
      {notifications.map((n) => (
        <PRNotificationCard
          key={n.id}
          id={n.id}
          status={n.status}
          message={n.message}
          description={n.description}
          prUrl={n.prUrl}
          prNumber={n.prNumber}
          worktreeId={n.worktreeId}
        />
      ))}
    </div>
  )
}

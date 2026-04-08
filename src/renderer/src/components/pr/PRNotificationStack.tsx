import { useCallback } from 'react'
import { Loader2, Check, AlertCircle, AlertTriangle, Info, X, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePRNotificationStore } from '@/stores/usePRNotificationStore'

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

function PRNotificationCard({
  id,
  status,
  message,
  description,
  prUrl
}: {
  id: string
  status: string
  message: string
  description?: string
  prUrl?: string
}): React.JSX.Element {
  const dismiss = usePRNotificationStore((s) => s.dismiss)
  const isDone = status === 'success' || status === 'error' || status === 'info' || status === 'warning'

  const handleClose = useCallback(() => {
    dismiss(id)
  }, [id, dismiss])

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
        />
      ))}
    </div>
  )
}

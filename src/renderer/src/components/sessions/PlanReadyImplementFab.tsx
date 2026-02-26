import { cn } from '@/lib/utils'

interface PlanReadyImplementFabProps {
  onImplement: () => void
  onHandoff: () => void
  visible: boolean
  onSuperpowers?: () => void
  onSuperpowersLocal?: () => void
  superpowersAvailable?: boolean
  isConnectionSession?: boolean
}

export function PlanReadyImplementFab({
  onImplement,
  onHandoff,
  visible,
  onSuperpowers,
  onSuperpowersLocal,
  superpowersAvailable,
  isConnectionSession
}: PlanReadyImplementFabProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'absolute bottom-4 right-4 z-10',
        'flex items-center gap-2',
        'transition-all duration-200',
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2 pointer-events-none'
      )}
    >
      <button
        onClick={onHandoff}
        className={cn(
          'h-8 rounded-full px-3',
          'text-xs font-medium',
          'bg-muted/80 text-foreground border border-border',
          'shadow-md hover:bg-muted transition-colors duration-200',
          'cursor-pointer',
          visible ? 'opacity-100' : 'opacity-0'
        )}
        aria-label="Handoff plan"
        data-testid="plan-ready-handoff-fab"
      >
        Handoff
      </button>
      {superpowersAvailable && !isConnectionSession && onSuperpowersLocal && (
        <button
          onClick={onSuperpowersLocal}
          className={cn(
            'h-8 rounded-full px-3',
            'text-xs font-medium',
            'border border-violet-600 text-violet-600 bg-transparent hover:bg-violet-600/10',
            'shadow-md transition-colors duration-200',
            'cursor-pointer',
            visible ? 'opacity-100' : 'opacity-0'
          )}
          aria-label="Supercharge locally plan"
          data-testid="plan-ready-supercharge-local-fab"
        >
          Supercharge locally
        </button>
      )}
      {superpowersAvailable && onSuperpowers && (
        <button
          onClick={onSuperpowers}
          className={cn(
            'h-8 rounded-full px-3',
            'text-xs font-medium',
            'bg-violet-600 text-white',
            'shadow-md hover:bg-violet-700 transition-colors duration-200',
            'cursor-pointer',
            visible ? 'opacity-100' : 'opacity-0'
          )}
          aria-label="Supercharge plan"
          data-testid="plan-ready-supercharge-fab"
        >
          Supercharge
        </button>
      )}
      <button
        onClick={onImplement}
        className={cn(
          'h-8 rounded-full px-3',
          'text-xs font-medium',
          'bg-primary text-primary-foreground',
          'shadow-md hover:bg-primary/90 transition-colors duration-200',
          'cursor-pointer',
          visible ? 'opacity-100' : 'opacity-0 pointer-events-none'
        )}
        aria-label="Implement plan"
        data-testid="plan-ready-implement-fab"
      >
        Implement
      </button>
    </div>
  )
}

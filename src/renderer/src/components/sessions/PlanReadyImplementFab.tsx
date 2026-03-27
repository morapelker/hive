import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/useSettingsStore'

function MnemonicLabel({ letter, label }: { letter: string; label: string }): React.JSX.Element {
  const index = label.toLowerCase().indexOf(letter.toLowerCase())
  if (index === -1) return <span>{label}</span>
  return (
    <span>
      {label.slice(0, index)}
      <span className="font-semibold underline underline-offset-2 decoration-2">
        {label[index]}
      </span>
      {label.slice(index + 1)}
    </span>
  )
}

interface PlanReadyImplementFabProps {
  onImplement: () => void
  onHandoff: () => void
  visible: boolean
  onSuperpowers?: () => void
  onSuperpowersLocal?: () => void
  superpowersAvailable?: boolean
  isConnectionSession?: boolean
  onSaveAsTicket?: () => void
}

export function PlanReadyImplementFab({
  onImplement,
  onHandoff,
  visible,
  onSuperpowers,
  onSuperpowersLocal,
  superpowersAvailable,
  isConnectionSession,
  onSaveAsTicket
}: PlanReadyImplementFabProps): React.JSX.Element {
  const vimModeEnabled = useSettingsStore((s) => s.vimModeEnabled)

  return (
    <div
      className={cn(
        'absolute bottom-4 right-4 z-10',
        'flex items-center gap-2',
        'transition-all duration-200',
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2 pointer-events-none'
      )}
    >
      {onSaveAsTicket && (
        <button
          onClick={onSaveAsTicket}
          className={cn(
            'h-8 rounded-full px-3',
            'text-xs font-medium',
            'bg-muted/80 text-foreground border border-border',
            'shadow-md hover:bg-muted transition-colors duration-200',
            'cursor-pointer',
            visible ? 'opacity-100' : 'opacity-0'
          )}
          aria-label="Save plan as ticket"
          data-testid="plan-ready-save-ticket-fab"
        >
          {vimModeEnabled ? <MnemonicLabel letter="s" label="Save as ticket" /> : 'Save as ticket'}
        </button>
      )}
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
        {vimModeEnabled ? <MnemonicLabel letter="a" label="Handoff" /> : 'Handoff'}
      </button>
      {superpowersAvailable && !isConnectionSession && onSuperpowersLocal && (
        <button
          onClick={onSuperpowersLocal}
          className={cn(
            'h-8 rounded-full px-3',
            'text-xs font-medium',
            'border border-violet-600 text-violet-600 bg-background hover:bg-violet-100 dark:hover:bg-violet-950',
            'shadow-md transition-colors duration-200',
            'cursor-pointer',
            visible ? 'opacity-100' : 'opacity-0'
          )}
          aria-label="Supercharge plan locally"
          data-testid="plan-ready-supercharge-local-fab"
        >
          {vimModeEnabled ? (
            <MnemonicLabel letter="o" label="Supercharge locally" />
          ) : (
            'Supercharge locally'
          )}
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
          {vimModeEnabled ? <MnemonicLabel letter="u" label="Supercharge" /> : 'Supercharge'}
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
        {vimModeEnabled ? <MnemonicLabel letter="m" label="Implement" /> : 'Implement'}
      </button>
    </div>
  )
}

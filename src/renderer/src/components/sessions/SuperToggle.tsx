import { cn } from '@/lib/utils'
import { useSessionStore } from '@/stores/useSessionStore'

interface SuperToggleProps {
  sessionId: string
}

export function SuperToggle({ sessionId }: SuperToggleProps): React.JSX.Element {
  const mode = useSessionStore((state) => state.modeBySession.get(sessionId)) ?? 'build'
  const toggleSuperMode = useSessionStore((state) => state.toggleSuperMode)

  const visible = mode === 'plan' || mode === 'super-plan'
  const isOn = mode === 'super-plan'

  return (
    <div
      className={cn(
        'transition-all duration-200 overflow-hidden',
        visible
          ? 'opacity-100 translate-x-0 max-w-[80px]'
          : 'opacity-0 -translate-x-2 max-w-0 pointer-events-none'
      )}
    >
      <button
        type="button"
        onClick={() => toggleSuperMode(sessionId)}
        aria-pressed={isOn}
        aria-label={`Super mode ${isOn ? 'enabled' : 'disabled'}`}
        data-testid="super-toggle"
        className={cn(
          'flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium transition-colors',
          'border select-none whitespace-nowrap',
          isOn
            ? 'bg-orange-500/10 border-orange-500/30 text-orange-500 hover:bg-orange-500/20 super-sparkle'
            : 'bg-muted/50 border-border text-muted-foreground hover:bg-muted hover:text-foreground'
        )}
      >
        SUPER
      </button>
    </div>
  )
}

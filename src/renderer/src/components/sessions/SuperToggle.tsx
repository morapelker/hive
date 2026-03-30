import { cn } from '@/lib/utils'
import { useSessionStore } from '@/stores/useSessionStore'

interface SuperToggleProps {
  sessionId: string
}

export function SuperToggle({ sessionId }: SuperToggleProps): React.JSX.Element | null {
  const mode = useSessionStore((state) => state.modeBySession.get(sessionId)) ?? 'build'
  const toggleSuperMode = useSessionStore((state) => state.toggleSuperMode)

  const visible = mode === 'plan' || mode === 'super-plan'
  const isOn = mode === 'super-plan'

  if (!visible) return null

  return (
    <div className="transition-all duration-200 opacity-100 translate-x-0">
      <button
        type="button"
        onClick={() => toggleSuperMode(sessionId)}
        aria-pressed={isOn}
        aria-label={`Super mode ${isOn ? 'enabled' : 'disabled'}`}
        data-testid="super-toggle"
        className={cn(
          'flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium transition-colors',
          'border select-none',
          isOn
            ? 'bg-orange-500/10 border-orange-500/30 text-orange-500 hover:bg-orange-500/20'
            : 'bg-muted/50 border-border text-muted-foreground hover:bg-muted hover:text-foreground'
        )}
      >
        SUPER
      </button>
    </div>
  )
}

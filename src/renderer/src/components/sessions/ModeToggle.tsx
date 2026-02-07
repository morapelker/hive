import { Hammer, Map } from 'lucide-react'
import { useSessionStore, type SessionMode } from '@/stores/useSessionStore'
import { cn } from '@/lib/utils'

interface ModeToggleProps {
  sessionId: string
}

const MODE_CONFIG: Record<SessionMode, { label: string; icon: typeof Hammer; description: string }> = {
  build: {
    label: 'Build',
    icon: Hammer,
    description: 'Execute code changes and implementations'
  },
  plan: {
    label: 'Plan',
    icon: Map,
    description: 'Plan and design before implementing'
  }
}

export function ModeToggle({ sessionId }: ModeToggleProps): React.JSX.Element {
  const mode = useSessionStore((state) => state.modeBySession.get(sessionId) || 'build')
  const toggleSessionMode = useSessionStore((state) => state.toggleSessionMode)

  const config = MODE_CONFIG[mode]
  const Icon = config.icon

  return (
    <button
      onClick={() => toggleSessionMode(sessionId)}
      className={cn(
        'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors',
        'border select-none',
        mode === 'build'
          ? 'bg-primary/10 border-primary/30 text-primary hover:bg-primary/20'
          : 'bg-violet-500/10 border-violet-500/30 text-violet-500 hover:bg-violet-500/20'
      )}
      title={`${config.description} (Shift+Tab to toggle)`}
      aria-label={`Current mode: ${config.label}. Click to switch to ${mode === 'build' ? 'Plan' : 'Build'} mode`}
      data-testid="mode-toggle"
      data-mode={mode}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      <span>{config.label}</span>
    </button>
  )
}

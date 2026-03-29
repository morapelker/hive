import { Hammer, Map, Sparkles } from 'lucide-react'
import { useSessionStore, type SessionMode } from '@/stores/useSessionStore'
import { cn } from '@/lib/utils'

interface ModeToggleProps {
  sessionId: string
}

const MODE_CONFIG: Record<
  SessionMode,
  { label: string; icon: typeof Hammer; description: string }
> = {
  build: {
    label: 'Build',
    icon: Hammer,
    description: 'Execute code changes and implementations'
  },
  plan: {
    label: 'Plan',
    icon: Map,
    description: 'Plan and design before implementing'
  },
  'super-plan': {
    label: 'Super Plan',
    icon: Sparkles,
    description: 'Deep-dive interview to refine the plan'
  }
}

export function ModeToggle({ sessionId }: ModeToggleProps): React.JSX.Element {
  const rawMode = useSessionStore((state) => state.modeBySession.get(sessionId))
  const mode: SessionMode = rawMode === 'plan' ? 'plan' : rawMode === 'super-plan' ? 'super-plan' : 'build'
  const toggleSessionMode = useSessionStore((state) => state.toggleSessionMode)

  const config = MODE_CONFIG[mode] ?? MODE_CONFIG.build
  const Icon = config.icon

  return (
    <button
      onClick={() => toggleSessionMode(sessionId)}
      onMouseDown={(e) => e.preventDefault()}
      className={cn(
        'flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium transition-colors',
        'border select-none',
        mode === 'build'
          ? 'bg-blue-500/10 border-blue-500/30 text-blue-500 hover:bg-blue-500/20'
          : mode === 'plan'
            ? 'bg-violet-500/10 border-violet-500/30 text-violet-500 hover:bg-violet-500/20'
            : 'bg-orange-500/10 border-orange-500/30 text-orange-500 hover:bg-orange-500/20'
      )}
      title={`${config.description} (Tab to toggle)`}
      aria-label={`Current mode: ${config.label}. Click to switch to ${mode === 'build' ? 'Plan' : mode === 'plan' ? 'Super Plan' : 'Build'} mode`}
      data-testid="mode-toggle"
      data-mode={mode}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      <span>{config.label}</span>
    </button>
  )
}

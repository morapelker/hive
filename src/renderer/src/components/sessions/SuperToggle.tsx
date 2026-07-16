import { memo } from 'react'
import { cn } from '@/lib/utils'
import { isCliAgentSdk } from '@shared/types/agent-sdk'
import { useSessionStore } from '@/stores/useSessionStore'
import { Tip } from '@/components/ui/Tip'

interface SuperToggleProps {
  sessionId: string
}

export const SuperToggle = memo(function SuperToggle({
  sessionId
}: SuperToggleProps): React.JSX.Element {
  const mode = useSessionStore((state) => state.modeBySession.get(sessionId)) ?? 'build'
  const toggleSuperMode = useSessionStore((state) => state.toggleSuperMode)
  const session = useSessionStore((state) => state.getSessionById(sessionId))
  const hasPendingPrompt = useSessionStore((state) => state.pendingMessages.has(sessionId))

  const visible = mode === 'plan' || mode === 'super-plan'
  const disabled = isCliAgentSdk(session?.agent_sdk) && !hasPendingPrompt
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
      <Tip tipId="super-plan-shortcut" enabled={isOn}>
        <button
          type="button"
          onClick={() => toggleSuperMode(sessionId)}
          disabled={disabled}
          aria-pressed={isOn}
          aria-label={`Super mode ${isOn ? 'enabled' : 'disabled'} (Shift+Tab to toggle)`}
          title="Toggle super-plan mode (Shift+Tab)"
          data-testid="super-toggle"
          className={cn(
            'flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium transition-colors',
            'border select-none whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed',
            isOn
              ? 'bg-orange-500/10 border-orange-500/30 text-orange-500 hover:bg-orange-500/20 super-sparkle'
              : 'bg-muted/50 border-border text-muted-foreground hover:bg-muted hover:text-foreground'
          )}
        >
          SUPER
        </button>
      </Tip>
    </div>
  )
})

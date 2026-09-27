import { memo } from 'react'
import { isAgentCli } from '@shared/types/agent-sdk'
import { cn } from '@/lib/utils'
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

  const disabled = isAgentCli(session?.agent_sdk) && !hasPendingPrompt
  const isOn = mode === 'super-plan' || mode === 'super-build'

  return (
    <div className="transition-all duration-200 overflow-hidden opacity-100 translate-x-0 max-w-[80px]">
      <Tip tipId="super-plan-shortcut" enabled={isOn}>
        <button
          type="button"
          onClick={() => toggleSuperMode(sessionId)}
          disabled={disabled}
          aria-pressed={isOn}
          aria-label={`Super mode ${isOn ? 'enabled' : 'disabled'} (Shift+Tab to toggle)`}
          title="Toggle super mode (Shift+Tab)"
          data-testid="super-toggle"
          className={cn(
            'flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium tracking-[0.01em] transition-colors',
            'border select-none whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed',
            isOn
              ? 'bg-secondary border-border text-foreground hover:bg-accent'
              : 'bg-transparent border-border text-muted-foreground hover:bg-secondary hover:text-foreground'
          )}
        >
          SUPER
        </button>
      </Tip>
    </div>
  )
})

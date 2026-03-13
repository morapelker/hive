import { cn } from '@/lib/utils'

interface CodexFastToggleProps {
  enabled: boolean
  onToggle: () => void
}

export function CodexFastToggle({
  enabled,
  onToggle
}: CodexFastToggleProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={enabled}
      aria-label={`Fast mode ${enabled ? 'enabled' : 'disabled'}`}
      data-testid="codex-fast-toggle"
      className={cn(
        'flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium transition-colors',
        'border select-none',
        enabled
          ? 'bg-primary border-primary text-primary-foreground'
          : 'bg-muted/50 border-border text-muted-foreground hover:bg-muted hover:text-foreground'
      )}
    >
      Fast
    </button>
  )
}

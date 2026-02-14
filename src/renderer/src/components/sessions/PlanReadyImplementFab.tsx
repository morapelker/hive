import { cn } from '@/lib/utils'

interface PlanReadyImplementFabProps {
  onClick: () => void
  visible: boolean
}

export function PlanReadyImplementFab({
  onClick,
  visible
}: PlanReadyImplementFabProps): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={cn(
        'absolute bottom-4 right-4 z-10',
        'h-8 rounded-full px-3',
        'text-xs font-medium',
        'bg-primary text-primary-foreground',
        'shadow-md hover:bg-primary/90 transition-all duration-200',
        'cursor-pointer',
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2 pointer-events-none'
      )}
      aria-label="Implement plan"
      data-testid="plan-ready-implement-fab"
    >
      Implement
    </button>
  )
}

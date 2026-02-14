import { ArrowDown } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ScrollToBottomFabProps {
  onClick: () => void
  visible: boolean
  bottomClass?: string
}

export function ScrollToBottomFab({
  onClick,
  visible,
  bottomClass = 'bottom-4'
}: ScrollToBottomFabProps): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={cn(
        'absolute right-4 z-10',
        bottomClass,
        'h-8 w-8 rounded-full',
        'bg-muted/80 backdrop-blur-sm border border-border',
        'flex items-center justify-center',
        'shadow-md hover:bg-muted transition-all duration-200',
        'cursor-pointer',
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2 pointer-events-none'
      )}
      aria-label="Scroll to bottom"
      data-testid="scroll-to-bottom-fab"
    >
      <ArrowDown className="h-4 w-4" />
    </button>
  )
}

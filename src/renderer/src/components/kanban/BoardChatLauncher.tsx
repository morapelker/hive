import { Bot, MessageSquareText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { BoardChatStatus } from '@/stores/useBoardChatStore'

interface BoardChatLauncherProps {
  disabled?: boolean
  disabledReason?: string
  onClick: () => void
  status: BoardChatStatus
}

function getStatusTone(status: BoardChatStatus): string {
  switch (status) {
    case 'thinking':
    case 'starting':
      return 'bg-emerald-500'
    case 'awaiting_confirmation':
      return 'bg-amber-500'
    case 'error':
      return 'bg-red-500'
    default:
      return 'bg-sky-500'
  }
}

export function BoardChatLauncher({
  disabled = false,
  disabledReason,
  onClick,
  status
}: BoardChatLauncherProps): React.JSX.Element {
  return (
    <div className="pointer-events-auto">
      <Button
        type="button"
        variant="outline"
        onClick={onClick}
        disabled={disabled}
        title={disabledReason}
        className={cn(
          'h-12 rounded-full border-border/70 pl-4 pr-5 shadow-sm',
          disabled
            ? 'bg-muted/30 text-muted-foreground'
            : 'bg-card text-foreground hover:bg-muted/60'
        )}
      >
        {disabled ? (
          <Bot className="h-4 w-4" />
        ) : (
          <span className={cn('h-2.5 w-2.5 rounded-full', getStatusTone(status))} />
        )}
        <MessageSquareText className="h-4 w-4" />
        <span className="text-sm font-medium">Board Assistant</span>
      </Button>
    </div>
  )
}

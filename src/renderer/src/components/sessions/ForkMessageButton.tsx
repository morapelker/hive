import { GitFork, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface ForkMessageButtonProps {
  onFork: () => void | Promise<void>
  disabled?: boolean
  isForking?: boolean
}

export function ForkMessageButton({
  onFork,
  disabled = false,
  isForking = false
}: ForkMessageButtonProps) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => {
        void onFork()
      }}
      disabled={disabled || isForking}
      className="absolute top-2 right-10 h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity z-10 bg-background/80 backdrop-blur-sm"
      aria-label="Fork message"
      data-testid="fork-message-button"
    >
      {isForking ? (
        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
      ) : (
        <GitFork className="h-3 w-3 text-muted-foreground" />
      )}
    </Button>
  )
}

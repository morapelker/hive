import { cn } from '@/lib/utils'

interface UserBubbleProps {
  content: string
  timestamp: string
}

export function UserBubble({ content, timestamp }: UserBubbleProps): React.JSX.Element {
  return (
    <div className="flex justify-end px-6 py-4" data-testid="message-user">
      <div
        className={cn(
          'max-w-[80%] rounded-2xl px-4 py-3',
          'bg-primary/10 text-foreground'
        )}
      >
        <p className="text-sm whitespace-pre-wrap leading-relaxed">{content}</p>
        <span className="block text-[10px] text-muted-foreground mt-1.5 text-right">
          {new Date(timestamp).toLocaleTimeString()}
        </span>
      </div>
    </div>
  )
}

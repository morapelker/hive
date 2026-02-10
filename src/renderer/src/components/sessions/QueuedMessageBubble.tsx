import { cn } from '@/lib/utils'

interface QueuedMessageBubbleProps {
  content: string
}

export function QueuedMessageBubble({ content }: QueuedMessageBubbleProps): React.JSX.Element {
  return (
    <div className="flex justify-end px-6 py-4 opacity-70" data-testid="queued-message-bubble">
      <div className={cn('max-w-[80%] rounded-2xl px-4 py-3', 'bg-primary/10 text-foreground')}>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[10px] font-medium bg-primary-foreground/20 rounded px-1.5 py-0.5">
            QUEUED
          </span>
        </div>
        <p className="text-sm whitespace-pre-wrap break-words leading-relaxed">{content}</p>
      </div>
    </div>
  )
}

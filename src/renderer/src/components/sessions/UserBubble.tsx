import { cn } from '@/lib/utils'

interface UserBubbleProps {
  content: string
  timestamp: string
  isPlanMode?: boolean
}

export function UserBubble({ content, isPlanMode }: UserBubbleProps): React.JSX.Element {
  return (
    <div className="flex justify-end px-6 py-4" data-testid="message-user">
      <div
        className={cn(
          'max-w-[80%] rounded-2xl px-4 py-3',
          isPlanMode ? 'bg-purple-500/10 text-foreground' : 'bg-primary/10 text-foreground'
        )}
      >
        {isPlanMode && (
          <span
            className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-semibold bg-purple-500/15 text-purple-400 mb-1"
            data-testid="plan-mode-badge"
          >
            PLAN
          </span>
        )}
        <p className="text-sm whitespace-pre-wrap leading-relaxed">{content}</p>
      </div>
    </div>
  )
}

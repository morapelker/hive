import { memo, useMemo } from 'react'
import { cn } from '@/lib/utils'
import { parseUserMessageAttachments } from '@/lib/parse-user-message-attachments'
import { UserMessageAttachmentCards } from './UserMessageAttachmentCards'

interface UserBubbleProps {
  content: string
  timestamp: string
  isPlanMode?: boolean
  isSuperPlanMode?: boolean
  isAskMode?: boolean
}

export const UserBubble = memo(function UserBubble({ content, isPlanMode, isSuperPlanMode, isAskMode }: UserBubbleProps): React.JSX.Element {
  const { tickets, prComments, files, dataAttachments, cleanText } = useMemo(
    () => parseUserMessageAttachments(content),
    [content]
  )

  const hasAttachments = tickets.length > 0 || prComments.length > 0 || files.length > 0 || dataAttachments.length > 0

  return (
    <div className="flex flex-col items-end px-6 py-4" data-testid="message-user">
      {hasAttachments && (
        <div className="max-w-[80%]">
          <UserMessageAttachmentCards tickets={tickets} prComments={prComments} files={files} dataAttachments={dataAttachments} />
        </div>
      )}
      <div
        className={cn(
          'max-w-[80%] rounded-2xl px-4 py-3',
          isSuperPlanMode
            ? 'bg-purple-500/10 text-foreground'
            : isPlanMode
              ? 'bg-purple-500/10 text-foreground'
              : isAskMode
                ? 'bg-amber-500/10 text-foreground'
                : 'bg-primary/10 text-foreground'
        )}
      >
        {isSuperPlanMode && (
          <span
            className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-semibold bg-orange-500/15 text-orange-400 mb-1"
            data-testid="super-plan-mode-badge"
          >
            SUPER PLAN
          </span>
        )}
        {isPlanMode && (
          <span
            className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-semibold bg-purple-500/15 text-purple-400 mb-1"
            data-testid="plan-mode-badge"
          >
            PLAN
          </span>
        )}
        {isAskMode && (
          <span
            className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-semibold bg-amber-500/15 text-amber-400 mb-1"
            data-testid="ask-mode-badge"
          >
            ASK
          </span>
        )}
        <p className="text-sm whitespace-pre-wrap leading-relaxed">{cleanText}</p>
      </div>
    </div>
  )
})

import { memo } from 'react'
import { UserBubble } from './UserBubble'
import { AssistantCanvas } from './AssistantCanvas'
import { CopyMessageButton } from './CopyMessageButton'
import { ForkMessageButton } from './ForkMessageButton'
import { PLAN_MODE_PREFIX, ASK_MODE_PREFIX, SUPER_PLAN_MODE_PREFIX } from '@/lib/constants'
import type { OpenCodeMessage } from './SessionView'

interface MessageRendererProps {
  message: OpenCodeMessage
  isStreaming?: boolean
  cwd?: string | null
  onForkAssistantMessage?: (message: OpenCodeMessage) => void | Promise<void>
  forkDisabled?: boolean
  isForking?: boolean
}

export const MessageRenderer = memo(function MessageRenderer({
  message,
  isStreaming = false,
  cwd,
  onForkAssistantMessage,
  forkDisabled = false,
  isForking = false
}: MessageRendererProps): React.JSX.Element {
  const isSuperPlanMode = message.role === 'user' && message.content.startsWith(SUPER_PLAN_MODE_PREFIX)
  const isPlanMode = !isSuperPlanMode && message.role === 'user' && message.content.startsWith(PLAN_MODE_PREFIX)
  const isAskMode = message.role === 'user' && message.content.startsWith(ASK_MODE_PREFIX)
  const displayContent = isSuperPlanMode
    ? message.content.slice(SUPER_PLAN_MODE_PREFIX.length)
    : isPlanMode
      ? message.content.slice(PLAN_MODE_PREFIX.length)
      : isAskMode
        ? message.content.slice(ASK_MODE_PREFIX.length)
        : message.content
  const isAssistantMessage = message.role === 'assistant' && !isStreaming

  return (
    <div className="group relative">
      <CopyMessageButton content={displayContent} />
      {isAssistantMessage && onForkAssistantMessage && (
        <ForkMessageButton
          onFork={() => onForkAssistantMessage(message)}
          disabled={forkDisabled}
          isForking={isForking}
        />
      )}
      {message.role === 'user' ? (
        <UserBubble
          content={displayContent}
          timestamp={message.timestamp}
          isPlanMode={isPlanMode}
          isSuperPlanMode={isSuperPlanMode}
          isAskMode={isAskMode}
        />
      ) : (
        <AssistantCanvas
          content={message.content}
          timestamp={message.timestamp}
          isStreaming={isStreaming}
          parts={message.parts}
          cwd={cwd}
        />
      )}
    </div>
  )
})

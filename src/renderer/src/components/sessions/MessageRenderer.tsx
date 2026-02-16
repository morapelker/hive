import { UserBubble } from './UserBubble'
import { AssistantCanvas } from './AssistantCanvas'
import { CopyMessageButton } from './CopyMessageButton'
import { ForkMessageButton } from './ForkMessageButton'
import { PLAN_MODE_PREFIX } from '@/lib/constants'
import type { OpenCodeMessage } from './SessionView'

interface MessageRendererProps {
  message: OpenCodeMessage
  isStreaming?: boolean
  cwd?: string | null
  onForkAssistantMessage?: (message: OpenCodeMessage) => void | Promise<void>
  forkDisabled?: boolean
  isForking?: boolean
}

export function MessageRenderer({
  message,
  isStreaming = false,
  cwd,
  onForkAssistantMessage,
  forkDisabled = false,
  isForking = false
}: MessageRendererProps): React.JSX.Element {
  const isPlanMode = message.role === 'user' && message.content.startsWith(PLAN_MODE_PREFIX)
  const displayContent = isPlanMode
    ? message.content.slice(PLAN_MODE_PREFIX.length)
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
}

import { UserBubble } from './UserBubble'
import { AssistantCanvas } from './AssistantCanvas'
import { CopyMessageButton } from './CopyMessageButton'
import { PLAN_MODE_PREFIX } from '@/lib/constants'
import type { OpenCodeMessage } from './SessionView'

interface MessageRendererProps {
  message: OpenCodeMessage
  isStreaming?: boolean
  cwd?: string | null
}

export function MessageRenderer({
  message,
  isStreaming = false,
  cwd
}: MessageRendererProps): React.JSX.Element {
  const isPlanMode = message.role === 'user' && message.content.startsWith(PLAN_MODE_PREFIX)
  const displayContent = isPlanMode
    ? message.content.slice(PLAN_MODE_PREFIX.length)
    : message.content

  return (
    <div className="group relative">
      <CopyMessageButton content={displayContent} />
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

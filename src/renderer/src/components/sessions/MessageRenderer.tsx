import { UserBubble } from './UserBubble'
import { AssistantCanvas } from './AssistantCanvas'
import { CopyMessageButton } from './CopyMessageButton'
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
  return (
    <div className="group relative">
      <CopyMessageButton content={message.content} />
      {message.role === 'user' ? (
        <UserBubble content={message.content} timestamp={message.timestamp} />
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

import { UserBubble } from './UserBubble'
import { AssistantCanvas } from './AssistantCanvas'
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
  if (message.role === 'user') {
    return <UserBubble content={message.content} timestamp={message.timestamp} />
  }

  // assistant and system messages both render on the canvas
  return (
    <AssistantCanvas
      content={message.content}
      timestamp={message.timestamp}
      isStreaming={isStreaming}
      parts={message.parts}
      cwd={cwd}
    />
  )
}

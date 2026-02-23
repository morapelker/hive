import { UserBubble } from './UserBubble'
import { AssistantCanvas } from './AssistantCanvas'
import { CopyMessageButton } from './CopyMessageButton'
import { ForkMessageButton } from './ForkMessageButton'
import { PLAN_MODE_PREFIX, ASK_MODE_PREFIX } from '@/lib/constants'
import type { OpenCodeMessage } from './SessionView'

interface MessageRendererProps {
  message: OpenCodeMessage
  isStreaming?: boolean
  cwd?: string | null
  onForkAssistantMessage?: (message: OpenCodeMessage) => void | Promise<void>
  forkDisabled?: boolean
  isForking?: boolean
}

// Clean up command output tags
function cleanCommandOutput(content: string): string {
  // Strip <local-command-stdout> tags and format nicely
  return content
    .replace(/<local-command-stdout>/g, '✓ ')
    .replace(/<\/local-command-stdout>/g, '')
    .replace(/Compacted Tip/g, 'Compaction tip')
    .trim()
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
  const isAskMode = message.role === 'user' && message.content.startsWith(ASK_MODE_PREFIX)
  let displayContent = isPlanMode
    ? message.content.slice(PLAN_MODE_PREFIX.length)
    : isAskMode
    ? message.content.slice(ASK_MODE_PREFIX.length)
    : message.content

  // Clean command output tags (for all messages)
  if (displayContent.includes('<local-command-stdout>')) {
    console.log('[MessageRenderer] Cleaning command output tags from content')
    displayContent = cleanCommandOutput(displayContent)
  }
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
          isAskMode={isAskMode}
        />
      ) : (
        <AssistantCanvas
          content={displayContent}
          timestamp={message.timestamp}
          isStreaming={isStreaming}
          parts={message.parts}
          cwd={cwd}
        />
      )}
    </div>
  )
}

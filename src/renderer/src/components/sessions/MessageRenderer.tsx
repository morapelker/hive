import { memo } from 'react'
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

/**
 * Skip past attachment XML blocks to find where the actual prompt text starts.
 * Attachments can come before the mode prefix, so we need to skip them.
 */
function skipAttachments(content: string): { prefix: string; remaining: string } {
  let pos = 0
  const attachmentPatterns = [
    /<data-attachment[\s\S]*?<\/data-attachment>/,
    /<attached_files>[\s\S]*?<\/attached_files>/,
    /<ticket[\s\S]*?<\/ticket>/,
    /<pr-comment[\s\S]*?<\/pr-comment>/
  ]

  let changed = true
  while (changed) {
    changed = false
    const rest = content.slice(pos).trimStart()
    const trimOffset = content.slice(pos).length - rest.length

    for (const pattern of attachmentPatterns) {
      const match = rest.match(pattern)
      if (match && match.index === 0) {
        pos += trimOffset + match[0].length
        changed = true
        break
      }
    }
  }

  return {
    prefix: content.slice(0, pos),
    remaining: content.slice(pos).trimStart()
  }
}

export const MessageRenderer = memo(function MessageRenderer({
  message,
  isStreaming = false,
  cwd,
  onForkAssistantMessage,
  forkDisabled = false,
  isForking = false
}: MessageRendererProps): React.JSX.Element {
  // For user messages, check if there's a mode prefix (possibly after attachments)
  let isPlanMode = false
  let isAskMode = false
  let displayContent = message.content

  if (message.role === 'user') {
    const { prefix, remaining } = skipAttachments(message.content)

    if (remaining.startsWith(PLAN_MODE_PREFIX)) {
      isPlanMode = true
      displayContent = prefix + remaining.slice(PLAN_MODE_PREFIX.length)
    } else if (remaining.startsWith(ASK_MODE_PREFIX)) {
      isAskMode = true
      displayContent = prefix + remaining.slice(ASK_MODE_PREFIX.length)
    }
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

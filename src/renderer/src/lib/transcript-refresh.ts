export interface TranscriptToolUseInfo {
  id: string
  name: string
  input: Record<string, unknown>
  status: 'pending' | 'running' | 'success' | 'error'
  startTime: number
  endTime?: number
  output?: string
  error?: string
}

export interface TranscriptStreamingPart {
  type: 'text' | 'tool_use' | 'subtask' | 'step_start' | 'step_finish' | 'reasoning' | 'compaction'
  text?: string
  toolUse?: TranscriptToolUseInfo
}

export interface TranscriptMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  parts?: TranscriptStreamingPart[]
}

interface AppendFallbackOptions {
  streamedContent: string
  streamedParts: TranscriptStreamingPart[]
  createId?: () => string
  now?: () => string
}

function normalizeText(value: string): string {
  return value.trim()
}

function messageCoversStream(
  message: TranscriptMessage,
  streamedContent: string,
  streamedToolIds: Set<string>
): boolean {
  if (message.role !== 'assistant') return false

  const normalizedStreamedContent = normalizeText(streamedContent)
  const normalizedMessageContent = normalizeText(message.content)
  if (
    normalizedStreamedContent.length > 0 &&
    (normalizedMessageContent.includes(normalizedStreamedContent) ||
      normalizedStreamedContent.includes(normalizedMessageContent))
  ) {
    return true
  }

  if (streamedToolIds.size === 0) return false

  return (
    message.parts?.some(
      (part) =>
        part.type === 'tool_use' && !!part.toolUse?.id && streamedToolIds.has(part.toolUse.id)
    ) ?? false
  )
}

export function appendStreamedAssistantFallback(
  messages: TranscriptMessage[],
  options: AppendFallbackOptions
): TranscriptMessage[] {
  const streamedContent = options.streamedContent.trim()
  const streamedParts = options.streamedParts
  const streamedToolIds = new Set(
    streamedParts
      .filter((part) => part.type === 'tool_use' && !!part.toolUse?.id)
      .map((part) => part.toolUse!.id)
  )

  if (streamedContent.length === 0 && streamedToolIds.size === 0) {
    return messages
  }

  const covered = messages.some((message) =>
    messageCoversStream(message, streamedContent, streamedToolIds)
  )
  if (covered) {
    return messages
  }

  return [
    ...messages,
    {
      id: options.createId ? options.createId() : `local-stream-${crypto.randomUUID()}`,
      role: 'assistant',
      content: streamedContent,
      timestamp: options.now ? options.now() : new Date().toISOString(),
      parts: streamedParts.length > 0 ? streamedParts : undefined
    }
  ]
}

export interface ToolUseInfo {
  id: string
  name: string
  input: Record<string, unknown>
  status: 'pending' | 'running' | 'success' | 'error'
  startTime: number
  endTime?: number
  output?: string
  error?: string
}

export interface StreamingPart {
  type: 'text' | 'tool_use' | 'subtask' | 'step_start' | 'step_finish' | 'reasoning' | 'compaction'
  text?: string
  toolUse?: ToolUseInfo
  subtask?: {
    id: string
    sessionID: string
    prompt: string
    description: string
    agent: string
    parts: StreamingPart[]
    status: 'running' | 'completed' | 'error'
  }
  stepStart?: { snapshot?: string }
  stepFinish?: {
    reason: string
    cost: number
    tokens: { input: number; output: number; reasoning: number }
  }
  reasoning?: string
  compactionAuto?: boolean
}

export interface OpenCodeMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  parts?: StreamingPart[]
}

interface MappedMessage {
  message: OpenCodeMessage
  sortTime?: number
  originalIndex: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function toNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function toTimestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return undefined

  const numeric = Number(value)
  if (Number.isFinite(numeric)) return numeric

  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

function toIsoTimestamp(value: unknown): string | undefined {
  const timestamp = toTimestampMs(value)
  return timestamp === undefined ? undefined : new Date(timestamp).toISOString()
}

function mapRole(value: unknown): 'user' | 'assistant' | 'system' {
  if (value === 'user' || value === 'assistant' || value === 'system') {
    return value
  }
  return 'assistant'
}

function mapToolStatus(value: unknown): 'pending' | 'running' | 'success' | 'error' {
  switch (value) {
    case 'pending':
      return 'pending'
    case 'running':
      return 'running'
    case 'completed':
    case 'success':
      return 'success'
    case 'error':
      return 'error'
    default:
      return 'running'
  }
}

function stringifyValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function extractTextContentFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) return ''

  return parts
    .map((part) => {
      const record = asRecord(part)
      if (!record || record.type !== 'text') return ''
      return asString(record.text) ?? ''
    })
    .join('')
}

export function mapOpencodePartToStreamingPart(part: unknown, index = 0): StreamingPart | null {
  const record = asRecord(part)
  if (!record) return null

  const type = asString(record.type)
  if (!type) return null

  if (type === 'text') {
    const text = asString(record.text)
    return text ? { type: 'text', text } : null
  }

  if (type === 'tool_use') {
    const toolUse = asRecord(record.toolUse)
    if (!toolUse) return null

    return {
      type: 'tool_use',
      toolUse: {
        id: asString(toolUse.id) ?? `tool-${index}`,
        name: asString(toolUse.name) ?? 'Unknown',
        input: asRecord(toolUse.input) ?? {},
        status: mapToolStatus(toolUse.status),
        startTime: toTimestampMs(toolUse.startTime) ?? Date.now(),
        endTime: toTimestampMs(toolUse.endTime),
        output: stringifyValue(toolUse.output),
        error: asString(toolUse.error)
      }
    }
  }

  if (type === 'tool') {
    const state = asRecord(record.state) ?? {}
    const stateTime = asRecord(state.time) ?? {}

    return {
      type: 'tool_use',
      toolUse: {
        id: asString(record.callID) ?? asString(record.id) ?? `tool-${index}`,
        name: asString(record.tool) ?? asString(record.name) ?? 'Unknown',
        input: asRecord(state.input) ?? {},
        status: mapToolStatus(state.status),
        startTime: toTimestampMs(stateTime.start) ?? Date.now(),
        endTime: toTimestampMs(stateTime.end),
        output: stringifyValue(state.output),
        error: stringifyValue(state.error)
      }
    }
  }

  if (type === 'subtask') {
    const rawParts = Array.isArray(record.parts) ? record.parts : []
    const parts = rawParts
      .map((rawPart, partIndex) => mapOpencodePartToStreamingPart(rawPart, partIndex))
      .filter((mappedPart): mappedPart is StreamingPart => mappedPart !== null)

    return {
      type: 'subtask',
      subtask: {
        id: asString(record.id) ?? `subtask-${index}`,
        sessionID: asString(record.sessionID) ?? '',
        prompt: asString(record.prompt) ?? '',
        description: asString(record.description) ?? '',
        agent: asString(record.agent) ?? 'unknown',
        parts,
        status:
          record.status === 'completed' || record.status === 'error'
            ? (record.status as 'completed' | 'error')
            : 'running'
      }
    }
  }

  if (type === 'step-start' || type === 'step_start') {
    return {
      type: 'step_start',
      stepStart: {
        snapshot: asString(record.snapshot)
      }
    }
  }

  if (type === 'step-finish' || type === 'step_finish') {
    const tokens = asRecord(record.tokens)
    return {
      type: 'step_finish',
      stepFinish: {
        reason: asString(record.reason) ?? '',
        cost: toNumber(record.cost) ?? 0,
        tokens: {
          input: toNumber(tokens?.input) ?? 0,
          output: toNumber(tokens?.output) ?? 0,
          reasoning: toNumber(tokens?.reasoning) ?? 0
        }
      }
    }
  }

  if (type === 'reasoning') {
    return { type: 'reasoning', reasoning: asString(record.text) ?? '' }
  }

  if (type === 'compaction') {
    return { type: 'compaction', compactionAuto: record.auto === true }
  }

  return null
}

function mapMessage(rawMessage: unknown, index: number): MappedMessage {
  const messageRecord = asRecord(rawMessage)
  const info = asRecord(messageRecord?.info)

  const id = asString(info?.id) ?? asString(messageRecord?.id) ?? `message-${index}`
  const role = mapRole(info?.role ?? messageRecord?.role)

  const rawParts = Array.isArray(messageRecord?.parts) ? messageRecord.parts : []
  const mappedParts = rawParts
    .map((part, partIndex) => mapOpencodePartToStreamingPart(part, partIndex))
    .filter((part): part is StreamingPart => part !== null)

  const content =
    extractTextContentFromParts(rawParts) ||
    asString(info?.content) ||
    asString(messageRecord?.content) ||
    ''

  const sortTime =
    toTimestampMs(info?.time && asRecord(info.time)?.created) ??
    toTimestampMs(info?.createdAt) ??
    toTimestampMs(info?.created_at) ??
    toTimestampMs(messageRecord?.timestamp)

  const timestamp =
    toIsoTimestamp(info?.time && asRecord(info.time)?.created) ??
    toIsoTimestamp(info?.createdAt) ??
    toIsoTimestamp(info?.created_at) ??
    toIsoTimestamp(messageRecord?.timestamp) ??
    new Date(0).toISOString()

  return {
    message: {
      id,
      role,
      content,
      timestamp,
      parts: mappedParts.length > 0 ? mappedParts : undefined
    },
    sortTime,
    originalIndex: index
  }
}

export function mapOpencodeMessagesToSessionViewMessages(messages: unknown[]): OpenCodeMessage[] {
  if (!Array.isArray(messages)) return []

  return messages
    .map((message, index) => mapMessage(message, index))
    .sort((a, b) => {
      if (a.sortTime !== undefined && b.sortTime !== undefined && a.sortTime !== b.sortTime) {
        return a.sortTime - b.sortTime
      }

      if (a.sortTime !== undefined && b.sortTime === undefined) return -1
      if (a.sortTime === undefined && b.sortTime !== undefined) return 1

      const idCompare = a.message.id.localeCompare(b.message.id)
      if (idCompare !== 0) return idCompare

      return a.originalIndex - b.originalIndex
    })
    .map((item) => item.message)
}

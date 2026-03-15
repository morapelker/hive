import {
  mapOpencodePartToStreamingPart,
  type OpenCodeMessage,
  type StreamingPart
} from '@/lib/opencode-transcript'

function parseJson<T>(value: string | null): T | null {
  if (!value) return null
  try {
    return JSON.parse(value) as T
  } catch {
    return null
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

function parseToolPart(activity: SessionActivity): StreamingPart | null {
  const payload = parseJson<Record<string, unknown>>(activity.payload_json)
  const item = payload && typeof payload.item === 'object' ? (payload.item as Record<string, unknown>) : null
  const toolName =
    (typeof item?.toolName === 'string' && item.toolName) ||
    (typeof item?.name === 'string' && item.name) ||
    (typeof item?.type === 'string' && item.type) ||
    'unknown'
  const rawInput =
    item?.input && typeof item.input === 'object' && !Array.isArray(item.input)
      ? (item.input as Record<string, unknown>)
      : {}
  const input = Array.isArray(item?.changes)
    ? { ...rawInput, changes: item.changes }
    : rawInput
  const output = item?.output ?? payload?.output ?? item?.aggregatedOutput ?? payload?.aggregatedOutput

  return {
    type: 'tool_use',
    toolUse: {
      id: activity.item_id ?? activity.id,
      name: toolName,
      input,
      status:
        activity.kind === 'tool.completed'
          ? 'success'
          : activity.kind === 'tool.failed'
            ? 'error'
            : 'running',
      startTime: Date.parse(activity.created_at) || Date.now(),
      endTime:
        activity.kind === 'tool.completed' || activity.kind === 'tool.failed'
          ? Date.parse(activity.created_at) || Date.now()
          : undefined,
      output:
        activity.kind === 'tool.completed' ? stringifyValue(output) : undefined,
      error:
        activity.kind === 'tool.failed' ? stringifyValue(output) ?? activity.summary : undefined
    }
  }
}

function parsePlanPart(activity: SessionActivity): StreamingPart | null {
  if (activity.kind !== 'plan.ready') return null

  const payload = parseJson<Record<string, unknown>>(activity.payload_json)
  const plan =
    (typeof payload?.plan === 'string' && payload.plan.trim()) ||
    (typeof payload?.planContent === 'string' && payload.planContent.trim()) ||
    ''

  if (!plan) return null

  const toolUseId =
    (typeof payload?.toolUseID === 'string' && payload.toolUseID) ||
    activity.item_id ||
    activity.request_id ||
    activity.id

  return {
    type: 'tool_use',
    toolUse: {
      id: toolUseId,
      name: 'ExitPlanMode',
      input: { plan },
      status: 'pending',
      startTime: Date.parse(activity.created_at) || Date.now()
    }
  }
}

export function mapDbSessionMessagesToOpenCodeMessages(messages: SessionMessage[]): OpenCodeMessage[] {
  return messages.map((message) => {
    const parsedParts = parseJson<unknown[]>(message.opencode_parts_json)
    const parts = Array.isArray(parsedParts)
      ? parsedParts
          .map((part, index) => mapOpencodePartToStreamingPart(part, index))
          .filter((part): part is StreamingPart => part !== null)
      : undefined

    return {
      id: message.opencode_message_id ?? message.id,
      role: message.role,
      content: message.content,
      timestamp: message.created_at,
      parts: parts && parts.length > 0 ? parts : undefined
    }
  })
}

export function mergeCodexActivityMessages(
  baseMessages: OpenCodeMessage[],
  activityRows: SessionActivity[]
): OpenCodeMessage[] {
  const mergedMessages = baseMessages.map((message) => ({
    ...message,
    parts: message.parts ? [...message.parts] : undefined
  }))
  const messageIndexByTurnId = new Map<string, number>()
  const assistantIndices: number[] = []

  mergedMessages.forEach((message, index) => {
    if (message.role !== 'assistant') return
    assistantIndices.push(index)
    const turnId = message.id.endsWith(':assistant')
      ? message.id.slice(0, -':assistant'.length)
      : null
    if (turnId) {
      messageIndexByTurnId.set(turnId, index)
    }
  })

  const findNearestAssistantIndex = (activityTime: number): number | undefined => {
    if (assistantIndices.length === 0) return undefined

    let futureMatch: number | undefined
    let futureDelta = Number.POSITIVE_INFINITY

    for (const index of assistantIndices) {
      const assistantTime = Date.parse(mergedMessages[index]?.timestamp ?? '')
      if (!Number.isFinite(assistantTime)) continue
      const delta = assistantTime - activityTime
      if (delta >= 0 && delta < futureDelta) {
        futureDelta = delta
        futureMatch = index
      }
    }

    if (futureMatch !== undefined) return futureMatch
    return assistantIndices[assistantIndices.length - 1]
  }

  const syntheticMessages: OpenCodeMessage[] = []

  const sortedActivities = [...activityRows].sort((left, right) => {
    const leftTime = Date.parse(left.created_at)
    const rightTime = Date.parse(right.created_at)
    if (leftTime !== rightTime) return leftTime - rightTime
    return left.id.localeCompare(right.id)
  })

  for (const activity of sortedActivities) {
    const activityPart = activity.kind.startsWith('tool.')
      ? parseToolPart(activity)
      : parsePlanPart(activity)
    if (!activityPart?.toolUse) continue

    const turnId = activity.turn_id
    const activityTime = Date.parse(activity.created_at)
    const existingIndex =
      (turnId ? messageIndexByTurnId.get(turnId) : undefined) ??
      (Number.isFinite(activityTime) ? findNearestAssistantIndex(activityTime) : undefined)
    if (existingIndex !== undefined) {
      const target = mergedMessages[existingIndex]
      const existingParts = target.parts ? [...target.parts] : []
      const partIndex = existingParts.findIndex(
        (part) => part.type === 'tool_use' && part.toolUse?.id === activityPart.toolUse?.id
      )
      if (partIndex >= 0) {
        existingParts[partIndex] = activityPart
      } else {
        existingParts.push(activityPart)
      }
      target.parts = existingParts
      continue
    }

    const syntheticId = turnId ? `${turnId}:assistant` : activity.id
    let target = syntheticMessages.find((message) => message.id === syntheticId)
    if (!target) {
      target = {
        id: syntheticId,
        role: 'assistant',
        content: '',
        timestamp: activity.created_at,
        parts: []
      }
      syntheticMessages.push(target)
    }
    const existingParts = target.parts ? [...target.parts] : []
    const partIndex = existingParts.findIndex(
      (part) => part.type === 'tool_use' && part.toolUse?.id === activityPart.toolUse?.id
    )
    if (partIndex >= 0) {
      existingParts[partIndex] = activityPart
    } else {
      existingParts.push(activityPart)
    }
    target.parts = existingParts
  }

  return [...mergedMessages, ...syntheticMessages]
    .map((message, index) => ({ message, index }))
    .sort((left, right) => {
      const leftTime = Date.parse(left.message.timestamp)
      const rightTime = Date.parse(right.message.timestamp)
      if (leftTime !== rightTime) return leftTime - rightTime
      const leftWeight = left.message.role === 'user' ? 0 : 1
      const rightWeight = right.message.role === 'user' ? 0 : 1
      return leftWeight - rightWeight || left.index - right.index
    })
    .map(({ message }) => message)
}

export function deriveCodexTimelineMessages(
  messageRows: SessionMessage[],
  activityRows: SessionActivity[]
): OpenCodeMessage[] {
  return mergeCodexActivityMessages(mapDbSessionMessagesToOpenCodeMessages(messageRows), activityRows)
}

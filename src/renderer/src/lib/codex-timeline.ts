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
  const item =
    payload && typeof payload.item === 'object' ? (payload.item as Record<string, unknown>) : null
  const toolName =
    (typeof item?.toolName === 'string' && item.toolName) ||
    (typeof item?.name === 'string' && item.name) ||
    (typeof item?.type === 'string' && item.type) ||
    'unknown'
  const rawInput =
    item?.input && typeof item.input === 'object' && !Array.isArray(item.input)
      ? (item.input as Record<string, unknown>)
      : {}
  const input = Array.isArray(item?.changes) ? { ...rawInput, changes: item.changes } : rawInput
  const output =
    item?.output ?? payload?.output ?? item?.aggregatedOutput ?? payload?.aggregatedOutput

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
      output: activity.kind === 'tool.completed' ? stringifyValue(output) : undefined,
      error:
        activity.kind === 'tool.failed' ? (stringifyValue(output) ?? activity.summary) : undefined
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

function hasCanonicalTurnScopedId(messageId: string | null | undefined): boolean {
  return typeof messageId === 'string' && /:user(?::|$)|:assistant(?::|$)/.test(messageId)
}

function extractAssistantTurnId(messageId: string): string | null {
  const assistantMatch = messageId.match(/^(.*):assistant(?::.*)?$/)
  return assistantMatch?.[1] ?? null
}

function extractUserTurnId(messageId: string): string | null {
  const userMatch = messageId.match(/^(.*):user(?::.*)?$/)
  return userMatch?.[1] ?? null
}

function extractRoleOrdinal(messageId: string, role: 'user' | 'assistant'): number {
  const match = messageId.match(new RegExp(`^[^]*:${role}(?::(.+))?$`))
  if (!match) return 0
  if (!match[1]) return 1
  const numericSuffix = Number.parseInt(match[1], 10)
  return Number.isFinite(numericSuffix) ? Math.max(1, numericSuffix) : 2
}

function getOrderedActivityTurnIds(activityRows: SessionActivity[]): string[] {
  return [
    ...new Set(
      [...activityRows]
        .sort((left, right) => {
          const leftTime = Date.parse(left.created_at)
          const rightTime = Date.parse(right.created_at)
          if (leftTime !== rightTime) return leftTime - rightTime
          return left.id.localeCompare(right.id)
        })
        .map((activity) => activity.turn_id)
        .filter((turnId): turnId is string => typeof turnId === 'string' && turnId.length > 0)
    )
  ]
}

function normalizeCodexMessageRows(
  messages: SessionMessage[],
  activityRows: SessionActivity[]
): SessionMessage[] {
  const orderedMessages = [...messages].sort((left, right) => {
    const leftTime = Date.parse(left.created_at)
    const rightTime = Date.parse(right.created_at)
    if (leftTime !== rightTime) return leftTime - rightTime
    return left.id.localeCompare(right.id)
  })

  const orderedTurnIds = getOrderedActivityTurnIds(activityRows)
  if (orderedTurnIds.length === 0) {
    return orderedMessages
  }

  const turnIndexById = new Map(orderedTurnIds.map((turnId, index) => [turnId, index]))
  let currentTurnIndex = -1
  let currentTurnId: string | null = null
  let assistantCountWithinTurn = 0
  let userCountWithinTurn = 0

  return orderedMessages.map((message) => {
    const messageId = message.opencode_message_id
    const canonicalTurnId =
      typeof messageId === 'string'
        ? message.role === 'assistant'
          ? extractAssistantTurnId(messageId)
          : message.role === 'user'
            ? extractUserTurnId(messageId)
            : null
        : null

    if (canonicalTurnId) {
      currentTurnId = canonicalTurnId
      currentTurnIndex = turnIndexById.get(canonicalTurnId) ?? currentTurnIndex
      if (message.role === 'user') {
        userCountWithinTurn = extractRoleOrdinal(messageId!, 'user')
        assistantCountWithinTurn = 0
      } else if (message.role === 'assistant') {
        assistantCountWithinTurn = extractRoleOrdinal(messageId!, 'assistant')
      }
      return message
    }

    if (message.role === 'user') {
      if (!currentTurnId || userCountWithinTurn > 0) {
        currentTurnIndex += 1
        currentTurnId = orderedTurnIds[currentTurnIndex] ?? currentTurnId
        userCountWithinTurn = 0
      }
      if (!currentTurnId) return message
      assistantCountWithinTurn = 0
      userCountWithinTurn += 1
      return {
        ...message,
        opencode_message_id:
          userCountWithinTurn === 1
            ? `${currentTurnId}:user`
            : `${currentTurnId}:user:${userCountWithinTurn}`
      }
    }

    if (message.role === 'assistant') {
      const turnId = currentTurnId ?? orderedTurnIds[Math.max(currentTurnIndex, 0)]
      if (!turnId) return message
      const messageId =
        assistantCountWithinTurn === 0
          ? `${turnId}:assistant`
          : `${turnId}:assistant:${assistantCountWithinTurn + 1}`
      assistantCountWithinTurn += 1
      return {
        ...message,
        opencode_message_id: messageId
      }
    }

    return message
  })
}

function normalizeCodexOpenCodeMessages(
  messages: OpenCodeMessage[],
  activityRows: SessionActivity[]
): OpenCodeMessage[] {
  const orderedTurnIds = getOrderedActivityTurnIds(activityRows)
  if (orderedTurnIds.length === 0) {
    return messages
  }

  const turnIndexById = new Map(orderedTurnIds.map((turnId, index) => [turnId, index]))
  let currentTurnIndex = -1
  let currentTurnId: string | null = null
  let assistantCountWithinTurn = 0
  let userCountWithinTurn = 0

  return messages.map((message) => {
    const canonicalTurnId =
      message.role === 'assistant'
        ? extractAssistantTurnId(message.id)
        : message.role === 'user'
          ? extractUserTurnId(message.id)
          : null

    if (canonicalTurnId) {
      currentTurnId = canonicalTurnId
      currentTurnIndex = turnIndexById.get(canonicalTurnId) ?? currentTurnIndex
      if (message.role === 'user') {
        userCountWithinTurn = extractRoleOrdinal(message.id, 'user')
        assistantCountWithinTurn = 0
      } else if (message.role === 'assistant') {
        assistantCountWithinTurn = extractRoleOrdinal(message.id, 'assistant')
      }
      return message
    }

    if (message.role === 'user') {
      if (!currentTurnId || userCountWithinTurn > 0) {
        currentTurnIndex += 1
        currentTurnId = orderedTurnIds[currentTurnIndex] ?? currentTurnId
        userCountWithinTurn = 0
      }
      if (!currentTurnId) return message
      assistantCountWithinTurn = 0
      userCountWithinTurn += 1
      return {
        ...message,
        id:
          userCountWithinTurn === 1
            ? `${currentTurnId}:user`
            : `${currentTurnId}:user:${userCountWithinTurn}`
      }
    }

    if (message.role === 'assistant') {
      const turnId = currentTurnId ?? orderedTurnIds[Math.max(currentTurnIndex, 0)]
      if (!turnId) return message
      const messageId =
        assistantCountWithinTurn === 0
          ? `${turnId}:assistant`
          : `${turnId}:assistant:${assistantCountWithinTurn + 1}`
      assistantCountWithinTurn += 1
      return {
        ...message,
        id: messageId
      }
    }

    return message
  })
}

export function mapDbSessionMessagesToOpenCodeMessages(
  messages: SessionMessage[]
): OpenCodeMessage[] {
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

function upsertToolPart(
  parts: StreamingPart[] | undefined,
  nextPart: StreamingPart
): StreamingPart[] {
  const existingParts = parts ? [...parts] : []
  const nextToolId = nextPart.toolUse?.id
  const partIndex = existingParts.findIndex(
    (part) => part.type === 'tool_use' && part.toolUse?.id === nextToolId
  )

  if (partIndex >= 0) {
    existingParts[partIndex] = nextPart
  } else {
    existingParts.push(nextPart)
  }

  return existingParts
}

export function mergeCodexActivityMessages(
  baseMessages: OpenCodeMessage[],
  activityRows: SessionActivity[]
): OpenCodeMessage[] {
  const normalizedBaseMessages = normalizeCodexOpenCodeMessages(baseMessages, activityRows)
  const mergedMessages = normalizedBaseMessages.map((message) => ({
    ...message,
    parts: message.parts ? [...message.parts] : undefined
  }))
  const knownToolIds = new Set(
    mergedMessages.flatMap((message) =>
      (message.parts ?? [])
        .filter((part) => part.type === 'tool_use' && !!part.toolUse?.id)
        .map((part) => part.toolUse!.id)
    )
  )
  const firstAssistantIndexByTurnId = new Map<string, number>()
  const turnOrder: string[] = []

  mergedMessages.forEach((message, index) => {
    const turnId =
      message.role === 'assistant'
        ? extractAssistantTurnId(message.id)
        : (message.id.match(/^(.*):user(?::.*)?$/)?.[1] ?? null)

    if (!turnId) return
    if (!turnOrder.includes(turnId)) {
      turnOrder.push(turnId)
    }
    if (message.role === 'assistant' && !firstAssistantIndexByTurnId.has(turnId)) {
      firstAssistantIndexByTurnId.set(turnId, index)
    }
  })

  const anchoredSyntheticByTurnId = new Map<
    string,
    Array<OpenCodeMessage & { syntheticOrder: number }>
  >()
  const unanchoredSynthetic: Array<OpenCodeMessage & { syntheticOrder: number }> = []

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

    const toolId = activityPart.toolUse.id
    if (knownToolIds.has(toolId)) {
      continue
    }

    const turnId = activity.turn_id
    const syntheticId = turnId ? `${turnId}:tool:${toolId}` : `tool:${toolId}`
    const targetCollection = turnId
      ? (anchoredSyntheticByTurnId.get(turnId) ?? [])
      : unanchoredSynthetic
    let target = targetCollection.find((message) => message.id === syntheticId)
    if (!target) {
      target = {
        id: syntheticId,
        role: 'assistant',
        content: '',
        timestamp: activity.created_at,
        parts: [],
        syntheticOrder: targetCollection.length
      }
      targetCollection.push(target)
      if (turnId) {
        anchoredSyntheticByTurnId.set(turnId, targetCollection)
      }
    }
    target.parts = upsertToolPart(target.parts, activityPart)
  }

  const injectedTurns = new Set<string>()
  const orderedMessages: OpenCodeMessage[] = []

  mergedMessages.forEach((message, index) => {
    const turnId =
      message.role === 'assistant'
        ? extractAssistantTurnId(message.id)
        : (message.id.match(/^(.*):user(?::.*)?$/)?.[1] ?? null)

    if (
      turnId &&
      message.role === 'assistant' &&
      firstAssistantIndexByTurnId.get(turnId) === index &&
      !injectedTurns.has(turnId)
    ) {
      orderedMessages.push(...(anchoredSyntheticByTurnId.get(turnId) ?? []))
      injectedTurns.add(turnId)
    }

    orderedMessages.push(message)
  })

  for (const turnId of turnOrder) {
    if (injectedTurns.has(turnId)) continue
    const syntheticMessages = anchoredSyntheticByTurnId.get(turnId)
    if (syntheticMessages && syntheticMessages.length > 0) {
      orderedMessages.push(...syntheticMessages)
    }
  }

  if (unanchoredSynthetic.length > 0) {
    orderedMessages.push(...unanchoredSynthetic)
  }

  return orderedMessages
}

export function deriveCodexTimelineMessages(
  messageRows: SessionMessage[],
  activityRows: SessionActivity[]
): OpenCodeMessage[] {
  const normalizedMessages = normalizeCodexMessageRows(messageRows, activityRows)
  return mergeCodexActivityMessages(
    mapDbSessionMessagesToOpenCodeMessages(normalizedMessages),
    activityRows
  )
}

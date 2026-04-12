import {
  mapOpencodePartToStreamingPart,
  type OpenCodeMessage,
  type StreamingPart
} from '@/lib/opencode-transcript'
import { correlateSubtasksIntoTaskTools } from '@/lib/codex-subtask-correlation'
import {
  normalizeCodexToolName,
  normalizeCommandExecutionTool
} from '@shared/codex-tool-normalizer'

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
  const itemType = typeof item?.type === 'string' ? item.type : ''
  const normalizedCommandTool =
    itemType === 'commandExecution'
      ? normalizeCommandExecutionTool({
          command: item?.command ?? item?.cmd,
          input: item?.input,
          commandActions: Array.isArray(item?.commandActions) ? item.commandActions : null
        })
      : null
  const toolName =
    normalizedCommandTool?.toolName ??
    normalizeCodexToolName(
      (typeof item?.toolName === 'string' && item.toolName) ||
        (typeof item?.name === 'string' && item.name) ||
        itemType ||
        'unknown'
    )
  const rawInput =
    item?.type === 'collabAgentToolCall'
      ? {
          ...(typeof item?.prompt === 'string' ? { prompt: item.prompt } : {}),
          ...(Array.isArray(item?.receiverThreadIds)
            ? { receiverThreadIds: item.receiverThreadIds }
            : {})
        }
      : item?.input && typeof item.input === 'object' && !Array.isArray(item.input)
        ? (item.input as Record<string, unknown>)
        : {}
  const mergedInput = Array.isArray(item?.changes) ? { ...rawInput, changes: item.changes } : rawInput
  const input = normalizedCommandTool?.input ?? mergedInput
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

function parseTaskPart(activity: SessionActivity): StreamingPart | null {
  if (
    activity.kind !== 'task.started' &&
    activity.kind !== 'task.updated' &&
    activity.kind !== 'task.completed'
  ) {
    return null
  }

  const payload = parseJson<Record<string, unknown>>(activity.payload_json)
  const task =
    payload && typeof payload.task === 'object' && !Array.isArray(payload.task)
      ? (payload.task as Record<string, unknown>)
      : null

  const taskId =
    (typeof task?.id === 'string' && task.id) ||
    (typeof payload?.taskId === 'string' && payload.taskId) ||
    activity.item_id ||
    activity.id

  const sessionID =
    (typeof task?.threadId === 'string' && task.threadId) ||
    (typeof payload?.threadId === 'string' && payload.threadId) ||
    taskId

  const description =
    (typeof task?.message === 'string' && task.message) ||
    (typeof payload?.message === 'string' && payload.message) ||
    activity.summary ||
    ''

  return {
    type: 'subtask',
    subtask: {
      id: taskId,
      sessionID,
      prompt: '',
      description,
      agent: 'task',
      parts: [],
      status:
        activity.kind === 'task.completed'
          ? 'completed'
          : activity.tone === 'error'
            ? 'error'
            : 'running'
    }
  }
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
    const serializedMessage =
      parseJson<OpenCodeMessage>(message.opencode_message_json) ??
      parseJson<OpenCodeMessage>(message.opencode_timeline_json)

    if (serializedMessage) {
      return {
        id: serializedMessage.id ?? message.opencode_message_id ?? message.id,
        role: serializedMessage.role ?? message.role,
        content: serializedMessage.content ?? message.content,
        timestamp: serializedMessage.timestamp ?? message.created_at,
        parts: serializedMessage.parts
      }
    }

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
    const existing = existingParts[partIndex].toolUse
    // Never downgrade a terminal status (success/error) back to running
    if (
      (existing?.status === 'success' || existing?.status === 'error') &&
      nextPart.toolUse?.status === 'running'
    ) {
      return existingParts
    }
    existingParts[partIndex] = nextPart
  } else {
    existingParts.push(nextPart)
  }

  return existingParts
}

function upsertSubtaskPart(
  parts: StreamingPart[] | undefined,
  nextPart: StreamingPart
): StreamingPart[] {
  const existingParts = parts ? [...parts] : []
  const nextSubtask = nextPart.subtask
  if (!nextSubtask) return existingParts

  const partIndex = existingParts.findIndex(
    (part) =>
      part.type === 'subtask' &&
      (part.subtask?.id === nextSubtask.id || part.subtask?.sessionID === nextSubtask.sessionID)
  )

  if (partIndex >= 0) {
    const existing = existingParts[partIndex].subtask
    existingParts[partIndex] = {
      type: 'subtask',
      subtask: {
        id: existing?.id ?? nextSubtask.id,
        sessionID: existing?.sessionID ?? nextSubtask.sessionID,
        prompt: nextSubtask.prompt || existing?.prompt || '',
        description: nextSubtask.description || existing?.description || '',
        agent: nextSubtask.agent || existing?.agent || 'task',
        parts: nextSubtask.parts.length > 0 ? nextSubtask.parts : (existing?.parts ?? []),
        status:
          nextSubtask.status === 'completed' || nextSubtask.status === 'error'
            ? nextSubtask.status
            : (existing?.status ?? nextSubtask.status)
      }
    }
    return existingParts
  }

  existingParts.push(nextPart)
  return existingParts
}

export function mergeCodexActivityMessages(
  baseMessages: OpenCodeMessage[],
  activityRows: SessionActivity[],
  sessionIsIdle?: boolean
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
      : activity.kind === 'plan.ready'
        ? parsePlanPart(activity)
        : parseTaskPart(activity)
    if (!activityPart) continue

    const toolId = activityPart.toolUse?.id
    if (toolId && knownToolIds.has(toolId)) {
      continue
    }

    const turnId = activity.turn_id
    const syntheticId = activityPart.toolUse
      ? turnId
        ? `${turnId}:tool:${toolId}`
        : `tool:${toolId}`
      : turnId
        ? `${turnId}:task:${activityPart.subtask?.id ?? activity.id}`
        : `task:${activityPart.subtask?.id ?? activity.id}`
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
    target.parts = activityPart.toolUse
      ? upsertToolPart(target.parts, activityPart)
      : upsertSubtaskPart(target.parts, activityPart)
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

  // ── Resolve stale "running" tools ────────────────────────────────
  // Build a set of item IDs that have terminal activities
  const completedItemIds = new Set(
    sortedActivities
      .filter((a) => a.kind === 'tool.completed' || a.kind === 'tool.failed')
      .map((a) => a.item_id)
      .filter((id): id is string => typeof id === 'string')
  )

  // Build ordered turn IDs to detect settled turns
  const turnIdOrder = getOrderedActivityTurnIds(activityRows)
  const lastTurnId = turnIdOrder[turnIdOrder.length - 1]

  for (const message of orderedMessages) {
    if (!message.parts) continue
    for (let i = 0; i < message.parts.length; i++) {
      const part = message.parts[i]
      if (part.type !== 'tool_use' || !part.toolUse) continue
      if (part.toolUse.status !== 'running') continue

      const toolId = part.toolUse.id
      // If we already have a completion event, the upsert should have handled it,
      // but double-check as a safety net
      if (completedItemIds.has(toolId)) {
        message.parts[i] = {
          ...part,
          toolUse: { ...part.toolUse, status: 'success' }
        }
        continue
      }

      // If this tool's turn is not the latest turn, the turn has settled
      // so this tool must have completed (event was lost/not persisted)
      const toolTurnId = message.id.match(/^([^:]+)/)?.[1]
      if (toolTurnId && toolTurnId !== lastTurnId) {
        message.parts[i] = {
          ...part,
          toolUse: { ...part.toolUse, status: 'success' }
        }
        continue
      }

      // If session is idle, even the latest turn's tools are done
      if (sessionIsIdle) {
        message.parts[i] = {
          ...part,
          toolUse: { ...part.toolUse, status: 'success' }
        }
      }
    }
  }

  return correlateSubtasksIntoTaskTools(orderedMessages)
}

export function deriveCodexTimelineMessages(
  messageRows: SessionMessage[],
  activityRows: SessionActivity[],
  sessionIsIdle?: boolean
): OpenCodeMessage[] {
  const normalizedMessages = normalizeCodexMessageRows(messageRows, activityRows)
  return mergeCodexActivityMessages(
    mapDbSessionMessagesToOpenCodeMessages(normalizedMessages),
    activityRows,
    sessionIsIdle
  )
}

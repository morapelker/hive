import type { OpenCodeMessage, StreamingPart, ToolUseInfo } from '@/lib/opencode-transcript'

type SubtaskInfo = NonNullable<StreamingPart['subtask']>

function cloneToolUse(toolUse: ToolUseInfo): ToolUseInfo {
  return {
    ...toolUse,
    input: { ...toolUse.input },
    subtasks: toolUse.subtasks?.map(cloneSubtask)
  }
}

function cloneSubtask(subtask: SubtaskInfo): SubtaskInfo {
  return {
    ...subtask,
    parts: subtask.parts.map(cloneStreamingPart)
  }
}

function cloneStreamingPart(part: StreamingPart): StreamingPart {
  if (part.type === 'tool_use' && part.toolUse) {
    return {
      ...part,
      toolUse: cloneToolUse(part.toolUse)
    }
  }

  if (part.type === 'subtask' && part.subtask) {
    return {
      ...part,
      subtask: cloneSubtask(part.subtask)
    }
  }

  return { ...part }
}

function isTaskToolUse(toolUse: ToolUseInfo | undefined): boolean {
  return toolUse?.name.toLowerCase() === 'task'
}

export function extractTaskReceiverThreadIds(toolUse: ToolUseInfo | undefined): string[] {
  const receiverThreadIds = toolUse?.input?.receiverThreadIds
  if (!Array.isArray(receiverThreadIds)) return []

  return receiverThreadIds.filter((value): value is string => typeof value === 'string')
}

function mergeToolPartParts(parts: StreamingPart[], nextPart: StreamingPart): StreamingPart[] {
  const nextParts = [...parts]

  if (nextPart.type === 'text') {
    const lastPart = nextParts[nextParts.length - 1]
    if (lastPart?.type === 'text') {
      nextParts[nextParts.length - 1] = {
        ...lastPart,
        text: `${lastPart.text ?? ''}${nextPart.text ?? ''}`
      }
    } else {
      nextParts.push({ type: 'text', text: nextPart.text ?? '' })
    }
    return nextParts
  }

  if (nextPart.type === 'tool_use' && nextPart.toolUse) {
    const existingToolIndex = nextParts.findIndex(
      (candidate) => candidate.type === 'tool_use' && candidate.toolUse?.id === nextPart.toolUse?.id
    )

    if (existingToolIndex >= 0) {
      nextParts[existingToolIndex] = {
        type: 'tool_use',
        toolUse: {
          ...cloneToolUse(nextParts[existingToolIndex].toolUse!),
          ...nextPart.toolUse,
          input: { ...nextParts[existingToolIndex].toolUse!.input, ...nextPart.toolUse.input },
          subtasks:
            nextPart.toolUse.subtasks ??
            nextParts[existingToolIndex].toolUse?.subtasks?.map(cloneSubtask)
        }
      }
    } else {
      nextParts.push(cloneStreamingPart(nextPart))
    }

    return nextParts
  }

  if (nextPart.type === 'subtask' && nextPart.subtask) {
    const existingSubtaskIndex = nextParts.findIndex(
      (candidate) =>
        candidate.type === 'subtask' &&
        (candidate.subtask?.id === nextPart.subtask?.id ||
          candidate.subtask?.sessionID === nextPart.subtask?.sessionID)
    )

    if (existingSubtaskIndex >= 0) {
      nextParts[existingSubtaskIndex] = {
        type: 'subtask',
        subtask: mergeSubtask(nextParts[existingSubtaskIndex].subtask!, nextPart)
      }
    } else {
      nextParts.push(cloneStreamingPart(nextPart))
    }
    return nextParts
  }

  nextParts.push(cloneStreamingPart(nextPart))
  return nextParts
}

function mergeSubtask(existing: SubtaskInfo, nextPart: StreamingPart): SubtaskInfo {
  if (nextPart.type === 'subtask' && nextPart.subtask) {
    const mergedParts = nextPart.subtask.parts.reduce(
      (parts, childPart) => mergeToolPartParts(parts, childPart),
      existing.parts.map(cloneStreamingPart)
    )

    return {
      ...existing,
      prompt: nextPart.subtask.prompt || existing.prompt,
      description: nextPart.subtask.description || existing.description,
      agent: nextPart.subtask.agent || existing.agent,
      status:
        nextPart.subtask.status === 'completed' || nextPart.subtask.status === 'error'
          ? nextPart.subtask.status
          : existing.status,
      parts: mergedParts
    }
  }

  return {
    ...existing,
    parts: mergeToolPartParts(existing.parts.map(cloneStreamingPart), nextPart)
  }
}

function buildInitialSubtask(childSessionId: string, nextPart: StreamingPart): SubtaskInfo {
  const base: SubtaskInfo = {
    id: childSessionId,
    sessionID: childSessionId,
    prompt: '',
    description: '',
    agent: 'task',
    parts: [],
    status: 'running'
  }

  if (nextPart.type === 'subtask' && nextPart.subtask) {
    return {
      ...base,
      id: nextPart.subtask.id || childSessionId,
      sessionID: nextPart.subtask.sessionID || childSessionId,
      prompt: nextPart.subtask.prompt || '',
      description: nextPart.subtask.description || '',
      agent: nextPart.subtask.agent || 'task',
      status: nextPart.subtask.status,
      parts: nextPart.subtask.parts.map(cloneStreamingPart)
    }
  }

  return {
    ...base,
    parts: mergeToolPartParts([], nextPart)
  }
}

function upsertToolSubtask(
  subtasks: SubtaskInfo[] | undefined,
  childSessionId: string,
  nextPart: StreamingPart
): SubtaskInfo[] {
  const nextSubtasks = subtasks?.map(cloneSubtask) ?? []
  const existingIndex = nextSubtasks.findIndex(
    (candidate) => candidate.id === childSessionId || candidate.sessionID === childSessionId
  )

  if (existingIndex >= 0) {
    nextSubtasks[existingIndex] = mergeSubtask(nextSubtasks[existingIndex], nextPart)
    return nextSubtasks
  }

  nextSubtasks.push(buildInitialSubtask(childSessionId, nextPart))
  return nextSubtasks
}

export function attachChildPartToTaskToolParts(
  parts: StreamingPart[] | undefined,
  childSessionId: string,
  nextPart: StreamingPart
): { attached: boolean; parts: StreamingPart[] } {
  const existingParts = parts?.map(cloneStreamingPart) ?? []

  let matchingTaskIndex = existingParts.findIndex(
    (candidate) =>
      candidate.type === 'tool_use' &&
      isTaskToolUse(candidate.toolUse) &&
      candidate.toolUse?.subtasks?.some(
        (subtask) => subtask.id === childSessionId || subtask.sessionID === childSessionId
      )
  )

  if (matchingTaskIndex < 0) {
    matchingTaskIndex = existingParts.findIndex(
      (candidate) =>
        candidate.type === 'tool_use' &&
        isTaskToolUse(candidate.toolUse) &&
        extractTaskReceiverThreadIds(candidate.toolUse).includes(childSessionId)
    )
  }

  if (matchingTaskIndex < 0) {
    return { attached: false, parts: existingParts }
  }

  const matchingTask = existingParts[matchingTaskIndex]
  if (matchingTask.type !== 'tool_use' || !matchingTask.toolUse) {
    return { attached: false, parts: existingParts }
  }

  existingParts[matchingTaskIndex] = {
    type: 'tool_use',
    toolUse: {
      ...cloneToolUse(matchingTask.toolUse),
      subtasks: upsertToolSubtask(matchingTask.toolUse.subtasks, childSessionId, nextPart)
    }
  }

  return { attached: true, parts: existingParts }
}

function buildTaskToolOwnership(
  messages: OpenCodeMessage[]
): Map<string, { messageIndex: number; partIndex: number }> {
  const owners = new Map<string, { messageIndex: number; partIndex: number }>()

  messages.forEach((message, messageIndex) => {
    message.parts?.forEach((part, partIndex) => {
      if (part.type !== 'tool_use' || !isTaskToolUse(part.toolUse)) return

      const receiverThreadIds = extractTaskReceiverThreadIds(part.toolUse)
      for (const receiverThreadId of receiverThreadIds) {
        if (!owners.has(receiverThreadId)) {
          owners.set(receiverThreadId, { messageIndex, partIndex })
        }
      }

      for (const subtask of part.toolUse.subtasks ?? []) {
        const childSessionId = subtask.sessionID || subtask.id
        if (childSessionId && !owners.has(childSessionId)) {
          owners.set(childSessionId, { messageIndex, partIndex })
        }
      }
    })
  })

  return owners
}

export function correlateSubtasksIntoTaskTools(messages: OpenCodeMessage[]): OpenCodeMessage[] {
  const nextMessages = messages.map((message) => ({
    ...message,
    parts: message.parts?.map(cloneStreamingPart)
  }))
  const owners = buildTaskToolOwnership(nextMessages)

  for (const message of nextMessages) {
    if (!message.parts || message.parts.length === 0) {
      continue
    }

    const nextParts: StreamingPart[] = []

    for (const part of message.parts) {
      if (part.type !== 'subtask' || !part.subtask) {
        nextParts.push(part)
        continue
      }

      const childSessionId = part.subtask.sessionID || part.subtask.id
      const owner = childSessionId ? owners.get(childSessionId) : undefined

      if (!owner) {
        nextParts.push(part)
        continue
      }

      const ownerMessage = nextMessages[owner.messageIndex]
      const ownerPart = ownerMessage.parts?.[owner.partIndex]
      if (ownerPart?.type !== 'tool_use' || !ownerPart.toolUse) {
        nextParts.push(part)
        continue
      }

      ownerMessage.parts![owner.partIndex] = {
        type: 'tool_use',
        toolUse: {
          ...cloneToolUse(ownerPart.toolUse),
          subtasks: upsertToolSubtask(ownerPart.toolUse.subtasks, childSessionId, part)
        }
      }
    }

    message.parts = nextParts.length > 0 ? nextParts : undefined
  }

  return nextMessages.filter(
    (message) => (message.parts?.length ?? 0) > 0 || message.content.length > 0
  )
}

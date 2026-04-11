import type { OpenCodeStreamEvent } from '@shared/types/opencode'
import { normalizeCodexToolName, stripShellPrefix } from '@shared/codex-tool-normalizer'
import type { CodexManagerEvent } from './codex-app-server-manager'
import { asObject, asString, asNumber } from './codex-utils'

// ── Content stream kind classification ───────────────────────────

export type ContentStreamKind =
  | 'assistant'
  | 'reasoning'
  | 'reasoning_summary'
  | 'command_output'
  | 'file_change_output'

/**
 * Maps actual Codex app-server JSON-RPC notification method names to a
 * ContentStreamKind. Returns null for methods that are not content deltas.
 *
 * These are the real method names the Codex app-server sends — NOT the
 * internal `content.delta` runtime event that t3code's adapter layer uses.
 */
export function contentStreamKindFromMethod(method: string): ContentStreamKind | null {
  switch (method) {
    case 'item/agentMessage/delta':
      return 'assistant'
    case 'item/reasoning/textDelta':
      return 'reasoning'
    case 'item/reasoning/summaryTextDelta':
      return 'reasoning_summary'
    case 'item/commandExecution/outputDelta':
      return 'command_output'
    case 'item/fileChange/outputDelta':
      return 'file_change_output'
    case 'item/plan/delta':
      return 'assistant'
    default:
      return null
  }
}

// ── Content delta extraction ──────────────────────────────────────

interface ContentDelta {
  kind: 'assistant' | 'reasoning'
  text: string
}

function toTextPart(text: string): { part: { type: 'text'; text: string }; delta: string } {
  return {
    part: { type: 'text', text },
    delta: text
  }
}

function toReasoningPart(text: string): {
  part: { type: 'reasoning'; text: string }
  delta: string
} {
  return {
    part: { type: 'reasoning', text },
    delta: text
  }
}

function normalizeCommandValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }

  if (!Array.isArray(value)) return undefined

  const parts = value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0)

  return parts.length > 0 ? parts.join(' ') : undefined
}

function normalizeToolInput(
  item: Record<string, unknown> | undefined,
  payload: Record<string, unknown> | undefined
): unknown {
  const rawInput = item?.input ?? payload?.input
  const inputRecord = asObject(rawInput)
  const command =
    normalizeCommandValue(item?.command) ??
    normalizeCommandValue(inputRecord?.command) ??
    normalizeCommandValue(payload?.command)
  const cleanCommand = command ? stripShellPrefix(command) : undefined
  const changes = Array.isArray(item?.changes) ? item.changes : undefined

  if (!cleanCommand && !changes) return rawInput

  return {
    ...(inputRecord ?? {}),
    ...(cleanCommand ? { command: cleanCommand } : {}),
    ...(changes ? { changes } : {})
  }
}

function extractContentDelta(event: CodexManagerEvent): ContentDelta | null {
  // The event mapper handles content delta notifications which carry text
  // deltas for either assistant output or reasoning (thinking) output.

  // Direct textDelta on event (set by manager for item/agentMessage/delta)
  if (event.textDelta) {
    return { kind: 'assistant', text: event.textDelta }
  }

  const payload = asObject(event.payload)
  if (!payload) return null

  const delta = asObject(payload.delta)

  // Structured delta object in payload (e.g. { type: 'text', text: '...' })
  if (delta) {
    const text = asString(delta.text)
    if (text) {
      const deltaType = asString(delta.type)
      const kind = deltaType === 'reasoning' ? 'reasoning' : 'assistant'
      return { kind, text }
    }
  }

  // Direct string delta in payload (item/agentMessage/delta sends this way)
  const directDelta = asString(payload.delta)
  if (directDelta) {
    return { kind: 'assistant', text: directDelta }
  }

  // payload.text (some delta methods send text directly here)
  const payloadText = asString(payload.text)
  if (payloadText) {
    return { kind: 'assistant', text: payloadText }
  }

  // Some formats put assistantText / reasoningText at payload level
  const assistantText = asString(payload.assistantText)
  if (assistantText) {
    return { kind: 'assistant', text: assistantText }
  }

  const reasoningText = asString(payload.reasoningText)
  if (reasoningText) {
    return { kind: 'reasoning', text: reasoningText }
  }

  return null
}

// ── Turn payload extraction ───────────────────────────────────────

interface TurnCompletedInfo {
  status: string
  error?: string
  usage?: Record<string, unknown>
  cost?: number
}

function extractTurnCompletedInfo(event: CodexManagerEvent): TurnCompletedInfo {
  const payload = asObject(event.payload)
  const turnObj = asObject(payload?.turn)

  const status = asString(turnObj?.status) ?? asString(payload?.state) ?? 'completed'

  const error = asString(turnObj?.error) ?? asString(payload?.error) ?? event.message

  const usage = asObject(turnObj?.usage) ?? asObject(payload?.usage)
  const cost = asNumber(turnObj?.cost) ?? asNumber(payload?.cost)

  return {
    status,
    ...(error && status === 'failed' ? { error } : {}),
    ...(usage ? { usage } : {}),
    ...(cost !== undefined ? { cost } : {})
  }
}

// ── Item payload extraction ───────────────────────────────────────

interface ItemInfo {
  itemType?: string
  toolName: string
  callId: string
  status?: string
  output?: unknown
  input?: unknown
}

function extractItemInfo(event: CodexManagerEvent): ItemInfo {
  const payload = asObject(event.payload)
  const item = asObject(payload?.item)
  const itemType = asString(item?.type) ?? asString(payload?.type)

  const toolName = normalizeCodexToolName(
    asString(item?.toolName) ??
    asString(item?.name) ??
    asString(item?.type) ??
    asString(payload?.toolName) ??
    'unknown'
  )

  const callId = asString(item?.id) ?? asString(event.itemId) ?? asString(payload?.itemId) ?? ''

  const status = asString(item?.status) ?? asString(payload?.status)
  const output =
    item?.output ?? item?.aggregatedOutput ?? payload?.output ?? payload?.aggregatedOutput
  const input = normalizeToolInput(item, payload)

  return {
    ...(itemType ? { itemType } : {}),
    toolName,
    callId,
    ...(status ? { status } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(input !== undefined ? { input } : {})
  }
}

function isToolLifecycleItem(item: ItemInfo): boolean {
  return item.itemType === 'commandExecution' || item.itemType === 'fileChange'
}

// ── Task payload extraction ───────────────────────────────────────

interface TaskInfo {
  taskId: string
  status: string
  message?: string
  progress?: number
}

function extractTaskInfo(event: CodexManagerEvent): TaskInfo {
  const payload = asObject(event.payload)
  const task = asObject(payload?.task)

  const taskId = asString(task?.id) ?? asString(payload?.taskId) ?? ''
  const status = asString(task?.status) ?? asString(payload?.status) ?? 'unknown'
  const message = asString(task?.message) ?? asString(payload?.message) ?? event.message
  const progress = asNumber(task?.progress) ?? asNumber(payload?.progress)

  return {
    taskId,
    status,
    ...(message ? { message } : {}),
    ...(progress !== undefined ? { progress } : {})
  }
}

// ── Main mapper ───────────────────────────────────────────────────

/**
 * Maps a Codex app-server manager event into one or more OpenCodeStreamEvent
 * objects that the Hive renderer understands.
 *
 * Returns an array because a single Codex notification may produce multiple
 * stream events (e.g. turn/completed → message.updated + session.status).
 */
export function mapCodexEventToStreamEvents(
  event: CodexManagerEvent,
  hiveSessionId: string
): OpenCodeStreamEvent[] {
  const annotateData = <T extends Record<string, unknown>>(data: T): T & { _codexEventId: string } => ({
    ...data,
    _codexEventId: event.id
  })

  const { method } = event

  // ── Approval requests — create/update tool card with command ──
  if (event.kind === 'request') {
    if (
      method === 'item/commandExecution/requestApproval' ||
      method === 'item/fileChange/requestApproval' ||
      method === 'item/fileRead/requestApproval'
    ) {
      const payload = asObject(event.payload)
      const item = asObject(payload?.item)
      const callId = event.itemId ?? asString(item?.id) ?? asString(payload?.itemId) ?? ''
      if (!callId) return []

      const toolName =
        method === 'item/commandExecution/requestApproval' ? 'Bash'
        : method === 'item/fileChange/requestApproval' ? 'fileChange'
        : 'Read'
      const input = normalizeToolInput(item, payload)

      return [{
        type: 'message.part.updated',
        sessionId: hiveSessionId,
        data: annotateData({
          part: {
            type: 'tool',
            callID: callId,
            tool: toolName,
            state: {
              status: 'running',
              ...(input !== undefined ? { input } : {})
            }
          }
        })
      }]
    }
    return []
  }

  // ── Content deltas — actual Codex notification methods ───────
  const streamKind = contentStreamKindFromMethod(method)
  if (streamKind) {
    const delta = extractContentDelta(event)
    if (!delta) return []

    return [
      {
        type: 'message.part.updated',
        sessionId: hiveSessionId,
        data: annotateData(
          streamKind === 'reasoning' || streamKind === 'reasoning_summary'
            ? toReasoningPart(delta.text)
            : toTextPart(delta.text)
        )
      }
    ]
  }

  // ── Turn started ──────────────────────────────────────────────
  if (method === 'turn/started') {
    return [
      {
        type: 'session.status',
        sessionId: hiveSessionId,
        data: annotateData({ status: { type: 'busy' } }),
        statusPayload: { type: 'busy' }
      }
    ]
  }

  // ── Turn completed ────────────────────────────────────────────
  if (method === 'turn/completed') {
    const info = extractTurnCompletedInfo(event)
    const events: OpenCodeStreamEvent[] = []

    if (info.status === 'failed') {
      events.push({
        type: 'session.error',
        sessionId: hiveSessionId,
        data: annotateData({ error: info.error ?? 'Turn failed' })
      })
    }

    // Emit a message.updated with usage/cost info when available
    if (info.usage || info.cost !== undefined) {
      events.push({
        type: 'message.updated',
        sessionId: hiveSessionId,
        data: annotateData({
          ...(info.usage ? { usage: info.usage } : {}),
          ...(info.cost !== undefined ? { cost: info.cost } : {})
        })
      })
    }

    // Always emit idle status on turn completion
    events.push({
      type: 'session.status',
      sessionId: hiveSessionId,
      data: annotateData({ status: { type: 'idle' } }),
      statusPayload: { type: 'idle' }
    })

    return events
  }

  // ── Item started (tool/command use) ──────────────────────────
  if (method === 'item.started' || method === 'item/started') {
    const item = extractItemInfo(event)
    if (!isToolLifecycleItem(item)) return []

    return [
      {
        type: 'message.part.updated',
        sessionId: hiveSessionId,
        data: annotateData({
          part: {
            type: 'tool',
            callID: item.callId,
            tool: item.toolName,
            state: {
              status: 'running',
              ...(item.input !== undefined ? { input: item.input } : {})
            }
          }
        })
      }
    ]
  }

  // ── Item updated ──────────��──────────────────────────────────
  if (method === 'item.updated' || method === 'item/updated') {
    const item = extractItemInfo(event)
    if (!isToolLifecycleItem(item)) return []

    return [
      {
        type: 'message.part.updated',
        sessionId: hiveSessionId,
        data: annotateData({
          part: {
            type: 'tool',
            callID: item.callId,
            tool: item.toolName,
            state: {
              status: item.status === 'failed' ? 'error' : 'running',
              ...(item.input !== undefined ? { input: item.input } : {})
            }
          }
        })
      }
    ]
  }

  // ── Item completed ───────────────────────────────────────────
  if (method === 'item.completed' || method === 'item/completed') {
    const item = extractItemInfo(event)
    if (!isToolLifecycleItem(item)) return []

    return [
      {
        type: 'message.part.updated',
        sessionId: hiveSessionId,
        data: annotateData({
          part: {
            type: 'tool',
            callID: item.callId,
            tool: item.toolName,
            state: {
              status: item.status === 'failed' ? 'error' : 'completed',
              ...(item.input !== undefined ? { input: item.input } : {}),
              ...(item.output !== undefined && item.status !== 'failed'
                ? { output: item.output }
                : {}),
              ...(item.output !== undefined && item.status === 'failed'
                ? { error: item.output }
                : {})
            }
          }
        })
      }
    ]
  }

  // ── Task lifecycle ───────────────────────────────────────────
  if (
    method === 'task.started' ||
    method === 'task/started' ||
    method === 'task.progress' ||
    method === 'task/progress' ||
    method === 'task.completed' ||
    method === 'task/completed'
  ) {
    const task = extractTaskInfo(event)
    return [
      {
        type: 'message.part.updated',
        sessionId: hiveSessionId,
        data: {
          type: 'task',
          taskId: task.taskId,
          status: task.status,
          ...(task.message ? { message: task.message } : {}),
          ...(task.progress !== undefined ? { progress: task.progress } : {})
        }
      }
    ]
  }

  // ── Session state changed ────────────────────────────────────
  if (method === 'session.state.changed' || method === 'session/state/changed') {
    const payload = asObject(event.payload)
    const state = asString(payload?.state)

    if (state === 'error') {
      const reason =
        asString(payload?.reason) ??
        asString(payload?.error) ??
        event.message ??
        'Session entered error state'
      return [
        {
          type: 'session.error',
          sessionId: hiveSessionId,
          data: { error: reason }
        }
      ]
    }

    // For running/ready states, emit status
    if (state === 'running') {
      return [
        {
          type: 'session.status',
          sessionId: hiveSessionId,
          data: { status: { type: 'busy' } },
          statusPayload: { type: 'busy' }
        }
      ]
    }

    if (state === 'ready') {
      return [
        {
          type: 'session.status',
          sessionId: hiveSessionId,
          data: { status: { type: 'idle' } },
          statusPayload: { type: 'idle' }
        }
      ]
    }

    return []
  }

  // ── Runtime error ────────────────────────────────────────────
  if (method === 'runtime.error' || method === 'runtime/error') {
    const payload = asObject(event.payload)
    const message =
      asString(payload?.message) ?? asString(payload?.error) ?? event.message ?? 'Runtime error'
    return [
      {
        type: 'session.error',
        sessionId: hiveSessionId,
        data: { error: message }
      }
    ]
  }

  // ── Manager-level error events (process crashes only) ────────
  if (event.kind === 'error') {
    // Only emit session.error for fatal process errors, not stderr warnings.
    // Stderr output is now emitted as kind: 'notification' with method
    // 'process/stderr' and silently dropped below.
    if (event.method === 'process/error') {
      const message = event.message ?? 'Unknown error'
      return [
        {
          type: 'session.error',
          sessionId: hiveSessionId,
          data: { error: message }
        }
      ]
    }
    return []
  }

  // ── Thread name updated (provider-generated title) ────────────────
  if (method === 'thread/name/updated') {
    const payload = asObject(event.payload)
    const title = asString(payload?.threadName)
    if (!title) return []

    return [
      {
        type: 'session.updated',
        sessionId: hiveSessionId,
        data: { title, info: { title } }
      }
    ]
  }

  // ── Stderr output (informational, silently drop) ───────────
  if (event.method === 'process/stderr') {
    return []
  }

  // ── Unrecognized events → empty (silently drop) ─────────────
  return []
}

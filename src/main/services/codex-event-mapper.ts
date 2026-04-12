import type { OpenCodeStreamEvent } from '@shared/types/opencode'
import { normalizeCodexToolName, stripShellPrefix } from '@shared/codex-tool-normalizer'
import type { CodexManagerEvent } from './codex-app-server-manager'
import { asObject, asString, asNumber } from './codex-utils'
import type { ThreadNameUpdatedNotification, TurnCompletedNotification, ThreadItem, CommandExecutionRequestApprovalParams, FileChangeRequestApprovalParams, TerminalInteractionNotification } from '@shared/codex-schemas/v2'

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
  // ── Typed fast-path: generated notification types all have `delta: string` ──
  const streamKind = contentStreamKindFromMethod(event.method)
  if (streamKind && event.payload && typeof event.payload === 'object' && 'delta' in event.payload) {
    const typed = event.payload as { delta: string }
    if (typeof typed.delta === 'string') {
      const kind = (streamKind === 'reasoning' || streamKind === 'reasoning_summary') ? 'reasoning' : 'assistant'
      return { kind, text: typed.delta }
    }
  }

  // ── Legacy fallback paths (unchanged) ──

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
  // ── Typed path: TurnCompletedNotification with Turn object ──
  const typed = event.payload as TurnCompletedNotification | undefined
  if (typed?.turn && typeof typed.turn === 'object' && typeof typed.turn.status === 'string') {
    const turn = typed.turn
    const errorMsg = typeof turn.error === 'object' && turn.error !== null
      ? turn.error.message
      // Defensive: handle legacy servers that may send error as a plain string
      // inside the typed turn structure (generated type says TurnError | null)
      : typeof turn.error === 'string' ? turn.error as unknown as string : undefined
    // usage/cost are not on the Turn type — check at payload level and inside turn (legacy extension)
    const payload = asObject(event.payload)
    const turnObj = asObject(payload?.turn)
    const usage = asObject(turnObj?.usage) ?? asObject(payload?.usage)
    const cost = asNumber(turnObj?.cost) ?? asNumber(payload?.cost)
    return {
      status: turn.status,
      ...(errorMsg && turn.status === 'failed' ? { error: errorMsg } : {}),
      ...(usage ? { usage } : {}),
      ...(cost !== undefined ? { cost } : {})
    }
  }

  // ── Fallback path (legacy) — unchanged ──
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

function isWellFormedThreadItem(item: { type: string; id: string; [k: string]: unknown }): boolean {
  switch (item.type) {
    case 'commandExecution':
      return typeof item.command === 'string' && typeof item.cwd === 'string'
    case 'fileChange':
      return Array.isArray(item.changes)
    case 'mcpToolCall':
      return typeof item.server === 'string' && typeof item.tool === 'string'
    case 'dynamicToolCall':
      return typeof item.tool === 'string' && 'arguments' in item
    case 'collabAgentToolCall':
      return typeof item.tool === 'string' && typeof item.senderThreadId === 'string'
    case 'webSearch':
      return typeof item.query === 'string'
    default:
      // Unknown item types → route through legacy fallback path
      return false
  }
}

function deriveInputFromThreadItem(item: ThreadItem): unknown {
  switch (item.type) {
    case 'commandExecution': {
      const command = stripShellPrefix(item.command)
      return { command }
    }
    case 'fileChange':
      return { changes: item.changes }
    case 'mcpToolCall':
    case 'dynamicToolCall':
      return item.arguments
    case 'collabAgentToolCall':
      return { prompt: item.prompt, receiverThreadIds: item.receiverThreadIds }
    case 'webSearch':
      return { query: item.query }
    default:
      return undefined
  }
}

function extractItemInfo(event: CodexManagerEvent): ItemInfo {
  // ── Typed path: ItemStartedNotification / ItemCompletedNotification ──
  const typed = event.payload as { item?: ThreadItem } | undefined
  const candidate = typed?.item
  if (candidate && typeof candidate === 'object' && typeof candidate.type === 'string' && typeof candidate.id === 'string' && isWellFormedThreadItem(candidate as { type: string; id: string; [k: string]: unknown })) {
    const item = candidate
    const itemType = item.type
    const toolName = normalizeCodexToolName(item.type)
    const callId = item.id || event.itemId || ''
    const status = 'status' in item ? String((item as any).status) : undefined
    const output = 'aggregatedOutput' in item ? (item as any).aggregatedOutput : undefined
    const input = deriveInputFromThreadItem(item)
    return {
      ...(itemType ? { itemType } : {}),
      toolName,
      callId,
      ...(status ? { status } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(input !== undefined ? { input } : {})
    }
  }

  // ── Fallback path (legacy) — unchanged ──
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

const TOOL_LIFECYCLE_ITEM_TYPES = new Set([
  'commandexecution',
  'filechange',
  'fileread',
  'dynamictoolcall',
  'collabagenttoolcall',
  'mcptoolcall',
  'websearch'
])

function isToolLifecycleItem(item: ItemInfo): boolean {
  if (!item.itemType) return false
  return TOOL_LIFECYCLE_ITEM_TYPES.has(item.itemType.toLowerCase())
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
  const events = mapCodexEventToStreamEventsInner(event, hiveSessionId)

  if (event.childThreadId) {
    for (const e of events) {
      e.childSessionId = event.childThreadId
    }
  }

  return events
}

function mapCodexEventToStreamEventsInner(
  event: CodexManagerEvent,
  hiveSessionId: string
): OpenCodeStreamEvent[] {
  // Attach Codex event ID for renderer-side dedup (seenCodexEventIds in
  // SessionView). Placed on stream event `data`; does NOT flow into canonical
  // message parts — extraction functions pick specific fields only.
  const annotateData = <T extends Record<string, unknown>>(data: T): T & { _codexEventId: string } => ({
    ...data,
    _codexEventId: event.id
  })

  const { method } = event

  // ── Approval requests — create/update tool card with command ──
  if (event.kind === 'request') {
    if (method === 'item/commandExecution/requestApproval') {
      const params = event.payload as CommandExecutionRequestApprovalParams | undefined
      const payload = asObject(event.payload)
      const item = asObject(payload?.item)
      const callId = event.itemId ?? params?.itemId ?? asString(item?.id) ?? asString(payload?.itemId) ?? ''
      if (!callId) return []
      const command = params?.command ? stripShellPrefix(params.command) : undefined
      // Typed path: build input from top-level params; fallback to normalizeToolInput for legacy
      const input = command ? { command } : normalizeToolInput(item, payload)
      return [{
        type: 'message.part.updated',
        sessionId: hiveSessionId,
        data: annotateData({
          part: {
            type: 'tool',
            callID: callId,
            tool: 'Bash',
            state: {
              status: 'running',
              ...(input !== undefined ? { input } : {})
            }
          }
        })
      }]
    }

    if (method === 'item/fileChange/requestApproval') {
      const params = event.payload as FileChangeRequestApprovalParams | undefined
      const fcPayload = asObject(event.payload)
      const fcItem = asObject(fcPayload?.item)
      const callId = event.itemId ?? params?.itemId ?? asString(fcItem?.id) ?? asString(fcPayload?.itemId) ?? ''
      if (!callId) return []
      return [{
        type: 'message.part.updated',
        sessionId: hiveSessionId,
        data: annotateData({
          part: {
            type: 'tool',
            callID: callId,
            tool: 'fileChange',
            state: { status: 'running' }
          }
        })
      }]
    }

    if (method === 'item/fileRead/requestApproval') {
      // No generated type — use existing asObject path
      const payload = asObject(event.payload)
      const item = asObject(payload?.item)
      const callId = event.itemId ?? asString(item?.id) ?? asString(payload?.itemId) ?? ''
      if (!callId) return []
      const input = normalizeToolInput(item, payload)
      return [{
        type: 'message.part.updated',
        sessionId: hiveSessionId,
        data: annotateData({
          part: {
            type: 'tool',
            callID: callId,
            tool: 'Read',
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

    // Route command/file-change output to the tool card as outputDelta
    if (
      (streamKind === 'command_output' || streamKind === 'file_change_output') &&
      event.itemId
    ) {
      return [{
        type: 'message.part.updated',
        sessionId: hiveSessionId,
        data: annotateData({
          part: {
            type: 'tool',
            callID: event.itemId,
            tool: streamKind === 'command_output' ? 'Bash' : 'fileChange',
            state: { status: 'running', outputDelta: delta.text }
          }
        })
      }]
    }

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
    const typed = event.payload as ThreadNameUpdatedNotification | undefined
    const title = typed?.threadName ?? asString(asObject(event.payload)?.threadName)
    if (!title) return []

    return [
      {
        type: 'session.updated',
        sessionId: hiveSessionId,
        data: { title, info: { title } }
      }
    ]
  }

  // ── Terminal interaction (treat as item update) ──────────────
  if (method === 'item/commandExecution/terminalInteraction') {
    const typed = event.payload as TerminalInteractionNotification | undefined
    const tiPayload = asObject(event.payload)
    const tiItem = asObject(tiPayload?.item)
    const callId = event.itemId ?? typed?.itemId ?? asString(tiItem?.id) ?? asString(tiPayload?.itemId) ?? ''
    if (!callId) return []

    return [
      {
        type: 'message.part.updated',
        sessionId: hiveSessionId,
        data: annotateData({
          part: {
            type: 'tool',
            callID: callId,
            tool: 'Bash',
            state: { status: 'running' }
          }
        })
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

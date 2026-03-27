import type { SessionActivityCreate, SessionActivityKind, SessionActivityTone } from '../db'
import type { CodexManagerEvent } from './codex-app-server-manager'
import { asObject, asString } from './codex-utils'

function stringifyPayload(payload: unknown): string | null {
  if (payload === undefined) return null
  try {
    return JSON.stringify(payload)
  } catch {
    return null
  }
}

function buildActivity(
  sessionId: string,
  agentSessionId: string,
  event: CodexManagerEvent,
  kind: SessionActivityKind,
  tone: SessionActivityTone,
  summary: string,
  payload: unknown = event.payload
): SessionActivityCreate {
  const payloadRecord =
    payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null
  const payloadTurnId =
    (typeof payloadRecord?.turnId === 'string' && payloadRecord.turnId) ||
    (typeof payloadRecord?.turn_id === 'string' && payloadRecord.turn_id) ||
    (typeof (payloadRecord?.turn as Record<string, unknown> | undefined)?.id === 'string'
      ? ((payloadRecord?.turn as Record<string, unknown>).id as string)
      : null)
  const payloadItemId =
    (typeof payloadRecord?.itemId === 'string' && payloadRecord.itemId) ||
    (typeof payloadRecord?.item_id === 'string' && payloadRecord.item_id) ||
    (typeof (payloadRecord?.item as Record<string, unknown> | undefined)?.id === 'string'
      ? ((payloadRecord?.item as Record<string, unknown>).id as string)
      : null)

  return {
    id: event.id,
    session_id: sessionId,
    agent_session_id: agentSessionId,
    thread_id: event.threadId,
    turn_id: event.turnId ?? payloadTurnId ?? null,
    item_id: event.itemId ?? payloadItemId ?? null,
    request_id: event.requestId ?? null,
    kind,
    tone,
    summary,
    payload_json: stringifyPayload(payload),
    created_at: event.createdAt
  }
}

export function mapCodexManagerEventToActivity(
  sessionId: string,
  agentSessionId: string,
  event: CodexManagerEvent
): SessionActivityCreate | null {
  const payload = asObject(event.payload)

  switch (event.method) {
    case 'item.started':
    case 'item/started':
    case 'item.updated':
    case 'item/updated':
    case 'item.completed':
    case 'item/completed': {
      const item = asObject(payload?.item)
      const itemType = asString(item?.type)?.toLowerCase()
      const toolName =
        asString(item?.toolName) ??
        asString(item?.name) ??
        asString(item?.type) ??
        asString(payload?.toolName) ??
        'unknown'
      const isTool = itemType === 'commandexecution' || itemType === 'filechange'
      if (!isTool) return null

      if (event.method === 'item.started' || event.method === 'item/started') {
        return buildActivity(sessionId, agentSessionId, event, 'tool.started', 'tool', toolName)
      }

      if (event.method === 'item.updated' || event.method === 'item/updated') {
        return buildActivity(sessionId, agentSessionId, event, 'tool.updated', 'tool', toolName)
      }

      const status = asString(item?.status) ?? asString(payload?.status)
      return buildActivity(
        sessionId,
        agentSessionId,
        event,
        status === 'failed' ? 'tool.failed' : 'tool.completed',
        status === 'failed' ? 'error' : 'tool',
        toolName
      )
    }

    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
    case 'item/fileRead/requestApproval':
      return buildActivity(
        sessionId,
        agentSessionId,
        event,
        'approval.requested',
        'approval',
        event.method
      )

    case 'item/tool/requestUserInput':
      return buildActivity(
        sessionId,
        agentSessionId,
        event,
        'user-input.requested',
        'approval',
        'User input requested'
      )

    case 'task.started':
    case 'task/started':
      return buildActivity(
        sessionId,
        agentSessionId,
        event,
        'task.started',
        'info',
        asString(payload?.message) ?? 'Task started'
      )

    case 'task.progress':
    case 'task/progress':
      return buildActivity(
        sessionId,
        agentSessionId,
        event,
        'task.updated',
        'info',
        asString(payload?.message) ?? 'Task progress'
      )

    case 'task.completed':
    case 'task/completed':
      return buildActivity(
        sessionId,
        agentSessionId,
        event,
        'task.completed',
        'info',
        asString(payload?.message) ?? 'Task completed'
      )

    case 'runtime.error':
    case 'runtime/error':
      return buildActivity(
        sessionId,
        agentSessionId,
        event,
        'session.error',
        'error',
        asString(payload?.message) ?? asString(payload?.error) ?? 'Runtime error'
      )

    case 'thread/name/updated':
      return buildActivity(
        sessionId,
        agentSessionId,
        event,
        'session.info',
        'info',
        asString(payload?.threadName) ?? 'Thread title updated'
      )

    default:
      return null
  }
}

import type { SessionActivityCreate, SessionActivityKind, SessionActivityTone } from '../db'
import { normalizeCodexToolName } from '@shared/codex-tool-normalizer'
import type { CodexManagerEvent } from './codex-app-server-manager'
import { asObject, asString } from './codex-utils'
import type { ItemStartedNotification } from '@shared/codex-schemas/v2/ItemStartedNotification'
import type { ItemCompletedNotification } from '@shared/codex-schemas/v2/ItemCompletedNotification'
import type { ThreadNameUpdatedNotification } from '@shared/codex-schemas/v2/ThreadNameUpdatedNotification'
import type { TurnPlanUpdatedNotification } from '@shared/codex-schemas/v2/TurnPlanUpdatedNotification'


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
      // Try typed access first, fall back to asObject/asString for legacy payloads
      const notification = event.payload as
        | ItemStartedNotification
        | ItemCompletedNotification
        | undefined
      const typedItem = notification?.item
      const legacyItem = asObject(payload?.item)

      // Detect item type: typed ThreadItem uses exact case (e.g. 'commandExecution'),
      // legacy payloads may use lowercase (e.g. 'commandexecution')
      const typedType = typedItem?.type
      const legacyType = asString(legacyItem?.type)?.toLowerCase()
      const isTool =
        typedType === 'commandExecution' ||
        typedType === 'fileChange' ||
        legacyType === 'commandexecution' ||
        legacyType === 'filechange'
      if (!isTool) return null

      const toolName = normalizeCodexToolName(
        typedType ??
        asString(legacyItem?.toolName) ??
        asString(legacyItem?.name) ??
        asString(legacyItem?.type) ??
        asString(payload?.toolName) ??
        'unknown'
      )

      if (event.method === 'item.started' || event.method === 'item/started') {
        return buildActivity(sessionId, agentSessionId, event, 'tool.started', 'tool', toolName)
      }

      if (event.method === 'item.updated' || event.method === 'item/updated') {
        return buildActivity(sessionId, agentSessionId, event, 'tool.updated', 'tool', toolName)
      }

      const typedStatus =
        typedItem?.type === 'commandExecution' ? typedItem.status :
        typedItem?.type === 'fileChange' ? typedItem.status :
        undefined
      const status = typedStatus ?? asString(legacyItem?.status) ?? asString(payload?.status)
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

    case 'thread/name/updated': {
      const params = event.payload as ThreadNameUpdatedNotification | undefined
      return buildActivity(
        sessionId,
        agentSessionId,
        event,
        'session.info',
        'info',
        params?.threadName ?? asString(payload?.threadName) ?? 'Thread title updated'
      )
    }

    case 'turn/plan/updated': {
      const params = event.payload as TurnPlanUpdatedNotification | undefined
      const plan = params?.plan ?? payload?.plan
      const steps = Array.isArray(plan) ? plan : []
      const completedCount = steps.filter((step) => {
        const stepObj = asObject(step)
        return asString(stepObj?.status) === 'completed'
      }).length
      const summary =
        steps.length > 0 ? `Plan updated (${completedCount}/${steps.length} completed)` : 'Plan updated'

      return buildActivity(sessionId, agentSessionId, event, 'session.info', 'info', summary)
    }

    default:
      return null
  }
}

import { isAgentCli } from '@shared/types/agent-sdk'
import type { OpenCodeStreamEvent } from '@shared/types/opencode'
import type { SessionFinalMessageUpsert } from './db-port'

/** `hook_event` of a turn end that came from an SDK stream rather than a CLI hook. */
export const SDK_IDLE_EVENT = 'SdkIdle'
/** `hook_event` of an SDK session getting back to work. */
export const SDK_BUSY_EVENT = 'SdkBusy'

export interface SdkTurnRecorderDeps {
  subscribe: (listener: (event: OpenCodeStreamEvent) => void) => () => void
  getSessionSdk: (sessionId: string) => string | null | undefined
  record: (input: SessionFinalMessageUpsert) => void
}

type TurnStateChange = Pick<SessionFinalMessageUpsert, 'state' | 'hook_event' | 'detail'>

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null

/** The first question's text of a `question.asked` payload, when it has one. */
function questionText(data: unknown): string | null {
  const questions = asRecord(data)?.questions
  const first = Array.isArray(questions) ? asRecord(questions[0]) : null
  return first ? (text(first.question) ?? text(first.header)) : null
}

// Blocking events are recorded under the same names as the CLI statuses they correspond to.
function turnStateOf(event: OpenCodeStreamEvent): TurnStateChange | null {
  switch (event.type) {
    case 'session.status':
      if (event.statusPayload?.type === 'idle') {
        return { state: 'ended', hook_event: SDK_IDLE_EVENT, detail: null }
      }
      if (event.statusPayload?.type === 'busy') {
        return { state: 'working', hook_event: SDK_BUSY_EVENT, detail: null }
      }
      return null
    case 'question.asked':
      return { state: 'blocked', hook_event: 'answering', detail: questionText(event.data) }
    case 'permission.asked':
      return {
        state: 'blocked',
        hook_event: 'permission',
        detail: text(asRecord(event.data)?.permission)
      }
    case 'plan.ready':
      return { state: 'blocked', hook_event: 'plan_ready', detail: null }
    case 'command.approval_needed':
      return {
        state: 'blocked',
        hook_event: 'command_approval',
        detail: text(asRecord(event.data)?.commandStr)
      }
    // The implementers emit `busy` once per prompt, not when a block is lifted: without these
    // the row would say "blocked" for the rest of the turn. A rejection on abort is followed
    // by the idle that ends the turn, which is recorded over this.
    case 'question.replied':
    case 'question.rejected':
    case 'permission.replied':
    case 'command.approval_replied':
    case 'plan.resolved':
      return { state: 'working', hook_event: SDK_BUSY_EVENT, detail: null }
    default:
      return null
  }
}

/**
 * SDK-driven sessions (claude-code, codex, opencode) have no hooks: their turn ends when the
 * stream reports `session.status: idle`, and they stop for the user with question, permission
 * and plan events. Record those like the CLI hooks do, so a document run that was not watching
 * (its window was closed or reloaded) still learns what the session is doing. The text stays
 * empty; the message is read from the provider's own store when it is judged.
 */
export function startSdkTurnRecorder(deps: SdkTurnRecorderDeps): () => void {
  // A busy stream repeats itself; only a change of state is worth a write.
  const lastRecorded = new Map<string, string>()
  return deps.subscribe((event) => {
    // A subagent's events are not the session's own.
    if (event.childSessionId || !event.sessionId) return
    const change = turnStateOf(event)
    if (!change) return
    const key = `${change.state}\u0000${change.hook_event}\u0000${change.detail ?? ''}`
    if (change.state !== 'ended' && lastRecorded.get(event.sessionId) === key) return
    try {
      // CLI sessions record their own, richer turn end from the Stop hook.
      if (isAgentCli(deps.getSessionSdk(event.sessionId))) return
      lastRecorded.set(event.sessionId, key)
      deps.record({
        session_id: event.sessionId,
        ...change,
        ...(change.state === 'ended' ? { text: '' } : {}),
        completion: null,
        api_error: null
      })
    } catch {
      // The stream must never fail on bookkeeping.
    }
  })
}

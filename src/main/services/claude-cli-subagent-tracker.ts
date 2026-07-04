// Type-only import: claude-hook-server imports this module at runtime, so a
// runtime import back would create a cycle.
import type { ClaudeCliStatusPayload, ParsedClaudeHook } from './claude-hook-server'

/**
 * Since claude-cli v2.1.198, Task subagents can run in the background: the
 * main agent's `Stop` hook can fire while subagents are still running, and
 * claude-cli auto-resumes the session (as a fresh turn) once they finish.
 * Naively mapping every main `Stop` to a 'completed' session status would
 * flicker the UI/kanban to "done" mid-flight.
 *
 * This module tracks, per session, whether a `Stop` is truly final:
 * - `background_tasks` on the Stop payload is the CLI's authoritative
 *   snapshot of in-flight subagent work at stop time.
 * - A background subagent's completion is delivered as a *separate* turn (a
 *   `UserPromptSubmit` "task-notification" hook); `pendingNotifications`
 *   covers the gap between a subagent finishing mid-turn and that
 *   notification turn actually starting.
 * - A deferred Stop is never resolved by mere inactivity — the resume turn
 *   always ends with its own `Stop`, which re-evaluates. The timer/handler
 *   here is purely a lost-event safety net.
 */

export interface ClaudeCliBackgroundTask {
  id?: string
  type?: string
  status?: string
}

// `ParsedClaudeHook` already declares agent_id/agent_type/background_tasks
// (claude-hook-server.ts), so this is just a local alias for readability at
// this module's call sites — not a distinct shape.
export type ClaudeCliTrackedHook = ParsedClaudeHook

export const SUBAGENT_RESUME_TIMEOUT_MS = 90_000 // deferred with only pending notifications: resume should be near-immediate
export const SUBAGENT_WATCHDOG_TIMEOUT_MS = 600_000 // deferred with running subagents: long tool calls can be hook-silent for minutes

export type SubagentGateResult =
  | { kind: 'pass' } // hook proceeds through ledger + publish as today
  | { kind: 'defer_stop' } // main Stop swallowed; session not done
  | { kind: 'subagent_scoped' } // Stop carrying agent_id — never a session completion

export type DeferredCompletionHandler = (
  sessionId: string,
  payload: ClaudeCliStatusPayload,
  lastAssistantMessage?: string
) => boolean // false ⇒ not safe to complete now (blocking interaction pending) ⇒ tracker re-arms

interface DeferredCompletion {
  payload: ClaudeCliStatusPayload
  lastAssistantMessage?: string
  running: Set<string> // running subagent task ids from the deferred Stop's background_tasks
}

interface SessionState {
  pendingNotifications: Set<string> // background subagent ids whose results haven't been consumed by a resume yet
  deferred: DeferredCompletion | null
  timer: NodeJS.Timeout | null
}

// sessionId -> tracking state
//
// Accepted race: a hook can arrive after a PTY teardown has already cleared
// this session (Esc/exit) and re-create bounded state for a now-dead session
// — e.g. a pending-notification entry from a late SubagentStop, or a
// deferring Stop that arms a timer whose eventual watchdog publish is simply
// dedup-swallowed by publishClaudeCliStatus/SessionStart clears. This state
// is bounded and self-heals on the next SessionStart (full clear) or PTY
// restart, or expires on its own via the watchdog, so it is not worth
// guarding against here.
const sessions = new Map<string, SessionState>()

let deferredCompletionHandler: DeferredCompletionHandler | null = null

const TASK_NOTIFICATION_PREFIX = '<task-notification>'
const TASK_ID_PATTERN = /<task-id>([^<]*)<\/task-id>/g

export function setClaudeCliDeferredCompletionHandler(h: DeferredCompletionHandler | null): void {
  deferredCompletionHandler = h
}

/**
 * True iff `prompt` is a string whose trimmed start begins with the
 * task-notification marker tag. This is the authoritative "is this a
 * notification resume, not a user-authored prompt" check — it must stay true
 * even for a marker-prefixed prompt with zero parseable `<task-id>` blocks,
 * so callers gating turn-boundary behavior (ledger reset, first-prompt
 * announce, status metadata) should use this rather than checking whether
 * `parseTaskNotificationIds` returned anything.
 */
export function isTaskNotificationPrompt(prompt: unknown): boolean {
  return typeof prompt === 'string' && prompt.trimStart().startsWith(TASK_NOTIFICATION_PREFIX)
}

/**
 * Pure parse of a Claude CLI background-task-resume prompt. Not a
 * notification unless the (trimmed) prompt starts with the marker tag; a
 * single resume can carry several `<task-id>` blocks (batch resume).
 */
export function parseTaskNotificationIds(prompt: unknown): string[] {
  if (!isTaskNotificationPrompt(prompt)) return []

  const ids: string[] = []
  for (const match of (prompt as string).trimStart().matchAll(TASK_ID_PATTERN)) {
    ids.push(match[1])
  }
  return ids
}

function getOrCreateState(sessionId: string): SessionState {
  let state = sessions.get(sessionId)
  if (!state) {
    state = { pendingNotifications: new Set(), deferred: null, timer: null }
    sessions.set(sessionId, state)
  }
  return state
}

function pruneIfEmpty(sessionId: string, state: SessionState): void {
  if (state.pendingNotifications.size === 0 && state.deferred === null && state.timer === null) {
    sessions.delete(sessionId)
  }
}

/** Restart (or cancel) the deferral timer to match the current state. */
function rearm(sessionId: string): void {
  const state = sessions.get(sessionId)
  if (!state) return

  if (state.timer) {
    clearTimeout(state.timer)
    state.timer = null
  }

  if (state.deferred) {
    const timeoutMs =
      state.deferred.running.size > 0 ? SUBAGENT_WATCHDOG_TIMEOUT_MS : SUBAGENT_RESUME_TIMEOUT_MS
    state.timer = setTimeout(() => onTimerFire(sessionId), timeoutMs)
  }

  pruneIfEmpty(sessionId, state)
}

function onTimerFire(sessionId: string): void {
  const state = sessions.get(sessionId)
  if (!state || !state.deferred) return

  if (!deferredCompletionHandler) {
    // No one registered to decide — safest is to stop holding the session open.
    clearClaudeCliSubagentTracking(sessionId)
    return
  }

  const { payload, lastAssistantMessage } = state.deferred
  const safeToComplete = deferredCompletionHandler(sessionId, payload, lastAssistantMessage)
  if (safeToComplete) {
    clearClaudeCliSubagentTracking(sessionId)
  } else {
    state.timer = setTimeout(() => onTimerFire(sessionId), SUBAGENT_WATCHDOG_TIMEOUT_MS)
  }
}

function runningSubagentIds(backgroundTasks: ClaudeCliBackgroundTask[] | undefined): Set<string> {
  const ids = new Set<string>()
  for (const task of backgroundTasks ?? []) {
    if (task.type === 'subagent' && task.status === 'running' && task.id) ids.add(task.id)
  }
  return ids
}

function isSelfListed(backgroundTasks: ClaudeCliBackgroundTask[] | undefined, agentId: string): boolean {
  return (backgroundTasks ?? []).some(
    (task) => task.id === agentId && task.type === 'subagent' && task.status === 'running'
  )
}

/**
 * Feed a Claude CLI hook through the subagent state machine and decide
 * whether the caller should treat this as a normal hook (`pass`), swallow a
 * `Stop` because background subagents are still in flight (`defer_stop`), or
 * ignore a `Stop` scoped to a subagent turn (`subagent_scoped`).
 */
export function processClaudeCliSubagentHook(
  sessionId: string,
  hook: ClaudeCliTrackedHook,
  mapped: ClaudeCliStatusPayload | null
): SubagentGateResult {
  const event = hook.hook_event_name ?? ''

  if (event === 'SessionStart' || event === 'SessionEnd') {
    clearClaudeCliSubagentTracking(sessionId)
    return { kind: 'pass' }
  }

  if (event === 'UserPromptSubmit') {
    const state = sessions.get(sessionId)
    if (state) {
      for (const id of parseTaskNotificationIds(hook.prompt)) {
        state.pendingNotifications.delete(id)
      }
      state.deferred = null
      if (state.timer) {
        clearTimeout(state.timer)
        state.timer = null
      }
      pruneIfEmpty(sessionId, state)
    }
    return { kind: 'pass' }
  }

  if (event === 'SubagentStop' && hook.agent_id) {
    const agentId = hook.agent_id
    if (isSelfListed(hook.background_tasks, agentId)) {
      getOrCreateState(sessionId).pendingNotifications.add(agentId)
    }
    sessions.get(sessionId)?.deferred?.running.delete(agentId)
    rearm(sessionId)
    return { kind: 'pass' }
  }

  if (event === 'Stop' && hook.agent_id) {
    rearm(sessionId)
    return { kind: 'subagent_scoped' }
  }

  if (event === 'Stop') {
    const running = runningSubagentIds(hook.background_tasks)
    const pendingCount = sessions.get(sessionId)?.pendingNotifications.size ?? 0

    if (running.size === 0 && pendingCount === 0) {
      clearClaudeCliSubagentTracking(sessionId)
      return { kind: 'pass' }
    }

    const state = getOrCreateState(sessionId)
    state.deferred = {
      payload: mapped ?? { sessionId, status: 'completed', metadata: { hookEventName: 'Stop' } },
      lastAssistantMessage: hook.last_assistant_message ?? hook.assistant_message,
      running
    }
    rearm(sessionId)
    return { kind: 'defer_stop' }
  }

  // SubagentStart, SubagentStop without agent_id, or any other hook.
  rearm(sessionId)
  return { kind: 'pass' }
}

export function isClaudeCliCompletionDeferred(sessionId: string): boolean {
  return sessions.get(sessionId)?.deferred != null
}

export function hasPendingClaudeCliSubagentWork(sessionId: string): boolean {
  const state = sessions.get(sessionId)
  if (!state) return false
  return (state.deferred?.running.size ?? 0) > 0 || state.pendingNotifications.size > 0
}

export function clearClaudeCliSubagentTracking(sessionId: string): void {
  const state = sessions.get(sessionId)
  if (state?.timer) clearTimeout(state.timer)
  sessions.delete(sessionId)
}

export function clearAllClaudeCliSubagentTracking(): void {
  for (const state of sessions.values()) {
    if (state.timer) clearTimeout(state.timer)
  }
  sessions.clear()
}

// Type-only import: claude-hook-server imports this module at runtime, so a
// runtime import back would create a cycle.
import type { ParsedClaudeHook } from './claude-hook-server'
import { isTaskNotificationPrompt } from './claude-cli-subagent-tracker'

/**
 * Counts a Claude CLI session's live background work from hook payloads alone
 * (validated empirically against claude v2.1.218 with the claude-playground
 * prototype):
 *
 * - A background shell starts at `PostToolUse` for Bash with
 *   `tool_input.run_in_background` and a `tool_response.backgroundTaskId`
 *   (PostToolUse fires immediately for backgrounded commands). A monitor
 *   starts at `PostToolUse` for Monitor with a `tool_response.taskId`; a
 *   failed launch has no id and must never count.
 * - `TaskStop` is the one ending that never produces a task notification, so
 *   its `tool_input.task_id` retires the task directly.
 * - Completions are delivered as `UserPromptSubmit` resume turns whose prompt
 *   carries `<task-notification>` blocks. A block is terminal only when it has
 *   a `<status>` tag (completed/failed/killed/stopped) or the literal
 *   monitor-timeout `<event>` — routine monitor events have neither and must
 *   not retire the monitor.
 * - A task finishing mid-turn fires NO hook at all; the `background_tasks`
 *   snapshot on every Stop/SubagentStop payload (claude >= 2.1.145) is the
 *   authoritative reconciliation that self-heals such gaps at each turn
 *   boundary (both shells and monitors appear there as type 'shell', so it
 *   can prune but never classify — classification only happens at start).
 * - SessionStart/SessionEnd clear everything; background tasks never survive
 *   the CLI process, and orphans are reported to the *next* session.
 */

export interface ClaudeCliBackgroundWorkCounts {
  runningShells: number
  runningMonitors: number
}

interface SessionWork {
  shells: Set<string>
  monitors: Set<string>
}

// sessionId -> live background-task ids. Same accepted race as the subagent
// tracker: a late hook can re-create bounded state for a dead session, which
// self-heals on the next SessionStart/PTY teardown clear.
const sessions = new Map<string, SessionWork>()

/** The literal `<event>` text of a monitor-timeout notification — the only
 * terminal monitor notification that carries no `<status>` tag. */
export const MONITOR_TIMEOUT_EVENT = '[Monitor timed out — re-arm if needed.]'

const NOTIFICATION_BLOCK_PATTERN = /<task-notification>([\s\S]*?)<\/task-notification>/g

function getOrCreateWork(sessionId: string): SessionWork {
  let work = sessions.get(sessionId)
  if (!work) {
    work = { shells: new Set(), monitors: new Set() }
    sessions.set(sessionId, work)
  }
  return work
}

function pruneIfEmpty(sessionId: string, work: SessionWork): void {
  if (work.shells.size === 0 && work.monitors.size === 0) {
    sessions.delete(sessionId)
  }
}

function counts(work: SessionWork | undefined): ClaudeCliBackgroundWorkCounts {
  return {
    runningShells: work?.shells.size ?? 0,
    runningMonitors: work?.monitors.size ?? 0
  }
}

function tagText(block: string, tag: string): string | null {
  const open = `<${tag}>`
  const close = `</${tag}>`
  const start = block.indexOf(open)
  if (start === -1) return null
  const end = block.indexOf(close, start + open.length)
  if (end === -1) return null
  return block.slice(start + open.length, end).trim()
}

/**
 * Task ids of *terminal* `<task-notification>` blocks in a resume prompt.
 * Unlike the subagent tracker's parseTaskNotificationIds (every id), this
 * keeps only blocks that actually end a task: ones carrying a `<status>` tag
 * or the monitor-timeout event.
 */
export function parseEndedTaskNotificationIds(prompt: unknown): string[] {
  if (!isTaskNotificationPrompt(prompt)) return []

  const ids: string[] = []
  for (const match of (prompt as string).matchAll(NOTIFICATION_BLOCK_PATTERN)) {
    const block = match[1]
    const terminal =
      tagText(block, 'status') !== null || tagText(block, 'event') === MONITOR_TIMEOUT_EVENT
    if (!terminal) continue
    const id = tagText(block, 'task-id')
    if (id) ids.push(id)
  }
  return ids
}

function responseId(hook: ParsedClaudeHook, field: string): string | null {
  const response = hook.tool_response
  if (typeof response !== 'object' || response === null) return null
  const id = (response as Record<string, unknown>)[field]
  return typeof id === 'string' && id.length > 0 ? id : null
}

function canStartBackgroundWork(hook: ParsedClaudeHook): boolean {
  return (
    hook.hook_event_name === 'PostToolUse' &&
    (hook.tool_name === 'Bash' || hook.tool_name === 'Monitor')
  )
}

function observePostToolUse(work: SessionWork, hook: ParsedClaudeHook): void {
  switch (hook.tool_name) {
    case 'Bash': {
      // A denied or failed launch has no backgroundTaskId — never count it.
      if (hook.tool_input?.run_in_background === true) {
        const id = responseId(hook, 'backgroundTaskId')
        if (id) work.shells.add(id)
      }
      return
    }
    case 'Monitor': {
      const id = responseId(hook, 'taskId')
      if (id) work.monitors.add(id)
      return
    }
    case 'TaskStop': {
      const id = hook.tool_input?.task_id
      if (typeof id === 'string') {
        work.shells.delete(id)
        work.monitors.delete(id)
      }
      return
    }
  }
}

function reconcileWithSnapshot(work: SessionWork, hook: ParsedClaudeHook): void {
  // Older claude versions omit the key entirely — only an actual snapshot may
  // prune (an empty array is an authoritative "nothing is running").
  const tasks = hook.background_tasks
  if (!Array.isArray(tasks)) return

  const running = new Set<string>()
  for (const task of tasks) {
    if (task.status === 'running' && task.id) running.add(task.id)
  }
  for (const id of work.shells) {
    if (!running.has(id)) work.shells.delete(id)
  }
  for (const id of work.monitors) {
    if (!running.has(id)) work.monitors.delete(id)
  }
}

/**
 * Feed a Claude CLI hook through the background-work counter. Returns the new
 * counts when they changed, or null when the hook left them untouched.
 */
export function processClaudeCliBackgroundWorkHook(
  sessionId: string,
  hook: ParsedClaudeHook
): ClaudeCliBackgroundWorkCounts | null {
  const event = hook.hook_event_name ?? ''

  if (event === 'SessionStart' || event === 'SessionEnd') {
    return clearClaudeCliBackgroundWork(sessionId) ? counts(undefined) : null
  }

  const existing = sessions.get(sessionId)
  // With nothing tracked, only a task START can change counts — every other
  // event just removes/reconciles. Skip the transient state allocation this
  // hot path (every tool use of every session) would otherwise churn through.
  if (!existing && !canStartBackgroundWork(hook)) {
    return null
  }
  const before = counts(existing)
  const work = existing ?? getOrCreateWork(sessionId)

  if (event === 'PostToolUse') {
    observePostToolUse(work, hook)
  } else if (event === 'UserPromptSubmit') {
    for (const id of parseEndedTaskNotificationIds(hook.prompt)) {
      work.shells.delete(id)
      work.monitors.delete(id)
    }
  } else if (event === 'Stop' || event === 'SubagentStop') {
    reconcileWithSnapshot(work, hook)
  }

  const after = counts(work)
  pruneIfEmpty(sessionId, work)
  return after.runningShells !== before.runningShells ||
    after.runningMonitors !== before.runningMonitors
    ? after
    : null
}

export function getClaudeCliBackgroundWorkCounts(sessionId: string): ClaudeCliBackgroundWorkCounts {
  return counts(sessions.get(sessionId))
}

/** Drop a session's tracked work. Returns true when it had live counts (the
 * caller should publish zeros so the renderer badge clears). */
export function clearClaudeCliBackgroundWork(sessionId: string): boolean {
  const work = sessions.get(sessionId)
  if (!work) return false
  sessions.delete(sessionId)
  return work.shells.size > 0 || work.monitors.size > 0
}

export function clearAllClaudeCliBackgroundWork(): void {
  sessions.clear()
}

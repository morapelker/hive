/**
 * Completion detection for Claude CLI `Stop` hooks.
 *
 * Claude fires `Stop` every time the main agent ends a turn — including turns
 * where it deliberately pauses to wait for something it started that will wake
 * it again later: a background shell (Bash with run_in_background), a Monitor
 * watch, a background subagent or Workflow, or a scheduled wakeup
 * (ScheduleWakeup / CronCreate / `/loop`). In those turns the final assistant
 * message is an intermediate status update ("waiting for the build…"), not the
 * completion message, so treating every Stop as "done" reports completion too
 * early.
 *
 * Since claude 2.1.2xx the Stop body carries two arrays that settle it
 * (validated against claude 2.1.269 with the claude-playground prototype):
 *
 * - `background_tasks`: every in-flight background task (shell, subagent,
 *   monitor, workflow, teammate, cloud session, MCP task). A Monitor watch is
 *   reported as `type: "shell"`, so classification never keys on the label.
 * - `session_crons`: every session-scoped scheduled wakeup.
 *
 * Rule: the turn is a completion only when both arrays are empty. When either
 * is non-empty the session is paused and will be re-invoked (background work
 * resumes it with a `<task-notification>` prompt; a cron fires its scheduled
 * prompt), so the message is intermediate. A body that carries neither array
 * predates the feature and cannot be told apart from a pause.
 *
 * The wording of `last_assistant_message` is never used as a signal.
 */

export type ClaudeCliStopCompletionKind = 'completed' | 'waiting' | 'unknown'

/**
 * Why a Claude CLI session's `completed` status was published, as far as the
 * ticket board is concerned:
 * - `completed`: a Stop hook with nothing in flight and nothing scheduled — the
 *   real completion message.
 * - `waiting`: a Stop hook while background tasks or scheduled wakeups are
 *   still pending — the agent will be woken again.
 * - `unknown`: a Stop hook from an older claude that reports neither array.
 * - `none`: the status did not come from a Stop hook at all (user interrupt,
 *   PTY exit, SessionEnd, …) — no completion message was ever produced.
 */
export type ClaudeCliCompletion = ClaudeCliStopCompletionKind | 'none'

export interface ClaudeCliStopCompletion {
  kind: ClaudeCliStopCompletionKind
  /** In-flight background tasks reported on the Stop body. */
  pendingTasks: number
  /** Session-scoped scheduled wakeups reported on the Stop body. */
  pendingWakeups: number
}

/** The subset of a Stop hook body the classifier reads. */
export interface ClaudeCliStopCompletionInput {
  background_tasks?: unknown
  session_crons?: unknown
}

/**
 * Classify a Stop hook body as a completion or an intermediate pause. Pure:
 * reads only `background_tasks` / `session_crons`.
 */
export function classifyClaudeCliStopCompletion(
  hook: ClaudeCliStopCompletionInput
): ClaudeCliStopCompletion {
  const tasks = Array.isArray(hook.background_tasks) ? hook.background_tasks : null
  const wakeups = Array.isArray(hook.session_crons) ? hook.session_crons : null

  if (tasks === null && wakeups === null) {
    return { kind: 'unknown', pendingTasks: 0, pendingWakeups: 0 }
  }

  const pendingTasks = tasks?.length ?? 0
  const pendingWakeups = wakeups?.length ?? 0
  return {
    kind: pendingTasks === 0 && pendingWakeups === 0 ? 'completed' : 'waiting',
    pendingTasks,
    pendingWakeups
  }
}

/**
 * Whether a Claude CLI completion signal counts as "the work is done" for the
 * ticket board. `unknown` fails open (an older claude cannot report pending
 * work, and flagging every one of its tickets as unfinished would be noise);
 * everything else that is not a clean Stop — a pause, or no Stop at all —
 * leaves the ticket awaiting completion.
 */
export function isClaudeCliCompletionDetected(completion: ClaudeCliCompletion): boolean {
  return completion === 'completed' || completion === 'unknown'
}

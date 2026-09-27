/**
 * Completion detection for Claude CLI `Stop` hooks.
 *
 * Claude fires `Stop` every time the main agent ends a turn — including turns
 * where it deliberately pauses to wait for something it started that will wake
 * it again later: a Monitor watch, a background subagent or Workflow, or a
 * scheduled wakeup (ScheduleWakeup / CronCreate / `/loop`). In those turns the
 * final assistant message is an intermediate status update ("waiting for the
 * build…"), not the completion message, so treating every Stop as "done"
 * reports completion too early.
 *
 * Since claude 2.1.2xx the Stop body carries two arrays that settle it
 * (validated against claude 2.1.269 with the claude-playground prototype):
 *
 * - `background_tasks`: every in-flight background task (shell, subagent,
 *   monitor, workflow, teammate, cloud session, MCP task). A Monitor watch is
 *   reported as `type: "shell"`, indistinguishable from a Bash
 *   `run_in_background` shell by the body alone.
 * - `session_crons`: every session-scoped scheduled wakeup.
 *
 * Rule: the turn is a completion unless something is pending that will
 * re-invoke the agent — a non-shell background task (subagent, workflow, …),
 * a Monitor watch, or a scheduled wakeup. Background *shells* are ignored: a
 * shell is just as often a dev server, a watcher, or a `tail -f` the agent
 * started for its own verification and left running after saying "Done" as
 * it is a wait loop, and the body cannot tell the two apart. Counting them
 * left tickets stuck "waiting" forever behind a Metro or cargo server. A
 * shell that really is a wait loop still resumes the agent when it exits,
 * and that resume flips the ticket back to in progress, so the cost of
 * ignoring it is a brief early trip to review — not a missed completion.
 *
 * Monitors are told apart from shells by id: the caller passes the task ids
 * it saw start as Monitors (from their PostToolUse). A body that carries
 * neither array predates the feature and cannot be told apart from a pause.
 *
 * The wording of `last_assistant_message` is never used as a signal.
 */

export type ClaudeCliStopCompletionKind = 'completed' | 'waiting' | 'unknown'

/**
 * Why a Claude CLI session's `completed` status was published, as far as the
 * ticket board is concerned:
 * - `completed`: a Stop hook with nothing pending that would wake the agent
 *   again — the real completion message (background shells may still run).
 * - `waiting`: a Stop hook while a subagent, workflow, Monitor watch, or
 *   scheduled wakeup is still pending — the agent will be woken again.
 * - `unknown`: a Stop hook from an older claude that reports neither array.
 * - `none`: the status did not come from a Stop hook at all (user interrupt,
 *   PTY exit, SessionEnd, …) — no completion message was ever produced.
 */
export type ClaudeCliCompletion = ClaudeCliStopCompletionKind | 'none'

export interface ClaudeCliStopCompletion {
  kind: ClaudeCliStopCompletionKind
  /**
   * Background tasks reported on the Stop body that hold the session open
   * (everything except plain background shells).
   */
  pendingTasks: number
  /** Session-scoped scheduled wakeups reported on the Stop body. */
  pendingWakeups: number
  /**
   * Background shells reported on the Stop body that were ignored for the
   * classification (dev servers, watchers, wait loops — indistinguishable).
   */
  ignoredShells: number
}

/** The subset of a Stop hook body the classifier reads. */
export interface ClaudeCliStopCompletionInput {
  background_tasks?: unknown
  session_crons?: unknown
}

export interface ClaudeCliStopCompletionOptions {
  /**
   * Task ids known to be Monitor watches. Monitors appear as `type: "shell"`
   * in the body, so without this every Monitor would be ignored like a shell.
   */
  monitorTaskIds?: ReadonlySet<string>
}

function taskField(task: unknown, field: 'id' | 'type'): string | undefined {
  if (typeof task !== 'object' || task === null) return undefined
  const value = (task as Record<string, unknown>)[field]
  return typeof value === 'string' ? value : undefined
}

/**
 * Classify a Stop hook body as a completion or an intermediate pause. Pure:
 * reads only `background_tasks` / `session_crons` plus the monitor ids the
 * caller supplies.
 */
export function classifyClaudeCliStopCompletion(
  hook: ClaudeCliStopCompletionInput,
  options: ClaudeCliStopCompletionOptions = {}
): ClaudeCliStopCompletion {
  const tasks = Array.isArray(hook.background_tasks) ? hook.background_tasks : null
  const wakeups = Array.isArray(hook.session_crons) ? hook.session_crons : null

  if (tasks === null && wakeups === null) {
    return { kind: 'unknown', pendingTasks: 0, pendingWakeups: 0, ignoredShells: 0 }
  }

  let pendingTasks = 0
  let ignoredShells = 0
  for (const task of tasks ?? []) {
    const id = taskField(task, 'id')
    const isShell = taskField(task, 'type') === 'shell'
    const isMonitor = id !== undefined && options.monitorTaskIds?.has(id) === true
    if (isShell && !isMonitor) {
      ignoredShells += 1
    } else {
      pendingTasks += 1
    }
  }
  const pendingWakeups = wakeups?.length ?? 0
  return {
    kind: pendingTasks === 0 && pendingWakeups === 0 ? 'completed' : 'waiting',
    pendingTasks,
    pendingWakeups,
    ignoredShells
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

import type { SessionFinalMessage } from '@shared/types/document-flow'
import {
  USER_ABORT_REASON,
  type SessionBlockReason,
  type SessionSignal
} from '@/lib/document-flow/session-signal'
import { PRD_FLOW_SETTLE_MS } from './ports'

// What a PRD flow can tell about its session since the flow's last prompt, from the two places
// that know: this page's own session status (lib/document-flow/session-signal), which is
// current but is lost with the page, and the main process's durable record of the session's
// last turn state, which says less but survives a reload. Both are reduced to the same few
// cases, the ones the driver (./driver) acts on. Everything here is pure: the prompt's stamp
// and the clock are passed in.

export type PrdFlowObservation =
  | { kind: 'working' }
  /** The session waits for the person; `detail` says for what. */
  | { kind: 'blocked'; detail: string }
  /** A turn end that has not stood for the settle delay yet; it counts from `until`. */
  | { kind: 'settling'; until: number }
  /** The agent paused its turn for work it started, and wakes itself when that is done. */
  | { kind: 'paused' }
  /** A settled turn end newer than the prompt. */
  | { kind: 'ended'; hasBackgroundWork: boolean }
  /** The turn ended on an API error at `at` (epoch ms). */
  | { kind: 'api_error'; at: number; error: string }
  /** The person stopped the turn. */
  | { kind: 'user_stopped' }
  /**
   * The session went away without its agent finishing the turn. `delivered`: the flow's prompt
   * had reached it before that, so it is told that it was cut off; a prompt that never arrived
   * is sent again as it was. Null when what was looked at cannot say (this page's status: it
   * knows that a process went away, not what the process had got), and the main process's
   * record has to.
   */
  | { kind: 'died'; delivered: boolean | null }
  /** The session's row is closed. */
  | { kind: 'closed' }
  /** Nothing is known to have happened since the prompt. */
  | { kind: 'idle' }

const BLOCK_LABELS: Record<SessionBlockReason, string> = {
  question: 'a question',
  permission: 'a permission request',
  command_approval: 'a command to approve',
  plan: 'a plan to review'
}

// The main process records a blocking status under the CLI's own name for it, and a turn the
// person stopped under `Interrupt`.
const RECORDED_BLOCK_REASONS: Record<string, SessionBlockReason> = {
  answering: 'question',
  permission: 'permission',
  command_approval: 'command_approval',
  plan_ready: 'plan'
}
const RECORDED_INTERRUPT_EVENT = 'Interrupt'

// Ends that are the person pressing Escape or Stop, for sessions of every provider.
const USER_STOP_REASONS: ReadonlySet<string> = new Set([
  'user_interrupt',
  'codex_turn_aborted',
  USER_ABORT_REASON
])
// A CLI publishes "completed" as its process starts, moments before the launch prompt puts it
// to work: not the end of anything.
const SESSION_START_HOOK = 'SessionStart'
const PROCESS_START_REASON = 'pty_start'
// Ends that are the process going away, not the agent finishing its turn.
const PROCESS_END_REASON = 'pty_exit'
const PROCESS_END_HOOK = 'SessionEnd'

/**
 * What this page's own status of the session says about the turn the flow prompted at
 * `promptedAt`. Null when it says nothing: the page has no status for the session, the end it
 * holds is not newer than the prompt (it belongs to the turn before), or it is the blip a CLI
 * publishes while it starts.
 */
export function observeSignal(
  signal: SessionSignal,
  promptedAt: number,
  now: number
): PrdFlowObservation | null {
  if (signal.kind === 'working') return { kind: 'working' }
  if (signal.kind === 'blocked') {
    return { kind: 'blocked', detail: signal.detail?.trim() || BLOCK_LABELS[signal.reason] }
  }
  if (signal.kind === 'unknown') return null

  if (signal.at <= promptedAt) return null
  const reason = signal.reason ?? ''
  if (signal.hookEvent === SESSION_START_HOOK || reason === PROCESS_START_REASON) return null
  // Every kind of end waits out the settle delay: sessions bounce in and out of completed.
  if (now - signal.at < PRD_FLOW_SETTLE_MS) {
    return { kind: 'settling', until: signal.at + PRD_FLOW_SETTLE_MS }
  }
  if (signal.apiError) return { kind: 'api_error', at: signal.at, error: signal.apiError }
  if (USER_STOP_REASONS.has(reason)) return { kind: 'user_stopped' }
  if (
    signal.completion === 'none' ||
    reason === PROCESS_END_REASON ||
    signal.hookEvent === PROCESS_END_HOOK
  ) {
    // The end is newer than the prompt: the process went away after it was stamped. Whether
    // the prompt had reached it by then, a process that exits before its first word included,
    // is not for this status to say.
    return { kind: 'died', delivered: null }
  }
  if (signal.completion === 'waiting') return { kind: 'paused' }
  return { kind: 'ended', hasBackgroundWork: signal.hasBackgroundWork || !!signal.pending }
}

/**
 * What the main process recorded of the session's last turn state says about the turn the
 * flow prompted at `promptedAt`. Null when it says nothing: there is no record, it is not newer
 * than the prompt, or it is a working or blocked state from before this app instance started
 * (`appStartedAt`, epoch ms; 0 while it is not known), which belongs to a process that went
 * away with the last one. A turn end stays true for as long as it stands, whichever instance
 * recorded it; the work it left running does not: a pause recorded before this instance
 * started waits for work that died with the last one, and no agent is left to wake.
 */
export function observeRecord(
  turn: SessionFinalMessage | null,
  promptedAt: number,
  appStartedAt: number,
  now: number
): PrdFlowObservation | null {
  if (!turn) return null
  const at = Date.parse(turn.updated_at)
  if (!Number.isFinite(at)) return null

  if (turn.state !== 'ended') {
    if (at < appStartedAt || at <= promptedAt) return null
    if (turn.state === 'working') return { kind: 'working' }
    const reason = RECORDED_BLOCK_REASONS[turn.hook_event] ?? 'question'
    return { kind: 'blocked', detail: turn.detail?.trim() || BLOCK_LABELS[reason] }
  }

  if (at <= promptedAt) return null
  if (turn.hook_event === SESSION_START_HOOK) return null
  if (now - at < PRD_FLOW_SETTLE_MS) return { kind: 'settling', until: at + PRD_FLOW_SETTLE_MS }
  if (turn.api_error) return { kind: 'api_error', at, error: turn.api_error }
  if (turn.hook_event === RECORDED_INTERRUPT_EVENT) return { kind: 'user_stopped' }
  // Whatever the turn left running went away with the app instance that recorded its end.
  const outlived = at < appStartedAt
  if (turn.completion === 'waiting') {
    return outlived ? { kind: 'died', delivered: true } : { kind: 'paused' }
  }
  return { kind: 'ended', hasBackgroundWork: !outlived && (turn.background_work ?? 0) > 0 }
}

/**
 * Whether the main process's record shows that the prompt stamped at `promptedAt` reached the
 * session: it recorded something of the session after the stamp (work, a question, a turn
 * end), and that is not merely its process starting.
 */
export function recordShowsDelivery(turn: SessionFinalMessage | null, promptedAt: number): boolean {
  if (!turn || turn.hook_event === SESSION_START_HOOK) return false
  const at = Date.parse(turn.updated_at)
  return Number.isFinite(at) && at > promptedAt
}

import {
  SHELL_COMMAND_RUN_STATES,
  type ShellCommandFailureReason,
  type ShellCommandRunState
} from '@shared/lib/shell-commands'

/**
 * Run-state changes of shell-command sessions, published by the Electron main
 * process (the only writer of the state) on every transition.
 *
 * A dedicated channel on purpose: 'claude-cli:status' schedules usage reports and
 * usage refreshes for every 'completed' and carries no exit code. This channel is
 * NOT in REMOTE_CHANNEL_ALLOWLIST: paired devices cannot subscribe to it.
 */
export const SHELL_COMMAND_STATUS_CHANNEL = 'shell-command:status'

export interface ShellCommandStatusPayload {
  sessionId: string
  /** The run this state belongs to; null only when a start failed before a run existed. */
  runId: string | null
  state: ShellCommandRunState
  exitCode: number | null
  signal: number | null
  detached: boolean
  reason: ShellCommandFailureReason | null
  /** Human-readable cause when reason is 'start-failed'. Never contains script text. */
  error: string | null
  startedAt: string | null
  finishedAt: string | null
}

const isNullableNumber = (value: unknown): value is number | null =>
  value === null || typeof value === 'number'

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string'

export function isShellCommandStatusPayload(value: unknown): value is ShellCommandStatusPayload {
  if (typeof value !== 'object' || value === null) return false
  const payload = value as Record<string, unknown>
  return (
    typeof payload.sessionId === 'string' &&
    isNullableString(payload.runId) &&
    typeof payload.state === 'string' &&
    (SHELL_COMMAND_RUN_STATES as readonly string[]).includes(payload.state) &&
    isNullableNumber(payload.exitCode) &&
    isNullableNumber(payload.signal) &&
    typeof payload.detached === 'boolean' &&
    (payload.reason === null ||
      payload.reason === 'output-limit' ||
      payload.reason === 'start-failed') &&
    isNullableString(payload.error) &&
    isNullableString(payload.startedAt) &&
    isNullableString(payload.finishedAt)
  )
}

/**
 * Transcript replay protocol.
 *
 * Output of a shell-command session reaches its views on the ordinary
 * `terminal:data:<sessionId>` channel. When a view attaches (or a run restarts) the
 * main process publishes, on that SAME channel, one chunk that resets the terminal
 * and replays everything printed so far, bracketed by two private OSC sequences:
 *
 *   OSC 7777 ; tedooo-replay-start BEL   RIS   <transcript>   OSC 7777 ; tedooo-replay-end BEL
 *
 * Because the replay travels in-band, it is ordered against live output by
 * construction: no chunk can be lost or shown twice, whatever the timing of the
 * attach round-trip. The renderer's xterm backend registers a handler for the OSC and
 * drops xterm's own answers to the terminal queries inside the replayed text
 * (cursor-position and device-attribute reports) so they are never typed into the
 * live program. Terminals without the handler ignore the unknown OSC.
 */
export const SHELL_COMMAND_REPLAY_OSC = 7777
export const SHELL_COMMAND_REPLAY_START = 'tedooo-replay-start'
export const SHELL_COMMAND_REPLAY_END = 'tedooo-replay-end'

/** Reset the terminal and replay `transcript` (pass '' to just clear it). */
export function wrapShellCommandReplay(transcript: string): string {
  return (
    `\x1b]${SHELL_COMMAND_REPLAY_OSC};${SHELL_COMMAND_REPLAY_START}\x07` +
    '\x1bc' +
    transcript +
    `\x1b]${SHELL_COMMAND_REPLAY_OSC};${SHELL_COMMAND_REPLAY_END}\x07`
  )
}

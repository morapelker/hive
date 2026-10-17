import {
  CLAUDE_CLI_LAUNCH_CHANNEL,
  type ClaudeCliLaunchPayload,
  type ClaudeCliLaunchState
} from '@shared/types/claude-cli-launch'
import { publishDesktopBackendEvent } from '../desktop/backend-event-publisher'
import { createLogger } from './logger'

const log = createLogger({ component: 'ClaudeCliLaunchWatch' })

/**
 * A healthy claude spawn fires its first hook well under a second after the
 * PTY starts (plugins and MCP servers can stretch that to a few seconds). The
 * CLI does not deliver SessionStart over http hooks, so in practice that first
 * hook is the UserPromptSubmit of the argv prompt. A spawn that has not
 * reported in by this point is held up by something that blocks the REPL
 * before any hook runs — in practice the folder-trust dialog. A `--resume`
 * without an argv prompt is not a launch and is never watched; a resume that
 * does carry a prompt gets the timer but not the output scan.
 */
export const CLAUDE_CLI_LAUNCH_TIMEOUT_MS = 20_000

/**
 * Markers of the CLI's folder-trust dialog, compared against PTY output with
 * escape sequences and whitespace removed and lower-cased (the dialog is
 * drawn word by word with cursor moves between the words). Both the current
 * wording ("Quick safety check… Yes, I trust this folder", claude 2.1.x) and
 * the earlier one ("Do you trust the files in this folder? Yes, proceed")
 * are recognised.
 */
const TRUST_DIALOG_MARKERS = [
  'itrustthisfolder',
  'quicksafetycheck',
  'doyoutrustthefilesinthisfolder'
]
/** Rolling window of normalised output kept per session while the watch is armed. */
const OUTPUT_WINDOW_CHARS = 4_000

interface LaunchWatch {
  timer: NodeJS.Timeout | null
  /**
   * Whether PTY output is scanned for the trust dialog. Off for a `--resume`:
   * the CLI replays the prior transcript into the PTY, and that text can
   * itself contain the dialog's wording.
   */
  scanOutput: boolean
  /** Normalised tail of the PTY output seen so far. */
  output: string
  /** The last non-clear state published for this session, if any. */
  published: Exclude<ClaudeCliLaunchState, 'clear'> | null
  onTrustDialog: (() => void) | null
}

const watches = new Map<string, LaunchWatch>()

// CSI (incl. private modes), OSC (BEL or ST terminated), single-char escapes.
// eslint-disable-next-line no-control-regex
const ESCAPE_SEQUENCES = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b./g

export function normalizeClaudeCliOutput(data: string): string {
  return data.replace(ESCAPE_SEQUENCES, '').replace(/\s+/g, '').toLowerCase()
}

/** Whether a stretch of (normalised) PTY output shows the folder-trust dialog. */
export function containsClaudeTrustDialog(normalizedOutput: string): boolean {
  return TRUST_DIALOG_MARKERS.some((marker) => normalizedOutput.includes(marker))
}

function publish(sessionId: string, state: ClaudeCliLaunchState, detail: string): void {
  const payload: ClaudeCliLaunchPayload = { sessionId, state, detail }
  void Promise.resolve(publishDesktopBackendEvent(CLAUDE_CLI_LAUNCH_CHANNEL, payload)).catch(
    () => undefined
  )
}

/**
 * Start watching a fresh claude spawn. Until a hook arrives, the PTY output is
 * scanned for the trust dialog and a timer waits for the first hook; whichever
 * fires first publishes the launch state. `onTrustDialog` runs once when the
 * dialog is recognised (the bridge re-asserts the trust entry there).
 * `scanOutput: false` keeps only the timer.
 */
export function armClaudeCliLaunchWatch(
  sessionId: string,
  opts?: { onTrustDialog?: () => void; timeoutMs?: number; scanOutput?: boolean }
): void {
  disarm(sessionId)
  const watch: LaunchWatch = {
    timer: null,
    scanOutput: opts?.scanOutput ?? true,
    output: '',
    published: null,
    onTrustDialog: opts?.onTrustDialog ?? null
  }
  watch.timer = setTimeout(() => {
    const current = watches.get(sessionId)
    if (current !== watch) return
    watch.timer = null
    if (watch.published) return
    watch.published = 'not_started'
    log.warn('Claude CLI spawn has not fired any hook within the launch window', {
      sessionId,
      timeoutMs: opts?.timeoutMs ?? CLAUDE_CLI_LAUNCH_TIMEOUT_MS
    })
    publish(sessionId, 'not_started', 'no_session_start')
  }, opts?.timeoutMs ?? CLAUDE_CLI_LAUNCH_TIMEOUT_MS)
  watch.timer.unref?.()
  watches.set(sessionId, watch)
}

/** Feed raw PTY output of a watched session. No-op once the session has started. */
export function observeClaudeCliLaunchOutput(sessionId: string, data: string): void {
  const watch = watches.get(sessionId)
  if (!watch || !watch.scanOutput || watch.published === 'awaiting_trust') return
  watch.output = (watch.output + normalizeClaudeCliOutput(data)).slice(-OUTPUT_WINDOW_CHARS)
  if (!containsClaudeTrustDialog(watch.output)) return
  watch.published = 'awaiting_trust'
  if (watch.timer) {
    clearTimeout(watch.timer)
    watch.timer = null
  }
  log.warn('Claude CLI is showing its folder-trust dialog; the session has not started', {
    sessionId
  })
  publish(sessionId, 'awaiting_trust', 'trust_dialog')
  const callback = watch.onTrustDialog
  watch.onTrustDialog = null
  try {
    callback?.()
  } catch (error) {
    log.warn('Trust-dialog callback threw', {
      sessionId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

/**
 * A hook arrived for the session: the REPL is running. Ends the watch and
 * clears any "not started" mark that was published meanwhile (the user
 * accepted the dialog, or SessionStart was merely slow).
 */
export function noteClaudeCliLaunchHook(sessionId: string, hookEventName: string | undefined): void {
  const watch = watches.get(sessionId)
  if (!watch) return
  const published = watch.published
  disarm(sessionId)
  if (published) {
    log.info('Claude CLI session started after a stalled launch', {
      sessionId,
      previous: published,
      hookEventName
    })
    publish(sessionId, 'clear', `hook:${hookEventName ?? 'unknown'}`)
  }
}

/** The PTY is gone (exit, destroy, restart): end the watch and drop any mark. */
export function clearClaudeCliLaunchWatch(sessionId: string, detail = 'pty_exit'): void {
  const watch = watches.get(sessionId)
  if (!watch) return
  const published = watch.published
  disarm(sessionId)
  if (published) publish(sessionId, 'clear', detail)
}

export function clearAllClaudeCliLaunchWatches(): void {
  for (const sessionId of [...watches.keys()]) clearClaudeCliLaunchWatch(sessionId, 'cleanup')
}

/** The last launch state published for a session that is still being watched. */
export function getClaudeCliLaunchState(sessionId: string): ClaudeCliLaunchState | null {
  return watches.get(sessionId)?.published ?? null
}

function disarm(sessionId: string): void {
  const watch = watches.get(sessionId)
  if (!watch) return
  if (watch.timer) clearTimeout(watch.timer)
  watches.delete(sessionId)
}

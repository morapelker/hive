/**
 * Whether a freshly spawned Claude CLI session actually got going. A spawn
 * that stalls on the CLI's folder-trust dialog (or anything else that keeps
 * the REPL from starting) never fires a single hook: no SessionStart, and the
 * argv prompt is never submitted — the ticket looks launched while nothing
 * runs. The PTY bridge watches the first seconds of every claude spawn and
 * publishes on the dedicated channel below (the status channel has no state
 * for "not started", and a 'completed' would read as idle).
 */
export const CLAUDE_CLI_LAUNCH_CHANNEL = 'claude-cli:launch'

export type ClaudeCliLaunchState =
  /** The CLI's "Quick safety check… Yes, I trust this folder" dialog is on screen. */
  | 'awaiting_trust'
  /** No SessionStart hook arrived within the launch window; cause unknown. */
  | 'not_started'
  /** The session is running (a hook arrived) or is gone — drop any mark. */
  | 'clear'

export interface ClaudeCliLaunchPayload {
  sessionId: string
  state: ClaudeCliLaunchState
  /** Machine-readable detail: `trust_dialog`, `no_session_start`, `hook:<event>`, `pty_exit`… */
  detail?: string
}

const LAUNCH_STATES: ReadonlySet<string> = new Set(['awaiting_trust', 'not_started', 'clear'])

export function isClaudeCliLaunchPayload(value: unknown): value is ClaudeCliLaunchPayload {
  if (typeof value !== 'object' || value === null) return false
  const payload = value as Record<string, unknown>
  return (
    typeof payload.sessionId === 'string' &&
    typeof payload.state === 'string' &&
    LAUNCH_STATES.has(payload.state) &&
    (payload.detail === undefined || typeof payload.detail === 'string')
  )
}

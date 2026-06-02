import { ptyService } from './pty-service'

/**
 * Inject a prompt into a running Claude CLI session as if the user typed it.
 *
 * Bracketed paste (`ESC[200~ … ESC[201~`) keeps a multi-line prompt from being
 * submitted line-by-line; the trailing CR submits the turn (as pressing Enter).
 *
 * Returns `delivered: false` when the session has no live PTY so the caller can
 * queue the prompt for later delivery (e.g. as the next spawn argument, or until
 * the session is idle) instead of silently dropping it.
 *
 * Shared by the `terminal:sendClaudeCliPrompt` IPC handler and the Telegram
 * forwarding service (which has no SDK implementer to route a CLI prompt to).
 * Lives in the service layer and imports only `pty-service` so callers don't
 * have to reach into the IPC layer (which would create import cycles).
 */
export function writeClaudeCliPrompt(sessionId: string, prompt: string): { delivered: boolean } {
  if (!ptyService.has(sessionId)) {
    return { delivered: false }
  }
  ptyService.write(sessionId, `[200~${prompt}[201~\r`)
  return { delivered: true }
}

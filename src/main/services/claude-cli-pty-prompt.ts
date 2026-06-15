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
 * Shared by the terminal RPC path and the Telegram forwarding service (which
 * has no SDK implementer to route a CLI prompt to). Lives in the service layer
 * and imports only `pty-service` so callers don't have to reach across layers.
 */
export function writeClaudeCliPrompt(sessionId: string, prompt: string): { delivered: boolean } {
  if (!ptyService.has(sessionId)) {
    return { delivered: false }
  }
  ptyService.write(sessionId, `\x1b[200~${prompt}\x1b[201~\r`)
  return { delivered: true }
}

// Re-send Enter at these offsets (ms) after a paste to cover claude's boot window.
const SUBMIT_REASSERT_DELAYS_MS = [400, 900, 1600, 2600]

/**
 * Re-assert the submitting Enter across claude's startup window.
 *
 * A bracketed paste delivered before claude's TUI is input-ready buffers the
 * pasted text but silently drops the trailing CR, so the prompt lands in the
 * input box yet is never submitted (the user sees the prompt "just sitting
 * there"). This happens on handoffs when a racing promptless spawn wins the
 * PTY and the prompt-carrying call pastes into a still-booting claude.
 *
 * Re-sending a bare CR once claude finishes initializing submits the
 * already-buffered text. A CR that arrives after the prompt is submitted — or
 * while the input is empty — is a harmless no-op, so a fixed retry schedule is
 * safe. The `ptyService.has` guard avoids writing to a torn-down PTY.
 *
 * `schedule` is injectable for tests; it defaults to `setTimeout`.
 */
export function reassertClaudeCliPromptSubmit(
  sessionId: string,
  opts?: { delaysMs?: number[]; schedule?: (fn: () => void, ms: number) => void }
): void {
  const delays = opts?.delaysMs ?? SUBMIT_REASSERT_DELAYS_MS
  const schedule = opts?.schedule ?? ((fn, ms) => void setTimeout(fn, ms))
  for (const ms of delays) {
    schedule(() => {
      if (ptyService.has(sessionId)) {
        ptyService.write(sessionId, '\r')
      }
    }, ms)
  }
}

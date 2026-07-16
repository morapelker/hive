import { ptyService } from './pty-service'

/**
 * Grok's TUI applies Shift+Tab mode cycles asynchronously: a bracketed-paste
 * prompt written right after a mode toggle (ticket follow-ups flip plan↔build
 * via setSessionMode and immediately send) can submit while the previous
 * native mode is still active. The launch path spaces its own paste this many
 * ms behind its toggles; renderer-originated writes are paced here to match.
 */
export const GROK_PROMPT_AFTER_TOGGLE_MS = 300

const GROK_MODE_TOGGLE = '\x1b[Z'
const BRACKETED_PASTE_START = '\x1b[200~'

/** Terminal ids spawned as grok sessions (pacing applies only to these). */
const grokCliTerminals = new Set<string>()
/** Last time a Shift+Tab mode toggle was written to each grok terminal. */
const lastModeToggleAt = new Map<string, number>()

export function registerGrokCliTerminal(terminalId: string): void {
  grokCliTerminals.add(terminalId)
}

export function unregisterGrokCliTerminal(terminalId: string): void {
  grokCliTerminals.delete(terminalId)
  lastModeToggleAt.delete(terminalId)
}

export function clearAllGrokCliTerminals(): void {
  grokCliTerminals.clear()
  lastModeToggleAt.clear()
}

/**
 * Stamp a mode toggle written outside the paced path (the launch-time plan
 * activation writes its toggles directly), so a renderer prompt racing in
 * behind it still waits out the settle window.
 */
export function stampGrokModeToggle(terminalId: string): void {
  lastModeToggleAt.set(terminalId, Date.now())
}

/**
 * Write renderer-originated input to a terminal, holding a grok prompt paste
 * that follows a mode toggle until the toggle settles. Non-grok terminals
 * (and non-paste grok input) write through untouched. The paste prefix is
 * checked first so prompt text containing the toggle sequence is never
 * mistaken for a mode switch.
 */
export function writeCliTerminalPaced(terminalId: string, data: string): void {
  if (grokCliTerminals.has(terminalId)) {
    if (data.startsWith(BRACKETED_PASTE_START)) {
      const toggledAt = lastModeToggleAt.get(terminalId)
      const wait = toggledAt != null ? GROK_PROMPT_AFTER_TOGGLE_MS - (Date.now() - toggledAt) : 0
      if (wait > 0) {
        setTimeout(() => {
          if (ptyService.has(terminalId)) ptyService.write(terminalId, data)
        }, wait)
        return
      }
    } else if (data.includes(GROK_MODE_TOGGLE)) {
      lastModeToggleAt.set(terminalId, Date.now())
    }
  }
  ptyService.write(terminalId, data)
}

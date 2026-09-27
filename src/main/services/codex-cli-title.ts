/**
 * Codex TUI terminal-title channel.
 *
 * Codex hooks fire only around turns (SessionStart at the first turn, not at
 * launch), so they cannot tell Hive when the TUI is ready for input, and a
 * turn that dies on an error never fires Stop. The TUI's configurable terminal
 * title (`tui.terminal_title`) fills both gaps from the PTY byte stream: Hive
 * launches codex with `-c 'tui.terminal_title=["run-state","thread-id","thread-title"]'`
 * and the TUI then emits OSC 0 titles of the form
 *
 *     Ready | 01a07dbd-6a11-7982-a2b6-ceaa4... | Fix the flaky test
 *
 * (`" | "`-joined; the thread id is truncated to 32 graphemes with an ellipsis;
 * unavailable items are omitted — the thread id appears once the thread
 * exists, the thread title once codex named the thread, falling back to the
 * id). Run-state words: Starting, Ready, Working, Thinking, Waiting.
 *
 * The `activity` item (codex calls it the spinner) is what makes the TUI
 * replace the whole title with `[ ! ] Action Required | …` (blinking to
 * `[ . ]`) while a bottom-pane view is blocked on the user — a
 * `request_user_input` question, a command approval, an MCP elicitation
 * (`terminal_title_requires_action`). Without it codex never says so on the
 * title channel. While a turn runs the item renders a braille spinner frame
 * joined by a plain space (`Working | <id> ⠋`); while idle it renders nothing,
 * so it sits last. The same frames also trail the thread items while codex is
 * naming the thread (`<id> ⠙ | <title> ⠙`), so every part is stripped of them.
 */

// Same OSC 0/2 matcher as claude-cli-title-handler.ts.
// eslint-disable-next-line no-control-regex
const OSC_TITLE_RE = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g
const MAX_TAIL_LENGTH = 4096

export const CODEX_TERMINAL_TITLE_ITEMS = ['run-state', 'thread-id', 'thread-title', 'activity'] as const

export type CodexRunState = 'Starting' | 'Ready' | 'Working' | 'Thinking' | 'Waiting'

const RUN_STATES = new Set<string>(['Starting', 'Ready', 'Working', 'Thinking', 'Waiting'])
const THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{0,12}(\.\.\.)?$/i
const FULL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/**
 * Spinner frames (`TERMINAL_TITLE_SPINNER_FRAMES` in codex's status_surfaces.rs)
 * trailing a title part, optionally with the `●` the activity item shows while
 * the realtime microphone listens. Joined by a plain space, never ` | `.
 */
const TRAILING_SPINNER_RE = /(?:\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏●]+)+\s*$/u

function stripSpinnerFrames(part: string): string {
  return part.replace(TRAILING_SPINNER_RE, '').trim()
}

export interface CodexTitleInfo {
  raw: string
  runState: CodexRunState | null
  /** Lower-cased thread id prefix (or the full id when it fit). */
  threadIdPrefix: string | null
  threadIdIsComplete: boolean
  /** The thread's title when codex has named it (null while it still shows the id). */
  threadTitle: string | null
  actionRequired: boolean
}

export function parseCodexTerminalTitle(raw: string): CodexTitleInfo {
  const info: CodexTitleInfo = {
    raw,
    runState: null,
    threadIdPrefix: null,
    threadIdIsComplete: false,
    threadTitle: null,
    actionRequired: false
  }
  let text = raw.trim()
  if (/^\[ [!.] \] Action Required/.test(text)) {
    info.actionRequired = true
    text = text.replace(/^\[ [!.] \] Action Required\s*\|?\s*/, '')
  }
  for (const part of text.split(' | ')) {
    const value = stripSpinnerFrames(part)
    if (!value) continue
    if (info.runState === null && RUN_STATES.has(value)) {
      info.runState = value as CodexRunState
      continue
    }
    if (THREAD_ID_RE.test(value)) {
      const prefix = value.replace(/\.\.\.$/, '').toLowerCase()
      const complete = FULL_UUID_RE.test(value)
      if (info.threadIdPrefix === null) {
        info.threadIdPrefix = prefix
        info.threadIdIsComplete = complete
      } else if (!info.threadIdIsComplete && complete && prefix.startsWith(info.threadIdPrefix)) {
        // The thread-title item falls back to the (untruncated) id while the
        // thread is unnamed — that completes the truncated thread-id item.
        info.threadIdPrefix = prefix
        info.threadIdIsComplete = true
      }
      // An id-like part is never a thread title.
      continue
    }
    if (info.threadTitle === null) {
      info.threadTitle = value
    }
  }
  return info
}

const tailBuffers = new Map<string, string>()

/**
 * Extract every complete OSC title from a PTY chunk (an OSC sequence split
 * across chunks is completed on the next call). Returns titles in order.
 */
export function extractCodexTitles(sessionId: string, chunk: string): string[] {
  const buffer = (tailBuffers.get(sessionId) ?? '') + chunk
  const titles: string[] = []
  let lastConsumedIndex = 0
  OSC_TITLE_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = OSC_TITLE_RE.exec(buffer)) !== null) {
    lastConsumedIndex = OSC_TITLE_RE.lastIndex
    titles.push(match[1])
  }

  const remainder = buffer.slice(lastConsumedIndex)
  const lastEsc = remainder.lastIndexOf('\x1b]')
  let newTail = ''
  if (lastEsc !== -1) {
    const suffix = remainder.slice(lastEsc)
    if (!suffix.includes('\x07') && !suffix.includes('\x1b\\')) newTail = suffix
  }
  if (newTail && newTail.length <= MAX_TAIL_LENGTH) {
    tailBuffers.set(sessionId, newTail)
  } else {
    tailBuffers.delete(sessionId)
  }
  return titles
}

export function resetCodexTitleState(sessionId: string): void {
  tailBuffers.delete(sessionId)
}

export function resetAllCodexTitleState(): void {
  tailBuffers.clear()
}

/** The `-c` override that turns the title channel on. */
export function buildCodexTerminalTitleOverride(): string {
  return `tui.terminal_title=[${CODEX_TERMINAL_TITLE_ITEMS.map((item) => `"${item}"`).join(',')}]`
}

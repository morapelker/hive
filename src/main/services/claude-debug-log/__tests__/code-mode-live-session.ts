/**
 * What the opt-in live test of Code Mode usage (`claude-code-mode-usage.live.test.ts`) needs
 * to watch a real Claude CLI session: the screen of its terminal as text, what that screen
 * says about Code Mode, and a wait that gives up with a reason.
 *
 * Kept apart from the live test so that these parts are tested without a CLI or an account
 * (`code-mode-live-session.test.ts`): the live test must fail with a clear message when the
 * CLI is missing or refuses Code Mode, and that is decided here.
 *
 * Nothing in here may put a secret into an error: what is shown of a screen goes through
 * `redactForReport` first.
 */
// The browser build of xterm.js, never opened: without a DOM element it still lays out what it
// is fed, which is all that is needed here.
import { Terminal } from '@xterm/xterm'

/** What the screen of a session says about Code Mode. */
export type CodeModeScreenReading =
  /** The CLI's notice that the session runs in Code Mode. */
  | { kind: 'on' }
  /** The CLI refused Code Mode; `notice` is its own sentence. */
  | { kind: 'unavailable'; notice: string }
  /** The CLI asks whether to turn Code Mode on, and waits for an answer. */
  | { kind: 'consent-needed' }
  /** Nothing about Code Mode (yet). */
  | { kind: 'unknown' }

// Words are matched with any white space between them: a notice can wrap, and a terminal
// program may move the cursor instead of printing a space.
const CODE_MODE_ON = /Code\s+Mode\s+\(experimental\)\s+is\s+on\b/
const CODE_MODE_UNAVAILABLE = /Code\s+Mode\s+\(experimental\)\s+isn['’]t\s+available/
const CODE_MODE_CONSENT = /Yes,\s+turn\s+on\s+Code\s+Mode/

/** How much of a refusal is quoted: its sentence, not the rest of the screen. */
const NOTICE_MAX_LENGTH = 400

/**
 * Read what a screen (plain text, one line per row) says about Code Mode. The notice that
 * it is on counts over everything else: it is only printed by a session that runs in it.
 */
export function readCodeModeScreen(screen: string): CodeModeScreenReading {
  if (CODE_MODE_ON.test(screen)) return { kind: 'on' }
  const refusal = CODE_MODE_UNAVAILABLE.exec(screen)
  if (refusal) {
    // The sentence runs to the end of its paragraph; it may be wrapped over several rows.
    const paragraph = screen.slice(refusal.index).split(/\n[ \t]*\n/)[0]
    const notice = paragraph.replace(/\s+/g, ' ').trim()
    return {
      kind: 'unavailable',
      notice: notice.length > NOTICE_MAX_LENGTH ? `${notice.slice(0, NOTICE_MAX_LENGTH)}…` : notice
    }
  }
  if (CODE_MODE_CONSENT.test(screen)) return { kind: 'consent-needed' }
  return { kind: 'unknown' }
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g
const UUID = /\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const TOKEN = /\bsk-ant-[A-Za-z0-9_-]+/g

/**
 * Text that may be shown in a test report: no e-mail address, no token, and of an id (an
 * organization, an account, a session) only its first eight characters.
 */
export function redactForReport(text: string): string {
  return text.replace(TOKEN, '<token>').replace(EMAIL, '<email>').replace(UUID, '$1…')
}

/** Rows of a screen shown in a report. */
const REPORT_ROWS = 30

/**
 * The screen of a terminal session, kept by feeding it everything the session prints: a
 * terminal program repaints in place, so its output only reads as text once a terminal has
 * laid it out.
 */
export class LiveSessionScreen {
  private readonly terminal: Terminal
  private written: Promise<void> = Promise.resolve()
  private codeMode: CodeModeScreenReading = { kind: 'unknown' }
  private disposed = false
  private readonly now: () => number
  private shown = ''
  private changedAt: number

  constructor(cols: number, rows: number, now: () => number = Date.now) {
    this.terminal = new Terminal({ cols, rows, scrollback: 200, allowProposedApi: true })
    this.now = now
    this.changedAt = now()
  }

  /** Output of the session, in the order it was printed. */
  feed(data: string): void {
    if (this.disposed) return
    this.written = this.written.then(
      () =>
        new Promise<void>((resolve) => {
          if (this.disposed) return resolve()
          this.terminal.write(data, () => {
            this.note()
            resolve()
          })
        })
    )
  }

  /** Resolves once everything fed so far is on the screen. */
  settled(): Promise<void> {
    return this.written
  }

  /**
   * The rows of the screen as text, without the empty ones at its end. A line the terminal
   * itself broke at its right edge is one row here, as the program printed it.
   */
  text(): string {
    if (this.disposed) return ''
    const buffer = this.terminal.buffer.active
    const rows: string[] = []
    for (let index = 0; index < buffer.length; index += 1) {
      const line = buffer.getLine(index)
      if (!line) continue
      // The spaces at the end of a row belong to the line when it goes on in the next row.
      const goesOn = buffer.getLine(index + 1)?.isWrapped === true
      const text = line.translateToString(!goesOn)
      if (line.isWrapped && rows.length > 0) rows[rows.length - 1] += text
      else rows.push(text)
    }
    while (rows.length > 0 && rows[rows.length - 1].trim() === '') rows.pop()
    return rows.join('\n')
  }

  /**
   * What the session has said about Code Mode so far. Looked at after every piece of
   * output, and kept: the notice that it is on stays true after it has scrolled away, and a
   * refusal stays the answer until that notice is seen.
   */
  codeModeReading(): CodeModeScreenReading {
    return this.codeMode
  }

  /**
   * How long the screen has shown what it shows now, in milliseconds. A program at work
   * animates (a spinner, a timer), so a screen that stands still is a program at rest.
   * Output that changes nothing on the screen does not count.
   */
  quietFor(): number {
    return this.now() - this.changedAt
  }

  /** The last rows of the screen, safe to put in an error. */
  report(): string {
    const rows = this.text()
      .split('\n')
      .filter((row) => row.trim() !== '')
      .slice(-REPORT_ROWS)
    if (rows.length === 0) return '  (the screen is empty)'
    return rows.map((row) => `  | ${redactForReport(row.trimEnd())}`).join('\n')
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.terminal.dispose()
  }

  private note(): void {
    const text = this.text()
    if (text !== this.shown) {
      this.shown = text
      this.changedAt = this.now()
    }
    if (this.codeMode.kind === 'on') return
    const reading = readCodeModeScreen(text)
    if (reading.kind === 'unknown') {
      // A dialog that was answered is over; a refusal that scrolled away still stands.
      if (this.codeMode.kind === 'consent-needed') this.codeMode = reading
      return
    }
    this.codeMode = reading
  }
}

export interface LiveWaitOptions<T> {
  /** What is waited for, as it reads after "waiting for". */
  what: string
  timeoutMs: number
  /** Time between two looks. Defaults to 100 ms. */
  intervalMs?: number
  /**
   * The value once it is there, `undefined` to keep waiting. Throw to give up at once: the
   * wait ends with that error, which is how a session that ended, or a state that cannot
   * turn into the one waited for, fails with its reason and not with a timeout.
   */
  look: () => T | undefined | Promise<T | undefined>
  /** What was known when the wait ran out, added to the error. */
  context?: () => string
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/**
 * Wait until `look` has a value. Runs out with an error that says what was waited for, for
 * how long, and what `context` knows, so that a live check never ends as a bare test timeout.
 */
export async function waitForLive<T>(options: LiveWaitOptions<T>): Promise<T> {
  const now = options.now ?? Date.now
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const intervalMs = options.intervalMs ?? 100
  const startedAt = now()
  for (;;) {
    const value = await options.look()
    if (value !== undefined) return value
    const waited = now() - startedAt
    if (waited >= options.timeoutMs) {
      const context = options.context?.()
      throw new Error(
        `Gave up after ${Math.round(waited / 1000)} s waiting for ${options.what}.` +
          (context ? `\n${context}` : '')
      )
    }
    await sleep(Math.min(intervalMs, options.timeoutMs - waited))
  }
}

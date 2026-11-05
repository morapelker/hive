/**
 * Caps how often a dictation's live transcript reaches the HUD (VOICE-06).
 *
 * The engine reports the transcript whenever it changes: about twice a second
 * while the user speaks, but in bursts when a backlog drains (a cold start
 * replays the audio held while the model loaded). Leading + trailing: the
 * first change goes out at once, later ones at most every `intervalMs`, and the
 * latest text always goes out in the end. Text equal to what was last sent is
 * dropped. Never a debounce, which continuous speech would starve.
 */
export class PreviewThrottle {
  private lastSent: string | null = null
  private lastSentAt = Number.NEGATIVE_INFINITY
  private pending: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly intervalMs: number,
    private readonly send: (text: string) => void,
    private readonly now: () => number = () => performance.now()
  ) {}

  /** The latest full transcript. */
  push(text: string): void {
    if (this.timer) {
      // A send is already scheduled: it will carry the newest text.
      this.pending = text
      return
    }
    if (text === this.lastSent) return
    const wait = this.lastSentAt + this.intervalMs - this.now()
    if (wait <= 0) {
      this.emit(text)
      return
    }
    this.pending = text
    this.timer = setTimeout(() => {
      this.timer = null
      const next = this.pending
      this.pending = null
      if (next !== null && next !== this.lastSent) this.emit(next)
    }, wait)
  }

  /** Drop a scheduled send (stop, cancel, failed session). Later pushes start afresh. */
  cancel(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending = null
  }

  private emit(text: string): void {
    this.lastSent = text
    this.lastSentAt = this.now()
    this.send(text)
  }
}

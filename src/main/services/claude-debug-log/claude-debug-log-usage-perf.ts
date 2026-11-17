/**
 * Performance counters of the debug-log usage source (Code Mode T20;
 * CODE_MODE_PRD.html PF-6, SEC-5).
 *
 * While the app's performance logging is on (Settings → Advanced), the source
 * of `claude-debug-log-usage-source.ts` tells these counters what each of its
 * passes and checks cost and found. They reach the performance log two ways:
 *
 * - the `claudeDebugLog` gauge, read by the performance logger for each of
 *   its samples (every 30 s): the registered sessions, and for the time since
 *   the previous sample the passes and checks run, the bytes read, the
 *   entries parsed, the parse failures, how long the checks and the passes
 *   took (total and longest), and how many rotations and degraded events
 *   there were;
 * - one `claude-debug-log` record the moment a log is rotated or a session's
 *   log is found to give no readings, with the cause or the reason.
 *
 * Nothing while it is off. The source asks `isEnabled()` first and calls
 * nothing else on a `false`: no clock is read, nothing is counted, nothing is
 * written. What was counted before logging went off is dropped, so that a
 * later sample does not report it as its own.
 *
 * Numbers and reasons only (SEC-5). Every value here is a count, a duration
 * or one of the codes named in the types below. No session id, no path, no
 * organization, no header and nothing else read from a log gets this far:
 * the methods have no parameter that could carry one.
 */
import type { ClaudeLiveUsageDegradedReason } from '@shared/types/claude-live-usage'
import type { DebugLogFollowerEvent, DebugLogUnsafeFile } from '../claude-debug-log-follower'

/** The name of the gauge in the `gauges` of a performance-log sample. */
export const CLAUDE_DEBUG_LOG_PERF_GAUGE = 'claudeDebugLog'
/** The `kind` of the record written for a rotation or a degraded event. */
export const CLAUDE_DEBUG_LOG_PERF_KIND = 'claude-debug-log'

/** Why the file at a log's path stopped being the one that was followed. */
export type ClaudeDebugLogRotationCause = Extract<
  DebugLogFollowerEvent,
  { type: 'rotated' }
>['cause']

/**
 * What the usage source reports to. `isEnabled()` is asked first, once per
 * pass and per check made outside a pass, and nothing else is called unless it
 * answered true.
 */
export interface ClaudeDebugLogUsagePerf {
  /** Whether performance logging is on right now. Must be cheap. */
  isEnabled(): boolean
  /** A clock for durations, in milliseconds. Only differences are used. */
  now(): number
  /** The timer fired and every session that was due has been checked. */
  pass(durationMs: number): void
  /** One session's log was looked at: what it took and what was new in it. */
  check(durationMs: number, bytesRead: number, entriesParsed: number, parseFailures: number): void
  /** The follower reported that a log was rotated. */
  rotated(cause: ClaudeDebugLogRotationCause): void
  /**
   * A session's log gives no readings (the source's own judgement), or the
   * follower gave up on a file (`hard-cap`, `unsafe-file`, with what was wrong
   * for the latter).
   */
  degraded(reason: ClaudeLiveUsageDegradedReason, detail: DebugLogUnsafeFile | null): void
}

/** The `claudeDebugLog` gauge: the time since the previous sample, in numbers. */
export type ClaudeDebugLogPerfWindow = {
  /** Sessions registered with the source when the sample was taken. */
  sessions: number
  /** Times the timer fired. */
  passes: number
  /** Checks of one session's log: by the timer, asked for, and the final read of a session that ended. */
  checks: number
  /** Bytes of log read. */
  bytesRead: number
  /** Lines that were an API response entry. */
  entriesParsed: number
  /** Lines that started like a response entry and could not be read. */
  parseFailures: number
  /** Time spent in checks, in ms. */
  checkTotalMs: number
  /** The longest check, in ms. */
  checkMaxMs: number
  /** Time spent in passes, in ms: their checks and the scheduling around them. */
  passTotalMs: number
  /** The longest pass, in ms (PF-4 allows 2 ms unchanged and 10 ms changed, for 50 sessions). */
  passMaxMs: number
  /** `rotated` events; each also has a record of its own. */
  rotations: number
  /** Degraded events; each also has a record of its own. */
  degraded: number
}

/** The `claude-debug-log` record, next to the logger's own `t`, `role`, `pid` and `kind`. */
export type ClaudeDebugLogPerfEvent =
  | { event: 'rotated'; cause: ClaudeDebugLogRotationCause }
  | { event: 'degraded'; reason: ClaudeLiveUsageDegradedReason; detail?: DebugLogUnsafeFile }

export interface ClaudeDebugLogUsagePerfCountersDeps {
  /** `perfLog.isEnabled` in the app. */
  isEnabled: () => boolean
  /** Writes one record of a kind to the performance log; `perfLog.record` in the app. */
  record: (kind: string, data: ClaudeDebugLogPerfEvent) => void
  /** Defaults to `performance.now()`: monotonic, unlike the wall clock. */
  now?: () => number
}

/** Durations are kept to the microsecond: finer is noise, and long in a log. */
const roundMs = (ms: number): number => Math.round(ms * 1_000) / 1_000

export class ClaudeDebugLogUsagePerfCounters implements ClaudeDebugLogUsagePerf {
  private readonly deps: ClaudeDebugLogUsagePerfCountersDeps
  /** Whether anything was counted since the window was last emptied. */
  private counted = false
  private passes = 0
  private checks = 0
  private bytesRead = 0
  private entriesParsed = 0
  private parseFailures = 0
  private checkTotalMs = 0
  private checkMaxMs = 0
  private passTotalMs = 0
  private passMaxMs = 0
  private rotations = 0
  private degradations = 0

  constructor(deps: ClaudeDebugLogUsagePerfCountersDeps) {
    this.deps = deps
  }

  isEnabled(): boolean {
    const enabled = this.deps.isEnabled()
    // Logging went off with counts no sample took: they are not kept for the day it is back on.
    if (!enabled && this.counted) this.reset()
    return enabled
  }

  now(): number {
    return this.deps.now ? this.deps.now() : performance.now()
  }

  pass(durationMs: number): void {
    this.counted = true
    this.passes += 1
    this.passTotalMs += durationMs
    if (durationMs > this.passMaxMs) this.passMaxMs = durationMs
  }

  check(durationMs: number, bytesRead: number, entriesParsed: number, parseFailures: number): void {
    this.counted = true
    this.checks += 1
    this.bytesRead += bytesRead
    this.entriesParsed += entriesParsed
    this.parseFailures += parseFailures
    this.checkTotalMs += durationMs
    if (durationMs > this.checkMaxMs) this.checkMaxMs = durationMs
  }

  rotated(cause: ClaudeDebugLogRotationCause): void {
    this.counted = true
    this.rotations += 1
    this.deps.record(CLAUDE_DEBUG_LOG_PERF_KIND, { event: 'rotated', cause })
  }

  degraded(reason: ClaudeLiveUsageDegradedReason, detail: DebugLogUnsafeFile | null): void {
    this.counted = true
    this.degradations += 1
    this.deps.record(
      CLAUDE_DEBUG_LOG_PERF_KIND,
      detail === null ? { event: 'degraded', reason } : { event: 'degraded', reason, detail }
    )
  }

  /**
   * The gauge: what was counted since this was last called, with the number of
   * registered sessions the caller gives. Calling it empties the counters.
   */
  takeWindow(sessions: number): ClaudeDebugLogPerfWindow {
    const window: ClaudeDebugLogPerfWindow = {
      sessions,
      passes: this.passes,
      checks: this.checks,
      bytesRead: this.bytesRead,
      entriesParsed: this.entriesParsed,
      parseFailures: this.parseFailures,
      checkTotalMs: roundMs(this.checkTotalMs),
      checkMaxMs: roundMs(this.checkMaxMs),
      passTotalMs: roundMs(this.passTotalMs),
      passMaxMs: roundMs(this.passMaxMs),
      rotations: this.rotations,
      degraded: this.degradations
    }
    this.reset()
    return window
  }

  private reset(): void {
    this.counted = false
    this.passes = 0
    this.checks = 0
    this.bytesRead = 0
    this.entriesParsed = 0
    this.parseFailures = 0
    this.checkTotalMs = 0
    this.checkMaxMs = 0
    this.passTotalMs = 0
    this.passMaxMs = 0
    this.rotations = 0
    this.degradations = 0
  }
}

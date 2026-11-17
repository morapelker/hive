/**
 * Turns the debug logs of Code Mode sessions into live usage (Code Mode T16;
 * CODE_MODE_PRD.html FR-20, FR-24, FR-25, FR-30, FR-40, SEC-5, SEC-6, PF-1,
 * PF-2, PF-4).
 *
 * A Code Mode session of the Claude CLI talks to the API directly, so the
 * app's proxy never sees its responses. The CLI writes them to a debug log
 * instead, one file per launch. This service follows the log of every
 * registered session (`DebugLogFollower`), reads each complete line
 * (`parseClaudeDebugLogLine`) and hands the live updater one observation per
 * response that carries usage, identified by the organization it was billed
 * to and stamped with the time written in the log line.
 *
 *   register(session)       before the CLI process starts
 *   setTurnInProgress(...)  from the session's hook status
 *   unregister(session)     when it ends: one final read, then nothing more
 *   facts(session)          what health detection reads (T18)
 *
 * One schedule for all sessions (PF-2): a single timer, re-armed after every
 * pass, and no timer at all while nothing is registered.
 * - A busy session is checked on every pass, 250 ms apart. Busy means a turn
 *   is in progress, or the log grew (or the session was registered, or its
 *   turn ended) less than 15 seconds ago. The log only grows when the CLI
 *   talks to the API, and a request is logged when it is sent, before its
 *   response starts: growth covers what no turn announces (the start-up quota
 *   check, title generation, background agents).
 * - An idle session is checked every 2 seconds. While some session is busy
 *   the idle ones ride along on the pass nearest to their turn; while none
 *   is, every pass checks them all, so that they share one wake-up.
 * - A pass that runs late (a blocked event loop, a sleeping machine) is not
 *   made up for: the next one is timed from when this one ran.
 *
 * Why a timer and not `fs.watch`: the CLI opens and closes the file on every
 * write and the file is replaced underneath the reader (the CLI's rotation,
 * the follower's own). A watcher follows one inode, reports renames
 * differently on every platform and coalesces events, so it could only ever
 * be a hint next to this same check. The check itself is one `lstat` for an
 * unchanged file (PF-3): synchronous, bounded fs work on the main thread,
 * like the transcript tailers, which keeps it off the libuv thread pool.
 *
 * Nothing of a line is kept (SEC-5, SEC-6). A line is parsed in memory and
 * dropped; what leaves this module is the usage snapshot, the organization id
 * and the line's time. A line that cannot be read is counted, never recorded,
 * and nothing here logs anything read from a file.
 */
import { isAbsolute } from 'node:path'
import {
  parseUnifiedRateLimitHeaders,
  snapshotHasUsage
} from '../claude-api-proxy/anthropic-rate-limit-headers'
import type { ClaudeUsageObservation } from '../claude-api-proxy/claude-usage-live-updater'
import {
  DebugLogFollower,
  type DebugLogFollowerEvent,
  type DebugLogFollowerOptions,
  type DebugLogFollowerStats,
  type DebugLogUnsafeFile
} from '../claude-debug-log-follower'
import { parseClaudeDebugLogLine } from './claude-debug-log-entry-parser'

/** Time between two checks of a busy session (PF-2). */
export const DEBUG_LOG_ACTIVE_CHECK_INTERVAL_MS = 250
/** Time between two checks of an idle session (PF-2). */
export const DEBUG_LOG_IDLE_CHECK_INTERVAL_MS = 2_000
/**
 * How long a session stays busy after its log grew, after it was registered
 * and after its turn ended. A request is logged when it is sent and its
 * response when the headers arrive, which can be many seconds later.
 */
export const DEBUG_LOG_ACTIVITY_HOLD_MS = 15_000

export interface ClaudeDebugLogSessionRegistration {
  /**
   * One launch of the CLI. A resumed session is a new launch with a new log:
   * unregister the old one first, or register the same id with the new path.
   */
  sessionId: string
  /** The file that launch was told to write its debug log to (absolute). */
  logPath: string
}

/** The follower gave up on a file. Carries no log content. */
export interface ClaudeDebugLogDegradedSignal {
  /** `hard-cap`: the file was too large and was deleted. `unsafe-file`: what is at the path was refused. */
  reason: 'hard-cap' | 'unsafe-file'
  /** For `unsafe-file`: what was wrong with it. */
  detail: DebugLogUnsafeFile | null
  /** When the source was told (its own clock, epoch ms). */
  at: number
}

/** What is known about one registered session. Numbers and times only. */
export interface ClaudeDebugLogSessionFacts {
  sessionId: string
  logPath: string
  /** Epoch ms, the source's clock. */
  registeredAt: number
  turnInProgress: boolean
  /** When the log was last looked at, or null before the first check. */
  lastCheckAt: number | null
  /** Bytes of log read so far. 0 means the log is missing or empty. */
  bytesRead: number
  /** Complete lines read so far, of any kind. */
  linesRead: number
  /** Lines that were an API response entry (`response start` or `response error`). */
  entriesParsed: number
  /** Entries that became an observation for the live updater. */
  observations: number
  /** Entries without usable usage headers (a 404, a temporary throttle): nothing to report. */
  entriesWithoutUsage: number
  /** Entries with usage but no readable organization: nothing to attribute them by. */
  entriesWithoutOrganization: number
  /** Lines that started like a response entry and could not be read. */
  parseFailures: number
  /** Lines over the length limit, skipped unread. */
  oversizedLines: number
  /** Observations the live updater refused by throwing. */
  submitFailures: number
  /** The time written in the log line of the last observation (epoch ms), or null. */
  lastObservationAt: number | null
  /** When that line was read (the source's clock), or null. */
  lastObservationReadAt: number | null
  /** The latest degraded signal of the follower, or null when there was none. */
  degraded: ClaudeDebugLogDegradedSignal | null
  /** How many degraded signals there were. */
  degradedSignals: number
  /** The follower's own counters (reads, rotations, fs errors, ...). */
  follower: DebugLogFollowerStats
}

/** How the schedule is doing, for tests and performance counters (T20). */
export interface ClaudeDebugLogUsageSourceStats {
  sessions: number
  /** Whether the shared timer is armed. Never while no session is registered. */
  timerArmed: boolean
  /** Times the timer fired. */
  passes: number
  /** Checks of one session's log, by the timer or asked for. */
  checks: number
  observations: number
}

export interface ClaudeDebugLogUsageSourceDeps {
  /**
   * Receives each observation; `submitClaudeUsageObservation` in the app. Must
   * return at once.
   */
  submit: (observation: ClaudeUsageObservation) => void
  /** Session ids and counters only: nothing read from a log is ever passed to it. */
  log?: {
    debug: (message: string, data?: Record<string, unknown>) => void
    info: (message: string, data?: Record<string, unknown>) => void
  }
  /** Defaults to `DEBUG_LOG_ACTIVE_CHECK_INTERVAL_MS`. */
  activeIntervalMs?: number
  /** Defaults to `DEBUG_LOG_IDLE_CHECK_INTERVAL_MS`. */
  idleIntervalMs?: number
  /** Defaults to `DEBUG_LOG_ACTIVITY_HOLD_MS`. */
  activityHoldMs?: number
  /** Passed on to every follower; injectable for tests. */
  follower?: Omit<DebugLogFollowerOptions, 'path' | 'onLine' | 'onEvent'>
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

interface Session {
  id: string
  logPath: string
  follower: DebugLogFollower
  registeredAt: number
  turnInProgress: boolean
  /** Checked on every pass until this moment. */
  busyUntil: number
  lastCheckAt: number | null
  /** The follower's byte count at the last check: a change means the log grew. */
  bytesRead: number
  /** Set by `dispose()`: what a closing read still delivers is dropped. */
  muted: boolean
  entriesParsed: number
  observations: number
  entriesWithoutUsage: number
  entriesWithoutOrganization: number
  parseFailures: number
  oversizedLines: number
  submitFailures: number
  lastObservationAt: number | null
  lastObservationReadAt: number | null
  degraded: ClaudeDebugLogDegradedSignal | null
  degradedSignals: number
}

export class ClaudeDebugLogUsageSource {
  private readonly deps: ClaudeDebugLogUsageSourceDeps
  private readonly activeIntervalMs: number
  private readonly idleIntervalMs: number
  private readonly activityHoldMs: number
  private readonly sessions = new Map<string, Session>()
  private timer: unknown = null
  /** When the armed timer is meant to fire. */
  private timerDueAt = 0
  private passes = 0
  private checks = 0
  private observations = 0

  constructor(deps: ClaudeDebugLogUsageSourceDeps) {
    this.deps = deps
    this.activeIntervalMs = Math.max(1, deps.activeIntervalMs ?? DEBUG_LOG_ACTIVE_CHECK_INTERVAL_MS)
    this.idleIntervalMs = Math.max(
      this.activeIntervalMs,
      deps.idleIntervalMs ?? DEBUG_LOG_IDLE_CHECK_INTERVAL_MS
    )
    this.activityHoldMs = Math.max(0, deps.activityHoldMs ?? DEBUG_LOG_ACTIVITY_HOLD_MS)
  }

  /**
   * Start following a session's log. Call it before the CLI process starts, so
   * that the first response is not missed; the file does not have to exist.
   *
   * Registering a session that is already followed at the same path changes
   * nothing and returns false (a view re-attaching to a running process).
   * The same id with another path is a new launch: the old log gets its final
   * read first. Throws only on an id or path that cannot be a registration.
   */
  register(registration: ClaudeDebugLogSessionRegistration): boolean {
    const { sessionId, logPath } = registration
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new TypeError('A debug-log session needs an id')
    }
    if (typeof logPath !== 'string' || !isAbsolute(logPath)) {
      throw new TypeError('A debug-log session needs an absolute log path')
    }
    const existing = this.sessions.get(sessionId)
    if (existing) {
      if (existing.logPath === logPath) return false
      this.unregister(sessionId)
    }

    const now = this.now()
    const session: Session = {
      id: sessionId,
      logPath,
      // Replaced right below: the follower's callbacks need the session.
      follower: null as unknown as DebugLogFollower,
      registeredAt: now,
      turnInProgress: false,
      // A CLI that starts talks to the API before any turn (its quota check).
      busyUntil: now + this.activityHoldMs,
      lastCheckAt: null,
      bytesRead: 0,
      muted: false,
      entriesParsed: 0,
      observations: 0,
      entriesWithoutUsage: 0,
      entriesWithoutOrganization: 0,
      parseFailures: 0,
      oversizedLines: 0,
      submitFailures: 0,
      lastObservationAt: null,
      lastObservationReadAt: null,
      degraded: null,
      degradedSignals: 0
    }
    session.follower = new DebugLogFollower({
      ...this.deps.follower,
      path: logPath,
      onLine: (line) => this.onLine(session, line),
      onEvent: (event) => this.onFollowerEvent(session, event)
    })
    this.sessions.set(sessionId, session)
    this.deps.log?.debug('Following the debug log of a Claude CLI session', { sessionId })
    this.arm()
    return true
  }

  /**
   * Stop following a session: its log is read one last time, to its end, so
   * that a response written just before this call still counts, and it is
   * never looked at again. Returns the session's final facts, or null when it
   * was not registered.
   */
  unregister(sessionId: string): ClaudeDebugLogSessionFacts | null {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    this.sessions.delete(sessionId)
    this.checks += 1
    session.follower.close()
    session.lastCheckAt = this.now()
    const facts = this.factsOf(session)
    this.deps.log?.info('Stopped following the debug log of a Claude CLI session', {
      sessionId,
      bytesRead: facts.bytesRead,
      entriesParsed: facts.entriesParsed,
      observations: facts.observations,
      parseFailures: facts.parseFailures,
      degraded: facts.degraded?.reason ?? null
    })
    this.arm()
    return facts
  }

  /**
   * Say whether the session has a turn in progress (the prompt was submitted
   * and the CLI has not stopped yet). While it has, its log is checked on
   * every pass. When the turn ends the log is checked right away, so that the
   * facts are current for whoever judges the turn, and stays on the fast
   * schedule a little longer for the requests that follow a turn. Returns
   * false when the session is not registered.
   */
  setTurnInProgress(sessionId: string, inProgress: boolean): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    if (session.turnInProgress === inProgress) return true
    session.turnInProgress = inProgress
    if (!inProgress) {
      const now = this.now()
      session.busyUntil = Math.max(session.busyUntil, now + this.activityHoldMs)
      this.check(session, now)
    }
    this.arm()
    return true
  }

  /**
   * Look at one session's log now, or at every log when no id is given,
   * whatever the schedule says. The schedule itself is not changed.
   */
  checkNow(sessionId?: string): void {
    const now = this.now()
    if (sessionId === undefined) {
      for (const session of this.sessions.values()) this.check(session, now)
    } else {
      const session = this.sessions.get(sessionId)
      if (session) this.check(session, now)
    }
    this.arm()
  }

  /** What is known about a registered session, or null. */
  facts(sessionId: string): ClaudeDebugLogSessionFacts | null {
    const session = this.sessions.get(sessionId)
    return session ? this.factsOf(session) : null
  }

  /** The facts of every registered session. */
  allFacts(): ClaudeDebugLogSessionFacts[] {
    return [...this.sessions.values()].map((session) => this.factsOf(session))
  }

  stats(): ClaudeDebugLogUsageSourceStats {
    return {
      sessions: this.sessions.size,
      timerArmed: this.timer !== null,
      passes: this.passes,
      checks: this.checks,
      observations: this.observations
    }
  }

  /**
   * App shutdown: let go of every log and stop the timer. Nothing more is
   * submitted (the live updater is shutting down too); a session that should
   * still count its last lines is unregistered before this.
   */
  dispose(): void {
    for (const session of this.sessions.values()) {
      session.muted = true
      session.follower.close()
    }
    this.sessions.clear()
    this.cancelTimer()
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private isBusy(session: Session, now: number): boolean {
    return session.turnInProgress || now < session.busyUntil
  }

  private anyBusy(now: number): boolean {
    for (const session of this.sessions.values()) {
      if (this.isBusy(session, now)) return true
    }
    return false
  }

  /** The timer fired: check what is due, then arm the timer for the next pass. */
  private pass(): void {
    this.timer = null
    this.passes += 1
    const now = this.now()
    // With nobody busy this is the idle wake-up, and everyone shares it.
    const everyone = !this.anyBusy(now)
    // An idle session takes the fast pass nearest to its turn.
    const idleDueAfter = this.idleIntervalMs - this.activeIntervalMs / 2
    try {
      for (const session of this.sessions.values()) {
        const last = session.lastCheckAt
        const due =
          everyone ||
          this.isBusy(session, now) ||
          last === null ||
          now - last >= idleDueAfter ||
          // The clock went back: do not wait for it to catch up.
          now < last
        if (due) this.check(session, now)
      }
    } finally {
      this.arm()
    }
  }

  private check(session: Session, now: number): void {
    this.checks += 1
    session.follower.check()
    session.lastCheckAt = now
    const bytesRead = session.follower.stats().bytesRead
    if (bytesRead !== session.bytesRead) {
      session.bytesRead = bytesRead
      session.busyUntil = Math.max(session.busyUntil, now + this.activityHoldMs)
    }
  }

  /**
   * Make sure the one timer fires when the next pass is due: within the fast
   * interval while a session is busy, within the idle one otherwise, and not
   * at all while nothing is registered. A timer that already fires soon
   * enough is left alone.
   */
  private arm(): void {
    if (this.sessions.size === 0) {
      this.cancelTimer()
      return
    }
    const now = this.now()
    const delay = this.anyBusy(now) ? this.activeIntervalMs : this.idleIntervalMs
    const dueAt = now + delay
    if (this.timer !== null) {
      // Also when it is overdue: pushing a late timer back could starve the pass.
      if (this.timerDueAt <= dueAt) return
      this.cancelTimer()
    }
    this.timerDueAt = dueAt
    const fire = (): void => this.pass()
    if (this.deps.setTimer) {
      this.timer = this.deps.setTimer(fire, delay)
    } else {
      const handle = setTimeout(fire, delay)
      // Following a log is no reason to keep a process alive.
      handle.unref?.()
      this.timer = handle
    }
  }

  private cancelTimer(): void {
    if (this.timer === null) return
    if (this.deps.clearTimer) this.deps.clearTimer(this.timer)
    else clearTimeout(this.timer as ReturnType<typeof setTimeout>)
    this.timer = null
  }

  /** One complete line of a session's log. The line itself goes nowhere from here. */
  private onLine(session: Session, line: string): void {
    if (session.muted) return
    const result = parseClaudeDebugLogLine(line)
    if (result.kind !== 'entry') {
      if (result.reason === 'malformed') session.parseFailures += 1
      else if (result.reason === 'oversized') session.oversizedLines += 1
      return
    }
    session.entriesParsed += 1
    const entry = result.entry
    const snapshot = parseUnifiedRateLimitHeaders(entry.headers)
    if (snapshot === null || !snapshotHasUsage(snapshot)) {
      session.entriesWithoutUsage += 1
      return
    }
    if (entry.organizationUuid === null) {
      // Usage that names nobody: the updater could only guess, and must not.
      session.entriesWithoutOrganization += 1
      return
    }
    try {
      // No credential and no reported account id: the organization alone
      // decides the account (FR-25).
      this.deps.submit({
        credentialFingerprint: null,
        accountUuid: null,
        organizationUuid: entry.organizationUuid,
        snapshot,
        observedAt: entry.observedAt
      })
    } catch {
      session.submitFailures += 1
      return
    }
    session.observations += 1
    this.observations += 1
    session.lastObservationAt = entry.observedAt
    session.lastObservationReadAt = this.now()
  }

  private onFollowerEvent(session: Session, event: DebugLogFollowerEvent): void {
    if (event.type !== 'degraded') return
    session.degradedSignals += 1
    session.degraded = {
      reason: event.reason,
      detail: event.reason === 'unsafe-file' ? event.detail : null,
      at: this.now()
    }
  }

  private factsOf(session: Session): ClaudeDebugLogSessionFacts {
    const follower = session.follower.stats()
    return {
      sessionId: session.id,
      logPath: session.logPath,
      registeredAt: session.registeredAt,
      turnInProgress: session.turnInProgress,
      lastCheckAt: session.lastCheckAt,
      bytesRead: follower.bytesRead,
      linesRead: follower.linesDelivered,
      entriesParsed: session.entriesParsed,
      observations: session.observations,
      entriesWithoutUsage: session.entriesWithoutUsage,
      entriesWithoutOrganization: session.entriesWithoutOrganization,
      parseFailures: session.parseFailures,
      oversizedLines: session.oversizedLines + follower.oversizedLinesSkipped,
      submitFailures: session.submitFailures,
      lastObservationAt: session.lastObservationAt,
      lastObservationReadAt: session.lastObservationReadAt,
      degraded: session.degraded ? { ...session.degraded } : null,
      degradedSignals: session.degradedSignals,
      follower
    }
  }
}

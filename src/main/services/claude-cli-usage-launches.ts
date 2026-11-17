// Where the live usage of one Claude CLI process comes from, for as long as that process
// runs (Code Mode T17; PRD FR-4, FR-15, LF-6, LF-7, LF-8).
//
// A session that asks for Code Mode cannot go through the app's API proxy, so its usage is
// read from the CLI's own debug log instead. The pieces for that were built apart from each
// other, and this is where a session's process meets them:
//
//   decide    which transport a process about to start gets (claude-usage-transport.ts, with
//             the Advanced switch and the kill switch of claude-debug-usage-setting.ts).
//   begin     for `debug-log`: the launch's own directory (claude-cli-debug-dir.ts) and the
//             follower of its log (claude-debug-log-usage-source.ts), both before the process
//             starts, and what the spawn builder needs to point the CLI at them
//             (claude-cli-spawner.ts). A launch that cannot be prepared still starts, without
//             live usage (`none`).
//   started   the process exists: from here on its end is the end of the launch.
//   abandon   the process never started: what `begin` made is taken back.
//   noteStatus  the session's hook status: the log is read faster while a turn runs, and
//             judged when the turn completes (health, below).
//   sweep     deletes the directories a crash left behind, at start and every hour.
//   quit      the app is going: every launch ends once the PTYs have been reaped.
//
// A launch belongs to a process, not to a session. A view that attaches to a running process
// begins nothing; a session that is started again (a restart, a resume after the app was
// closed) is a new launch with a new directory, and shares nothing with the earlier one.
//
// Health (Code Mode T18; PRD FR-30, FR-31, LF-5). A log can stop giving readings: the CLI
// could not write it, an update changed its format, the follower had to give it up. The
// usage source notices (claude-debug-log-usage-source.ts says when) and this is where the
// launch is told. A degraded launch needs nothing switched over: the usage poll runs on its
// own schedule whatever a session's transport is, so its numbers are simply the only ones
// left. What is done here is the telling: one warning per launch, with the reason and the
// CLI's version and nothing from the log, and a word to `onHealthChange` every time the
// launch becomes degraded or healthy again (the usage UI stops saying "Live" on the
// strength of that session). The launch stays a `debug-log` launch throughout, and is
// healthy again with the next response its log gives.
//
// A CLI version the log does not work with (Code Mode T19; PRD FR-32). Every `debug-log`
// launch says how it turned out to `autoDisable` (claude-debug-usage-auto-disable.ts, which
// has the rules): that its log became degraded before one response in it could be read, or
// that a response could be read. The second is looked for when a turn completes, when a
// degraded launch recovers and in the final read. After three launches in a row without a
// reading on one CLI version, `decide` gives the next ones `none` instead of `debug-log`,
// until the CLI or the app is another version. Launches that are running keep what they have.
//
// The end is the same whatever ended the process (it exited, the session was closed, it was
// reaped, the app quits): the log is read one last time and let go of, then the directory is
// deleted. In that order, and the directory only once the process is gone: a CLI that still
// runs makes the directory again on its next log line, and not a private one. So closing a
// session does not end its launch; the exit of its process does, a moment later.
import { basename } from 'node:path'
import type { SessionStatusType } from '@shared/types/session-status'
import type { ClaudeCliDebugDirs, ClaudeCliDebugLaunch } from './claude-cli-debug-dir'
import type { ClaudeCliUsageLaunch } from './claude-cli-spawner'
import type {
  ClaudeDebugLogDegradedReason,
  ClaudeDebugLogHealthChange,
  ClaudeDebugLogSessionFacts,
  ClaudeDebugLogUsageSource
} from './claude-debug-log/claude-debug-log-usage-source'
import type {
  ClaudeDebugUsageAutoDisable,
  ClaudeDebugUsageLaunchOutcome
} from './claude-debug-log/claude-debug-usage-auto-disable'
import type {
  ClaudeUsageTransport,
  ResolveClaudeUsageTransportOptions
} from './claude-usage-transport'
import { getUserEnvironmentVariables } from './env-vars'
import { createLogger } from './logger'

const log = createLogger({ component: 'ClaudeCliUsageLaunches' })

/** Time between two sweeps of the directories no session uses any more (LF-7). */
export const CLAUDE_CLI_USAGE_SWEEP_INTERVAL_MS = 60 * 60 * 1000

/** The user's own shell file for the commands of a session; the app's file sources it. */
const CLAUDE_ENV_FILE_ENV = 'CLAUDE_ENV_FILE'

type SettingsReader = { getSetting(key: string): string | null } | null

export interface ClaudeCliUsageLaunchesDeps {
  /** The launch directories (`claudeCliDebugDirs()` in the app). */
  readonly dirs: Pick<ClaudeCliDebugDirs, 'prepare' | 'remove' | 'sweep'>
  /** The follower of every Code Mode session's log (`getClaudeDebugLogUsageSource()`). */
  readonly source: Pick<
    ClaudeDebugLogUsageSource,
    'register' | 'unregister' | 'setTurnInProgress' | 'turnCompleted' | 'onHealthChange' | 'facts'
  >
  /** Whether live usage for Code Mode sessions is on, given the environment to read. */
  readonly isFeatureEnabled: (env: NodeJS.ProcessEnv) => boolean
  /** The transport decision for one launch. */
  readonly resolveTransport: (
    options: ResolveClaudeUsageTransportOptions
  ) => Promise<ClaudeUsageTransport>
  /**
   * Call `listener` when the process of the session's PTY has ended, whatever ended it and
   * whether or not the PTY is still known under that id by then. Returns what takes the
   * listener off again; that is never called from inside the listener.
   */
  readonly onProcessExit: (sessionId: string, listener: () => void) => () => void
  /** Whether the session has a PTY right now. */
  readonly hasLiveProcess: (sessionId: string) => boolean
  /**
   * The version of the CLI binary at `path`, or null when it is not known. Asked when a
   * launch becomes degraded; must answer at once.
   */
  readonly cliVersion?: (path: string) => string | null
  /**
   * Told when the log of a session's running launch stops giving readings and when it gives
   * them again (the app tells the usage UI). Must return at once.
   */
  readonly onHealthChange?: (change: ClaudeCliUsageHealthChange) => void
  /**
   * What switches the debug log off for a CLI version it gives no readings with (T19).
   * Without it every launch the decision gives `debug-log` gets it.
   */
  readonly autoDisable?: Pick<ClaudeDebugUsageAutoDisable, 'blocks' | 'launch'>
  /** The app's own environment; `process.env` unless a test says otherwise. */
  readonly env?: NodeJS.ProcessEnv
  /** Defaults to `CLAUDE_CLI_USAGE_SWEEP_INTERVAL_MS`. */
  readonly sweepIntervalMs?: number
  readonly setInterval?: (fn: () => void, ms: number) => unknown
  readonly clearInterval?: (handle: unknown) => void
}

export interface ClaudeCliUsageDecideInput {
  /** Reads Settings → Environment Variables. */
  readonly db: SettingsReader
  /** The session's custom provider command, when it launches through one. */
  readonly customProviderCommand?: string | null
  /** The CLI binary the launch will run: its version decides whether it gets a debug log. */
  readonly cliPath?: string | null
}

export interface ClaudeCliUsageBeginOptions {
  /** The directory the CLI starts in. */
  readonly cwd: string
  /** Reads Settings → Environment Variables. */
  readonly db: SettingsReader
  /**
   * The CLI binary the launch runs: its version is what a degraded launch is reported with
   * and what the launch is counted for (T19).
   */
  readonly cliPath?: string | null
}

/** The live usage of a session's launch stopped coming from its debug log, or came back. */
export interface ClaudeCliUsageHealthChange {
  readonly sessionId: string
  /** True: usage for this session comes from the usage poll alone until it recovers. */
  readonly degraded: boolean
  /** Why, for a degraded launch; null for one that is healthy again. */
  readonly reason: ClaudeDebugLogDegradedReason | null
  /** The CLI's version, or null when it is not known. */
  readonly cliVersion: string | null
  /** When it changed (epoch ms). */
  readonly at: number
}

/** One process of a session that is off the proxy, from `begin` to the end of the process. */
interface Launch {
  readonly sessionId: string
  readonly transport: Exclude<ClaudeUsageTransport, 'proxy'>
  /** The prepared directory of a `debug-log` launch. */
  readonly files: ClaudeCliDebugLaunch | null
  /** Its log is being followed. */
  registered: boolean
  /** Its process exists (or did). */
  started: boolean
  ended: boolean
  /** Takes the exit listener off its process. */
  offExit: (() => void) | null
  /** The last sweep found it without a PTY and without a reported end. */
  withoutProcess: boolean
  /** The CLI binary it runs, when the caller said. */
  readonly cliPath: string | null
  /** A turn started and has not completed. */
  turnOpen: boolean
  /** Why its log gives no readings right now; null while it does (or has had no reason to). */
  degraded: ClaudeDebugLogDegradedReason | null
  /** The one warning a degraded launch gets was logged. */
  warned: boolean
  /** Where a `debug-log` launch says how it turned out (T19); null for any other. */
  readonly outcome: ClaudeDebugUsageLaunchOutcome | null
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** A turn is running: the agent is at work, not waiting for the person. */
const isTurnInProgress = (status: SessionStatusType): boolean =>
  status === 'working' || status === 'planning'

/** The turn is over (the Stop hook, or what stands in for it), not waiting on an answer. */
const isTurnCompleted = (status: SessionStatusType): boolean =>
  status === 'completed' || status === 'unread'

export class ClaudeCliUsageLaunches {
  private readonly deps: ClaudeCliUsageLaunchesDeps
  private readonly sweepIntervalMs: number
  /** The launch of each session's current process (running, or about to start). */
  private readonly current = new Map<string, Launch>()
  /**
   * Launches whose session was started again while their own process had been told to end
   * and had not ended yet. They keep their directory until it has.
   */
  private readonly replaced = new Set<Launch>()
  private sweepTimer: unknown = null

  constructor(deps: ClaudeCliUsageLaunchesDeps) {
    this.deps = deps
    this.sweepIntervalMs = Math.max(1, deps.sweepIntervalMs ?? CLAUDE_CLI_USAGE_SWEEP_INTERVAL_MS)
    try {
      // For as long as the launches live: they are the app's, like the source.
      deps.source.onHealthChange((change) => this.noteHealth(change))
    } catch (error) {
      log.warn('Could not listen for the health of the debug logs', { error: errorText(error) })
    }
  }

  private get env(): NodeJS.ProcessEnv {
    return this.deps.env ?? process.env
  }

  /**
   * The transport for a process of the session that is about to start. Asked once per
   * process: one that is already running keeps what it was started with (FR-4), so a view
   * attaching to it does not ask.
   *
   * A launch that would get `debug-log` gets `none` while the debug log is switched off for
   * the version of its CLI (FR-32). Nothing else is asked about that: a launch on the proxy
   * is decided as it always was.
   *
   * Never throws. When the decision cannot be made the launch stays on the proxy, as every
   * launch did before.
   */
  async decide(input: ClaudeCliUsageDecideInput): Promise<ClaudeUsageTransport> {
    let transport: ClaudeUsageTransport
    try {
      // The kill switch is read where the launch's own variables are: Settings → Environment
      // Variables over the app's environment.
      const settingsEnv = getUserEnvironmentVariables(input.db)
      transport = await this.deps.resolveTransport({
        db: input.db,
        featureEnabled: this.deps.isFeatureEnabled({ ...this.env, ...settingsEnv }),
        customProviderCommand: input.customProviderCommand,
        env: this.env
      })
    } catch (error) {
      log.warn('Could not decide the usage transport; the launch stays on the proxy', {
        error: errorText(error)
      })
      return 'proxy'
    }
    if (transport !== 'debug-log' || !(await this.switchedOff(input.cliPath ?? null))) {
      return transport
    }
    log.info(
      'A Code Mode launch starts without live usage: the debug log is switched off for this version of the Claude CLI'
    )
    return 'none'
  }

  /**
   * A new process of the session is about to start with this transport: get what it needs
   * ready and say what the spawn builder has to be given. Null for `proxy`, whose launch is
   * what it always was.
   *
   * For `debug-log` the launch gets a directory of its own and its log is followed from now
   * on, before there is a process to write to it (FR-15). When either cannot be done the
   * launch is `none`: the session starts, off the proxy as it asked, without live usage.
   *
   * Only for a session that has no PTY, and with nothing awaited between this call and the
   * spawn: the caller then cannot be overtaken by another start of the same session. Follow
   * it with `started` once the PTY exists, or `abandon` when it never will. Never throws.
   */
  begin(
    sessionId: string,
    transport: ClaudeUsageTransport,
    options: ClaudeCliUsageBeginOptions
  ): ClaudeCliUsageLaunch | null {
    const earlier = this.current.get(sessionId)
    if (earlier) this.replace(earlier)
    if (transport === 'proxy') return null

    const files = transport === 'debug-log' ? this.prepare(sessionId, options) : null
    const launch: Launch = {
      sessionId,
      transport: files ? 'debug-log' : 'none',
      files,
      registered: files !== null,
      started: false,
      ended: false,
      offExit: null,
      withoutProcess: false,
      cliPath: options.cliPath ?? null,
      turnOpen: false,
      degraded: null,
      warned: false,
      outcome: files ? this.outcomeOf(options.cliPath ?? null) : null
    }
    this.current.set(sessionId, launch)
    if (!files) return { transport: 'none' }
    log.info('A Claude CLI launch reports its usage through its debug log', {
      sessionId,
      dir: basename(files.dir)
    })
    return { transport: 'debug-log', debugLogFile: files.logFile, envFile: files.envFile }
  }

  /** The PTY of the launch `begin` prepared exists: its process's end is the launch's end. */
  started(sessionId: string): void {
    const launch = this.current.get(sessionId)
    if (!launch || launch.started) return
    launch.started = true
    try {
      launch.offExit = this.deps.onProcessExit(sessionId, () => {
        // The process is gone, and its listeners go with it. This one is not taken off here:
        // the listeners of a PTY are called in a row, and one that removes itself while that
        // happens makes the next one (the terminal's own exit handling) be skipped.
        launch.offExit = null
        this.end(launch)
      })
    } catch (error) {
      // Without the listener the sweep ends the launch, once its PTY is gone.
      log.warn('Could not watch a Claude CLI process for its end', {
        sessionId,
        error: errorText(error)
      })
    }
  }

  /** The launch `begin` prepared never got a process: take back what was made for it. */
  abandon(sessionId: string): void {
    const launch = this.current.get(sessionId)
    if (launch && !launch.started) this.end(launch)
  }

  /**
   * The session's hook status changed. The log of a session whose turn is running is read
   * on the fast schedule, and once more the moment the turn ends. A turn that completes is
   * when the log is judged (FR-30): one that started here, so that a session reported idle
   * before it ever ran a turn is not judged by an empty log.
   */
  noteStatus(sessionId: string, status: SessionStatusType): void {
    const launch = this.current.get(sessionId)
    if (!launch?.registered) return
    try {
      const inProgress = isTurnInProgress(status)
      this.deps.source.setTurnInProgress(sessionId, inProgress)
      if (inProgress) {
        launch.turnOpen = true
      } else if (launch.turnOpen && isTurnCompleted(status)) {
        launch.turnOpen = false
        this.deps.source.turnCompleted(sessionId)
        this.noteReadings(launch, this.deps.source.facts(sessionId))
      }
    } catch (error) {
      log.warn('Could not pass a turn status on to the debug-log follower', {
        sessionId,
        error: errorText(error)
      })
    }
  }

  /**
   * Why the log of the session's running launch gives no readings right now, or null: for a
   * healthy launch, for one that is not on `debug-log`, and for a session without one.
   */
  degradedReason(sessionId: string): ClaudeDebugLogDegradedReason | null {
    return this.current.get(sessionId)?.degraded ?? null
  }

  /**
   * The transport the session's current process was started with, when it is off the proxy:
   * `debug-log` or `none`. Null for a process on the proxy and for a session without one.
   */
  transport(sessionId: string): Exclude<ClaudeUsageTransport, 'proxy'> | null {
    return this.current.get(sessionId)?.transport ?? null
  }

  /**
   * The sessions whose launch directory is in use: a process that runs, one that is about
   * to start (its directory exists before its PTY does), and one that was told to end and
   * has not ended yet.
   */
  liveSessionIds(): Set<string> {
    const live = new Set<string>()
    for (const launch of this.current.values()) live.add(launch.sessionId)
    for (const launch of this.replaced) live.add(launch.sessionId)
    return live
  }

  /**
   * Delete the launch directories no session of this app uses: what a crash or a force quit
   * left behind, of this app process and of app processes that are gone (LF-7). Never throws.
   *
   * A launch whose PTY is gone ends when its process reports its exit. One that has been
   * without a PTY for two sweeps in a row has no process left to wait for, whatever became
   * of the report: it is ended here, and its directory goes with it.
   */
  sweep(): void {
    try {
      for (const launch of [...this.current.values(), ...this.replaced]) {
        if (!launch.started) continue
        if (this.hasProcess(launch)) launch.withoutProcess = false
        else if (launch.withoutProcess) this.end(launch)
        else launch.withoutProcess = true
      }
      this.deps.dirs.sweep(this.liveSessionIds())
    } catch (error) {
      log.warn('Could not sweep the debug-log directories', { error: errorText(error) })
    }
  }

  /** Sweep now and every hour from now on. Calling it again sweeps once more, nothing else. */
  startSweeping(): void {
    this.sweep()
    if (this.sweepTimer !== null) return
    const tick = (): void => this.sweep()
    if (this.deps.setInterval) {
      this.sweepTimer = this.deps.setInterval(tick, this.sweepIntervalMs)
      return
    }
    const timer = setInterval(tick, this.sweepIntervalMs)
    // Cleaning up is no reason to keep a process alive.
    timer.unref?.()
    this.sweepTimer = timer
  }

  stopSweeping(): void {
    if (this.sweepTimer === null) return
    if (this.deps.clearInterval) this.deps.clearInterval(this.sweepTimer)
    else clearInterval(this.sweepTimer as ReturnType<typeof setInterval>)
    this.sweepTimer = null
  }

  /**
   * The app is quitting and is about to end every PTY. Returns what ends every launch, to be
   * called once the PTYs have been reaped.
   *
   * A launch whose PTY is alive now has no process left by then: its log is read one last
   * time and its directory is deleted, like any launch that ended. A launch whose process
   * was told to end before the quit (its session was closed, reaped or restarted a moment
   * ago) and has not reported its end is another matter: reaping the PTYs does not cover it,
   * and a CLI that still runs would make a deleted directory again, and not a private one.
   * Its log is read one last time too, and its directory is left as it is, private, for the
   * sweep of the next start, which deletes everything of an app process that is gone.
   *
   * Call what is returned with `false` when reaping the PTYs failed: no process is known to
   * be gone then, and every launch that has one keeps its directory in the same way.
   */
  quit(): (processesEnded?: boolean) => void {
    this.stopSweeping()
    const reaped = new Set<Launch>()
    for (const launch of this.current.values()) {
      if (launch.started && this.hasProcess(launch)) reaped.add(launch)
    }
    return (processesEnded = true) => {
      for (const launch of [...this.current.values(), ...this.replaced]) {
        if (!launch.started || (processesEnded && reaped.has(launch))) this.end(launch)
        else this.leaveToNextStart(launch)
      }
    }
  }

  /**
   * The usage source says a session's log stopped giving readings, or gives them again.
   * Only the session's running launch is meant: what the last read of a log that is being
   * let go of turns up changes nothing for anybody. Never throws.
   */
  private noteHealth(change: ClaudeDebugLogHealthChange): void {
    const launch = this.current.get(change.sessionId)
    if (!launch?.registered || launch.ended) return
    const reason = change.degradation?.reason ?? null
    if (reason === launch.degraded) return
    launch.degraded = reason
    // Recovered: a response could be read. Degraded with none read so far: for all this
    // launch shows, the log does not work with its CLI (T19).
    if (reason === null) this.report(launch, 'healthy')
    else if (change.facts.entriesParsed === 0) this.report(launch, 'degraded')
    const cliVersion = this.cliVersionOf(launch)
    if (reason === null) {
      log.info('The debug log of a Code Mode session gives readings again: live usage resumes', {
        sessionId: launch.sessionId
      })
    } else if (!launch.warned) {
      // Once per launch, however often it recovers and degrades again (FR-31, LF-5).
      // Numbers and fixed words only: nothing here was read from the log (SEC-5).
      launch.warned = true
      const facts = change.facts
      log.warn(
        'The debug log of a Code Mode session gives no usage readings: its usage comes from the usage poll',
        {
          sessionId: launch.sessionId,
          reason,
          ...(change.degradation?.detail ? { detail: change.degradation.detail } : {}),
          cliVersion: cliVersion ?? 'unknown',
          turnsCompleted: facts.turnsCompleted,
          bytesRead: facts.bytesRead,
          statusLines: facts.statusLines,
          entriesParsed: facts.entriesParsed,
          parseFailures: facts.parseFailures
        }
      )
    }
    try {
      this.deps.onHealthChange?.({
        sessionId: launch.sessionId,
        degraded: reason !== null,
        reason,
        cliVersion,
        at: change.degradation?.at ?? Date.now()
      })
    } catch (error) {
      log.warn('Could not pass on the health of a debug log', {
        sessionId: launch.sessionId,
        error: errorText(error)
      })
    }
  }

  private cliVersionOf(launch: Launch): string | null {
    if (launch.cliPath === null || !this.deps.cliVersion) return null
    try {
      return this.deps.cliVersion(launch.cliPath)
    } catch {
      return null
    }
  }

  /** Whether the debug log is switched off for the version of the CLI at `cliPath`. Never throws. */
  private async switchedOff(cliPath: string | null): Promise<boolean> {
    if (!this.deps.autoDisable) return false
    try {
      return await this.deps.autoDisable.blocks(cliPath)
    } catch (error) {
      log.warn('Could not ask whether the debug log is switched off for this Claude CLI', {
        error: errorText(error)
      })
      return false
    }
  }

  /** Where a `debug-log` launch that is about to start says how it turned out. Never throws. */
  private outcomeOf(cliPath: string | null): ClaudeDebugUsageLaunchOutcome | null {
    if (!this.deps.autoDisable) return null
    try {
      return this.deps.autoDisable.launch(cliPath)
    } catch (error) {
      log.warn('Could not count a Code Mode launch for its Claude CLI version', {
        error: errorText(error)
      })
      return null
    }
  }

  /** A response in the launch's log could be read: the log works with its CLI. */
  private noteReadings(launch: Launch, facts: ClaudeDebugLogSessionFacts | null): void {
    if (facts && facts.entriesParsed > 0) this.report(launch, 'healthy')
  }

  /** Tell how the launch turned out; whoever counts counts each of the two once. Never throws. */
  private report(launch: Launch, outcome: keyof ClaudeDebugUsageLaunchOutcome): void {
    try {
      launch.outcome?.[outcome]()
    } catch (error) {
      log.warn('Could not count how a Code Mode launch turned out', {
        sessionId: launch.sessionId,
        error: errorText(error)
      })
    }
  }

  /** Whether the launch's own process has a PTY right now. Never throws. */
  private hasProcess(launch: Launch): boolean {
    try {
      return (
        this.current.get(launch.sessionId) === launch &&
        this.deps.hasLiveProcess(launch.sessionId)
      )
    } catch {
      return false
    }
  }

  private prepare(
    sessionId: string,
    options: ClaudeCliUsageBeginOptions
  ): ClaudeCliDebugLaunch | null {
    let files: ClaudeCliDebugLaunch | null = null
    try {
      // The launch points CLAUDE_ENV_FILE at the app's file, which therefore has to source
      // the one the session would have had: the user's own, from Settings or from the
      // environment the app runs in.
      const settingsEnv = getUserEnvironmentVariables(options.db)
      const userEnvFile = settingsEnv[CLAUDE_ENV_FILE_ENV] ?? this.env[CLAUDE_ENV_FILE_ENV] ?? null
      files = this.deps.dirs.prepare(sessionId, { userEnvFile, cwd: options.cwd })
      if (!files) {
        // The directories said why (claude-cli-debug-dir.ts).
        log.warn('A Code Mode launch starts without live usage: its debug log has no home', {
          sessionId
        })
        return null
      }
      // Before the process starts, so that its first response is not missed.
      this.deps.source.register({ sessionId, logPath: files.logFile })
      return files
    } catch (error) {
      log.warn('A Code Mode launch starts without live usage: it could not be prepared', {
        sessionId,
        error: errorText(error)
      })
      // No process was started on it, so nothing can bring the directory back.
      if (files) this.deps.dirs.remove(files)
      return null
    }
  }

  /**
   * The session is being started again while this launch's process, told to end, has not
   * reported its end yet (a restart). The session id is about to name the new launch's log,
   * so this one's is let go of now; its directory waits for its process.
   */
  private replace(launch: Launch): void {
    this.current.delete(launch.sessionId)
    if (!launch.started) {
      this.end(launch)
      return
    }
    this.unregister(launch)
    if (launch.files) this.replaced.add(launch)
    else this.end(launch)
  }

  /** The launch's process is gone, or never was: the final read, then the directory. */
  private end(launch: Launch): void {
    if (!this.close(launch) || !launch.files) return
    this.unregister(launch)
    this.deps.dirs.remove(launch.files)
    log.info('A Claude CLI launch ended: its debug log is gone', {
      sessionId: launch.sessionId,
      dir: basename(launch.files.dir)
    })
  }

  /**
   * The app quits while the launch's process may still run: the final read, and the directory
   * stays where it is for the sweep of the next start.
   */
  private leaveToNextStart(launch: Launch): void {
    if (!this.close(launch) || !launch.files) return
    this.unregister(launch)
    log.info('A Claude CLI launch outlives the app: its debug log is left to the next start', {
      sessionId: launch.sessionId,
      dir: basename(launch.files.dir)
    })
  }

  /** Forget the launch and stop listening for its process. False when that was done before. */
  private close(launch: Launch): boolean {
    if (launch.ended) return false
    launch.ended = true
    if (this.current.get(launch.sessionId) === launch) this.current.delete(launch.sessionId)
    this.replaced.delete(launch)
    try {
      launch.offExit?.()
    } catch {
      // The process is gone, and its listeners with it.
    }
    launch.offExit = null
    return true
  }

  /** Stop following the launch's log, after one last read of it. Only its own registration. */
  private unregister(launch: Launch): void {
    if (!launch.registered) return
    launch.registered = false
    try {
      // What the last read turned up counts too: a launch that ended in the middle of a turn
      // may have given its readings without ever being judged.
      this.noteReadings(launch, this.deps.source.unregister(launch.sessionId))
    } catch (error) {
      log.warn('Could not stop following a debug log', {
        sessionId: launch.sessionId,
        error: errorText(error)
      })
    }
  }
}

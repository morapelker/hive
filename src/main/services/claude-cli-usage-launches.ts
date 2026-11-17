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
//   sweep     deletes the directories a crash left behind, at start and every hour.
//   quit      the app is going: every launch ends once the PTYs have been reaped.
//
// A launch belongs to a process, not to a session. A view that attaches to a running process
// begins nothing; a session that is started again (a restart, a resume after the app was
// closed) is a new launch with a new directory, and shares nothing with the earlier one.
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
import type { ClaudeDebugLogUsageSource } from './claude-debug-log/claude-debug-log-usage-source'
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
  readonly source: Pick<ClaudeDebugLogUsageSource, 'register' | 'unregister' | 'setTurnInProgress'>
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
}

export interface ClaudeCliUsageBeginOptions {
  /** The directory the CLI starts in. */
  readonly cwd: string
  /** Reads Settings → Environment Variables. */
  readonly db: SettingsReader
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
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** A turn is running: the agent is at work, not waiting for the person. */
const isTurnInProgress = (status: SessionStatusType): boolean =>
  status === 'working' || status === 'planning'

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
  }

  private get env(): NodeJS.ProcessEnv {
    return this.deps.env ?? process.env
  }

  /**
   * The transport for a process of the session that is about to start. Asked once per
   * process: one that is already running keeps what it was started with (FR-4), so a view
   * attaching to it does not ask.
   *
   * Never throws. When the decision cannot be made the launch stays on the proxy, as every
   * launch did before.
   */
  async decide(input: ClaudeCliUsageDecideInput): Promise<ClaudeUsageTransport> {
    try {
      // The kill switch is read where the launch's own variables are: Settings → Environment
      // Variables over the app's environment.
      const settingsEnv = getUserEnvironmentVariables(input.db)
      return await this.deps.resolveTransport({
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
      withoutProcess: false
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
   * on the fast schedule, and once more the moment the turn ends.
   */
  noteStatus(sessionId: string, status: SessionStatusType): void {
    const launch = this.current.get(sessionId)
    if (!launch?.registered) return
    try {
      this.deps.source.setTurnInProgress(sessionId, isTurnInProgress(status))
    } catch (error) {
      log.warn('Could not pass a turn status on to the debug-log follower', {
        sessionId,
        error: errorText(error)
      })
    }
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
      this.deps.source.unregister(launch.sessionId)
    } catch (error) {
      log.warn('Could not stop following a debug log', {
        sessionId: launch.sessionId,
        error: errorText(error)
      })
    }
  }
}

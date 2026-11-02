/**
 * The one interface the shell-command run registry (shell-command-runs.ts) drives.
 * Two implementations own the actual process:
 *
 * - in-app (shell-command-in-app-host.ts): a node-pty child of the Electron main
 *   process. Full terminal fidelity; dies with the app.
 * - detached (shell-command-detached-host.ts): a /bin/sh + script(1) process tree in
 *   its own session, with a FIFO for input and a log file for output. Survives the app
 *   quitting or being replaced; a later app instance can adopt it.
 *
 * The registry stays mode-agnostic: it owns the output buffer, the persisted state and
 * the published events, and routes write / resize / stop here.
 */
export type ShellCommandRunMode = 'in-app' | 'detached'

export type RunHostExit =
  | {
      kind: 'exited'
      /** 0-255. A shell killed by signal N is reported as 128 + N. */
      exitCode: number
      /** The signal that ended the shell, when the host knows it. */
      signal: number | null
      /** The host could not confirm the wrapper's own status (killed shell, log limit, ...). */
      abnormal: boolean
      reason?: 'output-limit'
    }
  /** The run's owner vanished without leaving a result: the run is 'interrupted'. */
  | { kind: 'lost' }

export interface RunHostSink {
  /** Decoded terminal output, in order. May be called synchronously from start(). */
  data(chunk: string): void
  /** Called at most once, after the last data() of the run. Never called after stop() resolved. */
  exit(exit: RunHostExit): void
}

export interface ShellCommandRunHost {
  readonly mode: ShellCommandRunMode
  /**
   * Spawn the run. Rejects with an Error whose message is safe to show the user (it
   * never contains script text) when the run cannot start; nothing is left running then.
   */
  start(): Promise<void>
  /** Keyboard input. Silently dropped once the run has ended. */
  write(data: string): void
  resize(cols: number, rows: number): void
  /**
   * Kill the whole process tree. The registry has ALREADY persisted 'cancelled';
   * whatever exit the dying tree reports afterwards is meaningless and is ignored.
   */
  stop(): Promise<void>
  /** Release fds, timers and listeners WITHOUT killing anything (app quit). */
  detach(): void
}

export interface ShellCommandRunHostOptions {
  sessionId: string
  /** <runs>/<sessionId>/<runId>; created by the host's start(). */
  runDir: string
  /** Absolute path of the worktree the command runs in. */
  cwd: string
  /** Runnable steps (parseShellCommandSteps of the session's script snapshot). Never logged. */
  steps: string[]
  /** Extra environment on top of the app's: user env vars + HIVE_*_PATH. */
  env: Record<string, string>
  cols: number
  rows: number
  sink: RunHostSink
}

/** The three ways the registry obtains a host; replaced by fakes in its unit tests. */
export interface ShellCommandRunHostFactories {
  createInApp(options: ShellCommandRunHostOptions): ShellCommandRunHost
  createDetached(options: ShellCommandRunHostOptions): ShellCommandRunHost
  /**
   * Take over a detached run that is already executing (started by an earlier app
   * lifetime). The returned host is live immediately: it replays the retained tail of
   * the run's log through sink.data, then follows it. start() must not be called on it.
   */
  adoptDetached(options: {
    sessionId: string
    runDir: string
    sink: RunHostSink
  }): ShellCommandRunHost
}

/** Environment variable names of the detached protocol. */
export const SHELL_RUN_DIR_ENV = 'HIVE_SHELL_RUN_DIR'
export const SHELL_LOG_LIMIT_ENV = 'HIVE_SHELL_LOG_LIMIT_BLOCKS'

/** Retained transcript and replay size, both modes. */
export const SHELL_COMMAND_LOG_CAP_BYTES = 5 * 1024 * 1024
/**
 * `ulimit -f` backstop for a detached run's log, in blocks: 256 MiB on macOS /bin/sh
 * (1024-byte blocks), 128 MiB under dash (512-byte blocks).
 */
export const DETACHED_LOG_LIMIT_BLOCKS = '262144'
/** Log poll interval; the exit file is checked every 5th tick, liveness every 20th. */
export const DETACHED_TAIL_POLL_MS = 50
/** How long start() waits for the host's ready marker (it appears within ~15 ms). */
export const DETACHED_READY_TIMEOUT_MS = 5000
/** Unreferenced, ownerless run directories are removed once they are this old. */
export const RUN_DIR_ORPHAN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** Size used until a view reports the real one. */
export const SHELL_COMMAND_DEFAULT_COLS = 80
export const SHELL_COMMAND_DEFAULT_ROWS = 24

/** Written at the top of a transcript whose beginning was dropped to honour the cap. */
export const SHELL_COMMAND_LOG_TRUNCATED_MARKER =
  '\x1b[2m[hive] Earlier output was truncated\x1b[0m\r\n'
/** Appended to the transcript when the user stops a run. */
export const SHELL_COMMAND_STOPPED_MARKER = '\r\n\x1b[1;33m[hive] Stopped\x1b[0m\r\n'
/** Appended to the transcript of an in-app run that died with the app. */
export const SHELL_COMMAND_INTERRUPTED_MARKER =
  '\r\n\x1b[1;33m[hive] Interrupted: the app quit while this command was running\x1b[0m\r\n'

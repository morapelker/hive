import { closeSync, constants, existsSync, openSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveDatabasePath } from '../db/database'

/**
 * On-disk layout of shell-command runs. Imported by the Electron main process
 * (run registry / hosts) and by the server child (session delete), so it must
 * stay free of Electron- and PTY-specific imports.
 *
 *   <data dir>/shell-command-runs/<sessionId>/<runId>/
 *     stdin        FIFO (0600). Detached runs: keyboard input; the run's host holds it open.
 *                  In-app runs: nobody writes to it; the app holds it open for the run's lifetime.
 *                  Either way "the FIFO has a reader" means "the run's owner is alive".
 *     output.log   raw terminal bytes (0600), capped by the app
 *     host.pid     detached only: the host's pid (= its process group id); ready marker
 *     inner        detached only: pid=<shell pid> / tty=<controlling tty>
 *     inner.exit   detached only: the wrapper's own exit status
 *     exit         detached only: script=<n> [wrapper=<n>]; existence means the log is complete
 *     feeder.pid   detached only: the stdin feeder's pid
 *     host.err     detached only: stderr of script(1)
 */
export const SHELL_COMMAND_RUNS_DIRNAME = 'shell-command-runs'

export const SHELL_COMMAND_RUN_FILES = {
  stdin: 'stdin',
  log: 'output.log',
  hostPid: 'host.pid',
  inner: 'inner',
  innerExit: 'inner.exit',
  exit: 'exit',
  feederPid: 'feeder.pid',
  hostErr: 'host.err'
} as const

const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** Session ids and run ids become directory names: letters, digits, '_' and '-' only. */
export function isValidShellCommandRunId(value: unknown): value is string {
  return typeof value === 'string' && RUN_ID_PATTERN.test(value)
}

/**
 * Lives beside the database whose session rows reference the runs, so the desktop
 * main process and its server child resolve the same directory (resolveDatabasePath
 * honours HIVE_DESKTOP_BASE_DIR and HIVE_SERVER_DB_PATH):
 * ~/.hive/shell-command-runs by default.
 */
export function getShellCommandRunsDir(): string {
  return join(dirname(resolveDatabasePath()), SHELL_COMMAND_RUNS_DIRNAME)
}

export function getShellCommandSessionRunsDir(sessionId: string): string {
  if (!isValidShellCommandRunId(sessionId)) throw new Error('Invalid shell command session id')
  return join(getShellCommandRunsDir(), sessionId)
}

export function getShellCommandRunDir(sessionId: string, runId: string): string {
  if (!isValidShellCommandRunId(runId)) throw new Error('Invalid shell command run id')
  return join(getShellCommandSessionRunsDir(sessionId), runId)
}

/**
 * True while the run's owner is alive: its FIFO has a reader. Works without any pid
 * bookkeeping (no pid reuse, survives the app being replaced) and for both kinds of
 * run. A non-blocking write-only open of a FIFO fails with ENXIO when nobody has it
 * open for reading, and with ENOENT when the run directory is gone. Probing never
 * writes, so it cannot disturb a command waiting for input. Windows has no FIFOs:
 * always false there.
 */
export function runHasLiveOwner(runDir: string): boolean {
  if (process.platform === 'win32') return false
  try {
    closeSync(
      openSync(
        join(runDir, SHELL_COMMAND_RUN_FILES.stdin),
        constants.O_WRONLY | constants.O_NONBLOCK
      )
    )
    return true
  } catch {
    return false
  }
}

/**
 * Removes every run directory of a deleted session, except runs whose owner is still
 * alive (a detached run that outlived its session row is stopped and removed by the
 * main process's sweep, never by pulling its files out from under it). Never throws.
 */
export function removeShellCommandSessionRunDirs(sessionId: string): void {
  try {
    if (!isValidShellCommandRunId(sessionId)) return
    const sessionDir = getShellCommandSessionRunsDir(sessionId)
    if (!existsSync(sessionDir)) return
    let kept = 0
    for (const entry of readdirSync(sessionDir, { withFileTypes: true })) {
      const runDir = join(sessionDir, entry.name)
      if (entry.isDirectory() && runHasLiveOwner(runDir)) {
        kept += 1
        continue
      }
      rmSync(runDir, { recursive: true, force: true })
    }
    if (kept === 0) rmSync(sessionDir, { recursive: true, force: true })
  } catch {
    // Best-effort: leftovers are removed by the main process's sweep.
  }
}

// The on-disk home of one Code Mode launch of the Claude CLI, and its clean-up (Code Mode
// T06; PRD LF-1, LF-6, LF-7, SEC-1, SEC-2, FR-14, SEC-7).
//
// A Code Mode session cannot go through the app's usage proxy, so the app reads rate-limit
// headers from the CLI's own debug log instead. Each launch of the CLI gets a directory of
// its own, because the log does not say which session wrote it and because the CLI drops
// files beside it (`usage.log.1` when it rotates, a `latest` link):
//
//   <data dir>/claude-cli-debug/<sessionId>-<app process>-<nonce>/
//     usage.log   empty; the CLI appends its debug log here (`--debug-file`)
//     env.sh      what the CLI runs before each shell command of the session (`CLAUDE_ENV_FILE`)
//
//   prepare  creates that directory for a launch about to start, or refuses.
//   remove   deletes one launch's directory with everything in it (the session ended).
//   sweep    deletes what a crash left behind: the directories of app processes that are no
//            longer running, and of this one's sessions that are not alive.
//
// The log can hold whatever the CLI's SDK prints at debug level, so the directory is for the
// current user only (0700, files 0600) and never in a shared place: the CLI follows a
// symbolic link at the log path, and in a directory someone else can write to, that would let
// them point the log at any file of the user. For the same reason nothing that already exists
// is ever adopted: prepare creates every piece itself, exclusively, or refuses.
//
// The app process is part of the name because two apps can run on one data directory (a
// development build next to the installed app): each sweeps after itself and after processes
// that are gone, never under one that is running (as terminal-pasted-images.ts does).
//
// Everything here is synchronous. A launch is prepared before its PTY exists, and a sweep that
// could be interleaved with a prepare would have to guess whether a directory it listed is
// about to be used. The work is a handful of system calls.
//
// Called from the session lifecycle (claude-cli-usage-launches.ts).
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  writeSync,
  type Stats
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { resolveDatabasePath } from '../db/database'
import { createLogger } from './logger'

const log = createLogger({ component: 'ClaudeCliDebugDir' })

export const CLAUDE_CLI_DEBUG_DIRNAME = 'claude-cli-debug'
/** The file the CLI is told to write its debug log to. */
export const CLAUDE_CLI_DEBUG_LOG_FILENAME = 'usage.log'
/** The file whose text the CLI is told to run before each shell command. */
export const CLAUDE_CLI_DEBUG_ENV_FILENAME = 'env.sh'
/**
 * The variable that turns on the SDK's debug output in the CLI. Every command the session
 * runs would inherit it, and a script using an Anthropic SDK would then print its requests,
 * prompts included: the environment file takes it out again.
 */
export const CLAUDE_CLI_DEBUG_VARIABLE = 'ANTHROPIC_LOG'

const DIR_MODE = 0o700
const FILE_MODE = 0o600

/** Session ids become part of directory names: letters, digits, '_' and '-' only. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
/** So do the ids of app processes. No '-': it separates the parts of a directory name. */
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9_]{1,32}$/
const NONCE_PATTERN = /^[0-9a-f]{16}$/
/**
 * `<sessionId>-<app process>-<nonce>`. A session id can hold '-' itself, the other two parts
 * cannot, so a name reads one way only: from its end.
 */
const LAUNCH_DIR_PATTERN = /^([A-Za-z0-9_-]{1,128})-([A-Za-z0-9_]{1,32})-([0-9a-f]{16})$/

/** The prepared files of one launch: what its arguments, its log follower and its clean-up need. */
export interface ClaudeCliDebugLaunch {
  readonly sessionId: string
  /** The launch's own directory. */
  readonly dir: string
  /** `usage.log` in it: exists, empty. For `--debug-file`. */
  readonly logFile: string
  /** `env.sh` in it. For `CLAUDE_ENV_FILE`. */
  readonly envFile: string
}

export interface ClaudeCliDebugPrepareOptions {
  /**
   * The `CLAUDE_ENV_FILE` the session would have had without the app's (the user's own
   * setting). The app's file sources it first, so it still takes effect.
   */
  readonly userEnvFile?: string | null
  /**
   * The directory the CLI starts in. A relative `userEnvFile` is read from there, as the CLI
   * would have read it. Without it, a relative one is read from wherever a command runs.
   */
  readonly cwd?: string
}

export interface ClaudeCliDebugDirsOptions {
  /** `<data dir>/claude-cli-debug`. Null: nothing is ever prepared, removed or swept. */
  readonly root: string | null
  /** This app process: part of the names of its directories. Defaults to its pid. */
  readonly instanceId?: string
  /** Whether the app process that made the directories of `instanceId` is still running. */
  readonly isInstanceAlive?: (instanceId: string) => boolean
  readonly platform?: NodeJS.Platform
  /** The random part of a directory name: 16 lowercase hex digits (tests). */
  readonly nonce?: () => string
}

/** A path as one word of a POSIX shell, whatever it contains. */
const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

/**
 * The text of a launch's `env.sh`: the user's own file first, then the `unset`. Theirs keeps
 * its effects, and the debug variable is gone even if theirs sets it.
 *
 * The CLI (2.1) does not source the file. It reads it once and puts its text in front of
 * every shell command of the session, in bash or zsh, on the command line itself. So the
 * text is as short as it can be and holds no comment (it shows wherever the command line
 * does), it prints nothing, and it never says `return` or `exit` (that would end the command
 * it is in front of). The user's file is sourced from where it is rather than copied in:
 * what it holds stays out of the command line, and a file that does not exist is skipped, as
 * the CLI would have skipped it.
 */
export const claudeCliDebugEnvFileContent = (userEnvFile?: string | null, cwd?: string): string => {
  const lines: string[] = []
  const user = userEnvFile ?? ''
  if (user.trim() !== '') {
    // `.` looks a name without a '/' up on the PATH, and reads one starting with '-' as an
    // option: a path that stays relative is made to say that it is one.
    const path = isAbsolute(user) ? user : cwd ? resolve(cwd, user) : `./${user}`
    const quoted = shellQuote(path)
    lines.push(`if [ -f ${quoted} ]; then . ${quoted}; fi`)
  }
  lines.push(`unset ${CLAUDE_CLI_DEBUG_VARIABLE}`, '')
  return lines.join('\n')
}

/** Whether a process with this pid exists (`EPERM`: it does, and belongs to someone else). */
const isProcessAlive = (instanceId: string): boolean => {
  const pid = Number(instanceId)
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const lstatOrNull = (path: string): Stats | null => {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** A refusal: something on disk is not what prepare would have made itself. */
class Unexpected extends Error {}

export class ClaudeCliDebugDirs {
  private readonly root: string | null
  private readonly instanceId: string
  private readonly isInstanceAlive: (instanceId: string) => boolean
  private readonly platform: NodeJS.Platform
  private readonly nonce: () => string

  constructor(options: ClaudeCliDebugDirsOptions) {
    this.root = options.root
    this.instanceId = options.instanceId ?? String(process.pid)
    if (!INSTANCE_ID_PATTERN.test(this.instanceId)) throw new Error('Invalid instance id')
    this.isInstanceAlive = options.isInstanceAlive ?? isProcessAlive
    this.platform = options.platform ?? process.platform
    this.nonce = options.nonce ?? ((): string => randomBytes(8).toString('hex'))
  }

  /**
   * Create the directory of a launch about to start, with its empty log and its environment
   * file. Every call makes a new directory: a session that is started again shares nothing
   * with its earlier process.
   *
   * Null when there is none: on Windows (no owner-only modes, and the file is for a POSIX
   * shell), without a place to keep it, for an id that cannot name a directory, or when
   * anything on the way is not what this module would have made (a link, a file, a directory
   * that is already there, one that others can read). Nothing that already existed is changed
   * or removed, and nothing of a refused launch is left behind. The caller starts the session
   * without the debug log.
   */
  prepare(
    sessionId: string,
    options: ClaudeCliDebugPrepareOptions = {}
  ): ClaudeCliDebugLaunch | null {
    if (this.platform === 'win32' || !this.root) return null
    if (!SESSION_ID_PATTERN.test(sessionId)) return null
    // The directory this call has made, to take back if it cannot finish.
    let created: string | null = null
    try {
      const nonce = this.nonce()
      if (!NONCE_PATTERN.test(nonce)) throw new Unexpected('the launch nonce is malformed')
      this.ensureRoot(this.root)
      const dir = join(this.root, `${sessionId}-${this.instanceId}-${nonce}`)
      // The name is new every time, so whatever is here was put here by someone else.
      if (lstatOrNull(dir)) throw new Unexpected('the launch directory already exists')
      // Not recursive: it fails rather than adopt something that appeared since the look.
      mkdirSync(dir, { mode: DIR_MODE })
      created = dir
      // The mode given to mkdir is cut down by the umask, never widened; this makes it exact.
      chmodSync(dir, DIR_MODE)
      this.assertPrivateDir(dir, 'the launch directory')
      const logFile = join(dir, CLAUDE_CLI_DEBUG_LOG_FILENAME)
      const envFile = join(dir, CLAUDE_CLI_DEBUG_ENV_FILENAME)
      this.createFile(logFile, '')
      this.createFile(envFile, claudeCliDebugEnvFileContent(options.userEnvFile, options.cwd))
      return { sessionId, dir, logFile, envFile }
    } catch (error) {
      if (created) this.discard(created)
      log.warn('Could not prepare the debug-log directory; the session starts without it', {
        sessionId,
        error: errorText(error)
      })
      return null
    }
  }

  /**
   * Delete a launch's directory and everything in it: the log, what the CLI and the log
   * follower put beside it (`usage.log.1`, `usage.log.old`, the `latest` link, which is
   * removed and not followed). Safe to call again, and for a directory that is already gone.
   * Never throws.
   *
   * For after the CLI's process has ended: one that still runs makes the directory again on
   * its next log line, and not a private one.
   */
  remove(launch: Pick<ClaudeCliDebugLaunch, 'dir'>): void {
    if (!this.root) return
    // Only ever a launch directory of this root, whatever the caller kept in `dir`.
    const dir = resolve(launch.dir)
    if (dirname(dir) !== resolve(this.root) || !LAUNCH_DIR_PATTERN.test(basename(dir))) {
      log.warn('Refused to remove a path that is not a debug-log directory', { dir: launch.dir })
      return
    }
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (error) {
      log.warn('Could not remove a debug-log directory', {
        dir: basename(dir),
        error: errorText(error)
      })
    }
  }

  /**
   * Delete the launch directories that no running session can be using, given the ids of the
   * sessions of this app process that are alive: every directory of this app process whose
   * session is not among them, and every directory of an app process that is no longer
   * running. Directories of another app process that is running are left to it. Anything in
   * the root that is not a launch directory is ignored.
   *
   * `liveSessionIds` must include a session whose launch has been prepared and whose process
   * is about to start: its directory exists before its PTY does.
   *
   * Never throws.
   */
  sweep(liveSessionIds: ReadonlySet<string>): void {
    if (!this.root) return
    try {
      // A root that is a link is not this module's: nothing is deleted through it.
      const root = lstatOrNull(this.root)
      if (!root || !root.isDirectory()) return
      for (const entry of readdirSync(this.root, { withFileTypes: true })) {
        const match = LAUNCH_DIR_PATTERN.exec(entry.name)
        if (!match || !entry.isDirectory()) continue
        const [, sessionId, instanceId] = match
        const inUse =
          instanceId === this.instanceId
            ? liveSessionIds.has(sessionId)
            : this.isInstanceAlive(instanceId)
        if (inUse) continue
        try {
          rmSync(join(this.root, entry.name), { recursive: true, force: true })
        } catch (error) {
          log.warn('Could not sweep a debug-log directory', {
            dir: entry.name,
            error: errorText(error)
          })
        }
      }
    } catch (error) {
      log.warn('Could not sweep the debug-log directories', { error: errorText(error) })
    }
  }

  /**
   * The root exists and is a directory only the current user can enter, or this throws. It
   * is made when it is missing; the data directory it is in is not.
   */
  private ensureRoot(root: string): void {
    if (!lstatOrNull(root)) {
      try {
        mkdirSync(root, { mode: DIR_MODE })
        chmodSync(root, DIR_MODE)
      } catch (error) {
        // Another app process on this data directory made it meanwhile: looked at below.
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    this.assertPrivateDir(root, 'the debug-log root')
  }

  /** Throws unless `path` is a real directory of the current user that no one else can use. */
  private assertPrivateDir(path: string, what: string): void {
    const info = lstatSync(path)
    if (!info.isDirectory()) throw new Unexpected(`${what} is not a directory`)
    const uid = process.getuid?.()
    if (uid !== undefined && info.uid !== uid) throw new Unexpected(`${what} has another owner`)
    if ((info.mode & 0o777) !== DIR_MODE) throw new Unexpected(`${what} is not private`)
  }

  /**
   * A new file for the current user only. Fails when anything is at the path, a link
   * included: nothing is opened that this call did not create.
   */
  private createFile(path: string, content: string): void {
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
    const fd = openSync(path, flags, FILE_MODE)
    try {
      // As for the directory: exact, whatever the umask.
      fchmodSync(fd, FILE_MODE)
      if (content !== '') writeSync(fd, content)
    } finally {
      closeSync(fd)
    }
  }

  /**
   * Take back a directory a prepare made and could not finish. It was made by that call and
   * is the current user's alone, so everything in it is that call's too.
   */
  private discard(dir: string): void {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // The sweep takes what is left.
    }
  }
}

/** `<data dir>/claude-cli-debug`, beside the database (`~/.hive/claude-cli-debug` by default). */
export const getClaudeCliDebugRootDir = (): string =>
  join(dirname(resolveDatabasePath()), CLAUDE_CLI_DEBUG_DIRNAME)

let defaultDirs: ClaudeCliDebugDirs | null = null

/**
 * The app's debug-log directories, kept beside its database (the instance's own data
 * directory for an isolated one). A test run has none unless a test builds its own: nothing
 * is written to, or swept from, the developer's data by a unit test.
 */
export function claudeCliDebugDirs(): ClaudeCliDebugDirs {
  if (!defaultDirs) {
    let root: string | null = null
    if (!process.env.VITEST) {
      try {
        root = getClaudeCliDebugRootDir()
      } catch {
        root = null
      }
    }
    defaultDirs = new ClaudeCliDebugDirs({ root })
  }
  return defaultDirs
}

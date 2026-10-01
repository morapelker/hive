import { execFile } from 'child_process'
import { access, constants } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { createLogger } from '../logger'

const log = createLogger({ component: 'FindExecutable' })

const LOOKUP_TIMEOUT_MS = 5000
const DEFAULT_VERSION_TIMEOUT_MS = 5000

export type ExecResult = { stdout: string; stderr: string }

export type ExecError = Error & { code?: number | string; killed?: boolean; stdout?: string }

/** `execFile` as a promise that resolves with both streams and rejects with Node's error. */
export function execFileText(
  file: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        timeout: opts.timeout ?? LOOKUP_TIMEOUT_MS,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) {
          const failure = error as ExecError
          failure.stdout = String(stdout ?? '')
          reject(failure)
          return
        }
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      }
    )
  })
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function firstExecutable(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (candidate && (await isExecutable(candidate))) return candidate
  }
  return null
}

const splitLines = (raw: string): string[] =>
  raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

const WINDOWS_EXECUTABLE_EXTENSIONS = ['.cmd', '.exe', '.bat']

/**
 * `where` lists every match on PATH, extensionless sh shims included (npm writes
 * both `tool` and `tool.cmd`). Only the .cmd/.exe/.bat ones can be spawned, so put
 * those first. A no-op elsewhere.
 */
function preferWindowsShims(lines: string[]): string[] {
  if (process.platform !== 'win32') return lines
  const spawnable = (line: string): boolean =>
    WINDOWS_EXECUTABLE_EXTENSIONS.some((ext) => line.toLowerCase().endsWith(ext))
  return [...lines.filter(spawnable), ...lines.filter((line) => !spawnable(line))]
}

/** Directories user-level installers put binaries in, for when PATH misses them. */
export function knownBinDirs(home: string = homedir()): string[] {
  if (process.platform === 'win32') return []
  return [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
}

/**
 * Locate an executable the way a terminal would: `which` against the backend's
 * (login-shell) PATH, then the login shell's own `command -v`, then the handful
 * of user-level bin directories installers use. Never throws.
 */
export async function findExecutable(
  name: string,
  opts: { env?: NodeJS.ProcessEnv; home?: string } = {}
): Promise<string | null> {
  const env = opts.env ?? process.env
  const lookupCommand = process.platform === 'win32' ? 'where' : 'which'

  try {
    const { stdout } = await execFileText(lookupCommand, [name], { env })
    const found = await firstExecutable(preferWindowsShims(splitLines(stdout)))
    if (found) return found
  } catch {
    // not on PATH
  }

  if (process.platform !== 'win32') {
    const shell = env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
    try {
      const { stdout } = await execFileText(shell, ['-lc', `command -v ${name}`], { env })
      const found = await firstExecutable(splitLines(stdout).filter((line) => line.includes('/')))
      if (found) return found
    } catch (error) {
      log.debug('login shell lookup failed', {
        name,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  return firstExecutable(knownBinDirs(opts.home).map((dir) => join(dir, name)))
}

/**
 * Parse a version out of `--version` output: "0.1.19", "tcu 0.2.0", "v1.2.3-rc.1"...
 * Returns null when nothing version-like is printed.
 */
export function parseVersionOutput(output: string): string | null {
  const firstLine = output.trim().split(/\r?\n/)[0]?.trim() ?? ''
  const match = firstLine.match(/(\d+\.\d+\.\d+[\w.-]*)/)
  return match ? match[1] : null
}

export type VersionProbe = {
  version: string | null
  /** The binary did not answer in time — on macOS usually a quarantined download. */
  timedOut: boolean
  error?: string
}

/** Run `<binary> --version` with a timeout. Never throws. */
export async function probeVersion(
  binaryPath: string,
  opts: { args?: string[]; env?: NodeJS.ProcessEnv; timeout?: number } = {}
): Promise<VersionProbe> {
  try {
    const { stdout, stderr } = await execFileText(binaryPath, opts.args ?? ['--version'], {
      env: { ...(opts.env ?? process.env), NO_UPDATE_NOTIFIER: '1' },
      timeout: opts.timeout ?? DEFAULT_VERSION_TIMEOUT_MS
    })
    return { version: parseVersionOutput(stdout) ?? parseVersionOutput(stderr), timedOut: false }
  } catch (error) {
    const failure = error as ExecError
    const timedOut = failure.killed === true || failure.code === 'ETIMEDOUT'
    // Some tools print the version and still exit non-zero; take it when present.
    const version = failure.stdout ? parseVersionOutput(failure.stdout) : null
    return { version, timedOut, error: failure.message }
  }
}

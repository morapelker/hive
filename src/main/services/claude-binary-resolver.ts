import { execFile, execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { realpath, stat } from 'fs/promises'
import { createLogger } from './logger'

const log = createLogger({ component: 'ClaudeBinaryResolver' })

/** Binary paths whose version has already been logged this app run. */
const versionLoggedPaths = new Set<string>()

/** The version each binary reported this app run, once it has answered. */
const versionByPath = new Map<string, string>()

/** `2.1.326 (Claude Code)` is `2.1.326`; output without a version number is kept as it is. */
function versionFromOutput(output: string): string | null {
  const firstLine = output.trim().split('\n')[0]?.trim() ?? ''
  if (firstLine === '') return null
  return firstLine.match(/\d+\.\d+\.\d+[\w.-]*/)?.[0] ?? firstLine.slice(0, 64)
}

/**
 * Log the `claude --version` output for a resolved binary, once per path per
 * app run. Async and fire-and-forget so it never delays a spawn. Diagnostic
 * for machines where the embedded claude-cli renders differently: version
 * skew across installs is a prime suspect. The version is remembered for
 * `getClaudeBinaryVersion`.
 */
export function logClaudeBinaryVersion(binaryPath: string): void {
  if (versionLoggedPaths.has(binaryPath)) return
  versionLoggedPaths.add(binaryPath)

  execFile(binaryPath, ['--version'], { encoding: 'utf-8', timeout: 5000 }, (error, stdout) => {
    if (error) {
      log.warn('Could not determine Claude CLI version', {
        path: binaryPath,
        error: error.message
      })
      return
    }
    const version = versionFromOutput(stdout)
    if (version !== null) versionByPath.set(binaryPath, version)
    log.info('Claude CLI version', { path: binaryPath, version: stdout.trim() })
  })
}

/**
 * The version of a binary `logClaudeBinaryVersion` was called for, or null
 * when it has not answered (yet) or could not be asked. Never runs anything.
 */
export function getClaudeBinaryVersion(binaryPath: string): string | null {
  return versionByPath.get(binaryPath) ?? null
}

/** The file a path leads to and what tells one build of it from the next, without running it. */
async function binaryIdentity(binaryPath: string): Promise<string | null> {
  try {
    const target = await realpath(binaryPath)
    const { size, mtimeMs } = await stat(target)
    return `${target}\n${size}\n${mtimeMs}`
  } catch {
    return null
  }
}

/** The answer of each binary as it was on disk when it was last asked. */
const versionByIdentity = new Map<string, { identity: string; version: Promise<string | null> }>()

function askClaudeBinaryVersion(binaryPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(binaryPath, ['--version'], { encoding: 'utf-8', timeout: 5000 }, (error, stdout) => {
      if (error) {
        log.warn('Could not determine Claude CLI version', {
          path: binaryPath,
          error: error.message
        })
        resolve(null)
        return
      }
      resolve(versionFromOutput(stdout))
    })
  })
}

/**
 * The version of the binary at `binaryPath` as it is on disk now, or null when it cannot be
 * told. The CLI updates itself while the app runs, at the same path, so the binary is asked
 * again whenever the file the path leads to is another one or has changed, and only then:
 * otherwise this costs two file lookups. A version it finds is what `getClaudeBinaryVersion`
 * answers from then on. Never rejects.
 *
 * A wrapper script that picks the real binary by other means looks unchanged here when the
 * binary behind it is updated; such a path keeps the version it first gave until the app
 * restarts.
 */
export async function readClaudeBinaryVersion(binaryPath: string): Promise<string | null> {
  const identity = await binaryIdentity(binaryPath)
  if (identity === null) return null
  const known = versionByIdentity.get(binaryPath)
  if (known?.identity === identity) return known.version
  const version = askClaudeBinaryVersion(binaryPath).then((found) => {
    if (versionByIdentity.get(binaryPath)?.version === version) {
      if (found !== null) versionByPath.set(binaryPath, found)
      // An answer that did not come is asked for again by the next caller.
      else versionByIdentity.delete(binaryPath)
    }
    return found
  })
  versionByIdentity.set(binaryPath, { identity, version })
  return version
}

/** Tests only: forget every version asked for so far. */
export function __resetClaudeBinaryVersionsForTests(): void {
  versionLoggedPaths.clear()
  versionByPath.clear()
  versionByIdentity.clear()
}

/**
 * Resolve the system-wide Claude Code binary path.
 *
 * Must be called AFTER loadShellEnv() so the full shell PATH is available
 * (macOS GUI apps don't inherit shell PATH by default).
 *
 * When the app is packaged into an ASAR archive, the SDK's bundled cli.js
 * cannot be spawned as a child process. Pointing the SDK at the system
 * binary sidesteps this entirely.
 */
export function resolveClaudeBinaryPath(): string | null {
  const command = process.platform === 'win32' ? 'where' : 'which'
  const binary = process.platform === 'win32' ? 'claude.exe' : 'claude'

  try {
    const result = execFileSync(command, [binary], {
      encoding: 'utf-8',
      timeout: 5000,
      // Inherit the (loadShellEnv-corrected) environment
      env: process.env
    }).trim()

    // `which` can return multiple lines on some systems; take the first
    const resolvedPath = result.split('\n')[0].trim()

    if (!resolvedPath || !existsSync(resolvedPath)) {
      log.warn('Claude binary not found on PATH')
      return null
    }

    log.info('Resolved Claude binary', { path: resolvedPath })
    return resolvedPath
  } catch {
    log.warn('Could not resolve Claude binary (not installed or not on PATH)')
    return null
  }
}

import { execFile, execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { createLogger } from './logger'

const log = createLogger({ component: 'ClaudeBinaryResolver' })

/** Binary paths whose version has already been logged this app run. */
const versionLoggedPaths = new Set<string>()

/**
 * Log the `claude --version` output for a resolved binary, once per path per
 * app run. Async and fire-and-forget so it never delays a spawn. Diagnostic
 * for machines where the embedded claude-cli renders differently: version
 * skew across installs is a prime suspect.
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
    log.info('Claude CLI version', { path: binaryPath, version: stdout.trim() })
  })
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

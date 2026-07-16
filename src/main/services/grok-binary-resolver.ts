import { execFile, execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { createLogger } from './logger'

const log = createLogger({ component: 'GrokBinaryResolver' })

/** Binary paths whose version has already been logged this app run. */
const versionLoggedPaths = new Set<string>()

/**
 * Log the `grok --version` output for a resolved binary, once per path per app
 * run. Async and fire-and-forget so it never delays a spawn — grok's hook and
 * flag surface moves fast, so version skew is the first suspect when a session
 * misbehaves on another machine.
 */
export function logGrokBinaryVersion(binaryPath: string): void {
  if (versionLoggedPaths.has(binaryPath)) return
  versionLoggedPaths.add(binaryPath)

  execFile(binaryPath, ['--version'], { encoding: 'utf-8', timeout: 5000 }, (error, stdout) => {
    if (error) {
      log.warn('Could not determine Grok CLI version', {
        path: binaryPath,
        error: error.message
      })
      return
    }
    log.info('Grok CLI version', { path: binaryPath, version: stdout.trim() })
  })
}

/**
 * Resolve the system-wide Grok Build CLI binary path.
 *
 * Must be called AFTER loadShellEnv() so the full shell PATH is available
 * (macOS GUI apps don't inherit shell PATH by default).
 */
export function resolveGrokBinaryPath(): string | null {
  const command = process.platform === 'win32' ? 'where' : 'which'
  const binary = process.platform === 'win32' ? 'grok.exe' : 'grok'

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
      log.warn('Grok binary not found on PATH')
      return null
    }

    log.info('Resolved Grok binary', { path: resolvedPath })
    return resolvedPath
  } catch {
    log.warn('Could not resolve Grok binary (not installed or not on PATH)')
    return null
  }
}

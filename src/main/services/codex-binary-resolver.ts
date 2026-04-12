import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { createLogger } from './logger'

const log = createLogger({ component: 'CodexBinaryResolver' })

/**
 * Resolve the system-wide Codex CLI binary path.
 *
 * Must be called AFTER loadShellEnv() so the full shell PATH is available.
 * This mirrors the Claude production fix path: resolve the real system
 * binary once and inject it into every child-process spawn site.
 */
export function resolveCodexBinaryPath(): string | null {
  const command = process.platform === 'win32' ? 'where' : 'which'
  const binary = process.platform === 'win32' ? 'codex.exe' : 'codex'

  try {
    const result = execFileSync(command, [binary], {
      encoding: 'utf-8',
      timeout: 5000,
      env: process.env
    }).trim()

    const resolvedPath = result.split('\n')[0].trim()

    if (!resolvedPath || !existsSync(resolvedPath)) {
      log.warn('Codex binary not found on PATH')
      return null
    }

    log.info('Resolved Codex binary', { path: resolvedPath })
    return resolvedPath
  } catch {
    log.warn('Could not resolve Codex binary (not installed or not on PATH)')
    return null
  }
}

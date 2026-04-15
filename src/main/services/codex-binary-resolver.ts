import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { extname } from 'path'
import { createLogger } from './logger'

const log = createLogger({ component: 'CodexBinaryResolver' })
const codexAppServerSupportCache = new Map<string, boolean>()

function splitResolvedPaths(result: string): string[] {
  return result
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function compareWindowsCodexCandidates(a: string, b: string): number {
  const rank = (candidate: string): number => {
    const normalized = candidate.toLowerCase()
    const extension = extname(candidate).toLowerCase()
    const isWindowsApps = normalized.includes('\\windowsapps\\')
    if (isWindowsApps) return 10
    if (extension === '.exe') return 0
    if (extension === '.cmd') return 1
    if (extension === '.bat' || extension === '.com') return 2
    return 3
  }

  return rank(a) - rank(b)
}

function usesShellForCodexBinary(binaryPath: string): boolean {
  const extension = extname(binaryPath).toLowerCase()
  return (
    process.platform === 'win32' &&
    (extension === '.cmd' || extension === '.bat' || extension === '.com')
  )
}

/**
 * Resolve the system-wide Codex CLI binary path.
 *
 * Must be called AFTER loadShellEnv() so the full shell PATH is available.
 * This mirrors the Claude production fix path: resolve the real system
 * binary once and inject it into every child-process spawn site.
 */
export function resolveCodexBinaryPath(): string | null {
  const command = process.platform === 'win32' ? 'where' : 'which'
  const binary = 'codex'

  try {
    const result = execFileSync(command, [binary], {
      encoding: 'utf-8',
      timeout: 5000,
      env: process.env
    }).trim()

    const resolvedPaths = splitResolvedPaths(result)
    const orderedPaths =
      process.platform === 'win32'
        ? [...resolvedPaths].sort(compareWindowsCodexCandidates)
        : resolvedPaths
    const resolvedPath = orderedPaths.find((candidate) => existsSync(candidate)) ?? null

    if (!resolvedPath) {
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

export function supportsCodexAppServer(binaryPath: string): boolean {
  const cached = codexAppServerSupportCache.get(binaryPath)
  if (cached !== undefined) {
    return cached
  }

  try {
    const output = execFileSync(binaryPath, ['app-server', '--help'], {
      encoding: 'utf-8',
      timeout: 5000,
      env: process.env,
      shell: usesShellForCodexBinary(binaryPath)
    })
    const supported = output.includes('Usage: codex app-server')
    codexAppServerSupportCache.set(binaryPath, supported)
    return supported
  } catch {
    codexAppServerSupportCache.set(binaryPath, false)
    return false
  }
}

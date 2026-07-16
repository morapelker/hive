import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { extname } from 'path'
import { createLogger } from './logger'

const log = createLogger({ component: 'CodexBinaryResolver' })
const codexAppServerSupportCache = new Map<string, boolean>()
const codexHookSupportCache = new Map<string, boolean>()

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

function isBareCommand(binaryPath: string): boolean {
  return !binaryPath.includes('/') && !binaryPath.includes('\\')
}

function stringifyProbeOutput(output: unknown): string {
  if (Buffer.isBuffer(output)) {
    return output.toString('utf-8')
  }
  if (typeof output === 'string') {
    return output
  }
  return ''
}

function hasCodexAppServerUsage(output: string): boolean {
  return /Usage:\s*codex\s+app-server\b/i.test(output)
}

/**
 * The codex-cli provider injects `--dangerously-bypass-hook-trust` (and the
 * `--enable hooks` / `-c hooks.*` overrides) on every spawn. An older codex
 * that predates the hooks surface rejects those flags and the session fails to
 * start, so hook-trust support is the capability gate for offering codex-cli.
 */
function hasCodexHookTrustFlag(output: string): boolean {
  return /--dangerously-bypass-hook-trust\b/.test(output)
}

function firstExistingPath(paths: string[]): string | null {
  return paths.find((candidate) => existsSync(candidate)) ?? null
}

function orderResolvedPaths(paths: string[]): string[] {
  return process.platform === 'win32'
    ? [...paths].sort(compareWindowsCodexCandidates)
    : paths
}

function readCodexFromPath(): string | null {
  const command = process.platform === 'win32' ? 'where' : 'which'
  const result = execFileSync(command, ['codex'], {
    encoding: 'utf-8',
    timeout: 5000,
    env: process.env
  }).trim()

  return firstExistingPath(orderResolvedPaths(splitResolvedPaths(result)))
}

function readCodexFromLoginShell(): string | null {
  if (process.platform === 'win32') return null

  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  const result = execFileSync(shell, ['-lc', 'command -v codex'], {
    encoding: 'utf-8',
    timeout: 5000,
    env: process.env
  }).trim()

  return firstExistingPath(splitResolvedPaths(result))
}

function readKnownCodexLocations(): string | null {
  if (process.platform === 'win32') return null

  const home = homedir()
  return firstExistingPath([
    `${home}/Applications/Codex.app/Contents/Resources/codex`,
    '/Applications/Codex.app/Contents/Resources/codex',
    `${home}/.local/share/mise/shims/codex`,
    `${home}/.local/bin/codex`,
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex'
  ])
}

/**
 * Resolve the system-wide Codex CLI binary path.
 *
 * Must be called AFTER loadShellEnv() so the full shell PATH is available.
 * This mirrors the Claude production fix path: resolve the real system
 * binary once and inject it into every child-process spawn site.
 */
export function resolveCodexBinaryPath(): string | null {
  const attempts: Array<[source: string, read: () => string | null]> = [
    ['PATH', readCodexFromPath],
    ['login shell', readCodexFromLoginShell],
    ['known locations', readKnownCodexLocations]
  ]

  for (const [source, read] of attempts) {
    try {
      const resolvedPath = read()
      if (resolvedPath) {
        log.info('Resolved Codex binary', { path: resolvedPath, source })
        return resolvedPath
      }
    } catch (error) {
      log.debug('Codex binary lookup failed', {
        source,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  log.warn('Could not resolve Codex binary (not installed or not on PATH)')
  return null
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
    const supported = hasCodexAppServerUsage(output)
    if (supported || !isBareCommand(binaryPath)) {
      codexAppServerSupportCache.set(binaryPath, supported)
    }
    return supported
  } catch (error) {
    const output = [
      stringifyProbeOutput((error as { stdout?: unknown }).stdout),
      stringifyProbeOutput((error as { stderr?: unknown }).stderr)
    ].join('\n')
    const supported = hasCodexAppServerUsage(output)
    if (supported) {
      codexAppServerSupportCache.set(binaryPath, true)
      return true
    }
    if (!isBareCommand(binaryPath)) {
      codexAppServerSupportCache.set(binaryPath, false)
    }
    return false
  }
}

/**
 * Whether this codex binary supports the hook flags the codex-cli provider
 * injects (see hasCodexHookTrustFlag). Probes `codex --help` and looks for
 * `--dangerously-bypass-hook-trust`. Same caching/shell/error-output handling
 * as supportsCodexAppServer.
 */
export function supportsCodexCliHooks(binaryPath: string): boolean {
  const cached = codexHookSupportCache.get(binaryPath)
  if (cached !== undefined) {
    return cached
  }

  try {
    const output = execFileSync(binaryPath, ['--help'], {
      encoding: 'utf-8',
      timeout: 5000,
      env: process.env,
      shell: usesShellForCodexBinary(binaryPath)
    })
    const supported = hasCodexHookTrustFlag(output)
    if (supported || !isBareCommand(binaryPath)) {
      codexHookSupportCache.set(binaryPath, supported)
    }
    return supported
  } catch (error) {
    const output = [
      stringifyProbeOutput((error as { stdout?: unknown }).stdout),
      stringifyProbeOutput((error as { stderr?: unknown }).stderr)
    ].join('\n')
    const supported = hasCodexHookTrustFlag(output)
    if (supported) {
      codexHookSupportCache.set(binaryPath, true)
      return true
    }
    if (!isBareCommand(binaryPath)) {
      codexHookSupportCache.set(binaryPath, false)
    }
    return false
  }
}

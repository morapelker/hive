import { execFile } from 'node:child_process'

import { createLogger } from './logger'

const log = createLogger({ component: 'CodexHealth' })

export interface CodexHealthStatus {
  available: boolean
  version?: string
  authStatus: 'authenticated' | 'unauthenticated' | 'unknown'
  message?: string
}

const EXEC_TIMEOUT_MS = 5000

/**
 * Run a command and return stdout, or throw on error/timeout.
 */
function execCommand(cmd: string, args: string[], timeoutMs = EXEC_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, encoding: 'utf-8' }, (error, stdout) => {
      if (error) {
        reject(error)
      } else {
        resolve(stdout)
      }
    })
  })
}

/**
 * Run `codex --version` and return the parsed version string.
 * Returns null if codex is not installed or the command fails.
 */
export async function getCodexVersion(): Promise<string | null> {
  try {
    const output = await execCommand('codex', ['--version'])
    return parseVersionOutput(output)
  } catch (error) {
    log.debug('codex --version failed', { error })
    return null
  }
}

/**
 * Parse the output of `codex --version` into a clean version string.
 * Handles formats like "codex 1.2.3", "1.2.3", "codex/1.2.3", etc.
 */
export function parseVersionOutput(output: string): string | null {
  const trimmed = output.trim()
  if (!trimmed) return null

  // Try "codex X.Y.Z" or "codex/X.Y.Z"
  const prefixed = trimmed.match(/codex[\s/]+(\S+)/i)
  if (prefixed) return prefixed[1]

  // Try bare version string (first line)
  const firstLine = trimmed.split('\n')[0].trim()
  const versionMatch = firstLine.match(/(\d+\.\d+\.\d+[\w.-]*)/)
  if (versionMatch) return versionMatch[1]

  // Return the raw first line if nothing else matched
  return firstLine || null
}

/**
 * Parse the output of `codex login status` to determine authentication state.
 */
export function parseAuthOutput(output: string): 'authenticated' | 'unauthenticated' {
  const lower = output.toLowerCase()

  // Unauthenticated indicators
  const unauthPatterns = [
    'not logged in',
    'login required',
    'run codex login',
    'unauthenticated',
    'not authenticated'
  ]
  for (const pattern of unauthPatterns) {
    if (lower.includes(pattern)) {
      return 'unauthenticated'
    }
  }

  // Try parsing as JSON for structured output
  try {
    const json = JSON.parse(output.trim())
    if (json.authenticated === true || json.isAuthenticated === true || json.loggedIn === true) {
      return 'authenticated'
    }
    if (json.authenticated === false || json.isAuthenticated === false || json.loggedIn === false) {
      return 'unauthenticated'
    }
  } catch {
    // Not JSON, fall through
  }

  // If we got output without unauthenticated indicators, assume authenticated
  return 'authenticated'
}

/**
 * Check `codex login status` to determine authentication state.
 * Returns 'unknown' if the command is not available or fails.
 */
export async function checkCodexAuth(): Promise<'authenticated' | 'unauthenticated' | 'unknown'> {
  try {
    const output = await execCommand('codex', ['login', 'status'])
    return parseAuthOutput(output)
  } catch (error) {
    log.debug('codex login status failed', { error })
    return 'unknown'
  }
}

/**
 * Run a full health check for the Codex CLI.
 * Checks version availability and optionally authentication status.
 */
export async function checkCodexHealth(
  options: { checkAuth?: boolean } = {}
): Promise<CodexHealthStatus> {
  const { checkAuth = true } = options

  // Step 1: Check if codex is installed
  const version = await getCodexVersion()
  if (!version) {
    return {
      available: false,
      authStatus: 'unknown',
      message: 'Codex CLI not found. Install it with: npm install -g @openai/codex'
    }
  }

  // Step 2: Optionally check auth
  let authStatus: CodexHealthStatus['authStatus'] = 'unknown'
  if (checkAuth) {
    authStatus = await checkCodexAuth()
  }

  const result: CodexHealthStatus = {
    available: true,
    version,
    authStatus
  }

  if (authStatus === 'unauthenticated') {
    result.message = 'Codex CLI is not authenticated. Run: codex login'
  }

  return result
}

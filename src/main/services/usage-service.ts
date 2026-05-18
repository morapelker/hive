import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { execFile } from 'child_process'
import { join } from 'path'
import { homedir, platform } from 'os'
import { createLogger } from './logger'
import type { UsageData, UsageResult } from '@shared/types/usage'

export type { UsageData, UsageResult }

const log = createLogger({ component: 'UsageService' })

type ClaudeTokenSource = 'keychain' | 'file' | 'override'

export interface ClaudeUsageFetchContext {
  caller: 'usage:fetch' | 'usage:fetchForAccount' | 'refreshAllForProvider'
  accountId?: string
  batchId?: string
}

interface AccessTokenWithSource {
  token: string
  source: ClaudeTokenSource
}

const RATE_LIMIT_HEADER_NAMES = [
  'retry-after',
  'anthropic-ratelimit-unified-status',
  'anthropic-ratelimit-unified-5h-remaining',
  'anthropic-ratelimit-unified-5h-reset',
  'anthropic-ratelimit-unified-7d-remaining',
  'anthropic-ratelimit-unified-7d-reset',
  'request-id',
  'cf-ray'
] as const

let inFlight = 0

/**
 * Read the OAuth access token from macOS Keychain.
 * Claude Code v2.x stores credentials in the keychain under
 * service "Claude Code-credentials".
 */
async function readFromKeychain(): Promise<string | null> {
  if (platform() !== 'darwin') return null
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { timeout: 5000 },
        (error, out) => {
          if (error) reject(error)
          else resolve(out.trim())
        }
      )
    })
    if (!stdout) return null
    const creds = JSON.parse(stdout)
    return creds?.claudeAiOauth?.accessToken || null
  } catch {
    return null
  }
}

/**
 * Read the OAuth access token from the legacy credentials file.
 * Older Claude Code versions stored credentials at ~/.claude/.credentials.json.
 */
async function readFromFile(): Promise<string | null> {
  const credsPath = join(homedir(), '.claude', '.credentials.json')
  if (!existsSync(credsPath)) return null
  try {
    const raw = await readFile(credsPath, 'utf-8')
    const creds = JSON.parse(raw)
    return creds?.claudeAiOauth?.accessToken || null
  } catch {
    return null
  }
}

/**
 * Read the Claude OAuth access token.
 * Tries macOS Keychain first (v2.x), then falls back to credentials file.
 */
export async function readAccessToken(): Promise<string | null> {
  return (await readAccessTokenWithSource())?.token ?? null
}

export async function readAccessTokenWithSource(): Promise<AccessTokenWithSource | null> {
  const keychainToken = await readFromKeychain()
  if (keychainToken) return { token: keychainToken, source: 'keychain' }

  const fileToken = await readFromFile()
  if (fileToken) return { token: fileToken, source: 'file' }

  return null
}

function tokenSuffix(token: string): string {
  return token.slice(-6)
}

function extractUsageResponseHeaders(response: Response): Record<string, string | null> {
  return Object.fromEntries(
    RATE_LIMIT_HEADER_NAMES.map((headerName) => [headerName, response.headers.get(headerName)])
  )
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined

  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds

  const retryAt = Date.parse(value)
  if (Number.isFinite(retryAt)) {
    return Math.max(0, Math.ceil((retryAt - Date.now()) / 1000))
  }

  return undefined
}

async function readCappedBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 1024)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `Failed to read response body: ${message}`
  }
}

export async function fetchClaudeUsage(
  overrideToken?: string,
  ctx?: ClaudeUsageFetchContext
): Promise<UsageResult> {
  const tokenWithSource =
    overrideToken !== undefined
      ? { token: overrideToken, source: 'override' as const }
      : await readAccessTokenWithSource()
  const token = tokenWithSource?.token
  if (!token) {
    log.warn('No Claude OAuth access token found (checked keychain and credentials file)', { ...ctx })
    return { success: false, error: 'No access token found' }
  }

  let timeout: ReturnType<typeof setTimeout> | undefined
  let countedInFlight = false

  try {
    const controller = new AbortController()
    timeout = setTimeout(() => controller.abort(), 10_000)

    inFlight += 1
    countedInFlight = true
    log.info('Fetching Claude usage', {
      ...ctx,
      tokenSource: tokenWithSource.source,
      tokenSuffix: tokenSuffix(token),
      tokenLength: token.length,
      inFlight
    })

    const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      signal: controller.signal
    })
    clearTimeout(timeout)
    timeout = undefined

    const retryAfter = parseRetryAfter(response.headers.get('retry-after'))
    const responseLogData: Record<string, unknown> = {
      ...ctx,
      status: response.status,
      statusText: response.statusText,
      headers: extractUsageResponseHeaders(response),
      retryAfter,
      inFlight
    }

    if (!response.ok) {
      const responseBody = await readCappedBody(response)
      log.warn('Claude usage response', { ...responseLogData, responseBody })
      const message = `Usage API returned ${response.status}: ${response.statusText}`
      return {
        success: false,
        error: message,
        ...(response.status === 429 && retryAfter !== undefined ? { retryAfter } : {})
      }
    }

    log.info('Claude usage response', responseLogData)
    const data = (await response.json()) as UsageData

    // API returns extra_usage credits in cents — convert to dollars
    if (data.extra_usage) {
      data.extra_usage.used_credits = (data.extra_usage.used_credits ?? 0) / 100
      data.extra_usage.monthly_limit = (data.extra_usage.monthly_limit ?? 0) / 100
    }

    return { success: true, data }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn('Failed to fetch Claude usage', { ...ctx, error: message, inFlight })
    return { success: false, error: message }
  } finally {
    if (timeout) clearTimeout(timeout)
    if (countedInFlight) {
      inFlight = Math.max(0, inFlight - 1)
    }
  }
}

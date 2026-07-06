import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { createLogger } from './logger'
import { keychainRead } from './keychain'
import { refreshAnthropicToken } from './oauth-anthropic'
import type { ClaudeRefreshResult, ScopedUsageWindow, UsageData, UsageResult } from '@shared/types/usage'

export type { UsageData, UsageResult }

const log = createLogger({ component: 'UsageService' })

const CLAUDE_CLIENT_USER_AGENT = 'claude-code/2.1.5'
const ANTHROPIC_API_VERSION = '2023-06-01'

type ClaudeTokenSource = 'keychain' | 'file' | 'override'

/**
 * Thrown by `refreshClaudeAccessToken` (and the OpenAI equivalent) when the
 * OAuth server rejected the refresh token itself (rather than a transient
 * network/server error) — the discriminant callers check to decide whether
 * to prompt the user to log back in.
 */
export class NeedsLoginError extends Error {
  readonly needsLogin = true as const

  constructor(message: string) {
    super(message)
    this.name = 'NeedsLoginError'
  }
}

export interface ClaudeUsageFetchContext {
  caller: 'usage:fetch' | 'usage:fetchForAccount' | 'refreshAllForProvider'
  accountId?: string
  batchId?: string
}

export interface ClaudeUsageOverride {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  accountId?: string
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
const inMemoryRefreshPromises = new Map<string, Promise<ClaudeRefreshResult>>()

function normalizeExpiresAt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value

  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric

    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }

  return undefined
}

function parseClaudeCredentials(raw: string): ClaudeUsageOverride | null {
  try {
    const creds = JSON.parse(raw) as {
      claudeAiOauth?: {
        accessToken?: unknown
        refreshToken?: unknown
        expiresAt?: unknown
      }
    }
    const oauth = creds?.claudeAiOauth
    if (typeof oauth?.accessToken !== 'string' || oauth.accessToken.length === 0) return null

    return {
      accessToken: oauth.accessToken,
      refreshToken:
        typeof oauth.refreshToken === 'string' && oauth.refreshToken.length > 0
          ? oauth.refreshToken
          : undefined,
      expiresAt: normalizeExpiresAt(oauth.expiresAt)
    }
  } catch {
    return null
  }
}

/**
 * Read the OAuth access token from macOS Keychain.
 * Claude Code v2.x stores credentials in the keychain under
 * service "Claude Code-credentials".
 */
async function readFromKeychain(): Promise<ClaudeUsageOverride | null> {
  const stdout = await keychainRead('Claude Code-credentials')
  if (!stdout) return null
  return parseClaudeCredentials(stdout)
}

/**
 * Read the OAuth access token from the legacy credentials file.
 * Older Claude Code versions stored credentials at ~/.claude/.credentials.json.
 */
async function readFromFile(): Promise<ClaudeUsageOverride | null> {
  const credsPath = join(homedir(), '.claude', '.credentials.json')
  if (!existsSync(credsPath)) return null
  try {
    const raw = await readFile(credsPath, 'utf-8')
    return parseClaudeCredentials(raw)
  } catch {
    return null
  }
}

/**
 * Read the Claude OAuth access token.
 * Tries macOS Keychain first (v2.x), then falls back to credentials file.
 */
export async function readAccessToken(): Promise<string | null> {
  return (await readClaudeCredentialsBlob())?.accessToken ?? null
}

export async function readClaudeCredentialsBlob(): Promise<ClaudeUsageOverride | null> {
  const keychainCredentials = await readFromKeychain()
  if (keychainCredentials?.accessToken) return keychainCredentials

  const fileCredentials = await readFromFile()
  if (fileCredentials?.accessToken) return fileCredentials

  return null
}

export async function readAccessTokenWithSource(): Promise<AccessTokenWithSource | null> {
  const keychainCredentials = await readFromKeychain()
  if (keychainCredentials?.accessToken) {
    return { token: keychainCredentials.accessToken, source: 'keychain' }
  }

  const fileCredentials = await readFromFile()
  if (fileCredentials?.accessToken) return { token: fileCredentials.accessToken, source: 'file' }

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

export async function refreshClaudeAccessToken(
  refreshToken: string | undefined,
  key: string
): Promise<ClaudeRefreshResult> {
  if (!refreshToken) {
    throw new Error('No refresh token available')
  }

  const existing = inMemoryRefreshPromises.get(key)
  if (existing) return existing

  const promise = (async () => {
    log.info('Claude token refresh start', {
      accountId: key,
      tokenSuffix: tokenSuffix(refreshToken)
    })

    try {
      const outcome = await refreshAnthropicToken(refreshToken)
      if (!outcome.ok) {
        throw new NeedsLoginError(`Token refresh failed: invalid_grant (${outcome.error})`)
      }
      log.info('Claude token refresh success', {
        accountId: key,
        newTokenSuffix: tokenSuffix(outcome.result.accessToken)
      })
      return {
        accessToken: outcome.result.accessToken,
        refreshToken: outcome.result.refreshToken,
        expiresAt: outcome.result.expiresAt,
        scope: outcome.scope,
        rotatedFrom: refreshToken
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.warn('Claude token refresh failed', { accountId: key, error: message })
      if (message.includes('Token refresh failed') || message.includes('No refresh token available')) {
        throw error
      }
      throw new Error(`Token refresh failed: ${message}`)
    }
  })().finally(() => {
    inMemoryRefreshPromises.delete(key)
  })

  inMemoryRefreshPromises.set(key, promise)
  return promise
}

async function fetchClaudeUsageResponse(
  token: string,
  tokenSource: ClaudeTokenSource,
  ctx: ClaudeUsageFetchContext | undefined
): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)

  try {
    log.info('Fetching Claude usage', {
      ...ctx,
      tokenSource,
      tokenSuffix: tokenSuffix(token),
      tokenLength: token.length,
      inFlight
    })

    return await fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': CLAUDE_CLIENT_USER_AGENT,
        'anthropic-version': ANTHROPIC_API_VERSION,
        'anthropic-beta': 'oauth-2025-04-20',
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      signal: controller.signal
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Usage API request timed out')
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function claudeRefreshKey(override: ClaudeUsageOverride): string {
  if (override.accountId) return override.accountId
  if (override.refreshToken) return `refresh:${tokenSuffix(override.refreshToken)}`
  return `access:${tokenSuffix(override.accessToken)}`
}

/** Map the usage response's `limits[]` array to model-scoped usage windows (Fable/Opus/etc). */
function mapScopedLimits(limits: unknown): ScopedUsageWindow[] | undefined {
  if (!Array.isArray(limits)) return undefined

  const scoped: ScopedUsageWindow[] = []
  for (const entry of limits) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as {
      percent?: unknown
      resets_at?: unknown
      scope?: { model?: { display_name?: unknown } }
    }
    const displayName = record.scope?.model?.display_name
    if (typeof displayName !== 'string' || displayName.length === 0) continue

    scoped.push({
      label: displayName,
      used_percent: typeof record.percent === 'number' ? record.percent : 0,
      resets_at: typeof record.resets_at === 'string' ? record.resets_at : null
    })
  }
  return scoped.length > 0 ? scoped : undefined
}

export async function fetchClaudeUsage(
  override?: ClaudeUsageOverride,
  ctx?: ClaudeUsageFetchContext
): Promise<UsageResult> {
  let effectiveOverride: ClaudeUsageOverride
  let tokenSource: ClaudeTokenSource

  if (override !== undefined) {
    effectiveOverride = override
    tokenSource = 'override'
  } else {
    const liveWithSource = await readAccessTokenWithSource()
    if (!liveWithSource?.token) {
      log.warn('No Claude OAuth access token found (checked keychain and credentials file)', {
        ...ctx
      })
      return { success: false, error: 'No access token found' }
    }
    // The LIVE credentials (whatever the `claude` CLI itself last wrote) are
    // refreshed just like any other account from here on — build an
    // override so the proactive/reactive refresh logic below applies to
    // them too.
    const liveBlob = await readClaudeCredentialsBlob()
    effectiveOverride = {
      accessToken: liveWithSource.token,
      refreshToken: liveBlob?.refreshToken,
      expiresAt: liveBlob?.expiresAt,
      accountId: 'live'
    }
    tokenSource = liveWithSource.source
  }

  let token = effectiveOverride.accessToken

  let countedInFlight = false
  let rotated: ClaudeRefreshResult | undefined
  let currentRefreshToken = effectiveOverride.refreshToken
  let needsLogin = false

  try {
    inFlight += 1
    countedInFlight = true

    if (
      effectiveOverride.expiresAt !== undefined &&
      Date.now() + 60_000 >= effectiveOverride.expiresAt &&
      currentRefreshToken
    ) {
      rotated = await refreshClaudeAccessToken(currentRefreshToken, claudeRefreshKey(effectiveOverride))
      token = rotated.accessToken
      currentRefreshToken = rotated.refreshToken
    }

    let response = await fetchClaudeUsageResponse(token, tokenSource, ctx)

    if (response.status === 401 && currentRefreshToken) {
      rotated = await refreshClaudeAccessToken(currentRefreshToken, claudeRefreshKey(effectiveOverride))
      token = rotated.accessToken
      currentRefreshToken = rotated.refreshToken
      response = await fetchClaudeUsageResponse(token, tokenSource, ctx)
    }

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
      // A 401 with no refresh token to try means we truly can't recover
      // without the user logging back in.
      if (response.status === 401 && !currentRefreshToken) {
        needsLogin = true
      }
      return {
        success: false,
        error: message,
        ...(response.status === 429 && retryAfter !== undefined ? { retryAfter } : {}),
        ...(needsLogin ? { needsLogin: true } : {})
      }
    }

    log.info('Claude usage response', responseLogData)
    const data = (await response.json()) as UsageData & { limits?: unknown }

    // API returns extra_usage credits in cents — convert to dollars
    if (data.extra_usage) {
      data.extra_usage.used_credits = (data.extra_usage.used_credits ?? 0) / 100
      data.extra_usage.monthly_limit = (data.extra_usage.monthly_limit ?? 0) / 100
    }

    const scoped = mapScopedLimits(data.limits)
    if (scoped) data.scoped = scoped
    delete data.limits

    return { success: true, data, ...(rotated ? { rotated } : {}) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn('Failed to fetch Claude usage', { ...ctx, error: message, inFlight })
    return {
      success: false,
      error: message,
      ...(error instanceof NeedsLoginError ? { needsLogin: true } : {})
    }
  } finally {
    if (countedInFlight) {
      inFlight = Math.max(0, inFlight - 1)
    }
  }
}

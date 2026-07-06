import { existsSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { execFile } from 'child_process'
import { join } from 'path'
import { homedir, platform } from 'os'
import { createLogger } from './logger'
import { decodeJwtPayload } from './jwt-utils'
import type { OpenAIUsageData, OpenAIUsageResult } from '@shared/types/usage'

export type { OpenAIUsageData, OpenAIUsageResult }

const log = createLogger({ component: 'OpenAIUsageService' })

const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex')
const AUTH_FILE = join(CODEX_HOME, 'auth.json')
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

interface CodexAuthTokens {
  id_token: unknown
  access_token: string
  refresh_token: string
  account_id: string
}

export interface CodexAuth {
  OPENAI_API_KEY?: string | null
  auth_mode?: string | null
  tokens?: CodexAuthTokens
  last_refresh?: string
}

export interface OpenAIUsageOverride {
  accessToken: string
  refreshToken: string
  accountId: string
  idToken?: string
  email?: string
}

interface RefreshResponse {
  id_token?: string
  access_token?: string
  refresh_token?: string
}

interface RefreshResult {
  accessToken: string
  refreshToken: string
  idToken?: string
}

/** Module-level promise to deduplicate concurrent refresh requests. */
let refreshPromise: Promise<string> | null = null
const inMemoryRefreshPromises = new Map<string, Promise<RefreshResult>>()

/**
 * Read Codex credentials from the auth.json file.
 */
async function readFromFile(): Promise<CodexAuth | null> {
  if (!existsSync(AUTH_FILE)) return null
  try {
    const raw = await readFile(AUTH_FILE, 'utf-8')
    return JSON.parse(raw) as CodexAuth
  } catch {
    return null
  }
}

/**
 * Read Codex credentials from the macOS Keychain ("Codex Auth" service).
 */
async function readFromKeychain(): Promise<CodexAuth | null> {
  if (platform() !== 'darwin') return null
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        'security',
        ['find-generic-password', '-s', 'Codex Auth', '-w'],
        { timeout: 5000 },
        (error, out) => {
          if (error) reject(error)
          else resolve(out.trim())
        }
      )
    })
    if (!stdout) return null
    return JSON.parse(stdout) as CodexAuth
  } catch {
    return null
  }
}

/**
 * Read Codex credentials. Tries auth.json first, then macOS Keychain as fallback.
 */
export async function readCodexCredentials(): Promise<CodexAuth | null> {
  const fromFile = await readFromFile()
  if (fromFile?.tokens?.access_token) return fromFile

  const fromKeychain = await readFromKeychain()
  if (fromKeychain?.tokens?.access_token) return fromKeychain

  return null
}

/**
 * Check whether a JWT access token is expired (or will expire within 60 seconds).
 */
function isTokenExpired(accessToken: string): boolean {
  const payload = decodeJwtPayload(accessToken)
  if (!payload || typeof payload.exp !== 'number') return false
  const nowSec = Math.floor(Date.now() / 1000)
  return payload.exp <= nowSec + 60
}

/**
 * Refresh the access token using the given refresh token.
 */
async function requestTokenRefresh(refreshToken: string): Promise<RefreshResponse> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)

  try {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      }),
      signal: controller.signal
    })

    clearTimeout(timeout)

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Token refresh failed (${response.status}): ${body}`)
    }

    return (await response.json()) as RefreshResponse
  } catch (error) {
    clearTimeout(timeout)
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Token refresh timed out')
    }
    throw error
  }
}

/**
 * Refresh the live access token and persist the updated auth.json.
 * Uses a module-level promise to deduplicate concurrent live refresh requests.
 */
async function refreshAccessToken(auth: CodexAuth): Promise<string> {
  if (refreshPromise) return refreshPromise

  refreshPromise = (async () => {
    if (!auth.tokens?.refresh_token) {
      throw new Error('No refresh token available')
    }

    const data = await requestTokenRefresh(auth.tokens.refresh_token)

    if (data.access_token) auth.tokens.access_token = data.access_token
    if (data.refresh_token) auth.tokens.refresh_token = data.refresh_token
    if (data.id_token) auth.tokens.id_token = data.id_token
    auth.last_refresh = new Date().toISOString()

    try {
      await writeFile(AUTH_FILE, JSON.stringify(auth, null, 2), { mode: 0o600 })
    } catch {
      // persist failed, continue with in-memory token
    }

    return auth.tokens.access_token
  })().finally(() => {
    refreshPromise = null
  })

  return refreshPromise
}

/**
 * Refresh a saved account in memory only. Concurrent refreshes for the same
 * account share the same HTTP request; different accounts refresh independently.
 */
export async function refreshAccessTokenInMemory(auth: CodexAuth): Promise<RefreshResult> {
  if (!auth.tokens?.refresh_token) {
    throw new Error('No refresh token available')
  }
  if (!auth.tokens.account_id) {
    throw new Error('No account id available')
  }

  const accountId = auth.tokens.account_id
  const existing = inMemoryRefreshPromises.get(accountId)
  if (existing) return existing

  const promise = (async () => {
    const data = await requestTokenRefresh(auth.tokens!.refresh_token)
    if (data.access_token) auth.tokens!.access_token = data.access_token
    if (data.refresh_token) auth.tokens!.refresh_token = data.refresh_token
    if (data.id_token) auth.tokens!.id_token = data.id_token
    auth.last_refresh = new Date().toISOString()

    return {
      accessToken: auth.tokens!.access_token,
      refreshToken: auth.tokens!.refresh_token,
      idToken: typeof auth.tokens!.id_token === 'string' ? auth.tokens!.id_token : undefined
    }
  })().finally(() => {
    inMemoryRefreshPromises.delete(accountId)
  })

  inMemoryRefreshPromises.set(accountId, promise)
  return promise
}

/**
 * Fetch usage data from the OpenAI usage endpoint.
 */
async function fetchUsage(
  accessToken: string,
  accountId: string
): Promise<{ status: number; data?: unknown; body?: string }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)

  try {
    const response = await fetch(USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'ChatGPT-Account-Id': accountId,
        Accept: 'application/json'
      },
      signal: controller.signal
    })

    clearTimeout(timeout)

    if (!response.ok) {
      const body = await response.text()
      return { status: response.status, body }
    }

    const data = await response.json()
    return { status: response.status, data }
  } catch (error) {
    clearTimeout(timeout)
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Usage API request timed out')
    }
    throw error
  }
}

/**
 * Fetch OpenAI usage data. Reads credentials, refreshes the token if expired,
 * calls the usage endpoint, and retries once on 401 after a forced refresh.
 */
export async function fetchOpenAIUsage(override?: OpenAIUsageOverride): Promise<OpenAIUsageResult> {
  const auth: CodexAuth | null = override
    ? {
        auth_mode: 'chatgpt',
        tokens: {
          access_token: override.accessToken,
          refresh_token: override.refreshToken,
          account_id: override.accountId,
          id_token: override.idToken ?? ''
        }
      }
    : await readCodexCredentials()
  if (!auth?.tokens) {
    log.warn('No Codex credentials found (checked auth.json and keychain)')
    return { success: false, error: 'No Codex credentials found' }
  }

  let accessToken = auth.tokens.access_token
  const accountId = auth.tokens.account_id
  let rotated: RefreshResult | undefined

  // Refresh if token is expired
  if (isTokenExpired(accessToken)) {
    try {
      if (override) {
        rotated = await refreshAccessTokenInMemory(auth)
        accessToken = rotated.accessToken
      } else {
        accessToken = await refreshAccessToken(auth)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.warn('Failed to refresh OpenAI access token', { error: message })
      return { success: false, error: message }
    }
  }

  try {
    let result = await fetchUsage(accessToken, accountId)

    // Retry once on 401 after forcing a refresh
    if (result.status === 401) {
      try {
        if (override) {
          rotated = await refreshAccessTokenInMemory(auth)
          accessToken = rotated.accessToken
        } else {
          accessToken = await refreshAccessToken(auth)
        }
        result = await fetchUsage(accessToken, accountId)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.warn('Failed to refresh OpenAI access token on 401 retry', { error: message })
        return { success: false, error: message }
      }
    }

    if (result.status !== 200) {
      const message = `OpenAI Usage API returned ${result.status}: ${result.body || 'unknown error'}`
      log.warn(message)
      return { success: false, error: message }
    }

    const data = result.data as OpenAIUsageData
    return { success: true, data, rotated }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn('Failed to fetch OpenAI usage', { error: message })
    return { success: false, error: message }
  }
}

import { randomUUID } from 'crypto'
import { getDatabase } from '../db'
import { getClaudeAccountEmail, getOpenAIAccountEmail } from './account-service'
import { createLogger } from './logger'
import {
  fetchOpenAIUsage,
  readCodexCredentials,
  type OpenAIUsageOverride
} from './openai-usage-service'
import {
  fetchClaudeUsage,
  readClaudeCredentialsBlob,
  type ClaudeUsageFetchContext,
  type ClaudeUsageOverride
} from './usage-service'
import type {
  FetchForAccountResult,
  OpenAIUsageData,
  RefreshAllResultItem,
  SavedAccountDTO,
  UsageData,
  UsageProvider
} from '@shared/types/usage'
import type { SavedUsageAccount, SavedUsageProvider, SavedUsageStatus } from '../db/types'

const log = createLogger({ component: 'SavedUsageOrchestrator' })

interface ClaudeSavedCredentials extends ClaudeUsageOverride {
  accessToken: string
  email: string
}

interface OpenAISavedCredentials extends OpenAIUsageOverride {
  email: string
}

function safeParseJson(value: string): unknown {
  return JSON.parse(value)
}

function parseLastUsage(row: SavedUsageAccount): UsageData | OpenAIUsageData | null {
  if (!row.last_usage_json) return null
  try {
    return safeParseJson(row.last_usage_json) as UsageData | OpenAIUsageData
  } catch {
    return null
  }
}

export function toSavedAccountDTO(row: SavedUsageAccount): SavedAccountDTO {
  return {
    id: row.id,
    provider: row.provider,
    email: row.email,
    last_usage: parseLastUsage(row),
    last_fetched_at: row.last_fetched_at,
    status: row.status,
    last_error: row.last_error,
    created_at: row.created_at
  }
}

export function listSavedAccounts(provider?: UsageProvider): SavedAccountDTO[] {
  const db = getDatabase()
  const providers: SavedUsageProvider[] = provider ? [provider] : ['anthropic', 'openai']
  return providers.flatMap((p) => db.getSavedUsageAccountsByProvider(p).map(toSavedAccountDTO))
}

export function removeSavedAccount(accountId: string): boolean {
  return getDatabase().deleteSavedUsageAccount(accountId)
}

export async function captureLiveAccountFromFetch(
  provider: UsageProvider,
  usage: UsageData | OpenAIUsageData
): Promise<void> {
  const db = getDatabase()

  if (provider === 'anthropic') {
    const [credentialsBlob, email] = await Promise.all([
      readClaudeCredentialsBlob(),
      getClaudeAccountEmail()
    ])
    if (!credentialsBlob?.accessToken || !email) {
      log.warn('Skipping Claude saved usage capture because token or email is unavailable')
      return
    }

    const credentials: ClaudeSavedCredentials = {
      accessToken: credentialsBlob.accessToken,
      refreshToken: credentialsBlob.refreshToken,
      expiresAt: credentialsBlob.expiresAt,
      email
    }
    db.upsertSavedUsageAccount({
      provider,
      email,
      credentials_json: JSON.stringify(credentials),
      last_usage_json: JSON.stringify(usage),
      status: 'ok',
      last_error: null
    })
    log.info('Captured Claude saved usage account', { provider })
    return
  }

  const [auth, email] = await Promise.all([readCodexCredentials(), getOpenAIAccountEmail()])
  const tokens = auth?.tokens
  if (!tokens?.access_token || !tokens.refresh_token || !tokens.account_id || !email) {
    log.warn('Skipping OpenAI saved usage capture because credentials or email are unavailable')
    return
  }

  const credentials: OpenAISavedCredentials = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    accountId: tokens.account_id,
    idToken: typeof tokens.id_token === 'string' ? tokens.id_token : undefined,
    email
  }
  db.upsertSavedUsageAccount({
    provider,
    email,
    credentials_json: JSON.stringify(credentials),
    last_usage_json: JSON.stringify(usage),
    status: 'ok',
    last_error: null
  })
  log.info('Captured OpenAI saved usage account', { provider })
}

function isAuthStatusError(message: string): boolean {
  return /\b(401|403)\b/.test(message)
}

function isOpenAIStaleError(message: string): boolean {
  return (
    isAuthStatusError(message) ||
    message.includes('Token refresh failed') ||
    message.includes('No refresh token available')
  )
}

function isClaudeStaleError(message: string): boolean {
  return (
    /\b401\b/.test(message) ||
    message.includes('Token refresh failed') ||
    message.includes('No refresh token available')
  )
}

function accountError(
  accountId: string,
  message: string,
  status: SavedUsageStatus = 'error',
  lastUsageJson: string | null = null,
  retryAfter?: number
): FetchForAccountResult {
  const db = getDatabase()
  db.updateSavedUsageAccountUsage(accountId, {
    last_usage_json: lastUsageJson,
    status,
    last_error: message
  })
  return { success: false, error: message, status, retryAfter }
}

function parseClaudeCredentials(row: SavedUsageAccount): ClaudeSavedCredentials | null {
  const parsed = safeParseJson(row.credentials_json) as Partial<ClaudeSavedCredentials>
  if (typeof parsed.accessToken !== 'string' || parsed.accessToken.length === 0) return null
  return {
    accessToken: parsed.accessToken,
    refreshToken:
      typeof parsed.refreshToken === 'string' && parsed.refreshToken.length > 0
        ? parsed.refreshToken
        : undefined,
    expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : undefined,
    email: row.email
  }
}

function parseOpenAICredentials(row: SavedUsageAccount): OpenAISavedCredentials | null {
  const parsed = safeParseJson(row.credentials_json) as Partial<OpenAISavedCredentials>
  if (
    typeof parsed.accessToken !== 'string' ||
    typeof parsed.refreshToken !== 'string' ||
    typeof parsed.accountId !== 'string' ||
    parsed.accessToken.length === 0 ||
    parsed.refreshToken.length === 0 ||
    parsed.accountId.length === 0
  ) {
    return null
  }

  return {
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken,
    accountId: parsed.accountId,
    idToken: typeof parsed.idToken === 'string' ? parsed.idToken : undefined,
    email: row.email
  }
}

interface FetchForSavedAccountOptions {
  caller?: ClaudeUsageFetchContext['caller']
  batchId?: string
}

export async function fetchForSavedAccount(
  accountId: string,
  options: FetchForSavedAccountOptions = {}
): Promise<FetchForAccountResult> {
  const db = getDatabase()
  const row = db.getSavedUsageAccountById(accountId)
  if (!row) return { success: false, error: 'not found', status: 'error' }

  try {
    if (row.provider === 'anthropic') {
      const credentials = parseClaudeCredentials(row)
      if (!credentials)
        return accountError(accountId, 'Invalid Claude credentials', 'error', row.last_usage_json)

      const result = await fetchClaudeUsage(
        {
          accessToken: credentials.accessToken,
          refreshToken: credentials.refreshToken,
          expiresAt: credentials.expiresAt,
          accountId
        },
        {
          caller: options.caller ?? 'usage:fetchForAccount',
          accountId,
          batchId: options.batchId
        }
      )
      if (!result.success || !result.data) {
        const message = result.error ?? 'Claude usage fetch failed'
        const status: SavedUsageStatus = isClaudeStaleError(message) ? 'stale' : 'error'
        db.updateSavedUsageAccountUsage(accountId, {
          last_usage_json: row.last_usage_json,
          status,
          last_error: message
        })
        return { success: false, error: message, status, retryAfter: result.retryAfter }
      }

      if (result.rotated) {
        const rotatedCredentials: ClaudeSavedCredentials = {
          ...credentials,
          accessToken: result.rotated.accessToken,
          refreshToken: result.rotated.refreshToken,
          expiresAt: result.rotated.expiresAt
        }
        db.updateSavedUsageAccountCredentials(accountId, JSON.stringify(rotatedCredentials))
      }

      db.updateSavedUsageAccountUsage(accountId, {
        last_usage_json: JSON.stringify(result.data),
        status: 'ok',
        last_error: null
      })
      return { success: true, data: result.data, status: 'ok' }
    }

    const credentials = parseOpenAICredentials(row)
    if (!credentials) {
      return accountError(accountId, 'Invalid OpenAI credentials', 'stale', row.last_usage_json)
    }

    const result = await fetchOpenAIUsage(credentials)
    if (!result.success || !result.data) {
      const message = result.error ?? 'OpenAI usage fetch failed'
      const status: SavedUsageStatus = isOpenAIStaleError(message) ? 'stale' : 'error'
      db.updateSavedUsageAccountUsage(accountId, {
        last_usage_json: row.last_usage_json,
        status,
        last_error: message
      })
      return { success: false, error: message, status }
    }

    if (result.rotated) {
      const rotatedCredentials: OpenAISavedCredentials = {
        ...credentials,
        accessToken: result.rotated.accessToken,
        refreshToken: result.rotated.refreshToken,
        idToken: result.rotated.idToken ?? credentials.idToken
      }
      db.updateSavedUsageAccountCredentials(accountId, JSON.stringify(rotatedCredentials))
    }

    db.updateSavedUsageAccountUsage(accountId, {
      last_usage_json: JSON.stringify(result.data),
      status: 'ok',
      last_error: null
    })
    return { success: true, data: result.data, status: 'ok' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return accountError(accountId, message, 'error', row.last_usage_json)
  }
}

export async function refreshAllForProvider(
  provider: UsageProvider
): Promise<RefreshAllResultItem[]> {
  const rows = getDatabase().getSavedUsageAccountsByProvider(provider)
  const batchId = randomUUID()
  const startedAt = Date.now()
  const results: RefreshAllResultItem[] = []

  log.info('refreshAllForProvider start', {
    provider,
    batchId,
    accountCount: rows.length,
    accountIds: rows.map((row) => row.id)
  })

  for (const row of rows) {
    log.info('refreshAllForProvider account start', { provider, batchId, accountId: row.id })
    try {
      const result = await fetchForSavedAccount(row.id, {
        caller: 'refreshAllForProvider',
        batchId
      })
      const item = {
        accountId: row.id,
        success: result.success,
        error: result.error,
        retryAfter: result.retryAfter
      }
      results.push(item)

      if (result.success) {
        log.info('refreshAllForProvider account success', { provider, batchId, accountId: row.id })
      } else {
        log.warn('refreshAllForProvider account failure', {
          provider,
          batchId,
          accountId: row.id,
          error: result.error,
          retryAfter: result.retryAfter
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      results.push({ accountId: row.id, success: false, error: message })
      log.warn('refreshAllForProvider account failure', {
        provider,
        batchId,
        accountId: row.id,
        error: message
      })
    }
  }

  const summary = results.reduce(
    (counts, result) => {
      if (result.success) {
        counts.success += 1
        return counts
      }

      const status = result.error?.match(/\b([1-5]\d{2})\b/)?.[1]
      if (status?.startsWith('4')) counts['4xx'] += 1
      else if (status?.startsWith('5')) counts['5xx'] += 1
      else counts.network += 1
      return counts
    },
    { success: 0, '4xx': 0, '5xx': 0, network: 0 }
  )

  log.info('refreshAllForProvider complete', {
    provider,
    batchId,
    elapsedMs: Date.now() - startedAt,
    ...summary
  })

  return results
}

import { randomUUID } from 'crypto'
import { getDatabase } from '../db'
import {
  addClaudeAccount,
  listClaudeAccounts,
  readClaudeEffectiveBlob,
  readClaudeLiveEmail,
  readClaudeLiveIdentity,
  readClaudeLiveRawBlob,
  removeClaudeAccount,
  switchClaudeAccount,
  updateClaudeTokens,
  type ClaudeStoreAccount
} from './account-store-claude'
import { accountLockKey, withAccountLock, withAccountLocks } from './account-lock'
import {
  addCodexAccount,
  listCodexAccounts,
  readCodexEffectiveAuth,
  removeCodexAccount,
  switchCodexAccount,
  updateCodexTokens,
  type CodexStoreAccount
} from './account-store-codex'
import { migrateSavedCredentialsToStores } from './credentials-migration'
import { createLogger } from './logger'
import { refreshAnthropicToken } from './oauth-anthropic'
import { refreshOpenAIToken } from './oauth-openai'
import {
  fetchOpenAIUsage,
  readCodexCredentials,
  type OpenAIUsageOverride
} from './openai-usage-service'
import {
  fetchClaudeUsage,
  NeedsLoginError,
  type ClaudeUsageFetchContext,
  type ClaudeUsageOverride
} from './usage-service'
import { jwtExpMs, parseCodexIdToken } from './jwt-utils'
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

/**
 * Watcher expiry threshold (kept in sync with account-maintenance.ts's
 * EXPIRY_THRESHOLD_MS by convention, not import, to avoid a cycle between the
 * two modules). Used by refreshTokensForStoreAccount's post-lock recheck: if
 * an earlier lock holder already refreshed the token past this threshold,
 * there's no need to hit the network again.
 */
const REFRESH_RECHECK_THRESHOLD_MS = 120_000

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
    created_at: row.created_at,
    plan: null
  }
}

async function safeMigrate(): Promise<void> {
  try {
    await migrateSavedCredentialsToStores()
  } catch (error) {
    log.warn('Failed to migrate saved credentials into account stores', {
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

/**
 * Store-backed account list: enumerates the ccswitch stores (source of
 * truth), ensures a usage-cache row exists for each, deletes cache rows for
 * accounts no longer in the store, and joins the store's `plan` onto the
 * cached usage/status fields.
 */
export async function listSavedAccounts(provider?: UsageProvider): Promise<SavedAccountDTO[]> {
  await safeMigrate()

  const db = getDatabase()
  const providers: UsageProvider[] = provider ? [provider] : ['anthropic', 'openai']
  const dtos: SavedAccountDTO[] = []

  for (const p of providers) {
    const savedProvider: SavedUsageProvider = p
    const storeAccounts: Array<{ email: string; plan: string | null }> =
      p === 'anthropic' ? await listClaudeAccounts() : await listCodexAccounts()
    const cacheRows = db.getSavedUsageAccountsByProvider(savedProvider)
    const cacheByEmail = new Map(cacheRows.map((row) => [row.email.toLowerCase(), row]))

    const seenEmails = new Set<string>()
    for (const account of storeAccounts) {
      const email = account.email.toLowerCase()
      if (!email) continue
      if (seenEmails.has(email)) {
        log.warn('Duplicate store account email; keeping the first entry', {
          provider: p,
          email
        })
        continue
      }
      seenEmails.add(email)

      let row = cacheByEmail.get(email)
      if (!row) {
        row = db.upsertSavedUsageAccount({
          provider: savedProvider,
          email,
          credentials_json: ''
        })
      }

      dtos.push({ ...toSavedAccountDTO(row), plan: account.plan })
    }

    for (const row of cacheRows) {
      if (!seenEmails.has(row.email.toLowerCase())) {
        db.deleteSavedUsageAccount(row.id)
      }
    }
  }

  return dtos
}

async function findClaudeStoreAccount(email: string): Promise<ClaudeStoreAccount | undefined> {
  const accounts = await listClaudeAccounts()
  const target = email.toLowerCase()
  return accounts.find((account) => account.email === target)
}

async function findCodexStoreAccount(email: string): Promise<CodexStoreAccount | undefined> {
  const accounts = await listCodexAccounts()
  const target = email.toLowerCase()
  return accounts.find((account) => account.email === target)
}

export async function removeSavedAccount(accountId: string): Promise<boolean> {
  const db = getDatabase()
  const row = db.getSavedUsageAccountById(accountId)
  if (!row) return false

  if (row.provider === 'anthropic') {
    const account = await findClaudeStoreAccount(row.email)
    if (account) await removeClaudeAccount(account.num, account.email)
  } else {
    const account = await findCodexStoreAccount(row.email)
    if (account) await removeCodexAccount(account.accountKey)
  }

  return db.deleteSavedUsageAccount(accountId)
}

/**
 * The currently-live account's email for `provider` (the account being
 * switched AWAY from). Tolerant of any read failure — a null just means we
 * skip the outgoing lock. Codex derives it from the managed list's `active`
 * entry so it matches the lowercased email the saved-account lock uses.
 */
async function readOutgoingLiveEmail(provider: SavedUsageProvider): Promise<string | null> {
  try {
    if (provider === 'anthropic') return await readClaudeLiveEmail()
    const accounts = await listCodexAccounts()
    return accounts.find((account) => account.active)?.email ?? null
  } catch {
    return null
  }
}

export async function switchAccount(
  accountId: string
): Promise<{ success: boolean; error?: string }> {
  const db = getDatabase()
  const row = db.getSavedUsageAccountById(accountId)
  if (!row) return { success: false, error: 'not found' }

  // Serialize the switch under BOTH the outgoing-live and target account locks
  // (sorted, deadlock-free). Combined with the live-fetch lock in usage-ops,
  // this closes the window where a concurrent rotation-persist could, between
  // its guard-read and its live-write+mirror, clobber the just-switched live
  // credentials or mirror the outgoing account's tokens into the target's
  // backup slot.
  const targetKey = accountLockKey(row.provider, row.email)
  const outgoingEmail = await readOutgoingLiveEmail(row.provider)
  const keys = [targetKey]
  if (outgoingEmail) {
    const outgoingKey = accountLockKey(row.provider, outgoingEmail)
    if (outgoingKey !== targetKey) keys.push(outgoingKey)
  }

  return withAccountLocks(keys, async () => {
    try {
      if (row.provider === 'anthropic') {
        const account = await findClaudeStoreAccount(row.email)
        if (!account) return { success: false, error: 'account no longer in store' }
        await switchClaudeAccount(account.num, account.email)
      } else {
        const account = await findCodexStoreAccount(row.email)
        if (!account) return { success: false, error: 'account no longer in store' }
        await switchCodexAccount(account.accountKey)
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}

function upsertUsageCacheRow(
  provider: UsageProvider,
  email: string,
  usage: UsageData | OpenAIUsageData
): void {
  getDatabase().upsertSavedUsageAccount({
    provider,
    email,
    credentials_json: '',
    last_usage_json: JSON.stringify(usage),
    status: 'ok',
    last_error: null
  })
}

/**
 * After a successful LIVE fetch, register the live identity in the
 * appropriate account store when it isn't already managed, then refresh the
 * usage cache row. Never writes credentials to SQLite.
 */
export async function captureLiveAccountFromFetch(
  provider: UsageProvider,
  usage: UsageData | OpenAIUsageData
): Promise<void> {
  if (provider === 'anthropic') {
    const identity = await readClaudeLiveIdentity()
    const email = identity.email?.toLowerCase()
    if (!email) {
      log.warn('Skipping Claude saved usage capture because live identity email is unavailable')
      return
    }

    const managed = await listClaudeAccounts()
    if (!managed.some((account) => account.email === email)) {
      const rawBlob = await readClaudeLiveRawBlob()
      if (!rawBlob) {
        log.warn('Skipping Claude saved usage capture because no live credential blob is available')
        return
      }
      await addClaudeAccount(email, identity.uuid ?? '', rawBlob)
      log.info('Captured Claude live account into the managed store', { provider })
    }

    upsertUsageCacheRow(provider, email, usage)
    return
  }

  const auth = await readCodexCredentials()
  const idToken = auth?.tokens?.id_token
  if (typeof idToken !== 'string' || idToken.length === 0) {
    log.warn('Skipping OpenAI saved usage capture because no live id_token is available')
    return
  }

  const claims = parseCodexIdToken(idToken)
  if (!claims.userId || !claims.accountId) {
    log.warn(
      'Skipping OpenAI saved usage capture: id_token has no chatgpt_user_id/chatgpt_account_id'
    )
    return
  }

  const accountKey = `${claims.userId}::${claims.accountId}`
  const managedCodex = await listCodexAccounts()
  const existing = managedCodex.find((account) => account.accountKey === accountKey)

  if (!existing) {
    const accessToken = auth?.tokens?.access_token
    const refreshToken = auth?.tokens?.refresh_token
    if (!accessToken || !refreshToken) {
      log.warn(
        'Skipping OpenAI saved usage capture: live auth.json is missing access/refresh token'
      )
      return
    }
    await addCodexAccount(idToken, accessToken, refreshToken)
    log.info('Captured OpenAI live account into the managed store', { provider })
  }

  const email = (existing?.email || claims.email || '').toLowerCase()
  if (!email) {
    log.warn('Skipping OpenAI saved usage cache update because no email is available')
    return
  }
  upsertUsageCacheRow(provider, email, usage)
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

function isNeedsLoginError(error: unknown): boolean {
  if (error instanceof NeedsLoginError) return true
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { needsLogin?: unknown }).needsLogin === true
  )
}

interface AccountErrorOptions {
  retryAfter?: number
  needsLogin?: boolean
}

function accountError(
  accountId: string,
  message: string,
  status: SavedUsageStatus = 'error',
  lastUsageJson: string | null = null,
  options: AccountErrorOptions = {}
): FetchForAccountResult {
  const db = getDatabase()
  db.updateSavedUsageAccountUsage(accountId, {
    last_usage_json: lastUsageJson,
    status,
    last_error: message
  })
  return {
    success: false,
    error: message,
    status,
    retryAfter: options.retryAfter,
    ...(options.needsLogin ? { needsLogin: true } : {})
  }
}

interface FetchForSavedAccountOptions {
  caller?: ClaudeUsageFetchContext['caller']
  batchId?: string
  userInitiated?: boolean
}

export async function fetchForSavedAccount(
  accountId: string,
  options: FetchForSavedAccountOptions = {}
): Promise<FetchForAccountResult> {
  const db = getDatabase()
  const row = db.getSavedUsageAccountById(accountId)
  if (!row) return { success: false, error: 'not found', status: 'error' }

  // Serialize the whole fetch (it may internally refresh the OAuth token) per
  // account so concurrent callers (watcher / mass refresh / user-initiated)
  // never race a single-use rotating refresh token against each other.
  return withAccountLock(accountLockKey(row.provider, row.email), async () => {
    try {
      if (row.provider === 'anthropic') {
        const account = await findClaudeStoreAccount(row.email)
        if (!account) {
          return accountError(accountId, 'account no longer in store', 'stale', row.last_usage_json)
        }

        const effective = await readClaudeEffectiveBlob(account.num, account.email)
        const accessToken = effective?.parsed.accessToken
        if (!accessToken) {
          return accountError(accountId, 'Invalid Claude credentials', 'stale', row.last_usage_json)
        }

        const override: ClaudeUsageOverride = {
          accessToken,
          refreshToken: effective?.parsed.refreshToken,
          expiresAt: effective?.parsed.expiresAt,
          accountId
        }

        const result = await fetchClaudeUsage(override, {
          caller: options.caller ?? 'usage:fetchForAccount',
          accountId,
          batchId: options.batchId
        })

        let rotationPersistError: string | null = null
        if (result.rotated) {
          try {
            await updateClaudeTokens(account.num, account.email, result.rotated, result.rotated.scope)
          } catch (persistError) {
            const message =
              persistError instanceof Error ? persistError.message : String(persistError)
            log.warn(
              'Failed to persist rotated Claude tokens; keeping the successful usage fetch result',
              { accountId, error: message }
            )
            rotationPersistError = `failed to persist rotated tokens: ${message}`
          }
        }

        if (!result.success || !result.data) {
          const message = result.error ?? 'Claude usage fetch failed'
          const needsLogin = result.needsLogin === true || isClaudeStaleError(message)
          const status: SavedUsageStatus = needsLogin ? 'stale' : 'error'
          db.updateSavedUsageAccountUsage(accountId, {
            last_usage_json: row.last_usage_json,
            status,
            last_error: message
          })
          return {
            success: false,
            error: message,
            status,
            retryAfter: result.retryAfter,
            ...(needsLogin ? { needsLogin: true } : {})
          }
        }

        db.updateSavedUsageAccountUsage(accountId, {
          last_usage_json: JSON.stringify(result.data),
          status: 'ok',
          last_error: rotationPersistError
        })
        return { success: true, data: result.data, status: 'ok' }
      }

      const account = await findCodexStoreAccount(row.email)
      if (!account) {
        return accountError(accountId, 'account no longer in store', 'stale', row.last_usage_json)
      }

      const snapshot = await readCodexEffectiveAuth(account.accountKey)
      const accessToken = snapshot?.tokens?.access_token
      const refreshToken = snapshot?.tokens?.refresh_token
      const codexAccountId = snapshot?.tokens?.account_id
      if (!accessToken || !refreshToken || !codexAccountId) {
        return accountError(accountId, 'Invalid OpenAI credentials', 'stale', row.last_usage_json)
      }

      const override: OpenAIUsageOverride = {
        accessToken,
        refreshToken,
        accountId: codexAccountId,
        idToken: typeof snapshot?.tokens?.id_token === 'string' ? snapshot.tokens.id_token : undefined,
        email: account.email
      }

      const result = await fetchOpenAIUsage(override)

      let rotationPersistError: string | null = null
      if (result.rotated) {
        try {
          await updateCodexTokens(account.accountKey, result.rotated)
        } catch (persistError) {
          const message = persistError instanceof Error ? persistError.message : String(persistError)
          log.warn(
            'Failed to persist rotated Codex tokens; keeping the successful usage fetch result',
            { accountId, error: message }
          )
          rotationPersistError = `failed to persist rotated tokens: ${message}`
        }
      }

      if (!result.success || !result.data) {
        const message = result.error ?? 'OpenAI usage fetch failed'
        const needsLogin = result.needsLogin === true || isOpenAIStaleError(message)
        const status: SavedUsageStatus = needsLogin ? 'stale' : 'error'
        db.updateSavedUsageAccountUsage(accountId, {
          last_usage_json: row.last_usage_json,
          status,
          last_error: message
        })
        return {
          success: false,
          error: message,
          status,
          ...(needsLogin ? { needsLogin: true } : {})
        }
      }

      db.updateSavedUsageAccountUsage(accountId, {
        last_usage_json: JSON.stringify(result.data),
        status: 'ok',
        last_error: rotationPersistError
      })
      return { success: true, data: result.data, status: 'ok' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (isNeedsLoginError(error)) {
        return accountError(accountId, message, 'stale', row.last_usage_json, { needsLogin: true })
      }
      return accountError(accountId, message, 'error', row.last_usage_json)
    }
  })
}

export async function refreshAllForProvider(
  provider: UsageProvider
): Promise<RefreshAllResultItem[]> {
  const accounts = await listSavedAccounts(provider)
  const batchId = randomUUID()
  const startedAt = Date.now()
  const results: RefreshAllResultItem[] = []

  log.info('refreshAllForProvider start', {
    provider,
    batchId,
    accountCount: accounts.length,
    accountIds: accounts.map((account) => account.id)
  })

  for (const account of accounts) {
    log.info('refreshAllForProvider account start', { provider, batchId, accountId: account.id })
    try {
      const result = await fetchForSavedAccount(account.id, {
        caller: 'refreshAllForProvider',
        batchId
      })
      const item = {
        accountId: account.id,
        success: result.success,
        error: result.error,
        retryAfter: result.retryAfter
      }
      results.push(item)

      if (result.success) {
        log.info('refreshAllForProvider account success', {
          provider,
          batchId,
          accountId: account.id
        })
      } else {
        log.warn('refreshAllForProvider account failure', {
          provider,
          batchId,
          accountId: account.id,
          error: result.error,
          retryAfter: result.retryAfter
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      results.push({ accountId: account.id, success: false, error: message })
      log.warn('refreshAllForProvider account failure', {
        provider,
        batchId,
        accountId: account.id,
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

export type RefreshTokensRef = { num: string; email: string } | { accountKey: string }

function markCacheRowStale(provider: SavedUsageProvider, email: string, message: string): void {
  const db = getDatabase()
  const row = db.getSavedUsageAccountByProviderEmail(provider, email)
  if (!row) return
  db.updateSavedUsageAccountUsage(row.id, {
    last_usage_json: row.last_usage_json,
    status: 'stale',
    last_error: message
  })
}

/**
 * Token-only refresh for the account-maintenance watcher (and any other
 * caller that only needs fresh tokens, not a usage fetch). Never launches a
 * browser/login flow — a rejected refresh token is reported as `needsLogin`
 * for the caller to act on.
 */
export function refreshTokensForStoreAccount(
  provider: UsageProvider,
  ref: RefreshTokensRef
): Promise<'refreshed' | 'needsLogin' | 'error'> {
  if (provider === 'anthropic') {
    const { num, email } = ref as { num: string; email: string }
    return withAccountLock(accountLockKey('anthropic', email), () =>
      refreshClaudeTokensLocked(num, email)
    )
  }

  const { accountKey } = ref as { accountKey: string }
  return resolveCodexEmailForLock(accountKey)
    .then((email) =>
      withAccountLock(accountLockKey('openai', email), () => refreshCodexTokensLocked(accountKey))
    )
    .catch((error) => {
      log.warn('refreshTokensForStoreAccount failed', {
        provider,
        error: error instanceof Error ? error.message : String(error)
      })
      return 'error' as const
    })
}

async function resolveCodexEmailForLock(accountKey: string): Promise<string> {
  const accounts = await listCodexAccounts()
  return accounts.find((account) => account.accountKey === accountKey)?.email ?? accountKey
}

async function refreshClaudeTokensLocked(
  num: string,
  email: string
): Promise<'refreshed' | 'needsLogin' | 'error'> {
  try {
    const effective = await readClaudeEffectiveBlob(num, email)
    const refreshToken = effective?.parsed.refreshToken
    if (!refreshToken) {
      markCacheRowStale('anthropic', email, 'No refresh token available')
      return 'needsLogin'
    }

    // An earlier lock holder may have already refreshed this account's token
    // while we were waiting for the lock — re-check expiry before hitting the
    // network again.
    const expiresAt = effective?.parsed.expiresAt
    if (typeof expiresAt === 'number' && expiresAt - Date.now() >= REFRESH_RECHECK_THRESHOLD_MS) {
      return 'refreshed'
    }

    const outcome = await refreshAnthropicToken(refreshToken)
    if (!outcome.ok) {
      markCacheRowStale('anthropic', email, `Token refresh failed: ${outcome.error}`)
      return 'needsLogin'
    }

    await updateClaudeTokens(num, email, outcome.result, outcome.scope)
    return 'refreshed'
  } catch (error) {
    log.warn('refreshTokensForStoreAccount failed', {
      provider: 'anthropic',
      error: error instanceof Error ? error.message : String(error)
    })
    return 'error'
  }
}

async function refreshCodexTokensLocked(
  accountKey: string
): Promise<'refreshed' | 'needsLogin' | 'error'> {
  try {
    const snapshot = await readCodexEffectiveAuth(accountKey)
    const refreshToken = snapshot?.tokens?.refresh_token
    if (!refreshToken) {
      await markCodexCacheRowStale(accountKey, 'No refresh token available')
      return 'needsLogin'
    }

    // An earlier lock holder may have already refreshed this account's token
    // while we were waiting for the lock — re-check expiry before hitting the
    // network again.
    const accessToken = snapshot?.tokens?.access_token
    const expiresAtMs = typeof accessToken === 'string' ? jwtExpMs(accessToken) : null
    if (typeof expiresAtMs === 'number' && expiresAtMs - Date.now() >= REFRESH_RECHECK_THRESHOLD_MS) {
      return 'refreshed'
    }

    const outcome = await refreshOpenAIToken(refreshToken)
    if (!outcome.ok) {
      await markCodexCacheRowStale(accountKey, `Token refresh failed: ${outcome.error}`)
      return 'needsLogin'
    }

    await updateCodexTokens(accountKey, outcome.result)
    return 'refreshed'
  } catch (error) {
    log.warn('refreshTokensForStoreAccount failed', {
      provider: 'openai',
      error: error instanceof Error ? error.message : String(error)
    })
    return 'error'
  }
}

async function markCodexCacheRowStale(accountKey: string, message: string): Promise<void> {
  const accounts = await listCodexAccounts()
  const account = accounts.find((a) => a.accountKey === accountKey)
  if (!account) return
  markCacheRowStale('openai', account.email, message)
}

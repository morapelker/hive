/**
 * Boot-time + background account maintenance for the ccswitch-compatible
 * account stores: runs the one-time credentials migration, does a one-shot
 * "launch mass refresh" of every managed account, then keeps tokens fresh
 * with a low-frequency expiry watcher. Never launches a browser/login flow —
 * a refresh that needs a human to log back in is left for the renderer
 * (Phase 6) to notice via the cached account's `stale` status.
 *
 * It also drives the organization learner (claude-organization-learner.ts):
 * once the launch mass refresh is over, every minute, and on request, the
 * Claude accounts that still have no organization stored are asked for it.
 * That runs beside the watcher, never inside a tick, so a slow request there
 * cannot hold up a token refresh.
 */
import { getDatabase } from '../db'
import { listClaudeAccounts, readClaudeEffectiveBlob, type ClaudeStoreAccount } from './account-store-claude'
import { listCodexAccounts, readCodexEffectiveAuth, type CodexStoreAccount } from './account-store-codex'
import { getClaudeOrganizationLearner } from './claude-organization-learner'
import { migrateSavedCredentialsToStores } from './credentials-migration'
import { createLogger } from './logger'
import {
  fetchForSavedAccount,
  refreshAllForProvider,
  refreshTokensForStoreAccount
} from './saved-usage-orchestrator'

const log = createLogger({ component: 'AccountMaintenance' })

const TICK_INTERVAL_MS = 60_000
const EXPIRY_THRESHOLD_MS = 120_000
const BASE_ERROR_BACKOFF_MS = 5 * 60_000
const MAX_ERROR_BACKOFF_MS = 30 * 60_000

type BackoffState =
  | { kind: 'needsLogin'; failingRefreshToken: string }
  | { kind: 'error'; backoffMs: number; nextAttemptAt: number }

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isExpiringSoon(hasRefresh: boolean, expiresAtMs: number | null, now: number): boolean {
  return hasRefresh && expiresAtMs !== null && expiresAtMs - now < EXPIRY_THRESHOLD_MS
}

/**
 * Whether a candidate account should be attempted this tick, given its
 * current backoff state and the CURRENT refresh token on record (used to
 * detect that a previously-failing `needsLogin` token has since changed —
 * e.g. the account was re-added or refreshed by another process).
 */
function shouldAttempt(
  backoff: Map<string, BackoffState>,
  key: string,
  now: number,
  currentRefreshToken: string | undefined
): boolean {
  const entry = backoff.get(key)
  if (!entry) return true

  if (entry.kind === 'needsLogin') {
    if (currentRefreshToken !== undefined && currentRefreshToken !== entry.failingRefreshToken) {
      backoff.delete(key)
      return true
    }
    return false
  }

  return now >= entry.nextAttemptAt
}

function recordOutcome(
  backoff: Map<string, BackoffState>,
  key: string,
  outcome: 'refreshed' | 'needsLogin' | 'error',
  currentRefreshToken: string | undefined
): void {
  if (outcome === 'refreshed') {
    backoff.delete(key)
    return
  }

  if (outcome === 'needsLogin') {
    backoff.set(key, { kind: 'needsLogin', failingRefreshToken: currentRefreshToken ?? '' })
    return
  }

  const previous = backoff.get(key)
  const previousBackoffMs = previous?.kind === 'error' ? previous.backoffMs : 0
  const backoffMs =
    previousBackoffMs === 0
      ? BASE_ERROR_BACKOFF_MS
      : Math.min(previousBackoffMs * 2, MAX_ERROR_BACKOFF_MS)
  backoff.set(key, { kind: 'error', backoffMs, nextAttemptAt: Date.now() + backoffMs })
}

async function readCurrentClaudeRefreshToken(num: string, email: string): Promise<string | undefined> {
  const effective = await readClaudeEffectiveBlob(num, email)
  return effective?.parsed.refreshToken
}

async function readCurrentCodexRefreshToken(accountKey: string): Promise<string | undefined> {
  const auth = await readCodexEffectiveAuth(accountKey)
  return auth?.tokens?.refresh_token
}

/**
 * Self-heal pass for one provider: a cache row stuck on `stale` whose store
 * credentials now carry a comfortably-unexpired access token was refreshed by
 * another process after the failure that flagged it (typically the `claude`
 * CLI rotating the live entry mid-session) — re-fetch usage so the flag can
 * clear itself instead of sticking until relaunch or a manual Refresh.
 * Genuinely-dead accounts keep an expired access token and are never
 * retried here. Shares the watcher's backoff map (a failed heal backs off;
 * a needsLogin outcome parks until the refresh token changes).
 */
async function healStaleRows(
  backoff: Map<string, BackoffState>,
  provider: 'anthropic' | 'openai',
  accounts: Array<{ key: string; email: string; expiresAtMs: number | null; refreshToken: () => Promise<string | undefined> }>,
  now: number
): Promise<void> {
  const rows = getDatabase().getSavedUsageAccountsByProvider(provider)
  for (const row of rows) {
    if (row.status !== 'stale') continue

    const account = accounts.find((a) => a.email === row.email.toLowerCase())
    if (!account) continue
    if (account.expiresAtMs === null || account.expiresAtMs - now < EXPIRY_THRESHOLD_MS) continue

    const key = `heal:${provider}:${account.key}`
    const currentRefreshToken = await account.refreshToken()
    if (!shouldAttempt(backoff, key, now, currentRefreshToken)) continue

    log.info('Retrying stale account with fresh-looking credentials', {
      provider,
      email: account.email
    })
    const result = await fetchForSavedAccount(row.id, { caller: 'usage:fetchForAccount' }).catch(
      (error): { success: false; error: string; status: 'error'; needsLogin?: boolean } => {
        log.warn('Stale-account heal fetch threw', { provider, email: account.email, error: message(error) })
        return { success: false, error: message(error), status: 'error' }
      }
    )
    const outcome = result.success
      ? ('refreshed' as const)
      : result.needsLogin === true
        ? ('needsLogin' as const)
        : ('error' as const)
    recordOutcome(backoff, key, outcome, currentRefreshToken)
    log[outcome === 'refreshed' ? 'info' : 'warn']('Stale-account heal outcome', {
      provider,
      email: account.email,
      outcome
    })
  }
}

function claudeHealCandidates(accounts: ClaudeStoreAccount[]): Array<{
  key: string
  email: string
  expiresAtMs: number | null
  refreshToken: () => Promise<string | undefined>
}> {
  return accounts.map((account) => ({
    key: account.num,
    email: account.email,
    expiresAtMs: account.expiresAtMs,
    refreshToken: () => readCurrentClaudeRefreshToken(account.num, account.email)
  }))
}

function codexHealCandidates(accounts: CodexStoreAccount[]): Array<{
  key: string
  email: string
  expiresAtMs: number | null
  refreshToken: () => Promise<string | undefined>
}> {
  return accounts.map((account) => ({
    key: account.accountKey,
    email: account.email,
    expiresAtMs: account.expiresAtMs,
    refreshToken: () => readCurrentCodexRefreshToken(account.accountKey)
  }))
}

async function tick(backoff: Map<string, BackoffState>): Promise<void> {
  const now = Date.now()

  const claudeAccounts = await listClaudeAccounts().catch((error) => {
    log.warn('Failed to list Claude accounts for expiry check', { error: message(error) })
    return []
  })

  for (const account of claudeAccounts) {
    if (!isExpiringSoon(account.hasRefresh, account.expiresAtMs, now)) continue

    const key = `anthropic:${account.num}`
    const currentRefreshToken = await readCurrentClaudeRefreshToken(account.num, account.email)
    if (!shouldAttempt(backoff, key, now, currentRefreshToken)) continue

    log.info('Refreshing expiring Claude account token', { num: account.num, email: account.email })
    const outcome = await refreshTokensForStoreAccount('anthropic', {
      num: account.num,
      email: account.email
    }).catch((error) => {
      log.warn('Claude token refresh threw', { num: account.num, error: message(error) })
      return 'error' as const
    })
    recordOutcome(backoff, key, outcome, currentRefreshToken)
    log[outcome === 'error' ? 'warn' : 'info']('Claude account refresh outcome', {
      num: account.num,
      email: account.email,
      outcome
    })
  }

  await healStaleRows(backoff, 'anthropic', claudeHealCandidates(claudeAccounts), now).catch(
    (error) => {
      log.warn('Stale-account heal pass failed', { provider: 'anthropic', error: message(error) })
    }
  )

  const codexAccounts = await listCodexAccounts().catch((error) => {
    log.warn('Failed to list Codex accounts for expiry check', { error: message(error) })
    return []
  })

  for (const account of codexAccounts) {
    if (!isExpiringSoon(account.hasRefresh, account.expiresAtMs, now)) continue

    const key = `openai:${account.accountKey}`
    const currentRefreshToken = await readCurrentCodexRefreshToken(account.accountKey)
    if (!shouldAttempt(backoff, key, now, currentRefreshToken)) continue

    log.info('Refreshing expiring Codex account token', {
      accountKey: account.accountKey,
      email: account.email
    })
    const outcome = await refreshTokensForStoreAccount('openai', {
      accountKey: account.accountKey
    }).catch((error) => {
      log.warn('Codex token refresh threw', { accountKey: account.accountKey, error: message(error) })
      return 'error' as const
    })
    recordOutcome(backoff, key, outcome, currentRefreshToken)
    log[outcome === 'error' ? 'warn' : 'info']('Codex account refresh outcome', {
      accountKey: account.accountKey,
      email: account.email,
      outcome
    })
  }

  await healStaleRows(backoff, 'openai', codexHealCandidates(codexAccounts), now).catch((error) => {
    log.warn('Stale-account heal pass failed', { provider: 'openai', error: message(error) })
  })
}

async function runLaunchMassRefresh(): Promise<void> {
  try {
    await migrateSavedCredentialsToStores()
  } catch (error) {
    log.warn('Launch-time credentials migration failed', { error: message(error) })
  }

  try {
    await refreshAllForProvider('anthropic')
  } catch (error) {
    log.warn('Launch-time mass refresh failed', { provider: 'anthropic', error: message(error) })
  }

  try {
    await refreshAllForProvider('openai')
  } catch (error) {
    log.warn('Launch-time mass refresh failed', { provider: 'openai', error: message(error) })
  }
}

/** Set while account maintenance runs: asks the organization learner for a sweep. */
let learnOrganizations: (() => void) | null = null

/**
 * Organizations are needed now (the live usage updater in the main process
 * saw a reading for an organization no account is mapped to): learn them for
 * the Claude accounts that have none. Returns at once. Does nothing where
 * account maintenance was not started (tests, the server run on its own), and
 * nothing while the launch mass refresh is still polling every account, which
 * teaches the same thing and is followed by a sweep of its own.
 */
export function requestClaudeOrganizationLearning(): void {
  learnOrganizations?.()
}

/**
 * Starts account maintenance: fires the one-shot migration + launch mass
 * refresh (never blocking the caller), then a `setInterval` expiry watcher.
 * Returns a cleanup function that stops the watcher.
 */
export function startAccountMaintenance(): () => void {
  const backoff = new Map<string, BackoffState>()
  let inTick = false

  // The launch poll is the first teacher (it stores the organization each
  // response names); the learner only asks for the accounts it left without.
  let launchRefreshDone = false
  let stopped = false
  const sweepOrganizations = (): void => {
    if (!launchRefreshDone || stopped) return
    void getClaudeOrganizationLearner().sweep()
  }
  learnOrganizations = sweepOrganizations

  void runLaunchMassRefresh().finally(() => {
    launchRefreshDone = true
    sweepOrganizations()
  })

  const interval = setInterval(() => {
    sweepOrganizations()
    if (inTick) {
      log.warn('Skipping account maintenance tick: previous tick is still running')
      return
    }
    inTick = true
    void tick(backoff)
      .catch((error) => {
        log.warn('Account maintenance tick failed', { error: message(error) })
      })
      .finally(() => {
        inTick = false
      })
  }, TICK_INTERVAL_MS)
  interval.unref?.()

  return () => {
    stopped = true
    clearInterval(interval)
    if (learnOrganizations === sweepOrganizations) learnOrganizations = null
  }
}

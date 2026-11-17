/**
 * Gives every managed Claude account the organization its requests are billed
 * to (`saved_usage_accounts.org_uuid`), using that account's own credential.
 * Live usage read from a Code Mode session's debug log names an organization
 * and nothing else, so an account without one cannot be credited.
 *
 * Two ways, both in the server child, where the accounts' credentials are used:
 *
 *  1. The usage poll. Every successful `/api/oauth/usage` response names the
 *     organization in a header, and the poll already runs for every account at
 *     launch and for a new account right after sign-in. The saved-account poll
 *     stores what it reads through `storeClaudeAccountOrganization` below: no
 *     extra request, ever.
 *
 *  2. This learner, for the accounts the poll left without one (it failed, it
 *     is backing off, the row was created without a poll or recreated). It
 *     asks for the account's profile (`fetchClaudeProfileOrganization`), a
 *     request of its own that leaves the poll's clock, its rate limit and the
 *     account's row alone. It runs after the launch poll, once a minute from
 *     account maintenance, and when the live updater in the main process says
 *     organizations are needed.
 *
 * An account whose organization is stored is never asked about: the learner
 * only looks at rows with none. A failure stores nothing, is not shown to
 * anyone, and is retried with back-off, however often a sweep is asked for.
 * So is an account that cannot be asked at all (signed out, its token about
 * to expire): the learner never refreshes a token, it waits for the watcher.
 */
import { getDatabase } from '../db'
import { normalizeOrgUuid } from '../db/types'
import { accountLockKey, withAccountLock } from './account-lock'
import { listClaudeAccounts, readClaudeEffectiveBlob } from './account-store-claude'
import { shortOrganizationId } from './claude-organization-id'
import { createLogger } from './logger'
import { emitClaudeOrganizationLearned } from './usage/claude-organization-signal'
import {
  fetchClaudeProfileOrganization,
  type ClaudeProfileOrganizationResult
} from './usage-service'

const log = createLogger({ component: 'ClaudeOrganizationLearner' })

/** The wait after an account's first failed request; doubled by each further failure. */
export const ORGANIZATION_LEARN_BASE_BACKOFF_MS = 5 * 60_000
/** The longest wait between two requests for one account. */
export const ORGANIZATION_LEARN_MAX_BACKOFF_MS = 6 * 60 * 60_000
/** After a 429, nothing is asked for any account for at least this long. */
export const ORGANIZATION_LEARN_RATE_LIMIT_PAUSE_MS = 60_000
/** The longest a `retry-after` is believed. */
const MAX_RETRY_AFTER_MS = 24 * 60 * 60_000
/** A token this close to expiry is left to the token watcher; the request waits for the new one. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000

export interface ClaudeOrganizationLearnerAccount {
  /** The saved usage account's row id. */
  id: string
  email: string
}

export interface ClaudeOrganizationLearnerCredential {
  accessToken: string
  /** Epoch ms; undefined when the store does not say. */
  expiresAt?: number
}

interface LearnerLog {
  info: (message: string, data?: Record<string, unknown>) => void
  warn: (message: string, data?: Record<string, unknown>) => void
}

export interface ClaudeOrganizationLearnerDeps {
  /** The saved Claude accounts with no organization stored, read fresh on every sweep. */
  listAccountsWithoutOrganization: () => ClaudeOrganizationLearnerAccount[]
  /**
   * The access token to ask with, or null when the account is no longer in
   * the account store or has no token. Must not refresh anything.
   */
  readCredential: (
    account: ClaudeOrganizationLearnerAccount
  ) => Promise<ClaudeOrganizationLearnerCredential | null>
  /** The one request this learner makes. Must not throw. */
  fetchOrganization: (accessToken: string) => Promise<ClaudeProfileOrganizationResult>
  /** Store it for the account. False when nothing was written (the row is gone or has one by now). */
  storeOrganization: (
    account: ClaudeOrganizationLearnerAccount,
    organizationUuid: string
  ) => boolean
  now?: () => number
  log?: LearnerLog
}

interface Backoff {
  failures: number
  nextAttemptAt: number
}

export class ClaudeOrganizationLearner {
  private readonly backoff = new Map<string, Backoff>()
  private readonly now: () => number
  private readonly log: LearnerLog
  private pausedUntil = 0
  private running: Promise<void> | null = null

  constructor(private readonly deps: ClaudeOrganizationLearnerDeps) {
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? log
  }

  /**
   * Learn the organization of every account that has none and is due. Safe to
   * call as often as wanted: a call during a sweep joins it, an account that
   * failed is left alone until its back-off is over, and an account with an
   * organization costs nothing. Never rejects.
   */
  sweep(): Promise<void> {
    this.running ??= this.run()
      .catch((error) => {
        this.log.warn('Learning Claude account organizations failed', {
          error: error instanceof Error ? error.message : String(error)
        })
      })
      .finally(() => {
        this.running = null
      })
    return this.running
  }

  private async run(): Promise<void> {
    const accounts = this.deps.listAccountsWithoutOrganization()

    // Forget the accounts that have an organization by now, or are gone: one
    // that loses it later (its row recreated) starts from a clean slate.
    const waiting = new Set(accounts.map((account) => account.id))
    for (const id of [...this.backoff.keys()]) {
      if (!waiting.has(id)) this.backoff.delete(id)
    }

    for (const account of accounts) {
      if (this.now() < this.pausedUntil) return
      const state = this.backoff.get(account.id)
      if (state && this.now() < state.nextAttemptAt) continue
      await this.learn(account)
    }
  }

  /** Whether the account is still without an organization (earlier requests of this sweep took time). */
  private stillWaiting(account: ClaudeOrganizationLearnerAccount): boolean {
    return this.deps
      .listAccountsWithoutOrganization()
      .some((candidate) => candidate.id === account.id)
  }

  private async learn(account: ClaudeOrganizationLearnerAccount): Promise<void> {
    // An account that cannot be asked right now (no token, one that is about
    // to expire, a Keychain that cannot be read) waits like one that failed:
    // reading its credential takes the account's lock and the Keychain, which
    // is not something to repeat every minute for an account that is signed out.
    let credential: ClaudeOrganizationLearnerCredential | null
    try {
      credential = await this.deps.readCredential(account)
    } catch (error) {
      this.log.warn('Could not read the credential of a Claude account to learn its organization', {
        accountId: account.id,
        error: error instanceof Error ? error.message : String(error)
      })
      this.backOff(account, 'credential-unreadable')
      return
    }
    if (credential === null) {
      this.backOff(account, 'no-credential')
      return
    }
    if (
      credential.expiresAt !== undefined &&
      credential.expiresAt - this.now() < TOKEN_EXPIRY_MARGIN_MS
    ) {
      this.backOff(account, 'token-expiring')
      return
    }
    // A poll or proxied traffic may have stored it since the sweep began.
    if (!this.stillWaiting(account)) return

    const result = await this.deps.fetchOrganization(credential.accessToken)
    if (!result.ok) {
      this.backOff(account, result.reason, result.status, result.retryAfter)
      return
    }

    if (this.deps.storeOrganization(account, result.organizationUuid)) {
      this.backoff.delete(account.id)
      this.log.info('Learned the organization of a Claude account from its profile', {
        accountId: account.id,
        organization: shortOrganizationId(result.organizationUuid)
      })
      return
    }
    // Not written. Usually because the row has one by now or is gone, and then
    // the next sweep no longer lists it. If it is still waiting, the write
    // failed: do not ask again every minute for an answer that cannot be kept.
    if (this.stillWaiting(account)) this.backOff(account, 'not-stored')
    else this.backoff.delete(account.id)
  }

  private backOff(
    account: ClaudeOrganizationLearnerAccount,
    reason: string,
    status?: number,
    retryAfter?: number
  ): void {
    const failures = (this.backoff.get(account.id)?.failures ?? 0) + 1
    let delayMs = Math.min(
      ORGANIZATION_LEARN_BASE_BACKOFF_MS * 2 ** Math.min(failures - 1, 20),
      ORGANIZATION_LEARN_MAX_BACKOFF_MS
    )
    if (reason === 'rate-limited') {
      // The server said when to come back: never sooner, for this account, and
      // nothing for the others meanwhile (the limit may not be per account).
      const retryAfterMs = Math.min((retryAfter ?? 0) * 1000, MAX_RETRY_AFTER_MS)
      delayMs = Math.max(delayMs, retryAfterMs)
      this.pausedUntil = this.now() + Math.max(retryAfterMs, ORGANIZATION_LEARN_RATE_LIMIT_PAUSE_MS)
    }
    this.backoff.set(account.id, { failures, nextAttemptAt: this.now() + delayMs })
    this.log.info('Could not learn the organization of a Claude account; will retry later', {
      accountId: account.id,
      reason,
      status,
      failures,
      retryInMs: delayMs
    })
  }
}

/**
 * Store the organization `organizationUuid` for a saved Claude account and
 * tell the main process, whose live updater may be holding a reading for it.
 * Writes, logs and signals only when the stored value changes; returns
 * whether it did. `replace: false` keeps a value that is already there (for a
 * source that only fills gaps). Never throws: learning an organization must
 * not fail the poll it rode on.
 */
export function storeClaudeAccountOrganization(
  account: ClaudeOrganizationLearnerAccount,
  organizationUuid: string,
  options: { replace?: boolean } = {}
): boolean {
  try {
    const organization = normalizeOrgUuid(organizationUuid)
    if (organization === null) return false
    const db = getDatabase()
    const previous = normalizeOrgUuid(db.getSavedUsageAccountOrgUuid(account.id))
    if (previous === organization) return false
    if (previous !== null && options.replace === false) return false
    const saved = db.setSavedUsageAccountOrgUuid(account.id, organization)
    if (saved === null) return false
    if (previous !== null) {
      log.info('The organization of a Claude account changed', {
        accountId: account.id,
        organization: shortOrganizationId(organization),
        previous: shortOrganizationId(previous)
      })
    }
    emitClaudeOrganizationLearned(account.email)
    return true
  } catch (error) {
    log.warn('Failed to store the organization of a Claude account', {
      accountId: account.id,
      error: error instanceof Error ? error.message : String(error)
    })
    return false
  }
}

let learner: ClaudeOrganizationLearner | null = null

/** The app's learner, on the real database, account store and network. */
export function getClaudeOrganizationLearner(): ClaudeOrganizationLearner {
  learner ??= new ClaudeOrganizationLearner({
    listAccountsWithoutOrganization: () =>
      getDatabase()
        .getSavedUsageAccountOrganizations('anthropic')
        .filter((row) => normalizeOrgUuid(row.org_uuid) === null)
        .map((row) => ({ id: row.id, email: row.email })),
    readCredential: async (account) => {
      const email = account.email.toLowerCase()
      const stored = (await listClaudeAccounts()).find((candidate) => candidate.email === email)
      if (!stored) return null
      // Under the account's lock, and only for the read: a switch holds this
      // lock while it moves credentials, so the token read here is this
      // account's, and the request that follows blocks nobody.
      return withAccountLock(accountLockKey('anthropic', email), async () => {
        const effective = await readClaudeEffectiveBlob(stored.num, stored.email)
        const accessToken = effective?.parsed.accessToken
        if (!accessToken) return null
        return { accessToken, expiresAt: effective.parsed.expiresAt }
      })
    },
    fetchOrganization: fetchClaudeProfileOrganization,
    // Fills a gap only: a value a poll or proxied traffic stored while the
    // request was under way is the newer word.
    storeOrganization: (account, organizationUuid) =>
      storeClaudeAccountOrganization(account, organizationUuid, { replace: false })
  })
  return learner
}

/** Tests only: forget the learner and its back-off. */
export function __resetClaudeOrganizationLearnerForTests(): void {
  learner = null
}

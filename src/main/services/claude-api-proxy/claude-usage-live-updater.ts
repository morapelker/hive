/**
 * Turns proxied Anthropic exchanges into per-account usage updates.
 *
 * For every response that carries `anthropic-ratelimit-unified-*` headers:
 * 1. identify the account the request was BILLED to: the managed account
 *    whose access token the request carried (compared by SHA-256 fingerprint).
 *    Not the `account_uuid` the client reports in `metadata.user_id` — a
 *    running CLI adopts the new account's token from the Keychain after an
 *    account switch but keeps stamping its requests with the account it
 *    started on, so that uuid would credit the new account's usage to the old
 *    one. The reported uuid is only a last resort, for environments where no
 *    token can be read to compare against;
 * 2. merge the header windows into that account's cached usage row (keeping
 *    the polled-only fields: extra usage, per-model windows the headers lack)
 *    WITHOUT touching the row's poll bookkeeping (`last_fetched_at`,
 *    `status`), which the refresh sweeps key their decisions on;
 * 3. decide, against the CLI's own identity file, whether this is the account
 *    currently signed in, and push a `usage:claudeLive` event so the renderer
 *    updates that account's bar immediately — and the bottom bar only when it
 *    is the live account.
 *
 * Updates for one credential are coalesced (leading + trailing edge) because
 * a session with parallel subagents can answer several requests per second.
 */
import {
  CLAUDE_LIVE_USAGE_CHANNEL,
  type ClaudeLiveUsagePayload
} from '@shared/types/claude-live-usage'
import type { AnthropicRateLimitWindow, UsageData } from '@shared/types/usage'
import type { SavedUsageAccount } from '../../db/types'
import {
  extractClaudeAccountUuid,
  mergeUnifiedSnapshotIntoUsage,
  parseUnifiedRateLimitHeaders,
  snapshotHasUsage,
  type UnifiedRateLimitSnapshot,
  type UnifiedRateLimitWindow
} from './anthropic-rate-limit-headers'
import type { LocalApiProxyExchange } from './local-api-proxy'

export interface ClaudeUsageObservation {
  /** SHA-256 of the credential the request carried — what the API billed. */
  credentialFingerprint: string | null
  /** The uuid the client reported in the body; may lag an account switch. */
  accountUuid: string | null
  snapshot: UnifiedRateLimitSnapshot
  observedAt: number
}

/** What the updater needs to know about each managed account. */
export interface ClaudeAccountIdentity {
  email: string
  uuid: string
  /** SHA-256 of the account's current access token, when it could be read. */
  tokenFingerprint: string | null
}

export interface ClaudeLiveIdentity {
  email: string | null
  uuid: string | null
}

export interface ClaudeUsageLiveUpdaterDeps {
  /**
   * `notOlderThan` (epoch ms) rejects a memoised list scanned before that
   * moment — a token nobody recognises was probably rotated since.
   */
  listManagedAccounts: (options?: { notOlderThan?: number }) => Promise<ClaudeAccountIdentity[]>
  /** The CLI's identity file (`oauthAccount.{emailAddress,accountUuid}`), read fresh. */
  readLiveIdentity: () => Promise<ClaudeLiveIdentity>
  /** Fingerprint of the access token in the live credentials, if readable. */
  readLiveTokenFingerprint: () => Promise<string | null>
  /** Whether `email` is in the managed index — a cheap check, no Keychain traffic. */
  isAccountManaged: (email: string) => Promise<boolean>
  /**
   * Register the live account in the managed store when a request belongs to
   * it but nothing manages it yet (mirrors the poll path's capture). Returns
   * false when that was impossible (no live credentials to back it up).
   */
  ensureLiveAccountManaged: (email: string, uuid: string) => Promise<boolean>
  /** Persist the uuid onto a managed account that was registered without one. */
  rememberAccountUuid: (email: string, uuid: string) => Promise<boolean>
  readUsageRow: (email: string) => SavedUsageAccount | null
  /**
   * Replace ONLY the cached usage snapshot of the account's row (creating the
   * row when missing). Must leave `last_fetched_at`/`status`/`last_error`
   * alone — they describe the last usage-endpoint poll.
   */
  writeLiveUsage: (email: string, usage: UsageData) => SavedUsageAccount
  publish: (channel: string, payload: ClaudeLiveUsagePayload) => Promise<boolean> | boolean
  log: {
    debug: (message: string, data?: Record<string, unknown>) => void
    info: (message: string, data?: Record<string, unknown>) => void
    warn: (message: string, data?: Record<string, unknown>) => void
  }
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/** Minimum spacing between two published updates for the same credential. */
export const LIVE_USAGE_COALESCE_MS = 250
/** How long a credential → account (or uuid → account) resolution is trusted. */
const RESOLUTION_TTL_MS = 10 * 60_000
/**
 * A resolution that has not been confirmed yet — a first live-credential
 * pairing, or a token seen under two accounts at once — is re-checked soon.
 */
const AMBIGUOUS_RESOLUTION_TTL_MS = 15_000
/**
 * How long an unrecognised credential is not looked up again: short at first
 * (a rotation is usually visible within seconds), backing off for one that
 * stays unknown (an env-provided token or API key the app will never place)
 * so it cannot keep the Keychain busy for a whole session.
 */
const UNKNOWN_CREDENTIAL_TTL_MS = 5_000
const UNKNOWN_CREDENTIAL_MAX_TTL_MS = 5 * 60_000
/** A memo-bypassing rescan reads every account's Keychain entry; keep it rare. */
const FORCED_RESCAN_MIN_INTERVAL_MS = 10_000
/** Re-log an unattributable request at most this often. */
const UNRESOLVED_LOG_TTL_MS = 10 * 60_000
const MAX_CACHED_RESOLUTIONS = 500

/**
 * Pure: the usage observation an exchange carries, or null when it carries
 * none (no unified headers) or nothing to attribute it by (neither a
 * credential nor a reported `account_uuid`).
 */
export function observationFromExchange(
  exchange: Pick<
    LocalApiProxyExchange,
    'responseHeaders' | 'requestBody' | 'observedAt' | 'credentialFingerprint'
  >
): ClaudeUsageObservation | null {
  const snapshot = parseUnifiedRateLimitHeaders(exchange.responseHeaders)
  if (snapshot === null || !snapshotHasUsage(snapshot)) return null
  const accountUuid =
    exchange.requestBody === null ? null : extractClaudeAccountUuid(exchange.requestBody)
  const credentialFingerprint = exchange.credentialFingerprint ?? null
  if (credentialFingerprint === null && accountUuid === null) return null
  return { credentialFingerprint, accountUuid, snapshot, observedAt: exchange.observedAt }
}

function parseUsageJson(json: string | null): UsageData | null {
  if (!json) return null
  try {
    const parsed = JSON.parse(json) as UsageData
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * The overlay window for one header window: its own status when present,
 * else the overall verdict when this is the representative window, else
 * `allowed` (which clears a stale rejected overlay once the window resets).
 */
export function rateLimitWindowFromSnapshot(
  window: UnifiedRateLimitWindow | undefined,
  snapshot: UnifiedRateLimitSnapshot,
  claim: 'five_hour' | 'seven_day'
): AnthropicRateLimitWindow | undefined {
  if (window === undefined) return undefined
  const representative = snapshot.representativeClaim === claim
  const resetsAt = window.resetsAt ?? (representative ? snapshot.resetsAt : null)
  if (resetsAt === null) return undefined
  const status = window.status ?? (representative ? snapshot.status : null) ?? 'allowed'
  const overage = snapshot.overage
  return {
    status,
    resetsAt,
    ...(overage.status !== null ? { overageStatus: overage.status } : {})
  }
}

/** Whether `email` is the account currently signed in, per the CLI's identity file. */
export function isLiveAccountEmail(email: string, live: ClaudeLiveIdentity): boolean {
  return live.email !== null && live.email.toLowerCase() === email
}

function coalesceKey(observation: ClaudeUsageObservation): string {
  return observation.credentialFingerprint !== null
    ? `token:${observation.credentialFingerprint}`
    : `uuid:${observation.accountUuid}`
}

interface PendingAccount {
  latest: ClaudeUsageObservation | null
  timer: unknown
}

interface CachedResolution {
  email: string | null
  expiresAt: number
  /** Consecutive failed lookups (unknown credentials only). */
  misses?: number
}

type Attribution = { email: string; via: 'token' | 'reported-uuid' }

export class ClaudeUsageLiveUpdater {
  private readonly deps: ClaudeUsageLiveUpdaterDeps
  private readonly pending = new Map<string, PendingAccount>()
  private readonly tokenOwners = new Map<string, CachedResolution>()
  private readonly uuidOwners = new Map<string, CachedResolution>()
  private readonly unresolvedLoggedAt = new Map<string, number>()
  private readonly announced = new Set<string>()
  private lastForcedRescanAt = 0
  private chain: Promise<void> = Promise.resolve()

  constructor(deps: ClaudeUsageLiveUpdaterDeps) {
    this.deps = deps
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  /** Entry point for the proxy: cheap triage, then coalesced async apply. */
  handleExchange(exchange: LocalApiProxyExchange): void {
    const observation = observationFromExchange(exchange)
    if (observation === null) return
    this.observe(observation)
  }

  observe(observation: ClaudeUsageObservation): void {
    const key = coalesceKey(observation)
    const pending = this.pending.get(key)
    if (pending === undefined) {
      // Leading edge: apply right away, then hold further updates for a beat.
      const entry: PendingAccount = { latest: null, timer: null }
      this.pending.set(key, entry)
      entry.timer = this.schedule(() => this.flush(key), LIVE_USAGE_COALESCE_MS)
      this.enqueue(observation)
      return
    }
    // Trailing edge: remember only the newest observation.
    if (pending.latest === null || observation.observedAt >= pending.latest.observedAt) {
      pending.latest = observation
    }
  }

  private flush(key: string): void {
    const pending = this.pending.get(key)
    if (pending === undefined) return
    const latest = pending.latest
    if (latest === null) {
      this.pending.delete(key)
      return
    }
    pending.latest = null
    pending.timer = this.schedule(() => this.flush(key), LIVE_USAGE_COALESCE_MS)
    this.enqueue(latest)
  }

  private schedule(fn: () => void, ms: number): unknown {
    if (this.deps.setTimer) return this.deps.setTimer(fn, ms)
    const handle = setTimeout(fn, ms)
    handle.unref?.()
    return handle
  }

  private enqueue(observation: ClaudeUsageObservation): void {
    this.chain = this.chain
      .then(() => this.apply(observation))
      .catch((error) => {
        this.deps.log.warn('Failed to apply live Claude usage update', {
          accountUuid: observation.accountUuid,
          error: error instanceof Error ? error.message : String(error)
        })
      })
  }

  /** Resolves once every observation handed in so far has been applied. */
  settle(): Promise<void> {
    return this.chain
  }

  dispose(): void {
    for (const pending of this.pending.values()) {
      if (pending.timer !== null) {
        if (this.deps.clearTimer) this.deps.clearTimer(pending.timer)
        else clearTimeout(pending.timer as ReturnType<typeof setTimeout>)
      }
    }
    this.pending.clear()
  }

  private remember(
    cache: Map<string, CachedResolution>,
    key: string,
    email: string | null,
    ttlMs: number,
    misses?: number
  ): void {
    if (cache.size >= MAX_CACHED_RESOLUTIONS && !cache.has(key)) cache.clear()
    cache.set(key, { email, expiresAt: this.now() + ttlMs, ...(misses ? { misses } : {}) })
  }

  private async attribute(
    observation: ClaudeUsageObservation,
    live: ClaudeLiveIdentity
  ): Promise<Attribution | null> {
    const fingerprint = observation.credentialFingerprint
    if (fingerprint !== null) {
      const cached = this.tokenOwners.get(fingerprint)
      if (cached !== undefined && cached.expiresAt > this.now()) {
        return cached.email === null ? null : { email: cached.email, via: 'token' }
      }
      const misses = cached !== undefined && cached.email === null ? (cached.misses ?? 0) : 0
      // Only the first miss pays for a full rescan; a credential that stays
      // unknown is re-checked against the (cheap) memo and live entry only.
      const byToken = await this.lookupByToken(
        fingerprint,
        live,
        misses === 0,
        cached?.email ?? null
      )
      if (byToken.email !== null) {
        this.remember(
          this.tokenOwners,
          fingerprint,
          byToken.email,
          byToken.ambiguous ? AMBIGUOUS_RESOLUTION_TTL_MS : RESOLUTION_TTL_MS
        )
        return { email: byToken.email, via: 'token' }
      }
      if (byToken.tokensReadable) {
        // Tokens can be compared here and this one belongs to no account we
        // know. Never guess from the client-reported uuid in that case: it is
        // exactly what goes stale across an account switch.
        const ttlMs = Math.min(
          UNKNOWN_CREDENTIAL_TTL_MS * 4 ** misses,
          UNKNOWN_CREDENTIAL_MAX_TTL_MS
        )
        this.remember(this.tokenOwners, fingerprint, null, ttlMs, misses + 1)
        return null
      }
    }

    // No credential on the request, or no token is readable in this
    // environment to compare against: the reported uuid is all there is.
    if (observation.accountUuid === null) return null
    const email = await this.resolveByReportedUuid(observation.accountUuid, live)
    return email === null ? null : { email, via: 'reported-uuid' }
  }

  /**
   * @param previouslyResolvedEmail what an earlier (now expired) lookup of
   *   this same credential concluded, if anything. A live-credential match is
   *   trusted for the full TTL only once two lookups agree: the live token and
   *   the identity file are written by an account switch a few milliseconds
   *   apart, so a single read can pair the incoming account's token with the
   *   outgoing account's identity. The first pairing is therefore short-lived
   *   (re-checked in seconds) and a mismatch with the previous answer resets
   *   the clock.
   */
  private async lookupByToken(
    fingerprint: string,
    live: ClaudeLiveIdentity,
    allowRescan: boolean,
    previouslyResolvedEmail: string | null
  ): Promise<{ email: string | null; ambiguous: boolean; tokensReadable: boolean }> {
    // Fast path — the live credentials. Nearly every request carries the
    // signed-in account's token, and comparing against it costs one Keychain
    // read instead of one per managed account. It is also the freshest view of
    // that token (the CLI may have refreshed it since any list was memoised)
    // and the only view of a live account nothing manages yet.
    const liveFingerprint = await this.deps.readLiveTokenFingerprint()
    let identity = live
    if (liveFingerprint !== null && liveFingerprint === fingerprint && live.email) {
      // The token is the live one; make sure the identity it was paired with
      // did not change while it was being read (an account switch completing
      // mid-lookup), or the token would be credited to the account just left.
      const confirmed = await this.deps.readLiveIdentity()
      const email = live.email.toLowerCase()
      identity = confirmed
      if (confirmed.email !== null && confirmed.email.toLowerCase() === email) {
        const agreedTwice = previouslyResolvedEmail === email
        if (!(await this.deps.isAccountManaged(email))) {
          // Register a live account nothing manages yet — but only once the
          // pairing has held across two lookups: in a half-applied switch
          // the live blob already belongs to the incoming account while the
          // identity still names the outgoing one, and capturing then would
          // file the wrong credentials under the wrong email.
          if (!agreedTwice) return { email, ambiguous: true, tokensReadable: true }
          const added = await this.deps.ensureLiveAccountManaged(email, live.uuid ?? '')
          if (!added) return { email: null, ambiguous: false, tokensReadable: true }
          this.deps.log.info('Captured the live Claude account into the managed store', { email })
        }
        return { email, ambiguous: !agreedTwice, tokensReadable: true }
      }
    }

    // Not the live token: a request still in flight on another account (the
    // one just switched away from), which only the managed list can place.
    // Wall clock on purpose (not the injectable `now`): it is compared with
    // the moment the account store's own scan started.
    const startedAt = Date.now()
    let managed = await this.deps.listManagedAccounts()
    let owner = this.ownerOf(managed, fingerprint, identity)
    if (owner !== null) return { ...owner, tokensReadable: true }

    // A token nobody recognises is usually one that was rotated since the
    // list was memoised (the app's own maintenance, or another process).
    // Only a memo that predates this lookup is rescanned: when the call above
    // built it, a second sweep of every Keychain entry could find nothing new.
    if (allowRescan && this.now() - this.lastForcedRescanAt >= FORCED_RESCAN_MIN_INTERVAL_MS) {
      this.lastForcedRescanAt = this.now()
      managed = await this.deps.listManagedAccounts({ notOlderThan: startedAt })
      owner = this.ownerOf(managed, fingerprint, identity)
      if (owner !== null) return { ...owner, tokensReadable: true }
    }

    const tokensReadable =
      liveFingerprint !== null || managed.some((account) => account.tokenFingerprint !== null)
    return { email: null, ambiguous: false, tokensReadable }
  }

  /**
   * The managed account holding `fingerprint`. Normally exactly one; a list
   * read in the instant an account switch is half-applied can show the live
   * token under two accounts, in which case the signed-in one owns it and the
   * answer is flagged so it is not trusted for long.
   */
  private ownerOf(
    managed: ClaudeAccountIdentity[],
    fingerprint: string,
    live: ClaudeLiveIdentity
  ): { email: string; ambiguous: boolean } | null {
    const owners = managed.filter((account) => account.tokenFingerprint === fingerprint)
    if (owners.length === 0) return null
    if (owners.length === 1) return { email: owners[0].email.toLowerCase(), ambiguous: false }
    const liveEmail = live.email?.toLowerCase()
    const liveOwner = owners.find((account) => account.email.toLowerCase() === liveEmail)
    return { email: (liveOwner ?? owners[0]).email.toLowerCase(), ambiguous: true }
  }

  private async resolveByReportedUuid(
    accountUuid: string,
    live: ClaudeLiveIdentity
  ): Promise<string | null> {
    const cached = this.uuidOwners.get(accountUuid)
    if (cached !== undefined && cached.expiresAt > this.now()) return cached.email

    const email = await this.lookupByReportedUuid(accountUuid, live)
    this.remember(
      this.uuidOwners,
      accountUuid,
      email,
      email === null ? UNKNOWN_CREDENTIAL_TTL_MS : RESOLUTION_TTL_MS
    )
    return email
  }

  private async lookupByReportedUuid(
    accountUuid: string,
    live: ClaudeLiveIdentity
  ): Promise<string | null> {
    const managed = await this.deps.listManagedAccounts()
    const byUuid = managed.find((account) => account.uuid.toLowerCase() === accountUuid)
    if (byUuid !== undefined && byUuid.email) return byUuid.email.toLowerCase()

    // Not in the managed index by uuid — the live login is the usual reason
    // (first run, or a legacy entry registered with an empty uuid). The
    // identity file the CLI itself maintains names both the email and the uuid.
    if (live.uuid !== null && live.uuid.toLowerCase() === accountUuid && live.email) {
      const email = live.email.toLowerCase()
      const managedByEmail = managed.find((account) => account.email.toLowerCase() === email)
      if (managedByEmail === undefined) {
        const added = await this.deps.ensureLiveAccountManaged(email, live.uuid)
        if (!added) return null
        this.deps.log.info('Captured the live Claude account into the managed store', { email })
      } else if (managedByEmail.uuid === '') {
        // Backfill so a later switch writes the right uuid into the identity file.
        if (await this.deps.rememberAccountUuid(email, live.uuid)) {
          this.deps.log.info('Recorded the uuid of a legacy Claude account', { email })
        }
      }
      return email
    }
    return null
  }

  private async apply(observation: ClaudeUsageObservation): Promise<void> {
    // Read fresh every time: an account switch rewrites this file before the
    // switch reports success, so it is the race-free source of "who is live".
    const live = await this.deps.readLiveIdentity()
    const attribution = await this.attribute(observation, live)
    if (attribution === null) {
      const key = coalesceKey(observation)
      const loggedAt = this.unresolvedLoggedAt.get(key)
      if (loggedAt === undefined || this.now() - loggedAt > UNRESOLVED_LOG_TTL_MS) {
        if (this.unresolvedLoggedAt.size >= MAX_CACHED_RESOLUTIONS) this.unresolvedLoggedAt.clear()
        this.unresolvedLoggedAt.set(key, this.now())
        this.deps.log.info('Live Claude usage for an account this app does not manage; ignoring', {
          accountUuid: observation.accountUuid,
          hasCredential: observation.credentialFingerprint !== null
        })
      }
      return
    }
    const { email } = attribution

    const previousRow = this.deps.readUsageRow(email)
    const previousUsage = parseUsageJson(previousRow?.last_usage_json ?? null)
    const usage = mergeUnifiedSnapshotIntoUsage(previousUsage, observation.snapshot)
    const row = this.deps.writeLiveUsage(email, usage)

    const payload: ClaudeLiveUsagePayload = {
      provider: 'anthropic',
      accountId: row.id,
      email,
      accountUuid: observation.accountUuid,
      isLiveAccount: isLiveAccountEmail(email, live),
      liveEmail: live.email ? live.email.toLowerCase() : null,
      usage,
      rateLimit: {
        fiveHour: rateLimitWindowFromSnapshot(
          observation.snapshot.fiveHour,
          observation.snapshot,
          'five_hour'
        ),
        sevenDay: rateLimitWindowFromSnapshot(
          observation.snapshot.sevenDay,
          observation.snapshot,
          'seven_day'
        )
      },
      observedAt: observation.observedAt
    }

    if (!this.announced.has(email)) {
      this.announced.add(email)
      this.deps.log.info('Live Claude usage attributed', { email, via: attribution.via })
    }
    this.deps.log.debug('Live Claude usage update', {
      email,
      via: attribution.via,
      live: payload.isLiveAccount,
      fiveHour: usage.five_hour.utilization,
      sevenDay: usage.seven_day.utilization,
      status: observation.snapshot.status,
      claim: observation.snapshot.representativeClaim
    })
    await this.deps.publish(CLAUDE_LIVE_USAGE_CHANNEL, payload)
  }
}

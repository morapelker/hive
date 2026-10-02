/**
 * Turns proxied Anthropic exchanges into per-account usage updates.
 *
 * For every response that carries `anthropic-ratelimit-unified-*` headers:
 * 1. read the `account_uuid` Claude Code put in the request body — that is
 *    the account the usage belongs to, even when the user has since switched
 *    accounts and this session is still streaming on the old credentials;
 * 2. map it to a managed account (sequence.json `uuid`, else the live
 *    identity file), i.e. to the `saved_usage_accounts` row the popover shows;
 * 3. merge the header windows into that row's cached usage (keeping the
 *    polled-only fields: extra usage, per-model windows the headers lack) —
 *    WITHOUT touching the row's poll bookkeeping (`last_fetched_at`,
 *    `status`), which the refresh sweeps key their decisions on;
 * 4. decide, against the CLI's own identity file, whether this is the account
 *    currently signed in, and push a `usage:claudeLive` event so the renderer
 *    updates that account's bar immediately — and the bottom bar only when it
 *    is the live account.
 *
 * Updates for one account are coalesced (leading + trailing edge) because a
 * session with parallel subagents can answer several requests per second.
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
  accountUuid: string
  snapshot: UnifiedRateLimitSnapshot
  observedAt: number
}

/** The one piece of identity the updater needs per managed account. */
export interface ClaudeAccountIdentity {
  email: string
  uuid: string
}

export interface ClaudeLiveIdentity {
  email: string | null
  uuid: string | null
}

export interface ClaudeUsageLiveUpdaterDeps {
  listManagedAccounts: () => Promise<ClaudeAccountIdentity[]>
  /** The CLI's identity file (`oauthAccount.{emailAddress,accountUuid}`), read fresh. */
  readLiveIdentity: () => Promise<ClaudeLiveIdentity>
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

/** Minimum spacing between two published updates for the same account. */
export const LIVE_USAGE_COALESCE_MS = 250
/** How long a uuid → email resolution is trusted before re-reading the stores. */
const RESOLUTION_TTL_MS = 30_000
/** Re-log an unattributable uuid at most this often. */
const UNRESOLVED_LOG_TTL_MS = 10 * 60_000

/**
 * Pure: the usage observation an exchange carries, or null when it carries
 * none (no unified headers, no `account_uuid`, body not captured).
 */
export function observationFromExchange(
  exchange: Pick<LocalApiProxyExchange, 'responseHeaders' | 'requestBody' | 'observedAt'>
): ClaudeUsageObservation | null {
  const snapshot = parseUnifiedRateLimitHeaders(exchange.responseHeaders)
  if (snapshot === null || !snapshotHasUsage(snapshot)) return null
  if (exchange.requestBody === null) return null
  const accountUuid = extractClaudeAccountUuid(exchange.requestBody)
  if (accountUuid === null) return null
  return { accountUuid, snapshot, observedAt: exchange.observedAt }
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

/**
 * Whether the request's account is the one currently signed in. The identity
 * file's uuid is authoritative when both sides have one; legacy entries can
 * leave it absent, in which case the email decides.
 */
export function isLiveAccountFor(
  accountUuid: string,
  email: string,
  live: ClaudeLiveIdentity
): boolean {
  if (live.uuid) return live.uuid.toLowerCase() === accountUuid.toLowerCase()
  return live.email !== null && live.email.toLowerCase() === email
}

interface PendingAccount {
  latest: ClaudeUsageObservation | null
  timer: unknown
}

export class ClaudeUsageLiveUpdater {
  private readonly deps: ClaudeUsageLiveUpdaterDeps
  private readonly pending = new Map<string, PendingAccount>()
  private readonly resolutions = new Map<string, { email: string | null; expiresAt: number }>()
  private readonly unresolvedLoggedAt = new Map<string, number>()
  private readonly announced = new Set<string>()
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
    const key = observation.accountUuid
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

  private async resolveEmail(
    accountUuid: string,
    live: ClaudeLiveIdentity
  ): Promise<string | null> {
    const cached = this.resolutions.get(accountUuid)
    if (cached !== undefined && cached.expiresAt > this.now()) return cached.email

    const email = await this.lookupEmail(accountUuid, live)
    this.resolutions.set(accountUuid, { email, expiresAt: this.now() + RESOLUTION_TTL_MS })
    return email
  }

  private async lookupEmail(accountUuid: string, live: ClaudeLiveIdentity): Promise<string | null> {
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
        // Backfill so the primary lookup works from now on (and so a later
        // switch writes the right uuid into the identity file).
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
    const email = await this.resolveEmail(observation.accountUuid, live)
    if (email === null) {
      const loggedAt = this.unresolvedLoggedAt.get(observation.accountUuid)
      if (loggedAt === undefined || this.now() - loggedAt > UNRESOLVED_LOG_TTL_MS) {
        this.unresolvedLoggedAt.set(observation.accountUuid, this.now())
        this.deps.log.info('Live Claude usage for an account this app does not manage; ignoring', {
          accountUuid: observation.accountUuid
        })
      }
      return
    }

    const previousRow = this.deps.readUsageRow(email)
    const previousUsage = parseUsageJson(previousRow?.last_usage_json ?? null)
    const usage = mergeUnifiedSnapshotIntoUsage(previousUsage, observation.snapshot)
    const row = this.deps.writeLiveUsage(email, usage)

    const payload: ClaudeLiveUsagePayload = {
      provider: 'anthropic',
      accountId: row.id,
      email,
      accountUuid: observation.accountUuid,
      isLiveAccount: isLiveAccountFor(observation.accountUuid, email, live),
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
      this.deps.log.info('Live Claude usage attributed', { email })
    }
    this.deps.log.debug('Live Claude usage update', {
      email,
      live: payload.isLiveAccount,
      fiveHour: usage.five_hour.utilization,
      sevenDay: usage.seven_day.utilization,
      status: observation.snapshot.status,
      claim: observation.snapshot.representativeClaim
    })
    await this.deps.publish(CLAUDE_LIVE_USAGE_CHANNEL, payload)
  }
}

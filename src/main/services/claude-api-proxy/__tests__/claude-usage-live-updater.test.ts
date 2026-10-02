// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_LIVE_USAGE_CHANNEL,
  type ClaudeLiveUsagePayload
} from '@shared/types/claude-live-usage'
import type { UsageData } from '@shared/types/usage'
import type { SavedUsageAccount } from '../../../db/types'
import {
  ClaudeUsageLiveUpdater,
  isLiveAccountEmail,
  observationFromExchange,
  rateLimitWindowFromSnapshot,
  type ClaudeAccountIdentity,
  type ClaudeUsageLiveUpdaterDeps
} from '../claude-usage-live-updater'
import { parseUnifiedRateLimitHeaders } from '../anthropic-rate-limit-headers'
import type { LocalApiProxyExchange } from '../local-api-proxy'

const ACCOUNT_A = '718fd88e-2076-4451-bc5f-066158379585'
const ACCOUNT_B = '0d2c9a9e-1f1d-4a8a-9d2c-3a4b5c6d7e8f'
const TOKEN_A = 'fp-token-a'
const TOKEN_B = 'fp-token-b'

function bodyFor(accountUuid: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      model: 'claude-opus-5-5',
      messages: [{ role: 'user', content: 'hello' }],
      metadata: {
        user_id: JSON.stringify({ device_id: 'd', account_uuid: accountUuid, session_id: 's' })
      }
    })
  )
}

interface ExchangeInput {
  /** Fingerprint of the token the request carried (what gets billed). */
  token?: string | null
  /** The account uuid the client reported in the body. */
  reportedUuid?: string | null
  headers?: Record<string, string>
  observedAt?: number
  status?: number
}

const USAGE_HEADERS = {
  'anthropic-ratelimit-unified-5h-utilization': '0.03',
  'anthropic-ratelimit-unified-5h-reset': '1790902800',
  'anthropic-ratelimit-unified-7d-utilization': '0.39',
  'anthropic-ratelimit-unified-7d-reset': '1791036000',
  'anthropic-ratelimit-unified-status': 'allowed',
  'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  'anthropic-ratelimit-unified-reset': '1790902800'
}

function exchange(input: ExchangeInput = {}): LocalApiProxyExchange {
  const reportedUuid = input.reportedUuid === undefined ? ACCOUNT_A : input.reportedUuid
  return {
    method: 'POST',
    path: '/v1/messages?beta=true',
    requestHeaders: {},
    credentialFingerprint: input.token === undefined ? TOKEN_A : input.token,
    requestBody: reportedUuid === null ? null : bodyFor(reportedUuid),
    status: input.status ?? 200,
    responseHeaders: input.headers ?? USAGE_HEADERS,
    observedAt: input.observedAt ?? 1_000,
    latencyMs: 10
  }
}

function row(email: string, usage: UsageData | null, id = `row-${email}`): SavedUsageAccount {
  return {
    id,
    provider: 'anthropic',
    email,
    credentials_json: '',
    last_usage_json: usage ? JSON.stringify(usage) : null,
    last_fetched_at: '2026-01-01T00:00:00.000Z',
    status: 'error',
    last_error: 'poll failed',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z'
  }
}

const accountA = (): ClaudeAccountIdentity => ({
  email: 'a@example.com',
  uuid: ACCOUNT_A,
  tokenFingerprint: TOKEN_A
})
const accountB = (): ClaudeAccountIdentity => ({
  email: 'b@example.com',
  uuid: ACCOUNT_B,
  tokenFingerprint: TOKEN_B
})

interface Harness {
  updater: ClaudeUsageLiveUpdater
  deps: ClaudeUsageLiveUpdaterDeps
  rows: Map<string, SavedUsageAccount>
  managed: ClaudeAccountIdentity[]
  /** What a memo-bypassing rescan returns (defaults to `managed`). */
  fresh: { accounts: ClaudeAccountIdentity[] | null }
  live: { email: string | null; uuid: string | null; tokenFingerprint: string | null }
  published: ClaudeLiveUsagePayload[]
  timers: Array<() => void>
  advance: (ms: number) => void
  runTimers: () => void
}

function makeHarness(
  managed: ClaudeAccountIdentity[],
  live: { email: string | null; uuid: string | null; tokenFingerprint?: string | null } = {
    email: null,
    uuid: null
  },
  seed: SavedUsageAccount[] = []
): Harness {
  const rows = new Map(seed.map((r) => [r.email, r]))
  const published: ClaudeLiveUsagePayload[] = []
  const timers: Array<() => void> = []
  const liveState = { tokenFingerprint: null, ...live }
  const fresh: { accounts: ClaudeAccountIdentity[] | null } = { accounts: null }
  let now = 1_000_000
  const deps: ClaudeUsageLiveUpdaterDeps = {
    listManagedAccounts: vi.fn(async (options?: { notOlderThan?: number }) =>
      options?.notOlderThan !== undefined && fresh.accounts !== null ? fresh.accounts : managed
    ),
    readLiveIdentity: vi.fn(async () => ({ email: liveState.email, uuid: liveState.uuid })),
    readLiveTokenFingerprint: vi.fn(async () => liveState.tokenFingerprint),
    isAccountManaged: vi.fn(async (email: string) =>
      managed.some((account) => account.email.toLowerCase() === email)
    ),
    ensureLiveAccountManaged: vi.fn(async (email: string, uuid: string) => {
      managed.push({ email, uuid, tokenFingerprint: liveState.tokenFingerprint })
      return true
    }),
    rememberAccountUuid: vi.fn(async (email: string, uuid: string) => {
      const entry = managed.find((account) => account.email === email)
      if (!entry || entry.uuid !== '') return false
      entry.uuid = uuid
      return true
    }),
    readUsageRow: vi.fn((email: string) => rows.get(email) ?? null),
    writeLiveUsage: vi.fn((email: string, usage: UsageData) => {
      const existing = rows.get(email) ?? row(email, null)
      // Like the real DB method: only the snapshot changes.
      const next = { ...existing, last_usage_json: JSON.stringify(usage) }
      rows.set(email, next)
      return next
    }),
    publish: vi.fn(async (_channel: string, payload: ClaudeLiveUsagePayload) => {
      published.push(payload)
      return true
    }),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    now: () => now,
    setTimer: (fn) => {
      timers.push(fn)
      return fn
    },
    clearTimer: (handle) => {
      const index = timers.indexOf(handle as () => void)
      if (index !== -1) timers.splice(index, 1)
    }
  }
  const updater = new ClaudeUsageLiveUpdater(deps)
  return {
    updater,
    deps,
    rows,
    managed,
    fresh,
    live: liveState,
    published,
    timers,
    advance: (ms) => {
      now += ms
    },
    runTimers: () => {
      now += 250
      const due = timers.splice(0, timers.length)
      due.forEach((fn) => fn())
    }
  }
}

describe('observationFromExchange', () => {
  it('needs usage headers plus something to attribute by (credential or reported uuid)', () => {
    const observation = observationFromExchange(exchange())
    expect(observation?.credentialFingerprint).toBe(TOKEN_A)
    expect(observation?.accountUuid).toBe(ACCOUNT_A)
    expect(observation?.snapshot.fiveHour?.utilizationPercent).toBe(3)

    // A credential alone is enough (no captured body)...
    expect(observationFromExchange(exchange({ reportedUuid: null }))?.accountUuid).toBeNull()
    // ...and so is a reported uuid alone...
    expect(observationFromExchange(exchange({ token: null }))?.credentialFingerprint).toBeNull()
    // ...but neither is not.
    expect(observationFromExchange(exchange({ token: null, reportedUuid: null }))).toBeNull()

    expect(
      observationFromExchange(exchange({ headers: { 'content-type': 'application/json' } }))
    ).toBeNull()
    // A temporary-throttle 429 (no unified headers) is not usage.
    expect(
      observationFromExchange(exchange({ headers: { 'x-should-retry': 'true' }, status: 429 }))
    ).toBeNull()
  })
})

describe('rateLimitWindowFromSnapshot', () => {
  it('uses the window status, falls back to the representative verdict, else allowed', () => {
    const rejected = parseUnifiedRateLimitHeaders({
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-representative-claim': 'five_hour',
      'anthropic-ratelimit-unified-reset': '1790902800',
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-7d-utilization': '0.4',
      'anthropic-ratelimit-unified-7d-reset': '1791036000',
      'anthropic-ratelimit-unified-overage-status': 'rejected'
    })!
    expect(rateLimitWindowFromSnapshot(rejected.fiveHour, rejected, 'five_hour')).toEqual({
      status: 'rejected',
      resetsAt: 1790902800,
      overageStatus: 'rejected'
    })
    expect(rateLimitWindowFromSnapshot(rejected.sevenDay, rejected, 'seven_day')).toEqual({
      status: 'allowed',
      resetsAt: 1791036000,
      overageStatus: 'rejected'
    })
    expect(rateLimitWindowFromSnapshot(undefined, rejected, 'seven_day')).toBeUndefined()
  })
})

describe('isLiveAccountEmail', () => {
  it('compares against the identity file email, case-insensitively', () => {
    expect(isLiveAccountEmail('a@example.com', { email: 'A@Example.com', uuid: null })).toBe(true)
    expect(isLiveAccountEmail('a@example.com', { email: 'b@example.com', uuid: ACCOUNT_A })).toBe(
      false
    )
    expect(isLiveAccountEmail('a@example.com', { email: null, uuid: ACCOUNT_A })).toBe(false)
  })
})

describe('ClaudeUsageLiveUpdater', () => {
  it('attributes by the token the request carried, merges into that account row only', async () => {
    const previous: UsageData = {
      five_hour: { utilization: 80, resets_at: '2026-10-01T00:00:00.000Z' },
      seven_day: { utilization: 10, resets_at: '2026-10-02T00:00:00.000Z' },
      extra_usage: { is_enabled: true, utilization: 5, used_credits: 2, monthly_limit: 20 },
      scoped: [{ label: 'Fable', used_percent: 33, resets_at: null }]
    }
    const harness = makeHarness(
      [accountA(), accountB()],
      { email: 'b@example.com', uuid: ACCOUNT_B },
      [row('a@example.com', previous, 'row-a'), row('b@example.com', null, 'row-b')]
    )

    // A request still in flight on account A's token after the switch to B.
    harness.updater.handleExchange(exchange({ token: TOKEN_A, reportedUuid: ACCOUNT_A }))
    await harness.updater.settle()

    expect(harness.deps.writeLiveUsage).toHaveBeenCalledTimes(1)
    expect(harness.rows.get('b@example.com')?.last_usage_json).toBeNull()
    const rowA = harness.rows.get('a@example.com')!
    const merged = JSON.parse(rowA.last_usage_json!) as UsageData
    expect(merged.five_hour).toEqual({ utilization: 3, resets_at: '2026-10-02T01:00:00.000Z' })
    expect(merged.seven_day).toEqual({ utilization: 39, resets_at: '2026-10-03T14:00:00.000Z' })
    expect(merged.extra_usage).toEqual(previous.extra_usage)
    expect(merged.scoped).toEqual(previous.scoped)
    // Poll bookkeeping untouched.
    expect(rowA.status).toBe('error')
    expect(rowA.last_fetched_at).toBe('2026-01-01T00:00:00.000Z')

    expect(harness.deps.publish).toHaveBeenCalledWith(CLAUDE_LIVE_USAGE_CHANNEL, expect.anything())
    expect(harness.published).toHaveLength(1)
    const payload = harness.published[0]
    expect(payload.accountId).toBe('row-a')
    expect(payload.email).toBe('a@example.com')
    expect(payload.accountUuid).toBe(ACCOUNT_A)
    expect(payload.isLiveAccount).toBe(false)
    expect(payload.liveEmail).toBe('b@example.com')
    expect(payload.usage).toEqual(merged)
    expect(payload.rateLimit).toEqual({
      fiveHour: { status: 'allowed', resetsAt: 1790902800 },
      sevenDay: { status: 'allowed', resetsAt: 1791036000 }
    })
    expect(payload.observedAt).toBe(1_000)
  })

  it('credits the NEW account when a running session adopts its token but still reports the old uuid', async () => {
    // Switched A -> B mid-prompt: the CLI re-read the Keychain and now sends
    // B's token (so B is billed and the headers are B's), while the request
    // body still says account_uuid = A.
    const usageA: UsageData = {
      five_hour: { utilization: 85, resets_at: '2026-10-02T01:00:00.000Z' },
      seven_day: { utilization: 60, resets_at: '2026-10-03T14:00:00.000Z' }
    }
    const harness = makeHarness(
      [accountA(), accountB()],
      { email: 'b@example.com', uuid: ACCOUNT_B },
      [row('a@example.com', usageA, 'row-a'), row('b@example.com', null, 'row-b')]
    )

    harness.updater.handleExchange(exchange({ token: TOKEN_B, reportedUuid: ACCOUNT_A }))
    await harness.updater.settle()

    // Account A's row keeps its own numbers...
    expect(JSON.parse(harness.rows.get('a@example.com')!.last_usage_json!)).toEqual(usageA)
    // ...B gets B's usage, and it is the live account, so the bar follows.
    expect(harness.published).toHaveLength(1)
    expect(harness.published[0].email).toBe('b@example.com')
    expect(harness.published[0].accountId).toBe('row-b')
    expect(harness.published[0].isLiveAccount).toBe(true)
    expect(harness.published[0].usage.five_hour.utilization).toBe(3)
  })

  it('never falls back to the reported uuid for a token it cannot place', async () => {
    const harness = makeHarness([accountA(), accountB()], {
      email: 'a@example.com',
      uuid: ACCOUNT_A
    })

    harness.updater.handleExchange(exchange({ token: 'fp-unknown', reportedUuid: ACCOUNT_A }))
    await harness.updater.settle()

    expect(harness.deps.writeLiveUsage).not.toHaveBeenCalled()
    expect(harness.published).toHaveLength(0)
    expect(harness.deps.log.info).toHaveBeenCalledWith(
      expect.stringContaining('does not manage'),
      expect.objectContaining({ hasCredential: true })
    )
  })

  it('recognises a just-rotated token by rescanning past the memo, at most once per interval', async () => {
    const harness = makeHarness([accountA(), accountB()], {
      email: 'b@example.com',
      uuid: ACCOUNT_B
    })
    harness.fresh.accounts = [accountA(), { ...accountB(), tokenFingerprint: 'fp-token-b2' }]

    harness.updater.handleExchange(exchange({ token: 'fp-token-b2', reportedUuid: ACCOUNT_B }))
    await harness.updater.settle()
    expect(harness.deps.listManagedAccounts).toHaveBeenCalledWith({
      notOlderThan: expect.any(Number)
    })
    expect(harness.published[0]?.email).toBe('b@example.com')

    // A different unknown token right away does not trigger another full rescan.
    vi.mocked(harness.deps.listManagedAccounts).mockClear()
    harness.updater.handleExchange(exchange({ token: 'fp-stranger', reportedUuid: ACCOUNT_B }))
    await harness.updater.settle()
    expect(harness.deps.listManagedAccounts).not.toHaveBeenCalledWith({
      notOlderThan: expect.any(Number)
    })
    expect(harness.published).toHaveLength(1)
  })

  it('backs off on a credential that stays unknown instead of rescanning the Keychain', async () => {
    const harness = makeHarness([accountA()], { email: 'a@example.com', uuid: ACCOUNT_A })
    const send = async (): Promise<void> => {
      harness.updater.handleExchange(exchange({ token: 'fp-env-token', reportedUuid: ACCOUNT_A }))
      await harness.updater.settle()
      harness.runTimers()
      harness.runTimers()
    }
    const lookups = (): number => vi.mocked(harness.deps.readLiveTokenFingerprint).mock.calls.length
    const rescans = (): number =>
      vi
        .mocked(harness.deps.listManagedAccounts)
        .mock.calls.filter(([options]) => options?.notOlderThan !== undefined).length

    await send()
    expect(lookups()).toBe(1)
    expect(rescans()).toBe(1)

    // Within the first 5s window: answered from the negative cache.
    harness.advance(3_000)
    await send()
    expect(lookups()).toBe(1)

    // After it: one cheap re-check, no second full rescan, and a longer wait next.
    harness.advance(3_000)
    await send()
    expect(lookups()).toBe(2)
    expect(rescans()).toBe(1)
    harness.advance(10_000)
    await send()
    expect(lookups()).toBe(2)
    harness.advance(11_000)
    await send()
    expect(lookups()).toBe(3)
    expect(rescans()).toBe(1)
    expect(harness.published).toHaveLength(0)
  })

  it('gives a token seen under two accounts to the signed-in one, and re-checks soon', async () => {
    // A list read in the instant a switch is half-applied can show the live
    // token under both the outgoing and the incoming account.
    const harness = makeHarness([{ ...accountA(), tokenFingerprint: TOKEN_B }, accountB()], {
      email: 'b@example.com',
      uuid: ACCOUNT_B
    })
    harness.updater.handleExchange(exchange({ token: TOKEN_B, reportedUuid: ACCOUNT_A }))
    await harness.updater.settle()
    expect(harness.published[0]?.email).toBe('b@example.com')

    // The answer is not trusted for the full ten minutes: once the list is
    // consistent again, a lookup shortly after resolves from it afresh.
    harness.managed[0].tokenFingerprint = TOKEN_A
    harness.runTimers()
    harness.runTimers()
    harness.advance(20_000)
    harness.updater.handleExchange(exchange({ token: TOKEN_B, observedAt: 2_000 }))
    await harness.updater.settle()
    expect(harness.deps.listManagedAccounts).toHaveBeenCalledTimes(2)
    expect(harness.published[1]?.email).toBe('b@example.com')
  })

  it('matches the live credentials when the list memo lags a CLI-side refresh', async () => {
    const harness = makeHarness([accountA(), accountB()], {
      email: 'b@example.com',
      uuid: ACCOUNT_B,
      tokenFingerprint: 'fp-token-b-refreshed'
    })

    harness.updater.handleExchange(
      exchange({ token: 'fp-token-b-refreshed', reportedUuid: ACCOUNT_A })
    )
    await harness.updater.settle()

    expect(harness.published[0]?.email).toBe('b@example.com')
    expect(harness.published[0]?.isLiveAccount).toBe(true)
    expect(harness.deps.ensureLiveAccountManaged).not.toHaveBeenCalled()
  })

  it('places the signed-in account from the live credentials alone, without sweeping every account', async () => {
    const harness = makeHarness([accountA(), accountB()], {
      email: 'b@example.com',
      uuid: ACCOUNT_B,
      tokenFingerprint: TOKEN_B
    })

    harness.updater.handleExchange(exchange({ token: TOKEN_B, reportedUuid: ACCOUNT_A }))
    await harness.updater.settle()

    expect(harness.published[0]?.email).toBe('b@example.com')
    expect(harness.published[0]?.isLiveAccount).toBe(true)
    // One Keychain read for the live entry and a look at the index — the
    // per-account token list was never needed.
    expect(harness.deps.readLiveTokenFingerprint).toHaveBeenCalledTimes(1)
    expect(harness.deps.isAccountManaged).toHaveBeenCalledWith('b@example.com')
    expect(harness.deps.listManagedAccounts).not.toHaveBeenCalled()

    // A first pairing is re-checked after seconds; once a second lookup
    // agrees it is trusted for the long TTL and no further reads happen.
    const sendLater = async (observedAt: number): Promise<void> => {
      harness.runTimers()
      harness.runTimers()
      harness.updater.handleExchange(exchange({ token: TOKEN_B, observedAt }))
      await harness.updater.settle()
    }
    harness.advance(20_000)
    await sendLater(2_000)
    expect(harness.deps.readLiveTokenFingerprint).toHaveBeenCalledTimes(2)
    harness.advance(60_000)
    await sendLater(3_000)
    expect(harness.deps.readLiveTokenFingerprint).toHaveBeenCalledTimes(2)
    expect(harness.deps.listManagedAccounts).not.toHaveBeenCalled()
    expect(harness.published.map((p) => p.email)).toEqual([
      'b@example.com',
      'b@example.com',
      'b@example.com'
    ])
  })

  it('recovers within seconds from a lookup that landed in a half-applied switch', async () => {
    // Switch A -> B: the live Keychain entry already holds B's token while
    // the identity file still names A. A lookup in that gap cannot tell.
    const harness = makeHarness([accountA(), accountB()], {
      email: 'a@example.com',
      uuid: ACCOUNT_A,
      tokenFingerprint: TOKEN_B
    })
    harness.updater.handleExchange(exchange({ token: TOKEN_B, reportedUuid: ACCOUNT_A }))
    await harness.updater.settle()
    expect(harness.published[0]?.email).toBe('a@example.com')

    // The switch completes. The wrong pairing was only trusted briefly: the
    // next lookup disagrees with it, so B's traffic is B's again — and the
    // bar follows, instead of ten minutes of B's usage filed under A.
    harness.live.email = 'b@example.com'
    harness.live.uuid = ACCOUNT_B
    harness.runTimers()
    harness.runTimers()
    harness.advance(20_000)
    harness.updater.handleExchange(exchange({ token: TOKEN_B, observedAt: 2_000 }))
    await harness.updater.settle()
    expect(harness.published[1]?.email).toBe('b@example.com')
    expect(harness.published[1]?.isLiveAccount).toBe(true)
    expect(harness.deps.listManagedAccounts).not.toHaveBeenCalled()
  })

  it('never registers the outgoing account with the incoming account credentials', async () => {
    // Same half-applied switch, but the outgoing account A is unmanaged
    // (signed in via the CLI): capturing in the gap would file B's blob
    // under A's email.
    const harness = makeHarness([accountB()], {
      email: 'a@example.com',
      uuid: ACCOUNT_A,
      tokenFingerprint: TOKEN_B
    })
    harness.updater.handleExchange(exchange({ token: TOKEN_B, reportedUuid: ACCOUNT_A }))
    await harness.updater.settle()
    expect(harness.deps.ensureLiveAccountManaged).not.toHaveBeenCalled()

    harness.live.email = 'b@example.com'
    harness.live.uuid = ACCOUNT_B
    harness.runTimers()
    harness.runTimers()
    harness.advance(20_000)
    harness.updater.handleExchange(exchange({ token: TOKEN_B, observedAt: 2_000 }))
    await harness.updater.settle()
    expect(harness.deps.ensureLiveAccountManaged).not.toHaveBeenCalled()
    expect(harness.published.map((p) => p.email)).toEqual(['a@example.com', 'b@example.com'])
  })

  it('does not trust the live match when the signed-in identity changes mid-lookup', async () => {
    // The token read is the live one, but by the time it was read the
    // identity file names another account (a switch landed in between):
    // pairing the two would credit the token to the wrong account, so the
    // per-account list decides instead.
    const harness = makeHarness([accountA(), accountB()], {
      email: 'a@example.com',
      uuid: ACCOUNT_A,
      tokenFingerprint: TOKEN_B
    })
    vi.mocked(harness.deps.readLiveTokenFingerprint).mockImplementationOnce(async () => {
      harness.live.email = 'b@example.com'
      harness.live.uuid = ACCOUNT_B
      return TOKEN_B
    })

    harness.updater.handleExchange(exchange({ token: TOKEN_B, reportedUuid: ACCOUNT_A }))
    await harness.updater.settle()

    expect(harness.deps.listManagedAccounts).toHaveBeenCalledTimes(1)
    expect(harness.published[0]?.email).toBe('b@example.com')
    expect(harness.rows.get('a@example.com')).toBeUndefined()
  })

  it('captures a live account nothing manages yet, by its live token', async () => {
    const harness = makeHarness([], {
      email: 'Live@Example.com',
      uuid: ACCOUNT_A,
      tokenFingerprint: TOKEN_A
    })

    harness.updater.handleExchange(exchange({ token: TOKEN_A }))
    await harness.updater.settle()

    // First sighting: attributed and published, but not yet registered — the
    // live blob and identity are only trusted together once they have held.
    expect(harness.deps.ensureLiveAccountManaged).not.toHaveBeenCalled()
    expect(harness.published[0]?.email).toBe('live@example.com')
    expect(harness.published[0]?.isLiveAccount).toBe(true)

    harness.runTimers()
    harness.runTimers()
    harness.advance(20_000)
    harness.updater.handleExchange(exchange({ token: TOKEN_A, observedAt: 2_000 }))
    await harness.updater.settle()

    expect(harness.deps.ensureLiveAccountManaged).toHaveBeenCalledTimes(1)
    expect(harness.deps.ensureLiveAccountManaged).toHaveBeenCalledWith(
      'live@example.com',
      ACCOUNT_A
    )
    expect(harness.published[1]?.email).toBe('live@example.com')
    expect(harness.published[0]?.isLiveAccount).toBe(true)
    expect(harness.rows.get('live@example.com')).toBeDefined()
  })

  it('resolves a credential once and reuses the answer', async () => {
    // A non-live token (the live entry is unreadable here) is placed by the
    // per-account list, which is a definite answer: no second lookup needed.
    const harness = makeHarness([accountA()], { email: 'a@example.com', uuid: ACCOUNT_A })
    harness.updater.handleExchange(exchange())
    await harness.updater.settle()
    harness.runTimers()
    harness.runTimers()
    harness.updater.handleExchange(exchange({ observedAt: 2_000 }))
    await harness.updater.settle()

    expect(harness.published).toHaveLength(2)
    expect(harness.deps.listManagedAccounts).toHaveBeenCalledTimes(1)
    // Liveness, however, is re-read from the identity file on every update.
    expect(harness.deps.readLiveIdentity).toHaveBeenCalledTimes(2)
  })

  describe('when no token can be read to compare against', () => {
    const noTokens = (account: ClaudeAccountIdentity): ClaudeAccountIdentity => ({
      ...account,
      tokenFingerprint: null
    })

    it('falls back to the reported uuid', async () => {
      const harness = makeHarness([noTokens(accountA()), noTokens(accountB())], {
        email: 'a@example.com',
        uuid: ACCOUNT_A
      })
      harness.updater.handleExchange(exchange({ token: 'fp-anything', reportedUuid: ACCOUNT_B }))
      await harness.updater.settle()
      expect(harness.published[0]?.email).toBe('b@example.com')
      expect(harness.published[0]?.isLiveAccount).toBe(false)
    })

    it('uses the identity file for a uuid the index lacks, backfilling a legacy entry', async () => {
      const harness = makeHarness(
        [{ email: 'legacy@example.com', uuid: '', tokenFingerprint: null }],
        {
          email: 'legacy@example.com',
          uuid: ACCOUNT_A
        }
      )

      harness.updater.handleExchange(exchange({ token: null, reportedUuid: ACCOUNT_A }))
      await harness.updater.settle()

      expect(harness.deps.rememberAccountUuid).toHaveBeenCalledWith('legacy@example.com', ACCOUNT_A)
      expect(harness.managed[0].uuid).toBe(ACCOUNT_A)
      expect(harness.published[0]?.email).toBe('legacy@example.com')
      expect(harness.published[0]?.isLiveAccount).toBe(true)
    })

    it('ignores a uuid it cannot place', async () => {
      const harness = makeHarness([noTokens(accountA())], {
        email: 'a@example.com',
        uuid: ACCOUNT_A
      })
      harness.updater.handleExchange(exchange({ token: null, reportedUuid: ACCOUNT_B }))
      await harness.updater.settle()
      expect(harness.deps.writeLiveUsage).not.toHaveBeenCalled()
      expect(harness.published).toHaveLength(0)
    })
  })

  it('coalesces a burst per credential: leading edge now, newest trailing edge later', async () => {
    const harness = makeHarness([accountA()])
    const withFiveHour = (value: string, observedAt: number): LocalApiProxyExchange =>
      exchange({
        headers: { ...USAGE_HEADERS, 'anthropic-ratelimit-unified-5h-utilization': value },
        observedAt
      })

    harness.updater.handleExchange(withFiveHour('0.03', 1_000))
    harness.updater.handleExchange(withFiveHour('0.05', 1_010))
    harness.updater.handleExchange(withFiveHour('0.07', 1_020))
    await harness.updater.settle()
    expect(harness.published.map((p) => p.usage.five_hour.utilization)).toEqual([3])

    harness.runTimers()
    await harness.updater.settle()
    expect(harness.published.map((p) => p.usage.five_hour.utilization)).toEqual([3, 7])

    // Quiet period: the trailing timer fires with nothing pending and clears.
    harness.runTimers()
    await harness.updater.settle()
    expect(harness.published).toHaveLength(2)
    expect(harness.timers).toHaveLength(0)
  })

  it('keeps accounts independent when a burst spans two credentials', async () => {
    const harness = makeHarness([accountA(), accountB()])
    harness.updater.handleExchange(exchange({ token: TOKEN_A }))
    harness.updater.handleExchange(exchange({ token: TOKEN_B }))
    await harness.updater.settle()
    expect(harness.published.map((p) => p.email).sort()).toEqual(['a@example.com', 'b@example.com'])
  })

  it('survives a failing store write and keeps serving later updates', async () => {
    const harness = makeHarness([accountA()])
    vi.mocked(harness.deps.writeLiveUsage).mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    harness.updater.handleExchange(exchange())
    await harness.updater.settle()
    expect(harness.deps.log.warn).toHaveBeenCalledWith(
      'Failed to apply live Claude usage update',
      expect.objectContaining({ error: 'disk full' })
    )
    harness.runTimers()
    harness.updater.handleExchange(exchange())
    await harness.updater.settle()
    expect(harness.published).toHaveLength(1)
  })
})

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
  isLiveAccountFor,
  observationFromExchange,
  rateLimitWindowFromSnapshot,
  type ClaudeUsageLiveUpdaterDeps
} from '../claude-usage-live-updater'
import { parseUnifiedRateLimitHeaders } from '../anthropic-rate-limit-headers'
import type { LocalApiProxyExchange } from '../local-api-proxy'

const ACCOUNT_A = '718fd88e-2076-4451-bc5f-066158379585'
const ACCOUNT_B = '0d2c9a9e-1f1d-4a8a-9d2c-3a4b5c6d7e8f'

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

function exchangeFor(
  accountUuid: string | null,
  headers: Record<string, string>,
  overrides: Partial<LocalApiProxyExchange> = {}
): LocalApiProxyExchange {
  return {
    method: 'POST',
    path: '/v1/messages?beta=true',
    requestHeaders: {},
    requestBody: accountUuid === null ? null : bodyFor(accountUuid),
    status: 200,
    responseHeaders: headers,
    observedAt: 1_000,
    latencyMs: 10,
    ...overrides
  }
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

interface Harness {
  updater: ClaudeUsageLiveUpdater
  deps: ClaudeUsageLiveUpdaterDeps
  rows: Map<string, SavedUsageAccount>
  managed: Array<{ email: string; uuid: string }>
  live: { email: string | null; uuid: string | null }
  published: ClaudeLiveUsagePayload[]
  timers: Array<() => void>
  runTimers: () => void
}

function makeHarness(
  managed: Array<{ email: string; uuid: string }>,
  live: { email: string | null; uuid: string | null } = { email: null, uuid: null },
  seed: SavedUsageAccount[] = []
): Harness {
  const rows = new Map(seed.map((r) => [r.email, r]))
  const published: ClaudeLiveUsagePayload[] = []
  const timers: Array<() => void> = []
  let now = 1_000
  const deps: ClaudeUsageLiveUpdaterDeps = {
    listManagedAccounts: vi.fn(async () => managed),
    readLiveIdentity: vi.fn(async () => live),
    ensureLiveAccountManaged: vi.fn(async (email: string, uuid: string) => {
      managed.push({ email, uuid })
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
    live,
    published,
    timers,
    runTimers: () => {
      now += 250
      const due = timers.splice(0, timers.length)
      due.forEach((fn) => fn())
    }
  }
}

describe('observationFromExchange', () => {
  it('yields an observation only when headers carry usage and the body names an account', () => {
    const observation = observationFromExchange(exchangeFor(ACCOUNT_A, USAGE_HEADERS))
    expect(observation?.accountUuid).toBe(ACCOUNT_A)
    expect(observation?.snapshot.fiveHour?.utilizationPercent).toBe(3)

    expect(observationFromExchange(exchangeFor(null, USAGE_HEADERS))).toBeNull()
    expect(
      observationFromExchange(exchangeFor(ACCOUNT_A, { 'content-type': 'application/json' }))
    ).toBeNull()
    // A temporary-throttle 429 (no unified headers) is not usage.
    expect(
      observationFromExchange(exchangeFor(ACCOUNT_A, { 'x-should-retry': 'true' }, { status: 429 }))
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

describe('isLiveAccountFor', () => {
  it('compares uuids when the identity file has one, else emails', () => {
    expect(
      isLiveAccountFor(ACCOUNT_A, 'a@example.com', { email: 'b@example.com', uuid: ACCOUNT_A })
    ).toBe(true)
    expect(
      isLiveAccountFor(ACCOUNT_A, 'a@example.com', { email: 'a@example.com', uuid: ACCOUNT_B })
    ).toBe(false)
    expect(
      isLiveAccountFor(ACCOUNT_A, 'a@example.com', { email: 'A@Example.com', uuid: null })
    ).toBe(true)
    expect(isLiveAccountFor(ACCOUNT_A, 'a@example.com', { email: null, uuid: null })).toBe(false)
  })
})

describe('ClaudeUsageLiveUpdater', () => {
  it('attributes by account uuid, merges into that account row only, and marks it not live', async () => {
    const previous: UsageData = {
      five_hour: { utilization: 80, resets_at: '2026-10-01T00:00:00.000Z' },
      seven_day: { utilization: 10, resets_at: '2026-10-02T00:00:00.000Z' },
      extra_usage: { is_enabled: true, utilization: 5, used_credits: 2, monthly_limit: 20 },
      scoped: [{ label: 'Fable', used_percent: 33, resets_at: null }]
    }
    const harness = makeHarness(
      [
        { email: 'a@example.com', uuid: ACCOUNT_A },
        { email: 'b@example.com', uuid: ACCOUNT_B }
      ],
      { email: 'b@example.com', uuid: ACCOUNT_B },
      [row('a@example.com', previous, 'row-a'), row('b@example.com', null, 'row-b')]
    )

    // The request belongs to account A even though B is the live account.
    harness.updater.handleExchange(exchangeFor(ACCOUNT_A, USAGE_HEADERS))
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

  it('marks the signed-in account live by uuid, re-reading the identity file every time', async () => {
    const harness = makeHarness(
      [
        { email: 'a@example.com', uuid: ACCOUNT_A },
        { email: 'b@example.com', uuid: ACCOUNT_B }
      ],
      { email: 'a@example.com', uuid: ACCOUNT_A }
    )
    harness.updater.handleExchange(exchangeFor(ACCOUNT_A, USAGE_HEADERS))
    await harness.updater.settle()
    expect(harness.published[0].isLiveAccount).toBe(true)

    // The user switches to B: the identity file now names B.
    harness.live.email = 'b@example.com'
    harness.live.uuid = ACCOUNT_B
    harness.runTimers()
    harness.updater.handleExchange(exchangeFor(ACCOUNT_A, USAGE_HEADERS, { observedAt: 2_000 }))
    await harness.updater.settle()
    expect(harness.published[1].isLiveAccount).toBe(false)
    expect(harness.published[1].liveEmail).toBe('b@example.com')
    expect(harness.deps.readLiveIdentity).toHaveBeenCalledTimes(2)
  })

  it('falls back to the live identity and captures an unmanaged live account', async () => {
    const harness = makeHarness([], { email: 'Live@Example.com', uuid: ACCOUNT_A.toUpperCase() })

    harness.updater.handleExchange(exchangeFor(ACCOUNT_A, USAGE_HEADERS))
    await harness.updater.settle()

    expect(harness.deps.ensureLiveAccountManaged).toHaveBeenCalledWith(
      'live@example.com',
      ACCOUNT_A.toUpperCase()
    )
    expect(harness.published[0]?.email).toBe('live@example.com')
    expect(harness.published[0]?.isLiveAccount).toBe(true)
    expect(harness.rows.get('live@example.com')).toBeDefined()
  })

  it('backfills the uuid of a legacy account the identity file names', async () => {
    const harness = makeHarness([{ email: 'legacy@example.com', uuid: '' }], {
      email: 'legacy@example.com',
      uuid: ACCOUNT_A
    })

    harness.updater.handleExchange(exchangeFor(ACCOUNT_A, USAGE_HEADERS))
    await harness.updater.settle()

    expect(harness.deps.rememberAccountUuid).toHaveBeenCalledWith('legacy@example.com', ACCOUNT_A)
    expect(harness.managed[0].uuid).toBe(ACCOUNT_A)
    expect(harness.deps.ensureLiveAccountManaged).not.toHaveBeenCalled()
    expect(harness.published[0]?.email).toBe('legacy@example.com')
  })

  it('ignores accounts it cannot attribute and never writes a row for them', async () => {
    const harness = makeHarness([{ email: 'a@example.com', uuid: ACCOUNT_A }], {
      email: 'a@example.com',
      uuid: ACCOUNT_A
    })

    harness.updater.handleExchange(exchangeFor(ACCOUNT_B, USAGE_HEADERS))
    await harness.updater.settle()

    expect(harness.deps.writeLiveUsage).not.toHaveBeenCalled()
    expect(harness.published).toHaveLength(0)
    expect(harness.deps.log.info).toHaveBeenCalledWith(
      expect.stringContaining('does not manage'),
      expect.objectContaining({ accountUuid: ACCOUNT_B })
    )
  })

  it('coalesces a burst per account: leading edge now, newest trailing edge later', async () => {
    const harness = makeHarness([{ email: 'a@example.com', uuid: ACCOUNT_A }])

    harness.updater.handleExchange(exchangeFor(ACCOUNT_A, USAGE_HEADERS, { observedAt: 1_000 }))
    harness.updater.handleExchange(
      exchangeFor(
        ACCOUNT_A,
        { ...USAGE_HEADERS, 'anthropic-ratelimit-unified-5h-utilization': '0.05' },
        { observedAt: 1_010 }
      )
    )
    harness.updater.handleExchange(
      exchangeFor(
        ACCOUNT_A,
        { ...USAGE_HEADERS, 'anthropic-ratelimit-unified-5h-utilization': '0.07' },
        { observedAt: 1_020 }
      )
    )
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

  it('keeps accounts independent when a burst spans two accounts', async () => {
    const harness = makeHarness([
      { email: 'a@example.com', uuid: ACCOUNT_A },
      { email: 'b@example.com', uuid: ACCOUNT_B }
    ])
    harness.updater.handleExchange(exchangeFor(ACCOUNT_A, USAGE_HEADERS))
    harness.updater.handleExchange(exchangeFor(ACCOUNT_B, USAGE_HEADERS))
    await harness.updater.settle()
    expect(harness.published.map((p) => p.email).sort()).toEqual(['a@example.com', 'b@example.com'])
  })

  it('survives a failing store write and keeps serving later updates', async () => {
    const harness = makeHarness([{ email: 'a@example.com', uuid: ACCOUNT_A }])
    vi.mocked(harness.deps.writeLiveUsage).mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    harness.updater.handleExchange(exchangeFor(ACCOUNT_A, USAGE_HEADERS))
    await harness.updater.settle()
    expect(harness.deps.log.warn).toHaveBeenCalledWith(
      'Failed to apply live Claude usage update',
      expect.objectContaining({ error: 'disk full' })
    )
    harness.runTimers()
    harness.updater.handleExchange(exchangeFor(ACCOUNT_A, USAGE_HEADERS))
    await harness.updater.settle()
    expect(harness.published).toHaveLength(1)
  })
})

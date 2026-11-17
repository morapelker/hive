// @vitest-environment node
import http from 'http'
import type { AddressInfo } from 'net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The live usage updater as the app wires it (a fake database, account store
// and event publisher), fed with and without the proxy.

const dbMocks = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>()
}))

const storeMocks = vi.hoisted(() => ({
  listClaudeAccountTokenFingerprints: vi.fn(
    async () => [] as Array<{ email: string; uuid: string; tokenFingerprint: string | null }>
  ),
  readClaudeLiveTokenFingerprint: vi.fn(async () => null as string | null),
  isClaudeAccountManaged: vi.fn(async () => true),
  readClaudeLiveIdentityCached: vi.fn(async () => ({
    email: null as string | null,
    uuid: null as string | null
  })),
  readClaudeLiveRawBlob: vi.fn(async () => null as string | null),
  addClaudeAccount: vi.fn(async () => '1'),
  rememberClaudeAccountUuid: vi.fn(async () => false),
  repairStaleClaudeLiveIdentityUuid: vi.fn(async () => false)
}))

const publisherMocks = vi.hoisted(() => ({
  publishDesktopBackendEvent: vi.fn(async () => true)
}))

/** How many updaters were ever built: the app must have one, not one per proxy start. */
const updaterMocks = vi.hoisted(() => ({ constructed: 0 }))

vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

vi.mock('../../../db', () => ({
  getDatabase: () => ({
    getSavedUsageAccountByProviderEmail: (_provider: string, email: string) =>
      dbMocks.rows.get(email) ?? null,
    upsertSavedUsageAccount: (data: Record<string, unknown>) => {
      const email = data.email as string
      const row = polledRow(email, null)
      dbMocks.rows.set(email, row)
      return row
    },
    updateSavedUsageAccountLiveUsage: (id: string, lastUsageJson: string) => {
      for (const row of dbMocks.rows.values()) {
        if (row.id === id) {
          row.last_usage_json = lastUsageJson
          return row
        }
      }
      return null
    }
  })
}))

vi.mock('../../account-store-claude', () => storeMocks)

vi.mock('../../../desktop/backend-event-publisher', () => publisherMocks)

vi.mock('../claude-usage-live-updater', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../claude-usage-live-updater')>()
  class CountedUpdater extends actual.ClaudeUsageLiveUpdater {
    constructor(deps: ConstructorParameters<typeof actual.ClaudeUsageLiveUpdater>[0]) {
      super(deps)
      updaterMocks.constructed += 1
    }
  }
  return { ...actual, ClaudeUsageLiveUpdater: CountedUpdater }
})

import type { ClaudeLiveUsagePayload } from '@shared/types/claude-live-usage'
import type { UsageData } from '@shared/types/usage'
import { fingerprintSecret } from '../../credential-fingerprint'
import { parseUnifiedRateLimitHeaders } from '../anthropic-rate-limit-headers'
import {
  closeClaudeApiProxy,
  isClaudeApiProxyRunning,
  startClaudeApiProxy,
  __resetClaudeApiProxyCachesForTests
} from '../claude-api-proxy'
import {
  disposeClaudeUsageLiveUpdater,
  getClaudeUsageLiveUpdater,
  submitClaudeUsageObservation,
  __resetClaudeUsageLiveUpdaterForTests
} from '../claude-usage-live'
import { LIVE_USAGE_COALESCE_MS, type ClaudeUsageObservation } from '../claude-usage-live-updater'

const ME = 'me@example.com'
const OTHER = 'other@example.com'
const UUID_ME = '0d2c9a9e-1f1d-4a8a-9d2c-3a4b5c6d7e8f'
const UUID_OTHER = '718fd88e-2076-4451-bc5f-066158379585'
/** The bearer tokens of the two accounts (made up; only their fingerprints are compared). */
const TOKEN_ME = 'token-of-me'
const TOKEN_OTHER = 'token-of-other'
// Windows far ahead of the clock: 2 Mar 2099 15:00 UTC and 6 Mar 2099 09:00 UTC.
const FIVE_HOUR_RESET = Date.parse('2099-03-02T15:00:00.000Z') / 1000
const WEEKLY_RESET = Date.parse('2099-03-06T09:00:00.000Z') / 1000

const ENV_KEYS = ['ANTHROPIC_BASE_URL', '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL']
const saved: Record<string, string | undefined> = {}

/** A row as a poll of the usage endpoint left it; a live update must keep its poll stamp. */
function polledRow(email: string, usage: UsageData | null): Record<string, unknown> {
  return {
    id: `row-${email}`,
    provider: 'anthropic',
    email,
    credentials_json: '',
    last_usage_json: usage === null ? null : JSON.stringify(usage),
    last_fetched_at: usage === null ? null : 'polled-earlier',
    status: 'ok',
    last_error: null,
    created_at: 'c',
    updated_at: 'u'
  }
}

/** Two managed accounts with a polled row each; `ME` is the one signed in. */
function seedAccounts(): void {
  storeMocks.listClaudeAccountTokenFingerprints.mockResolvedValue([
    { email: OTHER, uuid: UUID_OTHER, tokenFingerprint: fingerprintSecret(TOKEN_OTHER) },
    { email: ME, uuid: UUID_ME, tokenFingerprint: fingerprintSecret(TOKEN_ME) }
  ])
  storeMocks.readClaudeLiveIdentityCached.mockResolvedValue({ email: ME, uuid: UUID_ME })
  for (const email of [ME, OTHER]) {
    dbMocks.rows.set(
      email,
      polledRow(email, {
        five_hour: { utilization: 1, resets_at: null },
        seven_day: { utilization: 2, resets_at: null },
        extra_usage: { is_enabled: true, utilization: 0, used_credits: 0, monthly_limit: 10 }
      })
    )
  }
}

/** The response headers of one exchange, `fiveHour` being the 0..1 fraction on the wire. */
function usageHeaders(fiveHour: string): Record<string, string> {
  return {
    'anthropic-ratelimit-unified-5h-utilization': fiveHour,
    'anthropic-ratelimit-unified-5h-reset': String(FIVE_HOUR_RESET),
    'anthropic-ratelimit-unified-7d-utilization': '0.4',
    'anthropic-ratelimit-unified-7d-reset': String(WEEKLY_RESET),
    'anthropic-ratelimit-unified-status': fiveHour === '1' ? 'rejected' : 'allowed'
  }
}

/** What a caller outside the proxy submits: headers it read itself, billed to `token`. */
function observationFor(
  token: string,
  fiveHour: string,
  observedAt: number
): ClaudeUsageObservation {
  return {
    credentialFingerprint: fingerprintSecret(token),
    accountUuid: null,
    snapshot: parseUnifiedRateLimitHeaders(usageHeaders(fiveHour))!,
    observedAt
  }
}

/** A stand-in for api.anthropic.com that answers with whatever `headers()` says right now. */
async function startUpstream(
  headers: () => Record<string, string>
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream', ...headers() })
      res.end('event: message_stop\ndata: {}\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

/** One request through the proxy, as the CLI signed in to `token`'s account makes it. */
async function proxiedTurn(baseUrl: string, token: string): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/messages?beta=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      model: 'claude-haiku-5-5',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true
    })
  })
  expect(response.status).toBe(200)
  await response.text()
}

function published(): Array<{ channel: string; payload: ClaudeLiveUsagePayload }> {
  const calls = publisherMocks.publishDesktopBackendEvent.mock.calls as unknown as Array<
    [string, ClaudeLiveUsagePayload]
  >
  return calls.map(([channel, payload]) => ({ channel, payload }))
}

const publishedFiveHour = (): Array<number | undefined> =>
  published().map(({ payload }) => payload.usage.five_hour?.utilization)

const storedUsage = (email: string): UsageData =>
  JSON.parse(dbMocks.rows.get(email)!.last_usage_json as string) as UsageData

/** Long enough for a reading the updater is holding back to have been published. */
const pastTheCoalescingWindow = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, LIVE_USAGE_COALESCE_MS * 2))
  await getClaudeUsageLiveUpdater().settle()
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  dbMocks.rows.clear()
  updaterMocks.constructed = 0
  __resetClaudeApiProxyCachesForTests()
})

afterEach(async () => {
  await closeClaudeApiProxy()
  __resetClaudeUsageLiveUpdaterForTests()
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  vi.clearAllMocks()
})

describe('the live usage updater without the proxy', () => {
  it('applies a submitted observation with the proxy disabled: the right account, the live event', async () => {
    seedAccounts()

    const result = await startClaudeApiProxy({
      env: { HIVE_DISABLE_CLAUDE_API_PROXY: '1' }
    })
    expect(result).toEqual({ started: false, reason: 'disabled' })
    expect(isClaudeApiProxyRunning()).toBe(false)

    // A response billed to ME that says the 5-hour limit is full, seen at a moment of its own.
    const observedAt = Date.parse('2026-11-17T10:00:00.000Z')
    submitClaudeUsageObservation(observationFor(TOKEN_ME, '1', observedAt))
    await getClaudeUsageLiveUpdater().settle()

    // The right account's row, and only its usage snapshot.
    const usage = storedUsage(ME)
    expect(usage.five_hour).toEqual({ utilization: 100, resets_at: '2099-03-02T15:00:00.000Z' })
    expect(usage.seven_day).toEqual({ utilization: 40, resets_at: '2099-03-06T09:00:00.000Z' })
    expect(usage.extra_usage).toBeDefined()
    expect(dbMocks.rows.get(ME)!.last_fetched_at).toBe('polled-earlier')
    expect(storedUsage(OTHER).five_hour?.utilization).toBe(1)

    // The live event.
    expect(published()).toHaveLength(1)
    const [{ channel, payload }] = published()
    expect(channel).toBe('usage:claudeLive')
    expect(payload.email).toBe(ME)
    expect(payload.accountId).toBe(`row-${ME}`)
    expect(payload.isLiveAccount).toBe(true)
    expect(payload.liveEmail).toBe(ME)
    expect(payload.usage).toEqual(usage)
    expect(payload.rateLimit.fiveHour).toEqual({ status: 'allowed', resetsAt: FIVE_HOUR_RESET })
    expect(payload.observedAt).toBe(observedAt)
  })

  it('needs no proxy start at all, and tells accounts apart', async () => {
    seedAccounts()

    submitClaudeUsageObservation(observationFor(TOKEN_OTHER, '0.07', Date.now()))
    await getClaudeUsageLiveUpdater().settle()

    expect(published().map(({ payload }) => [payload.email, payload.isLiveAccount])).toEqual([
      [OTHER, false]
    ])
    expect(storedUsage(OTHER).five_hour?.utilization).toBe(7)
    expect(storedUsage(ME).five_hour?.utilization).toBe(1)
  })

  it('drops an observation it cannot attribute instead of guessing', async () => {
    seedAccounts()

    submitClaudeUsageObservation(observationFor('a-token-nobody-manages', '0.5', Date.now()))
    await getClaudeUsageLiveUpdater().settle()

    expect(published()).toEqual([])
    expect(storedUsage(ME).five_hour?.utilization).toBe(1)
    expect(storedUsage(OTHER).five_hour?.utilization).toBe(1)
  })

  it('on shutdown drops what it was holding back, and builds nothing just to dispose', async () => {
    disposeClaudeUsageLiveUpdater()
    expect(updaterMocks.constructed).toBe(0)

    seedAccounts()
    const now = Date.now()
    submitClaudeUsageObservation(observationFor(TOKEN_ME, '0.2', now))
    submitClaudeUsageObservation(observationFor(TOKEN_ME, '0.3', now + 1))
    disposeClaudeUsageLiveUpdater()
    await pastTheCoalescingWindow()

    expect(publishedFiveHour()).toEqual([20])
    expect(updaterMocks.constructed).toBe(1)
  })
})

describe('the live usage updater with the proxy', () => {
  it('sends a proxied exchange through the one updater: same update and event as before', async () => {
    seedAccounts()
    const upstream = await startUpstream(() => usageHeaders('0.42'))
    const env = { ANTHROPIC_BASE_URL: upstream.url, HIVE_CLAUDE_API_PROXY_PORT: '0' }

    try {
      // The updater is already there before the proxy starts...
      const updater = getClaudeUsageLiveUpdater()
      const result = await startClaudeApiProxy({ env })
      expect(result.started).toBe(true)
      if (!result.started) return

      await proxiedTurn(result.baseUrl, TOKEN_ME)
      await vi.waitFor(() => expect(published()).toHaveLength(1))

      const [{ channel, payload }] = published()
      expect(channel).toBe('usage:claudeLive')
      expect(payload.email).toBe(ME)
      expect(payload.accountId).toBe(`row-${ME}`)
      expect(payload.isLiveAccount).toBe(true)
      expect(payload.liveEmail).toBe(ME)
      expect(payload.usage.five_hour?.utilization).toBe(42)
      expect(payload.usage.extra_usage).toBeDefined()
      expect(storedUsage(ME)).toEqual(payload.usage)
      expect(dbMocks.rows.get(ME)!.last_fetched_at).toBe('polled-earlier')
      expect(storedUsage(OTHER).five_hour?.utilization).toBe(1)

      // ...and the proxy fed that one: it did not build its own.
      expect(updaterMocks.constructed).toBe(1)
      expect(getClaudeUsageLiveUpdater()).toBe(updater)

      // The entry point works next to a running proxy, through the same updater.
      submitClaudeUsageObservation(observationFor(TOKEN_OTHER, '0.07', Date.now()))
      await updater.settle()
      expect(published().map(({ payload: each }) => [each.email, each.isLiveAccount])).toEqual([
        [ME, true],
        [OTHER, false]
      ])
      expect(storedUsage(OTHER).five_hour?.utilization).toBe(7)
      expect(updaterMocks.constructed).toBe(1)
    } finally {
      await upstream.close()
    }
  })

  it('publishes each reading exactly once across repeated proxy starts and stops', async () => {
    seedAccounts()
    let fiveHour = '0'
    const upstream = await startUpstream(() => usageHeaders(fiveHour))
    const env = { ANTHROPIC_BASE_URL: upstream.url, HIVE_CLAUDE_API_PROXY_PORT: '0' }
    const rounds = ['0.11', '0.22', '0.33', '0.44']

    try {
      for (const [index, value] of rounds.entries()) {
        fiveHour = value
        const result = await startClaudeApiProxy({ env })
        expect(result.started).toBe(true)
        if (!result.started) return
        await proxiedTurn(result.baseUrl, TOKEN_ME)
        await vi.waitFor(() => expect(published()).toHaveLength(index + 1))
        await closeClaudeApiProxy()
        expect(isClaudeApiProxyRunning()).toBe(false)
      }
      await pastTheCoalescingWindow()

      // Every round's reading, in order, once: none lost to a stop, none repeated by a start.
      expect(publishedFiveHour()).toEqual([11, 22, 33, 44])
      expect(published().every(({ payload }) => payload.email === ME)).toBe(true)
      expect(storedUsage(ME).five_hour?.utilization).toBe(44)
      expect(updaterMocks.constructed).toBe(1)
    } finally {
      await upstream.close()
    }
  })

  it('still publishes a reading it was holding back when the proxy stopped', async () => {
    seedAccounts()
    const upstream = await startUpstream(() => usageHeaders('0.5'))
    const env = { ANTHROPIC_BASE_URL: upstream.url, HIVE_CLAUDE_API_PROXY_PORT: '0' }

    try {
      const result = await startClaudeApiProxy({ env })
      expect(result.started).toBe(true)
      if (!result.started) return

      // The first reading of a burst on this account is applied at once...
      submitClaudeUsageObservation(observationFor(TOKEN_ME, '0.2', Date.now()))
      // ...the proxied one right behind it is held back for the rest of the burst...
      await proxiedTurn(result.baseUrl, TOKEN_ME)
      // ...and the proxy stops while it is.
      await closeClaudeApiProxy()

      await vi.waitFor(() => expect(published()).toHaveLength(2))
      await pastTheCoalescingWindow()
      expect(publishedFiveHour()).toEqual([20, 50])
      expect(storedUsage(ME).five_hour?.utilization).toBe(50)

      // The next start feeds the same updater, and repeats nothing.
      const again = await startClaudeApiProxy({ env })
      expect(again.started).toBe(true)
      await pastTheCoalescingWindow()
      expect(published()).toHaveLength(2)
      expect(updaterMocks.constructed).toBe(1)
    } finally {
      await upstream.close()
    }
  })
})

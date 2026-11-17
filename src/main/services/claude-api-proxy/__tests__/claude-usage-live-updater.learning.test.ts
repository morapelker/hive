// @vitest-environment node
/**
 * Learning an account's organization from proxied traffic (Code Mode PRD
 * AT-2): a response whose credential placed it also names the organization it
 * was billed to, and that is stored for the account. How an organization-only
 * observation is then placed is covered by
 * `claude-usage-live-updater.organization.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ClaudeLiveUsagePayload } from '@shared/types/claude-live-usage'
import type { UsageData } from '@shared/types/usage'
import type { SavedUsageAccount } from '../../../db/types'
import {
  ANTHROPIC_ORGANIZATION_HEADER,
  ClaudeUsageLiveUpdater,
  LIVE_USAGE_COALESCE_MS,
  ORGANIZATION_CONFIRM_DELAY_MS,
  observationFromExchange,
  type ClaudeAccountIdentity,
  type ClaudeProxyObservedExchange,
  type ClaudeUsageLiveUpdaterDeps
} from '../claude-usage-live-updater'
import { parseUnifiedRateLimitHeaders } from '../anthropic-rate-limit-headers'

const A = 'a@example.com'
const B = 'b@example.com'
const UUID_A = '718fd88e-2076-4451-bc5f-066158379585'
const UUID_B = '0d2c9a9e-1f1d-4a8a-9d2c-3a4b5c6d7e8f'
const TOKEN_A = 'fp-token-a'
const TOKEN_B = 'fp-token-b'
// Not real organizations.
const ORG_A = 'f43590b8-1111-4222-8333-444455556666'
const ORG_B = '3ccde938-7777-4888-9999-aaaabbbbcccc'
const ORG_NEW = '8023b5fe-0000-4000-8000-000000000001'

const START = Date.UTC(2026, 10, 17, 9, 0, 0)

function usageHeaders(sevenDay: string): Record<string, string> {
  return {
    'anthropic-ratelimit-unified-7d-utilization': sevenDay,
    'anthropic-ratelimit-unified-7d-reset': '1793977200',
    'anthropic-ratelimit-unified-7d-status': 'allowed',
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-representative-claim': 'seven_day',
    'anthropic-ratelimit-unified-reset': '1793977200'
  }
}

interface ExchangeInput {
  /** Fingerprint of the credential the request carried; null for none. */
  token?: string | null
  /** The account uuid the client reported; null for none. */
  reportedUuid?: string | null
  /** The `anthropic-organization-id` response header; null leaves it out. */
  organization?: string | string[] | null
  sevenDay?: string
  observedAt?: number
}

/** A proxied exchange as the utility-process host reports it (no body, the uuid extracted). */
function exchange(input: ExchangeInput = {}): ClaudeProxyObservedExchange {
  const organization = input.organization === undefined ? ORG_A : input.organization
  return {
    credentialFingerprint: input.token === undefined ? TOKEN_A : input.token,
    accountUuid: input.reportedUuid === undefined ? UUID_A : input.reportedUuid,
    requestBody: null,
    responseHeaders: {
      'content-type': 'text/event-stream',
      ...usageHeaders(input.sevenDay ?? '0.12'),
      ...(organization !== null ? { [ANTHROPIC_ORGANIZATION_HEADER]: organization } : {})
    },
    observedAt: input.observedAt ?? START
  }
}

function row(email: string, orgUuid: string | null = null): SavedUsageAccount {
  return {
    id: `row-${email}`,
    provider: 'anthropic',
    email,
    credentials_json: '',
    last_usage_json: null,
    last_fetched_at: null,
    status: 'ok',
    last_error: null,
    org_uuid: orgUuid,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z'
  }
}

const accountA = (tokenFingerprint: string | null = TOKEN_A): ClaudeAccountIdentity => ({
  email: A,
  uuid: UUID_A,
  tokenFingerprint
})
const accountB = (tokenFingerprint: string | null = TOKEN_B): ClaudeAccountIdentity => ({
  email: B,
  uuid: UUID_B,
  tokenFingerprint
})

interface Harness {
  updater: ClaudeUsageLiveUpdater
  deps: ClaudeUsageLiveUpdaterDeps
  /** What the CLI's identity file and live credentials say; tests change it to "switch". */
  live: { email: string | null; tokenFingerprint: string | null }
  rows: Map<string, SavedUsageAccount>
  published: ClaudeLiveUsagePayload[]
  /** The organization store: every call is a write. */
  store: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
  requestOrganizations: ReturnType<typeof vi.fn>
  now: () => number
  /** Hand the updater a proxied exchange and wait until it is applied. */
  send: (input?: ExchangeInput) => Promise<void>
  /** Move the clock, firing every timer that falls due on the way, in order. */
  advance: (ms: number) => Promise<void>
  organizationOf: (email: string) => string | null
  sevenDay: (email: string) => number | null
}

function makeHarness(
  options: {
    managed?: ClaudeAccountIdentity[]
    live?: { email: string | null; tokenFingerprint?: string | null }
    rows?: SavedUsageAccount[]
  } = {}
): Harness {
  const managed = options.managed ?? [accountA(), accountB()]
  const live = {
    tokenFingerprint: null,
    ...(options.live ?? { email: B, tokenFingerprint: TOKEN_B })
  }
  const rows = new Map((options.rows ?? []).map((entry) => [entry.email, entry]))
  const published: ClaudeLiveUsagePayload[] = []
  const requestOrganizations = vi.fn()
  const warn = vi.fn()
  let now = START
  let nextTimerId = 0
  const timers: Array<{ id: number; at: number; fn: () => void }> = []

  // As the real setter: only the organization of the row with that id changes.
  const store = vi.fn((accountId: string, organizationUuid: string): void => {
    for (const [email, entry] of rows) {
      if (entry.id === accountId) rows.set(email, { ...entry, org_uuid: organizationUuid })
    }
  })

  const deps: ClaudeUsageLiveUpdaterDeps = {
    listManagedAccounts: vi.fn(async () => managed),
    readLiveIdentity: vi.fn(async () => ({
      email: live.email,
      uuid: managed.find((account) => account.email === live.email)?.uuid ?? null
    })),
    readLiveTokenFingerprint: vi.fn(async () => live.tokenFingerprint),
    isAccountManaged: vi.fn(async (email: string) =>
      managed.some((account) => account.email === email)
    ),
    ensureLiveAccountManaged: vi.fn(async () => false),
    rememberAccountUuid: vi.fn(async () => false),
    readUsageRow: vi.fn((email: string) => rows.get(email) ?? null),
    writeLiveUsage: vi.fn((email: string, usage: UsageData) => {
      // Like the real DB method: only the snapshot changes.
      const next = { ...(rows.get(email) ?? row(email)), last_usage_json: JSON.stringify(usage) }
      rows.set(email, next)
      return next
    }),
    publish: vi.fn(async (_channel: string, payload: ClaudeLiveUsagePayload) => {
      published.push(payload)
      return true
    }),
    // The same store the organization-only path reads its mapping from.
    listAccountOrganizations: vi.fn(() =>
      [...rows.values()].map((entry) => ({ email: entry.email, organizationUuid: entry.org_uuid }))
    ),
    readLastAccountSwitchAt: vi.fn(async () => null),
    requestOrganizations,
    storeAccountOrganization: store,
    log: { debug: vi.fn(), info: vi.fn(), warn },
    now: () => now,
    setTimer: (fn, ms) => {
      const timer = { id: nextTimerId++, at: now + ms, fn }
      timers.push(timer)
      return timer
    },
    clearTimer: (handle) => {
      const index = timers.indexOf(handle as (typeof timers)[number])
      if (index !== -1) timers.splice(index, 1)
    }
  }
  const updater = new ClaudeUsageLiveUpdater(deps)

  const advance = async (ms: number): Promise<void> => {
    const target = now + ms
    for (let guard = 0; guard < 10_000; guard += 1) {
      const due = timers
        .filter((timer) => timer.at <= target)
        .sort((x, y) => x.at - y.at || x.id - y.id)[0]
      if (due === undefined) {
        now = target
        await updater.settle()
        return
      }
      timers.splice(timers.indexOf(due), 1)
      now = Math.max(now, due.at)
      due.fn()
      await updater.settle()
    }
    throw new Error('timers never ran dry')
  }

  return {
    updater,
    deps,
    live,
    rows,
    published,
    store,
    warn,
    requestOrganizations,
    now: () => now,
    send: async (input = {}) => {
      updater.handleExchange(exchange({ observedAt: now, ...input }))
      await updater.settle()
    },
    advance,
    organizationOf: (email) => rows.get(email)?.org_uuid ?? null,
    sevenDay: (email) => {
      const json = rows.get(email)?.last_usage_json
      return json ? ((JSON.parse(json) as UsageData).seven_day?.utilization ?? null) : null
    }
  }
}

describe('observationFromExchange and the billed organization', () => {
  it('carries the organization of a response next to the credential that was billed', () => {
    const observation = observationFromExchange(exchange())
    expect(observation?.credentialFingerprint).toBe(TOKEN_A)
    expect(observation?.organizationUuid).toBe(ORG_A)
  })

  it('carries it in the stored form: trimmed, lower-cased, the first of a repeated header', () => {
    expect(
      observationFromExchange(exchange({ organization: ` ${ORG_A.toUpperCase()} ` }))
        ?.organizationUuid
    ).toBe(ORG_A)
    expect(
      observationFromExchange(exchange({ organization: [ORG_B, ORG_A] }))?.organizationUuid
    ).toBe(ORG_B)
  })

  it('carries none when the header is missing, empty or not an id', () => {
    for (const organization of [null, '', '   ', 'not an id', '<script>', 'a'.repeat(200)]) {
      const observation = observationFromExchange(exchange({ organization }))
      expect(observation).not.toBeNull()
      expect(observation).not.toHaveProperty('organizationUuid')
    }
  })

  it('carries none without a credential: such a request keeps going by the reported uuid', () => {
    const observation = observationFromExchange(exchange({ token: null }))
    expect(observation?.accountUuid).toBe(UUID_A)
    expect(observation).not.toHaveProperty('organizationUuid')
  })

  it('still needs usage headers: an organization alone is not an observation', () => {
    expect(
      observationFromExchange({
        ...exchange(),
        responseHeaders: { [ANTHROPIC_ORGANIZATION_HEADER]: ORG_A }
      })
    ).toBeNull()
  })
})

describe('an exchange placed by its credential', () => {
  it('stores the organization for that account after one exchange', async () => {
    // A request on A's token while B is signed in: only the managed list can place it.
    const h = makeHarness({ live: { email: B, tokenFingerprint: TOKEN_B } })

    await h.send({ token: TOKEN_A, organization: ORG_A })

    expect(h.store).toHaveBeenCalledExactlyOnceWith(`row-${A}`, ORG_A)
    expect(h.organizationOf(A)).toBe(ORG_A)
    expect(h.organizationOf(B)).toBeNull()
    // The usage update it rides on is the one it always was.
    expect(h.published).toHaveLength(1)
    expect(h.published[0]).toMatchObject({ email: A, accountId: `row-${A}`, isLiveAccount: false })
    expect(h.sevenDay(A)).toBe(12)
    expect(h.warn).not.toHaveBeenCalled()
  })

  it('goes by the credential, not by the account the client reported', async () => {
    // Switched A -> B mid-prompt: B's token is billed, the body still reports A.
    const h = makeHarness({ live: { email: A, tokenFingerprint: TOKEN_A } })

    await h.send({ token: TOKEN_B, reportedUuid: UUID_A, organization: ORG_B })

    expect(h.store).toHaveBeenCalledExactlyOnceWith(`row-${B}`, ORG_B)
    expect(h.organizationOf(A)).toBeNull()
  })

  it('stores the header value in the stored form', async () => {
    const h = makeHarness()

    await h.send({ token: TOKEN_A, organization: `  ${ORG_A.toUpperCase()} ` })

    expect(h.store).toHaveBeenCalledExactlyOnceWith(`row-${A}`, ORG_A)
  })

  it('writes nothing more for repeated exchanges with the same organization', async () => {
    const h = makeHarness()

    await h.send({ token: TOKEN_A, organization: ORG_A, sevenDay: '0.12' })
    for (const sevenDay of ['0.13', '0.14', '0.15']) {
      await h.advance(LIVE_USAGE_COALESCE_MS)
      await h.send({ token: TOKEN_A, organization: ORG_A.toUpperCase(), sevenDay })
    }
    // Long after the credential's resolution expired and was looked up again.
    await h.advance(30 * 60_000)
    await h.send({ token: TOKEN_A, organization: ORG_A, sevenDay: '0.16' })

    expect(h.published).toHaveLength(5)
    expect(h.sevenDay(A)).toBe(16)
    expect(h.store).toHaveBeenCalledTimes(1)
  })

  it('writes nothing when the organization is the one already stored', async () => {
    const h = makeHarness({ rows: [row(A, ORG_A)] })

    await h.send({ token: TOKEN_A, organization: ORG_A })
    await h.advance(60_000)

    expect(h.published).toHaveLength(1)
    expect(h.store).not.toHaveBeenCalled()
  })

  it('replaces the stored organization when the account is billed to another one', async () => {
    const h = makeHarness({ rows: [row(A, ORG_A)] })

    await h.send({ token: TOKEN_A, organization: ORG_NEW })

    expect(h.store).toHaveBeenCalledExactlyOnceWith(`row-${A}`, ORG_NEW)
    expect(h.organizationOf(A)).toBe(ORG_NEW)

    await h.advance(LIVE_USAGE_COALESCE_MS)
    await h.send({ token: TOKEN_A, organization: ORG_NEW })
    expect(h.store).toHaveBeenCalledTimes(1)
  })

  it('changes nothing and raises no error when the response has no organization header', async () => {
    const h = makeHarness({ rows: [row(A, ORG_A)] })

    await h.send({ token: TOKEN_A, organization: null })
    await h.advance(60_000)

    expect(h.published).toHaveLength(1)
    expect(h.sevenDay(A)).toBe(12)
    expect(h.store).not.toHaveBeenCalled()
    expect(h.organizationOf(A)).toBe(ORG_A)
    expect(h.warn).not.toHaveBeenCalled()
  })

  it('learns nothing when no store is connected, and still applies the usage', async () => {
    const h = makeHarness()
    delete h.deps.storeAccountOrganization

    await h.send({ token: TOKEN_A, organization: ORG_A })
    await h.advance(60_000)

    expect(h.published).toHaveLength(1)
    expect(h.store).not.toHaveBeenCalled()
    expect(h.warn).not.toHaveBeenCalled()
  })

  it('still applies the usage when the store fails, and tries again on the next exchange', async () => {
    const h = makeHarness()
    h.store.mockImplementationOnce(() => {
      throw new Error('database is locked')
    })

    await h.send({ token: TOKEN_A, organization: ORG_A })

    expect(h.published).toHaveLength(1)
    expect(h.sevenDay(A)).toBe(12)
    expect(h.organizationOf(A)).toBeNull()
    expect(h.warn).toHaveBeenCalledExactlyOnceWith(
      'Failed to store the organization of a Claude account',
      { email: A, error: 'database is locked' }
    )

    await h.advance(LIVE_USAGE_COALESCE_MS)
    await h.send({ token: TOKEN_A, organization: ORG_A, sevenDay: '0.2' })

    expect(h.published).toHaveLength(2)
    expect(h.organizationOf(A)).toBe(ORG_A)
  })
})

describe('the signed-in account, whose first pairing with its credential is unconfirmed', () => {
  it('stores nothing at once, then the organization after one exchange once the pairing holds', async () => {
    const h = makeHarness({ live: { email: A, tokenFingerprint: TOKEN_A } })

    await h.send({ token: TOKEN_A, organization: ORG_A })
    expect(h.published).toHaveLength(1)
    expect(h.published[0]).toMatchObject({ email: A, isLiveAccount: true })
    expect(h.store).not.toHaveBeenCalled()

    await h.advance(ORGANIZATION_CONFIRM_DELAY_MS - 1)
    expect(h.store).not.toHaveBeenCalled()

    await h.advance(1)
    expect(h.store).toHaveBeenCalledExactlyOnceWith(`row-${A}`, ORG_A)
    expect(h.organizationOf(A)).toBe(ORG_A)
    // The second look publishes nothing: there was no new reading.
    expect(h.published).toHaveLength(1)
  })

  it('stores it from the next exchange when that comes after the pairing was confirmed', async () => {
    const h = makeHarness({ live: { email: A, tokenFingerprint: TOKEN_A } })

    await h.send({ token: TOKEN_A, organization: ORG_A })
    await h.advance(ORGANIZATION_CONFIRM_DELAY_MS - 500)
    expect(h.store).not.toHaveBeenCalled()

    // The resolution expired half a second ago: this exchange is the second lookup.
    await h.send({ token: TOKEN_A, organization: ORG_A, sevenDay: '0.3' })
    expect(h.store).toHaveBeenCalledExactlyOnceWith(`row-${A}`, ORG_A)

    // The look that was still scheduled finds it stored and reads nothing again.
    const lookups = vi.mocked(h.deps.readLiveTokenFingerprint).mock.calls.length
    await h.advance(60_000)
    expect(h.store).toHaveBeenCalledTimes(1)
    expect(h.deps.readLiveTokenFingerprint).toHaveBeenCalledTimes(lookups)
  })

  it('takes no second look at all when the organization is already stored', async () => {
    const h = makeHarness({
      live: { email: A, tokenFingerprint: TOKEN_A },
      rows: [row(A, ORG_A)]
    })

    await h.send({ token: TOKEN_A, organization: ORG_A })
    await h.advance(10 * 60_000)

    expect(h.store).not.toHaveBeenCalled()
    expect(h.deps.readLiveTokenFingerprint).toHaveBeenCalledTimes(1)
  })

  it('never stores the incoming account organization for the outgoing account of a half-applied switch', async () => {
    // A switch A -> B wrote B's token; the identity file still names A.
    const h = makeHarness({ live: { email: A, tokenFingerprint: TOKEN_B } })

    await h.send({ token: TOKEN_B, reportedUuid: UUID_B, organization: ORG_B })
    // The reading is credited as it always was in that instant...
    expect(h.published.map((payload) => payload.email)).toEqual([A])
    // ...but B's organization is not filed under A.
    expect(h.store).not.toHaveBeenCalled()

    // The switch completes. The second look sees the credential under B now.
    h.live.email = B
    await h.advance(ORGANIZATION_CONFIRM_DELAY_MS)
    expect(h.store).not.toHaveBeenCalled()
    expect(h.organizationOf(A)).toBeNull()

    // B's own traffic teaches B's organization, once its pairing held twice.
    await h.send({ token: TOKEN_B, reportedUuid: UUID_B, organization: ORG_B })
    await h.advance(ORGANIZATION_CONFIRM_DELAY_MS)

    expect(h.store).toHaveBeenCalledExactlyOnceWith(`row-${B}`, ORG_B)
    expect(h.organizationOf(A)).toBeNull()
    expect(h.organizationOf(B)).toBe(ORG_B)
  })

  it('forgets what it was waiting to confirm when the updater is disposed', async () => {
    const h = makeHarness({ live: { email: A, tokenFingerprint: TOKEN_A } })

    await h.send({ token: TOKEN_A, organization: ORG_A })
    h.updater.dispose()
    await h.advance(10 * 60_000)

    expect(h.store).not.toHaveBeenCalled()
  })
})

describe('an exchange not placed by its credential', () => {
  it('stores nothing when it was placed by the reported account id', async () => {
    // No token can be read to compare against: the reported uuid is all there is.
    const h = makeHarness({
      managed: [accountA(null), accountB(null)],
      live: { email: A, tokenFingerprint: null }
    })

    await h.send({ token: 'fp-unreadable', reportedUuid: UUID_A, organization: ORG_A })
    await h.advance(10 * 60_000)

    expect(h.published.map((payload) => payload.email)).toEqual([A])
    expect(h.sevenDay(A)).toBe(12)
    expect(h.store).not.toHaveBeenCalled()
    expect(h.organizationOf(A)).toBeNull()
  })

  it('stores nothing when the request carried no credential', async () => {
    const h = makeHarness()

    await h.send({ token: null, reportedUuid: UUID_A, organization: ORG_A })
    await h.advance(10 * 60_000)

    // Placed by the reported uuid as before, not by the organization.
    expect(h.published.map((payload) => payload.email)).toEqual([A])
    expect(h.requestOrganizations).not.toHaveBeenCalled()
    expect(h.store).not.toHaveBeenCalled()
  })

  it('stores nothing when it could not be attributed at all', async () => {
    // Tokens are readable and this one belongs to no managed account.
    const h = makeHarness({ live: { email: B, tokenFingerprint: TOKEN_B } })

    await h.send({ token: 'fp-somebody-else', reportedUuid: UUID_A, organization: ORG_A })
    await h.advance(10 * 60_000)

    expect(h.published).toHaveLength(0)
    expect(h.store).not.toHaveBeenCalled()
    expect(h.organizationOf(A)).toBeNull()
  })

  it('stores nothing for an observation identified only by its organization', async () => {
    const h = makeHarness({ rows: [row(A, ORG_A)] })

    h.updater.observe({
      credentialFingerprint: null,
      accountUuid: null,
      organizationUuid: ORG_A,
      snapshot: parseUnifiedRateLimitHeaders(usageHeaders('0.4'))!,
      observedAt: h.now()
    })
    await h.updater.settle()

    expect(h.published.map((payload) => payload.email)).toEqual([A])
    expect(h.store).not.toHaveBeenCalled()
  })
})

describe('end to end: a proxied exchange teaches the mapping', () => {
  const organizationOnly = (h: Harness, organizationUuid: string, sevenDay: string): void =>
    h.updater.observe({
      credentialFingerprint: null,
      accountUuid: null,
      organizationUuid,
      snapshot: parseUnifiedRateLimitHeaders(usageHeaders(sevenDay))!,
      observedAt: h.now()
    })

  it('an organization-only observation for the same organization is then attributed to that account', async () => {
    const h = makeHarness({ live: { email: B, tokenFingerprint: TOKEN_B } })

    await h.send({ token: TOKEN_A, organization: ORG_A, sevenDay: '0.12' })
    expect(h.organizationOf(A)).toBe(ORG_A)

    await h.advance(LIVE_USAGE_COALESCE_MS)
    organizationOnly(h, ORG_A.toUpperCase(), '0.36')
    await h.updater.settle()

    expect(h.published).toHaveLength(2)
    expect(h.published[1]).toMatchObject({
      email: A,
      accountId: `row-${A}`,
      accountUuid: null,
      isLiveAccount: false
    })
    expect(h.sevenDay(A)).toBe(36)
    expect(h.sevenDay(B)).toBeNull()
    expect(h.requestOrganizations).not.toHaveBeenCalled()
  })

  it('a reading held for an unknown organization is applied as soon as an exchange teaches it', async () => {
    const h = makeHarness({ live: { email: B, tokenFingerprint: TOKEN_B } })

    organizationOnly(h, ORG_A, '0.5')
    await h.updater.settle()
    expect(h.published).toHaveLength(0)
    expect(h.requestOrganizations).toHaveBeenCalledTimes(1)

    // No timer fires in between: storing the organization is what releases it.
    await h.send({ token: TOKEN_A, organization: ORG_A, sevenDay: '0.12' })

    expect(h.store).toHaveBeenCalledExactlyOnceWith(`row-${A}`, ORG_A)
    expect(h.published.map((payload) => payload.email)).toEqual([A, A])
    expect(h.published.map((payload) => payload.usage.seven_day?.utilization)).toEqual([12, 50])
  })

  it('an organization nobody was taught stays unattributed', async () => {
    const h = makeHarness({ live: { email: B, tokenFingerprint: TOKEN_B } })

    await h.send({ token: TOKEN_A, organization: ORG_A })
    await h.advance(LIVE_USAGE_COALESCE_MS)
    organizationOnly(h, ORG_B, '0.36')
    await h.updater.settle()

    expect(h.published.map((payload) => payload.email)).toEqual([A])
    expect(h.sevenDay(B)).toBeNull()
  })
})

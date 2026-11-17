// @vitest-environment node
/**
 * Observations identified only by the organization they were billed to (the
 * Code Mode debug log cannot see the credential): Code Mode PRD AT-4, AT-5,
 * AT-8. Token-identified observations are covered by
 * `claude-usage-live-updater.test.ts`, which this file leaves alone.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ClaudeLiveUsagePayload } from '@shared/types/claude-live-usage'
import type { UsageData } from '@shared/types/usage'
import type { SavedUsageAccount } from '../../../db/types'
import {
  ACCOUNT_SWITCH_SETTLE_MS,
  ClaudeUsageLiveUpdater,
  HELD_ORGANIZATION_RECHECK_MS,
  LIVE_USAGE_COALESCE_MS,
  UNKNOWN_ORGANIZATION_HOLD_MS,
  type ClaudeAccountIdentity,
  type ClaudeAccountOrganization,
  type ClaudeUsageLiveUpdaterDeps,
  type ClaudeUsageObservation
} from '../claude-usage-live-updater'
import { parseUnifiedRateLimitHeaders } from '../anthropic-rate-limit-headers'

const A = 'a@example.com'
const B = 'b@example.com'
const C = 'c@example.com'
const UUID_A = '718fd88e-2076-4451-bc5f-066158379585'
const UUID_B = '0d2c9a9e-1f1d-4a8a-9d2c-3a4b5c6d7e8f'
const ORG_A = 'f43590b8-1111-4222-8333-444455556666'
const ORG_B = '3ccde938-7777-4888-9999-aaaabbbbcccc'
const ORG_TEAM = '8023b5fe-0000-4000-8000-000000000001'
const ORG_NOBODY = 'deadbeef-0000-4000-8000-00000000dead'

/** 10:36:00 UTC, the minute the PRD's captured timeline starts in. */
const START = Date.UTC(2026, 10, 1, 10, 36, 0)

function snapshot(sevenDay: string): ClaudeUsageObservation['snapshot'] {
  return parseUnifiedRateLimitHeaders({
    'anthropic-ratelimit-unified-7d-utilization': sevenDay,
    'anthropic-ratelimit-unified-7d-reset': '1793977200',
    'anthropic-ratelimit-unified-7d-status': 'allowed',
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-representative-claim': 'seven_day',
    'anthropic-ratelimit-unified-reset': '1793977200'
  })!
}

function row(email: string): SavedUsageAccount {
  return {
    id: `row-${email}`,
    provider: 'anthropic',
    email,
    credentials_json: '',
    last_usage_json: null,
    last_fetched_at: null,
    status: 'ok',
    last_error: null,
    org_uuid: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z'
  }
}

interface Harness {
  updater: ClaudeUsageLiveUpdater
  deps: ClaudeUsageLiveUpdaterDeps
  /** The managed index: emails the account store knows. */
  managed: ClaudeAccountIdentity[]
  /** What the organization store holds; tests change it to "learn". */
  organizations: ClaudeAccountOrganization[]
  live: { email: string | null }
  /** What the account index says about the last switch. */
  lastSwitchAt: { value: number | null }
  rows: Map<string, SavedUsageAccount>
  published: ClaudeLiveUsagePayload[]
  requestOrganizations: ReturnType<typeof vi.fn>
  now: () => number
  /** An organization-only observation made now (or at `observedAt`). */
  observe: (
    organizationUuid: string,
    sevenDay: string,
    extra?: Partial<ClaudeUsageObservation>
  ) => Promise<void>
  /** Move the clock, firing every timer that falls due on the way, in order. */
  advance: (ms: number) => Promise<void>
  sevenDay: (email: string) => number | null
}

function makeHarness(options: {
  managed?: string[]
  organizations?: ClaudeAccountOrganization[]
  live?: string | null
  lastSwitchAt?: number | null
}): Harness {
  const managed: ClaudeAccountIdentity[] = (options.managed ?? [A, B]).map((email) => ({
    email,
    uuid: email === A ? UUID_A : email === B ? UUID_B : '',
    tokenFingerprint: `fp-${email}`
  }))
  const organizations = options.organizations ?? []
  const live = { email: options.live === undefined ? A : options.live }
  const lastSwitchAt = { value: options.lastSwitchAt ?? null }
  const rows = new Map<string, SavedUsageAccount>()
  const published: ClaudeLiveUsagePayload[] = []
  const requestOrganizations = vi.fn()
  let now = START
  let nextTimerId = 0
  const timers: Array<{ id: number; at: number; fn: () => void }> = []

  const deps: ClaudeUsageLiveUpdaterDeps = {
    listManagedAccounts: vi.fn(async () => managed),
    readLiveIdentity: vi.fn(async () => ({
      email: live.email,
      uuid: managed.find((account) => account.email === live.email)?.uuid ?? null
    })),
    readLiveTokenFingerprint: vi.fn(async () => (live.email ? `fp-${live.email}` : null)),
    isAccountManaged: vi.fn(async (email: string) =>
      managed.some((account) => account.email === email)
    ),
    ensureLiveAccountManaged: vi.fn(async () => false),
    rememberAccountUuid: vi.fn(async () => false),
    readUsageRow: vi.fn((email: string) => rows.get(email) ?? null),
    writeLiveUsage: vi.fn((email: string, usage: UsageData) => {
      const next = { ...(rows.get(email) ?? row(email)), last_usage_json: JSON.stringify(usage) }
      rows.set(email, next)
      return next
    }),
    publish: vi.fn(async (_channel: string, payload: ClaudeLiveUsagePayload) => {
      published.push(payload)
      return true
    }),
    listAccountOrganizations: vi.fn(() => organizations.map((entry) => ({ ...entry }))),
    readLastAccountSwitchAt: vi.fn(async () => lastSwitchAt.value),
    requestOrganizations,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
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
    managed,
    organizations,
    live,
    lastSwitchAt,
    rows,
    published,
    requestOrganizations,
    now: () => now,
    observe: async (organizationUuid, sevenDay, extra = {}) => {
      updater.observe({
        credentialFingerprint: null,
        accountUuid: null,
        organizationUuid,
        snapshot: snapshot(sevenDay),
        observedAt: now,
        ...extra
      })
      await updater.settle()
    },
    advance,
    sevenDay: (email) => {
      const json = rows.get(email)?.last_usage_json
      return json ? ((JSON.parse(json) as UsageData).seven_day?.utilization ?? null) : null
    }
  }
}

const mapped = (): ClaudeAccountOrganization[] => [
  { email: A, organizationUuid: ORG_A },
  { email: B, organizationUuid: ORG_B }
]

const team = (): ClaudeAccountOrganization[] => [
  { email: A, organizationUuid: ORG_TEAM },
  { email: B, organizationUuid: ORG_TEAM }
]

describe('an organization stored for one account', () => {
  it('credits that account and marks the event live only for the signed-in one', async () => {
    const h = makeHarness({ organizations: mapped(), live: A })

    await h.observe(ORG_A, '0.12')
    await h.advance(LIVE_USAGE_COALESCE_MS)
    await h.observe(ORG_B, '0.36')

    expect(h.published).toHaveLength(2)
    expect(h.published[0]).toMatchObject({
      provider: 'anthropic',
      accountId: `row-${A}`,
      email: A,
      accountUuid: null,
      isLiveAccount: true,
      liveEmail: A
    })
    expect(h.published[0].usage.seven_day?.utilization).toBe(12)
    // The other account's reading lands on its own row, not marked live.
    expect(h.published[1]).toMatchObject({ email: B, isLiveAccount: false, liveEmail: A })
    expect(h.sevenDay(A)).toBe(12)
    expect(h.sevenDay(B)).toBe(36)
    expect(h.requestOrganizations).not.toHaveBeenCalled()
  })

  it('compares organizations as the store normalises them (case and spaces)', async () => {
    const h = makeHarness({
      organizations: [{ email: 'A@Example.com', organizationUuid: ` ${ORG_A.toUpperCase()} ` }]
    })

    await h.observe(`  ${ORG_A.toUpperCase()}`, '0.12')

    expect(h.published.map((p) => p.email)).toEqual([A])
  })

  it('ignores a stored organization whose account is no longer managed', async () => {
    const h = makeHarness({
      managed: [A],
      organizations: [
        { email: A, organizationUuid: ORG_TEAM },
        { email: C, organizationUuid: ORG_TEAM },
        { email: C, organizationUuid: ORG_B }
      ]
    })

    // Shared on paper, but only one of the two is an account of this app.
    await h.observe(ORG_TEAM, '0.12')
    expect(h.published.map((p) => p.email)).toEqual([A])

    // An organization only a removed account carried is unknown.
    await h.observe(ORG_B, '0.36')
    expect(h.published).toHaveLength(1)
    expect(h.rows.has(C)).toBe(false)
  })

  it('is decided by the credential when the observation carries one too', async () => {
    const h = makeHarness({ organizations: mapped(), live: A })

    // Account A's token, but (wrongly) B's organization: the token wins,
    // exactly as before the organization field existed.
    h.updater.observe({
      credentialFingerprint: `fp-${A}`,
      accountUuid: UUID_B,
      organizationUuid: ORG_B,
      snapshot: snapshot('0.12'),
      observedAt: h.now()
    })
    await h.updater.settle()

    expect(h.published.map((p) => p.email)).toEqual([A])
    expect(h.deps.listAccountOrganizations).not.toHaveBeenCalled()
  })
})

describe('an organization no account is mapped to', () => {
  it('publishes nothing and asks for organizations to be learned', async () => {
    const h = makeHarness({ organizations: [{ email: A, organizationUuid: null }] })

    await h.observe(ORG_NOBODY, '0.12')

    expect(h.published).toHaveLength(0)
    expect(h.deps.writeLiveUsage).not.toHaveBeenCalled()
    expect(h.requestOrganizations).toHaveBeenCalledTimes(1)
  })

  it('applies the held reading once when the mapping is stored within 60 seconds', async () => {
    const h = makeHarness({ organizations: [{ email: A, organizationUuid: null }] })
    await h.observe(ORG_A, '0.12')
    const observedAt = h.now()

    await h.advance(59_000)
    expect(h.published).toHaveLength(0)

    h.organizations[0].organizationUuid = ORG_A
    await h.advance(HELD_ORGANIZATION_RECHECK_MS)

    expect(h.published).toHaveLength(1)
    expect(h.published[0]).toMatchObject({ email: A, isLiveAccount: true, observedAt })
    expect(h.sevenDay(A)).toBe(12)

    // Once: nothing is left to apply, and nothing keeps checking.
    await h.advance(5 * UNKNOWN_ORGANIZATION_HOLD_MS)
    expect(h.published).toHaveLength(1)
    expect(h.deps.writeLiveUsage).toHaveBeenCalledTimes(1)
  })

  it('applies it at once when told that organizations were learned', async () => {
    const h = makeHarness({ organizations: [{ email: B, organizationUuid: null }], live: A })
    await h.observe(ORG_B, '0.36')
    await h.advance(300)

    h.organizations[0].organizationUuid = ORG_B
    h.updater.organizationsLearned()
    await h.updater.settle()

    expect(h.published).toHaveLength(1)
    expect(h.published[0]).toMatchObject({ email: B, isLiveAccount: false, liveEmail: A })

    h.updater.organizationsLearned()
    await h.advance(UNKNOWN_ORGANIZATION_HOLD_MS)
    expect(h.published).toHaveLength(1)
  })

  it('discards the held reading when no mapping appears within 60 seconds', async () => {
    const h = makeHarness({ organizations: [{ email: A, organizationUuid: null }] })
    await h.observe(ORG_A, '0.12')

    await h.advance(UNKNOWN_ORGANIZATION_HOLD_MS + 1_000)
    h.organizations[0].organizationUuid = ORG_A
    h.updater.organizationsLearned()
    await h.advance(5 * UNKNOWN_ORGANIZATION_HOLD_MS)

    expect(h.published).toHaveLength(0)
    expect(h.deps.writeLiveUsage).not.toHaveBeenCalled()

    // The mapping is there for the next reading, which applies normally.
    await h.observe(ORG_A, '0.2')
    expect(h.published).toHaveLength(1)
    expect(h.sevenDay(A)).toBe(20)
  })

  it('keeps only the latest reading for the organization', async () => {
    const h = makeHarness({ organizations: [{ email: A, organizationUuid: null }] })
    await h.observe(ORG_A, '0.12')
    await h.advance(10_000)
    await h.observe(ORG_A, '0.2')
    const newest = h.now()
    await h.advance(10_000)
    // Arrives late but was made earlier: it must not replace the newer one.
    await h.observe(ORG_A, '0.15', { observedAt: newest - 5_000 })

    h.organizations[0].organizationUuid = ORG_A
    await h.advance(HELD_ORGANIZATION_RECHECK_MS)

    expect(h.published).toHaveLength(1)
    expect(h.published[0].observedAt).toBe(newest)
    expect(h.sevenDay(A)).toBe(20)
  })

  it('never applies a held reading after a newer one for the same organization', async () => {
    const h = makeHarness({ organizations: [{ email: A, organizationUuid: null }] })
    await h.observe(ORG_A, '0.12')
    await h.advance(2_500)

    // The mapping and a newer reading arrive together, between two checks.
    h.organizations[0].organizationUuid = ORG_A
    await h.observe(ORG_A, '0.2')
    await h.advance(UNKNOWN_ORGANIZATION_HOLD_MS)

    expect(h.published.map((p) => p.usage.seven_day?.utilization)).toEqual([20])
  })

  it('counts the 60 seconds from the newest reading, and asks again at most once a minute', async () => {
    const h = makeHarness({ organizations: [{ email: A, organizationUuid: null }] })
    await h.observe(ORG_A, '0.12')
    await h.advance(40_000)
    await h.observe(ORG_A, '0.2')
    expect(h.requestOrganizations).toHaveBeenCalledTimes(1)

    await h.advance(30_000)
    await h.observe(ORG_A, '0.3')
    // 70 s after the first request: asked again, once.
    expect(h.requestOrganizations).toHaveBeenCalledTimes(2)

    // 50 s after the newest reading: still inside its minute.
    await h.advance(50_000)
    h.organizations[0].organizationUuid = ORG_A
    await h.advance(HELD_ORGANIZATION_RECHECK_MS)
    expect(h.published.map((p) => p.usage.seven_day?.utilization)).toEqual([30])
  })

  it('holds each unknown organization separately', async () => {
    const h = makeHarness({
      organizations: [
        { email: A, organizationUuid: null },
        { email: B, organizationUuid: null }
      ]
    })
    await h.observe(ORG_A, '0.12')
    await h.observe(ORG_B, '0.36')
    expect(h.requestOrganizations).toHaveBeenCalledTimes(2)

    h.organizations[1].organizationUuid = ORG_B
    await h.advance(HELD_ORGANIZATION_RECHECK_MS)
    expect(h.published.map((p) => p.email)).toEqual([B])

    h.organizations[0].organizationUuid = ORG_A
    await h.advance(HELD_ORGANIZATION_RECHECK_MS)
    expect(h.published.map((p) => p.email)).toEqual([B, A])
  })

  it('drops what it holds on dispose', async () => {
    const h = makeHarness({ organizations: [{ email: A, organizationUuid: null }] })
    await h.observe(ORG_A, '0.12')

    h.updater.dispose()
    h.organizations[0].organizationUuid = ORG_A
    h.updater.organizationsLearned()
    await h.advance(UNKNOWN_ORGANIZATION_HOLD_MS)

    expect(h.published).toHaveLength(0)
  })

  it('keeps going when the request to learn organizations throws', async () => {
    const h = makeHarness({ organizations: [{ email: A, organizationUuid: null }] })
    h.requestOrganizations.mockImplementation(() => {
      throw new Error('learner is down')
    })

    await h.observe(ORG_A, '0.12')
    h.organizations[0].organizationUuid = ORG_A
    await h.advance(HELD_ORGANIZATION_RECHECK_MS)

    expect(h.published.map((p) => p.email)).toEqual([A])
  })
})

describe('an organization shared by two accounts', () => {
  it('goes to the signed-in one when no switch happened in the last 30 seconds', async () => {
    const h = makeHarness({ organizations: team(), live: B })
    h.lastSwitchAt.value = h.now() - ACCOUNT_SWITCH_SETTLE_MS

    await h.observe(ORG_TEAM, '0.12')

    expect(h.published).toHaveLength(1)
    expect(h.published[0]).toMatchObject({ email: B, isLiveAccount: true })
    expect(h.rows.has(A)).toBe(false)
  })

  it('goes to neither within 30 seconds of a switch', async () => {
    const h = makeHarness({ organizations: team(), live: B })
    h.lastSwitchAt.value = h.now() - (ACCOUNT_SWITCH_SETTLE_MS - 1)

    await h.observe(ORG_TEAM, '0.12')

    expect(h.published).toHaveLength(0)
    expect(h.deps.writeLiveUsage).not.toHaveBeenCalled()
    // Not held either: there is nothing to learn that would settle it.
    expect(h.requestOrganizations).not.toHaveBeenCalled()

    // Once the switch is 30 seconds behind, the signed-in account is credited.
    await h.advance(1_000)
    await h.observe(ORG_TEAM, '0.2')
    expect(h.published.map((p) => p.email)).toEqual([B])
  })

  it('goes to neither when the reading was made before the switch, however late it arrives', async () => {
    const h = makeHarness({ organizations: team(), live: B })
    const switchedAt = h.now()
    h.lastSwitchAt.value = switchedAt
    await h.advance(5 * 60_000)

    // Read from the log minutes later: the request answered while A was signed in.
    await h.observe(ORG_TEAM, '0.12', { observedAt: switchedAt - 2_000 })

    expect(h.published).toHaveLength(0)
  })

  it('goes to neither when the signed-in account is not one of them', async () => {
    const h = makeHarness({
      managed: [A, B, C],
      organizations: [...team(), { email: C, organizationUuid: ORG_A }],
      live: C
    })
    await h.observe(ORG_TEAM, '0.12')

    h.live.email = null
    await h.advance(LIVE_USAGE_COALESCE_MS)
    await h.observe(ORG_TEAM, '0.2')

    expect(h.published).toHaveLength(0)
    expect(h.deps.writeLiveUsage).not.toHaveBeenCalled()
  })

  it('treats a change of the signed-in account it saw itself as a switch', async () => {
    // Nothing on record (a sign-in made outside the app): the updater only
    // has the identity file to go by.
    const h = makeHarness({ organizations: team(), live: A })
    await h.observe(ORG_TEAM, '0.12')
    expect(h.published.map((p) => p.email)).toEqual([A])

    await h.advance(60_000)
    h.live.email = B
    // A request of A still answering, or B's first one: nothing can tell.
    await h.observe(ORG_TEAM, '0.2')
    await h.advance(ACCOUNT_SWITCH_SETTLE_MS - 1_000)
    await h.observe(ORG_TEAM, '0.21')
    expect(h.published).toHaveLength(1)

    await h.advance(1_000)
    await h.observe(ORG_TEAM, '0.22')
    expect(h.published.map((p) => p.email)).toEqual([A, B])
    expect(h.sevenDay(A)).toBe(12)
    expect(h.sevenDay(B)).toBe(22)
  })

  it('drops a held reading that turns out to be shared right after a switch', async () => {
    const h = makeHarness({
      organizations: [
        { email: A, organizationUuid: null },
        { email: B, organizationUuid: null }
      ],
      live: A
    })
    await h.observe(ORG_TEAM, '0.12')
    await h.advance(5_000)

    // The user switches while the reading waits, then both seats are learned.
    h.live.email = B
    h.lastSwitchAt.value = h.now()
    h.organizations[0].organizationUuid = ORG_TEAM
    h.organizations[1].organizationUuid = ORG_TEAM
    await h.advance(UNKNOWN_ORGANIZATION_HOLD_MS)

    expect(h.published).toHaveLength(0)
  })
})

describe('the account id the client reported', () => {
  it('is never used for an organization-only observation, even when it is a managed account', async () => {
    const h = makeHarness({ organizations: [{ email: B, organizationUuid: ORG_B }], live: A })

    // Unknown organization, reported uuid of managed (and signed-in) account A.
    await h.observe(ORG_NOBODY, '0.12', { accountUuid: UUID_A })
    await h.advance(UNKNOWN_ORGANIZATION_HOLD_MS + 1_000)
    expect(h.published).toHaveLength(0)

    // Known organization, reported uuid of another account: the organization decides.
    await h.observe(ORG_B, '0.36', { accountUuid: UUID_A })
    expect(h.published.map((p) => p.email)).toEqual([B])
    expect(h.rows.has(A)).toBe(false)

    // Shared organization inside the switch window, reported uuid of one seat.
    h.organizations.push({ email: A, organizationUuid: ORG_B })
    h.lastSwitchAt.value = h.now()
    await h.advance(LIVE_USAGE_COALESCE_MS)
    await h.observe(ORG_B, '0.4', { accountUuid: UUID_A })
    expect(h.published).toHaveLength(1)

    expect(h.deps.listManagedAccounts).not.toHaveBeenCalled()
    expect(h.deps.readLiveTokenFingerprint).not.toHaveBeenCalled()
  })

  it('is not used either when the organization given is blank', async () => {
    const h = makeHarness({ organizations: mapped(), live: A })

    await h.observe('   ', '0.12', { accountUuid: UUID_A })

    expect(h.published).toHaveLength(0)
    expect(h.deps.listManagedAccounts).not.toHaveBeenCalled()
  })
})

describe('the mid-prompt switch timeline (PRD section 3)', () => {
  const at = (h: Harness, hhmmss: string): Promise<void> => {
    const [hours, minutes, seconds] = hhmmss.split(':').map(Number)
    return h.advance(Date.UTC(2026, 10, 1, hours, minutes, seconds) - h.now())
  }

  it('credits each reading to the account that was billed', async () => {
    // "first account" is org f43590b8, "second account" is org 3ccde938.
    const h = makeHarness({ organizations: mapped(), live: A })

    // 10:36:32 request 1 headers arrive: org f43590b8, 7d 0.12.
    await at(h, '10:36:32')
    await h.observe(ORG_A, '0.12')
    // 10:36:56 the user switches account; request 1 is still streaming.
    await at(h, '10:36:56')
    h.live.email = B
    h.lastSwitchAt.value = h.now()
    // 10:37:43 request 1 finishes: nothing new in the log, nothing to apply.
    await at(h, '10:37:43')
    expect(h.published).toHaveLength(1)
    // 10:37:53 request 2 headers arrive: org 3ccde938, 7d 0.36.
    await at(h, '10:37:53')
    await h.observe(ORG_B, '0.36')

    expect(
      h.published.map((p) => [p.email, p.usage.seven_day?.utilization, p.isLiveAccount])
    ).toEqual([
      [A, 12, true],
      [B, 36, true]
    ])
    // Neither row shows the other's numbers.
    expect(h.sevenDay(A)).toBe(12)
    expect(h.sevenDay(B)).toBe(36)
  })

  it('credits a response that arrives after the switch to the account left, not live', async () => {
    const h = makeHarness({ organizations: mapped(), live: A })
    await at(h, '10:36:32')
    await h.observe(ORG_A, '0.12')
    await at(h, '10:36:56')
    h.live.email = B
    h.lastSwitchAt.value = h.now()

    // Two seconds after the switch, another response of the request that
    // started on the first account: still billed to its organization.
    await at(h, '10:36:58')
    await h.observe(ORG_A, '0.13')

    expect(h.published).toHaveLength(2)
    expect(h.published[1]).toMatchObject({ email: A, isLiveAccount: false, liveEmail: B })
    expect(h.sevenDay(A)).toBe(13)
    expect(h.rows.has(B)).toBe(false)
  })
})

describe('bursts for one organization', () => {
  it('are coalesced: the first reading now, the newest of the rest a beat later', async () => {
    const h = makeHarness({ organizations: mapped(), live: A })

    await h.observe(ORG_A, '0.10')
    await h.observe(ORG_A.toUpperCase(), '0.11', { observedAt: h.now() + 1 })
    await h.observe(ORG_A, '0.12', { observedAt: h.now() + 2 })
    expect(h.published.map((p) => p.usage.seven_day?.utilization)).toEqual([10])

    await h.advance(LIVE_USAGE_COALESCE_MS)
    expect(h.published.map((p) => p.usage.seven_day?.utilization)).toEqual([10, 12])

    await h.advance(10 * LIVE_USAGE_COALESCE_MS)
    expect(h.published).toHaveLength(2)
  })

  it('do not hold back another organization or a credential', async () => {
    const h = makeHarness({ organizations: mapped(), live: A })

    await h.observe(ORG_A, '0.10')
    await h.observe(ORG_B, '0.36')
    h.updater.observe({
      credentialFingerprint: `fp-${A}`,
      accountUuid: null,
      snapshot: snapshot('0.11'),
      observedAt: h.now()
    })
    await h.updater.settle()

    expect(h.published.map((p) => p.email)).toEqual([A, B, A])
  })
})

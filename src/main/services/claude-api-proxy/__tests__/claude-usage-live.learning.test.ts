// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Learning organizations from proxied traffic through the app's own updater:
// the real updater wired to a fake database (rows with their organization, and
// a setter that behaves like the real one), a fake account store (who holds
// which token) and a fake event publisher.

interface Row {
  id: string
  provider: string
  email: string
  last_usage_json: string | null
  org_uuid: string | null
}

const dbMocks = vi.hoisted(() => ({
  rows: new Map<string, Row>(),
  /** Every call of the setter, as (row id, organization). */
  setOrganization: vi.fn()
}))

const storeMocks = vi.hoisted(() => ({
  accounts: [] as Array<{ email: string; uuid: string; tokenFingerprint: string | null }>,
  listClaudeAccountTokenFingerprints: vi.fn(async () => storeMocks.accounts),
  readClaudeLiveTokenFingerprint: vi.fn(async () => null as string | null),
  isClaudeAccountManaged: vi.fn(async (email: string) =>
    storeMocks.accounts.some((account) => account.email === email)
  ),
  readClaudeAccountIndexUpdatedAt: vi.fn(async () => 0),
  readClaudeLiveIdentityCached: vi.fn(async () => ({
    email: null as string | null,
    uuid: null as string | null
  })),
  readClaudeLiveRawBlob: vi.fn(async () => null as string | null),
  addClaudeAccount: vi.fn(async () => '1'),
  rememberClaudeAccountUuid: vi.fn(async () => false)
}))

const publisherMocks = vi.hoisted(() => ({
  publishDesktopBackendEvent: vi.fn(async () => true)
}))

vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

vi.mock('../../../db', async () => {
  const types = await vi.importActual<typeof import('../../../db/types')>('../../../db/types')
  const rowById = (id: string): Row | null =>
    [...dbMocks.rows.values()].find((row) => row.id === id) ?? null
  return {
    normalizeOrgUuid: types.normalizeOrgUuid,
    getDatabase: () => ({
      getSavedUsageAccountByProviderEmail: (_provider: string, email: string) =>
        dbMocks.rows.get(email) ?? null,
      upsertSavedUsageAccount: () => {
        throw new Error('no row should be created in these tests')
      },
      updateSavedUsageAccountLiveUsage: (id: string, lastUsageJson: string) => {
        const row = rowById(id)
        if (row !== null) row.last_usage_json = lastUsageJson
        return row
      },
      getSavedUsageAccountOrganizations: (provider: string) =>
        [...dbMocks.rows.values()]
          .filter((row) => row.provider === provider)
          .map(({ id, email, org_uuid }) => ({ id, email, org_uuid })),
      // As the real method: the value is stored normalised, on that row only.
      setSavedUsageAccountOrgUuid: (id: string, orgUuid: string | null) => {
        dbMocks.setOrganization(id, orgUuid)
        const row = rowById(id)
        if (row !== null) row.org_uuid = types.normalizeOrgUuid(orgUuid)
        return row
      }
    })
  }
})

vi.mock('../../account-store-claude', () => storeMocks)
vi.mock('../../../desktop/backend-event-publisher', () => publisherMocks)

import type { ClaudeLiveUsagePayload } from '@shared/types/claude-live-usage'
import type { UsageData } from '@shared/types/usage'
import { parseUnifiedRateLimitHeaders } from '../anthropic-rate-limit-headers'
import {
  getClaudeUsageLiveUpdater,
  submitClaudeUsageObservation,
  __resetClaudeUsageLiveUpdaterForTests
} from '../claude-usage-live'
import {
  LIVE_USAGE_COALESCE_MS,
  ORGANIZATION_CONFIRM_DELAY_MS,
  type ClaudeProxyObservedExchange
} from '../claude-usage-live-updater'

const ME = 'me@example.com'
const OTHER = 'other@example.com'
const UUID_ME = '0d2c9a9e-1f1d-4a8a-9d2c-3a4b5c6d7e8f'
const UUID_OTHER = '718fd88e-2076-4451-bc5f-066158379585'
const TOKEN_ME = 'fp-token-me'
const TOKEN_OTHER = 'fp-token-other'
// Not real organizations.
const ORG_ME = 'f43590b8-1111-4222-8333-444455556666'
const ORG_OTHER = '3ccde938-7777-4888-9999-aaaabbbbcccc'

function seed(
  email: string,
  uuid: string,
  tokenFingerprint: string | null,
  orgUuid: string | null = null
): void {
  storeMocks.accounts.push({ email, uuid, tokenFingerprint })
  dbMocks.rows.set(email, {
    id: `row-${email}`,
    provider: 'anthropic',
    email,
    last_usage_json: null,
    org_uuid: orgUuid
  })
}

function usageHeaders(sevenDay: string): Record<string, string> {
  return {
    'anthropic-ratelimit-unified-7d-utilization': sevenDay,
    'anthropic-ratelimit-unified-7d-reset': '4078890000',
    'anthropic-ratelimit-unified-status': 'allowed'
  }
}

/** A proxied exchange as the proxy host reports it to main. */
function proxied(input: {
  token: string | null
  reportedUuid: string | null
  organization: string | null
  sevenDay?: string
}): ClaudeProxyObservedExchange {
  return {
    credentialFingerprint: input.token,
    accountUuid: input.reportedUuid,
    requestBody: null,
    responseHeaders: {
      ...usageHeaders(input.sevenDay ?? '0.12'),
      ...(input.organization !== null ? { 'anthropic-organization-id': input.organization } : {})
    },
    observedAt: Date.now()
  }
}

const published = (): ClaudeLiveUsagePayload[] =>
  (
    publisherMocks.publishDesktopBackendEvent.mock.calls as unknown as Array<
      [string, ClaudeLiveUsagePayload]
    >
  ).map(([, payload]) => payload)

const storedSevenDay = (email: string): number | null => {
  const json = dbMocks.rows.get(email)?.last_usage_json
  return json ? ((JSON.parse(json) as UsageData).seven_day?.utilization ?? null) : null
}

const settled = (): Promise<void> => getClaudeUsageLiveUpdater().settle()

async function send(exchange: ClaudeProxyObservedExchange): Promise<void> {
  getClaudeUsageLiveUpdater().handleExchange(exchange)
  await settled()
}

/** Let `ms` pass on the updater's timers and wait for what they started. */
async function pass(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await settled()
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  dbMocks.rows.clear()
  storeMocks.accounts.length = 0
  // OTHER is signed in; ME's requests are the ones still running on its token.
  storeMocks.readClaudeLiveIdentityCached.mockResolvedValue({ email: OTHER, uuid: UUID_OTHER })
  storeMocks.readClaudeLiveTokenFingerprint.mockResolvedValue(TOKEN_OTHER)
  storeMocks.readClaudeAccountIndexUpdatedAt.mockResolvedValue(0)
})

afterEach(() => {
  __resetClaudeUsageLiveUpdaterForTests()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('organizations learned from proxied traffic, through the app updater', () => {
  it('stores the organization of a response for the account its credential belongs to', async () => {
    seed(ME, UUID_ME, TOKEN_ME)
    seed(OTHER, UUID_OTHER, TOKEN_OTHER)

    await send(proxied({ token: TOKEN_ME, reportedUuid: UUID_ME, organization: ORG_ME }))

    expect(dbMocks.setOrganization).toHaveBeenCalledExactlyOnceWith(`row-${ME}`, ORG_ME)
    expect(dbMocks.rows.get(ME)?.org_uuid).toBe(ORG_ME)
    expect(dbMocks.rows.get(OTHER)?.org_uuid).toBeNull()
    expect(published().map((payload) => payload.email)).toEqual([ME])
    expect(storedSevenDay(ME)).toBe(12)
  })

  it('does not write again for further exchanges with the same organization', async () => {
    seed(ME, UUID_ME, TOKEN_ME)
    seed(OTHER, UUID_OTHER, TOKEN_OTHER)

    await send(proxied({ token: TOKEN_ME, reportedUuid: UUID_ME, organization: ORG_ME }))
    for (const sevenDay of ['0.2', '0.3']) {
      await pass(LIVE_USAGE_COALESCE_MS)
      await send(
        proxied({
          token: TOKEN_ME,
          reportedUuid: UUID_ME,
          organization: ORG_ME.toUpperCase(),
          sevenDay
        })
      )
    }

    expect(published()).toHaveLength(3)
    expect(storedSevenDay(ME)).toBe(30)
    expect(dbMocks.setOrganization).toHaveBeenCalledTimes(1)
  })

  it('replaces an organization stored earlier with the one the account is billed to now', async () => {
    seed(ME, UUID_ME, TOKEN_ME, ORG_OTHER)
    seed(OTHER, UUID_OTHER, TOKEN_OTHER)

    await send(proxied({ token: TOKEN_ME, reportedUuid: UUID_ME, organization: ORG_ME }))

    expect(dbMocks.setOrganization).toHaveBeenCalledExactlyOnceWith(`row-${ME}`, ORG_ME)
    expect(dbMocks.rows.get(ME)?.org_uuid).toBe(ORG_ME)
  })

  it('learns the signed-in account from a single exchange, once its pairing is confirmed', async () => {
    seed(ME, UUID_ME, TOKEN_ME)
    storeMocks.readClaudeLiveIdentityCached.mockResolvedValue({ email: ME, uuid: UUID_ME })
    storeMocks.readClaudeLiveTokenFingerprint.mockResolvedValue(TOKEN_ME)

    await send(proxied({ token: TOKEN_ME, reportedUuid: UUID_ME, organization: ORG_ME }))
    expect(published()).toHaveLength(1)
    expect(published()[0]).toMatchObject({ email: ME, isLiveAccount: true })
    expect(dbMocks.setOrganization).not.toHaveBeenCalled()

    await pass(ORGANIZATION_CONFIRM_DELAY_MS)

    expect(dbMocks.setOrganization).toHaveBeenCalledExactlyOnceWith(`row-${ME}`, ORG_ME)
    expect(dbMocks.rows.get(ME)?.org_uuid).toBe(ORG_ME)
    expect(published()).toHaveLength(1)
  })

  it('stores nothing for an exchange placed by the reported account id or not placed at all', async () => {
    seed(ME, UUID_ME, TOKEN_ME)
    seed(OTHER, UUID_OTHER, TOKEN_OTHER)

    // A credential no account holds, tokens readable: not attributed.
    await send(proxied({ token: 'fp-stranger', reportedUuid: UUID_ME, organization: ORG_ME }))
    expect(published()).toHaveLength(0)

    // No credential on the request: placed by the uuid it reported.
    await send(proxied({ token: null, reportedUuid: UUID_ME, organization: ORG_ME }))
    expect(published().map((payload) => payload.email)).toEqual([ME])

    await pass(10 * 60_000)
    expect(dbMocks.setOrganization).not.toHaveBeenCalled()
    expect(dbMocks.rows.get(ME)?.org_uuid).toBeNull()
  })

  it('stores nothing where no token can be read and the reported id is all there is', async () => {
    seed(ME, UUID_ME, null)
    storeMocks.readClaudeLiveTokenFingerprint.mockResolvedValue(null)

    await send(proxied({ token: 'fp-unreadable', reportedUuid: UUID_ME, organization: ORG_ME }))
    await pass(10 * 60_000)

    expect(published().map((payload) => payload.email)).toEqual([ME])
    expect(dbMocks.setOrganization).not.toHaveBeenCalled()
  })

  it('leaves everything as it is for a response without the organization header', async () => {
    seed(ME, UUID_ME, TOKEN_ME, ORG_ME)
    seed(OTHER, UUID_OTHER, TOKEN_OTHER)

    await send(proxied({ token: TOKEN_ME, reportedUuid: UUID_ME, organization: null }))
    await pass(10 * 60_000)

    expect(published().map((payload) => payload.email)).toEqual([ME])
    expect(dbMocks.setOrganization).not.toHaveBeenCalled()
    expect(dbMocks.rows.get(ME)?.org_uuid).toBe(ORG_ME)
  })

  it('end to end: an organization-only observation follows the mapping a proxied exchange taught', async () => {
    seed(ME, UUID_ME, TOKEN_ME)
    seed(OTHER, UUID_OTHER, TOKEN_OTHER)
    const organizationOnly = (organizationUuid: string, sevenDay: string): void =>
      submitClaudeUsageObservation({
        credentialFingerprint: null,
        accountUuid: null,
        organizationUuid,
        snapshot: parseUnifiedRateLimitHeaders(usageHeaders(sevenDay))!,
        observedAt: Date.now()
      })

    // Before anything was learned the organization belongs to nobody.
    organizationOnly(ORG_ME, '0.5')
    await settled()
    expect(published()).toHaveLength(0)

    // One proxied exchange on ME's token teaches it, which also releases the held reading.
    await send(proxied({ token: TOKEN_ME, reportedUuid: UUID_ME, organization: ORG_ME }))
    expect(dbMocks.rows.get(ME)?.org_uuid).toBe(ORG_ME)
    expect(published().map((payload) => payload.email)).toEqual([ME, ME])

    // From here on a reading that names only the organization is ME's.
    await pass(LIVE_USAGE_COALESCE_MS)
    organizationOnly(ORG_ME, '0.61')
    await settled()

    expect(published()).toHaveLength(3)
    expect(published()[2]).toMatchObject({ email: ME, accountId: `row-${ME}`, accountUuid: null })
    expect(storedSevenDay(ME)).toBe(61)
    expect(storedSevenDay(OTHER)).toBeNull()
    // The mapping was written once, by the proxied exchange.
    expect(dbMocks.setOrganization).toHaveBeenCalledTimes(1)
  })
})

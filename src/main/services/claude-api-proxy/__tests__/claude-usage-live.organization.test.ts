// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Organization-identified observations through the app's own entry point: the
// real updater wired to a fake database (the per-account organizations), a
// fake account store (the managed index and its last-changed stamp) and a
// fake event publisher.

interface Row {
  id: string
  provider: string
  email: string
  last_usage_json: string | null
  org_uuid: string | null
}

const dbMocks = vi.hoisted(() => ({ rows: new Map<string, Row>() }))

const storeMocks = vi.hoisted(() => ({
  managed: new Set<string>(),
  listClaudeAccountTokenFingerprints: vi.fn(async () => []),
  readClaudeLiveTokenFingerprint: vi.fn(async () => null as string | null),
  isClaudeAccountManaged: vi.fn(async (email: string) => storeMocks.managed.has(email)),
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
  return {
    normalizeOrgUuid: types.normalizeOrgUuid,
    getDatabase: () => ({
      getSavedUsageAccountByProviderEmail: (_provider: string, email: string) =>
        dbMocks.rows.get(email) ?? null,
      upsertSavedUsageAccount: () => {
        throw new Error('no row should be created in these tests')
      },
      updateSavedUsageAccountLiveUsage: (id: string, lastUsageJson: string) => {
        for (const row of dbMocks.rows.values()) {
          if (row.id === id) {
            row.last_usage_json = lastUsageJson
            return row
          }
        }
        return null
      },
      // As the real method: every account of the provider, organization or not.
      getSavedUsageAccountOrganizations: (provider: string) =>
        [...dbMocks.rows.values()]
          .filter((row) => row.provider === provider)
          .map(({ id, email, org_uuid }) => ({ id, email, org_uuid }))
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
  notifyClaudeOrganizationsLearned,
  setClaudeOrganizationsNeededHandler,
  submitClaudeUsageObservation,
  __resetClaudeUsageLiveUpdaterForTests
} from '../claude-usage-live'
import type { ClaudeUsageObservation } from '../claude-usage-live-updater'

const ME = 'me@example.com'
const OTHER = 'other@example.com'
const UUID_ME = '0d2c9a9e-1f1d-4a8a-9d2c-3a4b5c6d7e8f'
const ORG_ME = 'f43590b8-1111-4222-8333-444455556666'
const ORG_OTHER = '3ccde938-7777-4888-9999-aaaabbbbcccc'

function seed(email: string, orgUuid: string | null): void {
  storeMocks.managed.add(email)
  dbMocks.rows.set(email, {
    id: `row-${email}`,
    provider: 'anthropic',
    email,
    last_usage_json: null,
    org_uuid: orgUuid
  })
}

/** What the debug-log source submits: usage headers and the billed organization, nothing else. */
function organizationObservation(
  organizationUuid: string,
  sevenDay: string,
  observedAt = Date.now()
): ClaudeUsageObservation {
  return {
    credentialFingerprint: null,
    accountUuid: null,
    organizationUuid,
    snapshot: parseUnifiedRateLimitHeaders({
      'anthropic-ratelimit-unified-7d-utilization': sevenDay,
      'anthropic-ratelimit-unified-7d-reset': '4078890000',
      'anthropic-ratelimit-unified-status': 'allowed'
    })!,
    observedAt
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

beforeEach(() => {
  dbMocks.rows.clear()
  storeMocks.managed.clear()
  storeMocks.readClaudeLiveIdentityCached.mockResolvedValue({ email: ME, uuid: UUID_ME })
  storeMocks.readClaudeAccountIndexUpdatedAt.mockResolvedValue(0)
})

afterEach(() => {
  __resetClaudeUsageLiveUpdaterForTests()
  vi.clearAllMocks()
})

describe('organization-identified observations through submitClaudeUsageObservation', () => {
  it('updates the account the organization is stored for, live or not, and both consumers', async () => {
    seed(ME, ORG_ME)
    seed(OTHER, ORG_OTHER)

    submitClaudeUsageObservation(organizationObservation(ORG_ME, '0.12', 1_000))
    submitClaudeUsageObservation(organizationObservation(ORG_OTHER.toUpperCase(), '0.36', 2_000))
    await settled()

    expect(published()).toHaveLength(2)
    expect(published()[0]).toMatchObject({
      accountId: `row-${ME}`,
      email: ME,
      accountUuid: null,
      isLiveAccount: true,
      observedAt: 1_000
    })
    expect(published()[1]).toMatchObject({ email: OTHER, isLiveAccount: false, liveEmail: ME })
    expect(storedSevenDay(ME)).toBe(12)
    expect(storedSevenDay(OTHER)).toBe(36)
    // Nothing about them touches the Keychain.
    expect(storeMocks.listClaudeAccountTokenFingerprints).not.toHaveBeenCalled()
    expect(storeMocks.readClaudeLiveTokenFingerprint).not.toHaveBeenCalled()
  })

  it('asks the connected learner for an unknown organization and applies the reading once it is stored', async () => {
    seed(ME, null)
    const learner = vi.fn()
    setClaudeOrganizationsNeededHandler(learner)

    submitClaudeUsageObservation(organizationObservation(ORG_ME, '0.12'))
    await settled()
    expect(learner).toHaveBeenCalledTimes(1)
    expect(published()).toHaveLength(0)
    expect(storedSevenDay(ME)).toBeNull()

    // What T12/T13 will do: store the organization, then say so.
    dbMocks.rows.get(ME)!.org_uuid = ORG_ME
    notifyClaudeOrganizationsLearned()
    await settled()

    expect(published().map((payload) => payload.email)).toEqual([ME])
    expect(storedSevenDay(ME)).toBe(12)

    notifyClaudeOrganizationsLearned()
    await settled()
    expect(published()).toHaveLength(1)
  })

  it('works with no learner connected, and notifying before anything was submitted builds nothing', async () => {
    notifyClaudeOrganizationsLearned()
    seed(ME, null)

    submitClaudeUsageObservation(organizationObservation(ORG_ME, '0.12'))
    await settled()

    expect(published()).toHaveLength(0)
  })

  it('reads the last switch from the account index for an organization two accounts share', async () => {
    seed(ME, ORG_ME)
    seed(OTHER, ORG_ME)

    // The index changed a moment ago (a switch): neither seat is credited.
    storeMocks.readClaudeAccountIndexUpdatedAt.mockResolvedValue(Date.now() - 5_000)
    submitClaudeUsageObservation(organizationObservation(ORG_ME, '0.12'))
    await settled()
    expect(published()).toHaveLength(0)

    // Long after the last switch, the signed-in seat is.
    __resetClaudeUsageLiveUpdaterForTests()
    storeMocks.readClaudeAccountIndexUpdatedAt.mockResolvedValue(Date.now() - 10 * 60_000)
    submitClaudeUsageObservation(organizationObservation(ORG_ME, '0.2'))
    await settled()

    expect(published().map((payload) => payload.email)).toEqual([ME])
    expect(storedSevenDay(ME)).toBe(20)
    expect(storedSevenDay(OTHER)).toBeNull()
  })
})

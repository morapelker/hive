// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// An unknown-organization reading, from the live updater to the learner and back, with both
// processes in one: the real updater and its bridge (the main process), and the server child's
// real event bus, its real connection to learning (what server.ts calls), the real learner, the
// real profile request and the real "store and signal", on a fake table of accounts, fake
// credentials and simulated HTTP responses. Only the two IPC hops are shortened: what main
// publishes for the backend is put on the child's event bus, and what the child reports to main
// is heard in-process. The test never starts a sweep itself.

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
  readClaudeLiveKeychainRaw: vi.fn(async () => null as string | null),
  addClaudeAccount: vi.fn(async () => '1'),
  rememberClaudeAccountUuid: vi.fn(async () => false)
}))

const publisherMocks = vi.hoisted(() => ({
  publishDesktopBackendEvent: vi.fn(async (_channel: string, _payload: unknown) => true)
}))

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

vi.mock('../../../db', async () => {
  const types = await vi.importActual<typeof import('../../../db/types')>('../../../db/types')
  const rowById = (id: string): Row | undefined =>
    [...dbMocks.rows.values()].find((row) => row.id === id)
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
        if (!row) return null
        row.last_usage_json = lastUsageJson
        return row
      },
      getSavedUsageAccountOrganizations: (provider: string) =>
        [...dbMocks.rows.values()]
          .filter((row) => row.provider === provider)
          .map(({ id, email, org_uuid }) => ({ id, email, org_uuid })),
      getSavedUsageAccountOrgUuid: (id: string) => rowById(id)?.org_uuid ?? null,
      setSavedUsageAccountOrgUuid: (id: string, orgUuid: string | null) => {
        const row = rowById(id)
        if (!row) return null
        row.org_uuid = types.normalizeOrgUuid(orgUuid)
        return row
      }
    })
  }
})

vi.mock('../../account-store-claude', () => storeMocks)
vi.mock('../../../desktop/backend-event-publisher', () => publisherMocks)

import {
  CLAUDE_LIVE_USAGE_CHANNEL,
  type ClaudeLiveUsagePayload
} from '@shared/types/claude-live-usage'
import type { UsageData } from '@shared/types/usage'
import { Effect } from 'effect'
import { connectClaudeOrganizationLearningInServer } from '../../../../server/claude-organization-forwarder'
import { makeEventBus } from '../../../../server/events/event-bus'
import {
  ClaudeOrganizationLearner,
  storeClaudeAccountOrganization
} from '../../claude-organization-learner'
import {
  CLAUDE_ORGANIZATIONS_NEEDED_CHANNEL,
  __resetClaudeOrganizationSignalForTests,
  setClaudeOrganizationLearnedPublisher
} from '../../usage/claude-organization-signal'
import { fetchClaudeProfileOrganization } from '../../usage-service'
import { parseUnifiedRateLimitHeaders } from '../anthropic-rate-limit-headers'
import { connectClaudeOrganizationLearning } from '../claude-organization-learning'
import {
  getClaudeUsageLiveUpdater,
  submitClaudeUsageObservation,
  __resetClaudeUsageLiveUpdaterForTests
} from '../claude-usage-live'
import type { ClaudeUsageObservation } from '../claude-usage-live-updater'

const ME = 'me@example.com'
const OTHER = 'other@example.com'
const UUID_ME = '0d2c9a9e-1f1d-4a8a-9d2c-3a4b5c6d7e8f'
const ORG_ME = 'f43590b8-1111-4222-8333-444455556666'
const ORG_OTHER = '3ccde938-7777-4888-9999-aaaabbbbcccc'
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'

/** The organization each account's own token answers with; a Response stands for an error. */
let profiles = new Map<string, string | Response>()
let fetchMock: ReturnType<typeof vi.fn>
let learner: ClaudeOrganizationLearner
/** The sweeps the "organizations needed" event started, and nothing else. */
let sweeps: Array<Promise<void>> = []
let disconnect: () => void = () => undefined
let disconnectServer: () => void = () => undefined

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
  sevenDay: string
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
    observedAt: Date.now()
  }
}

const calls = (channel: string): unknown[] =>
  publisherMocks.publishDesktopBackendEvent.mock.calls
    .filter(([sent]) => sent === channel)
    .map(([, payload]) => payload)

const liveUpdates = (): ClaudeLiveUsagePayload[] =>
  calls(CLAUDE_LIVE_USAGE_CHANNEL) as ClaudeLiveUsagePayload[]

const storedSevenDay = (email: string): number | null => {
  const json = dbMocks.rows.get(email)?.last_usage_json
  return json ? ((JSON.parse(json) as UsageData).seven_day?.utilization ?? null) : null
}

/** Let the updater finish, then the learning it asked for (if it did), then what that released. */
async function settled(): Promise<void> {
  await getClaudeUsageLiveUpdater().settle()
  await Promise.all(sweeps)
  await getClaudeUsageLiveUpdater().settle()
}

beforeEach(() => {
  dbMocks.rows.clear()
  storeMocks.managed.clear()
  storeMocks.readClaudeLiveIdentityCached.mockResolvedValue({ email: ME, uuid: UUID_ME })
  storeMocks.readClaudeAccountIndexUpdatedAt.mockResolvedValue(0)
  profiles = new Map()

  fetchMock = vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
    if (url !== PROFILE_URL) throw new Error(`unexpected request to ${url}`)
    const token = init.headers.Authorization.replace('Bearer ', '')
    const answer = profiles.get(token)
    if (answer instanceof Response) return answer
    if (answer === undefined) return new Response('{}', { status: 401 })
    return new Response(
      JSON.stringify({ account: { email: 'someone@example.com' }, organization: { uuid: answer } }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  })
  vi.stubGlobal('fetch', fetchMock)

  // The server child's side: the learner as the app builds it, with the account store replaced
  // by one token per managed account.
  learner = new ClaudeOrganizationLearner({
    listAccountsWithoutOrganization: () =>
      [...dbMocks.rows.values()]
        .filter((row) => row.org_uuid === null)
        .map(({ id, email }) => ({ id, email })),
    readCredential: async (account) =>
      storeMocks.managed.has(account.email) ? { accessToken: `token-of-${account.email}` } : null,
    fetchOrganization: fetchClaudeProfileOrganization,
    storeOrganization: (account, organizationUuid) =>
      storeClaudeAccountOrganization(account, organizationUuid, { replace: false })
  })
  // The child's event bus, connected to learning as server.ts connects it; account
  // maintenance's part (start a sweep) is the learner above.
  sweeps = []
  const eventBus = makeEventBus()
  disconnectServer = connectClaudeOrganizationLearningInServer(eventBus, () => {
    sweeps.push(learner.sweep())
  })
  // What the child would send main over IPC is heard here directly.
  setClaudeOrganizationLearnedPublisher(null)
  // What main publishes for the backend arrives on the child's event bus.
  publisherMocks.publishDesktopBackendEvent.mockImplementation(
    async (channel: string, payload: unknown) => {
      Effect.runSync(eventBus.publish({ channel, payload }))
      return true
    }
  )

  disconnect = connectClaudeOrganizationLearning()
})

afterEach(() => {
  disconnect()
  disconnectServer()
  __resetClaudeUsageLiveUpdaterForTests()
  __resetClaudeOrganizationSignalForTests()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('an unknown-organization reading triggers learning', () => {
  it('asks for organizations, learns them per account, and applies the held reading to the right one', async () => {
    seed(ME, null)
    seed(OTHER, null)
    profiles.set(`token-of-${ME}`, ORG_ME)
    profiles.set(`token-of-${OTHER}`, ORG_OTHER)

    // A Code Mode session on the other account: its organization is not mapped to anyone yet.
    submitClaudeUsageObservation(organizationObservation(ORG_OTHER, '0.36'))
    await settled()

    // Main asked the child once; the child asked each account's own profile once.
    expect(calls(CLAUDE_ORGANIZATIONS_NEEDED_CHANNEL)).toHaveLength(1)
    expect(fetchMock.mock.calls.map(([, init]) => init.headers.Authorization)).toEqual([
      `Bearer token-of-${ME}`,
      `Bearer token-of-${OTHER}`
    ])
    expect(dbMocks.rows.get(ME)!.org_uuid).toBe(ORG_ME)
    expect(dbMocks.rows.get(OTHER)!.org_uuid).toBe(ORG_OTHER)

    // The reading that was held went to the account that organization belongs to, and only it.
    expect(liveUpdates().map((payload) => payload.email)).toEqual([OTHER])
    expect(liveUpdates()[0]).toMatchObject({ accountId: `row-${OTHER}`, isLiveAccount: false })
    expect(storedSevenDay(OTHER)).toBe(36)
    expect(storedSevenDay(ME)).toBeNull()
  })

  it('makes no request for the account whose organization is already known', async () => {
    seed(ME, ORG_ME)
    seed(OTHER, null)
    profiles.set(`token-of-${ME}`, ORG_ME)
    profiles.set(`token-of-${OTHER}`, ORG_OTHER)

    submitClaudeUsageObservation(organizationObservation(ORG_OTHER, '0.36'))
    await settled()

    expect(fetchMock.mock.calls.map(([, init]) => init.headers.Authorization)).toEqual([
      `Bearer token-of-${OTHER}`
    ])
    expect(storedSevenDay(OTHER)).toBe(36)
  })

  it('asks nothing at all for a reading whose organization is known', async () => {
    seed(ME, ORG_ME)

    submitClaudeUsageObservation(organizationObservation(ORG_ME, '0.12'))
    await settled()

    expect(calls(CLAUDE_ORGANIZATIONS_NEEDED_CHANNEL)).toHaveLength(0)
    expect(sweeps).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(storedSevenDay(ME)).toBe(12)
  })

  it('keeps holding the reading, credits nobody and does not retry at once when learning fails', async () => {
    seed(ME, null)
    profiles.set(`token-of-${ME}`, new Response('{}', { status: 503 }))

    submitClaudeUsageObservation(organizationObservation(ORG_ME, '0.12'))
    await settled()
    // A second reading for the same organization, moments later.
    submitClaudeUsageObservation(organizationObservation(ORG_ME, '0.13'))
    await settled()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(dbMocks.rows.get(ME)!.org_uuid).toBeNull()
    expect(liveUpdates()).toHaveLength(0)
    expect(storedSevenDay(ME)).toBeNull()
  })

  it('does not credit an account whose own organization is a different one', async () => {
    seed(ME, null)
    profiles.set(`token-of-${ME}`, ORG_ME)

    submitClaudeUsageObservation(organizationObservation(ORG_OTHER, '0.36'))
    await settled()

    expect(dbMocks.rows.get(ME)!.org_uuid).toBe(ORG_ME)
    expect(liveUpdates()).toHaveLength(0)
    expect(storedSevenDay(ME)).toBeNull()
  })

  it('stops asking once disconnected', async () => {
    seed(ME, null)
    disconnect()

    submitClaudeUsageObservation(organizationObservation(ORG_ME, '0.12'))
    await getClaudeUsageLiveUpdater().settle()

    expect(calls(CLAUDE_ORGANIZATIONS_NEEDED_CHANNEL)).toHaveLength(0)
    expect(sweeps).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

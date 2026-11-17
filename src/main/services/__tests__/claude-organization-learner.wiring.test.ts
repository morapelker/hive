// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The learner as the app builds it (`getClaudeOrganizationLearner`) and the shared
// "store and signal" step, on a fake table of saved accounts, a fake account store and
// simulated HTTP responses.

interface Row {
  id: string
  provider: string
  email: string
  org_uuid: string | null
}

const mocks = vi.hoisted(() => ({
  rows: new Map<string, Row>(),
  setOrg: vi.fn(),
  listClaudeAccounts: vi.fn(),
  readClaudeEffectiveBlob: vi.fn(),
  readClaudeLiveKeychainRaw: vi.fn(),
  refreshAnthropicToken: vi.fn()
}))

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

vi.mock('../../db', () => ({
  getDatabase: () => ({
    getSavedUsageAccountOrganizations: (provider: string) =>
      [...mocks.rows.values()]
        .filter((row) => row.provider === provider)
        .map(({ id, email, org_uuid }) => ({ id, email, org_uuid })),
    getSavedUsageAccountOrgUuid: (id: string) => mocks.rows.get(id)?.org_uuid ?? null,
    setSavedUsageAccountOrgUuid: mocks.setOrg
  })
}))

vi.mock('../account-store-claude', () => ({
  listClaudeAccounts: mocks.listClaudeAccounts,
  readClaudeEffectiveBlob: mocks.readClaudeEffectiveBlob,
  readClaudeLiveKeychainRaw: mocks.readClaudeLiveKeychainRaw
}))

vi.mock('../oauth-anthropic', () => ({ refreshAnthropicToken: mocks.refreshAnthropicToken }))

import { accountLockKey, withAccountLock } from '../account-lock'
import {
  __resetClaudeOrganizationLearnerForTests,
  getClaudeOrganizationLearner,
  storeClaudeAccountOrganization
} from '../claude-organization-learner'
import {
  __resetClaudeOrganizationSignalForTests,
  subscribeClaudeOrganizationLearned
} from '../usage/claude-organization-signal'

const ORG_A = 'f43590b8-1111-4222-8333-444455556666'
const ORG_B = '3ccde938-7777-4888-9999-aaaabbbbcccc'
const A = 'a@example.com'
const B = 'b@example.com'
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'
const FAR = Date.now() + 8 * 3600_000

function seed(
  id: string,
  email: string,
  orgUuid: string | null = null,
  provider = 'anthropic'
): void {
  mocks.rows.set(id, { id, provider, email, org_uuid: orgUuid })
}

function storeAccount(num: string, email: string) {
  return {
    num,
    email,
    uuid: `uuid-${num}`,
    expiresAtMs: FAR,
    sessionExpiresAtMs: null,
    hasRefresh: true,
    plan: 'max',
    active: false
  }
}

function profile(organizationUuid: string): Response {
  return new Response(JSON.stringify({ organization: { uuid: organizationUuid } }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

let learned: string[] = []
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.resetAllMocks()
  mocks.rows.clear()
  learned = []
  __resetClaudeOrganizationLearnerForTests()
  __resetClaudeOrganizationSignalForTests()
  subscribeClaudeOrganizationLearned((email) => learned.push(email))

  mocks.setOrg.mockImplementation((id: string, org: string | null) => {
    const row = mocks.rows.get(id)
    if (!row) return null
    row.org_uuid = org
    return { ...row }
  })
  mocks.listClaudeAccounts.mockResolvedValue([storeAccount('1', A), storeAccount('2', B)])
  mocks.readClaudeEffectiveBlob.mockImplementation(async (num: string) => ({
    raw: '{}',
    parsed: { accessToken: `token-${num}`, refreshToken: `refresh-${num}`, expiresAt: FAR }
  }))

  fetchMock = vi.fn(async (_url: string, init: { headers: Record<string, string> }) =>
    profile(init.headers.Authorization === 'Bearer token-1' ? ORG_A : ORG_B)
  )
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  __resetClaudeOrganizationLearnerForTests()
  __resetClaudeOrganizationSignalForTests()
})

describe('getClaudeOrganizationLearner', () => {
  it("asks each Claude account without an organization, with that account's own token, and stores the answer", async () => {
    seed('row-a', A)
    seed('row-b', B)

    await getClaudeOrganizationLearner().sweep()

    expect(fetchMock.mock.calls.map(([url, init]) => [url, init.headers.Authorization])).toEqual([
      [PROFILE_URL, 'Bearer token-1'],
      [PROFILE_URL, 'Bearer token-2']
    ])
    expect(mocks.rows.get('row-a')!.org_uuid).toBe(ORG_A)
    expect(mocks.rows.get('row-b')!.org_uuid).toBe(ORG_B)
    expect(learned).toEqual([A, B])
  })

  it('makes no request for accounts that have an organization, or for another provider', async () => {
    seed('row-a', A, ORG_A)
    seed('row-codex', 'codex@example.com', null, 'openai')

    await getClaudeOrganizationLearner().sweep()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(mocks.readClaudeEffectiveBlob).not.toHaveBeenCalled()
    expect(mocks.setOrg).not.toHaveBeenCalled()
  })

  it('skips a row whose account is no longer in the account store', async () => {
    seed('row-gone', 'gone@example.com')

    await getClaudeOrganizationLearner().sweep()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(mocks.rows.get('row-gone')!.org_uuid).toBeNull()
  })

  it('never refreshes a token: an expired one is left to the token watcher', async () => {
    seed('row-a', A)
    mocks.readClaudeEffectiveBlob.mockResolvedValue({
      raw: '{}',
      parsed: { accessToken: 'token-1', refreshToken: 'refresh-1', expiresAt: Date.now() - 1 }
    })

    await getClaudeOrganizationLearner().sweep()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(mocks.refreshAnthropicToken).not.toHaveBeenCalled()
  })

  it('leaves the value empty when the request fails, and does not ask again at once', async () => {
    seed('row-a', A)
    fetchMock.mockResolvedValue(new Response('{}', { status: 500 }))

    await getClaudeOrganizationLearner().sweep()
    await getClaudeOrganizationLearner().sweep()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(mocks.rows.get('row-a')!.org_uuid).toBeNull()
    expect(mocks.setOrg).not.toHaveBeenCalled()
    expect(learned).toEqual([])
  })

  it('does not overwrite an organization stored while its request was under way', async () => {
    seed('row-a', A)
    fetchMock.mockImplementation(async () => {
      // A usage poll for this account answered first.
      mocks.rows.get('row-a')!.org_uuid = ORG_B
      return profile(ORG_A)
    })

    await getClaudeOrganizationLearner().sweep()

    expect(mocks.rows.get('row-a')!.org_uuid).toBe(ORG_B)
    expect(mocks.setOrg).not.toHaveBeenCalled()
  })

  it("holds the account's lock to read the token, and not while the request is out", async () => {
    seed('row-a', A)
    const key = accountLockKey('anthropic', A)
    const order: string[] = []

    // A switch or poll holds the account: the learner's read waits for it.
    let releaseHolder: () => void = () => undefined
    const holder = withAccountLock(
      key,
      () =>
        new Promise<void>((resolve) => {
          releaseHolder = () => {
            order.push('holder done')
            resolve()
          }
        })
    )
    mocks.readClaudeEffectiveBlob.mockImplementation(async () => {
      order.push('token read')
      return { raw: '{}', parsed: { accessToken: 'token-1', expiresAt: FAR } }
    })
    let answer: (response: Response) => void = () => undefined
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          order.push('request sent')
          answer = resolve
        })
    )

    const sweep = getClaudeOrganizationLearner().sweep()
    await new Promise((resolve) => setImmediate(resolve))
    expect(order).toEqual([])

    releaseHolder()
    await holder
    await vi.waitFor(() => expect(order).toContain('request sent'))

    // With the request still unanswered, the account's lock is free for a poll or a switch.
    await withAccountLock(key, async () => {
      order.push('poll ran')
    })
    answer(profile(ORG_A))
    await sweep

    expect(order).toEqual(['holder done', 'token read', 'request sent', 'poll ran'])
    expect(mocks.rows.get('row-a')!.org_uuid).toBe(ORG_A)
  })
})

describe('storeClaudeAccountOrganization', () => {
  const account = { id: 'row-a', email: A }

  it('stores a first organization, normalised, and says so once', () => {
    seed('row-a', A)

    expect(storeClaudeAccountOrganization(account, ` ${ORG_A.toUpperCase()} `)).toBe(true)
    expect(storeClaudeAccountOrganization(account, ORG_A)).toBe(false)

    expect(mocks.rows.get('row-a')!.org_uuid).toBe(ORG_A)
    expect(mocks.setOrg).toHaveBeenCalledTimes(1)
    expect(learned).toEqual([A])
  })

  it('replaces a different organization by default, and keeps it when asked only to fill a gap', () => {
    seed('row-a', A, ORG_B)

    expect(storeClaudeAccountOrganization(account, ORG_A, { replace: false })).toBe(false)
    expect(mocks.rows.get('row-a')!.org_uuid).toBe(ORG_B)

    expect(storeClaudeAccountOrganization(account, ORG_A)).toBe(true)
    expect(mocks.rows.get('row-a')!.org_uuid).toBe(ORG_A)
    expect(learned).toEqual([A])
  })

  it('reports nothing stored for a row that is gone, an empty value, or a database error', () => {
    expect(storeClaudeAccountOrganization(account, ORG_A)).toBe(false)

    seed('row-a', A)
    expect(storeClaudeAccountOrganization(account, '   ')).toBe(false)

    mocks.setOrg.mockImplementation(() => {
      throw new Error('database is locked')
    })
    expect(storeClaudeAccountOrganization(account, ORG_A)).toBe(false)
    expect(learned).toEqual([])
  })
})

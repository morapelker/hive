// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The per-account usage poll as the first teacher of an account's organization: the
// orchestrator on a fake table of saved accounts, a fake account store and a simulated poll
// (`fetchClaudeUsage`), which is where the response header arrives.

import type { SavedUsageAccount } from '../../src/main/db/types'

const mocks = vi.hoisted(() => ({
  rows: new Map<string, SavedUsageAccount>(),
  db: {
    getSavedUsageAccountById: vi.fn(),
    getSavedUsageAccountsByProvider: vi.fn(),
    getSavedUsageAccountByProviderEmail: vi.fn(),
    getSavedUsageAccountOrgUuid: vi.fn(),
    setSavedUsageAccountOrgUuid: vi.fn(),
    upsertSavedUsageAccount: vi.fn(),
    updateSavedUsageAccountUsage: vi.fn(),
    deleteSavedUsageAccount: vi.fn()
  },
  fetchClaudeUsage: vi.fn(),
  listClaudeAccounts: vi.fn(),
  readClaudeEffectiveBlob: vi.fn(),
  readClaudeLiveEmail: vi.fn(),
  readClaudeLiveIdentity: vi.fn(),
  readClaudeLiveRawBlob: vi.fn(),
  updateClaudeTokens: vi.fn(),
  switchClaudeAccount: vi.fn(),
  addClaudeAccount: vi.fn(),
  removeClaudeAccount: vi.fn(),
  persistRotatedLiveClaudeTokens: vi.fn(),
  listCodexAccounts: vi.fn(),
  migrateSavedCredentialsToStores: vi.fn()
}))

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

vi.mock('../../src/main/db', () => ({ getDatabase: () => mocks.db }))

vi.mock('../../src/main/services/usage-service', async () => {
  const actual = await vi.importActual<typeof import('../../src/main/services/usage-service')>(
    '../../src/main/services/usage-service'
  )
  return { ...actual, fetchClaudeUsage: mocks.fetchClaudeUsage }
})

vi.mock('../../src/main/services/openai-usage-service', () => ({
  fetchOpenAIUsage: vi.fn(),
  readCodexCredentials: vi.fn()
}))

vi.mock('../../src/main/services/account-store-claude', () => ({
  listClaudeAccounts: mocks.listClaudeAccounts,
  readClaudeEffectiveBlob: mocks.readClaudeEffectiveBlob,
  readClaudeLiveEmail: mocks.readClaudeLiveEmail,
  readClaudeLiveIdentity: mocks.readClaudeLiveIdentity,
  readClaudeLiveRawBlob: mocks.readClaudeLiveRawBlob,
  updateClaudeTokens: mocks.updateClaudeTokens,
  switchClaudeAccount: mocks.switchClaudeAccount,
  addClaudeAccount: mocks.addClaudeAccount,
  removeClaudeAccount: mocks.removeClaudeAccount,
  persistRotatedLiveClaudeTokens: mocks.persistRotatedLiveClaudeTokens
}))

vi.mock('../../src/main/services/account-store-codex', () => ({
  listCodexAccounts: mocks.listCodexAccounts,
  readCodexEffectiveAuth: vi.fn(),
  updateCodexTokens: vi.fn(),
  switchCodexAccount: vi.fn(),
  addCodexAccount: vi.fn(),
  removeCodexAccount: vi.fn(),
  persistRotatedLiveCodexTokens: vi.fn()
}))

vi.mock('../../src/main/services/credentials-migration', () => ({
  migrateSavedCredentialsToStores: mocks.migrateSavedCredentialsToStores
}))

import {
  fetchForSavedAccount,
  refreshAllForProvider,
  switchAccount
} from '../../src/main/services/saved-usage-orchestrator'
import { fetchUsageOp } from '../../src/main/services/usage-ops'
import {
  __resetClaudeOrganizationSignalForTests,
  subscribeClaudeOrganizationLearned
} from '../../src/main/services/usage/claude-organization-signal'
import type { ClaudeStoreAccount } from '../../src/main/services/account-store-claude'

const ORG_A = 'f43590b8-1111-4222-8333-444455556666'
const ORG_B = '3ccde938-7777-4888-9999-aaaabbbbcccc'
const A = 'a@example.com'
const B = 'b@example.com'

function usageData() {
  return {
    five_hour: { utilization: 12, resets_at: '2026-05-19T12:00:00.000Z' },
    seven_day: { utilization: 34, resets_at: '2026-05-20T12:00:00.000Z' }
  }
}

function seed(id: string, email: string, orgUuid: string | null = null): SavedUsageAccount {
  const row: SavedUsageAccount = {
    id,
    provider: 'anthropic',
    email,
    credentials_json: '',
    last_usage_json: null,
    last_fetched_at: null,
    status: 'ok',
    last_error: null,
    org_uuid: orgUuid,
    created_at: '2026-05-19T00:00:00.000Z',
    updated_at: '2026-05-19T00:00:00.000Z'
  }
  mocks.rows.set(id, row)
  return row
}

function storeAccount(num: string, email: string): ClaudeStoreAccount {
  return {
    num,
    email,
    uuid: `uuid-${num}`,
    expiresAtMs: null,
    sessionExpiresAtMs: null,
    hasRefresh: true,
    plan: 'max',
    active: false
  }
}

let learned: string[] = []

beforeEach(() => {
  vi.resetAllMocks()
  mocks.rows.clear()
  learned = []
  __resetClaudeOrganizationSignalForTests()
  subscribeClaudeOrganizationLearned((email) => learned.push(email))

  // A table that behaves like the real one for the columns these tests look at.
  mocks.db.getSavedUsageAccountById.mockImplementation((id: string) => {
    const row = mocks.rows.get(id)
    return row ? { ...row } : null
  })
  mocks.db.getSavedUsageAccountsByProvider.mockImplementation(() =>
    [...mocks.rows.values()].map((row) => ({ ...row }))
  )
  mocks.db.getSavedUsageAccountOrgUuid.mockImplementation(
    (id: string) => mocks.rows.get(id)?.org_uuid ?? null
  )
  mocks.db.setSavedUsageAccountOrgUuid.mockImplementation((id: string, org: string | null) => {
    const row = mocks.rows.get(id)
    if (!row) return null
    row.org_uuid = org
    return { ...row }
  })
  mocks.db.updateSavedUsageAccountUsage.mockImplementation(
    (id: string, data: Partial<SavedUsageAccount>) => {
      const row = mocks.rows.get(id)
      if (!row) return null
      Object.assign(row, data, { last_fetched_at: 'now' })
      return { ...row }
    }
  )

  mocks.migrateSavedCredentialsToStores.mockResolvedValue(undefined)
  mocks.listCodexAccounts.mockResolvedValue([])
  mocks.readClaudeLiveEmail.mockResolvedValue(null)
  mocks.listClaudeAccounts.mockResolvedValue([storeAccount('1', A), storeAccount('2', B)])
  // Each account polls with its own token.
  mocks.readClaudeEffectiveBlob.mockImplementation(async (num: string) => ({
    raw: '{}',
    parsed: { accessToken: `token-${num}`, refreshToken: `refresh-${num}`, expiresAt: 9e15 }
  }))
})

afterEach(() => {
  __resetClaudeOrganizationSignalForTests()
})

describe('the saved-account usage poll teaches the organization', () => {
  it('stores the organization the response names for the account that was polled', async () => {
    seed('row-a', A)
    seed('row-b', B)
    mocks.fetchClaudeUsage.mockResolvedValue({
      success: true,
      data: usageData(),
      organizationUuid: ORG_A
    })

    await fetchForSavedAccount('row-a')

    expect(mocks.rows.get('row-a')!.org_uuid).toBe(ORG_A)
    expect(mocks.rows.get('row-b')!.org_uuid).toBeNull()
    expect(learned).toEqual([A])
  })

  it('gives every account its own organization on the launch refresh, with one poll each', async () => {
    seed('row-a', A)
    seed('row-b', B)
    mocks.fetchClaudeUsage.mockImplementation(async (override: { accessToken: string }) => ({
      success: true,
      data: usageData(),
      organizationUuid: override.accessToken === 'token-1' ? ORG_A : ORG_B
    }))

    await refreshAllForProvider('anthropic')

    expect(mocks.fetchClaudeUsage).toHaveBeenCalledTimes(2)
    expect(mocks.rows.get('row-a')!.org_uuid).toBe(ORG_A)
    expect(mocks.rows.get('row-b')!.org_uuid).toBe(ORG_B)
    expect(learned).toEqual([A, B])
  })

  it('writes nothing and signals nothing when the account already has that organization', async () => {
    seed('row-a', A, ORG_A)
    mocks.fetchClaudeUsage.mockResolvedValue({
      success: true,
      data: usageData(),
      organizationUuid: ORG_A
    })

    await fetchForSavedAccount('row-a')
    await fetchForSavedAccount('row-a')

    expect(mocks.db.setSavedUsageAccountOrgUuid).not.toHaveBeenCalled()
    expect(learned).toEqual([])
  })

  it('replaces a stored organization the account no longer answers with', async () => {
    seed('row-a', A, ORG_B)
    mocks.fetchClaudeUsage.mockResolvedValue({
      success: true,
      data: usageData(),
      organizationUuid: ORG_A
    })

    await fetchForSavedAccount('row-a')

    expect(mocks.rows.get('row-a')!.org_uuid).toBe(ORG_A)
    expect(learned).toEqual([A])
  })

  it('leaves the organization alone when the response names none', async () => {
    seed('row-a', A)
    seed('row-b', B, ORG_B)
    mocks.fetchClaudeUsage.mockResolvedValue({ success: true, data: usageData() })

    await fetchForSavedAccount('row-a')
    await fetchForSavedAccount('row-b')

    expect(mocks.db.setSavedUsageAccountOrgUuid).not.toHaveBeenCalled()
    expect(mocks.rows.get('row-a')!.org_uuid).toBeNull()
    expect(mocks.rows.get('row-b')!.org_uuid).toBe(ORG_B)
  })

  it('learns nothing from a poll that failed or was rate limited', async () => {
    seed('row-a', A)
    mocks.fetchClaudeUsage.mockResolvedValueOnce({
      success: false,
      error: 'Usage API returned 429: Too Many Requests',
      retryAfter: 120
    })
    mocks.fetchClaudeUsage.mockResolvedValueOnce({
      success: false,
      error: 'Usage API returned 500: Internal Server Error'
    })

    await fetchForSavedAccount('row-a')
    await fetchForSavedAccount('row-a')

    expect(mocks.db.setSavedUsageAccountOrgUuid).not.toHaveBeenCalled()
    expect(mocks.rows.get('row-a')!.org_uuid).toBeNull()
    expect(learned).toEqual([])
  })

  it('hands a switch the organization the poll just stored', async () => {
    seed('row-b', B)
    mocks.fetchClaudeUsage.mockResolvedValue({
      success: true,
      data: usageData(),
      organizationUuid: ORG_B
    })

    await fetchForSavedAccount('row-b')
    await switchAccount('row-b')

    expect(mocks.switchClaudeAccount).toHaveBeenCalledWith('2', B, { organizationUuid: ORG_B })
  })
})

describe('the poll itself is unchanged by learning', () => {
  /** Everything a poll leaves behind that a caller or the renderer can see. */
  async function pollOutcome(response: Record<string, unknown>) {
    mocks.rows.clear()
    seed('row-a', A)
    mocks.db.updateSavedUsageAccountUsage.mockClear()
    mocks.fetchClaudeUsage.mockResolvedValue(response)
    const result = await fetchForSavedAccount('row-a')
    // Everything on the row but the organization itself.
    const row: Partial<SavedUsageAccount> = { ...mocks.rows.get('row-a')! }
    delete row.org_uuid
    return {
      result,
      row,
      usageWrites: mocks.db.updateSavedUsageAccountUsage.mock.calls
    }
  }

  it('returns and writes the same on success, with or without an organization on the response', async () => {
    const plain = await pollOutcome({ success: true, data: usageData() })
    const learning = await pollOutcome({
      success: true,
      data: usageData(),
      organizationUuid: ORG_A
    })

    expect(learning).toEqual(plain)
    expect(learning.result).toEqual({ success: true, data: usageData(), status: 'ok' })
    expect(mocks.rows.get('row-a')!.org_uuid).toBe(ORG_A)
  })

  it('returns and writes the same when the organization cannot be stored', async () => {
    const plain = await pollOutcome({ success: true, data: usageData() })
    mocks.db.setSavedUsageAccountOrgUuid.mockImplementation(() => {
      throw new Error('database is locked')
    })
    const learning = await pollOutcome({
      success: true,
      data: usageData(),
      organizationUuid: ORG_A
    })

    expect(learning).toEqual(plain)
    expect(mocks.rows.get('row-a')!.org_uuid).toBeNull()
    expect(learned).toEqual([])
  })

  it('reports a rate-limited poll exactly as before: error status, the retry-after, nothing learned', async () => {
    const outcome = await pollOutcome({
      success: false,
      error: 'Usage API returned 429: Too Many Requests',
      retryAfter: 120
    })

    expect(outcome.result).toEqual({
      success: false,
      error: 'Usage API returned 429: Too Many Requests',
      status: 'error',
      retryAfter: 120
    })
    expect(outcome.row.status).toBe('error')
    expect(outcome.row.last_error).toBe('Usage API returned 429: Too Many Requests')
    expect(mocks.rows.get('row-a')!.org_uuid).toBeNull()
  })

  it('reports a poll that needs a new sign-in exactly as before', async () => {
    const outcome = await pollOutcome({
      success: false,
      error: 'Token refresh failed: invalid_grant (expired)',
      needsLogin: true
    })

    expect(outcome.result).toEqual({
      success: false,
      error: 'Token refresh failed: invalid_grant (expired)',
      status: 'stale',
      retryAfter: undefined,
      needsLogin: true
    })
    expect(outcome.row.status).toBe('stale')
  })

  it('keeps the organization of a 200 whose body was not usage, and still reports the failure', async () => {
    const plain = await pollOutcome({
      success: false,
      error: 'Usage API returned an unexpected body'
    })
    const learning = await pollOutcome({
      success: false,
      error: 'Usage API returned an unexpected body',
      organizationUuid: ORG_A
    })

    expect(learning).toEqual(plain)
    expect(learning.result.status).toBe('error')
    expect(mocks.rows.get('row-a')!.org_uuid).toBe(ORG_A)
  })
})

describe('the signed-in account fetch (usage:fetch)', () => {
  it('hands the renderer no organization and stores none: the result is what it was', async () => {
    seed('row-a', A)
    mocks.readClaudeLiveEmail.mockResolvedValue(A)
    mocks.readClaudeLiveIdentity.mockResolvedValue({ email: A, uuid: 'uuid-1' })
    mocks.fetchClaudeUsage.mockResolvedValue({
      success: true,
      data: usageData(),
      organizationUuid: ORG_A
    })

    const result = await fetchUsageOp()

    expect(result).toEqual({ success: true, data: usageData() })
    expect(mocks.db.setSavedUsageAccountOrgUuid).not.toHaveBeenCalled()
    expect(learned).toEqual([])
  })
})

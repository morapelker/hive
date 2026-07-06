// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  db: {
    getSavedUsageAccountById: vi.fn(),
    getSavedUsageAccountsByProvider: vi.fn(),
    getSavedUsageAccountByProviderEmail: vi.fn(),
    upsertSavedUsageAccount: vi.fn(),
    updateSavedUsageAccountUsage: vi.fn(),
    deleteSavedUsageAccount: vi.fn()
  },
  fetchClaudeUsage: vi.fn(),
  fetchOpenAIUsage: vi.fn(),
  readCodexCredentials: vi.fn(),
  listClaudeAccounts: vi.fn(),
  readClaudeEffectiveBlob: vi.fn(),
  readClaudeLiveIdentity: vi.fn(),
  readClaudeLiveRawBlob: vi.fn(),
  updateClaudeTokens: vi.fn(),
  switchClaudeAccount: vi.fn(),
  addClaudeAccount: vi.fn(),
  removeClaudeAccount: vi.fn(),
  listCodexAccounts: vi.fn(),
  readCodexEffectiveAuth: vi.fn(),
  updateCodexTokens: vi.fn(),
  switchCodexAccount: vi.fn(),
  addCodexAccount: vi.fn(),
  removeCodexAccount: vi.fn(),
  migrateSavedCredentialsToStores: vi.fn(),
  refreshAnthropicToken: vi.fn(),
  refreshOpenAIToken: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp'
  }
}))

vi.mock('../../src/main/db', () => ({
  getDatabase: () => mocks.db
}))

vi.mock('../../src/main/services/usage-service', async () => {
  const actual = await vi.importActual<typeof import('../../src/main/services/usage-service')>(
    '../../src/main/services/usage-service'
  )
  return {
    ...actual,
    fetchClaudeUsage: mocks.fetchClaudeUsage
  }
})

vi.mock('../../src/main/services/openai-usage-service', () => ({
  fetchOpenAIUsage: mocks.fetchOpenAIUsage,
  readCodexCredentials: mocks.readCodexCredentials
}))

vi.mock('../../src/main/services/account-store-claude', () => ({
  listClaudeAccounts: mocks.listClaudeAccounts,
  readClaudeEffectiveBlob: mocks.readClaudeEffectiveBlob,
  readClaudeLiveIdentity: mocks.readClaudeLiveIdentity,
  readClaudeLiveRawBlob: mocks.readClaudeLiveRawBlob,
  updateClaudeTokens: mocks.updateClaudeTokens,
  switchClaudeAccount: mocks.switchClaudeAccount,
  addClaudeAccount: mocks.addClaudeAccount,
  removeClaudeAccount: mocks.removeClaudeAccount
}))

vi.mock('../../src/main/services/account-store-codex', () => ({
  listCodexAccounts: mocks.listCodexAccounts,
  readCodexEffectiveAuth: mocks.readCodexEffectiveAuth,
  updateCodexTokens: mocks.updateCodexTokens,
  switchCodexAccount: mocks.switchCodexAccount,
  addCodexAccount: mocks.addCodexAccount,
  removeCodexAccount: mocks.removeCodexAccount
}))

vi.mock('../../src/main/services/credentials-migration', () => ({
  migrateSavedCredentialsToStores: mocks.migrateSavedCredentialsToStores
}))

vi.mock('../../src/main/services/oauth-anthropic', () => ({
  refreshAnthropicToken: mocks.refreshAnthropicToken
}))

vi.mock('../../src/main/services/oauth-openai', () => ({
  refreshOpenAIToken: mocks.refreshOpenAIToken
}))

import {
  captureLiveAccountFromFetch,
  fetchForSavedAccount,
  listSavedAccounts,
  refreshAllForProvider,
  refreshTokensForStoreAccount,
  removeSavedAccount,
  switchAccount
} from '../../src/main/services/saved-usage-orchestrator'
import type { SavedUsageAccount } from '../../src/main/db/types'
import type { ClaudeStoreAccount } from '../../src/main/services/account-store-claude'
import type { CodexStoreAccount } from '../../src/main/services/account-store-codex'

function claudeAccount(overrides: Partial<ClaudeStoreAccount> = {}): ClaudeStoreAccount {
  return {
    num: '1',
    email: 'claude@example.com',
    uuid: 'uuid-1',
    expiresAtMs: 2_000,
    hasRefresh: true,
    plan: 'pro',
    active: true,
    ...overrides
  }
}

function codexAccount(overrides: Partial<CodexStoreAccount> = {}): CodexStoreAccount {
  return {
    accountKey: 'user-1::acct-1',
    email: 'codex@example.com',
    plan: 'plus',
    expiresAtMs: 2_000,
    hasRefresh: true,
    active: true,
    ...overrides
  }
}

function savedRow(overrides: Partial<SavedUsageAccount> = {}): SavedUsageAccount {
  return {
    id: 'saved-1',
    provider: 'anthropic',
    email: 'claude@example.com',
    credentials_json: '',
    last_usage_json: JSON.stringify({
      five_hour: { utilization: 10, resets_at: '2026-05-19T12:00:00.000Z' },
      seven_day: { utilization: 20, resets_at: '2026-05-20T12:00:00.000Z' }
    }),
    last_fetched_at: null,
    status: 'ok',
    last_error: null,
    created_at: '2026-05-19T00:00:00.000Z',
    updated_at: '2026-05-19T00:00:00.000Z',
    ...overrides
  }
}

function usageData(): { five_hour: { utilization: number; resets_at: string }; seven_day: { utilization: number; resets_at: string } } {
  return {
    five_hour: { utilization: 12, resets_at: '2026-05-19T12:00:00.000Z' },
    seven_day: { utilization: 34, resets_at: '2026-05-20T12:00:00.000Z' }
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.migrateSavedCredentialsToStores.mockResolvedValue(undefined)
  mocks.listClaudeAccounts.mockResolvedValue([])
  mocks.listCodexAccounts.mockResolvedValue([])
  mocks.db.getSavedUsageAccountsByProvider.mockReturnValue([])
  mocks.db.upsertSavedUsageAccount.mockImplementation((data: { email: string }) =>
    savedRow({ ...data, id: `new-${data.email}` })
  )
})

describe('listSavedAccounts', () => {
  it('creates a missing cache row for a store account and joins its plan', async () => {
    mocks.listClaudeAccounts.mockResolvedValue([claudeAccount({ plan: 'max' })])
    mocks.db.getSavedUsageAccountsByProvider.mockReturnValue([])

    const result = await listSavedAccounts('anthropic')

    expect(mocks.migrateSavedCredentialsToStores).toHaveBeenCalled()
    expect(mocks.db.upsertSavedUsageAccount).toHaveBeenCalledWith({
      provider: 'anthropic',
      email: 'claude@example.com',
      credentials_json: ''
    })
    expect(result).toHaveLength(1)
    expect(result[0].plan).toBe('max')
  })

  it('does not rewrite an existing cache row (only creates when missing)', async () => {
    mocks.listClaudeAccounts.mockResolvedValue([claudeAccount()])
    mocks.db.getSavedUsageAccountsByProvider.mockReturnValue([savedRow({ id: 'existing-1' })])

    const result = await listSavedAccounts('anthropic')

    expect(mocks.db.upsertSavedUsageAccount).not.toHaveBeenCalled()
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('existing-1')
  })

  it('deletes cache rows whose account no longer exists in the store', async () => {
    mocks.listClaudeAccounts.mockResolvedValue([])
    mocks.db.getSavedUsageAccountsByProvider.mockReturnValue([
      savedRow({ id: 'orphan-1', email: 'gone@example.com' })
    ])

    const result = await listSavedAccounts('anthropic')

    expect(mocks.db.deleteSavedUsageAccount).toHaveBeenCalledWith('orphan-1')
    expect(result).toHaveLength(0)
  })

  it('keeps the first account and logs a warning when two store accounts share an email', async () => {
    mocks.listClaudeAccounts.mockResolvedValue([
      claudeAccount({ num: '1', plan: 'pro' }),
      claudeAccount({ num: '2', plan: 'max' })
    ])
    mocks.db.getSavedUsageAccountsByProvider.mockReturnValue([])

    const result = await listSavedAccounts('anthropic')

    expect(result).toHaveLength(1)
    expect(result[0].plan).toBe('pro')
  })

  it('queries both providers when none is specified', async () => {
    mocks.listClaudeAccounts.mockResolvedValue([claudeAccount()])
    mocks.listCodexAccounts.mockResolvedValue([codexAccount()])
    mocks.db.getSavedUsageAccountsByProvider.mockReturnValue([])

    const result = await listSavedAccounts()

    expect(result).toHaveLength(2)
    expect(mocks.listClaudeAccounts).toHaveBeenCalled()
    expect(mocks.listCodexAccounts).toHaveBeenCalled()
  })
})

describe('fetchForSavedAccount (Claude)', () => {
  beforeEach(() => {
    mocks.db.getSavedUsageAccountById.mockReturnValue(savedRow())
    mocks.listClaudeAccounts.mockResolvedValue([claudeAccount()])
    mocks.readClaudeEffectiveBlob.mockResolvedValue({
      raw: '{}',
      parsed: { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 1_000 }
    })
  })

  it('reads effective creds from the store (not SQLite credentials_json)', async () => {
    mocks.fetchClaudeUsage.mockResolvedValue({ success: true, data: usageData() })

    await fetchForSavedAccount('saved-1')

    expect(mocks.readClaudeEffectiveBlob).toHaveBeenCalledWith('1', 'claude@example.com')
    expect(mocks.fetchClaudeUsage).toHaveBeenCalledWith(
      {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: 1_000,
        accountId: 'saved-1'
      },
      { caller: 'usage:fetchForAccount', accountId: 'saved-1', batchId: undefined }
    )
  })

  it('persists a rotation via updateClaudeTokens (never SQLite credentials)', async () => {
    mocks.fetchClaudeUsage.mockResolvedValue({
      success: true,
      data: usageData(),
      rotated: {
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresAt: 2_000,
        scope: 'a b',
        rotatedFrom: 'old-refresh'
      }
    })

    const result = await fetchForSavedAccount('saved-1')

    expect(result.success).toBe(true)
    expect(mocks.updateClaudeTokens).toHaveBeenCalledWith(
      '1',
      'claude@example.com',
      {
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresAt: 2_000,
        scope: 'a b',
        rotatedFrom: 'old-refresh'
      },
      'a b'
    )
    expect(mocks.db.updateSavedUsageAccountUsage).toHaveBeenCalledWith(
      'saved-1',
      expect.objectContaining({ status: 'ok', last_error: null })
    )
  })

  it('marks stale + needsLogin on an invalid_grant failure', async () => {
    mocks.fetchClaudeUsage.mockResolvedValue({
      success: false,
      error: 'Token refresh failed: invalid_grant (bad token)',
      needsLogin: true
    })

    const result = await fetchForSavedAccount('saved-1')

    expect(result.success).toBe(false)
    expect(result.status).toBe('stale')
    expect(result.needsLogin).toBe(true)
    expect(mocks.db.updateSavedUsageAccountUsage).toHaveBeenCalledWith(
      'saved-1',
      expect.objectContaining({ status: 'stale' })
    )
  })

  it('keeps a transient (non-auth) failure as an error status, not stale', async () => {
    mocks.fetchClaudeUsage.mockResolvedValue({
      success: false,
      error: 'Usage API returned 500: Internal Server Error'
    })

    const result = await fetchForSavedAccount('saved-1')

    expect(result.success).toBe(false)
    expect(result.status).toBe('error')
    expect(result.needsLogin).toBeUndefined()
  })

  it('treats a missing store account like stale with a clear error', async () => {
    mocks.listClaudeAccounts.mockResolvedValue([])

    const result = await fetchForSavedAccount('saved-1')

    expect(result.success).toBe(false)
    expect(result.status).toBe('stale')
    expect(result.error).toBe('account no longer in store')
    expect(mocks.fetchClaudeUsage).not.toHaveBeenCalled()
  })
})

describe('fetchForSavedAccount (OpenAI)', () => {
  beforeEach(() => {
    mocks.db.getSavedUsageAccountById.mockReturnValue(
      savedRow({ id: 'saved-openai-1', provider: 'openai', email: 'codex@example.com' })
    )
    mocks.listCodexAccounts.mockResolvedValue([codexAccount()])
    mocks.readCodexEffectiveAuth.mockResolvedValue({
      tokens: {
        access_token: 'old-access',
        refresh_token: 'old-refresh',
        account_id: 'acct-1',
        id_token: 'id-token'
      }
    })
  })

  it('reads effective creds from the store and persists rotation via updateCodexTokens', async () => {
    mocks.fetchOpenAIUsage.mockResolvedValue({
      success: true,
      data: { plan_type: 'plus', rate_limit: { primary_window: null, secondary_window: null } },
      rotated: { accessToken: 'new-access', refreshToken: 'new-refresh', rotatedFrom: 'old-refresh' }
    })

    const result = await fetchForSavedAccount('saved-openai-1')

    expect(result.success).toBe(true)
    expect(mocks.readCodexEffectiveAuth).toHaveBeenCalledWith('user-1::acct-1')
    expect(mocks.fetchOpenAIUsage).toHaveBeenCalledWith({
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      accountId: 'acct-1',
      idToken: 'id-token',
      email: 'codex@example.com'
    })
    expect(mocks.updateCodexTokens).toHaveBeenCalledWith('user-1::acct-1', {
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      rotatedFrom: 'old-refresh'
    })
  })

  it('marks stale + needsLogin on a 401 needing login', async () => {
    mocks.fetchOpenAIUsage.mockResolvedValue({
      success: false,
      error: 'OpenAI Usage API returned 401: unauthorized',
      needsLogin: true
    })

    const result = await fetchForSavedAccount('saved-openai-1')

    expect(result.success).toBe(false)
    expect(result.status).toBe('stale')
    expect(result.needsLogin).toBe(true)
  })

  it('keeps a transient failure as an error status', async () => {
    mocks.fetchOpenAIUsage.mockResolvedValue({
      success: false,
      error: 'OpenAI Usage API returned 500: boom'
    })

    const result = await fetchForSavedAccount('saved-openai-1')

    expect(result.success).toBe(false)
    expect(result.status).toBe('error')
  })
})

describe('refreshAllForProvider', () => {
  it('iterates the store-backed account list serially and marks stale only on needsLogin', async () => {
    mocks.listClaudeAccounts.mockResolvedValue([
      claudeAccount({ num: '1', email: 'a@example.com' }),
      claudeAccount({ num: '2', email: 'b@example.com' })
    ])
    const rowA = savedRow({ id: 'row-a', email: 'a@example.com' })
    const rowB = savedRow({ id: 'row-b', email: 'b@example.com' })
    mocks.db.getSavedUsageAccountsByProvider.mockReturnValue([rowA, rowB])
    mocks.db.getSavedUsageAccountById.mockImplementation((id: string) =>
      id === 'row-a' ? rowA : id === 'row-b' ? rowB : null
    )
    mocks.readClaudeEffectiveBlob.mockResolvedValue({
      raw: '{}',
      parsed: { accessToken: 'access', refreshToken: 'refresh', expiresAt: 1_000 }
    })

    const order: string[] = []
    mocks.fetchClaudeUsage.mockImplementation(async (_override, ctx) => {
      order.push(ctx.accountId)
      if (ctx.accountId === 'row-a') {
        return { success: false, error: 'Token refresh failed: invalid_grant (bad)', needsLogin: true }
      }
      return { success: false, error: 'Usage API returned 500: boom' }
    })

    const results = await refreshAllForProvider('anthropic')

    expect(order).toEqual(['row-a', 'row-b'])
    expect(results).toEqual([
      { accountId: 'row-a', success: false, error: 'Token refresh failed: invalid_grant (bad)', retryAfter: undefined },
      { accountId: 'row-b', success: false, error: 'Usage API returned 500: boom', retryAfter: undefined }
    ])
    expect(mocks.db.updateSavedUsageAccountUsage).toHaveBeenCalledWith(
      'row-a',
      expect.objectContaining({ status: 'stale' })
    )
    expect(mocks.db.updateSavedUsageAccountUsage).toHaveBeenCalledWith(
      'row-b',
      expect.objectContaining({ status: 'error' })
    )
  })
})

describe('removeSavedAccount', () => {
  it('removes the managed store account and the cache row', async () => {
    mocks.db.getSavedUsageAccountById.mockReturnValue(savedRow({ id: 'saved-1' }))
    mocks.listClaudeAccounts.mockResolvedValue([claudeAccount()])
    mocks.db.deleteSavedUsageAccount.mockReturnValue(true)

    const result = await removeSavedAccount('saved-1')

    expect(result).toBe(true)
    expect(mocks.removeClaudeAccount).toHaveBeenCalledWith('1', 'claude@example.com')
    expect(mocks.db.deleteSavedUsageAccount).toHaveBeenCalledWith('saved-1')
  })

  it('still deletes the cache row when the store account is already gone', async () => {
    mocks.db.getSavedUsageAccountById.mockReturnValue(savedRow({ id: 'saved-1' }))
    mocks.listClaudeAccounts.mockResolvedValue([])
    mocks.db.deleteSavedUsageAccount.mockReturnValue(true)

    const result = await removeSavedAccount('saved-1')

    expect(result).toBe(true)
    expect(mocks.removeClaudeAccount).not.toHaveBeenCalled()
    expect(mocks.db.deleteSavedUsageAccount).toHaveBeenCalledWith('saved-1')
  })

  it('returns false without touching the store when the cache row does not exist', async () => {
    mocks.db.getSavedUsageAccountById.mockReturnValue(null)

    const result = await removeSavedAccount('missing')

    expect(result).toBe(false)
    expect(mocks.removeClaudeAccount).not.toHaveBeenCalled()
    expect(mocks.removeCodexAccount).not.toHaveBeenCalled()
  })
})

describe('switchAccount', () => {
  it('switches the Claude store account on the happy path', async () => {
    mocks.db.getSavedUsageAccountById.mockReturnValue(savedRow({ id: 'saved-1' }))
    mocks.listClaudeAccounts.mockResolvedValue([claudeAccount()])

    const result = await switchAccount('saved-1')

    expect(result).toEqual({ success: true })
    expect(mocks.switchClaudeAccount).toHaveBeenCalledWith('1', 'claude@example.com')
  })

  it('maps a missing store account to an error result', async () => {
    mocks.db.getSavedUsageAccountById.mockReturnValue(savedRow({ id: 'saved-1' }))
    mocks.listClaudeAccounts.mockResolvedValue([])

    const result = await switchAccount('saved-1')

    expect(result).toEqual({ success: false, error: 'account no longer in store' })
    expect(mocks.switchClaudeAccount).not.toHaveBeenCalled()
  })

  it('maps a thrown switch error to an error result', async () => {
    mocks.db.getSavedUsageAccountById.mockReturnValue(savedRow({ id: 'saved-1' }))
    mocks.listClaudeAccounts.mockResolvedValue([claudeAccount()])
    mocks.switchClaudeAccount.mockRejectedValue(new Error('keychain exploded'))

    const result = await switchAccount('saved-1')

    expect(result).toEqual({ success: false, error: 'keychain exploded' })
  })
})

describe('captureLiveAccountFromFetch', () => {
  it('adds an unknown live Claude account to the store and writes no SQLite credentials', async () => {
    mocks.readClaudeLiveIdentity.mockResolvedValue({ email: 'New@Example.com', uuid: 'uuid-9' })
    mocks.listClaudeAccounts.mockResolvedValue([])
    mocks.readClaudeLiveRawBlob.mockResolvedValue('{"claudeAiOauth":{"accessToken":"a"}}')

    await captureLiveAccountFromFetch('anthropic', usageData())

    expect(mocks.addClaudeAccount).toHaveBeenCalledWith(
      'new@example.com',
      'uuid-9',
      '{"claudeAiOauth":{"accessToken":"a"}}'
    )
    expect(mocks.db.upsertSavedUsageAccount).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'anthropic', email: 'new@example.com', credentials_json: '' })
    )
  })

  it('does not re-add a Claude live account that is already managed', async () => {
    mocks.readClaudeLiveIdentity.mockResolvedValue({ email: 'claude@example.com', uuid: 'uuid-1' })
    mocks.listClaudeAccounts.mockResolvedValue([claudeAccount()])

    await captureLiveAccountFromFetch('anthropic', usageData())

    expect(mocks.addClaudeAccount).not.toHaveBeenCalled()
    expect(mocks.db.upsertSavedUsageAccount).toHaveBeenCalledWith(
      expect.objectContaining({ credentials_json: '' })
    )
  })

  it('adds an unknown live Codex account to the store and writes no SQLite credentials', async () => {
    const idToken = buildCodexIdToken('user-9', 'acct-9', 'codex-new@example.com')
    mocks.readCodexCredentials.mockResolvedValue({
      tokens: {
        id_token: idToken,
        access_token: 'access-9',
        refresh_token: 'refresh-9',
        account_id: 'acct-9'
      }
    })
    mocks.listCodexAccounts.mockResolvedValue([])

    await captureLiveAccountFromFetch('openai', {
      plan_type: 'plus',
      rate_limit: { primary_window: null, secondary_window: null }
    })

    expect(mocks.addCodexAccount).toHaveBeenCalledWith(idToken, 'access-9', 'refresh-9')
    expect(mocks.db.upsertSavedUsageAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openai',
        email: 'codex-new@example.com',
        credentials_json: ''
      })
    )
  })

  it('does not re-add a Codex live account that is already managed', async () => {
    const idToken = buildCodexIdToken('user-1', 'acct-1', 'codex@example.com')
    mocks.readCodexCredentials.mockResolvedValue({
      tokens: {
        id_token: idToken,
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        account_id: 'acct-1'
      }
    })
    mocks.listCodexAccounts.mockResolvedValue([codexAccount()])

    await captureLiveAccountFromFetch('openai', {
      plan_type: 'plus',
      rate_limit: { primary_window: null, secondary_window: null }
    })

    expect(mocks.addCodexAccount).not.toHaveBeenCalled()
  })
})

describe('refreshTokensForStoreAccount', () => {
  it('refreshes a Claude account and persists via updateClaudeTokens', async () => {
    mocks.readClaudeEffectiveBlob.mockResolvedValue({
      raw: '{}',
      parsed: { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 1_000 }
    })
    mocks.refreshAnthropicToken.mockResolvedValue({
      ok: true,
      result: { accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: 2_000 },
      scope: 'a b'
    })

    const outcome = await refreshTokensForStoreAccount('anthropic', { num: '1', email: 'claude@example.com' })

    expect(outcome).toBe('refreshed')
    expect(mocks.updateClaudeTokens).toHaveBeenCalledWith(
      '1',
      'claude@example.com',
      { accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: 2_000 },
      'a b'
    )
  })

  it('reports needsLogin and marks the cache row stale on invalid_grant', async () => {
    mocks.readClaudeEffectiveBlob.mockResolvedValue({
      raw: '{}',
      parsed: { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 1_000 }
    })
    mocks.refreshAnthropicToken.mockResolvedValue({ ok: false, needsLogin: true, error: 'invalid_grant' })
    mocks.db.getSavedUsageAccountByProviderEmail.mockReturnValue(savedRow({ id: 'row-1' }))

    const outcome = await refreshTokensForStoreAccount('anthropic', { num: '1', email: 'claude@example.com' })

    expect(outcome).toBe('needsLogin')
    expect(mocks.updateClaudeTokens).not.toHaveBeenCalled()
    expect(mocks.db.updateSavedUsageAccountUsage).toHaveBeenCalledWith(
      'row-1',
      expect.objectContaining({ status: 'stale' })
    )
  })

  it('reports error (without marking stale) when the refresh call throws', async () => {
    mocks.readClaudeEffectiveBlob.mockResolvedValue({
      raw: '{}',
      parsed: { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 1_000 }
    })
    mocks.refreshAnthropicToken.mockRejectedValue(new Error('network down'))

    const outcome = await refreshTokensForStoreAccount('anthropic', { num: '1', email: 'claude@example.com' })

    expect(outcome).toBe('error')
    expect(mocks.db.updateSavedUsageAccountUsage).not.toHaveBeenCalled()
  })

  it('refreshes a Codex account and persists via updateCodexTokens', async () => {
    mocks.readCodexEffectiveAuth.mockResolvedValue({
      tokens: { access_token: 'old-access', refresh_token: 'old-refresh', account_id: 'acct-1' }
    })
    mocks.refreshOpenAIToken.mockResolvedValue({
      ok: true,
      result: { accessToken: 'new-access', refreshToken: 'new-refresh', idToken: 'new-id' }
    })

    const outcome = await refreshTokensForStoreAccount('openai', { accountKey: 'user-1::acct-1' })

    expect(outcome).toBe('refreshed')
    expect(mocks.updateCodexTokens).toHaveBeenCalledWith('user-1::acct-1', {
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      idToken: 'new-id'
    })
  })

  it('reports needsLogin for a Codex account rejected with invalid_grant', async () => {
    mocks.readCodexEffectiveAuth.mockResolvedValue({
      tokens: { access_token: 'old-access', refresh_token: 'old-refresh', account_id: 'acct-1' }
    })
    mocks.refreshOpenAIToken.mockResolvedValue({ ok: false, needsLogin: true, error: 'invalid_grant' })
    mocks.listCodexAccounts.mockResolvedValue([codexAccount()])
    mocks.db.getSavedUsageAccountByProviderEmail.mockReturnValue(savedRow({ id: 'row-openai-1' }))

    const outcome = await refreshTokensForStoreAccount('openai', { accountKey: 'user-1::acct-1' })

    expect(outcome).toBe('needsLogin')
    expect(mocks.updateCodexTokens).not.toHaveBeenCalled()
    expect(mocks.db.updateSavedUsageAccountUsage).toHaveBeenCalledWith(
      'row-openai-1',
      expect.objectContaining({ status: 'stale' })
    )
  })
})

function base64url(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64url')
}

function buildCodexIdToken(userId: string, accountId: string, email: string, plan = 'plus'): string {
  const header = base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))
  const body = base64url(
    JSON.stringify({
      email,
      'https://api.openai.com/auth': {
        chatgpt_user_id: userId,
        chatgpt_account_id: accountId,
        chatgpt_plan_type: plan
      }
    })
  )
  return `${header}.${body}.fake-signature`
}

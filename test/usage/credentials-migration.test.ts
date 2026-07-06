// @vitest-environment node
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SavedUsageAccount, SavedUsageProvider } from '../../src/main/db/types'

const mocks = vi.hoisted(() => ({
  homeDir: '/tmp/hive-credentials-migration-test',
  keychainStore: new Map<string, string>(),
  keychainRead: vi.fn(async (service: string) => mocks.keychainStore.get(service) ?? null),
  keychainWrite: vi.fn(async (service: string, secret: string) => {
    mocks.keychainStore.set(service, secret)
  }),
  keychainDelete: vi.fn(async (service: string) => {
    mocks.keychainStore.delete(service)
  }),
  logWarn: vi.fn(),
  db: {
    getSetting: vi.fn(),
    setSetting: vi.fn(),
    getSavedUsageAccountsByProvider: vi.fn(),
    clearSavedUsageAccountCredentials: vi.fn()
  }
}))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => mocks.homeDir }
})

vi.mock('../../src/main/services/keychain', () => ({
  keychainRead: mocks.keychainRead,
  keychainWrite: mocks.keychainWrite,
  keychainDelete: mocks.keychainDelete
}))

vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mocks.logWarn, error: vi.fn() })
}))

vi.mock('../../src/main/db', () => ({
  getDatabase: () => mocks.db
}))

import { migrateSavedCredentialsToStores } from '../../src/main/services/credentials-migration'
import {
  addClaudeAccount,
  clearAccountStoreCacheForTests as clearClaudeAccountStoreCacheForTests,
  listClaudeAccounts
} from '../../src/main/services/account-store-claude'
import {
  addCodexAccount,
  clearAccountStoreCacheForTests as clearCodexAccountStoreCacheForTests,
  listCodexAccounts,
  readCodexSnapshot
} from '../../src/main/services/account-store-codex'

const MIGRATION_KEY = 'saved_usage_credentials_migrated'

function base64url(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64url')
}

function buildIdToken(payload: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))
  const body = base64url(JSON.stringify(payload))
  return `${header}.${body}.fake-signature`
}

function codexIdToken(userId: string, accountId: string, email: string, plan = 'plus'): string {
  return buildIdToken({
    email,
    'https://api.openai.com/auth': {
      chatgpt_user_id: userId,
      chatgpt_account_id: accountId,
      chatgpt_plan_type: plan
    }
  })
}

function savedRow(overrides: Partial<SavedUsageAccount> = {}): SavedUsageAccount {
  return {
    id: 'row-1',
    provider: 'anthropic',
    email: 'unused@example.com',
    credentials_json: '',
    last_usage_json: null,
    last_fetched_at: null,
    status: 'ok',
    last_error: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

function savedAnthropicRow(overrides: Partial<SavedUsageAccount> = {}): SavedUsageAccount {
  const email = overrides.email ?? 'claude-user@example.com'
  return savedRow({
    id: 'anthropic-1',
    provider: 'anthropic',
    email,
    credentials_json: JSON.stringify({
      accessToken: 'legacy-access',
      refreshToken: 'legacy-refresh',
      expiresAt: 1_700_000_000_000,
      email
    }),
    ...overrides
  })
}

function savedOpenAIRow(overrides: Partial<SavedUsageAccount> = {}): SavedUsageAccount {
  const idToken = codexIdToken('user-1', 'acct-1', 'codex-user@example.com')
  return savedRow({
    id: 'openai-1',
    provider: 'openai',
    email: 'codex-user@example.com',
    credentials_json: JSON.stringify({
      accessToken: 'legacy-access',
      refreshToken: 'legacy-refresh',
      accountId: 'acct-1',
      idToken,
      email: 'codex-user@example.com'
    }),
    ...overrides
  })
}

function mockRowsByProvider(rows: Partial<Record<SavedUsageProvider, SavedUsageAccount[]>>): void {
  mocks.db.getSavedUsageAccountsByProvider.mockImplementation(
    (provider: SavedUsageProvider) => rows[provider] ?? []
  )
}

describe('migrateSavedCredentialsToStores', () => {
  let codexHome: string
  const originalCodexHome = process.env.CODEX_HOME

  beforeEach(async () => {
    mocks.homeDir = await mkdtemp(join(tmpdir(), 'hive-credentials-migration-'))
    codexHome = await mkdtemp(join(tmpdir(), 'hive-credentials-migration-codex-'))
    process.env.CODEX_HOME = codexHome
    mocks.keychainStore.clear()
    vi.clearAllMocks()
    mocks.db.getSetting.mockReturnValue(null)
    mockRowsByProvider({})
    // These tests use the real account-store-claude/codex modules with a
    // fresh homeDir/codexHome per test, but their listClaudeAccounts()/
    // listCodexAccounts() memo is module-level state that outlives a single
    // test — clear it so each test starts from a real read of its own fixtures.
    clearClaudeAccountStoreCacheForTests()
    clearCodexAccountStoreCacheForTests()
  })

  afterEach(async () => {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = originalCodexHome
    await rm(mocks.homeDir, { recursive: true, force: true })
    await rm(codexHome, { recursive: true, force: true })
  })

  it('migrates both anthropic and openai rows into their account stores, blanks credentials, and records the setting', async () => {
    mockRowsByProvider({ anthropic: [savedAnthropicRow()], openai: [savedOpenAIRow()] })

    await migrateSavedCredentialsToStores()

    const claudeAccounts = await listClaudeAccounts()
    expect(claudeAccounts).toHaveLength(1)
    expect(claudeAccounts[0].email).toBe('claude-user@example.com')
    expect(claudeAccounts[0].expiresAtMs).toBe(1_700_000_000_000)

    const codexAccounts = await listCodexAccounts()
    expect(codexAccounts).toHaveLength(1)
    expect(codexAccounts[0].accountKey).toBe('user-1::acct-1')

    expect(mocks.db.clearSavedUsageAccountCredentials).toHaveBeenCalledTimes(1)
    expect(mocks.db.setSetting).toHaveBeenCalledWith(MIGRATION_KEY, expect.any(String))
  })

  it('skips an anthropic row whose email is already managed (case-insensitive), preserving the existing account', async () => {
    await addClaudeAccount(
      'Claude-User@Example.com',
      'existing-uuid',
      JSON.stringify({
        claudeAiOauth: { accessToken: 'pre-existing-access', refreshToken: 'pre-existing-refresh', expiresAt: 999, scopes: [] }
      })
    )
    mockRowsByProvider({ anthropic: [savedAnthropicRow()] })

    await migrateSavedCredentialsToStores()

    const accounts = await listClaudeAccounts()
    expect(accounts).toHaveLength(1)
    expect(accounts[0].expiresAtMs).toBe(999)
  })

  it('skips an openai row whose account_key is already managed, preserving the existing account', async () => {
    const idToken = codexIdToken('user-1', 'acct-1', 'existing@example.com')
    await addCodexAccount(idToken, 'pre-existing-access', 'pre-existing-refresh')
    mockRowsByProvider({ openai: [savedOpenAIRow()] })

    await migrateSavedCredentialsToStores()

    const accounts = await listCodexAccounts()
    expect(accounts).toHaveLength(1)
    const snapshot = await readCodexSnapshot('user-1::acct-1')
    expect(snapshot?.tokens?.access_token).toBe('pre-existing-access')
  })

  it('skips an openai row without an idToken and logs a warning', async () => {
    mockRowsByProvider({
      openai: [
        savedOpenAIRow({
          credentials_json: JSON.stringify({
            accessToken: 'a',
            refreshToken: 'r',
            accountId: 'acct-1',
            email: 'x@y.z'
          })
        })
      ]
    })

    await migrateSavedCredentialsToStores()

    expect(await listCodexAccounts()).toHaveLength(0)
    expect(mocks.logWarn).toHaveBeenCalledWith(expect.stringMatching(/idToken/i), expect.anything())
  })

  it('continues past a row with unparseable credentials_json instead of aborting the migration', async () => {
    const badRow = savedAnthropicRow({ id: 'bad-1', email: 'bad@example.com', credentials_json: '{ not json' })
    const goodRow = savedAnthropicRow({ id: 'good-1', email: 'good@example.com' })
    mockRowsByProvider({ anthropic: [badRow, goodRow] })

    await expect(migrateSavedCredentialsToStores()).resolves.toBeUndefined()

    const accounts = await listClaudeAccounts()
    expect(accounts.map((a) => a.email)).toEqual(['good@example.com'])
    expect(mocks.db.clearSavedUsageAccountCredentials).toHaveBeenCalledTimes(1)
  })

  it('is idempotent: no-ops immediately once the migration setting is already recorded', async () => {
    expect(mocks.db.getSetting(MIGRATION_KEY)).toBeFalsy()
    mocks.db.getSetting.mockReturnValue('2026-01-01T00:00:00.000Z')

    await migrateSavedCredentialsToStores()

    expect(mocks.db.getSavedUsageAccountsByProvider).not.toHaveBeenCalled()
    expect(mocks.db.clearSavedUsageAccountCredentials).not.toHaveBeenCalled()
    expect(mocks.db.setSetting).not.toHaveBeenCalled()
  })

  it('running twice back-to-back only migrates rows once (the settings key short-circuits the second run)', async () => {
    let migrated: string | null = null
    mocks.db.getSetting.mockImplementation((key: string) => (key === MIGRATION_KEY ? migrated : null))
    mocks.db.setSetting.mockImplementation((key: string, value: string) => {
      if (key === MIGRATION_KEY) migrated = value
    })
    mockRowsByProvider({ anthropic: [savedAnthropicRow()] })

    await migrateSavedCredentialsToStores()
    const callsAfterFirstRun = mocks.db.getSavedUsageAccountsByProvider.mock.calls.length
    expect(callsAfterFirstRun).toBeGreaterThan(0)

    await migrateSavedCredentialsToStores()
    expect(mocks.db.getSavedUsageAccountsByProvider.mock.calls.length).toBe(callsAfterFirstRun)
  })
})

// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listClaudeAccounts: vi.fn(),
  readClaudeEffectiveBlob: vi.fn(),
  listCodexAccounts: vi.fn(),
  readCodexEffectiveAuth: vi.fn(),
  migrateSavedCredentialsToStores: vi.fn(),
  refreshAllForProvider: vi.fn(),
  refreshTokensForStoreAccount: vi.fn(),
  shellOpenExternal: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  shell: { openExternal: mocks.shellOpenExternal }
}))

vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

vi.mock('../../src/main/services/account-store-claude', () => ({
  listClaudeAccounts: mocks.listClaudeAccounts,
  readClaudeEffectiveBlob: mocks.readClaudeEffectiveBlob
}))

vi.mock('../../src/main/services/account-store-codex', () => ({
  listCodexAccounts: mocks.listCodexAccounts,
  readCodexEffectiveAuth: mocks.readCodexEffectiveAuth
}))

vi.mock('../../src/main/services/credentials-migration', () => ({
  migrateSavedCredentialsToStores: mocks.migrateSavedCredentialsToStores
}))

vi.mock('../../src/main/services/saved-usage-orchestrator', () => ({
  refreshAllForProvider: mocks.refreshAllForProvider,
  refreshTokensForStoreAccount: mocks.refreshTokensForStoreAccount
}))

import { startAccountMaintenance } from '../../src/main/services/account-maintenance'
import type { ClaudeStoreAccount } from '../../src/main/services/account-store-claude'
import type { CodexStoreAccount } from '../../src/main/services/account-store-codex'

const TICK_MS = 60_000
const START = Date.parse('2026-01-01T00:00:00.000Z')

function claudeAccount(overrides: Partial<ClaudeStoreAccount> = {}): ClaudeStoreAccount {
  return {
    num: '1',
    email: 'claude@example.com',
    uuid: 'uuid-1',
    expiresAtMs: START + 50_000,
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
    expiresAtMs: START + 50_000,
    hasRefresh: true,
    active: true,
    ...overrides
  }
}

describe('account maintenance', () => {
  let stop: (() => void) | null = null

  beforeEach(() => {
    vi.resetAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(START)
    mocks.migrateSavedCredentialsToStores.mockResolvedValue(undefined)
    mocks.refreshAllForProvider.mockResolvedValue([])
    mocks.listClaudeAccounts.mockResolvedValue([])
    mocks.listCodexAccounts.mockResolvedValue([])
  })

  afterEach(() => {
    stop?.()
    stop = null
    vi.useRealTimers()
  })

  it('runs the migration and a one-shot launch mass refresh for both providers, without blocking the caller', async () => {
    stop = startAccountMaintenance()
    // startAccountMaintenance() itself returns synchronously (fire-and-forget).
    await vi.advanceTimersByTimeAsync(0)

    expect(mocks.migrateSavedCredentialsToStores).toHaveBeenCalledTimes(1)
    expect(mocks.refreshAllForProvider).toHaveBeenCalledWith('anthropic')
    expect(mocks.refreshAllForProvider).toHaveBeenCalledWith('openai')
  })

  it('refreshes a Claude account expiring within 2 minutes and skips one expiring later', async () => {
    mocks.listClaudeAccounts.mockResolvedValue([
      claudeAccount({ num: '1', email: 'soon@example.com', expiresAtMs: START + 50_000 }),
      claudeAccount({ num: '2', email: 'later@example.com', expiresAtMs: START + 10 * 60_000 })
    ])
    mocks.readClaudeEffectiveBlob.mockResolvedValue({ parsed: { refreshToken: 'token-a' } })
    mocks.refreshTokensForStoreAccount.mockResolvedValue('refreshed')

    stop = startAccountMaintenance()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(TICK_MS)

    expect(mocks.refreshTokensForStoreAccount).toHaveBeenCalledTimes(1)
    expect(mocks.refreshTokensForStoreAccount).toHaveBeenCalledWith('anthropic', {
      num: '1',
      email: 'soon@example.com'
    })
  })

  it('does not refresh an account without a refresh token even if it is expiring soon', async () => {
    mocks.listClaudeAccounts.mockResolvedValue([
      claudeAccount({ hasRefresh: false, expiresAtMs: START + 1_000 })
    ])

    stop = startAccountMaintenance()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(TICK_MS)

    expect(mocks.refreshTokensForStoreAccount).not.toHaveBeenCalled()
  })

  it('refreshes an expiring Codex account', async () => {
    mocks.listCodexAccounts.mockResolvedValue([codexAccount()])
    mocks.readCodexEffectiveAuth.mockResolvedValue({ tokens: { refresh_token: 'codex-token-a' } })
    mocks.refreshTokensForStoreAccount.mockResolvedValue('refreshed')

    stop = startAccountMaintenance()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(TICK_MS)

    expect(mocks.refreshTokensForStoreAccount).toHaveBeenCalledWith('openai', {
      accountKey: 'user-1::acct-1'
    })
  })

  it('does not retry a needsLogin account until its refresh token changes', async () => {
    mocks.listClaudeAccounts.mockResolvedValue([claudeAccount()])
    mocks.readClaudeEffectiveBlob.mockResolvedValue({ parsed: { refreshToken: 'token-a' } })
    mocks.refreshTokensForStoreAccount.mockResolvedValue('needsLogin')

    stop = startAccountMaintenance()
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(TICK_MS)
    expect(mocks.refreshTokensForStoreAccount).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(TICK_MS)
    expect(mocks.refreshTokensForStoreAccount).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(TICK_MS)
    expect(mocks.refreshTokensForStoreAccount).toHaveBeenCalledTimes(1)

    mocks.readClaudeEffectiveBlob.mockResolvedValue({ parsed: { refreshToken: 'token-b' } })
    await vi.advanceTimersByTimeAsync(TICK_MS)
    expect(mocks.refreshTokensForStoreAccount).toHaveBeenCalledTimes(2)
  })

  it('backs off exponentially on repeated errors, doubling the wait each time', async () => {
    mocks.listClaudeAccounts.mockResolvedValue([claudeAccount()])
    mocks.readClaudeEffectiveBlob.mockResolvedValue({ parsed: { refreshToken: 'token-a' } })
    mocks.refreshTokensForStoreAccount.mockResolvedValue('error')

    stop = startAccountMaintenance()
    await vi.advanceTimersByTimeAsync(0)

    // t=60s: first attempt fails -> 5 minute backoff (next attempt at t=360s)
    await vi.advanceTimersByTimeAsync(TICK_MS)
    expect(mocks.refreshTokensForStoreAccount).toHaveBeenCalledTimes(1)

    // t=300s: still within the 5 minute backoff window
    await vi.advanceTimersByTimeAsync(TICK_MS * 4)
    expect(mocks.refreshTokensForStoreAccount).toHaveBeenCalledTimes(1)

    // t=360s: backoff elapsed -> retried, fails again -> 10 minute backoff (next at t=960s)
    await vi.advanceTimersByTimeAsync(TICK_MS)
    expect(mocks.refreshTokensForStoreAccount).toHaveBeenCalledTimes(2)

    // t=900s: still within the 10 minute backoff window
    await vi.advanceTimersByTimeAsync(TICK_MS * 9)
    expect(mocks.refreshTokensForStoreAccount).toHaveBeenCalledTimes(2)

    // t=960s: backoff elapsed -> retried, fails again -> 20 minute backoff
    await vi.advanceTimersByTimeAsync(TICK_MS)
    expect(mocks.refreshTokensForStoreAccount).toHaveBeenCalledTimes(3)
  })

  it('caps the error backoff at 30 minutes', async () => {
    mocks.listClaudeAccounts.mockResolvedValue([claudeAccount()])
    mocks.readClaudeEffectiveBlob.mockResolvedValue({ parsed: { refreshToken: 'token-a' } })
    mocks.refreshTokensForStoreAccount.mockResolvedValue('error')

    stop = startAccountMaintenance()
    await vi.advanceTimersByTimeAsync(0)

    // Drive backoff through 5 -> 10 -> 20 -> 30 (capped) minutes:
    // attempts land at t=60s, 360s, 960s, 2160s, 3960s (each +30min thereafter).
    await vi.advanceTimersByTimeAsync(TICK_MS) // t=60s: attempt #1 (backoff -> 5m)
    await vi.advanceTimersByTimeAsync(TICK_MS * 5) // t=360s: attempt #2 (backoff -> 10m)
    await vi.advanceTimersByTimeAsync(TICK_MS * 10) // t=960s: attempt #3 (backoff -> 20m)
    await vi.advanceTimersByTimeAsync(TICK_MS * 20) // t=2160s: attempt #4 (backoff -> 30m, capped)
    expect(mocks.refreshTokensForStoreAccount).toHaveBeenCalledTimes(4)

    // Only 25 minutes later: still within the capped 30 minute window.
    await vi.advanceTimersByTimeAsync(TICK_MS * 25)
    expect(mocks.refreshTokensForStoreAccount).toHaveBeenCalledTimes(4)

    // 30 minutes after attempt #4 (t=2160+1800=3960s): retried again.
    await vi.advanceTimersByTimeAsync(TICK_MS * 5)
    expect(mocks.refreshTokensForStoreAccount).toHaveBeenCalledTimes(5)
  })

  it('clears the backoff after a successful refresh so the next expiring tick retries immediately', async () => {
    mocks.listClaudeAccounts.mockResolvedValue([claudeAccount()])
    mocks.readClaudeEffectiveBlob.mockResolvedValue({ parsed: { refreshToken: 'token-a' } })
    mocks.refreshTokensForStoreAccount.mockResolvedValueOnce('error').mockResolvedValue('refreshed')

    stop = startAccountMaintenance()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(TICK_MS) // fails, 5 minute backoff
    expect(mocks.refreshTokensForStoreAccount).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(TICK_MS * 5) // t=360s: retried, succeeds
    expect(mocks.refreshTokensForStoreAccount).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(TICK_MS) // no backoff left -> retries again next tick
    expect(mocks.refreshTokensForStoreAccount).toHaveBeenCalledTimes(3)
  })

  it('never touches any login/browser API', async () => {
    mocks.listClaudeAccounts.mockResolvedValue([claudeAccount()])
    mocks.listCodexAccounts.mockResolvedValue([codexAccount()])
    mocks.readClaudeEffectiveBlob.mockResolvedValue({ parsed: { refreshToken: 'token-a' } })
    mocks.readCodexEffectiveAuth.mockResolvedValue({ tokens: { refresh_token: 'codex-token-a' } })
    mocks.refreshTokensForStoreAccount.mockResolvedValue('needsLogin')

    stop = startAccountMaintenance()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(TICK_MS * 3)

    expect(mocks.shellOpenExternal).not.toHaveBeenCalled()
  })

  it('stops the expiry watcher once the returned cleanup function is called', async () => {
    mocks.listClaudeAccounts.mockResolvedValue([claudeAccount()])
    mocks.readClaudeEffectiveBlob.mockResolvedValue({ parsed: { refreshToken: 'token-a' } })
    mocks.refreshTokensForStoreAccount.mockResolvedValue('refreshed')

    stop = startAccountMaintenance()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(TICK_MS)
    expect(mocks.refreshTokensForStoreAccount).toHaveBeenCalledTimes(1)

    stop()
    await vi.advanceTimersByTimeAsync(TICK_MS * 5)
    expect(mocks.refreshTokensForStoreAccount).toHaveBeenCalledTimes(1)
  })
})

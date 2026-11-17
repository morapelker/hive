// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// When account maintenance asks the organization learner for a sweep: after the launch poll,
// once a minute, and on request. The learner itself is replaced by a counter.

const mocks = vi.hoisted(() => ({
  listClaudeAccounts: vi.fn(),
  readClaudeEffectiveBlob: vi.fn(),
  listCodexAccounts: vi.fn(),
  readCodexEffectiveAuth: vi.fn(),
  migrateSavedCredentialsToStores: vi.fn(),
  refreshAllForProvider: vi.fn(),
  refreshTokensForStoreAccount: vi.fn(),
  fetchForSavedAccount: vi.fn(),
  sweep: vi.fn()
}))

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

vi.mock('../../src/main/db', () => ({
  getDatabase: () => ({ getSavedUsageAccountsByProvider: () => [] })
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
  refreshTokensForStoreAccount: mocks.refreshTokensForStoreAccount,
  fetchForSavedAccount: mocks.fetchForSavedAccount
}))

vi.mock('../../src/main/services/claude-organization-learner', () => ({
  getClaudeOrganizationLearner: () => ({ sweep: mocks.sweep })
}))

import {
  requestClaudeOrganizationLearning,
  startAccountMaintenance
} from '../../src/main/services/account-maintenance'

const TICK_MS = 60_000
const START = Date.parse('2026-01-01T00:00:00.000Z')

describe('account maintenance and the organization learner', () => {
  let stop: (() => void) | null = null
  /** Ends the launch poll of Claude accounts. */
  let finishLaunchRefresh: () => void = () => undefined

  beforeEach(() => {
    vi.resetAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(START)
    mocks.migrateSavedCredentialsToStores.mockResolvedValue(undefined)
    mocks.listClaudeAccounts.mockResolvedValue([])
    mocks.listCodexAccounts.mockResolvedValue([])
    mocks.sweep.mockResolvedValue(undefined)
    mocks.refreshAllForProvider.mockImplementation((provider: string) =>
      provider === 'anthropic'
        ? new Promise<[]>((resolve) => {
            finishLaunchRefresh = () => resolve([])
          })
        : Promise.resolve([])
    )
  })

  afterEach(() => {
    stop?.()
    stop = null
    vi.useRealTimers()
  })

  /** Start maintenance and let it reach the launch poll, which stays open until it is finished. */
  async function startWithLaunchPollRunning(): Promise<void> {
    finishLaunchRefresh = () => {
      throw new Error('the launch poll has not started')
    }
    stop = startAccountMaintenance()
    await vi.advanceTimersByTimeAsync(0)
  }

  async function startWithLaunchPollOver(): Promise<void> {
    await startWithLaunchPollRunning()
    finishLaunchRefresh()
    await vi.advanceTimersByTimeAsync(0)
  }

  it('asks nothing while the launch poll is running, then sweeps as soon as it is over', async () => {
    await startWithLaunchPollRunning()

    // The launch poll is under way (it teaches organizations itself): ticks and requests wait.
    await vi.advanceTimersByTimeAsync(TICK_MS)
    requestClaudeOrganizationLearning()
    await vi.advanceTimersByTimeAsync(TICK_MS)
    expect(mocks.sweep).not.toHaveBeenCalled()

    finishLaunchRefresh()
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.sweep).toHaveBeenCalledTimes(1)
    // Both providers were polled exactly as before.
    expect(mocks.refreshAllForProvider.mock.calls).toEqual([['anthropic'], ['openai']])
  })

  it('sweeps again on every tick and on request', async () => {
    await startWithLaunchPollOver()
    expect(mocks.sweep).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(TICK_MS)
    expect(mocks.sweep).toHaveBeenCalledTimes(2)

    requestClaudeOrganizationLearning()
    requestClaudeOrganizationLearning()
    expect(mocks.sweep).toHaveBeenCalledTimes(4)

    await vi.advanceTimersByTimeAsync(TICK_MS)
    expect(mocks.sweep).toHaveBeenCalledTimes(5)
  })

  it('sweeps after a launch poll that failed', async () => {
    mocks.refreshAllForProvider.mockRejectedValue(new Error('offline'))
    stop = startAccountMaintenance()

    await vi.advanceTimersByTimeAsync(0)

    expect(mocks.sweep).toHaveBeenCalledTimes(1)
  })

  it('does not wait for a sweep: a learner that never answers holds up neither ticks nor token refreshes', async () => {
    mocks.sweep.mockReturnValue(new Promise<void>(() => undefined))
    mocks.listClaudeAccounts.mockResolvedValue([
      {
        num: '1',
        email: 'claude@example.com',
        uuid: 'uuid-1',
        expiresAtMs: START + 50_000,
        sessionExpiresAtMs: null,
        hasRefresh: true,
        plan: 'pro',
        active: true
      }
    ])
    mocks.readClaudeEffectiveBlob.mockResolvedValue({
      raw: '{}',
      parsed: { accessToken: 'access', refreshToken: 'refresh', expiresAt: START + 50_000 }
    })
    mocks.refreshTokensForStoreAccount.mockResolvedValue('refreshed')

    await startWithLaunchPollOver()
    expect(mocks.sweep).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(TICK_MS)
    await vi.advanceTimersByTimeAsync(TICK_MS)

    // The expiring token was refreshed on both ticks, with the sweep still pending.
    expect(mocks.refreshTokensForStoreAccount).toHaveBeenCalledTimes(2)
    expect(mocks.refreshTokensForStoreAccount).toHaveBeenCalledWith('anthropic', {
      num: '1',
      email: 'claude@example.com'
    })
  })

  it('starts no sweep when maintenance stopped while the launch poll was still running', async () => {
    await startWithLaunchPollRunning()

    stop?.()
    stop = null
    finishLaunchRefresh()
    await vi.advanceTimersByTimeAsync(TICK_MS)

    expect(mocks.sweep).not.toHaveBeenCalled()
  })

  it('does nothing on request before maintenance starts and after it stops', async () => {
    requestClaudeOrganizationLearning()
    expect(mocks.sweep).not.toHaveBeenCalled()

    await startWithLaunchPollOver()
    expect(mocks.sweep).toHaveBeenCalledTimes(1)

    stop?.()
    stop = null
    requestClaudeOrganizationLearning()
    await vi.advanceTimersByTimeAsync(5 * TICK_MS)
    expect(mocks.sweep).toHaveBeenCalledTimes(1)
  })
})

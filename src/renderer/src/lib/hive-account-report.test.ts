import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  isHiveTelemetryEnabled: vi.fn(() => true),
  reportHiveActiveAccounts: vi.fn(async () => true),
  fetchEmail: vi.fn(async () => {})
}))

vi.mock('@/api/hive-enterprise/client', () => ({
  isHiveTelemetryEnabled: mocks.isHiveTelemetryEnabled,
  reportHiveActiveAccounts: mocks.reportHiveActiveAccounts
}))

vi.mock('@/stores/useSettingsStore', () => ({
  useSettingsStore: {
    getState: () => ({ hiveAuthToken: 'token-1', hiveOrganizationId: 'org-1' })
  }
}))

// The mock's `fetchEmail` mutates this object directly, mirroring how the
// real zustand store's `set` updates state in place — the module under test
// reads `anthropicEmail`/`openaiEmail` off a fresh `getState()` call after
// each await, so mutating here is what makes "email changed mid-flight"
// observable to it.
const accountState = {
  anthropicEmail: null as string | null,
  openaiEmail: null as string | null
}

vi.mock('@/stores/useAccountStore', () => ({
  useAccountStore: {
    getState: () => ({
      get anthropicEmail() {
        return accountState.anthropicEmail
      },
      get openaiEmail() {
        return accountState.openaiEmail
      },
      fetchEmail: mocks.fetchEmail
    })
  }
}))

import {
  reportActiveAccountsSnapshot,
  resetHiveAccountReportStateForTests
} from './hive-account-report'

describe('hive-account-report', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-08T10:00:00.000Z'))
    vi.clearAllMocks()
    mocks.isHiveTelemetryEnabled.mockReturnValue(true)
    mocks.reportHiveActiveAccounts.mockResolvedValue(true)
    mocks.fetchEmail.mockResolvedValue(undefined)
    accountState.anthropicEmail = null
    accountState.openaiEmail = null
    resetHiveAccountReportStateForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends the full snapshot when both providers have an active account', async () => {
    accountState.anthropicEmail = 'alice@example.com'
    accountState.openaiEmail = 'Bob@example.com'

    await reportActiveAccountsSnapshot()

    expect(mocks.reportHiveActiveAccounts).toHaveBeenCalledTimes(1)
    expect(mocks.reportHiveActiveAccounts).toHaveBeenCalledWith([
      { provider: 'anthropic', email: 'alice@example.com' },
      { provider: 'openai', email: 'bob@example.com' }
    ])
  })

  it('omits a provider whose email is null', async () => {
    accountState.anthropicEmail = 'alice@example.com'
    accountState.openaiEmail = null

    await reportActiveAccountsSnapshot()

    expect(mocks.reportHiveActiveAccounts).toHaveBeenCalledWith([
      { provider: 'anthropic', email: 'alice@example.com' }
    ])
  })

  it('sends nothing when the snapshot is empty', async () => {
    await reportActiveAccountsSnapshot()

    expect(mocks.reportHiveActiveAccounts).not.toHaveBeenCalled()
  })

  it('skips a repeat send of an identical snapshot within the 1h heartbeat window', async () => {
    accountState.anthropicEmail = 'alice@example.com'

    await reportActiveAccountsSnapshot()
    expect(mocks.reportHiveActiveAccounts).toHaveBeenCalledTimes(1)

    vi.setSystemTime(new Date('2026-07-08T10:30:00.000Z')) // +30min, still < 1h
    await reportActiveAccountsSnapshot()

    expect(mocks.reportHiveActiveAccounts).toHaveBeenCalledTimes(1)
  })

  it('re-sends an identical snapshot as a heartbeat once an hour has elapsed', async () => {
    accountState.anthropicEmail = 'alice@example.com'

    await reportActiveAccountsSnapshot()
    expect(mocks.reportHiveActiveAccounts).toHaveBeenCalledTimes(1)

    vi.setSystemTime(new Date('2026-07-08T11:00:01.000Z')) // +1h and 1s
    await reportActiveAccountsSnapshot()

    expect(mocks.reportHiveActiveAccounts).toHaveBeenCalledTimes(2)
  })

  it('sends immediately when the active account email changes', async () => {
    accountState.anthropicEmail = 'alice@example.com'
    await reportActiveAccountsSnapshot()
    expect(mocks.reportHiveActiveAccounts).toHaveBeenCalledTimes(1)

    accountState.anthropicEmail = 'carol@example.com'
    await reportActiveAccountsSnapshot()

    expect(mocks.reportHiveActiveAccounts).toHaveBeenCalledTimes(2)
    expect(mocks.reportHiveActiveAccounts).toHaveBeenLastCalledWith([
      { provider: 'anthropic', email: 'carol@example.com' }
    ])
  })

  it('retries on the next trigger after a failed send instead of caching it as sent', async () => {
    accountState.anthropicEmail = 'alice@example.com'
    mocks.reportHiveActiveAccounts.mockResolvedValueOnce(false)

    await reportActiveAccountsSnapshot()
    expect(mocks.reportHiveActiveAccounts).toHaveBeenCalledTimes(1)

    // Same snapshot, no time elapsed — a successful send would have been
    // deduped, but the prior attempt failed so last-sent state was never set.
    await reportActiveAccountsSnapshot()

    expect(mocks.reportHiveActiveAccounts).toHaveBeenCalledTimes(2)
  })

  it('does not call the server or read accounts when telemetry is disabled', async () => {
    mocks.isHiveTelemetryEnabled.mockReturnValue(false)
    accountState.anthropicEmail = 'alice@example.com'

    await reportActiveAccountsSnapshot()

    expect(mocks.reportHiveActiveAccounts).not.toHaveBeenCalled()
    expect(mocks.fetchEmail).not.toHaveBeenCalled()
  })
})

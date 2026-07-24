import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import {
  useAccountScheduleStore,
  resetExecutingProvidersForTests
} from '../useAccountScheduleStore'
import { useUsageStore } from '../useUsageStore'
import { useAccountStore } from '../useAccountStore'
import { toast } from '@/lib/toast'
import type { RefreshAllResultItem, SavedAccountDTO, UsageData } from '@shared/types/usage'

vi.mock('@/lib/toast', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn()
  }
}))

function makeUsage(fiveHour: number, sevenDay: number): UsageData {
  const futureReset = new Date(Date.now() + 3_600_000).toISOString()
  return {
    five_hour: { utilization: fiveHour, resets_at: futureReset },
    seven_day: { utilization: sevenDay, resets_at: futureReset }
  }
}

function makeAccount(
  id: string,
  email: string,
  usage: UsageData | null,
  status: SavedAccountDTO['status'] = 'ok'
): SavedAccountDTO {
  return {
    id,
    provider: 'anthropic',
    email,
    last_usage: usage,
    last_fetched_at: usage ? new Date().toISOString() : null,
    status,
    last_error: null,
    created_at: new Date().toISOString(),
    plan: null
  }
}

describe('useAccountScheduleStore auto-switch', () => {
  let request: ReturnType<typeof vi.fn>
  let refreshedAccounts: SavedAccountDTO[]
  let refreshResults: RefreshAllResultItem[]

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-16T10:00:00.000Z'))
    vi.clearAllMocks()

    useAccountScheduleStore.setState({ schedules: {}, autoSwitch: {} })
    resetExecutingProvidersForTests()
    useAccountStore.setState({ anthropicEmail: 'current@x.com', openaiEmail: null })

    // Post-refresh world: the active account is nearly exhausted; acc-2 has
    // the most headroom, acc-3 less; acc-4's refresh fails; acc-5 is expired.
    refreshedAccounts = [
      makeAccount('acc-1', 'current@x.com', makeUsage(0, 0)),
      makeAccount('acc-2', 'best@x.com', makeUsage(10, 20)),
      makeAccount('acc-3', 'meh@x.com', makeUsage(60, 50)),
      makeAccount('acc-4', 'failed@x.com', makeUsage(0, 0)),
      makeAccount('acc-5', 'expired@x.com', makeUsage(0, 0), 'stale')
    ]
    refreshResults = [
      { accountId: 'acc-1', success: true },
      { accountId: 'acc-2', success: true },
      { accountId: 'acc-3', success: true },
      { accountId: 'acc-4', success: false, error: 'network down' },
      { accountId: 'acc-5', success: true }
    ]

    useUsageStore.setState({
      anthropicUsage: makeUsage(92, 40),
      anthropicLastFetchedAt: Date.now(),
      anthropicIsLoading: false,
      anthropicLastError: null,
      anthropicLastRetryAfter: null,
      openaiUsage: null,
      openaiIsLoading: false,
      savedAccounts: { anthropic: refreshedAccounts, openai: [] },
      savedAccountsLoaded: { anthropic: true, openai: false },
      refreshingProviders: { anthropic: false, openai: false },
      refreshingAccountIds: new Set<string>(),
      switchingAccountIds: new Set<string>()
    })

    request = vi.fn(async (method: string) => {
      if (method === 'usageOps.refreshAllForProvider') return refreshResults
      if (method === 'accountOps.listSaved') return refreshedAccounts
      if (method === 'accountOps.switchAccount') return { success: true }
      if (method === 'accountOps.getClaudeEmail') return 'best@x.com'
      if (method === 'usageOps.fetch') return { success: true, data: undefined }
      return null
    })
    setRendererRpcClient({ request, subscribe: vi.fn() })
  })

  afterEach(() => {
    resetRendererRpcClientForTests()
    vi.useRealTimers()
  })

  const calls = (method: string): unknown[][] =>
    request.mock.calls.filter(([m]) => m === method)
  const switchCalls = (): unknown[][] => calls('accountOps.switchAccount')
  const refreshAllCalls = (): unknown[][] => calls('usageOps.refreshAllForProvider')

  it('enabling auto-switch replaces a pending schedule, and scheduling replaces auto-switch', () => {
    const store = useAccountScheduleStore.getState()
    store.scheduleByUsage('anthropic', 'acc-2', 'best@x.com', 95)
    store.setAutoSwitch('anthropic', 90)

    let state = useAccountScheduleStore.getState()
    expect(state.schedules.anthropic).toBeUndefined()
    expect(state.autoSwitch.anthropic?.thresholdPercent).toBe(90)

    state.scheduleByTime('anthropic', 'acc-2', 'best@x.com', 60_000)
    state = useAccountScheduleStore.getState()
    expect(state.autoSwitch.anthropic).toBeUndefined()
    expect(state.schedules.anthropic).toBeDefined()

    state.setAutoSwitch('anthropic', 95)
    state.scheduleByUsage('anthropic', 'acc-2', 'best@x.com', 90)
    state = useAccountScheduleStore.getState()
    expect(state.autoSwitch.anthropic).toBeUndefined()
    expect(state.schedules.anthropic).toBeDefined()
  })

  it('clamps the threshold and supports disabling', () => {
    const store = useAccountScheduleStore.getState()
    store.setAutoSwitch('anthropic', 300)
    expect(useAccountScheduleStore.getState().autoSwitch.anthropic?.thresholdPercent).toBe(100)
    store.setAutoSwitch('anthropic', -5)
    expect(useAccountScheduleStore.getState().autoSwitch.anthropic?.thresholdPercent).toBe(1)

    store.disableAutoSwitch('anthropic')
    expect(useAccountScheduleStore.getState().autoSwitch.anthropic).toBeUndefined()
  })

  it('does nothing while the active account is below the threshold', async () => {
    useUsageStore.setState({ anthropicUsage: makeUsage(60, 40) })
    useAccountScheduleStore.getState().setAutoSwitch('anthropic', 90)

    await useAccountScheduleStore.getState().checkSchedules()

    expect(refreshAllCalls()).toHaveLength(0)
    expect(switchCalls()).toHaveLength(0)
  })

  it('refreshes all accounts and switches to the best-scoring eligible one at the threshold', async () => {
    useAccountScheduleStore.getState().setAutoSwitch('anthropic', 90)

    await useAccountScheduleStore.getState().checkSchedules()

    // acc-1 is the active account (best usage but excluded), acc-4's refresh
    // failed, acc-5 is expired — acc-2 wins over acc-3 on headroom.
    expect(refreshAllCalls()).toHaveLength(1)
    expect(switchCalls()).toHaveLength(1)
    expect(switchCalls()[0][1]).toEqual({ accountId: 'acc-2' })
    // Stays armed for the next threshold crossing.
    expect(useAccountScheduleStore.getState().autoSwitch.anthropic).toBeDefined()
  })

  it('ignores an account whose refresh failed even when its cached usage looks best', async () => {
    // acc-4 (refresh failed) has pristine cached usage; the pick must fall to
    // the best account that actually answered.
    useAccountScheduleStore.getState().setAutoSwitch('anthropic', 90)

    await useAccountScheduleStore.getState().checkSchedules()

    expect(switchCalls()[0][1]).toEqual({ accountId: 'acc-2' })
  })

  it('backs off with a toast when no account is below the threshold', async () => {
    refreshedAccounts = [
      makeAccount('acc-1', 'current@x.com', makeUsage(0, 0)),
      makeAccount('acc-2', 'best@x.com', makeUsage(95, 20)),
      makeAccount('acc-3', 'meh@x.com', makeUsage(20, 91))
    ]
    refreshResults = [
      { accountId: 'acc-1', success: true },
      { accountId: 'acc-2', success: true },
      { accountId: 'acc-3', success: true }
    ]
    useAccountScheduleStore.getState().setAutoSwitch('anthropic', 90)

    await useAccountScheduleStore.getState().checkSchedules()

    expect(switchCalls()).toHaveLength(0)
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Auto-switch'))
    expect(useAccountScheduleStore.getState().autoSwitch.anthropic?.notBefore).toBe(
      Date.now() + 5 * 60_000
    )

    // Backing off — no second refresh sweep on the next tick.
    await useAccountScheduleStore.getState().checkSchedules()
    expect(refreshAllCalls()).toHaveLength(1)

    // After the delay it tries again.
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1_000)
    await useAccountScheduleStore.getState().checkSchedules()
    expect(refreshAllCalls()).toHaveLength(2)
  })

  it('keeps auto-switch enabled and backs off when the switch attempt fails', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'usageOps.refreshAllForProvider') return refreshResults
      if (method === 'accountOps.listSaved') return refreshedAccounts
      if (method === 'accountOps.switchAccount') return { success: false, error: 'boom' }
      return null
    })
    useAccountScheduleStore.getState().setAutoSwitch('anthropic', 90)

    await useAccountScheduleStore.getState().checkSchedules()

    expect(switchCalls()).toHaveLength(1)
    const auto = useAccountScheduleStore.getState().autoSwitch.anthropic
    expect(auto).toBeDefined()
    expect(auto?.notBefore).toBe(Date.now() + 5 * 60_000)

    await useAccountScheduleStore.getState().checkSchedules()
    expect(switchCalls()).toHaveLength(1)
  })

  it('does not switch when auto-switch is disabled during the refresh sweep', async () => {
    const pendingRefresh: { resolve?: (value: RefreshAllResultItem[]) => void } = {}
    request.mockImplementation(async (method: string) => {
      if (method === 'usageOps.refreshAllForProvider')
        return new Promise((resolve) => {
          pendingRefresh.resolve = resolve
        })
      if (method === 'accountOps.listSaved') return refreshedAccounts
      if (method === 'accountOps.switchAccount') return { success: true }
      return null
    })
    useAccountScheduleStore.getState().setAutoSwitch('anthropic', 90)

    const checking = useAccountScheduleStore.getState().checkSchedules()
    while (!pendingRefresh.resolve) await Promise.resolve()

    useAccountScheduleStore.getState().disableAutoSwitch('anthropic')
    pendingRefresh.resolve(refreshResults)
    await checking

    expect(switchCalls()).toHaveLength(0)
    expect(useAccountScheduleStore.getState().autoSwitch.anthropic).toBeUndefined()
  })

  it('cools down after a successful switch so a lagging active-usage refresh cannot cause churn', async () => {
    useAccountScheduleStore.getState().setAutoSwitch('anthropic', 90)

    await useAccountScheduleStore.getState().checkSchedules()
    expect(switchCalls()).toHaveLength(1)
    expect(useAccountScheduleStore.getState().autoSwitch.anthropic?.notBefore).toBe(
      Date.now() + 5 * 60_000
    )

    // The active usage still reads the OLD account's 92% (its refresh failed
    // or is slow) — the cooldown must prevent an immediate second hop.
    await useAccountScheduleStore.getState().checkSchedules()
    expect(switchCalls()).toHaveLength(1)
  })

  it('seeds the active usage from the switched-to account so a dead refresh cannot re-trigger', async () => {
    // The post-switch active-usage refresh stays broken (rate limited) — the
    // slot must carry the NEW account's numbers, not the exhausted 92%, or
    // every cooldown expiry would hop away from a perfectly healthy account.
    request.mockImplementation(async (method: string) => {
      if (method === 'usageOps.refreshAllForProvider') return refreshResults
      if (method === 'accountOps.listSaved') return refreshedAccounts
      if (method === 'accountOps.switchAccount') return { success: true }
      if (method === 'accountOps.getClaudeEmail') return 'best@x.com'
      if (method === 'usageOps.fetch') return { success: false, error: 'rate limited' }
      return null
    })
    useAccountScheduleStore.getState().setAutoSwitch('anthropic', 90)

    await useAccountScheduleStore.getState().checkSchedules()
    expect(switchCalls()).toHaveLength(1)
    expect(useUsageStore.getState().anthropicUsage).toEqual(
      refreshedAccounts.find((a) => a.id === 'acc-2')?.last_usage
    )

    // Past the cooldown with the refresh still dead: no churn.
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1_000)
    await useAccountScheduleStore.getState().checkSchedules()
    expect(switchCalls()).toHaveLength(1)
  })

  it('does not sweep or switch while the active account cannot be identified', async () => {
    useAccountStore.setState({ anthropicEmail: null, openaiEmail: null })
    request.mockImplementation(async (method: string) => {
      if (method === 'usageOps.refreshAllForProvider') return refreshResults
      if (method === 'accountOps.listSaved') return refreshedAccounts
      if (method === 'accountOps.switchAccount') return { success: true }
      if (method === 'accountOps.getClaudeEmail') return null
      return null
    })
    useAccountScheduleStore.getState().setAutoSwitch('anthropic', 90)

    await useAccountScheduleStore.getState().checkSchedules()

    // It tried to resolve the email, then gave up without touching accounts.
    expect(calls('accountOps.getClaudeEmail').length).toBeGreaterThan(0)
    expect(refreshAllCalls()).toHaveLength(0)
    expect(switchCalls()).toHaveLength(0)
    expect(useAccountScheduleStore.getState().autoSwitch.anthropic?.notBefore).toBe(
      Date.now() + 5 * 60_000
    )
  })

  it('recovers by fetching the email when the account store has none yet', async () => {
    useAccountStore.setState({ anthropicEmail: null, openaiEmail: null })
    request.mockImplementation(async (method: string) => {
      if (method === 'usageOps.refreshAllForProvider') return refreshResults
      if (method === 'accountOps.listSaved') return refreshedAccounts
      if (method === 'accountOps.switchAccount') return { success: true }
      if (method === 'accountOps.getClaudeEmail') return 'current@x.com'
      if (method === 'usageOps.fetch') return { success: true, data: undefined }
      return null
    })
    useAccountScheduleStore.getState().setAutoSwitch('anthropic', 90)

    await useAccountScheduleStore.getState().checkSchedules()

    expect(switchCalls()).toHaveLength(1)
    expect(switchCalls()[0][1]).toEqual({ accountId: 'acc-2' })
  })

  it('never picks an account whose refreshed windows are all already expired', async () => {
    const pastReset = new Date(Date.now() - 3_600_000).toISOString()
    // acc-2 would win on score (expired windows read as full headroom), but
    // its live usage is unknown — the pick must fall to acc-3.
    refreshedAccounts = [
      makeAccount('acc-1', 'current@x.com', makeUsage(0, 0)),
      {
        ...makeAccount('acc-2', 'best@x.com', null),
        last_usage: {
          five_hour: { utilization: 10, resets_at: pastReset },
          seven_day: { utilization: 10, resets_at: pastReset }
        }
      },
      makeAccount('acc-3', 'meh@x.com', makeUsage(60, 50))
    ]
    refreshResults = [
      { accountId: 'acc-1', success: true },
      { accountId: 'acc-2', success: true },
      { accountId: 'acc-3', success: true }
    ]
    useAccountScheduleStore.getState().setAutoSwitch('anthropic', 90)

    await useAccountScheduleStore.getState().checkSchedules()

    expect(switchCalls()).toHaveLength(1)
    expect(switchCalls()[0][1]).toEqual({ accountId: 'acc-3' })
  })

  it('skips the round without backing off when a refresh sweep is already running', async () => {
    useUsageStore.setState({ refreshingProviders: { anthropic: true, openai: false } })
    useAccountScheduleStore.getState().setAutoSwitch('anthropic', 90)

    await useAccountScheduleStore.getState().checkSchedules()

    expect(refreshAllCalls()).toHaveLength(0)
    expect(switchCalls()).toHaveLength(0)
    // No backoff: the next tick should retry immediately.
    expect(useAccountScheduleStore.getState().autoSwitch.anthropic?.notBefore).toBeUndefined()
  })
})

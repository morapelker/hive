import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import type { ClaudeLiveUsagePayload } from '@shared/types/claude-live-usage'
import type { SavedAccountDTO, UsageData } from '@shared/types/usage'
import { useUsageStore } from '../useUsageStore'
import { useAccountStore } from '../useAccountStore'

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn() }
}))

vi.mock('@/lib/hive-account-report', () => ({
  reportActiveAccountsSnapshot: vi.fn()
}))

const NOW = new Date('2026-10-02T01:00:00.000Z').getTime()

const polledUsage: UsageData = {
  five_hour: { utilization: 70, resets_at: '2026-10-02T03:00:00.000Z' },
  seven_day: { utilization: 20, resets_at: '2026-10-05T10:00:00.000Z' },
  extra_usage: { is_enabled: true, utilization: 5, used_credits: 1, monthly_limit: 10 }
}

function account(id: string, email: string, usage: UsageData | null): SavedAccountDTO {
  return {
    id,
    provider: 'anthropic',
    email,
    last_usage: usage,
    last_fetched_at: '2026-10-02T00:00:00.000Z',
    status: 'error',
    last_error: 'stale',
    created_at: '2026-01-01T00:00:00.000Z',
    plan: 'max'
  }
}

function payload(overrides: Partial<ClaudeLiveUsagePayload> = {}): ClaudeLiveUsagePayload {
  return {
    provider: 'anthropic',
    accountId: 'row-a',
    email: 'a@example.com',
    accountUuid: '718fd88e-2076-4451-bc5f-066158379585',
    isLiveAccount: true,
    liveEmail: 'a@example.com',
    usage: {
      five_hour: { utilization: 42, resets_at: '2026-10-02T05:00:00.000Z' },
      seven_day: { utilization: 61, resets_at: '2026-10-05T10:00:00.000Z' },
      extra_usage: polledUsage.extra_usage
    },
    rateLimit: {
      fiveHour: { status: 'allowed', resetsAt: Math.floor(NOW / 1000) + 4 * 3600 },
      sevenDay: { status: 'allowed_warning', resetsAt: Math.floor(NOW / 1000) + 3 * 86400 }
    },
    observedAt: NOW,
    ...overrides
  }
}

describe('useUsageStore.applyClaudeLiveUsage', () => {
  let request: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    request = vi.fn(async (method: string) => {
      if (method === 'accountOps.getClaudeEmail') return 'a@example.com'
      if (method === 'accountOps.listSaved') return []
      if (method === 'usageOps.fetch') return { success: false, error: 'offline' }
      return null
    })
    setRendererRpcClient({ request, subscribe: vi.fn() })

    useAccountStore.setState({ anthropicEmail: 'a@example.com' })
    useUsageStore.setState({
      anthropicUsage: polledUsage,
      anthropicLastFetchedAt: NOW - 60_000,
      anthropicIsLoading: false,
      anthropicLastError: 'Usage API returned 429',
      anthropicLastRetryAfter: 30,
      anthropicRateLimit: {
        fiveHour: { status: 'rejected', resetsAt: Math.floor(NOW / 1000) + 3600 },
        updatedAt: NOW - 60_000
      },
      anthropicUsageFromFetch: false,
      anthropicAccountSwitchedAt: null,
      anthropicEarlyRefreshAttemptAt: null,
      anthropicLiveUpdatedAt: null,
      savedAccounts: {
        anthropic: [
          account('row-a', 'a@example.com', polledUsage),
          account('row-b', 'b@example.com', null)
        ],
        openai: []
      },
      savedAccountsLoaded: { anthropic: true, openai: false }
    })
  })

  afterEach(() => {
    resetRendererRpcClientForTests()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('updates the attributed row snapshot and, for the live account, the bar and overlay', async () => {
    useUsageStore.getState().applyClaudeLiveUsage(payload())
    await vi.runAllTimersAsync()

    const state = useUsageStore.getState()
    const rowA = state.savedAccounts.anthropic.find((row) => row.id === 'row-a')!
    expect(rowA.last_usage).toEqual(payload().usage)
    // The poll's bookkeeping on the row is not ours to touch.
    expect(rowA.last_fetched_at).toBe('2026-10-02T00:00:00.000Z')
    expect(rowA.status).toBe('error')
    expect(state.savedAccounts.anthropic.find((row) => row.id === 'row-b')!.last_usage).toBeNull()

    expect(state.anthropicUsage).toEqual(payload().usage)
    expect(state.anthropicUsageFromFetch).toBe(true)
    expect(state.anthropicLiveUpdatedAt).toBe(NOW)
    // The usage-endpoint poll keeps its own clock and its Retry-After state —
    // including the error that announces the pending deadline.
    expect(state.anthropicLastFetchedAt).toBe(NOW - 60_000)
    expect(state.anthropicLastRetryAfter).toBe(30)
    expect(state.anthropicLastError).toBe('Usage API returned 429')
    // The stale rejected 5h overlay is replaced by the response's own verdict.
    expect(state.anthropicRateLimit?.fiveHour).toMatchObject({ status: 'allowed' })
    expect(state.anthropicRateLimit?.sevenDay).toMatchObject({ status: 'allowed_warning' })
    // Neither the update nor the warning window issued a poll.
    expect(request).not.toHaveBeenCalledWith('usageOps.fetch', expect.anything())
    expect(state.anthropicEarlyRefreshAttemptAt).toBeNull()
  })

  it('keeps five_hour null for an account whose plan has no 5h window', async () => {
    // Plans without the 5h limit get no `-5h-*` headers: the main process then
    // publishes `five_hour: null` and no fiveHour rate-limit window. The null
    // must reach the bar and the row untouched (it is what hides the 5h bar),
    // and no 5h overlay may be conjured for a window that doesn't exist.
    useUsageStore.setState({ anthropicRateLimit: null })
    const noFiveHour = payload({
      usage: {
        five_hour: null,
        seven_day: { utilization: 6, resets_at: '2026-11-06T15:00:00.000Z' }
      },
      rateLimit: {
        sevenDay: { status: 'allowed', resetsAt: Math.floor(NOW / 1000) + 3 * 86400 }
      }
    })

    useUsageStore.getState().applyClaudeLiveUsage(noFiveHour)
    await vi.runAllTimersAsync()

    const state = useUsageStore.getState()
    expect(state.anthropicUsage).toEqual(noFiveHour.usage)
    expect(state.anthropicUsage?.five_hour).toBeNull()
    expect(state.anthropicUsage?.seven_day?.utilization).toBe(6)
    const rowA = state.savedAccounts.anthropic.find((row) => row.id === 'row-a')!
    expect(rowA.last_usage).toEqual(noFiveHour.usage)
    expect(rowA.last_usage).toMatchObject({ five_hour: null })
    expect(state.anthropicRateLimit?.fiveHour).toBeUndefined()
    expect(state.anthropicRateLimit?.sevenDay).toMatchObject({ status: 'allowed' })
  })

  it('clears a stale poll error once no Retry-After deadline is pending', () => {
    useUsageStore.setState({ anthropicLastRetryAfter: null, anthropicLastError: 'offline' })
    useUsageStore.getState().applyClaudeLiveUsage(payload())
    expect(useUsageStore.getState().anthropicLastError).toBeNull()
  })

  it('leaves the bar alone when the main process says the account is not the live one', () => {
    useUsageStore
      .getState()
      .applyClaudeLiveUsage(
        payload({ accountId: 'row-b', email: 'b@example.com', isLiveAccount: false })
      )

    const state = useUsageStore.getState()
    expect(state.savedAccounts.anthropic.find((row) => row.id === 'row-b')!.last_usage).toEqual(
      payload().usage
    )
    expect(state.anthropicUsage).toBe(polledUsage)
    expect(state.anthropicLiveUpdatedAt).toBeNull()
    expect(state.anthropicRateLimit?.fiveHour).toMatchObject({ status: 'rejected' })
  })

  it('drops a live verdict observed before this renderer stamped its switch', () => {
    useUsageStore.setState({ anthropicAccountSwitchedAt: NOW - 1_000 })
    useUsageStore.getState().applyClaudeLiveUsage(payload({ observedAt: NOW - 2_000 }))
    expect(useUsageStore.getState().anthropicUsage).toBe(polledUsage)
    expect(useUsageStore.getState().anthropicLiveUpdatedAt).toBeNull()

    useUsageStore.getState().applyClaudeLiveUsage(payload({ observedAt: NOW }))
    expect(useUsageStore.getState().anthropicUsage).toEqual(payload().usage)
  })

  it('syncs a lagging cached active email from the identity the main process saw', () => {
    // Switched to B, but the renderer's email refresh has not landed yet.
    useUsageStore.setState({ anthropicAccountSwitchedAt: NOW - 500 })
    useUsageStore
      .getState()
      .applyClaudeLiveUsage(
        payload({ accountId: 'row-b', email: 'b@example.com', liveEmail: 'b@example.com' })
      )

    expect(useAccountStore.getState().anthropicEmail).toBe('b@example.com')
    expect(useUsageStore.getState().anthropicUsage).toEqual(payload().usage)
    expect(useUsageStore.getState().anthropicLiveUpdatedAt).toBe(NOW)
    expect(request).not.toHaveBeenCalledWith('accountOps.getClaudeEmail', expect.anything())
  })

  it('applies when the identity was never loaded, seeding the active email', () => {
    useAccountStore.setState({ anthropicEmail: null })
    useUsageStore.getState().applyClaudeLiveUsage(payload())
    expect(useAccountStore.getState().anthropicEmail).toBe('a@example.com')
    expect(useUsageStore.getState().anthropicLiveUpdatedAt).toBe(NOW)
  })

  it('reloads the saved list when the attributed account is not in it yet', async () => {
    useUsageStore
      .getState()
      .applyClaudeLiveUsage(payload({ accountId: 'row-c', email: 'c@example.com' }))
    await vi.runAllTimersAsync()
    expect(request).toHaveBeenCalledWith('accountOps.listSaved', { provider: 'anthropic' })
  })

  it('a later switch clears the live marker so the predictor and label reset', () => {
    useUsageStore.getState().applyClaudeLiveUsage(payload())
    expect(useUsageStore.getState().anthropicLiveUpdatedAt).toBe(NOW)

    useUsageStore.getState().noteExternalAnthropicAccountSwitch()
    expect(useUsageStore.getState().anthropicLiveUpdatedAt).toBeNull()
  })
})

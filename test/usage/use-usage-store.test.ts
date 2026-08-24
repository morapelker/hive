import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SavedAccountDTO } from '@shared/types/usage'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { useUsageStore, type UsageData } from '@/stores/useUsageStore'
import { useAccountStore } from '@/stores/useAccountStore'
import { toast } from '@/lib/toast'

vi.mock('@/lib/toast', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn()
  }
}))

const sampleUsage: UsageData = {
  five_hour: {
    utilization: 42,
    resets_at: '2026-05-14T12:00:00.000Z'
  },
  seven_day: {
    utilization: 13,
    resets_at: '2026-05-15T12:00:00.000Z'
  }
}

function usageState(): ReturnType<typeof useUsageStore.getState> & {
  anthropicLastError: string | null
  openaiLastError: string | null
} {
  return useUsageStore.getState() as ReturnType<typeof useUsageStore.getState> & {
    anthropicLastError: string | null
    openaiLastError: string | null
  }
}

describe('useUsageStore', () => {
  let request: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-14T09:00:00.000Z'))
    vi.mocked(toast.error).mockClear()
    vi.mocked(toast.success).mockClear()

    request = vi.fn(async (method: string) => {
      if (method === 'accountOps.listSaved') return []
      return null
    })
    setRendererRpcClient({ request, subscribe: vi.fn() })

    useUsageStore.setState({
      anthropicUsage: null,
      anthropicLastFetchedAt: null,
      anthropicIsLoading: false,
      anthropicLastError: null,
      anthropicRateLimit: null,
      anthropicRateLimitRefreshAttemptAt: null,
      anthropicAccountSwitchedAt: null,
      anthropicUsageFromFetch: false,
      openaiUsage: null,
      openaiLastFetchedAt: null,
      openaiIsLoading: false,
      openaiLastError: null,
      activeProvider: 'anthropic'
    } as Partial<ReturnType<typeof useUsageStore.getState>>)
  })

  afterEach(() => {
    resetRendererRpcClientForTests()
    vi.useRealTimers()
  })

  it('records inner Anthropic failures without changing stale usage or debounce timestamp', async () => {
    useUsageStore.setState({
      anthropicUsage: sampleUsage,
      anthropicLastFetchedAt: null
    })
    request.mockImplementation(async (method: string) => {
      if (method === 'usageOps.fetch') return { success: false, error: 'No access token found' }
      if (method === 'accountOps.listSaved') return []
      return null
    })

    await useUsageStore.getState().fetchUsageForProvider('anthropic')

    const state = usageState()
    expect(state.anthropicUsage).toBe(sampleUsage)
    expect(state.anthropicLastError).toBe('No access token found')
    expect(state.anthropicLastFetchedAt).toBeNull()
    expect(state.anthropicIsLoading).toBe(false)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('records envelope-level Anthropic failures without rejecting or advancing debounce', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'usageOps.fetch') {
        return {
          success: false,
          errorCode: 'ZodDecodeError',
          error: 'Could not decode usage response'
        }
      }
      if (method === 'accountOps.listSaved') return []
      return null
    })

    await expect(
      useUsageStore.getState().forceRefreshProvider('anthropic')
    ).resolves.toBeUndefined()

    const state = usageState()
    expect(state.anthropicLastError).toBe('Could not decode usage response')
    expect(state.anthropicLastFetchedAt).toBeNull()
    expect(state.anthropicIsLoading).toBe(false)
    expect(toast.error).toHaveBeenCalledWith(
      'Claude usage refresh failed: Could not decode usage response'
    )
  })

  it('always fetches on an explicit force refresh, even shortly after a successful attempt', async () => {
    useUsageStore.setState({
      anthropicLastFetchedAt: Date.now() - 1_000,
      anthropicLastError: null
    } as Partial<ReturnType<typeof useUsageStore.getState>>)
    request.mockImplementation(async (method: string) => {
      if (method === 'usageOps.fetch') return { success: true, data: sampleUsage }
      if (method === 'accountOps.listSaved') return []
      return null
    })

    await useUsageStore.getState().forceRefreshProvider('anthropic')

    expect(request.mock.calls.filter(([method]) => method === 'usageOps.fetch')).toHaveLength(1)
    expect(usageState().anthropicUsage).toBe(sampleUsage)
  })

  it('blocks a force refresh while a 429 retry-after window is active and toasts instead of fetching', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'usageOps.fetch') {
        return {
          success: false,
          error: 'Usage API returned 429: Too Many Requests',
          retryAfter: 30
        }
      }
      if (method === 'accountOps.listSaved') return []
      return null
    })

    await useUsageStore.getState().forceRefreshProvider('anthropic')
    vi.mocked(toast.error).mockClear()
    request.mockClear()

    await useUsageStore.getState().forceRefreshProvider('anthropic')

    expect(request.mock.calls.filter(([method]) => method === 'usageOps.fetch')).toHaveLength(0)
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringMatching(/^Rate limited — retry in \d+s$/)
    )
  })

  it('clears Anthropic errors and advances debounce after a successful fetch', async () => {
    useUsageStore.setState({
      anthropicLastError: 'No access token found'
    } as Partial<ReturnType<typeof useUsageStore.getState>>)
    request.mockImplementation(async (method: string) => {
      if (method === 'usageOps.fetch') return { success: true, data: sampleUsage }
      if (method === 'accountOps.listSaved') return []
      return null
    })

    await useUsageStore.getState().fetchUsageForProvider('anthropic')

    const state = usageState()
    expect(state.anthropicUsage).toBe(sampleUsage)
    expect(state.anthropicLastError).toBeNull()
    expect(state.anthropicLastFetchedAt).toBe(Date.now())
    expect(state.anthropicIsLoading).toBe(false)
  })

  it('records inner OpenAI failures without advancing debounce', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'usageOps.fetchOpenai') return { success: false, error: 'OpenAI auth failed' }
      if (method === 'accountOps.listSaved') return []
      return null
    })

    await useUsageStore.getState().forceRefreshProvider('openai')

    const state = usageState()
    expect(state.openaiLastError).toBe('OpenAI auth failed')
    expect(state.openaiLastFetchedAt).toBeNull()
    expect(state.openaiIsLoading).toBe(false)
    expect(toast.error).toHaveBeenCalledWith('OpenAI usage refresh failed: OpenAI auth failed')
  })

  function anthropicAccount(id: string, email: string): SavedAccountDTO {
    return {
      id,
      provider: 'anthropic',
      email,
      last_usage: null,
      last_fetched_at: null,
      status: 'ok',
      last_error: null,
      created_at: '2026-01-01T00:00:00.000Z',
      plan: null
    }
  }

  it('does not toast a refresh failure when the fetch succeeded but the post-op reload hiccups', async () => {
    useUsageStore.setState({
      savedAccounts: { anthropic: [anthropicAccount('acc-1', 'a@b.com')], openai: [] }
    } as Partial<ReturnType<typeof useUsageStore.getState>>)
    request.mockImplementation(async (method: string) => {
      if (method === 'usageOps.fetchForAccount') return { success: true, status: 'ok' }
      if (method === 'accountOps.listSaved') throw new Error('reload hiccup')
      return null
    })

    await useUsageStore.getState().refreshSavedAccount('acc-1', { userInitiated: true })

    expect(toast.error).not.toHaveBeenCalled()
  })

  it('mirrors a popover refresh of the ACTIVE account into the live usage bar', async () => {
    useAccountStore.setState({ anthropicEmail: 'a@b.com' })
    useUsageStore.setState({
      anthropicUsage: null,
      savedAccounts: { anthropic: [anthropicAccount('acc-1', 'a@b.com')], openai: [] }
    } as Partial<ReturnType<typeof useUsageStore.getState>>)
    request.mockImplementation(async (method: string) => {
      if (method === 'usageOps.fetchForAccount')
        return { success: true, status: 'ok', data: sampleUsage }
      if (method === 'accountOps.listSaved') return []
      return null
    })

    await useUsageStore.getState().refreshSavedAccount('acc-1', { userInitiated: true })

    expect(usageState().anthropicUsage).toEqual(sampleUsage)
    expect(usageState().anthropicLastFetchedAt).toBe(Date.now())
  })

  it('does not touch the live usage bar when refreshing a NON-active account', async () => {
    useAccountStore.setState({ anthropicEmail: 'a@b.com' })
    useUsageStore.setState({
      anthropicUsage: null,
      savedAccounts: { anthropic: [anthropicAccount('acc-2', 'other@b.com')], openai: [] }
    } as Partial<ReturnType<typeof useUsageStore.getState>>)
    request.mockImplementation(async (method: string) => {
      if (method === 'usageOps.fetchForAccount')
        return { success: true, status: 'ok', data: sampleUsage }
      if (method === 'accountOps.listSaved') return []
      return null
    })

    await useUsageStore.getState().refreshSavedAccount('acc-2', { userInitiated: true })

    expect(usageState().anthropicUsage).toBeNull()
  })

  it('toasts switch success even when a post-switch reload fails', async () => {
    useUsageStore.setState({
      savedAccounts: { anthropic: [anthropicAccount('acc-1', 'a@b.com')], openai: [] }
    } as Partial<ReturnType<typeof useUsageStore.getState>>)
    request.mockImplementation(async (method: string) => {
      if (method === 'accountOps.switchAccount') return { success: true }
      if (method === 'accountOps.getClaudeEmail') return 'a@b.com'
      if (method === 'accountOps.listSaved') throw new Error('reload hiccup')
      if (method === 'usageOps.fetch') return { success: true, data: sampleUsage }
      return null
    })

    await useUsageStore.getState().switchAccount('acc-1')

    expect(toast.success).toHaveBeenCalledWith('Switched to a@b.com')
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('honors a minIntervalMs override to bypass the 3-minute debounce, but not below the floor', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'usageOps.fetch') return { success: true, data: sampleUsage }
      if (method === 'accountOps.listSaved') return []
      return null
    })
    // Fetched 60s ago: the default debounce (3 min) blocks…
    useUsageStore.setState({ anthropicLastFetchedAt: Date.now() - 60_000 })
    await useUsageStore.getState().fetchUsageForProvider('anthropic')
    expect(request).not.toHaveBeenCalledWith('usageOps.fetch', expect.anything())

    // …a 30s floor lets the early refresh through…
    await useUsageStore.getState().fetchUsageForProvider('anthropic', { minIntervalMs: 30_000 })
    expect(request).toHaveBeenCalledWith('usageOps.fetch', expect.anything())

    // …but a fetch 10s old stays blocked even with the floored override.
    request.mockClear()
    useUsageStore.setState({ anthropicLastFetchedAt: Date.now() - 10_000 })
    await useUsageStore.getState().fetchUsageForProvider('anthropic', { minIntervalMs: 30_000 })
    expect(request).not.toHaveBeenCalledWith('usageOps.fetch', expect.anything())
  })

  it('keeps the Retry-After deadline authoritative over a shorter minIntervalMs', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'usageOps.fetch') return { success: true, data: sampleUsage }
      if (method === 'accountOps.listSaved') return []
      return null
    })
    // A 429 with retryAfter 120 back-dated lastFetchedAt so the deadline is
    // 120s away under the FULL debounce: fetchedAt = now - 180s + 120s.
    useUsageStore.setState({
      anthropicLastRetryAfter: 120,
      anthropicLastFetchedAt: Date.now() - 60_000
    })

    // A 30s predictor floor must NOT slip past the server's deadline…
    await useUsageStore.getState().fetchUsageForProvider('anthropic', { minIntervalMs: 30_000 })
    expect(request).not.toHaveBeenCalledWith('usageOps.fetch', expect.anything())

    // …but once the deadline has passed, the fetch goes through.
    vi.setSystemTime(Date.now() + 121_000)
    await useUsageStore.getState().fetchUsageForProvider('anthropic', { minIntervalMs: 30_000 })
    expect(request).toHaveBeenCalledWith('usageOps.fetch', expect.anything())
  })

  it('pulls a floored early refresh on warning/rejected rate-limit events, never on allowed', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'usageOps.fetch') return { success: true, data: sampleUsage }
      if (method === 'accountOps.listSaved') return []
      return null
    })
    // Last fetch 2 minutes ago — inside the normal debounce.
    useUsageStore.setState({ anthropicLastFetchedAt: Date.now() - 120_000 })

    useUsageStore.getState().setAnthropicRateLimit({
      status: 'allowed',
      resetsAt: Math.floor(Date.now() / 1000) + 3_600,
      rateLimitType: 'five_hour'
    })
    await vi.runOnlyPendingTimersAsync()
    expect(request).not.toHaveBeenCalledWith('usageOps.fetch', expect.anything())

    useUsageStore.getState().setAnthropicRateLimit({
      status: 'allowed_warning',
      resetsAt: Math.floor(Date.now() / 1000) + 3_600,
      rateLimitType: 'five_hour'
    })
    await vi.runOnlyPendingTimersAsync()
    expect(request).toHaveBeenCalledWith('usageOps.fetch', expect.anything())
  })

  it('floors event-driven refresh ATTEMPTS so a failing endpoint is not retried on every event', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'usageOps.fetch') return { success: false, error: 'network down' }
      if (method === 'accountOps.listSaved') return []
      return null
    })
    const fetchCalls = (): number =>
      request.mock.calls.filter(([m]) => m === 'usageOps.fetch').length

    const reject = (): void =>
      useUsageStore.getState().setAnthropicRateLimit({
        status: 'rejected',
        resetsAt: Math.floor(Date.now() / 1000) + 1_800,
        rateLimitType: 'five_hour'
      })

    // First event attempts a fetch; it FAILS, so lastFetchedAt stays null…
    reject()
    await vi.runOnlyPendingTimersAsync()
    expect(fetchCalls()).toBe(1)

    // …and an immediate event storm must not retry before the 30s floor.
    reject()
    reject()
    await vi.runOnlyPendingTimersAsync()
    expect(fetchCalls()).toBe(1)

    // After the floor elapses, the next event may try again.
    vi.setSystemTime(Date.now() + 31_000)
    reject()
    await vi.runOnlyPendingTimersAsync()
    expect(fetchCalls()).toBe(2)
  })

  it('does not burn the event attempt slot when the fetch floor would no-op anyway', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'usageOps.fetch') return { success: true, data: sampleUsage }
      if (method === 'accountOps.listSaved') return []
      return null
    })
    const fetchCalls = (): number =>
      request.mock.calls.filter(([m]) => m === 'usageOps.fetch').length
    const reject = (): void =>
      useUsageStore.getState().setAnthropicRateLimit({
        status: 'rejected',
        resetsAt: Math.floor(Date.now() / 1000) + 1_800,
        rateLimitType: 'five_hour'
      })

    // An event 29s after a successful fetch: inside the fetch floor, so no
    // request — and crucially no attempt recorded (it would be a no-op).
    useUsageStore.setState({ anthropicLastFetchedAt: Date.now() - 29_000 })
    reject()
    await vi.runOnlyPendingTimersAsync()
    expect(fetchCalls()).toBe(0)

    // 2s later the fetch floor is open: the next event fetches immediately
    // instead of waiting out an attempt slot burned by the no-op above.
    vi.setSystemTime(Date.now() + 2_000)
    reject()
    await vi.runOnlyPendingTimersAsync()
    expect(fetchCalls()).toBe(1)
  })

  it('does not burn the event attempt slot inside a pending Retry-After window', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'usageOps.fetch') return { success: true, data: sampleUsage }
      if (method === 'accountOps.listSaved') return []
      return null
    })
    const fetchCalls = (): number =>
      request.mock.calls.filter(([m]) => m === 'usageOps.fetch').length
    const reject = (): void =>
      useUsageStore.getState().setAnthropicRateLimit({
        status: 'rejected',
        resetsAt: Math.floor(Date.now() / 1000) + 1_800,
        rateLimitType: 'five_hour'
      })

    // Retry-After pending: the fetch enforces the FULL debounce (deadline in
    // 20s), so this event must not record an attempt on a guaranteed no-op.
    useUsageStore.setState({
      anthropicLastRetryAfter: 120,
      anthropicLastFetchedAt: Date.now() - 160_000
    })
    reject()
    await vi.runOnlyPendingTimersAsync()
    expect(fetchCalls()).toBe(0)

    // 25s later the server deadline has passed: the next event fetches
    // immediately instead of waiting out a wasted attempt slot.
    vi.setSystemTime(Date.now() + 25_000)
    reject()
    await vi.runOnlyPendingTimersAsync()
    expect(fetchCalls()).toBe(1)
  })

  it('clears the anthropic rate-limit overlay on a successful switch', async () => {
    useUsageStore.setState({
      savedAccounts: {
        anthropic: [
          {
            id: 'acc-1',
            provider: 'anthropic',
            email: 'a@b.com',
            last_usage: null,
            last_fetched_at: null,
            status: 'ok',
            last_error: null,
            created_at: new Date().toISOString(),
            plan: null
          }
        ],
        openai: []
      },
      anthropicRateLimit: {
        fiveHour: {
          status: 'rejected',
          resetsAt: Math.floor(Date.now() / 1000) + 1_800
        },
        updatedAt: Date.now()
      }
    } as Partial<ReturnType<typeof useUsageStore.getState>>)
    request.mockImplementation(async (method: string) => {
      if (method === 'accountOps.switchAccount') return { success: true }
      if (method === 'accountOps.getClaudeEmail') return 'a@b.com'
      if (method === 'accountOps.listSaved') return []
      if (method === 'usageOps.fetch') return { success: true, data: sampleUsage }
      return null
    })

    await useUsageStore.getState().switchAccount('acc-1')

    expect(useUsageStore.getState().anthropicRateLimit).toBeNull()
    // The pre-switch usage object no longer describes the live account —
    // it must not pass for fetch data (predictor calibration baseline).
    expect(useUsageStore.getState().anthropicUsageFromFetch).toBe(false)
  })

  it('discards a usage fetch that resolves after an account switch happened mid-flight', async () => {
    const staleUsage: UsageData = {
      five_hour: { utilization: 99, resets_at: '2026-05-14T12:00:00.000Z' },
      seven_day: { utilization: 90, resets_at: '2026-05-15T12:00:00.000Z' }
    }
    const seededUsage: UsageData = {
      five_hour: { utilization: 5, resets_at: '2026-05-14T12:00:00.000Z' },
      seven_day: { utilization: 3, resets_at: '2026-05-15T12:00:00.000Z' }
    }
    request.mockImplementation(async (method: string) => {
      if (method === 'usageOps.fetch') {
        // A switch (and its seed) completes while this request is in flight.
        useUsageStore.setState({
          anthropicAccountSwitchedAt: Date.now(),
          anthropicUsage: seededUsage,
          anthropicUsageFromFetch: false
        })
        return { success: true, data: staleUsage }
      }
      if (method === 'accountOps.listSaved') return []
      return null
    })

    await useUsageStore.getState().fetchUsageForProvider('anthropic')

    // The response describes the account we just left — it must not clobber
    // the seed, restore fetch provenance, or advance the debounce.
    expect(useUsageStore.getState().anthropicUsage).toBe(seededUsage)
    expect(useUsageStore.getState().anthropicUsageFromFetch).toBe(false)
    expect(useUsageStore.getState().anthropicLastFetchedAt).toBeNull()
    expect(useUsageStore.getState().anthropicIsLoading).toBe(false)
  })

  it('merges Anthropic rate-limit windows and drops stale windows', () => {
    useUsageStore.getState().setAnthropicRateLimit({
      status: 'allowed_warning',
      resetsAt: Math.floor(Date.now() / 1000) + 3_600,
      rateLimitType: 'five_hour',
      isUsingOverage: false,
      overageStatus: 'rejected'
    })
    useUsageStore.getState().setAnthropicRateLimit({
      status: 'allowed',
      resetsAt: Math.floor(Date.now() / 1000) + 86_400,
      rateLimitType: 'seven_day',
      isUsingOverage: true,
      overageStatus: 'allowed'
    })

    expect(useUsageStore.getState().anthropicRateLimit).toMatchObject({
      fiveHour: {
        status: 'allowed_warning',
        isUsingOverage: false,
        overageStatus: 'rejected'
      },
      sevenDay: {
        status: 'allowed',
        isUsingOverage: true,
        overageStatus: 'allowed'
      },
      updatedAt: Date.now()
    })

    useUsageStore.getState().setAnthropicRateLimit({
      status: 'rejected',
      resetsAt: Math.floor(Date.now() / 1000) - 1,
      rateLimitType: 'five_hour'
    })

    expect(useUsageStore.getState().anthropicRateLimit?.fiveHour).toBeUndefined()
    expect(useUsageStore.getState().anthropicRateLimit?.sevenDay?.status).toBe('allowed')
  })
})

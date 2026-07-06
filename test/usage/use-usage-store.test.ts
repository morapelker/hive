import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SavedAccountDTO } from '@shared/types/usage'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { useUsageStore, type UsageData } from '@/stores/useUsageStore'
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
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/^Rate limited — retry in \d+s$/))
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

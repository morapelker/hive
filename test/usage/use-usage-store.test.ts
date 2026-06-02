import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { useUsageStore, type UsageData } from '@/stores/useUsageStore'

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

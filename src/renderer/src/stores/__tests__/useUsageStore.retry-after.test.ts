import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { useUsageStore } from '../useUsageStore'

const baseState = {
  anthropicUsage: null,
  anthropicLastFetchedAt: null,
  anthropicIsLoading: false,
  anthropicLastError: null,
  anthropicLastRetryAfter: null,
  anthropicRateLimit: null,
  openaiUsage: null,
  openaiLastFetchedAt: null,
  openaiIsLoading: false,
  openaiLastError: null,
  activeProvider: 'anthropic' as const,
  savedAccounts: { anthropic: [], openai: [] },
  savedAccountLoadErrors: { anthropic: null, openai: null },
  refreshingProviders: { anthropic: false, openai: false },
  refreshingAccountIds: new Set<string>()
}

describe('useUsageStore Anthropic rate-limit throttling', () => {
  let request: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-18T10:00:00.000Z'))
    vi.clearAllMocks()

    useUsageStore.setState(baseState)

    request = vi.fn(async (method: string) => {
      if (method === 'accountOps.listSaved') return []
      return null
    })
    setRendererRpcClient({ request, subscribe: vi.fn() })
  })

  afterEach(() => {
    resetRendererRpcClientForTests()
    vi.useRealTimers()
  })

  it('uses Retry-After from a failed Anthropic fetch to debounce the next fetch', async () => {
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

    await useUsageStore.getState().fetchUsageForProvider('anthropic')
    await useUsageStore.getState().fetchUsageForProvider('anthropic')

    expect(request.mock.calls.filter(([method]) => method === 'usageOps.fetch')).toHaveLength(1)
    expect(useUsageStore.getState().anthropicLastFetchedAt).toBe(Date.now() - 180_000 + 30_000)
  })

  it('does not force refresh Anthropic usage within 5 seconds of a successful attempt', async () => {
    useUsageStore.setState({
      anthropicLastFetchedAt: Date.now() - 1_000,
      anthropicLastError: null
    })

    await useUsageStore.getState().forceRefreshProvider('anthropic')

    expect(request.mock.calls.filter(([method]) => method === 'usageOps.fetch')).toHaveLength(0)
  })
})

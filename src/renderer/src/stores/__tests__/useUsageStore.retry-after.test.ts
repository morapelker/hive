import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useUsageStore } from '../useUsageStore'

const baseState = {
  anthropicUsage: null,
  anthropicLastFetchedAt: null,
  anthropicIsLoading: false,
  anthropicLastError: null,
  anthropicLastRetryAfter: null,
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
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-18T10:00:00.000Z'))
    vi.clearAllMocks()

    useUsageStore.setState(baseState)

    Object.defineProperty(window, 'usageOps', {
      writable: true,
      configurable: true,
      value: {
        fetch: vi.fn(),
        fetchOpenai: vi.fn(),
        fetchForAccount: vi.fn(),
        refreshAllForProvider: vi.fn()
      }
    })

    Object.defineProperty(window, 'accountOps', {
      writable: true,
      configurable: true,
      value: {
        getClaudeEmail: vi.fn(),
        getOpenAIEmail: vi.fn(),
        listSaved: vi.fn().mockResolvedValue({ success: true, value: [] }),
        removeSaved: vi.fn()
      }
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('uses Retry-After from a failed Anthropic fetch to debounce the next fetch', async () => {
    vi.mocked(window.usageOps.fetch).mockResolvedValue({
      success: true,
      value: { success: false, error: 'Usage API returned 429: Too Many Requests', retryAfter: 30 }
    })

    await useUsageStore.getState().fetchUsageForProvider('anthropic')
    await useUsageStore.getState().fetchUsageForProvider('anthropic')

    expect(window.usageOps.fetch).toHaveBeenCalledTimes(1)
    expect(useUsageStore.getState().anthropicLastFetchedAt).toBe(Date.now() - 180_000 + 30_000)
  })

  it('does not force refresh Anthropic usage within 5 seconds of a successful attempt', async () => {
    useUsageStore.setState({
      anthropicLastFetchedAt: Date.now() - 1_000,
      anthropicLastError: null
    })

    await useUsageStore.getState().forceRefreshProvider('anthropic')

    expect(window.usageOps.fetch).not.toHaveBeenCalled()
  })
})

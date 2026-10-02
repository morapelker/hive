import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  FetchForAccountResult,
  OpenAIUsageResult,
  RefreshAllResultItem,
  UsageResult
} from '@shared/types/usage'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '../rpc-client'
import { usageApi } from '../usage-api'

describe('usageApi', () => {
  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  it('routes fetch through the renderer RPC client', async () => {
    const result: UsageResult = {
      success: true,
      data: {
        five_hour: { utilization: 42, resets_at: '2026-05-26T05:00:00.000Z' },
        seven_day: { utilization: 17, resets_at: '2026-06-02T00:00:00.000Z' }
      }
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(usageApi.fetch()).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('usageOps.fetch', {})
  })

  it('routes fetchOpenai through the renderer RPC client', async () => {
    const result: OpenAIUsageResult = {
      success: true,
      data: {
        plan_type: 'pro',
        rate_limit: {
          primary_window: {
            used_percent: 25,
            limit_window_seconds: 3600,
            reset_after_seconds: 600,
            reset_at: 1770000000
          },
          secondary_window: null
        }
      }
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(usageApi.fetchOpenai()).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('usageOps.fetchOpenai', {})
  })

  it('routes refreshAllForProvider through the renderer RPC client', async () => {
    const result: RefreshAllResultItem[] = [
      { accountId: 'account-1', success: true },
      { accountId: 'account-2', success: false, error: 'stale token', retryAfter: 60 }
    ]
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(usageApi.refreshAllForProvider('anthropic')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('usageOps.refreshAllForProvider', {
      provider: 'anthropic'
    })
  })

  it('routes fetchForAccount through the renderer RPC client', async () => {
    const result: FetchForAccountResult = {
      success: true,
      data: {
        five_hour: { utilization: 42, resets_at: '2026-05-26T05:00:00.000Z' },
        seven_day: { utilization: 17, resets_at: '2026-06-02T00:00:00.000Z' }
      },
      status: 'ok'
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(usageApi.fetchForAccount('account-1')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('usageOps.fetchForAccount', {
      accountId: 'account-1',
      userInitiated: undefined
    })
  })

  it('passes userInitiated through to the renderer RPC client', async () => {
    const result: FetchForAccountResult = {
      success: true,
      data: {
        five_hour: { utilization: 42, resets_at: '2026-05-26T05:00:00.000Z' },
        seven_day: { utilization: 17, resets_at: '2026-06-02T00:00:00.000Z' }
      },
      status: 'ok'
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(usageApi.fetchForAccount('account-1', true)).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('usageOps.fetchForAccount', {
      accountId: 'account-1',
      userInitiated: true
    })
  })

  it('subscribes to live Claude usage events and ignores malformed payloads', () => {
    const request = vi.fn()
    const unsubscribe = vi.fn()
    const subscribe = vi.fn().mockReturnValue(unsubscribe)
    setRendererRpcClient({ request, subscribe })

    const callback = vi.fn()
    const dispose = usageApi.onClaudeLiveUsage(callback)
    expect(subscribe).toHaveBeenCalledWith('usage:claudeLive', expect.any(Function))
    const listener = subscribe.mock.calls[0][1] as (event: {
      channel: string
      payload: unknown
    }) => void

    const payload = {
      provider: 'anthropic',
      accountId: 'row-a',
      email: 'a@example.com',
      accountUuid: '718fd88e-2076-4451-bc5f-066158379585',
      isLiveAccount: true,
      liveEmail: 'a@example.com',
      usage: {
        five_hour: { utilization: 3, resets_at: null },
        seven_day: { utilization: 39, resets_at: null }
      },
      rateLimit: {},
      observedAt: 1
    }
    listener({ channel: 'usage:claudeLive', payload })
    listener({ channel: 'usage:claudeLive', payload: { provider: 'openai' } })
    listener({ channel: 'usage:claudeLive', payload: null })
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith(payload)

    // The client-reported uuid is optional: attribution goes by credential.
    listener({ channel: 'usage:claudeLive', payload: { ...payload, accountUuid: null } })
    expect(callback).toHaveBeenCalledTimes(2)

    dispose()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})

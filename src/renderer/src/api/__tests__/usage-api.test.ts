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
})

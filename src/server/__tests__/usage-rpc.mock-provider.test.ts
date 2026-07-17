import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import type {
  FetchForAccountResult,
  OpenAIUsageResult,
  RefreshAllResultItem,
  UsageResult
} from '../../shared/types/usage'
import { makeEventBus } from '../events/event-bus'
import type { UsageOpsRpcService } from '../rpc/domains/usage-ops'
import { makeRpcRouter } from '../rpc/router'

describe('usage ops RPC mocked provider', () => {
  it('routes usageOps.fetch to the injected provider service', async () => {
    const result: UsageResult = {
      success: true,
      data: {
        five_hour: {
          utilization: 42,
          resets_at: '2026-05-26T05:00:00.000Z'
        },
        seven_day: {
          utilization: 17,
          resets_at: '2026-06-02T00:00:00.000Z'
        },
        extra_usage: {
          is_enabled: true,
          utilization: 5,
          used_credits: 1,
          monthly_limit: 20
        }
      }
    }
    const fetch = vi.fn(() => Effect.succeed(result))
    const service = { fetch } as unknown as UsageOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      usageOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'usage-fetch-1',
        method: 'usageOps.fetch',
        params: {}
      })
    )

    expect(fetch).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'usage-fetch-1',
      ok: true,
      value: result
    })
  })

  it('validates usageOps.fetch params before calling the provider service', async () => {
    const fetch = vi.fn(() => Effect.succeed({ success: false, error: 'unused' }))
    const service = { fetch } as unknown as UsageOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      usageOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'usage-fetch-invalid',
        method: 'usageOps.fetch',
        params: { unexpected: true }
      })
    )

    expect(fetch).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'usage-fetch-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes usageOps.fetchOpenai to the injected provider service', async () => {
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
        },
        credits: {
          has_credits: true,
          unlimited: false,
          balance: '12.34'
        }
      }
    }
    const fetchOpenai = vi.fn(() => Effect.succeed(result))
    const service = { fetchOpenai } as unknown as UsageOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      usageOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'usage-fetch-openai-1',
        method: 'usageOps.fetchOpenai',
        params: {}
      })
    )

    expect(fetchOpenai).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'usage-fetch-openai-1',
      ok: true,
      value: result
    })
  })

  it('validates usageOps.fetchOpenai params before calling the provider service', async () => {
    const fetchOpenai = vi.fn(() => Effect.succeed({ success: false, error: 'unused' }))
    const service = { fetchOpenai } as unknown as UsageOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      usageOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'usage-fetch-openai-invalid',
        method: 'usageOps.fetchOpenai',
        params: { unexpected: true }
      })
    )

    expect(fetchOpenai).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'usage-fetch-openai-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes usageOps.fetchForAccount to the injected provider service', async () => {
    const result: FetchForAccountResult = {
      success: true,
      data: {
        five_hour: {
          utilization: 42,
          resets_at: '2026-05-26T05:00:00.000Z'
        },
        seven_day: {
          utilization: 17,
          resets_at: '2026-06-02T00:00:00.000Z'
        }
      },
      status: 'ok'
    }
    const fetchForAccount = vi.fn(() => Effect.succeed(result))
    const service = { fetchForAccount } as unknown as UsageOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      usageOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'usage-fetch-for-account-1',
        method: 'usageOps.fetchForAccount',
        params: { accountId: 'account-1' }
      })
    )

    expect(fetchForAccount).toHaveBeenCalledWith('account-1', undefined)
    expect(response).toEqual({
      id: 'usage-fetch-for-account-1',
      ok: true,
      value: result
    })
  })

  it('passes userInitiated through to the injected provider service', async () => {
    const result: FetchForAccountResult = { success: true, status: 'ok' }
    const fetchForAccount = vi.fn(() => Effect.succeed(result))
    const service = { fetchForAccount } as unknown as UsageOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      usageOps: service
    })

    await Effect.runPromise(
      router.handle({
        id: 'usage-fetch-for-account-user-initiated',
        method: 'usageOps.fetchForAccount',
        params: { accountId: 'account-1', userInitiated: true }
      })
    )

    expect(fetchForAccount).toHaveBeenCalledWith('account-1', true)
  })

  it('validates usageOps.fetchForAccount params before calling the provider service', async () => {
    const fetchForAccount = vi.fn(() =>
      Effect.succeed({ success: false, status: 'error' as const })
    )
    const service = { fetchForAccount } as unknown as UsageOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      usageOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'usage-fetch-for-account-invalid',
        method: 'usageOps.fetchForAccount',
        params: { accountId: 123 }
      })
    )

    expect(fetchForAccount).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'usage-fetch-for-account-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('rejects a non-boolean userInitiated for usageOps.fetchForAccount', async () => {
    const fetchForAccount = vi.fn(() =>
      Effect.succeed({ success: false, status: 'error' as const })
    )
    const service = { fetchForAccount } as unknown as UsageOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      usageOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'usage-fetch-for-account-bad-user-initiated',
        method: 'usageOps.fetchForAccount',
        params: { accountId: 'account-1', userInitiated: 'yes' }
      })
    )

    expect(fetchForAccount).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'usage-fetch-for-account-bad-user-initiated',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes usageOps.refreshAllForProvider to the injected provider service', async () => {
    const result: RefreshAllResultItem[] = [
      { accountId: 'account-1', success: true },
      { accountId: 'account-2', success: false, error: 'stale token', retryAfter: 60 }
    ]
    const refreshAllForProvider = vi.fn(() => Effect.succeed(result))
    const service = { refreshAllForProvider } as unknown as UsageOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      usageOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'usage-refresh-all-for-provider-1',
        method: 'usageOps.refreshAllForProvider',
        params: { provider: 'openai' }
      })
    )

    expect(refreshAllForProvider).toHaveBeenCalledWith('openai')
    expect(response).toEqual({
      id: 'usage-refresh-all-for-provider-1',
      ok: true,
      value: result
    })
  })

  it('validates usageOps.refreshAllForProvider params before calling the provider service', async () => {
    const refreshAllForProvider = vi.fn(() => Effect.succeed([]))
    const service = { refreshAllForProvider } as unknown as UsageOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      usageOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'usage-refresh-all-for-provider-invalid',
        method: 'usageOps.refreshAllForProvider',
        params: { provider: 'other' }
      })
    )

    expect(refreshAllForProvider).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'usage-refresh-all-for-provider-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })
})

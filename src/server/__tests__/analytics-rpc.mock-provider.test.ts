import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { makeEventBus } from '../events/event-bus'
import type { AnalyticsOpsRpcService } from '../rpc/domains/analytics-ops'
import { makeRpcRouter } from '../rpc/router'

describe('analytics ops RPC mocked provider', () => {
  it('routes analyticsOps.track to the injected provider service', async () => {
    const properties = { source: 'settings', enabled: true }
    const track = vi.fn(() => Effect.void)
    const service = { track } as unknown as AnalyticsOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      analyticsOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'analytics-track-1',
        method: 'analyticsOps.track',
        params: { event: 'setting_changed', properties }
      })
    )

    expect(track).toHaveBeenCalledWith('setting_changed', properties)
    expect(response).toEqual({
      id: 'analytics-track-1',
      ok: true,
      value: undefined
    })
  })

  it('validates analyticsOps.track params before calling the provider service', async () => {
    const track = vi.fn(() => Effect.void)
    const service = { track } as unknown as AnalyticsOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      analyticsOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'analytics-track-invalid',
        method: 'analyticsOps.track',
        params: { event: 123, properties: { source: 'settings' } }
      })
    )

    expect(track).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'analytics-track-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes analyticsOps.setEnabled to the injected provider service', async () => {
    const setEnabled = vi.fn(() => Effect.void)
    const service = { setEnabled } as unknown as AnalyticsOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      analyticsOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'analytics-set-enabled-1',
        method: 'analyticsOps.setEnabled',
        params: { enabled: false }
      })
    )

    expect(setEnabled).toHaveBeenCalledWith(false)
    expect(response).toEqual({
      id: 'analytics-set-enabled-1',
      ok: true,
      value: undefined
    })
  })

  it('validates analyticsOps.setEnabled params before calling the provider service', async () => {
    const setEnabled = vi.fn(() => Effect.void)
    const service = { setEnabled } as unknown as AnalyticsOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      analyticsOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'analytics-set-enabled-invalid',
        method: 'analyticsOps.setEnabled',
        params: { enabled: 'no' }
      })
    )

    expect(setEnabled).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'analytics-set-enabled-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes analyticsOps.isEnabled to the injected provider service', async () => {
    const isEnabled = vi.fn(() => Effect.succeed(false))
    const service = { isEnabled } as unknown as AnalyticsOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      analyticsOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'analytics-is-enabled-1',
        method: 'analyticsOps.isEnabled',
        params: {}
      })
    )

    expect(isEnabled).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'analytics-is-enabled-1',
      ok: true,
      value: false
    })
  })

  it('validates analyticsOps.isEnabled params before calling the provider service', async () => {
    const isEnabled = vi.fn(() => Effect.succeed(true))
    const service = { isEnabled } as unknown as AnalyticsOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      analyticsOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'analytics-is-enabled-invalid',
        method: 'analyticsOps.isEnabled',
        params: { enabled: true }
      })
    )

    expect(isEnabled).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'analytics-is-enabled-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })
})

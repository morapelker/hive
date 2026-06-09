import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '../rpc-client'
import { analyticsApi } from '../analytics-api'

describe('analyticsApi', () => {
  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  it('routes track through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()
    const properties = { sdk: 'opencode', auto_selected: true }

    setRendererRpcClient({ request, subscribe })

    await expect(analyticsApi.track('onboarding_completed', properties)).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith('analyticsOps.track', {
      event: 'onboarding_completed',
      properties
    })
  })

  it('routes setEnabled through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(analyticsApi.setEnabled(false)).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith('analyticsOps.setEnabled', { enabled: false })
  })

  it('routes isEnabled through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(false)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(analyticsApi.isEnabled()).resolves.toBe(false)
    expect(request).toHaveBeenCalledWith('analyticsOps.isEnabled', {})
  })
})

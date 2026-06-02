import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '../rpc-client'
import { codexDebugLoggerApi } from '../codex-debug-logger-api'

describe('codexDebugLoggerApi', () => {
  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  it('routes configure through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(codexDebugLoggerApi.configure(true, false)).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith('codexDebugLoggerOps.configure', {
      enabled: true,
      resetPerSession: false
    })
  })
})

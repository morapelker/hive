import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '../rpc-client'
import { loggingApi } from '../logging-api'

describe('loggingApi', () => {
  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  it('routes createResponseLog through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue('/tmp/hive/session-1.jsonl')
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(loggingApi.createResponseLog('session-1')).resolves.toBe(
      '/tmp/hive/session-1.jsonl'
    )
    expect(request).toHaveBeenCalledWith('loggingOps.createResponseLog', {
      sessionId: 'session-1'
    })
  })

  it('routes appendResponseLog through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()
    const data = { type: 'part_updated', event: { text: 'hello' } }

    setRendererRpcClient({ request, subscribe })

    await expect(loggingApi.appendResponseLog('/tmp/hive/session-1.jsonl', data)).resolves.toBe(
      undefined
    )
    expect(request).toHaveBeenCalledWith('loggingOps.appendResponseLog', {
      filePath: '/tmp/hive/session-1.jsonl',
      data
    })
  })
})

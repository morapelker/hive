import { afterEach, describe, expect, it, vi } from 'vitest'
import { documentFlowApi } from '../document-flow-api'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '../rpc-client'

// The one read of the document flow domain that is about the app, not about a run: when the
// app instance that owns the sessions started. A PRD flow ("New PRD → orchestrator ticket…")
// asks it to tell a session that died with the app from a live one.

describe('documentFlowApi.appStartedAt', () => {
  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  it('asks documentFlow.appStartedAt with an empty object, which is all the server accepts', async () => {
    const request = vi.fn().mockResolvedValue('2026-10-05T08:00:00.000Z')
    setRendererRpcClient({ request, subscribe: vi.fn() })

    await expect(documentFlowApi.appStartedAt()).resolves.toBe('2026-10-05T08:00:00.000Z')

    expect(request.mock.calls).toEqual([['documentFlow.appStartedAt', {}]])
  })

  it('rejects when the server cannot be asked, for the caller to take as "not known"', async () => {
    const request = vi.fn().mockRejectedValue(new Error('The server is not connected.'))
    setRendererRpcClient({ request, subscribe: vi.fn() })

    await expect(documentFlowApi.appStartedAt()).rejects.toThrow('The server is not connected.')
  })
})

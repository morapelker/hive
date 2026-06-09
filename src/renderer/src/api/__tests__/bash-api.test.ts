import { afterEach, describe, expect, it, vi } from 'vitest'
import { BASH_STREAM_CHANNEL } from '@shared/bash-events'
import type { ServerEvent } from '@shared/rpc/protocol'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '../rpc-client'
import { bashApi } from '../bash-api'

describe('bashApi', () => {
  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  it('routes run through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue({ runId: 'run-1' })
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(bashApi.run('session-1', 'pnpm test', '/tmp/hive')).resolves.toEqual({
      success: true,
      value: { runId: 'run-1' }
    })
    expect(request).toHaveBeenCalledWith('bash.run', {
      sessionId: 'session-1',
      command: 'pnpm test',
      cwd: '/tmp/hive'
    })
  })

  it('routes abort through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(true)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(bashApi.abort('session-1')).resolves.toEqual({
      success: true,
      value: true
    })
    expect(request).toHaveBeenCalledWith('bash.abort', { sessionId: 'session-1' })
  })

  it('routes getRun through the renderer RPC client', async () => {
    const snapshot = {
      sessionId: 'session-1',
      id: 'run-1',
      command: 'pnpm test',
      cwd: '/tmp/hive',
      startedAt: 123,
      status: 'running' as const,
      outputBuffer: 'seeded output',
      outputBytes: 13
    }
    const request = vi.fn().mockResolvedValue(snapshot)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(bashApi.getRun('session-1')).resolves.toEqual(snapshot)
    expect(request).toHaveBeenCalledWith('bash.getRun', { sessionId: 'session-1' })
  })

  it('subscribes to stream events through the renderer RPC client', () => {
    const request = vi.fn()
    const unsubscribe = vi.fn()
    const subscribe = vi.fn(
      (_channel: string, _listener: (event: ServerEvent) => void): (() => void) => unsubscribe
    )
    const callback = vi.fn()
    const payload = {
      type: 'output',
      sessionId: 'session-1',
      runId: 'run-1',
      data: 'hello'
    } as const

    setRendererRpcClient({ request, subscribe })

    expect(bashApi.onStream(callback)).toBe(unsubscribe)
    expect(subscribe).toHaveBeenCalledWith(BASH_STREAM_CHANNEL, expect.any(Function))

    const listener = subscribe.mock.calls[0]?.[1]
    listener?.({ channel: BASH_STREAM_CHANNEL, payload })
    listener?.({ channel: BASH_STREAM_CHANNEL, payload: { type: 'output', data: 'ignored' } })

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith(payload)
  })
})

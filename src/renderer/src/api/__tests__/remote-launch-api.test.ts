import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '../rpc-client'
import { remoteLaunchApi, remoteTargetFromUrl } from '../remote-launch-api'
import type { ServerEvent } from '@shared/rpc/protocol'
import type { RemoteLaunchStartParams } from '@shared/types/remote-launch'

describe('remoteLaunchApi', () => {
  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  it('routes preflight through the renderer RPC client', async () => {
    const result = {
      remoteConfigured: true,
      branchOnOrigin: true,
      localAhead: 0,
      localBehind: 0,
      diverged: false,
      transfers: [],
      transferErrors: []
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(
      remoteLaunchApi.preflight({ projectId: 'project-1', branch: 'feature-1' })
    ).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('remoteLaunchOps.preflight', {
      projectId: 'project-1',
      branch: 'feature-1'
    })
  })

  it('routes start through the renderer RPC client', async () => {
    const params: RemoteLaunchStartParams = {
      launchId: 'launch-1',
      ticketId: 'ticket-1',
      projectId: 'project-1',
      branch: 'feature-1',
      prompt: 'do the thing',
      mode: 'build',
      model: { providerId: 'anthropic', id: 'claude-3', variant: null },
      ticketTitle: 'Ticket 1'
    }
    const result = { success: true, localSessionId: 'session-1', tmuxSession: 'hive-launch-1' }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(remoteLaunchApi.start(params)).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('remoteLaunchOps.start', params)
  })

  it('routes stop through the renderer RPC client', async () => {
    const result = { killed: true, alreadyDead: false }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(remoteLaunchApi.stop({ sessionId: 'session-1' })).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('remoteLaunchOps.stop', { sessionId: 'session-1' })
  })

  it('subscribes to progress events through the renderer RPC client and unwraps the payload', () => {
    const request = vi.fn()
    const unsubscribe = vi.fn()
    const subscribe = vi.fn(
      (_channel: string, _listener: (event: ServerEvent) => void): (() => void) => unsubscribe
    )
    const callback = vi.fn()

    setRendererRpcClient({ request, subscribe })

    expect(remoteLaunchApi.onProgress('launch-1', callback)).toBe(unsubscribe)
    expect(subscribe).toHaveBeenCalledWith(
      'remote-launch:progress:launch-1',
      expect.any(Function)
    )

    const listener = subscribe.mock.calls[0]?.[1]
    const payload = { step: 'clone', status: 'running' } as const
    listener?.({ channel: 'remote-launch:progress:launch-1', payload })
    // Malformed payloads (wrong step, missing status) must not reach the callback.
    listener?.({ channel: 'remote-launch:progress:launch-1', payload: { step: 'bogus', status: 'running' } })
    listener?.({ channel: 'remote-launch:progress:launch-1', payload: { step: 'clone' } })
    listener?.({ channel: 'remote-launch:progress:launch-1', payload: 'not-an-object' })

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith(payload)
  })
})

describe('remoteTargetFromUrl', () => {
  it('converts an http url into a ws base url with /ws appended', () => {
    const target = remoteTargetFromUrl('http://host:1234', 'token-1')

    expect(target).toEqual({
      httpBaseUrl: 'http://host:1234',
      wsBaseUrl: 'ws://host:1234/ws',
      bootstrapToken: 'token-1',
      source: 'desktop'
    })
  })

  it('converts an https url into a wss base url with /ws appended', () => {
    const target = remoteTargetFromUrl('https://host', 'token-2')

    expect(target.httpBaseUrl).toBe('https://host')
    expect(target.wsBaseUrl).toBe('wss://host/ws')
    expect(target.bootstrapToken).toBe('token-2')
  })

  it('strips a trailing slash from the http base url', () => {
    const target = remoteTargetFromUrl('https://host/', 'token-3')

    expect(target.httpBaseUrl).toBe('https://host')
    expect(target.wsBaseUrl).toBe('wss://host/ws')
  })

  it('preserves a subpath when deriving the ws base url', () => {
    const target = remoteTargetFromUrl('https://host/hive', 'token-4')

    expect(target.httpBaseUrl).toBe('https://host/hive')
    expect(target.wsBaseUrl).toBe('wss://host/hive/ws')
  })

  it('preserves a subpath and strips its trailing slash', () => {
    const target = remoteTargetFromUrl('https://host/hive/', 'token-5')

    expect(target.httpBaseUrl).toBe('https://host/hive')
    expect(target.wsBaseUrl).toBe('wss://host/hive/ws')
  })

  it('carries the bootstrap token through unchanged', () => {
    const target = remoteTargetFromUrl('http://host', 'super-secret-token')

    expect(target.bootstrapToken).toBe('super-secret-token')
  })
})

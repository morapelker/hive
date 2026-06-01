import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '../rpc-client'
import { scriptApi } from '../script-api'

describe('scriptApi', () => {
  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  it('routes getPort through the renderer RPC client', async () => {
    const result = { port: 5173 }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(scriptApi.getPort('/tmp/hive')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('scriptOps.getPort', {
      cwd: '/tmp/hive'
    })
  })

  it('routes runSetup through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(
      scriptApi.runSetup(['npm install', 'npm run setup'], '/tmp/hive', 'worktree-1')
    ).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('scriptOps.runSetup', {
      commands: ['npm install', 'npm run setup'],
      cwd: '/tmp/hive',
      worktreeId: 'worktree-1'
    })
  })

  it('routes runProject through the renderer RPC client', async () => {
    const result = { success: true, pid: 1234 }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(scriptApi.runProject(['pnpm dev'], '/tmp/hive', 'worktree-1')).resolves.toBe(
      result
    )
    expect(request).toHaveBeenCalledWith('scriptOps.runProject', {
      commands: ['pnpm dev'],
      cwd: '/tmp/hive',
      worktreeId: 'worktree-1'
    })
  })

  it('routes killPid through the renderer RPC client', async () => {
    const result = { killed: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(scriptApi.killPid(12345)).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('scriptOps.killPid', {
      pid: 12345
    })
  })

  it('routes kill through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(scriptApi.kill('worktree-1')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('scriptOps.kill', {
      worktreeId: 'worktree-1'
    })
  })

  it('routes output events through the renderer RPC client subscription', () => {
    const request = vi.fn()
    const unsubscribe = vi.fn()
    let listener: ((event: { channel: string; payload: unknown }) => void) | undefined
    const subscribe = vi.fn(
      (_channel: string, next: (event: { channel: string; payload: unknown }) => void) => {
        listener = next
        return unsubscribe
      }
    )

    setRendererRpcClient({ request, subscribe })

    const callback = vi.fn()
    const returned = scriptApi.onOutput('script:setup:worktree-1', callback)

    expect(returned).toBe(unsubscribe)
    expect(subscribe).toHaveBeenCalledWith('script:setup:worktree-1', expect.any(Function))

    listener?.({
      channel: 'script:setup:worktree-1',
      payload: { type: 'command-start', command: 'npm install' }
    })
    listener?.({
      channel: 'script:setup:worktree-1',
      payload: { type: 'output', data: 42 }
    })

    expect(callback).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith({ type: 'command-start', command: 'npm install' })
  })
})

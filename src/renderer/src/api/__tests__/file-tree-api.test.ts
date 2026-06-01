import { afterEach, describe, expect, it, vi } from 'vitest'
import { FILE_TREE_CHANGE_CHANNEL } from '@shared/file-tree-events'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '../rpc-client'
import { fileTreeApi } from '../file-tree-api'

describe('fileTreeApi', () => {
  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  it('routes scan through the renderer RPC client', async () => {
    const result = {
      success: true,
      tree: [
        {
          name: 'src',
          path: '/tmp/hive/src',
          relativePath: 'src',
          isDirectory: true,
          extension: null,
          children: []
        }
      ]
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(fileTreeApi.scan('/tmp/hive')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('fileTreeOps.scan', { dirPath: '/tmp/hive' })
  })

  it('routes scanFlat through the renderer RPC client', async () => {
    const result = {
      success: true,
      files: [
        {
          name: 'App.tsx',
          path: '/tmp/hive/src/App.tsx',
          relativePath: 'src/App.tsx',
          extension: '.tsx'
        }
      ]
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(fileTreeApi.scanFlat('/tmp/hive')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('fileTreeOps.scanFlat', { dirPath: '/tmp/hive' })
  })

  it('routes loadChildren through the renderer RPC client', async () => {
    const result = {
      success: true,
      children: [
        {
          name: 'App.tsx',
          path: '/tmp/hive/src/App.tsx',
          relativePath: 'src/App.tsx',
          isDirectory: false,
          extension: '.tsx'
        }
      ]
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(fileTreeApi.loadChildren('/tmp/hive/src', '/tmp/hive')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('fileTreeOps.loadChildren', {
      dirPath: '/tmp/hive/src',
      rootPath: '/tmp/hive'
    })
  })

  it('routes watch through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(fileTreeApi.watch('/tmp/hive')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('fileTreeOps.watch', { worktreePath: '/tmp/hive' })
  })

  it('routes unwatch through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(fileTreeApi.unwatch('/tmp/hive')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('fileTreeOps.unwatch', { worktreePath: '/tmp/hive' })
  })

  it('routes change events through the renderer RPC client subscription', () => {
    const request = vi.fn()
    const unsubscribe = vi.fn()
    const subscribe = vi.fn().mockReturnValue(unsubscribe)
    const callback = vi.fn()
    const event = {
      worktreePath: '/tmp/hive',
      events: [
        {
          eventType: 'change',
          changedPath: '/tmp/hive/src/App.tsx',
          relativePath: 'src/App.tsx'
        }
      ]
    }

    setRendererRpcClient({ request, subscribe })

    expect(fileTreeApi.onChange(callback)).toBe(unsubscribe)
    expect(subscribe).toHaveBeenCalledWith(FILE_TREE_CHANGE_CHANNEL, expect.any(Function))

    const handler = subscribe.mock.calls[0]?.[1]
    handler?.({ channel: FILE_TREE_CHANGE_CHANNEL, payload: event })
    handler?.({ channel: FILE_TREE_CHANGE_CHANNEL, payload: { worktreePath: '/tmp/hive' } })

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith(event)
  })
})

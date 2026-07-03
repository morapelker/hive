import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '../rpc-client'
import { fileApi, resetFileOpsAdapterForTests, setFileOpsAdapterForTests } from '../file-api'

describe('fileApi', () => {
  const originalDesktopBridgeDescriptor = Object.getOwnPropertyDescriptor(window, 'desktopBridge')

  afterEach(() => {
    resetFileOpsAdapterForTests()
    resetRendererRpcClientForTests()
    if (originalDesktopBridgeDescriptor) {
      Object.defineProperty(window, 'desktopBridge', originalDesktopBridgeDescriptor)
    } else {
      Reflect.deleteProperty(window, 'desktopBridge')
    }
  })

  it('routes getPathForFile through the file ops adapter', () => {
    const file = { name: 'README.md' } as File
    const getPathForFile = vi.fn().mockReturnValue('/tmp/hive/README.md')

    setFileOpsAdapterForTests({ getPathForFile })

    expect(fileApi.getPathForFile(file)).toBe('/tmp/hive/README.md')
    expect(getPathForFile).toHaveBeenCalledWith(file)
  })

  it('routes getPathForFile through desktopBridge by default', () => {
    const file = { name: 'README.md' } as File
    const getPathForFile = vi.fn().mockReturnValue('/tmp/hive/README.md')

    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: { getPathForFile }
    })

    expect(fileApi.getPathForFile(file)).toBe('/tmp/hive/README.md')
    expect(getPathForFile).toHaveBeenCalledWith(file)
  })

  it('routes readImageAsBase64 through the renderer RPC client', async () => {
    const result = { data: 'iVBORw0KGgo=', mimeType: 'image/png' }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(fileApi.readImageAsBase64('/tmp/hive/icon.png')).resolves.toEqual({
      success: true,
      value: result
    })
    expect(request).toHaveBeenCalledWith('fileOps.readImageAsBase64', {
      filePath: '/tmp/hive/icon.png'
    })
  })

  it('routes readFile through the renderer RPC client', async () => {
    const result = { success: true, content: '# Hive' }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(fileApi.readFile('/tmp/hive/README.md')).resolves.toEqual({
      success: true,
      value: result
    })
    expect(request).toHaveBeenCalledWith('fileOps.readFile', {
      filePath: '/tmp/hive/README.md'
    })
  })

  it('routes writeFile through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(null)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(fileApi.writeFile('/tmp/hive/README.md', '# Hive')).resolves.toEqual({
      success: true,
      value: null
    })
    expect(request).toHaveBeenCalledWith('fileOps.writeFile', {
      filePath: '/tmp/hive/README.md',
      content: '# Hive'
    })
  })

  it('routes createFile through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(null)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(
      fileApi.createFile('/tmp/hive', 'PLAN_feature.md', '# Plan', false)
    ).resolves.toEqual({
      success: true,
      value: null
    })
    expect(request).toHaveBeenCalledWith('fileOps.createFile', {
      directoryPath: '/tmp/hive',
      fileName: 'PLAN_feature.md',
      content: '# Plan',
      overwrite: false
    })
  })

  it('surfaces the RPC error code when createFile rejects', async () => {
    const error = new Error('File already exists')
    error.name = 'FileAlreadyExists'
    const request = vi.fn().mockRejectedValue(error)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(
      fileApi.createFile('/tmp/hive', 'PLAN_feature.md', '# Plan', false)
    ).resolves.toEqual({
      success: false,
      errorCode: 'FileAlreadyExists',
      error: 'File already exists'
    })
  })
})

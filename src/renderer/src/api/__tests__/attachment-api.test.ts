import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '../rpc-client'
import { attachmentApi } from '../attachment-api'

describe('attachmentApi', () => {
  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  it('routes saveImage through the renderer RPC client', async () => {
    const result = { success: true, filePath: '/tmp/hive/.hive/attachments/image.png' }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(
      attachmentApi.saveImage(new TextEncoder().encode('hello').buffer, 'image.png')
    ).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('attachmentOps.saveImage', {
      dataBase64: 'aGVsbG8=',
      originalName: 'image.png'
    })
  })

  it('routes deleteImage through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(attachmentApi.deleteImage('/tmp/hive/.hive/attachments/image.png')).resolves.toBe(
      result
    )
    expect(request).toHaveBeenCalledWith('attachmentOps.deleteImage', {
      filePath: '/tmp/hive/.hive/attachments/image.png'
    })
  })
})

import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { makeEventBus } from '../events/event-bus'
import type { AttachmentOpsRpcService } from '../rpc/domains/attachment-ops'
import { makeRpcRouter } from '../rpc/router'

describe('attachment ops RPC mocked provider', () => {
  it('routes attachmentOps.saveImage to the injected provider service', async () => {
    const result = { success: true, filePath: '/tmp/hive/attachments/image.png' }
    const saveImage = vi.fn(() => Effect.succeed(result))
    const service = { saveImage } as unknown as AttachmentOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      attachmentOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'attachment-save-image-1',
        method: 'attachmentOps.saveImage',
        params: {
          dataBase64: 'aGVsbG8=',
          originalName: 'image.png'
        }
      })
    )

    expect(saveImage).toHaveBeenCalledWith('aGVsbG8=', 'image.png')
    expect(response).toEqual({
      id: 'attachment-save-image-1',
      ok: true,
      value: result
    })
  })

  it('validates attachmentOps.saveImage params before calling the provider service', async () => {
    const saveImage = vi.fn(() => Effect.succeed({ success: true, filePath: '/unused.png' }))
    const service = { saveImage } as unknown as AttachmentOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      attachmentOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'attachment-save-image-invalid',
        method: 'attachmentOps.saveImage',
        params: {
          dataBase64: '',
          originalName: 'image.png'
        }
      })
    )

    expect(saveImage).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'attachment-save-image-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes attachmentOps.deleteImage to the injected provider service', async () => {
    const result = { success: true }
    const deleteImage = vi.fn(() => Effect.succeed(result))
    const service = { deleteImage } as unknown as AttachmentOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      attachmentOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'attachment-delete-image-1',
        method: 'attachmentOps.deleteImage',
        params: {
          filePath: '/tmp/hive/.hive/attachments/image.png'
        }
      })
    )

    expect(deleteImage).toHaveBeenCalledWith('/tmp/hive/.hive/attachments/image.png')
    expect(response).toEqual({
      id: 'attachment-delete-image-1',
      ok: true,
      value: result
    })
  })

  it('validates attachmentOps.deleteImage params before calling the provider service', async () => {
    const deleteImage = vi.fn(() => Effect.succeed({ success: false, error: 'unused' }))
    const service = { deleteImage } as unknown as AttachmentOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      attachmentOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'attachment-delete-image-invalid',
        method: 'attachmentOps.deleteImage',
        params: {
          filePath: ''
        }
      })
    )

    expect(deleteImage).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'attachment-delete-image-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })
})

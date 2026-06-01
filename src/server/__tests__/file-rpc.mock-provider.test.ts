import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { makeEventBus } from '../events/event-bus'
import type { FileOpsRpcService } from '../rpc/domains/file-ops'
import { makeRpcRouter } from '../rpc/router'

describe('file ops RPC mocked provider', () => {
  it('routes fileOps.readFile to the injected provider service', async () => {
    const result = { success: true, content: 'hello from file' }
    const readFile = vi.fn(() => Effect.succeed(result))
    const service = { readFile } as unknown as FileOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      fileOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'file-read-file-1',
        method: 'fileOps.readFile',
        params: { filePath: '/tmp/hive/README.md' }
      })
    )

    expect(readFile).toHaveBeenCalledWith('/tmp/hive/README.md')
    expect(response).toEqual({
      id: 'file-read-file-1',
      ok: true,
      value: result
    })
  })

  it('validates fileOps.readFile params before calling the provider service', async () => {
    const readFile = vi.fn(() => Effect.succeed({ success: true, content: 'unused' }))
    const service = { readFile } as unknown as FileOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      fileOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'file-read-file-invalid',
        method: 'fileOps.readFile',
        params: { filePath: '' }
      })
    )

    expect(readFile).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'file-read-file-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes fileOps.writeFile to the injected provider service', async () => {
    const writeFile = vi.fn(() => Effect.succeed(null))
    const service = { writeFile } as unknown as FileOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      fileOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'file-write-file-1',
        method: 'fileOps.writeFile',
        params: {
          filePath: '/tmp/hive/README.md',
          content: 'hello from http'
        }
      })
    )

    expect(writeFile).toHaveBeenCalledWith('/tmp/hive/README.md', 'hello from http')
    expect(response).toEqual({
      id: 'file-write-file-1',
      ok: true,
      value: null
    })
  })

  it('validates fileOps.writeFile params before calling the provider service', async () => {
    const writeFile = vi.fn(() => Effect.succeed(null))
    const service = { writeFile } as unknown as FileOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      fileOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'file-write-file-invalid',
        method: 'fileOps.writeFile',
        params: {
          filePath: '/tmp/hive/README.md',
          content: 42
        }
      })
    )

    expect(writeFile).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'file-write-file-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes fileOps.readImageAsBase64 to the injected provider service', async () => {
    const result = { data: 'aGVsbG8=', mimeType: 'image/png' }
    const readImageAsBase64 = vi.fn(() => Effect.succeed(result))
    const service = { readImageAsBase64 } as unknown as FileOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      fileOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'file-read-image-as-base64-1',
        method: 'fileOps.readImageAsBase64',
        params: { filePath: '/tmp/hive/icon.png' }
      })
    )

    expect(readImageAsBase64).toHaveBeenCalledWith('/tmp/hive/icon.png')
    expect(response).toEqual({
      id: 'file-read-image-as-base64-1',
      ok: true,
      value: result
    })
  })

  it('validates fileOps.readImageAsBase64 params before calling the provider service', async () => {
    const readImageAsBase64 = vi.fn(() => Effect.succeed({ data: 'unused' }))
    const service = { readImageAsBase64 } as unknown as FileOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      fileOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'file-read-image-as-base64-invalid',
        method: 'fileOps.readImageAsBase64',
        params: { filePath: '' }
      })
    )

    expect(readImageAsBase64).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'file-read-image-as-base64-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })
})

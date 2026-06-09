import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { makeEventBus } from '../events/event-bus'
import type { FileTreeOpsRpcService } from '../rpc/domains/file-tree-ops'
import { makeRpcRouter } from '../rpc/router'

describe('file tree ops RPC mocked provider', () => {
  it('routes fileTreeOps.scan to the injected provider service', async () => {
    const tree = [
      {
        name: 'src',
        path: '/repo/src',
        relativePath: 'src',
        isDirectory: true,
        extension: null,
        children: []
      }
    ]
    const scan = vi.fn(() => Effect.succeed({ success: true, tree }))
    const service = { scan } as unknown as FileTreeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      fileTreeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'file-tree-scan-1',
        method: 'fileTreeOps.scan',
        params: { dirPath: '/repo' }
      })
    )

    expect(scan).toHaveBeenCalledWith('/repo')
    expect(response).toEqual({
      id: 'file-tree-scan-1',
      ok: true,
      value: { success: true, tree }
    })
  })

  it('validates fileTreeOps.scan params before calling the provider service', async () => {
    const scan = vi.fn(() => Effect.succeed({ success: true, tree: [] }))
    const service = { scan } as unknown as FileTreeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      fileTreeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'file-tree-scan-invalid',
        method: 'fileTreeOps.scan',
        params: { dirPath: '' }
      })
    )

    expect(scan).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'file-tree-scan-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes fileTreeOps.scanFlat to the injected provider service', async () => {
    const files = [
      {
        name: 'App.tsx',
        path: '/repo/src/App.tsx',
        relativePath: 'src/App.tsx',
        extension: '.tsx'
      }
    ]
    const scanFlat = vi.fn(() => Effect.succeed({ success: true, files }))
    const service = { scanFlat } as unknown as FileTreeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      fileTreeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'file-tree-scan-flat-1',
        method: 'fileTreeOps.scanFlat',
        params: { dirPath: '/repo' }
      })
    )

    expect(scanFlat).toHaveBeenCalledWith('/repo')
    expect(response).toEqual({
      id: 'file-tree-scan-flat-1',
      ok: true,
      value: { success: true, files }
    })
  })

  it('validates fileTreeOps.scanFlat params before calling the provider service', async () => {
    const scanFlat = vi.fn(() => Effect.succeed({ success: true, files: [] }))
    const service = { scanFlat } as unknown as FileTreeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      fileTreeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'file-tree-scan-flat-invalid',
        method: 'fileTreeOps.scanFlat',
        params: { dirPath: '' }
      })
    )

    expect(scanFlat).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'file-tree-scan-flat-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes fileTreeOps.loadChildren to the injected provider service', async () => {
    const children = [
      {
        name: 'App.tsx',
        path: '/repo/src/App.tsx',
        relativePath: 'src/App.tsx',
        isDirectory: false,
        extension: '.tsx'
      }
    ]
    const loadChildren = vi.fn(() => Effect.succeed({ success: true, children }))
    const service = { loadChildren } as unknown as FileTreeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      fileTreeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'file-tree-load-children-1',
        method: 'fileTreeOps.loadChildren',
        params: { dirPath: '/repo/src', rootPath: '/repo' }
      })
    )

    expect(loadChildren).toHaveBeenCalledWith('/repo/src', '/repo')
    expect(response).toEqual({
      id: 'file-tree-load-children-1',
      ok: true,
      value: { success: true, children }
    })
  })

  it('validates fileTreeOps.loadChildren params before calling the provider service', async () => {
    const loadChildren = vi.fn(() => Effect.succeed({ success: true, children: [] }))
    const service = { loadChildren } as unknown as FileTreeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      fileTreeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'file-tree-load-children-invalid',
        method: 'fileTreeOps.loadChildren',
        params: { dirPath: '/repo/src', rootPath: '' }
      })
    )

    expect(loadChildren).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'file-tree-load-children-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes fileTreeOps.watch to the injected provider service', async () => {
    const result = { success: true }
    const watch = vi.fn(() => Effect.succeed(result))
    const service = { watch } as unknown as FileTreeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      fileTreeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'file-tree-watch-1',
        method: 'fileTreeOps.watch',
        params: { worktreePath: '/repo' }
      })
    )

    expect(watch).toHaveBeenCalledWith('/repo')
    expect(response).toEqual({
      id: 'file-tree-watch-1',
      ok: true,
      value: result
    })
  })

  it('validates fileTreeOps.watch params before calling the provider service', async () => {
    const watch = vi.fn(() => Effect.succeed({ success: true }))
    const service = { watch } as unknown as FileTreeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      fileTreeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'file-tree-watch-invalid',
        method: 'fileTreeOps.watch',
        params: { worktreePath: '' }
      })
    )

    expect(watch).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'file-tree-watch-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes fileTreeOps.unwatch to the injected provider service', async () => {
    const result = { success: true }
    const unwatch = vi.fn(() => Effect.succeed(result))
    const service = { unwatch } as unknown as FileTreeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      fileTreeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'file-tree-unwatch-1',
        method: 'fileTreeOps.unwatch',
        params: { worktreePath: '/repo' }
      })
    )

    expect(unwatch).toHaveBeenCalledWith('/repo')
    expect(response).toEqual({
      id: 'file-tree-unwatch-1',
      ok: true,
      value: result
    })
  })

  it('validates fileTreeOps.unwatch params before calling the provider service', async () => {
    const unwatch = vi.fn(() => Effect.succeed({ success: true }))
    const service = { unwatch } as unknown as FileTreeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      fileTreeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'file-tree-unwatch-invalid',
        method: 'fileTreeOps.unwatch',
        params: { worktreePath: '' }
      })
    )

    expect(unwatch).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'file-tree-unwatch-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })
})

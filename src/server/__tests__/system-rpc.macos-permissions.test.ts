import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { makeEventBus } from '../events/event-bus'
import type { SystemOpsRpcService } from '../rpc/domains/system-ops'
import { makeRpcRouter } from '../rpc/router'

describe('system ops RPC — macOS permissions', () => {
  it('routes systemOps.getMacosPermissions to the provider service', async () => {
    const getMacosPermissions = vi.fn(() =>
      Effect.succeed({ supported: true, fullDiskAccess: false })
    )
    const service = { getMacosPermissions } as unknown as SystemOpsRpcService
    const router = makeRpcRouter({ eventBus: makeEventBus(), systemOps: service })

    const response = await Effect.runPromise(
      router.handle({
        id: 'macos-permissions-1',
        method: 'systemOps.getMacosPermissions',
        params: {}
      })
    )

    expect(getMacosPermissions).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'macos-permissions-1',
      ok: true,
      value: { supported: true, fullDiskAccess: false }
    })
  })

  it('routes systemOps.openMacosPrivacySettings with the requested pane', async () => {
    const openMacosPrivacySettings = vi.fn(() => Effect.succeed({ success: true }))
    const service = { openMacosPrivacySettings } as unknown as SystemOpsRpcService
    const router = makeRpcRouter({ eventBus: makeEventBus(), systemOps: service })

    const response = await Effect.runPromise(
      router.handle({
        id: 'macos-permissions-open-1',
        method: 'systemOps.openMacosPrivacySettings',
        params: { pane: 'filesAndFolders' }
      })
    )

    expect(openMacosPrivacySettings).toHaveBeenCalledWith('filesAndFolders')
    expect(response).toEqual({
      id: 'macos-permissions-open-1',
      ok: true,
      value: { success: true }
    })
  })

  it('rejects a pane the app does not know before calling the provider service', async () => {
    const openMacosPrivacySettings = vi.fn(() => Effect.succeed({ success: true }))
    const service = { openMacosPrivacySettings } as unknown as SystemOpsRpcService
    const router = makeRpcRouter({ eventBus: makeEventBus(), systemOps: service })

    const response = await Effect.runPromise(
      router.handle({
        id: 'macos-permissions-open-invalid',
        method: 'systemOps.openMacosPrivacySettings',
        params: { pane: 'camera' }
      })
    )

    expect(openMacosPrivacySettings).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'macos-permissions-open-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })
})

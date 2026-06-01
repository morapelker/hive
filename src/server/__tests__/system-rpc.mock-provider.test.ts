import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { makeEventBus } from '../events/event-bus'
import type { SystemOpsRpcService } from '../rpc/domains/system-ops'
import { makeRpcRouter } from '../rpc/router'

describe('system ops RPC mocked provider', () => {
  it('routes systemOps.getLogDir to the injected provider service', async () => {
    const getLogDir = vi.fn(() => Effect.succeed('/tmp/hive-logs'))
    const service = { getLogDir } as unknown as SystemOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      systemOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'system-get-log-dir-1',
        method: 'systemOps.getLogDir',
        params: {}
      })
    )

    expect(getLogDir).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'system-get-log-dir-1',
      ok: true,
      value: '/tmp/hive-logs'
    })
  })

  it('validates systemOps.getLogDir params before calling the provider service', async () => {
    const getLogDir = vi.fn(() => Effect.succeed('/unused'))
    const service = { getLogDir } as unknown as SystemOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      systemOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'system-get-log-dir-invalid',
        method: 'systemOps.getLogDir',
        params: { extra: true }
      })
    )

    expect(getLogDir).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'system-get-log-dir-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes systemOps.getAppVersion to the injected provider service', async () => {
    const getAppVersion = vi.fn(() => Effect.succeed('1.2.3-test'))
    const service = { getAppVersion } as unknown as SystemOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      systemOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'system-get-app-version-1',
        method: 'systemOps.getAppVersion',
        params: {}
      })
    )

    expect(getAppVersion).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'system-get-app-version-1',
      ok: true,
      value: '1.2.3-test'
    })
  })

  it('validates systemOps.getAppVersion params before calling the provider service', async () => {
    const getAppVersion = vi.fn(() => Effect.succeed('0.0.0-unused'))
    const service = { getAppVersion } as unknown as SystemOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      systemOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'system-get-app-version-invalid',
        method: 'systemOps.getAppVersion',
        params: { includeBuild: true }
      })
    )

    expect(getAppVersion).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'system-get-app-version-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes systemOps.getAppPaths to the injected provider service', async () => {
    const appPaths = {
      userData: '/tmp/hive-user-data',
      home: '/home/tester',
      logs: '/tmp/hive-logs'
    }
    const getAppPaths = vi.fn(() => Effect.succeed(appPaths))
    const service = { getAppPaths } as unknown as SystemOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      systemOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'system-get-app-paths-1',
        method: 'systemOps.getAppPaths',
        params: {}
      })
    )

    expect(getAppPaths).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'system-get-app-paths-1',
      ok: true,
      value: appPaths
    })
  })

  it('validates systemOps.getAppPaths params before calling the provider service', async () => {
    const getAppPaths = vi.fn(() =>
      Effect.succeed({
        userData: '/unused/user-data',
        home: '/unused/home',
        logs: '/unused/logs'
      })
    )
    const service = { getAppPaths } as unknown as SystemOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      systemOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'system-get-app-paths-invalid',
        method: 'systemOps.getAppPaths',
        params: { includeTemp: true }
      })
    )

    expect(getAppPaths).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'system-get-app-paths-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes systemOps.isLogMode to the injected provider service', async () => {
    const isLogMode = vi.fn(() => Effect.succeed(true))
    const service = { isLogMode } as unknown as SystemOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      systemOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'system-is-log-mode-1',
        method: 'systemOps.isLogMode',
        params: {}
      })
    )

    expect(isLogMode).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'system-is-log-mode-1',
      ok: true,
      value: true
    })
  })

  it('validates systemOps.isLogMode params before calling the provider service', async () => {
    const isLogMode = vi.fn(() => Effect.succeed(false))
    const service = { isLogMode } as unknown as SystemOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      systemOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'system-is-log-mode-invalid',
        method: 'systemOps.isLogMode',
        params: { argv: ['--log'] }
      })
    )

    expect(isLogMode).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'system-is-log-mode-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes systemOps.detectAgentSdks to the injected provider service', async () => {
    const detected = {
      opencode: true,
      claude: false,
      codex: true
    }
    const detectAgentSdks = vi.fn(() => Effect.succeed(detected))
    const service = { detectAgentSdks } as unknown as SystemOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      systemOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'system-detect-agent-sdks-1',
        method: 'systemOps.detectAgentSdks',
        params: {}
      })
    )

    expect(detectAgentSdks).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'system-detect-agent-sdks-1',
      ok: true,
      value: detected
    })
  })

  it('validates systemOps.detectAgentSdks params before calling the provider service', async () => {
    const detectAgentSdks = vi.fn(() =>
      Effect.succeed({
        opencode: false,
        claude: false,
        codex: false
      })
    )
    const service = { detectAgentSdks } as unknown as SystemOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      systemOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'system-detect-agent-sdks-invalid',
        method: 'systemOps.detectAgentSdks',
        params: { refresh: true }
      })
    )

    expect(detectAgentSdks).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'system-detect-agent-sdks-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes systemOps.quitApp to the injected provider service', async () => {
    const quitApp = vi.fn(() => Effect.succeed(undefined))
    const service = { quitApp } as unknown as SystemOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      systemOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'system-quit-app-1',
        method: 'systemOps.quitApp',
        params: {}
      })
    )

    expect(quitApp).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'system-quit-app-1',
      ok: true,
      value: undefined
    })
  })

  it('validates systemOps.quitApp params before calling the provider service', async () => {
    const quitApp = vi.fn(() => Effect.succeed(undefined))
    const service = { quitApp } as unknown as SystemOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      systemOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'system-quit-app-invalid',
        method: 'systemOps.quitApp',
        params: { force: true }
      })
    )

    expect(quitApp).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'system-quit-app-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes systemOps.openInApp to the injected provider service', async () => {
    const result = { success: true }
    const openInApp = vi.fn(() => Effect.succeed(result))
    const service = { openInApp } as unknown as SystemOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      systemOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'system-open-in-app-1',
        method: 'systemOps.openInApp',
        params: {
          appName: 'cursor',
          path: '/tmp/hive'
        }
      })
    )

    expect(openInApp).toHaveBeenCalledWith('cursor', '/tmp/hive')
    expect(response).toEqual({
      id: 'system-open-in-app-1',
      ok: true,
      value: result
    })
  })

  it('validates systemOps.openInApp params before calling the provider service', async () => {
    const openInApp = vi.fn(() => Effect.succeed({ success: false, error: 'unused' }))
    const service = { openInApp } as unknown as SystemOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      systemOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'system-open-in-app-invalid',
        method: 'systemOps.openInApp',
        params: {
          appName: '',
          path: '/tmp/hive'
        }
      })
    )

    expect(openInApp).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'system-open-in-app-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes systemOps.openInChrome to the injected provider service', async () => {
    const result = { success: true }
    const openInChrome = vi.fn(() => Effect.succeed(result))
    const service = { openInChrome } as unknown as SystemOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      systemOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'system-open-in-chrome-1',
        method: 'systemOps.openInChrome',
        params: {
          url: 'https://example.com/pr/1',
          customCommand: 'google-chrome {url}'
        }
      })
    )

    expect(openInChrome).toHaveBeenCalledWith(
      'https://example.com/pr/1',
      'google-chrome {url}'
    )
    expect(response).toEqual({
      id: 'system-open-in-chrome-1',
      ok: true,
      value: result
    })
  })

  it('validates systemOps.openInChrome params before calling the provider service', async () => {
    const openInChrome = vi.fn(() => Effect.succeed({ success: false, error: 'unused' }))
    const service = { openInChrome } as unknown as SystemOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      systemOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'system-open-in-chrome-invalid',
        method: 'systemOps.openInChrome',
        params: {
          url: '',
          customCommand: 'google-chrome {url}'
        }
      })
    )

    expect(openInChrome).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'system-open-in-chrome-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes systemOps.updateMenuState to the injected provider service', async () => {
    const state = {
      hasActiveSession: true,
      hasActiveWorktree: false,
      canUndo: true,
      canRedo: false
    }
    const updateMenuState = vi.fn(() => Effect.succeed(undefined))
    const service = { updateMenuState } as unknown as SystemOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      systemOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'system-update-menu-state-1',
        method: 'systemOps.updateMenuState',
        params: state
      })
    )

    expect(updateMenuState).toHaveBeenCalledWith(state)
    expect(response).toEqual({
      id: 'system-update-menu-state-1',
      ok: true,
      value: undefined
    })
  })

  it('validates systemOps.updateMenuState params before calling the provider service', async () => {
    const updateMenuState = vi.fn(() => Effect.succeed(undefined))
    const service = { updateMenuState } as unknown as SystemOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      systemOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'system-update-menu-state-invalid',
        method: 'systemOps.updateMenuState',
        params: {
          hasActiveSession: true,
          hasActiveWorktree: 'no'
        }
      })
    )

    expect(updateMenuState).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'system-update-menu-state-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes systemOps.isPackaged to the injected provider service', async () => {
    const isPackaged = vi.fn(() => Effect.succeed(true))
    const service = { isPackaged } as unknown as SystemOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      systemOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'system-is-packaged-1',
        method: 'systemOps.isPackaged',
        params: {}
      })
    )

    expect(isPackaged).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'system-is-packaged-1',
      ok: true,
      value: true
    })
  })

  it('validates systemOps.isPackaged params before calling the provider service', async () => {
    const isPackaged = vi.fn(() => Effect.succeed(false))
    const service = { isPackaged } as unknown as SystemOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      systemOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'system-is-packaged-invalid',
        method: 'systemOps.isPackaged',
        params: { probe: true }
      })
    )

    expect(isPackaged).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'system-is-packaged-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes systemOps.getPlatform to the injected provider service', async () => {
    const getPlatform = vi.fn(() => Effect.succeed('darwin' as NodeJS.Platform))
    const service = { getPlatform } as unknown as SystemOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      systemOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'system-get-platform-1',
        method: 'systemOps.getPlatform',
        params: {}
      })
    )

    expect(getPlatform).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'system-get-platform-1',
      ok: true,
      value: 'darwin'
    })
  })

  it('validates systemOps.getPlatform params before calling the provider service', async () => {
    const getPlatform = vi.fn(() => Effect.succeed('linux' as NodeJS.Platform))
    const service = { getPlatform } as unknown as SystemOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      systemOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'system-get-platform-invalid',
        method: 'systemOps.getPlatform',
        params: { normalize: true }
      })
    )

    expect(getPlatform).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'system-get-platform-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes systemOps.setKeepAwake to the injected provider service', async () => {
    const setKeepAwake = vi.fn(() => Effect.succeed(undefined))
    const service = { setKeepAwake } as unknown as SystemOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      systemOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'system-set-keep-awake-1',
        method: 'systemOps.setKeepAwake',
        params: { active: true }
      })
    )

    expect(setKeepAwake).toHaveBeenCalledWith(true)
    expect(response).toEqual({
      id: 'system-set-keep-awake-1',
      ok: true,
      value: undefined
    })
  })

  it('validates systemOps.setKeepAwake params before calling the provider service', async () => {
    const setKeepAwake = vi.fn(() => Effect.succeed(undefined))
    const service = { setKeepAwake } as unknown as SystemOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      systemOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'system-set-keep-awake-invalid',
        method: 'systemOps.setKeepAwake',
        params: { active: 'yes' }
      })
    )

    expect(setKeepAwake).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'system-set-keep-awake-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes systemOps.setSessionQueuedState to the injected provider service', async () => {
    const setSessionQueuedState = vi.fn(() => Effect.succeed(undefined))
    const service = { setSessionQueuedState } as unknown as SystemOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      systemOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'system-set-session-queued-state-1',
        method: 'systemOps.setSessionQueuedState',
        params: {
          sessionId: 'session-1',
          hasQueued: true
        }
      })
    )

    expect(setSessionQueuedState).toHaveBeenCalledWith('session-1', true)
    expect(response).toEqual({
      id: 'system-set-session-queued-state-1',
      ok: true,
      value: undefined
    })
  })

  it('validates systemOps.setSessionQueuedState params before calling the provider service', async () => {
    const setSessionQueuedState = vi.fn(() => Effect.succeed(undefined))
    const service = { setSessionQueuedState } as unknown as SystemOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      systemOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'system-set-session-queued-state-invalid',
        method: 'systemOps.setSessionQueuedState',
        params: {
          sessionId: '',
          hasQueued: true
        }
      })
    )

    expect(setSessionQueuedState).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'system-set-session-queued-state-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })
})

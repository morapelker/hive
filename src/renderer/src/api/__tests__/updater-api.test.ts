import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  UPDATER_AVAILABLE_CHANNEL,
  UPDATER_CHECKING_CHANNEL,
  UPDATER_DOWNLOADED_CHANNEL,
  UPDATER_ERROR_CHANNEL,
  UPDATER_NOT_AVAILABLE_CHANNEL,
  UPDATER_PROGRESS_CHANNEL
} from '@shared/updater-events'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '../rpc-client'
import { updaterApi } from '../updater-api'

describe('updaterApi', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'desktopBridge')
    resetRendererRpcClientForTests()
  })

  it('routes getVersion through the renderer RPC client', async () => {
    const getUpdaterVersion = vi.fn().mockResolvedValue('stale-bridge-version')
    const request = vi.fn().mockResolvedValue('1.2.3')
    const subscribe = vi.fn()

    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: {
        getLocalEnvironmentBootstrap: vi.fn(),
        getUpdaterVersion
      }
    })
    setRendererRpcClient({ request, subscribe })

    await expect(updaterApi.getVersion()).resolves.toBe('1.2.3')
    expect(request).toHaveBeenCalledWith('updaterOps.getVersion', {})
    expect(getUpdaterVersion).not.toHaveBeenCalled()
  })

  it('routes checkForUpdate through the renderer RPC client', async () => {
    const checkForUpdate = vi.fn().mockResolvedValue(undefined)
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: {
        getLocalEnvironmentBootstrap: vi.fn(),
        checkForUpdate
      }
    })
    setRendererRpcClient({ request, subscribe })

    await expect(updaterApi.checkForUpdate({ manual: true })).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith('updaterOps.checkForUpdate', { manual: true })
    expect(checkForUpdate).not.toHaveBeenCalled()
  })

  it('routes setChannel through the renderer RPC client', async () => {
    const setUpdateChannel = vi.fn().mockResolvedValue(undefined)
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: {
        getLocalEnvironmentBootstrap: vi.fn(),
        setUpdateChannel
      }
    })
    setRendererRpcClient({ request, subscribe })

    await expect(updaterApi.setChannel('canary')).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith('updaterOps.setChannel', { channel: 'canary' })
    expect(setUpdateChannel).not.toHaveBeenCalled()
  })

  it('routes downloadUpdate through the renderer RPC client', async () => {
    const downloadUpdate = vi.fn().mockResolvedValue(undefined)
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: {
        getLocalEnvironmentBootstrap: vi.fn(),
        downloadUpdate
      }
    })
    setRendererRpcClient({ request, subscribe })

    await expect(updaterApi.downloadUpdate()).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith('updaterOps.downloadUpdate', {})
    expect(downloadUpdate).not.toHaveBeenCalled()
  })

  it('routes installUpdate through the renderer RPC client', async () => {
    const installUpdate = vi.fn().mockResolvedValue(undefined)
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: {
        getLocalEnvironmentBootstrap: vi.fn(),
        installUpdate
      }
    })
    setRendererRpcClient({ request, subscribe })

    await expect(updaterApi.installUpdate()).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith('updaterOps.installUpdate', {})
    expect(installUpdate).not.toHaveBeenCalled()
  })

  it('routes checking events through the renderer subscription client', () => {
    const request = vi.fn()
    const unsubscribe = vi.fn()
    const onUpdaterChecking = vi.fn((_listener: () => void) => unsubscribe)
    let listener: ((event: { channel: string; payload: unknown }) => void) | undefined
    const subscribe = vi.fn(
      (_channel: string, next: (event: { channel: string; payload: unknown }) => void) => {
        listener = next
        return unsubscribe
      }
    )

    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: {
        getLocalEnvironmentBootstrap: vi.fn(),
        onUpdaterChecking
      }
    })
    setRendererRpcClient({ request, subscribe })

    const callback = vi.fn()
    const returned = updaterApi.onChecking(callback)

    expect(returned).toBe(unsubscribe)
    expect(subscribe).toHaveBeenCalledWith(UPDATER_CHECKING_CHANNEL, expect.any(Function))
    expect(onUpdaterChecking).not.toHaveBeenCalled()

    listener?.({ channel: UPDATER_CHECKING_CHANNEL, payload: {} })

    expect(callback).toHaveBeenCalledOnce()
  })

  it('routes update-available events through the renderer subscription client', () => {
    const request = vi.fn()
    const unsubscribe = vi.fn()
    const onUpdaterAvailable = vi.fn(
      (_listener: (data: { version: string }) => void) => unsubscribe
    )
    let listener: ((event: { channel: string; payload: unknown }) => void) | undefined
    const subscribe = vi.fn(
      (_channel: string, next: (event: { channel: string; payload: unknown }) => void) => {
        listener = next
        return unsubscribe
      }
    )

    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: {
        getLocalEnvironmentBootstrap: vi.fn(),
        onUpdaterAvailable
      }
    })
    setRendererRpcClient({ request, subscribe })

    const callback = vi.fn()
    const returned = updaterApi.onUpdateAvailable(callback)

    expect(returned).toBe(unsubscribe)
    expect(subscribe).toHaveBeenCalledWith(UPDATER_AVAILABLE_CHANNEL, expect.any(Function))
    expect(onUpdaterAvailable).not.toHaveBeenCalled()

    const payload = { version: '1.2.3', releaseDate: '2026-05-29', isManualCheck: true }
    listener?.({ channel: UPDATER_AVAILABLE_CHANNEL, payload })
    listener?.({
      channel: UPDATER_AVAILABLE_CHANNEL,
      payload: { releaseDate: '2026-05-29' }
    })

    expect(callback).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith(payload)
  })

  it('falls back to the renderer subscription client for update-available events', () => {
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
    const returned = updaterApi.onUpdateAvailable(callback)

    expect(returned).toBe(unsubscribe)
    expect(subscribe).toHaveBeenCalledWith(UPDATER_AVAILABLE_CHANNEL, expect.any(Function))

    listener?.({
      channel: UPDATER_AVAILABLE_CHANNEL,
      payload: { version: '1.2.3', releaseDate: '2026-05-29', isManualCheck: true }
    })
    listener?.({
      channel: UPDATER_AVAILABLE_CHANNEL,
      payload: { releaseDate: '2026-05-29' }
    })

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith({
      version: '1.2.3',
      releaseDate: '2026-05-29',
      isManualCheck: true
    })
  })

  it('routes update-not-available events through the renderer subscription client', () => {
    const request = vi.fn()
    const unsubscribe = vi.fn()
    const onUpdaterNotAvailable = vi.fn(
      (_listener: (data: { version: string; isManualCheck?: boolean }) => void) => unsubscribe
    )
    let listener: ((event: { channel: string; payload: unknown }) => void) | undefined
    const subscribe = vi.fn(
      (_channel: string, next: (event: { channel: string; payload: unknown }) => void) => {
        listener = next
        return unsubscribe
      }
    )

    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: {
        getLocalEnvironmentBootstrap: vi.fn(),
        onUpdaterNotAvailable
      }
    })
    setRendererRpcClient({ request, subscribe })

    const callback = vi.fn()
    const returned = updaterApi.onUpdateNotAvailable(callback)

    expect(returned).toBe(unsubscribe)
    expect(subscribe).toHaveBeenCalledWith(UPDATER_NOT_AVAILABLE_CHANNEL, expect.any(Function))
    expect(onUpdaterNotAvailable).not.toHaveBeenCalled()

    const payload = { version: '1.2.3', isManualCheck: true }
    listener?.({ channel: UPDATER_NOT_AVAILABLE_CHANNEL, payload })
    listener?.({
      channel: UPDATER_NOT_AVAILABLE_CHANNEL,
      payload: { version: '1.2.4', isManualCheck: 'yes' }
    })

    expect(callback).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith(payload)
  })

  it('falls back to the renderer subscription client for update-not-available events', () => {
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
    const returned = updaterApi.onUpdateNotAvailable(callback)

    expect(returned).toBe(unsubscribe)
    expect(subscribe).toHaveBeenCalledWith(UPDATER_NOT_AVAILABLE_CHANNEL, expect.any(Function))

    listener?.({
      channel: UPDATER_NOT_AVAILABLE_CHANNEL,
      payload: { version: '1.2.3', isManualCheck: true }
    })
    listener?.({
      channel: UPDATER_NOT_AVAILABLE_CHANNEL,
      payload: { version: '1.2.4', isManualCheck: 'yes' }
    })

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith({
      version: '1.2.3',
      isManualCheck: true
    })
  })

  it('routes update-progress events through the renderer subscription client', () => {
    const request = vi.fn()
    const unsubscribe = vi.fn()
    const onUpdaterProgress = vi.fn(
      (
        _listener: (data: {
          percent: number
          bytesPerSecond: number
          transferred: number
          total: number
        }) => void
      ) => unsubscribe
    )
    let listener: ((event: { channel: string; payload: unknown }) => void) | undefined
    const subscribe = vi.fn(
      (_channel: string, next: (event: { channel: string; payload: unknown }) => void) => {
        listener = next
        return unsubscribe
      }
    )

    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: {
        getLocalEnvironmentBootstrap: vi.fn(),
        onUpdaterProgress
      }
    })
    setRendererRpcClient({ request, subscribe })

    const callback = vi.fn()
    const returned = updaterApi.onProgress(callback)

    expect(returned).toBe(unsubscribe)
    expect(subscribe).toHaveBeenCalledWith(UPDATER_PROGRESS_CHANNEL, expect.any(Function))
    expect(onUpdaterProgress).not.toHaveBeenCalled()

    const payload = { percent: 42, bytesPerSecond: 1024, transferred: 2048, total: 4096 }
    listener?.({ channel: UPDATER_PROGRESS_CHANNEL, payload })
    listener?.({
      channel: UPDATER_PROGRESS_CHANNEL,
      payload: { percent: '42', bytesPerSecond: 1024, transferred: 2048, total: 4096 }
    })

    expect(callback).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith(payload)
  })

  it('falls back to the renderer subscription client for update-progress events', () => {
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
    const returned = updaterApi.onProgress(callback)

    expect(returned).toBe(unsubscribe)
    expect(subscribe).toHaveBeenCalledWith(UPDATER_PROGRESS_CHANNEL, expect.any(Function))

    listener?.({
      channel: UPDATER_PROGRESS_CHANNEL,
      payload: { percent: 42, bytesPerSecond: 1024, transferred: 2048, total: 4096 }
    })
    listener?.({
      channel: UPDATER_PROGRESS_CHANNEL,
      payload: { percent: '42', bytesPerSecond: 1024, transferred: 2048, total: 4096 }
    })

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith({
      percent: 42,
      bytesPerSecond: 1024,
      transferred: 2048,
      total: 4096
    })
  })

  it('routes update-downloaded events through the renderer subscription client', () => {
    const request = vi.fn()
    const unsubscribe = vi.fn()
    const onUpdaterDownloaded = vi.fn(
      (_listener: (data: { version: string; releaseNotes?: unknown }) => void) => unsubscribe
    )
    let listener: ((event: { channel: string; payload: unknown }) => void) | undefined
    const subscribe = vi.fn(
      (_channel: string, next: (event: { channel: string; payload: unknown }) => void) => {
        listener = next
        return unsubscribe
      }
    )

    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: {
        getLocalEnvironmentBootstrap: vi.fn(),
        onUpdaterDownloaded
      }
    })
    setRendererRpcClient({ request, subscribe })

    const callback = vi.fn()
    const returned = updaterApi.onUpdateDownloaded(callback)

    expect(returned).toBe(unsubscribe)
    expect(subscribe).toHaveBeenCalledWith(UPDATER_DOWNLOADED_CHANNEL, expect.any(Function))
    expect(onUpdaterDownloaded).not.toHaveBeenCalled()

    const payload = { version: '1.2.3', releaseNotes: 'Fixes' }
    listener?.({ channel: UPDATER_DOWNLOADED_CHANNEL, payload })
    listener?.({
      channel: UPDATER_DOWNLOADED_CHANNEL,
      payload: { version: 123, releaseNotes: 'Fixes' }
    })

    expect(callback).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith(payload)
  })

  it('falls back to the renderer subscription client for update-downloaded events', () => {
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
    const returned = updaterApi.onUpdateDownloaded(callback)

    expect(returned).toBe(unsubscribe)
    expect(subscribe).toHaveBeenCalledWith(UPDATER_DOWNLOADED_CHANNEL, expect.any(Function))

    listener?.({
      channel: UPDATER_DOWNLOADED_CHANNEL,
      payload: { version: '1.2.3', releaseNotes: 'Fixes' }
    })
    listener?.({
      channel: UPDATER_DOWNLOADED_CHANNEL,
      payload: { version: 123, releaseNotes: 'Fixes' }
    })

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith({
      version: '1.2.3',
      releaseNotes: 'Fixes'
    })
  })

  it('routes update-error events through the renderer subscription client', () => {
    const request = vi.fn()
    const unsubscribe = vi.fn()
    const onUpdaterError = vi.fn(
      (_listener: (data: { message: string; isManualCheck?: boolean }) => void) => unsubscribe
    )
    let listener: ((event: { channel: string; payload: unknown }) => void) | undefined
    const subscribe = vi.fn(
      (_channel: string, next: (event: { channel: string; payload: unknown }) => void) => {
        listener = next
        return unsubscribe
      }
    )

    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: {
        getLocalEnvironmentBootstrap: vi.fn(),
        onUpdaterError
      }
    })
    setRendererRpcClient({ request, subscribe })

    const callback = vi.fn()
    const returned = updaterApi.onError(callback)

    expect(returned).toBe(unsubscribe)
    expect(subscribe).toHaveBeenCalledWith(UPDATER_ERROR_CHANNEL, expect.any(Function))
    expect(onUpdaterError).not.toHaveBeenCalled()

    const payload = { message: 'Download failed', isManualCheck: true }
    listener?.({ channel: UPDATER_ERROR_CHANNEL, payload })
    listener?.({
      channel: UPDATER_ERROR_CHANNEL,
      payload: { message: 123, isManualCheck: true }
    })

    expect(callback).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith(payload)
  })

  it('falls back to the renderer subscription client for update-error events', () => {
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
    const returned = updaterApi.onError(callback)

    expect(returned).toBe(unsubscribe)
    expect(subscribe).toHaveBeenCalledWith(UPDATER_ERROR_CHANNEL, expect.any(Function))

    listener?.({
      channel: UPDATER_ERROR_CHANNEL,
      payload: { message: 'Download failed', isManualCheck: true }
    })
    listener?.({
      channel: UPDATER_ERROR_CHANNEL,
      payload: { message: 123, isManualCheck: true }
    })

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith({
      message: 'Download failed',
      isManualCheck: true
    })
  })
})

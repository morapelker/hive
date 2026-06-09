import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeLocalEnvironmentBootstrapArg } from '@shared/desktop-bridge'
import { ipcMain, shell } from 'electron'
import {
  getDesktopPreloadBootstrapArguments,
  registerDesktopBridgeHandlers
} from './desktop-bridge-handlers'
import { getDesktopBackendBootstrap } from './backend-manager'

vi.mock('./backend-manager', () => ({
  getDesktopBackendBootstrap: vi.fn(() => null)
}))

describe('desktop bridge preload bootstrap arguments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('serializes the backend bootstrap for preload without IPC', () => {
    const bootstrap = {
      httpBaseUrl: 'http://127.0.0.1:3773',
      wsBaseUrl: 'ws://127.0.0.1:3773/ws',
      bootstrapToken: 'a'.repeat(48)
    }

    const argv = getDesktopPreloadBootstrapArguments(bootstrap)

    expect(decodeLocalEnvironmentBootstrapArg(argv)).toEqual(bootstrap)
  })

  it('uses the current backend bootstrap by default', () => {
    const bootstrap = {
      httpBaseUrl: 'http://127.0.0.1:3774',
      wsBaseUrl: 'ws://127.0.0.1:3774/ws',
      bootstrapToken: 'b'.repeat(48)
    }
    vi.mocked(getDesktopBackendBootstrap).mockReturnValue(bootstrap)

    const argv = getDesktopPreloadBootstrapArguments()

    expect(decodeLocalEnvironmentBootstrapArg(argv)).toEqual(bootstrap)
  })

  it('serializes null while the backend is unavailable', () => {
    vi.mocked(getDesktopBackendBootstrap).mockReturnValue(null)

    const argv = getDesktopPreloadBootstrapArguments()

    expect(decodeLocalEnvironmentBootstrapArg(argv)).toBeNull()
  })
})

describe('Hive Enterprise desktop login', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('starts auth with a localhost callback URL and completes the loopback token exchange', async () => {
    registerDesktopBridgeHandlers()
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => {
      return channel === 'hive-enterprise:start-login'
    })?.[1]
    expect(handler).toBeDefined()

    let openedUrl = ''
    vi.spyOn(shell, 'openExternal').mockImplementation(async (url) => {
      openedUrl = url
    })

    const loginPromise = handler!({} as Electron.IpcMainInvokeEvent, {
      serverUrl: 'http://localhost:3022/'
    })

    await vi.waitFor(() => expect(openedUrl).toContain('/api/auth/desktop/start'))

    const startUrl = new URL(openedUrl)
    const redirect = startUrl.searchParams.get('redirect')
    expect(redirect).toBeTruthy()

    const callbackUrl = new URL(redirect!)
    try {
      expect(callbackUrl.protocol).toBe('http:')
      expect(callbackUrl.hostname).toBe('localhost')

      callbackUrl.searchParams.set('token', 'enterprise-token')
      const callbackResponse = await fetch(callbackUrl)
      expect(callbackResponse.status).toBe(200)

      await expect(loginPromise).resolves.toEqual({ token: 'enterprise-token' })
    } finally {
      const cleanupUrl = new URL(callbackUrl)
      cleanupUrl.hostname = '127.0.0.1'
      cleanupUrl.searchParams.set('token', 'enterprise-token')
      await fetch(cleanupUrl).catch(() => undefined)
      await Promise.race([
        loginPromise.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 50))
      ])
    }
  })

  it('uses http for localhost Enterprise desktop auth even when the configured server URL is https', async () => {
    registerDesktopBridgeHandlers()
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => {
      return channel === 'hive-enterprise:start-login'
    })?.[1]
    expect(handler).toBeDefined()

    let openedUrl = ''
    vi.spyOn(shell, 'openExternal').mockImplementation(async (url) => {
      openedUrl = url
    })

    const loginPromise = handler!({} as Electron.IpcMainInvokeEvent, {
      serverUrl: 'https://localhost:3000/'
    })

    await vi.waitFor(() => expect(openedUrl).toContain('/api/auth/desktop/start'))

    const startUrl = new URL(openedUrl)
    const redirect = startUrl.searchParams.get('redirect')
    expect(startUrl.origin).toBe('http://localhost:3000')
    expect(redirect).toBeTruthy()

    const callbackUrl = new URL(redirect!)
    try {
      expect(callbackUrl.protocol).toBe('http:')
      expect(callbackUrl.hostname).toBe('localhost')

      callbackUrl.searchParams.set('token', 'enterprise-token')
      const callbackResponse = await fetch(callbackUrl)
      expect(callbackResponse.status).toBe(200)

      await expect(loginPromise).resolves.toEqual({ token: 'enterprise-token' })
    } finally {
      const cleanupUrl = new URL(callbackUrl)
      cleanupUrl.hostname = '127.0.0.1'
      cleanupUrl.searchParams.set('token', 'enterprise-token')
      await fetch(cleanupUrl).catch(() => undefined)
      await Promise.race([
        loginPromise.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 50))
      ])
    }
  })
})

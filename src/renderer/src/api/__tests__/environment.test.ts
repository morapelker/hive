import { describe, expect, it, vi } from 'vitest'
import { resolveBackendTarget } from '../environment'

describe('resolveBackendTarget', () => {
  it('prefers desktopBridge bootstrap when available', async () => {
    const desktopBridge = {
      getLocalEnvironmentBootstrap: vi.fn(async () => ({
        httpBaseUrl: 'http://127.0.0.1:3773/',
        wsBaseUrl: 'ws://127.0.0.1:3773/ws',
        bootstrapToken: 'token'
      }))
    }

    await expect(resolveBackendTarget({ desktopBridge })).resolves.toEqual({
      httpBaseUrl: 'http://127.0.0.1:3773',
      wsBaseUrl: 'ws://127.0.0.1:3773/ws',
      bootstrapToken: 'token',
      source: 'desktop'
    })
  })

  it('uses Vite env when desktop bootstrap is not available', async () => {
    await expect(
      resolveBackendTarget({
        desktopBridge: null,
        env: { VITE_HIVE_HTTP_BASE_URL: 'http://127.0.0.1:4000' }
      })
    ).resolves.toEqual({
      httpBaseUrl: 'http://127.0.0.1:4000',
      wsBaseUrl: 'ws://127.0.0.1:4000/ws',
      bootstrapToken: null,
      source: 'vite'
    })
  })

  it('falls back to window location origin for browser production mode', async () => {
    await expect(
      resolveBackendTarget({
        desktopBridge: null,
        env: {},
        location: {
          origin: 'https://hive.local',
          protocol: 'https:',
          host: 'hive.local'
        }
      })
    ).resolves.toEqual({
      httpBaseUrl: 'https://hive.local',
      wsBaseUrl: 'wss://hive.local/ws',
      bootstrapToken: null,
      source: 'browser'
    })
  })
})


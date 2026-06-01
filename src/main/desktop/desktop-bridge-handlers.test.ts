import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeLocalEnvironmentBootstrapArg } from '@shared/desktop-bridge'
import { getDesktopPreloadBootstrapArguments } from './desktop-bridge-handlers'
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

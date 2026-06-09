import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./logger', () => ({
  getLogDir: () => '/tmp/hive-logs',
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { getAppPaths, getAppVersion } from './system-info'

describe('system info', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('derives app paths from Node environment without Electron app APIs', () => {
    vi.stubEnv('HOME', '/tmp/hive-home')
    vi.stubEnv('HIVE_SERVER_BASE_DIR', '/tmp/hive-base')

    expect(getAppPaths()).toEqual({
      userData: '/tmp/hive-base',
      home: '/tmp/hive-home',
      logs: '/tmp/hive-logs'
    })
  })

  it('uses the npm package version environment fallback without Electron app APIs', () => {
    vi.stubEnv('npm_package_version', '1.2.3-test')

    expect(getAppVersion()).toBe('1.2.3-test')
  })
})

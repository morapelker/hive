import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { parseGhosttyConfig, resolveGhosttyConfigPath } from '../ghostty-config'

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn()
}))

vi.mock('os', () => ({
  homedir: vi.fn(() => '/Users/test')
}))

vi.mock('../logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}))

const HOME = '/Users/test'
const APP_SUPPORT_DIR = join(HOME, 'Library', 'Application Support', 'com.mitchellh.ghostty')
const XDG_CONFIG = join(HOME, '.config', 'ghostty', 'config')

const existsSyncMock = vi.mocked(existsSync)
const readFileSyncMock = vi.mocked(readFileSync)

describe('ghostty config path resolution (TCC gating)', () => {
  let savedXdgConfigHome: string | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    savedXdgConfigHome = process.env.XDG_CONFIG_HOME
    delete process.env.XDG_CONFIG_HOME
  })

  afterEach(() => {
    if (savedXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME
    } else {
      process.env.XDG_CONFIG_HOME = savedXdgConfigHome
    }
  })

  it('never touches the Application Support dir by default, even when only it has a config', () => {
    // Simulate a machine where the only Ghostty config lives in App Support.
    existsSyncMock.mockImplementation((path) => String(path).startsWith(APP_SUPPORT_DIR))

    const config = parseGhosttyConfig()

    expect(config).toEqual({})
    for (const call of existsSyncMock.mock.calls) {
      expect(String(call[0])).not.toContain('com.mitchellh.ghostty')
    }
    expect(readFileSyncMock).not.toHaveBeenCalled()
  })

  it('finds and parses the XDG config in default mode', () => {
    existsSyncMock.mockImplementation((path) => path === XDG_CONFIG)
    readFileSyncMock.mockReturnValue('font-size = 13\nbackground = #1e1e2e')

    const config = parseGhosttyConfig()

    expect(config.fontSize).toBe(13)
    expect(config.background).toBe('#1e1e2e')
    expect(readFileSyncMock).toHaveBeenCalledWith(XDG_CONFIG, 'utf-8')
  })

  it('honors XDG_CONFIG_HOME in default mode', () => {
    process.env.XDG_CONFIG_HOME = '/custom/xdg'
    const customPath = join('/custom/xdg', 'ghostty', 'config')
    existsSyncMock.mockImplementation((path) => path === customPath)
    readFileSyncMock.mockReturnValue('font-size = 11')

    const config = parseGhosttyConfig()

    expect(config.fontSize).toBe(11)
    expect(readFileSyncMock).toHaveBeenCalledWith(customPath, 'utf-8')
  })

  it('prefers the Application Support config when includeAppSupport is set', () => {
    const appSupportConfig = join(APP_SUPPORT_DIR, 'config.ghostty')
    existsSyncMock.mockImplementation(
      (path) => path === appSupportConfig || path === XDG_CONFIG
    )

    const resolved = resolveGhosttyConfigPath({ includeAppSupport: true })

    expect(resolved).toBe(appSupportConfig)
  })

  it('falls back through App Support candidates in order when opted in', () => {
    const appSupportPlain = join(APP_SUPPORT_DIR, 'config')
    existsSyncMock.mockImplementation((path) => path === appSupportPlain)

    const resolved = resolveGhosttyConfigPath({ includeAppSupport: true })

    expect(resolved).toBe(appSupportPlain)
  })

  it('resolves nothing (empty config) when no candidate exists', () => {
    existsSyncMock.mockReturnValue(false)

    expect(resolveGhosttyConfigPath({ includeAppSupport: true })).toBeUndefined()
    expect(parseGhosttyConfig({ includeAppSupport: true })).toEqual({})
  })
})

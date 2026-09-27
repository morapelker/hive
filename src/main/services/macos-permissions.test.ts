import { describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import {
  MACOS_PRIVACY_PANE_URLS,
  checkFullDiskAccess,
  getFullDiskAccessProbePaths,
  getMacosPermissionStatus,
  openMacosPrivacySettings
} from './macos-permissions'

const errnoError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code })

const HOME = '/Users/probe'

describe('checkFullDiskAccess', () => {
  it('is granted when a protected file opens for reading', () => {
    const readProbe = vi.fn()

    expect(checkFullDiskAccess({ platform: 'darwin', homeDirectory: HOME, readProbe })).toBe(true)
    expect(readProbe).toHaveBeenCalledTimes(1)
    expect(readProbe).toHaveBeenCalledWith(
      join(HOME, 'Library', 'Application Support', 'com.apple.TCC', 'TCC.db')
    )
  })

  it('skips probe files that do not exist and keeps looking', () => {
    const readProbe = vi
      .fn()
      .mockImplementationOnce(() => {
        throw errnoError('ENOENT')
      })
      .mockImplementationOnce(() => undefined)

    expect(checkFullDiskAccess({ platform: 'darwin', homeDirectory: HOME, readProbe })).toBe(true)
    expect(readProbe).toHaveBeenCalledTimes(2)
    expect(readProbe).toHaveBeenLastCalledWith(getFullDiskAccessProbePaths(HOME)[1])
  })

  it('is denied as soon as macOS refuses a read', () => {
    const readProbe = vi.fn(() => {
      throw errnoError('EPERM')
    })

    expect(checkFullDiskAccess({ platform: 'darwin', homeDirectory: HOME, readProbe })).toBe(false)
    expect(readProbe).toHaveBeenCalledTimes(1)
  })

  it('is denied when no probe file exists at all', () => {
    const readProbe = vi.fn(() => {
      throw errnoError('ENOENT')
    })

    expect(checkFullDiskAccess({ platform: 'darwin', homeDirectory: HOME, readProbe })).toBe(false)
    expect(readProbe).toHaveBeenCalledTimes(getFullDiskAccessProbePaths(HOME).length)
  })

  it('never probes off macOS', () => {
    const readProbe = vi.fn()

    expect(checkFullDiskAccess({ platform: 'linux', homeDirectory: HOME, readProbe })).toBe(false)
    expect(readProbe).not.toHaveBeenCalled()
  })
})

describe('getMacosPermissionStatus', () => {
  it('reports the platform as unsupported off macOS', () => {
    expect(getMacosPermissionStatus({ platform: 'win32', readProbe: vi.fn() })).toEqual({
      supported: false,
      fullDiskAccess: false
    })
  })

  it('reports the Full Disk Access probe on macOS', () => {
    expect(
      getMacosPermissionStatus({ platform: 'darwin', homeDirectory: HOME, readProbe: vi.fn() })
    ).toEqual({ supported: true, fullDiskAccess: true })
  })
})

describe('openMacosPrivacySettings', () => {
  it('opens the Full Disk Access pane through `open` without holding the event loop', () => {
    const unref = vi.fn()
    const spawn = vi.fn(() => ({ on: vi.fn(), unref }))

    expect(openMacosPrivacySettings('fullDiskAccess', { platform: 'darwin', spawn })).toEqual({
      success: true
    })
    expect(spawn).toHaveBeenCalledWith('open', [MACOS_PRIVACY_PANE_URLS.fullDiskAccess], {
      detached: true,
      stdio: 'ignore'
    })
    expect(unref).toHaveBeenCalled()
  })

  it('opens the Files and Folders pane', () => {
    const spawn = vi.fn(() => ({}))

    expect(openMacosPrivacySettings('filesAndFolders', { platform: 'darwin', spawn })).toEqual({
      success: true
    })
    expect(spawn).toHaveBeenCalledWith(
      'open',
      [MACOS_PRIVACY_PANE_URLS.filesAndFolders],
      expect.anything()
    )
  })

  it('refuses off macOS', () => {
    const spawn = vi.fn(() => ({}))

    expect(openMacosPrivacySettings('fullDiskAccess', { platform: 'linux', spawn })).toMatchObject({
      success: false
    })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('refuses a pane it does not know', () => {
    const spawn = vi.fn(() => ({}))

    expect(
      openMacosPrivacySettings('camera' as never, { platform: 'darwin', spawn })
    ).toMatchObject({ success: false, error: 'Unknown privacy pane: camera' })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('reports a spawn failure instead of throwing', () => {
    const spawn = vi.fn(() => {
      throw new Error('open: not found')
    })

    expect(openMacosPrivacySettings('fullDiskAccess', { platform: 'darwin', spawn })).toEqual({
      success: false,
      error: 'open: not found'
    })
  })
})

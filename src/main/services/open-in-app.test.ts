import { describe, expect, it, vi } from 'vitest'
import { openInApp } from './open-in-app'

describe('openInApp', () => {
  it('opens Cursor with the macOS app launcher', async () => {
    const spawn = vi.fn()

    await expect(
      openInApp('cursor', '/tmp/hive', { platform: 'darwin', spawn })
    ).resolves.toEqual({ success: true })

    expect(spawn).toHaveBeenCalledWith('open', ['-a', 'Cursor', '/tmp/hive'], {
      detached: true,
      stdio: 'ignore'
    })
  })

  it('returns the Windows Ghostty unsupported error', async () => {
    const spawn = vi.fn()

    await expect(
      openInApp('ghostty', '/tmp/hive', { platform: 'win32', spawn })
    ).resolves.toEqual({
      success: false,
      error: 'Ghostty is not available on Windows'
    })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('copies paths through Electron clipboard', async () => {
    const clipboard = { writeText: vi.fn() }

    await expect(
      openInApp('copy-path', '/tmp/hive', { platform: 'linux', clipboard })
    ).resolves.toEqual({ success: true })

    expect(clipboard.writeText).toHaveBeenCalledWith('/tmp/hive')
  })

  it('returns an unavailable result when copy-path has no clipboard writer', async () => {
    await expect(openInApp('copy-path', '/tmp/hive', { platform: 'linux' })).resolves.toEqual({
      success: false,
      error: 'No clipboard writer is available'
    })
  })

  it('returns an error for unknown app names', async () => {
    await expect(openInApp('missing-app', '/tmp/hive')).resolves.toEqual({
      success: false,
      error: 'Unknown app: missing-app'
    })
  })
})

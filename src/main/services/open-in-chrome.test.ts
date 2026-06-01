import { describe, expect, it, vi } from 'vitest'
import { openInChrome } from './open-in-chrome'

describe('openInChrome', () => {
  it('opens URLs through the default external browser when no command is configured', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined)

    await expect(openInChrome('https://example.com', undefined, { openExternal })).resolves.toEqual({
      success: true
    })

    expect(openExternal).toHaveBeenCalledWith('https://example.com')
  })

  it('returns an unavailable result when no command or external opener is configured', async () => {
    await expect(openInChrome('https://example.com')).resolves.toEqual({
      success: false,
      error: 'No external URL opener is available'
    })
  })

  it('substitutes URL placeholders in custom commands', async () => {
    const exec = vi.fn((_command: string, callback: (error: Error | null) => void) => {
      callback(null)
    })

    await expect(
      openInChrome('https://example.com', 'google-chrome {url}', { exec })
    ).resolves.toEqual({ success: true })

    expect(exec).toHaveBeenCalledWith('google-chrome https://example.com', expect.any(Function))
  })

  it('appends the URL to custom commands without placeholders', async () => {
    const exec = vi.fn((_command: string, callback: (error: Error | null) => void) => {
      callback(null)
    })

    await expect(openInChrome('https://example.com', 'google-chrome', { exec })).resolves.toEqual({
      success: true
    })

    expect(exec).toHaveBeenCalledWith('google-chrome https://example.com', expect.any(Function))
  })

  it('returns command errors without throwing', async () => {
    const exec = vi.fn((_command: string, callback: (error: Error | null) => void) => {
      callback(new Error('command failed'))
    })

    await expect(openInChrome('https://example.com', 'google-chrome', { exec })).resolves.toEqual({
      success: false,
      error: 'command failed'
    })
  })
})

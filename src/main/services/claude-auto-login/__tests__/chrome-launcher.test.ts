// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { buildChromeArgs, CHROME_WINDOW_SIZE, findChromeBinary } from '../chrome-launcher'

describe('buildChromeArgs', () => {
  it('isolates the profile, opens the CDP pipe and starts on the authorize URL', () => {
    const args = buildChromeArgs('/tmp/profile-x', 'https://claude.ai/oauth/authorize?x=1')
    expect(args).toContain('--remote-debugging-pipe')
    expect(args).toContain('--user-data-dir=/tmp/profile-x')
    expect(args).toContain('--no-first-run')
    expect(args).toContain('--use-mock-keychain')
    expect(args).toContain(`--window-size=${CHROME_WINDOW_SIZE.width},${CHROME_WINDOW_SIZE.height}`)
    // Never a debugging port: nothing else on the machine may attach to this browser.
    expect(args.some((a) => a.startsWith('--remote-debugging-port'))).toBe(false)
    expect(args.at(-1)).toBe('https://claude.ai/oauth/authorize?x=1')
  })

  it('gives the consent page enough room for the Authorize button', () => {
    expect(CHROME_WINDOW_SIZE.width).toBeGreaterThanOrEqual(1024)
    expect(CHROME_WINDOW_SIZE.height).toBeGreaterThanOrEqual(768)
  })
})

describe('findChromeBinary', () => {
  it('returns the first candidate that exists, skipping relative paths', async () => {
    expect(
      await findChromeBinary(['relative/path', '/definitely/not/here', process.execPath])
    ).toBe(process.execPath)
    expect(await findChromeBinary(['/definitely/not/here'])).toBeNull()
  })
})

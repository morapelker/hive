import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockExecFileSync, mockExistsSync, mockHomedir } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockExistsSync: vi.fn(),
  mockHomedir: vi.fn()
}))

vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

vi.mock('child_process', () => ({
  default: { execFileSync: (...args: unknown[]) => mockExecFileSync(...args) },
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args)
}))

vi.mock('fs', () => ({
  default: { existsSync: (...args: unknown[]) => mockExistsSync(...args) },
  existsSync: (...args: unknown[]) => mockExistsSync(...args)
}))

vi.mock('os', () => ({
  default: { homedir: () => mockHomedir() },
  homedir: () => mockHomedir()
}))

describe('resolveCodexBinaryPath', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockHomedir.mockReturnValue('/Users/test')
    mockExistsSync.mockReturnValue(true)
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform
    })
  })

  it('returns the first resolved path from which/where', async () => {
    mockExecFileSync.mockReturnValue('/usr/local/bin/codex\n/opt/homebrew/bin/codex\n')

    const { resolveCodexBinaryPath } = await import('../../../src/main/services/codex-binary-resolver')

    expect(resolveCodexBinaryPath()).toBe('/usr/local/bin/codex')
    expect(mockExistsSync).toHaveBeenCalledWith('/usr/local/bin/codex')
  })

  it('returns null when the resolved path does not exist', async () => {
    mockExecFileSync.mockReturnValue('/usr/local/bin/codex\n')
    mockExistsSync.mockReturnValue(false)

    const { resolveCodexBinaryPath } = await import('../../../src/main/services/codex-binary-resolver')

    expect(resolveCodexBinaryPath()).toBeNull()
  })

  it('uses the login shell when the app process PATH lookup fails', async () => {
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw new Error('not found')
      })
      .mockReturnValueOnce('/Users/test/Applications/Codex.app/Contents/Resources/codex\n')

    const { resolveCodexBinaryPath } = await import('../../../src/main/services/codex-binary-resolver')

    expect(resolveCodexBinaryPath()).toBe('/Users/test/Applications/Codex.app/Contents/Resources/codex')
  })

  it('checks known Codex locations when PATH and login shell lookups fail', async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found')
    })
    mockExistsSync.mockImplementation(
      (candidate: unknown) =>
        candidate === '/Users/test/Applications/Codex.app/Contents/Resources/codex'
    )

    const { resolveCodexBinaryPath } = await import('../../../src/main/services/codex-binary-resolver')

    expect(resolveCodexBinaryPath()).toBe('/Users/test/Applications/Codex.app/Contents/Resources/codex')
  })

  it('returns null when all lookup strategies fail', async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found')
    })
    mockExistsSync.mockReturnValue(false)

    const { resolveCodexBinaryPath } = await import('../../../src/main/services/codex-binary-resolver')

    expect(resolveCodexBinaryPath()).toBeNull()
  })

  it('prefers runnable Windows candidates over extensionless shims', async () => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    mockExecFileSync.mockReturnValue(
      [
        'C:\\Users\\seanc\\AppData\\Roaming\\npm\\codex',
        'C:\\Users\\seanc\\AppData\\Roaming\\npm\\codex.cmd',
        'C:\\Program Files\\Codex\\codex.exe'
      ].join('\r\n')
    )

    const { resolveCodexBinaryPath } = await import('../../../src/main/services/codex-binary-resolver')

    expect(resolveCodexBinaryPath()).toBe('C:\\Program Files\\Codex\\codex.exe')
  })

  it('deprioritizes WindowsApps executables behind regular PATH shims on Windows', async () => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    mockExecFileSync.mockReturnValue(
      [
        'C:\\Users\\seanc\\AppData\\Roaming\\npm\\codex',
        'C:\\Users\\seanc\\AppData\\Roaming\\npm\\codex.cmd',
        'C:\\Program Files\\WindowsApps\\OpenAI.Codex\\codex.exe'
      ].join('\r\n')
    )

    const { resolveCodexBinaryPath } = await import('../../../src/main/services/codex-binary-resolver')

    expect(resolveCodexBinaryPath()).toBe('C:\\Users\\seanc\\AppData\\Roaming\\npm\\codex.cmd')
  })

  it('reports app-server support when the help output exposes the app-server usage', async () => {
    mockExecFileSync.mockReturnValue('Usage: codex app-server [OPTIONS] [COMMAND]\n')

    const { supportsCodexAppServer } = await import('../../../src/main/services/codex-binary-resolver')

    expect(supportsCodexAppServer('/usr/local/bin/codex')).toBe(true)
    expect(mockExecFileSync).toHaveBeenCalledWith(
      '/usr/local/bin/codex',
      ['app-server', '--help'],
      expect.objectContaining({
        encoding: 'utf-8',
        timeout: 5000,
        env: process.env,
        shell: false
      })
    )
  })

  it('recognizes app-server support when warnings surround the usage output', async () => {
    mockExecFileSync.mockReturnValue(
      'Warning: falling back to default config\nUsage: codex app-server [OPTIONS] [COMMAND]\n'
    )

    const { supportsCodexAppServer } = await import('../../../src/main/services/codex-binary-resolver')

    expect(supportsCodexAppServer('/usr/local/bin/codex')).toBe(true)
  })

  it('recognizes app-server support from captured stderr when the help probe exits non-zero', async () => {
    const error = new Error('help failed') as Error & { stdout: string; stderr: string }
    error.stdout = ''
    error.stderr = 'Warning: config issue\nUsage: codex app-server [OPTIONS] [COMMAND]\n'
    mockExecFileSync.mockImplementation(() => {
      throw error
    })

    const { supportsCodexAppServer } = await import('../../../src/main/services/codex-binary-resolver')

    expect(supportsCodexAppServer('/usr/local/bin/codex')).toBe(true)
  })

  it('reports no app-server support when help falls back to the top-level CLI usage', async () => {
    mockExecFileSync.mockReturnValue('Usage: codex [OPTIONS] [PROMPT]\n')

    const { supportsCodexAppServer } = await import('../../../src/main/services/codex-binary-resolver')

    expect(supportsCodexAppServer('/usr/local/bin/codex')).toBe(false)
  })

  it('caches non-zero negative app-server probes for resolved paths', async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('unsupported')
    })

    const { supportsCodexAppServer } = await import('../../../src/main/services/codex-binary-resolver')

    expect(supportsCodexAppServer('/usr/local/bin/codex')).toBe(false)
    expect(supportsCodexAppServer('/usr/local/bin/codex')).toBe(false)
    expect(mockExecFileSync).toHaveBeenCalledTimes(1)
  })

  it('does not cache transient probe failures for the bare codex command', async () => {
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw new Error('temporary PATH failure')
      })
      .mockReturnValueOnce('Usage: codex app-server [OPTIONS] [COMMAND]\n')

    const { supportsCodexAppServer } = await import('../../../src/main/services/codex-binary-resolver')

    expect(supportsCodexAppServer('codex')).toBe(false)
    expect(supportsCodexAppServer('codex')).toBe(true)
    expect(mockExecFileSync).toHaveBeenCalledTimes(2)
  })
})

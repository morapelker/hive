import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockExecFileSync, mockExistsSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockExistsSync: vi.fn()
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

describe('resolveCodexBinaryPath', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
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

  it('returns null when the lookup command fails', async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found')
    })

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

  it('reports no app-server support when help falls back to the top-level CLI usage', async () => {
    mockExecFileSync.mockReturnValue('Usage: codex [OPTIONS] [PROMPT]\n')

    const { supportsCodexAppServer } = await import('../../../src/main/services/codex-binary-resolver')

    expect(supportsCodexAppServer('/usr/local/bin/codex')).toBe(false)
  })
})

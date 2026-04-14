import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const { mockExecFileSync, mockExistsSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockExistsSync: vi.fn()
}))

const originalPlatform = process.platform

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

describe('resolveOpenCodeLaunchSpec', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(true)
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  it('returns the first resolved path on non-Windows platforms', async () => {
    mockExecFileSync.mockReturnValue('/usr/local/bin/opencode\n/opt/homebrew/bin/opencode\n')

    const { resolveOpenCodeLaunchSpec } = await import(
      '../../../src/main/services/opencode-binary-resolver'
    )

    expect(resolveOpenCodeLaunchSpec()).toEqual({
      command: '/usr/local/bin/opencode',
      shell: false
    })
    expect(mockExistsSync).toHaveBeenCalledWith('/usr/local/bin/opencode')
  })

  it('returns a shell-backed launch spec on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockExecFileSync.mockReturnValue('C:\\Users\\mor\\AppData\\Roaming\\npm\\opencode.cmd\r\n')

    const { resolveOpenCodeLaunchSpec } = await import(
      '../../../src/main/services/opencode-binary-resolver'
    )

    expect(resolveOpenCodeLaunchSpec()).toEqual({
      command: 'C:\\Users\\mor\\AppData\\Roaming\\npm\\opencode.cmd',
      shell: true
    })
  })

  it('returns null when the resolved path does not exist', async () => {
    mockExecFileSync.mockReturnValue('/usr/local/bin/opencode\n')
    mockExistsSync.mockReturnValue(false)

    const { resolveOpenCodeLaunchSpec } = await import(
      '../../../src/main/services/opencode-binary-resolver'
    )

    expect(resolveOpenCodeLaunchSpec()).toBeNull()
  })

  it('returns null when the lookup command fails', async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found')
    })

    const { resolveOpenCodeLaunchSpec } = await import(
      '../../../src/main/services/opencode-binary-resolver'
    )

    expect(resolveOpenCodeLaunchSpec()).toBeNull()
  })
})

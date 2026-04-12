import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(true)
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
})

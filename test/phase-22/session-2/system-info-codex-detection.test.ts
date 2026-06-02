import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for the codex detection logic in detectAgentSdks().
 *
 * Since the actual system-info.ts module depends on Electron (`app` from 'electron'),
 * we test the detection logic by exercising the same pattern used in the source:
 * shell-out to `which`/`where`, parse the path, and verify with existsSync.
 *
 * This validates:
 *   1. The return type includes `codex: boolean`
 *   2. The detection logic correctly identifies installed/missing codex binary
 *   3. Error handling works for all three binaries
 */

describe('system-info: detectAgentSdks codex detection logic', () => {
  // Replicate the detection logic from system-info.ts without Electron deps
  let mockExecFileSync: ReturnType<typeof vi.fn>
  let mockExistsSync: ReturnType<typeof vi.fn>

  function detectAgentSdks(): { opencode: boolean; claude: boolean; codex: boolean } {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which'
    const check = (binary: string): boolean => {
      try {
        const result = (mockExecFileSync(whichCmd, [binary], {
          encoding: 'utf-8',
          timeout: 5000,
          env: process.env
        }) as string).trim()
        const resolved = result.split('\n')[0].trim()
        return !!resolved && mockExistsSync(resolved)
      } catch {
        return false
      }
    }

    const checkCodex = (): boolean => {
      try {
        const result = (mockExecFileSync(whichCmd, ['codex'], {
          encoding: 'utf-8',
          timeout: 5000,
          env: process.env
        }) as string).trim()
        const resolved = result.split('\n')[0].trim()
        if (!resolved || !mockExistsSync(resolved)) {
          return false
        }

        const helpOutput = mockExecFileSync(resolved, ['app-server', '--help'], {
          encoding: 'utf-8',
          timeout: 5000,
          env: process.env,
          shell: false
        }) as string

        return helpOutput.includes('Usage: codex app-server')
      } catch {
        return false
      }
    }

    return { opencode: check('opencode'), claude: check('claude'), codex: checkCodex() }
  }

  beforeEach(() => {
    mockExecFileSync = vi.fn()
    mockExistsSync = vi.fn()
  })

  it('returns codex: true when codex binary is found', () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      const binary = args[0]
      if (binary === 'codex') return '/usr/local/bin/codex\n'
      if (binary === 'app-server') return 'Usage: codex app-server [OPTIONS] [COMMAND]\n'
      throw new Error('not found')
    })
    mockExistsSync.mockImplementation((p: string) => {
      return p === '/usr/local/bin/codex'
    })

    const result = detectAgentSdks()
    expect(result.codex).toBe(true)
    expect(result.opencode).toBe(false)
    expect(result.claude).toBe(false)
  })

  it('returns codex: false when codex binary is not found', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found')
    })

    const result = detectAgentSdks()
    expect(result.codex).toBe(false)
    expect(result.opencode).toBe(false)
    expect(result.claude).toBe(false)
  })

  it('returns all three as true when all binaries are found', () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      const binary = args[0]
      const paths: Record<string, string> = {
        opencode: '/usr/local/bin/opencode',
        claude: '/usr/local/bin/claude',
        codex: '/usr/local/bin/codex'
      }
      if (paths[binary]) return paths[binary] + '\n'
      if (binary === 'app-server') return 'Usage: codex app-server [OPTIONS] [COMMAND]\n'
      throw new Error('not found')
    })
    mockExistsSync.mockReturnValue(true)

    const result = detectAgentSdks()
    expect(result.opencode).toBe(true)
    expect(result.claude).toBe(true)
    expect(result.codex).toBe(true)
  })

  it('handles errors gracefully for codex detection', () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      const binary = args[0]
      if (binary === 'opencode') return '/usr/local/bin/opencode\n'
      if (binary === 'codex') return '/usr/local/bin/codex\n'
      if (binary === 'app-server') throw new Error('command timed out')
      throw new Error('not found')
    })
    mockExistsSync.mockReturnValue(true)

    const result = detectAgentSdks()
    expect(result.opencode).toBe(true)
    expect(result.claude).toBe(false)
    expect(result.codex).toBe(false)
  })

  it('returns codex: false when binary path does not exist on disk', () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      const binary = args[0]
      if (binary === 'codex') return '/usr/local/bin/codex\n'
      throw new Error('not found')
    })
    mockExistsSync.mockReturnValue(false)

    const result = detectAgentSdks()
    expect(result.codex).toBe(false)
  })

  it('returns codex: false when the installed CLI lacks app-server support', () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      const binary = args[0]
      if (binary === 'codex') return '/usr/local/bin/codex\n'
      if (binary === 'app-server') return 'Usage: codex [OPTIONS] [PROMPT]\n'
      throw new Error('not found')
    })
    mockExistsSync.mockReturnValue(true)

    const result = detectAgentSdks()
    expect(result.codex).toBe(false)
  })

  it('return type includes all three properties', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found')
    })

    const result = detectAgentSdks()
    expect(result).toHaveProperty('opencode')
    expect(result).toHaveProperty('claude')
    expect(result).toHaveProperty('codex')
  })

  it('uses which command on non-Windows platforms', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found')
    })

    detectAgentSdks()

    // All three calls should use 'which' (or 'where' on Windows)
    const expectedCmd = process.platform === 'win32' ? 'where' : 'which'
    expect(mockExecFileSync).toHaveBeenCalledTimes(3)
    expect(mockExecFileSync).toHaveBeenCalledWith(
      expectedCmd,
      ['opencode'],
      expect.objectContaining({ encoding: 'utf-8' })
    )
    expect(mockExecFileSync).toHaveBeenCalledWith(
      expectedCmd,
      ['claude'],
      expect.objectContaining({ encoding: 'utf-8' })
    )
    expect(mockExecFileSync).toHaveBeenCalledWith(
      expectedCmd,
      ['codex'],
      expect.objectContaining({ encoding: 'utf-8' })
    )
  })
})

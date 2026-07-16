import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockExecFileSync, mockExistsSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockExistsSync: vi.fn()
}))

vi.mock('child_process', () => ({
  default: { execFileSync: (...args: unknown[]) => mockExecFileSync(...args) },
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args)
}))

vi.mock('fs', () => ({
  default: { existsSync: (...args: unknown[]) => mockExistsSync(...args) },
  existsSync: (...args: unknown[]) => mockExistsSync(...args)
}))

describe('system-info: detectAgentSdks opencode launchability', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(true)
  })

  it('marks opencode available only when the launch spec resolves', async () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      const binary = args[0]
      if (binary === 'claude') return '/usr/local/bin/claude\n'
      if (binary === 'codex') return '/usr/local/bin/codex\n'
      if (_cmd === '/usr/local/bin/codex' && args.join(' ') === 'app-server --help') {
        return 'Usage: codex app-server\n'
      }
      // codex-cli hook-capability probe: `codex --version` >= 0.134.0.
      if (_cmd === '/usr/local/bin/codex' && args.join(' ') === '--version') {
        return 'codex-cli 0.144.0\n'
      }
      throw new Error('not found')
    })

    const { detectAgentSdks } = await import('../../../src/main/services/system-info')

    expect(
      detectAgentSdks({ command: '/usr/local/bin/opencode', shell: false })
    ).toEqual({
      opencode: true,
      claude: true,
      codex: true,
      codexCli: true
    })
  })

  it('does not offer codex-cli for a version with a broken hook-trust bypass (0.131-0.133)', async () => {
    // The flag is present but ignored in these versions (openai/codex#24093).
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args?.[0] === 'codex') return '/usr/local/bin/codex\n'
      if (_cmd === '/usr/local/bin/codex' && args.join(' ') === '--version') {
        return 'codex-cli 0.132.0\n'
      }
      throw new Error('not found')
    })

    const { detectAgentSdks } = await import('../../../src/main/services/system-info')

    const result = detectAgentSdks({ command: '/usr/local/bin/opencode', shell: false })
    expect(result.codexCli).toBe(false)
  })

  it('offers codex-cli for the first fixed version (0.134.0)', async () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args?.[0] === 'codex') return '/usr/local/bin/codex\n'
      if (_cmd === '/usr/local/bin/codex' && args.join(' ') === '--version') {
        return 'codex-cli 0.134.0\n'
      }
      throw new Error('not found')
    })

    const { detectAgentSdks } = await import('../../../src/main/services/system-info')

    const result = detectAgentSdks({ command: '/usr/local/bin/opencode', shell: false })
    expect(result.codexCli).toBe(true)
  })

  it('returns opencode false when the launch spec is null', async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found')
    })

    const { detectAgentSdks } = await import('../../../src/main/services/system-info')

    // Every probe throws with no output, so hook support can't be confirmed
    // → codex-cli is not offered.
    expect(detectAgentSdks(null)).toEqual({
      opencode: false,
      claude: false,
      codex: false,
      codexCli: false
    })
  })
})

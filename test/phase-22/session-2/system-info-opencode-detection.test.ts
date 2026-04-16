import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockExecFileSync, mockExistsSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockExistsSync: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/tmp'),
    getVersion: vi.fn().mockReturnValue('1.0.0')
  }
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
      throw new Error('not found')
    })

    const { detectAgentSdks } = await import('../../../src/main/services/system-info')

    expect(
      detectAgentSdks({ command: '/usr/local/bin/opencode', shell: false })
    ).toEqual({
      opencode: true,
      claude: true,
      codex: true
    })
  })

  it('returns opencode false when the launch spec is null', async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found')
    })

    const { detectAgentSdks } = await import('../../../src/main/services/system-info')

    expect(detectAgentSdks(null)).toEqual({
      opencode: false,
      claude: false,
      codex: false
    })
  })
})

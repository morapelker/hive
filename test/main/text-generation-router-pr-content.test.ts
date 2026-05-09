// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockRunOnceOptions,
  mockReadFile,
  mockUnlink,
  mockWriteFile,
  mockDetectAgentSdks,
  mockResolveCodexBinaryPath,
  mockGetCodexCliEnv
} = vi.hoisted(() => ({
  mockRunOnceOptions: vi.fn(),
  mockReadFile: vi.fn(),
  mockUnlink: vi.fn(),
  mockWriteFile: vi.fn(),
  mockDetectAgentSdks: vi.fn(),
  mockResolveCodexBinaryPath: vi.fn(),
  mockGetCodexCliEnv: vi.fn(() => ({ PATH: '/mock/bin' }))
}))

vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: mockReadFile,
    unlink: mockUnlink,
    writeFile: mockWriteFile
  }
})

vi.mock('../../src/main/services/system-info', () => ({
  detectAgentSdks: mockDetectAgentSdks
}))

vi.mock('../../src/main/services/codex-binary-resolver', () => ({
  resolveCodexBinaryPath: mockResolveCodexBinaryPath
}))

vi.mock('../../src/main/services/codex-cli-env', () => ({
  getCodexCliEnv: mockGetCodexCliEnv
}))

vi.mock('../../src/main/effect/spawn/runtime', async () => {
  const { Effect, Layer, Stream } = await import('effect')
  const { Spawn } = await import('../../src/main/effect/spawn/service')

  return {
    getRuntime: () => ({
      runPromise: (effect: import('effect').Effect.Effect<unknown, unknown, unknown>) =>
        Effect.runPromise(
          effect.pipe(
            Effect.provide(
              Layer.succeed(Spawn, {
                runOnce: (options) => {
                  mockRunOnceOptions(options)
                  return Effect.succeed({ stdout: '', stderr: '', exitCode: 0 })
                },
                stream: () => Stream.empty
              })
            )
          )
        )
    })
  }
})

describe('text-generation-router codex structured output', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDetectAgentSdks.mockReturnValue({ opencode: false, claude: false, codex: true })
    mockResolveCodexBinaryPath.mockReturnValue(null)
    mockReadFile.mockResolvedValue('{"title":"Refine PR flow","body":"## Summary\\n- Added tests\\n## Testing\\n- Not run"}')
    mockWriteFile.mockResolvedValue(undefined)
    mockUnlink.mockResolvedValue(undefined)
  })

  it('uses output schema for codex when structured output is requested', async () => {
    const { generateText } = await import('../../src/main/services/text-generation-router')

    const result = await generateText(
      'Prompt',
      'System',
      'codex',
      {
        cwd: '/tmp/worktree',
        outputSchema:
          '{"type":"object","properties":{"title":{"type":"string"},"body":{"type":"string"}}}'
      }
    )

    expect(result).toContain('"title":"Refine PR flow"')
    expect(mockRunOnceOptions).toHaveBeenCalledOnce()

    const options = mockRunOnceOptions.mock.calls[0][0]
    expect(options.command).toBe('codex')
    expect(options.args).toContain('exec')
    expect(options.args).toContain('--output-schema')
    expect(options.args).toContain('--output-last-message')
    expect(options.args).toContain('--config')
    expect(options.args).toContain('model_reasoning_effort="low"')
    expect(options.cwd).toBe('/tmp/worktree')
    expect(options.env).toEqual({ PATH: '/mock/bin' })
    expect(mockWriteFile).toHaveBeenCalledTimes(2)
    expect(mockUnlink).toHaveBeenCalledTimes(2)
  })

  it('uses injected codex binary path when provided', async () => {
    const { generateText, setCodexBinaryPath } = await import('../../src/main/services/text-generation-router')
    setCodexBinaryPath('/resolved/codex')

    await generateText('Prompt', 'System', 'codex', { cwd: '/tmp/worktree' })

    expect(mockRunOnceOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        command: '/resolved/codex',
        args: expect.any(Array),
        cwd: '/tmp/worktree',
        env: { PATH: '/mock/bin' }
      })
    )
  })

  it('falls back to resolveCodexBinaryPath when no injected path is set', async () => {
    mockResolveCodexBinaryPath.mockReturnValue('/usr/local/bin/codex')
    const { generateText, setCodexBinaryPath } = await import('../../src/main/services/text-generation-router')
    setCodexBinaryPath(null)

    await generateText('Prompt', 'System', 'codex', { cwd: '/tmp/worktree' })

    expect(mockRunOnceOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        command: '/usr/local/bin/codex',
        args: expect.any(Array),
        cwd: '/tmp/worktree',
        env: { PATH: '/mock/bin' }
      })
    )
  })
})

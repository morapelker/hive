// @vitest-environment node
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockSpawn,
  mockReadFile,
  mockUnlink,
  mockWriteFile,
  mockDetectAgentSdks,
  mockResolveCodexBinaryPath,
  mockGetCodexCliEnv
} = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
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

vi.mock('node:child_process', () => ({
  spawn: mockSpawn
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

function createMockProcess(exitCode = 0): EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: { end: ReturnType<typeof vi.fn> }
  kill: ReturnType<typeof vi.fn>
} {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    stdin: { end: ReturnType<typeof vi.fn> }
    kill: ReturnType<typeof vi.fn>
  }
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.stdin = { end: vi.fn(() => setImmediate(() => proc.emit('close', exitCode))) }
  proc.kill = vi.fn()
  return proc
}

describe('text-generation-router codex structured output', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDetectAgentSdks.mockReturnValue({ opencode: false, claude: false, codex: true })
    mockResolveCodexBinaryPath.mockReturnValue(null)
    mockReadFile.mockResolvedValue('{"title":"Refine PR flow","body":"## Summary\\n- Added tests\\n## Testing\\n- Not run"}')
    mockWriteFile.mockResolvedValue(undefined)
    mockUnlink.mockResolvedValue(undefined)
    mockSpawn.mockImplementation(() => createMockProcess())
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
    expect(mockSpawn).toHaveBeenCalledOnce()

    const [command, args, options] = mockSpawn.mock.calls[0] as [string, string[], { cwd?: string; env?: Record<string, string> }]
    expect(command).toBe('codex')
    expect(args).toContain('exec')
    expect(args).toContain('--output-schema')
    expect(args).toContain('--output-last-message')
    expect(args).toContain('--config')
    expect(args).toContain('model_reasoning_effort="low"')
    expect(options.cwd).toBe('/tmp/worktree')
    expect(options.env).toEqual({ PATH: '/mock/bin' })
    expect(mockWriteFile).toHaveBeenCalledTimes(2)
    expect(mockUnlink).toHaveBeenCalledTimes(2)
  })

  it('uses injected codex binary path when provided', async () => {
    const { generateText, setCodexBinaryPath } = await import('../../src/main/services/text-generation-router')
    setCodexBinaryPath('/resolved/codex')

    await generateText('Prompt', 'System', 'codex', { cwd: '/tmp/worktree' })

    expect(mockSpawn).toHaveBeenCalledWith(
      '/resolved/codex',
      expect.any(Array),
      expect.objectContaining({ cwd: '/tmp/worktree', env: { PATH: '/mock/bin' } })
    )
  })

  it('falls back to resolveCodexBinaryPath when no injected path is set', async () => {
    mockResolveCodexBinaryPath.mockReturnValue('/usr/local/bin/codex')
    const { generateText, setCodexBinaryPath } = await import('../../src/main/services/text-generation-router')
    setCodexBinaryPath(null)

    await generateText('Prompt', 'System', 'codex', { cwd: '/tmp/worktree' })

    expect(mockSpawn).toHaveBeenCalledWith(
      '/usr/local/bin/codex',
      expect.any(Array),
      expect.objectContaining({ cwd: '/tmp/worktree', env: { PATH: '/mock/bin' } })
    )
  })
})

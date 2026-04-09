// @vitest-environment node
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockSpawn, mockReadFile, mockUnlink, mockWriteFile, mockDetectAgentSdks } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockReadFile: vi.fn(),
  mockUnlink: vi.fn(),
  mockWriteFile: vi.fn(),
  mockDetectAgentSdks: vi.fn()
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
      undefined,
      '{"type":"object","properties":{"title":{"type":"string"},"body":{"type":"string"}}}'
    )

    expect(result).toContain('"title":"Refine PR flow"')
    expect(mockSpawn).toHaveBeenCalledOnce()

    const [, args] = mockSpawn.mock.calls[0] as [string, string[]]
    expect(args).toContain('exec')
    expect(args).toContain('--output-schema')
    expect(args).toContain('--output-last-message')
    expect(args).toContain('--config')
    expect(args).toContain('model_reasoning_effort="low"')
    expect(mockWriteFile).toHaveBeenCalledTimes(2)
    expect(mockUnlink).toHaveBeenCalledTimes(2)
  })
})

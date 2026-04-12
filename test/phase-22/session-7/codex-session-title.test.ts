// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockSpawnCLI, mockExtractTitle, mockSanitize } = vi.hoisted(() => ({
  mockSpawnCLI: vi.fn(),
  mockExtractTitle: vi.fn(),
  mockSanitize: vi.fn()
}))

const { mockResolveCodexBinaryPath, mockGetCodexCliEnv } = vi.hoisted(() => ({
  mockResolveCodexBinaryPath: vi.fn(),
  mockGetCodexCliEnv: vi.fn(() => ({ PATH: '/mock/bin' }))
}))

const { mockWriteFile, mockReadFile, mockUnlink } = vi.hoisted(() => ({
  mockWriteFile: vi.fn(),
  mockReadFile: vi.fn(),
  mockUnlink: vi.fn()
}))

const { mockLogInfo, mockLogWarn, mockLogCodexLifecycleEvent } = vi.hoisted(() => ({
  mockLogInfo: vi.fn(),
  mockLogWarn: vi.fn(),
  mockLogCodexLifecycleEvent: vi.fn()
}))

vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: mockLogInfo,
    warn: mockLogWarn,
    error: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('../../../src/main/services/title-generation-shared', async (importOriginal) => {
  const actual = await importOriginal() as any
  return {
    ...actual,
    spawnCLI: mockSpawnCLI,
    extractTitleFromJSON: mockExtractTitle,
    sanitizeTitle: mockSanitize,
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal() as any
  return {
    ...actual,
    writeFile: mockWriteFile,
    readFile: mockReadFile,
    unlink: mockUnlink
  }
})

vi.mock('../../../src/main/services/codex-debug-logger', () => ({
  logCodexLifecycleEvent: mockLogCodexLifecycleEvent
}))

vi.mock('../../../src/main/services/codex-binary-resolver', () => ({
  resolveCodexBinaryPath: mockResolveCodexBinaryPath
}))

vi.mock('../../../src/main/services/codex-cli-env', () => ({
  getCodexCliEnv: mockGetCodexCliEnv
}))

describe('generateCodexSessionTitle', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockWriteFile.mockResolvedValue(undefined)
    mockReadFile.mockResolvedValue('{"title":"Test title"}')
    mockUnlink.mockResolvedValue(undefined)
    mockSpawnCLI.mockResolvedValue('')
    mockExtractTitle.mockReturnValue('Test title')
    mockSanitize.mockReturnValue('Test title')
    mockResolveCodexBinaryPath.mockReturnValue(null)
  })

  it('returns sanitized title on success', async () => {
    mockReadFile.mockResolvedValue('{"title":"Auth fix"}')
    mockExtractTitle.mockReturnValue('Auth fix')
    mockSanitize.mockReturnValue('Auth fix')

    const { generateCodexSessionTitle } = await import(
      '../../../src/main/services/codex-session-title'
    )

    const result = await generateCodexSessionTitle('Fix auth refresh token bug')
    expect(result).toBe('Auth fix')
    expect(mockLogInfo).toHaveBeenCalledWith(
      'generateCodexSessionTitle: starting',
      expect.objectContaining({ messageLength: 'Fix auth refresh token bug'.length })
    )
    expect(mockLogInfo).toHaveBeenCalledWith(
      'generateCodexSessionTitle: sanitized title',
      { rawTitle: 'Auth fix', title: 'Auth fix' }
    )
    expect(mockLogCodexLifecycleEvent).toHaveBeenCalledWith(
      'title/output_read',
      expect.objectContaining({ outputLength: '{"title":"Auth fix"}'.length })
    )
  })

  it('calls spawnCLI with correct codex args', async () => {
    const { generateCodexSessionTitle } = await import(
      '../../../src/main/services/codex-session-title'
    )

    await generateCodexSessionTitle('Some message', '/tmp/worktree')

    expect(mockSpawnCLI).toHaveBeenCalledOnce()
    const [command, args, , timeoutMs, cwd, env] = mockSpawnCLI.mock.calls[0]
    expect(command).toBe('codex')
    expect(args).toContain('exec')
    expect(args).toContain('--ephemeral')
    expect(args).toContain('-s')
    expect(args).toContain('read-only')
    expect(args).toContain('--model')
    expect(args).toContain('gpt-5.4-mini')
    expect(args).toContain('--config')
    expect(args).toContain('model_reasoning_effort="low"')
    expect(args).toContain('--output-schema')
    expect(args).toContain('--output-last-message')
    expect(timeoutMs).toBeDefined()
    expect(cwd).toBe('/tmp/worktree')
    expect(env).toEqual({ PATH: '/mock/bin' })
  })

  it('uses provided codexBinaryPath when given', async () => {
    const { generateCodexSessionTitle } = await import(
      '../../../src/main/services/codex-session-title'
    )

    await generateCodexSessionTitle('Some message', '/tmp/worktree', '/usr/local/bin/codex')

    expect(mockSpawnCLI).toHaveBeenCalledWith(
      '/usr/local/bin/codex',
      expect.any(Array),
      expect.any(String),
      expect.any(Number),
      '/tmp/worktree',
      { PATH: '/mock/bin' }
    )
  })

  it('falls back to resolveCodexBinaryPath() when no path is provided', async () => {
    mockResolveCodexBinaryPath.mockReturnValue('/resolved/codex')
    const { generateCodexSessionTitle } = await import(
      '../../../src/main/services/codex-session-title'
    )

    await generateCodexSessionTitle('Some message', '/tmp/worktree')

    expect(mockSpawnCLI).toHaveBeenCalledWith(
      '/resolved/codex',
      expect.any(Array),
      expect.any(String),
      expect.any(Number),
      '/tmp/worktree',
      { PATH: '/mock/bin' }
    )
  })

  it('writes schema JSON to temp file', async () => {
    const { generateCodexSessionTitle } = await import(
      '../../../src/main/services/codex-session-title'
    )
    const { TITLE_JSON_SCHEMA } = await import(
      '../../../src/main/services/title-generation-shared'
    )

    await generateCodexSessionTitle('Test message')

    const schemaWriteCall = mockWriteFile.mock.calls.find(
      (call: any[]) => call[1] === TITLE_JSON_SCHEMA
    )
    expect(schemaWriteCall).toBeTruthy()
  })

  it('creates empty output file', async () => {
    const { generateCodexSessionTitle } = await import(
      '../../../src/main/services/codex-session-title'
    )

    await generateCodexSessionTitle('Test message')

    expect(mockWriteFile).toHaveBeenCalledTimes(2)
    const emptyWriteCall = mockWriteFile.mock.calls.find(
      (call: any[]) => call[1] === ''
    )
    expect(emptyWriteCall).toBeTruthy()
  })

  it('cleans up both temp files on success', async () => {
    const { generateCodexSessionTitle } = await import(
      '../../../src/main/services/codex-session-title'
    )

    await generateCodexSessionTitle('Test message')

    expect(mockUnlink).toHaveBeenCalledTimes(2)
  })

  it('cleans up temp files on failure', async () => {
    mockSpawnCLI.mockRejectedValue(new Error('spawn failed'))

    const { generateCodexSessionTitle } = await import(
      '../../../src/main/services/codex-session-title'
    )

    await generateCodexSessionTitle('Test message')

    expect(mockUnlink).toHaveBeenCalledTimes(2)
  })

  it('returns null when spawnCLI throws', async () => {
    mockSpawnCLI.mockRejectedValue(new Error('CLI error'))

    const { generateCodexSessionTitle } = await import(
      '../../../src/main/services/codex-session-title'
    )

    const result = await generateCodexSessionTitle('Test message')
    expect(result).toBeNull()
  })

  it('returns null when readFile fails', async () => {
    mockReadFile.mockRejectedValue(new Error('read failed'))

    const { generateCodexSessionTitle } = await import(
      '../../../src/main/services/codex-session-title'
    )

    const result = await generateCodexSessionTitle('Test message')
    expect(result).toBeNull()
  })

  it('returns null when extractTitleFromJSON returns null', async () => {
    mockExtractTitle.mockReturnValue(null)

    const { generateCodexSessionTitle } = await import(
      '../../../src/main/services/codex-session-title'
    )

    const result = await generateCodexSessionTitle('Test message')
    expect(result).toBeNull()
    expect(mockLogWarn).toHaveBeenCalledWith(
      'generateCodexSessionTitle: no title extracted from output',
      expect.objectContaining({ outputPreview: '{"title":"Test title"}' })
    )
    expect(mockLogCodexLifecycleEvent).toHaveBeenCalledWith(
      'title/extract_failed',
      expect.objectContaining({ outputPreview: '{"title":"Test title"}' })
    )
  })

  it('never throws, always returns null on error', async () => {
    mockWriteFile.mockRejectedValue(new Error('write failed'))

    const { generateCodexSessionTitle } = await import(
      '../../../src/main/services/codex-session-title'
    )

    const result = await generateCodexSessionTitle('Test message')
    expect(result).toBeNull()
  })

  it('logs structured spawn failure details', async () => {
    const { SpawnCliError } = await import('../../../src/main/services/title-generation-shared')
    mockSpawnCLI.mockRejectedValue(
      new SpawnCliError('codex exited with code 1: boom', {
        kind: 'non_zero_exit',
        command: 'codex',
        code: 1,
        stdoutPreview: 'stdout preview',
        stderrPreview: 'stderr preview',
        cwd: '/tmp/worktree'
      })
    )

    const { generateCodexSessionTitle } = await import(
      '../../../src/main/services/codex-session-title'
    )

    const result = await generateCodexSessionTitle('Test message', '/tmp/worktree')
    expect(result).toBeNull()
    expect(mockLogWarn).toHaveBeenCalledWith(
      'generateCodexSessionTitle: failed',
      expect.objectContaining({
        cwd: '/tmp/worktree',
        error: 'codex exited with code 1: boom',
        kind: 'non_zero_exit',
        code: 1,
        stdoutPreview: 'stdout preview',
        stderrPreview: 'stderr preview'
      })
    )
    expect(mockLogCodexLifecycleEvent).toHaveBeenCalledWith(
      'title/spawn_failure',
      expect.objectContaining({
        cwd: '/tmp/worktree',
        kind: 'non_zero_exit',
        code: 1
      })
    )
  })
})

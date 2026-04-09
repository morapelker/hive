// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockSpawnCLI, mockExtractTitle, mockSanitize } = vi.hoisted(() => ({
  mockSpawnCLI: vi.fn(),
  mockExtractTitle: vi.fn(),
  mockSanitize: vi.fn()
}))

const { mockWriteFile, mockReadFile, mockUnlink } = vi.hoisted(() => ({
  mockWriteFile: vi.fn(),
  mockReadFile: vi.fn(),
  mockUnlink: vi.fn()
}))

vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
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
  })

  it('calls spawnCLI with correct codex args', async () => {
    const { generateCodexSessionTitle } = await import(
      '../../../src/main/services/codex-session-title'
    )

    await generateCodexSessionTitle('Some message')

    expect(mockSpawnCLI).toHaveBeenCalledOnce()
    const [command, args] = mockSpawnCLI.mock.calls[0]
    expect(command).toBe('codex')
    expect(args).toContain('exec')
    expect(args).toContain('--ephemeral')
    expect(args).toContain('-s')
    expect(args).toContain('read-only')
    expect(args).toContain('--model')
    expect(args).toContain('gpt-5.4')
    expect(args).toContain('--config')
    expect(args).toContain('model_reasoning_effort="low"')
    expect(args).toContain('--output-schema')
    expect(args).toContain('--output-last-message')
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
  })

  it('never throws, always returns null on error', async () => {
    mockWriteFile.mockRejectedValue(new Error('write failed'))

    const { generateCodexSessionTitle } = await import(
      '../../../src/main/services/codex-session-title'
    )

    const result = await generateCodexSessionTitle('Test message')
    expect(result).toBeNull()
  })
})

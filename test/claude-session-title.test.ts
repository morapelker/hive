import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mock references (available to vi.mock factories) ───────────

const { mockSpawnCLI, mockExtractTitle, mockSanitize, mockResolveBinary } = vi.hoisted(() => ({
  mockSpawnCLI: vi.fn(),
  mockExtractTitle: vi.fn(),
  mockSanitize: vi.fn(),
  mockResolveBinary: vi.fn()
}))

// ── Mocks ──────────────────────────────────────────────────────────────

vi.mock('../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('../src/main/services/title-generation-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/services/title-generation-shared')>()
  return {
    ...actual,
    spawnCLI: mockSpawnCLI,
    extractTitleFromJSON: mockExtractTitle,
    sanitizeTitle: mockSanitize,
  }
})

vi.mock('../src/main/services/claude-binary-resolver', () => ({
  resolveClaudeBinaryPath: mockResolveBinary
}))

// ── Tests ──────────────────────────────────────────────────────────────

describe('generateSessionTitle', () => {
  let generateSessionTitle: typeof import('../src/main/services/claude-session-title').generateSessionTitle

  beforeEach(async () => {
    vi.clearAllMocks()
    mockSpawnCLI.mockResolvedValue('{"structured_output":{"title":"Test title"}}')
    mockExtractTitle.mockReturnValue('Test title')
    mockSanitize.mockReturnValue('Test title')
    mockResolveBinary.mockReturnValue(null)

    const mod = await import('../src/main/services/claude-session-title')
    generateSessionTitle = mod.generateSessionTitle
  })

  // ── Happy path ──────────────────────────────────────────────────────

  it('returns sanitized title when spawnCLI succeeds', async () => {
    mockSpawnCLI.mockResolvedValue('json output')
    mockExtractTitle.mockReturnValue('Fix auth bug')
    mockSanitize.mockReturnValue('Fix auth bug')

    const result = await generateSessionTitle('Fix the auth token refresh bug')
    expect(result).toBe('Fix auth bug')
  })

  // ── CLI args verification ──────────────────────────────────────────

  it('calls spawnCLI with correct args', async () => {
    await generateSessionTitle('hello')

    const { TITLE_JSON_SCHEMA, TITLE_TIMEOUT_MS } = await import('../src/main/services/title-generation-shared')

    expect(mockSpawnCLI).toHaveBeenCalledWith(
      expect.any(String),
      ['-p', '--output-format', 'json', '--json-schema', TITLE_JSON_SCHEMA, '--model', 'haiku', '--effort', 'low', '--dangerously-skip-permissions', '--no-session-persistence', '--tools', ''],
      expect.any(String),
      TITLE_TIMEOUT_MS
    )
  })

  // ── Binary resolution ──────────────────────────────────────────────

  it('uses provided claudeBinaryPath when given', async () => {
    await generateSessionTitle('hello', '/usr/local/bin/claude')

    expect(mockSpawnCLI).toHaveBeenCalledWith(
      '/usr/local/bin/claude',
      expect.any(Array),
      expect.any(String),
      expect.any(Number)
    )
  })

  it('falls back to resolveClaudeBinaryPath() when no path given', async () => {
    mockResolveBinary.mockReturnValue('/resolved/claude')

    await generateSessionTitle('hello')

    expect(mockSpawnCLI).toHaveBeenCalledWith(
      '/resolved/claude',
      expect.any(Array),
      expect.any(String),
      expect.any(Number)
    )
  })

  it('falls back to "claude" when both are null', async () => {
    mockResolveBinary.mockReturnValue(null)

    await generateSessionTitle('hello')

    expect(mockSpawnCLI).toHaveBeenCalledWith(
      'claude',
      expect.any(Array),
      expect.any(String),
      expect.any(Number)
    )
  })

  // ── Null-return cases ──────────────────────────────────────────────

  it('returns null when spawnCLI throws', async () => {
    mockSpawnCLI.mockRejectedValue(new Error('spawn failed'))

    const result = await generateSessionTitle('hello')
    expect(result).toBeNull()
  })

  it('returns null when extractTitleFromJSON returns null', async () => {
    mockExtractTitle.mockReturnValue(null)

    const result = await generateSessionTitle('hello')
    expect(result).toBeNull()
  })

  it('returns null when sanitizeTitle returns null', async () => {
    mockExtractTitle.mockReturnValue('some raw title')
    mockSanitize.mockReturnValue(null)

    const result = await generateSessionTitle('hello')
    expect(result).toBeNull()
  })

  // ── Message truncation ────────────────────────────────────────────

  it('truncates messages longer than 2000 characters', async () => {
    const longMessage = 'x'.repeat(5000)
    await generateSessionTitle(longMessage)

    const prompt = mockSpawnCLI.mock.calls[0][2] as string
    // The prompt should contain the truncation marker
    expect(prompt).toContain('...')
    // Full 5000 char message should NOT be present
    expect(prompt).not.toContain(longMessage)
    // But the first 2000 chars should be
    expect(prompt).toContain(longMessage.slice(0, 2000))
  })

  it('does not truncate short messages', async () => {
    const shortMessage = 'Fix the bug'
    await generateSessionTitle(shortMessage)

    const prompt = mockSpawnCLI.mock.calls[0][2] as string
    expect(prompt).toContain(shortMessage)
    // Should not have the truncation ellipsis appended to the message
    expect(prompt).toContain('User message:\n' + shortMessage)
  })

  // ── Never throws ──────────────────────────────────────────────────

  it('returns null on any error, never throws', async () => {
    mockSpawnCLI.mockRejectedValue(new Error('total explosion'))

    const result = await generateSessionTitle('message')
    expect(result).toBeNull()
  })
})

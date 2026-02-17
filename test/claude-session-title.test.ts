/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mock references (available to vi.mock factories) ───────────

const { mockQuery, mockMkdirSync, mockLoadClaudeSDK, mockHomedir } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockLoadClaudeSDK: vi.fn(async () => ({ query: mockQuery })),
  mockHomedir: vi.fn(() => '/mock-home')
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

vi.mock('../src/main/services/claude-sdk-loader', () => ({
  loadClaudeSDK: mockLoadClaudeSDK
}))

vi.mock('node:fs', () => {
  const fsMock = {
    mkdirSync: mockMkdirSync,
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn()
  }
  return { ...fsMock, default: fsMock }
})

vi.mock('node:os', () => {
  const osMock = { homedir: mockHomedir }
  return { ...osMock, default: osMock }
})

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Make sdk.query() return an async generator that yields a single result message.
 */
function mockQueryResult(text: string): void {
  mockQuery.mockReturnValue(
    (async function* () {
      yield { type: 'result', result: text }
    })()
  )
}

/**
 * Make sdk.query() throw an error (thrown from within the async generator).
 */
function mockQueryError(err: Error): void {
  mockQuery.mockReturnValue(
    (async function* () {
      throw err
    })()
  )
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('generateSessionTitle', () => {
  let generateSessionTitle: typeof import('../src/main/services/claude-session-title').generateSessionTitle

  beforeEach(async () => {
    vi.clearAllMocks()
    mockLoadClaudeSDK.mockImplementation(async () => ({ query: mockQuery }))

    const mod = await import('../src/main/services/claude-session-title')
    generateSessionTitle = mod.generateSessionTitle
  })

  // ── Happy path ──────────────────────────────────────────────────────

  it('returns trimmed title on successful SDK query', async () => {
    mockQueryResult('  Fix auth token refresh  \n')
    const result = await generateSessionTitle('Fix the auth token refresh bug')
    expect(result).toBe('Fix auth token refresh')
  })

  it('returns title with no extra whitespace', async () => {
    mockQueryResult('Add dark mode toggle')
    const result = await generateSessionTitle('I want to add dark mode')
    expect(result).toBe('Add dark mode toggle')
  })

  // ── Null-return cases ──────────────────────────────────────────────

  it('returns null on empty SDK result', async () => {
    mockQueryResult('')
    const result = await generateSessionTitle('message')
    expect(result).toBeNull()
  })

  it('returns null on whitespace-only SDK result', async () => {
    mockQueryResult('   \n  ')
    const result = await generateSessionTitle('message')
    expect(result).toBeNull()
  })

  it('returns null when title exceeds 50 characters', async () => {
    const longTitle = 'A'.repeat(51)
    mockQueryResult(longTitle)
    const result = await generateSessionTitle('message')
    expect(result).toBeNull()
  })

  it('returns title when exactly 50 characters', async () => {
    const exactTitle = 'A'.repeat(50)
    mockQueryResult(exactTitle)
    const result = await generateSessionTitle('message')
    expect(result).toBe(exactTitle)
  })

  it('returns null when SDK query throws', async () => {
    mockQueryError(new Error('SDK query failed'))
    const result = await generateSessionTitle('message')
    expect(result).toBeNull()
  })

  // ── Message truncation ────────────────────────────────────────────

  it('truncates messages longer than 2000 characters', async () => {
    mockQueryResult('Some title')
    const longMessage = 'x'.repeat(5000)
    await generateSessionTitle(longMessage)

    const callArgs = mockQuery.mock.calls[0][0]
    const prompt: string = callArgs.prompt
    // The prompt should contain the truncated message (2000 chars + '...')
    expect(prompt).toContain('...')
    // Full 5000 char message should NOT be present
    expect(prompt).not.toContain(longMessage)
    // But the first 2000 chars should be
    expect(prompt).toContain(longMessage.slice(0, 2000))
  })

  it('does not truncate messages under 2000 characters', async () => {
    mockQueryResult('Some title')
    const shortMessage = 'Fix the bug'
    await generateSessionTitle(shortMessage)

    const callArgs = mockQuery.mock.calls[0][0]
    const prompt: string = callArgs.prompt
    expect(prompt).toContain(shortMessage)
    expect(prompt).not.toContain('...')
  })

  // ── Never throws ──────────────────────────────────────────────────

  it('never throws — always returns string or null', async () => {
    // Even when loadClaudeSDK itself throws
    mockLoadClaudeSDK.mockRejectedValueOnce(new Error('SDK load explosion'))
    const result = await generateSessionTitle('message')
    expect(result).toBeNull()
  })

  // ── SDK-specific behavior ─────────────────────────────────────────

  it('uses model: "haiku" in query options', async () => {
    mockQueryResult('Some title')
    await generateSessionTitle('hello')

    const callArgs = mockQuery.mock.calls[0][0]
    expect(callArgs.options.model).toBe('haiku')
  })

  it('sets cwd to ~/.hive/titles/ path', async () => {
    mockQueryResult('Some title')
    await generateSessionTitle('hello')

    const callArgs = mockQuery.mock.calls[0][0]
    expect(callArgs.options.cwd).toBe('/mock-home/.hive/titles')
  })

  it('passes maxTurns: 1 in query options', async () => {
    mockQueryResult('Some title')
    await generateSessionTitle('hello')

    const callArgs = mockQuery.mock.calls[0][0]
    expect(callArgs.options.maxTurns).toBe(1)
  })

  it('passes pathToClaudeCodeExecutable when claudeBinaryPath is provided', async () => {
    mockQueryResult('Some title')
    await generateSessionTitle('hello', '/custom/path/claude')

    const callArgs = mockQuery.mock.calls[0][0]
    expect(callArgs.options.pathToClaudeCodeExecutable).toBe('/custom/path/claude')
  })

  it('omits pathToClaudeCodeExecutable when claudeBinaryPath is null', async () => {
    mockQueryResult('Some title')
    await generateSessionTitle('hello', null)

    const callArgs = mockQuery.mock.calls[0][0]
    expect(callArgs.options.pathToClaudeCodeExecutable).toBeUndefined()
  })

  it('omits pathToClaudeCodeExecutable when claudeBinaryPath is undefined', async () => {
    mockQueryResult('Some title')
    await generateSessionTitle('hello')

    const callArgs = mockQuery.mock.calls[0][0]
    expect(callArgs.options.pathToClaudeCodeExecutable).toBeUndefined()
  })

  it('creates ~/.hive/titles/ directory if it does not exist', async () => {
    mockQueryResult('Some title')
    await generateSessionTitle('hello')

    expect(mockMkdirSync).toHaveBeenCalledWith('/mock-home/.hive/titles', { recursive: true })
  })

  it('aborts query via AbortController after timeout', async () => {
    mockQueryResult('Some title')
    await generateSessionTitle('hello')

    const callArgs = mockQuery.mock.calls[0][0]
    expect(callArgs.options.abortController).toBeDefined()
    expect(callArgs.options.abortController).toBeInstanceOf(AbortController)
  })
})

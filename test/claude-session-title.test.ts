import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mock references (available to vi.mock factories) ───────────

const { mockQuery, mockLoadClaudeSDK, mockHomedir } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
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

vi.mock('node:os', () => {
  const osMock = { homedir: mockHomedir }
  return { ...osMock, default: osMock }
})

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Make sdk.query() return an async generator that yields a single result message.
 * When called multiple times (for retries), each call returns a fresh generator.
 */
function mockQueryResult(text: string): void {
  mockQuery.mockImplementation(() =>
    (async function* () {
      yield { type: 'result', result: text }
    })()
  )
}

/**
 * Make sdk.query() throw an error (thrown from within the async generator).
 * When called multiple times (for retries), each call throws.
 */
function mockQueryError(err: Error): void {
  mockQuery.mockImplementation(() => ({
    async next() {
      throw err
    },
    [Symbol.asyncIterator]() {
      return this
    }
  }))
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

  // ── Post-processing ────────────────────────────────────────────────

  it('strips <think> tags from response', async () => {
    mockQueryResult('<think>reasoning here</think>Fix auth bug')
    const result = await generateSessionTitle('message')
    expect(result).toBe('Fix auth bug')
  })

  it('strips multiline <think> tags', async () => {
    mockQueryResult('<think>\nsome reasoning\nacross lines\n</think>\nDatabase migration')
    const result = await generateSessionTitle('message')
    expect(result).toBe('Database migration')
  })

  it('takes first non-empty line from multiline response', async () => {
    mockQueryResult('\n\n  Fix auth bug  \nAnother line\n')
    const result = await generateSessionTitle('message')
    expect(result).toBe('Fix auth bug')
  })

  it('truncates titles longer than 100 chars to 97 + "..."', async () => {
    const longTitle = 'A'.repeat(110)
    mockQueryResult(longTitle)
    const result = await generateSessionTitle('message')
    expect(result).toBe('A'.repeat(97) + '...')
    expect(result!.length).toBe(100)
  })

  it('returns full title when exactly 100 characters', async () => {
    const exactTitle = 'A'.repeat(100)
    mockQueryResult(exactTitle)
    const result = await generateSessionTitle('message')
    expect(result).toBe(exactTitle)
  })

  it('returns full title when under 100 characters', async () => {
    const shortTitle = 'A'.repeat(50)
    mockQueryResult(shortTitle)
    const result = await generateSessionTitle('message')
    expect(result).toBe(shortTitle)
  })

  // ── Null-return cases ──────────────────────────────────────────────

  it('returns null on empty SDK result after all retries', async () => {
    mockQueryResult('')
    const result = await generateSessionTitle('message')
    expect(result).toBeNull()
  })

  it('returns null on whitespace-only SDK result after all retries', async () => {
    mockQueryResult('   \n  ')
    const result = await generateSessionTitle('message')
    expect(result).toBeNull()
  })

  it('returns null when SDK query throws after all retries', async () => {
    mockQueryError(new Error('SDK query failed'))
    const result = await generateSessionTitle('message')
    expect(result).toBeNull()
  })

  // ── Retry behavior ────────────────────────────────────────────────

  it('retries up to 3 times total (2 retries) on failure', async () => {
    mockQueryError(new Error('fail'))
    await generateSessionTitle('message')
    // Should have been called 3 times (1 initial + 2 retries)
    expect(mockQuery).toHaveBeenCalledTimes(3)
  })

  it('retries up to 3 times on empty results', async () => {
    mockQueryResult('')
    await generateSessionTitle('message')
    expect(mockQuery).toHaveBeenCalledTimes(3)
  })

  it('returns on first successful attempt without retrying', async () => {
    mockQueryResult('Good title')
    const result = await generateSessionTitle('message')
    expect(result).toBe('Good title')
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  it('succeeds on second attempt after first failure', async () => {
    let callCount = 0
    mockQuery.mockImplementation(() =>
      (async function* () {
        callCount++
        if (callCount === 1) {
          yield { type: 'result', result: '' }
        } else {
          yield { type: 'result', result: 'Recovered title' }
        }
      })()
    )
    const result = await generateSessionTitle('message')
    expect(result).toBe('Recovered title')
    expect(mockQuery).toHaveBeenCalledTimes(2)
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
  })

  // ── User message format ────────────────────────────────────────────

  it('formats user prompt with "Generate a title" prefix', async () => {
    mockQueryResult('Some title')
    await generateSessionTitle('hello world')

    const callArgs = mockQuery.mock.calls[0][0]
    expect(callArgs.prompt).toContain('Generate a title for this conversation:')
    expect(callArgs.prompt).toContain('hello world')
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

  it('sets cwd to homedir()', async () => {
    mockQueryResult('Some title')
    await generateSessionTitle('hello')

    const callArgs = mockQuery.mock.calls[0][0]
    expect(callArgs.options.cwd).toBe('/mock-home')
  })

  it('passes maxTurns: 1 in query options', async () => {
    mockQueryResult('Some title')
    await generateSessionTitle('hello')

    const callArgs = mockQuery.mock.calls[0][0]
    expect(callArgs.options.maxTurns).toBe(1)
  })

  it('passes systemPrompt in query options', async () => {
    mockQueryResult('Some title')
    await generateSessionTitle('hello')

    const callArgs = mockQuery.mock.calls[0][0]
    expect(callArgs.options.systemPrompt).toBeDefined()
    expect(callArgs.options.systemPrompt).toContain('You are a title generator')
  })

  it('passes effort: "low" in query options', async () => {
    mockQueryResult('Some title')
    await generateSessionTitle('hello')

    const callArgs = mockQuery.mock.calls[0][0]
    expect(callArgs.options.effort).toBe('low')
  })

  it('disables thinking in query options', async () => {
    mockQueryResult('Some title')
    await generateSessionTitle('hello')

    const callArgs = mockQuery.mock.calls[0][0]
    expect(callArgs.options.thinking).toEqual({ type: 'disabled' })
  })

  it('disables all tools in query options', async () => {
    mockQueryResult('Some title')
    await generateSessionTitle('hello')

    const callArgs = mockQuery.mock.calls[0][0]
    expect(callArgs.options.tools).toEqual([])
  })

  it('disables session persistence', async () => {
    mockQueryResult('Some title')
    await generateSessionTitle('hello')

    const callArgs = mockQuery.mock.calls[0][0]
    expect(callArgs.options.persistSession).toBe(false)
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

  it('aborts query via AbortController after timeout', async () => {
    mockQueryResult('Some title')
    await generateSessionTitle('hello')

    const callArgs = mockQuery.mock.calls[0][0]
    expect(callArgs.options.abortController).toBeDefined()
    expect(callArgs.options.abortController).toBeInstanceOf(AbortController)
  })
})

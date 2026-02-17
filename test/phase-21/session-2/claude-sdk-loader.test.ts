import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the logger (depends on electron's app)
vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

// Mock the dynamic import
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn()
}))

describe('Claude SDK Loader', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('loadClaudeSDK returns the query function', async () => {
    const { loadClaudeSDK } = await import('../../../src/main/services/claude-sdk-loader')
    const sdk = await loadClaudeSDK()
    expect(sdk).toBeDefined()
    expect(typeof sdk.query).toBe('function')
  })

  it('loadClaudeSDK caches the result on repeated calls', async () => {
    const { loadClaudeSDK } = await import('../../../src/main/services/claude-sdk-loader')
    const sdk1 = await loadClaudeSDK()
    const sdk2 = await loadClaudeSDK()
    expect(sdk1).toBe(sdk2)
  })

  it('loadClaudeSDK rejects with descriptive error when SDK not available', async () => {
    vi.doMock('@anthropic-ai/claude-agent-sdk', () => {
      throw new Error('Cannot find module')
    })
    // Need fresh import to pick up doMock
    const { loadClaudeSDK: loadFresh } =
      await import('../../../src/main/services/claude-sdk-loader')
    await expect(loadFresh()).rejects.toThrow(/Claude Code SDK/)
  })
})

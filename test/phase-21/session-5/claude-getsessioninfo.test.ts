import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('../../../src/main/services/claude-sdk-loader', () => ({
  loadClaudeSDK: vi.fn()
}))

vi.mock('../../../src/main/services/claude-transcript-reader', () => ({
  readClaudeTranscript: vi.fn().mockResolvedValue([]),
  translateEntry: vi.fn().mockReturnValue(null)
}))

import { ClaudeCodeImplementer } from '../../../src/main/services/claude-code-implementer'

describe('ClaudeCodeImplementer.getSessionInfo', () => {
  let implementer: ClaudeCodeImplementer

  beforeEach(() => {
    vi.resetAllMocks()
    implementer = new ClaudeCodeImplementer()
  })

  // 1. Returns null revert fields
  it('returns null revert fields', async () => {
    const result = await implementer.getSessionInfo('/test/project', 'session-123')
    expect(result).toEqual({ revertMessageID: null, revertDiff: null })
  })

  // 2. Does not throw
  it('does not throw', async () => {
    await expect(implementer.getSessionInfo('/test/project', 'session-123')).resolves.not.toThrow()
  })

  // 3. Returns consistent shape regardless of arguments
  it('returns consistent shape regardless of arguments', async () => {
    const result1 = await implementer.getSessionInfo('/path/a', 'sid-1')
    const result2 = await implementer.getSessionInfo('/path/b', 'sid-2')
    const result3 = await implementer.getSessionInfo('', '')

    expect(result1).toEqual({ revertMessageID: null, revertDiff: null })
    expect(result2).toEqual({ revertMessageID: null, revertDiff: null })
    expect(result3).toEqual({ revertMessageID: null, revertDiff: null })

    // Same shape
    expect(Object.keys(result1)).toEqual(['revertMessageID', 'revertDiff'])
    expect(Object.keys(result2)).toEqual(['revertMessageID', 'revertDiff'])
    expect(Object.keys(result3)).toEqual(['revertMessageID', 'revertDiff'])
  })
})

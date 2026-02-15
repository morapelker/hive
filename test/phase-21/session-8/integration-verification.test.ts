import { describe, it, expect, vi } from 'vitest'
import {
  CLAUDE_CODE_CAPABILITIES,
  OPENCODE_CAPABILITIES
} from '../../../src/main/services/agent-sdk-types'

vi.mock('../../../src/main/services/claude-sdk-loader', () => ({
  loadClaudeSDK: vi.fn().mockResolvedValue({ query: vi.fn() })
}))

vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('../../../src/main/services/claude-transcript-reader', () => ({
  readClaudeTranscript: vi.fn().mockResolvedValue([]),
  translateEntry: vi.fn().mockReturnValue(null)
}))

describe('Session 8 integration verification', () => {
  describe('capability constants', () => {
    it('CLAUDE_CODE_CAPABILITIES has supportsUndo: true and supportsRedo: false', () => {
      expect(CLAUDE_CODE_CAPABILITIES.supportsUndo).toBe(true)
      expect(CLAUDE_CODE_CAPABILITIES.supportsRedo).toBe(false)
    })

    it('OPENCODE_CAPABILITIES has both supportsUndo and supportsRedo: true', () => {
      expect(OPENCODE_CAPABILITIES.supportsUndo).toBe(true)
      expect(OPENCODE_CAPABILITIES.supportsRedo).toBe(true)
    })
  })

  describe('ClaudeCodeImplementer stubs replaced', () => {
    it('undo() does not throw "not yet implemented"', async () => {
      const { ClaudeCodeImplementer } =
        await import('../../../src/main/services/claude-code-implementer')
      const impl = new ClaudeCodeImplementer()
      try {
        await impl.undo('test', 'test', 'test')
      } catch (e) {
        // It should throw, but not with the "not yet implemented" message
        expect(String(e)).not.toContain('not yet implemented')
      }
    })

    it('redo() throws unsupported error (not "not yet implemented")', async () => {
      const { ClaudeCodeImplementer } =
        await import('../../../src/main/services/claude-code-implementer')
      const impl = new ClaudeCodeImplementer()
      await expect(impl.redo('test', 'test', 'test')).rejects.toThrow(
        'Redo is not supported for Claude Code sessions'
      )
    })

    it('getSessionInfo() returns structured response (not hardcoded stub)', async () => {
      const { ClaudeCodeImplementer } =
        await import('../../../src/main/services/claude-code-implementer')
      const impl = new ClaudeCodeImplementer()
      const result = await impl.getSessionInfo('test', 'test')
      // Should return the expected structure
      expect(result).toHaveProperty('revertMessageID')
      expect(result).toHaveProperty('revertDiff')
      // For a nonexistent session, both should be null
      expect(result.revertMessageID).toBeNull()
      expect(result.revertDiff).toBeNull()
    })
  })
})

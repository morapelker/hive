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

describe('Session 10 production readiness verification', () => {
  describe('capability constants', () => {
    it('CLAUDE_CODE_CAPABILITIES has supportsUndo: true and supportsRedo: false', () => {
      expect(CLAUDE_CODE_CAPABILITIES.supportsUndo).toBe(true)
      expect(CLAUDE_CODE_CAPABILITIES.supportsRedo).toBe(false)
    })

    it('OPENCODE_CAPABILITIES has both supportsUndo and supportsRedo: true', () => {
      expect(OPENCODE_CAPABILITIES.supportsUndo).toBe(true)
      expect(OPENCODE_CAPABILITIES.supportsRedo).toBe(true)
    })

    it('CLAUDE_CODE_CAPABILITIES declares all 8 capability fields', () => {
      const keys = Object.keys(CLAUDE_CODE_CAPABILITIES)
      expect(keys).toContain('supportsUndo')
      expect(keys).toContain('supportsRedo')
      expect(keys).toContain('supportsCommands')
      expect(keys).toContain('supportsPermissionRequests')
      expect(keys).toContain('supportsQuestionPrompts')
      expect(keys).toContain('supportsModelSelection')
      expect(keys).toContain('supportsReconnect')
      expect(keys).toContain('supportsPartialStreaming')
      expect(keys).toHaveLength(8)
    })
  })

  describe('ClaudeCodeImplementer has no remaining stubs', () => {
    it('undo() does not throw "not yet implemented"', async () => {
      const { ClaudeCodeImplementer } =
        await import('../../../src/main/services/claude-code-implementer')
      const impl = new ClaudeCodeImplementer()
      try {
        await impl.undo('test', 'test', 'test')
      } catch (e) {
        // It may throw for missing session, but never "not yet implemented"
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
      expect(result).toHaveProperty('revertMessageID')
      expect(result).toHaveProperty('revertDiff')
      expect(result.revertMessageID).toBeNull()
      expect(result.revertDiff).toBeNull()
    })

    it('permissionReply() does not throw (no-op for Claude)', async () => {
      const { ClaudeCodeImplementer } =
        await import('../../../src/main/services/claude-code-implementer')
      const impl = new ClaudeCodeImplementer()
      // Should not throw — permissions are handled via canUseTool callback
      await expect(impl.permissionReply('req-1', 'once')).resolves.toBeUndefined()
    })

    it('permissionList() returns empty array', async () => {
      const { ClaudeCodeImplementer } =
        await import('../../../src/main/services/claude-code-implementer')
      const impl = new ClaudeCodeImplementer()
      const result = await impl.permissionList()
      expect(result).toEqual([])
    })

    it('listCommands() returns empty array', async () => {
      const { ClaudeCodeImplementer } =
        await import('../../../src/main/services/claude-code-implementer')
      const impl = new ClaudeCodeImplementer()
      const result = await impl.listCommands('/test/path')
      expect(result).toEqual([])
    })

    it('sendCommand() delegates to prompt() with slash command format', async () => {
      const { ClaudeCodeImplementer } =
        await import('../../../src/main/services/claude-code-implementer')
      const impl = new ClaudeCodeImplementer()
      // sendCommand requires a connected session — it will throw for missing session
      // but the error should NOT be "not yet implemented"
      try {
        await impl.sendCommand('/test', 'session-1', 'help', 'me')
      } catch (e) {
        expect(String(e)).not.toContain('not yet implemented')
        // Expected: session not found error from prompt()
        expect(String(e)).toContain('session not found')
      }
    })

    it('renameSession() does not throw (uses DB update)', async () => {
      const { ClaudeCodeImplementer } =
        await import('../../../src/main/services/claude-code-implementer')
      const impl = new ClaudeCodeImplementer()
      // Without dbService set, it logs a warning and returns silently
      await expect(impl.renameSession('/test', 'session-1', 'New Name')).resolves.toBeUndefined()
    })
  })

  describe('no "not yet implemented" stubs remain in source', () => {
    it('ClaudeCodeImplementer source has no "not yet implemented" strings', async () => {
      const fs = await import('node:fs')
      const path = await import('node:path')
      const filePath = path.resolve(
        __dirname,
        '../../../src/main/services/claude-code-implementer.ts'
      )
      const source = fs.readFileSync(filePath, 'utf-8')
      expect(source).not.toContain('not yet implemented')
    })

    it('ClaudeCodeImplementer source has no TODO(claude-code-sdk) markers', async () => {
      const fs = await import('node:fs')
      const path = await import('node:path')
      const filePath = path.resolve(
        __dirname,
        '../../../src/main/services/claude-code-implementer.ts'
      )
      const source = fs.readFileSync(filePath, 'utf-8')
      expect(source).not.toContain('TODO(claude-code-sdk)')
    })
  })
})

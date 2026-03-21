/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock logger
vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { CodexImplementer } from '../../../src/main/services/codex-implementer'
import { CODEX_CAPABILITIES } from '../../../src/main/services/agent-sdk-types'
import { CODEX_DEFAULT_MODEL } from '../../../src/main/services/codex-models'

describe('CodexImplementer skeleton', () => {
  let impl: CodexImplementer

  beforeEach(() => {
    impl = new CodexImplementer()
  })

  // ── Identity & capabilities ────────────────────────────────────

  describe('identity', () => {
    it('has id "codex"', () => {
      expect(impl.id).toBe('codex')
    })

    it('has CODEX_CAPABILITIES', () => {
      expect(impl.capabilities).toEqual(CODEX_CAPABILITIES)
    })

    it('supportsUndo is true', () => {
      expect(impl.capabilities.supportsUndo).toBe(true)
    })

    it('supportsRedo is false', () => {
      expect(impl.capabilities.supportsRedo).toBe(false)
    })

    it('supportsCommands is false', () => {
      expect(impl.capabilities.supportsCommands).toBe(false)
    })

    it('supportsModelSelection is true', () => {
      expect(impl.capabilities.supportsModelSelection).toBe(true)
    })
  })

  // ── Model methods (implemented) ────────────────────────────────

  describe('getAvailableModels', () => {
    it('returns array with codex provider', async () => {
      const result = (await impl.getAvailableModels()) as any[]
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('codex')
    })

    it('provider contains all 4 models', async () => {
      const result = (await impl.getAvailableModels()) as any[]
      const models = result[0].models
      expect(Object.keys(models)).toHaveLength(4)
    })
  })

  describe('getModelInfo', () => {
    it('returns info for a known model', async () => {
      const info = await impl.getModelInfo('/path', 'gpt-5.4')
      expect(info).not.toBeNull()
      expect(info!.id).toBe('gpt-5.4')
      expect(info!.name).toBe('GPT-5.4')
    })

    it('returns null for unknown model', async () => {
      const info = await impl.getModelInfo('/path', 'unknown')
      expect(info).toBeNull()
    })
  })

  // ── setSelectedModel ───────────────────────────────────────────

  describe('setSelectedModel', () => {
    it('stores the model selection', () => {
      impl.setSelectedModel({ providerID: 'codex', modelID: 'gpt-5.3-codex' })
      expect(impl.getSelectedModel()).toBe('gpt-5.3-codex')
    })

    it('stores the variant selection', () => {
      impl.setSelectedModel({ providerID: 'codex', modelID: 'gpt-5.4', variant: 'xhigh' })
      expect(impl.getSelectedVariant()).toBe('xhigh')
    })

    it('defaults to gpt-5.4 before any selection', () => {
      expect(impl.getSelectedModel()).toBe(CODEX_DEFAULT_MODEL)
    })
  })

  // ── setMainWindow ──────────────────────────────────────────────

  describe('setMainWindow', () => {
    it('stores the window reference', () => {
      const mockWindow = { webContents: { send: vi.fn() } } as any
      impl.setMainWindow(mockWindow)
      expect(impl.getMainWindow()).toBe(mockWindow)
    })
  })

  // ── cleanup ────────────────────────────────────────────────────

  describe('cleanup', () => {
    it('clears mainWindow', async () => {
      const mockWindow = { webContents: { send: vi.fn() } } as any
      impl.setMainWindow(mockWindow)

      await impl.cleanup()
      expect(impl.getMainWindow()).toBeNull()
    })

    it('resets selected model to default', async () => {
      impl.setSelectedModel({ providerID: 'codex', modelID: 'gpt-5.3-codex', variant: 'low' })

      await impl.cleanup()
      expect(impl.getSelectedModel()).toBe(CODEX_DEFAULT_MODEL)
      expect(impl.getSelectedVariant()).toBeUndefined()
    })

    it('does not throw', async () => {
      await expect(impl.cleanup()).resolves.toBeUndefined()
    })
  })

  // ── Unimplemented lifecycle methods throw ──────────────────────

  describe('lifecycle methods are implemented (session 4)', () => {
    it('connect is a function', () => {
      expect(typeof impl.connect).toBe('function')
    })

    it('reconnect is a function', () => {
      expect(typeof impl.reconnect).toBe('function')
    })

    it('disconnect is a function', () => {
      expect(typeof impl.disconnect).toBe('function')
    })
  })

  // ── Unimplemented messaging methods throw ──────────────────────

  describe('implemented messaging methods', () => {
    it('prompt throws when session not found', async () => {
      await expect(impl.prompt('/path', 'session-1', 'hello')).rejects.toThrow(
        'session not found'
      )
    })

    it('abort returns false for unknown session', async () => {
      const result = await impl.abort('/path', 'session-1')
      expect(result).toBe(false)
    })

    it('getMessages returns empty array for unknown session', async () => {
      const messages = await impl.getMessages('/path', 'session-1')
      expect(messages).toEqual([])
    })
  })

  // ── Unimplemented session info methods throw ───────────────────

  describe('implemented session info methods', () => {
    it('getSessionInfo returns null/null for unknown session', async () => {
      const result = await impl.getSessionInfo('/path', 'session-1')
      expect(result.revertMessageID).toBeNull()
      expect(result.revertDiff).toBeNull()
    })

    it('renameSession does not throw without dbService', async () => {
      await expect(
        impl.renameSession('/path', 'session-1', 'new name')
      ).resolves.not.toThrow()
    })
  })

  // ── Implemented human-in-the-loop methods ──────────────────────

  describe('implemented human-in-the-loop methods handle missing requests', () => {
    it('questionReply throws for unknown requestId', async () => {
      await expect(impl.questionReply('req-1', [['answer']])).rejects.toThrow(
        'No pending question found for requestId: req-1'
      )
    })

    it('questionReject throws for unknown requestId', async () => {
      await expect(impl.questionReject('req-1')).rejects.toThrow(
        'No pending question found for requestId: req-1'
      )
    })

    it('permissionReply throws for unknown requestId', async () => {
      await expect(impl.permissionReply('req-1', 'once')).rejects.toThrow(
        'No pending approval found for requestId: req-1'
      )
    })

    it('permissionList returns empty array with no sessions', async () => {
      const result = await impl.permissionList()
      expect(result).toEqual([])
    })
  })

  // ── Unimplemented undo/redo methods throw ──────────────────────

  describe('undo/redo methods', () => {
    it('undo throws for unknown session', async () => {
      await expect(impl.undo('/path', 'session-1', 'hive-1')).rejects.toThrow(
        'session not found'
      )
    })

    it('redo throws unsupported', async () => {
      await expect(impl.redo('/path', 'session-1', 'hive-1')).rejects.toThrow(
        'Redo is not supported for Codex sessions'
      )
    })
  })

  // ── Unimplemented command methods throw ─────────────────────────

  describe('unimplemented command methods throw descriptive errors', () => {
    it('listCommands throws', async () => {
      await expect(impl.listCommands('/path')).rejects.toThrow(
        'CodexImplementer.listCommands() not yet implemented'
      )
    })

    it('sendCommand throws', async () => {
      await expect(impl.sendCommand('/path', 'session-1', '/help')).rejects.toThrow(
        'CodexImplementer.sendCommand() not yet implemented'
      )
    })
  })

  // ── Implements AgentSdkImplementer interface ───────────────────

  describe('interface compliance', () => {
    it('has all required methods', () => {
      const requiredMethods = [
        'connect',
        'reconnect',
        'disconnect',
        'cleanup',
        'prompt',
        'abort',
        'getMessages',
        'getAvailableModels',
        'getModelInfo',
        'setSelectedModel',
        'getSessionInfo',
        'questionReply',
        'questionReject',
        'permissionReply',
        'permissionList',
        'undo',
        'redo',
        'listCommands',
        'sendCommand',
        'renameSession',
        'setMainWindow'
      ]

      for (const method of requiredMethods) {
        expect(typeof (impl as any)[method]).toBe('function')
      }
    })

    it('has id property set to codex', () => {
      expect(impl.id).toBe('codex')
    })

    it('has readonly capabilities property', () => {
      expect(impl.capabilities).toBeDefined()
    })
  })
})

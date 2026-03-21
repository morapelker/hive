/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentSdkImplementer, AgentSdkId } from '../../../src/main/services/agent-sdk-types'
import {
  OPENCODE_CAPABILITIES,
  CLAUDE_CODE_CAPABILITIES,
  CODEX_CAPABILITIES
} from '../../../src/main/services/agent-sdk-types'

// Mock logger
vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { AgentSdkManager } from '../../../src/main/services/agent-sdk-manager'

// Minimal mock implementers
function createMockImplementer(id: AgentSdkId): AgentSdkImplementer {
  const capsMap: Record<string, AgentSdkImplementer['capabilities']> = {
    opencode: OPENCODE_CAPABILITIES,
    'claude-code': CLAUDE_CODE_CAPABILITIES,
    codex: CODEX_CAPABILITIES
  }
  return {
    id,
    capabilities: capsMap[id] ?? OPENCODE_CAPABILITIES,
    connect: vi.fn().mockResolvedValue({ sessionId: `${id}-session-1` }),
    reconnect: vi.fn().mockResolvedValue({ success: true }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(true),
    getMessages: vi.fn().mockResolvedValue([]),
    getAvailableModels: vi.fn().mockResolvedValue({}),
    getModelInfo: vi.fn().mockResolvedValue(null),
    setSelectedModel: vi.fn(),
    getSessionInfo: vi.fn().mockResolvedValue({ revertMessageID: null, revertDiff: null }),
    questionReply: vi.fn().mockResolvedValue(undefined),
    questionReject: vi.fn().mockResolvedValue(undefined),
    permissionReply: vi.fn().mockResolvedValue(undefined),
    permissionList: vi.fn().mockResolvedValue([]),
    undo: vi.fn().mockResolvedValue({}),
    redo: vi.fn().mockResolvedValue({}),
    listCommands: vi.fn().mockResolvedValue([]),
    sendCommand: vi.fn().mockResolvedValue(undefined),
    renameSession: vi.fn().mockResolvedValue(undefined),
    setMainWindow: vi.fn()
  }
}

describe('AgentSdkManager with Codex', () => {
  let manager: AgentSdkManager
  let mockOpencode: AgentSdkImplementer
  let mockClaudeCode: AgentSdkImplementer
  let mockCodex: AgentSdkImplementer

  beforeEach(() => {
    mockOpencode = createMockImplementer('opencode')
    mockClaudeCode = createMockImplementer('claude-code')
    mockCodex = createMockImplementer('codex')
    manager = new AgentSdkManager([mockOpencode, mockClaudeCode, mockCodex])
  })

  describe('constructor accepts arbitrary implementers', () => {
    it('registers all three implementers via array', () => {
      expect(manager.getImplementer('opencode')).toBe(mockOpencode)
      expect(manager.getImplementer('claude-code')).toBe(mockClaudeCode)
      expect(manager.getImplementer('codex')).toBe(mockCodex)
    })

    it('works with a subset of implementers', () => {
      const twoSdkManager = new AgentSdkManager([mockOpencode, mockCodex])
      expect(twoSdkManager.getImplementer('opencode')).toBe(mockOpencode)
      expect(twoSdkManager.getImplementer('codex')).toBe(mockCodex)
      expect(() => twoSdkManager.getImplementer('claude-code')).toThrow(
        'Unknown agent SDK: "claude-code"'
      )
    })
  })

  describe('getImplementer', () => {
    it('returns codex implementer for "codex"', () => {
      expect(manager.getImplementer('codex')).toBe(mockCodex)
    })

    it('still returns opencode implementer for "opencode"', () => {
      expect(manager.getImplementer('opencode')).toBe(mockOpencode)
    })

    it('still returns claude-code implementer for "claude-code"', () => {
      expect(manager.getImplementer('claude-code')).toBe(mockClaudeCode)
    })

    it('throws for unknown SDK id', () => {
      expect(() => manager.getImplementer('unknown' as AgentSdkId)).toThrow(
        'Unknown agent SDK: "unknown"'
      )
    })
  })

  describe('getCapabilities', () => {
    it('returns codex capabilities', () => {
      expect(manager.getCapabilities('codex')).toEqual(CODEX_CAPABILITIES)
    })

    it('codex capabilities have correct values', () => {
      const caps = manager.getCapabilities('codex')
      expect(caps.supportsUndo).toBe(true)
      expect(caps.supportsRedo).toBe(false)
      expect(caps.supportsCommands).toBe(false)
      expect(caps.supportsPermissionRequests).toBe(true)
      expect(caps.supportsQuestionPrompts).toBe(true)
      expect(caps.supportsModelSelection).toBe(true)
      expect(caps.supportsReconnect).toBe(true)
      expect(caps.supportsPartialStreaming).toBe(true)
    })

    it('opencode capabilities still work', () => {
      expect(manager.getCapabilities('opencode')).toEqual(OPENCODE_CAPABILITIES)
    })
  })

  describe('defaultSdkId', () => {
    it('defaults to opencode (not codex)', () => {
      expect(manager.defaultSdkId).toBe('opencode')
    })
  })

  describe('setMainWindow', () => {
    it('propagates to codex implementer', () => {
      const mockWindow = { fake: 'window' } as any
      manager.setMainWindow(mockWindow)

      expect(mockCodex.setMainWindow).toHaveBeenCalledWith(mockWindow)
    })

    it('propagates to all three implementers', () => {
      const mockWindow = { fake: 'window' } as any
      manager.setMainWindow(mockWindow)

      expect(mockOpencode.setMainWindow).toHaveBeenCalledWith(mockWindow)
      expect(mockClaudeCode.setMainWindow).toHaveBeenCalledWith(mockWindow)
      expect(mockCodex.setMainWindow).toHaveBeenCalledWith(mockWindow)
    })

    it('calls each implementer exactly once', () => {
      const mockWindow = { fake: 'window' } as any
      manager.setMainWindow(mockWindow)

      expect(mockOpencode.setMainWindow).toHaveBeenCalledTimes(1)
      expect(mockClaudeCode.setMainWindow).toHaveBeenCalledTimes(1)
      expect(mockCodex.setMainWindow).toHaveBeenCalledTimes(1)
    })
  })

  describe('cleanupAll', () => {
    it('calls cleanup on all three implementers including codex', async () => {
      await manager.cleanupAll()

      expect(mockOpencode.cleanup).toHaveBeenCalledTimes(1)
      expect(mockClaudeCode.cleanup).toHaveBeenCalledTimes(1)
      expect(mockCodex.cleanup).toHaveBeenCalledTimes(1)
    })

    it('continues cleanup even if codex fails', async () => {
      vi.mocked(mockCodex.cleanup).mockRejectedValueOnce(new Error('codex boom'))

      await manager.cleanupAll()

      expect(mockOpencode.cleanup).toHaveBeenCalledTimes(1)
      expect(mockClaudeCode.cleanup).toHaveBeenCalledTimes(1)
      expect(mockCodex.cleanup).toHaveBeenCalledTimes(1)
    })

    it('does not throw when codex cleanup fails', async () => {
      vi.mocked(mockCodex.cleanup).mockRejectedValueOnce(new Error('codex boom'))

      await expect(manager.cleanupAll()).resolves.toBeUndefined()
    })
  })

  describe('codex implementer methods route correctly', () => {
    it('connect routes through codex implementer', async () => {
      const impl = manager.getImplementer('codex')
      const result = await impl.connect('/path', 'hive-session-1')

      expect(result).toEqual({ sessionId: 'codex-session-1' })
      expect(mockCodex.connect).toHaveBeenCalledWith('/path', 'hive-session-1')
    })

    it('prompt routes through codex implementer', async () => {
      const impl = manager.getImplementer('codex')
      await impl.prompt('/path', 'session-1', 'Hello')

      expect(mockCodex.prompt).toHaveBeenCalledWith('/path', 'session-1', 'Hello')
    })

    it('abort routes through codex implementer', async () => {
      const impl = manager.getImplementer('codex')
      const result = await impl.abort('/path', 'session-1')

      expect(result).toBe(true)
      expect(mockCodex.abort).toHaveBeenCalledWith('/path', 'session-1')
    })
  })
})

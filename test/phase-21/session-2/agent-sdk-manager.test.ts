/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentSdkImplementer, AgentSdkId } from '../../../src/main/services/agent-sdk-types'
import {
  OPENCODE_CAPABILITIES,
  CLAUDE_CODE_CAPABILITIES
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
  const caps = id === 'opencode' ? OPENCODE_CAPABILITIES : CLAUDE_CODE_CAPABILITIES
  return {
    id,
    capabilities: caps,
    connect: vi.fn(),
    reconnect: vi.fn(),
    disconnect: vi.fn(),
    cleanup: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn(),
    abort: vi.fn(),
    getMessages: vi.fn(),
    getAvailableModels: vi.fn(),
    getModelInfo: vi.fn(),
    setSelectedModel: vi.fn(),
    getSessionInfo: vi.fn(),
    questionReply: vi.fn(),
    questionReject: vi.fn(),
    permissionReply: vi.fn(),
    permissionList: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    listCommands: vi.fn(),
    sendCommand: vi.fn(),
    renameSession: vi.fn(),
    setMainWindow: vi.fn()
  }
}

describe('AgentSdkManager', () => {
  let manager: AgentSdkManager
  let mockOpencode: AgentSdkImplementer
  let mockClaudeCode: AgentSdkImplementer

  beforeEach(() => {
    mockOpencode = createMockImplementer('opencode')
    mockClaudeCode = createMockImplementer('claude-code')
    manager = new AgentSdkManager(mockOpencode, mockClaudeCode)
  })

  describe('getImplementer', () => {
    it('returns opencode implementer for "opencode"', () => {
      expect(manager.getImplementer('opencode')).toBe(mockOpencode)
    })

    it('returns claude-code implementer for "claude-code"', () => {
      expect(manager.getImplementer('claude-code')).toBe(mockClaudeCode)
    })

    it('throws for unknown SDK id', () => {
      expect(() => manager.getImplementer('unknown' as AgentSdkId)).toThrow(
        'Unknown agent SDK: "unknown"'
      )
    })
  })

  describe('getCapabilities', () => {
    it('returns opencode capabilities', () => {
      expect(manager.getCapabilities('opencode')).toEqual(OPENCODE_CAPABILITIES)
    })

    it('returns claude-code capabilities', () => {
      expect(manager.getCapabilities('claude-code')).toEqual(CLAUDE_CODE_CAPABILITIES)
    })
  })

  describe('defaultSdkId', () => {
    it('defaults to opencode', () => {
      expect(manager.defaultSdkId).toBe('opencode')
    })
  })

  describe('setMainWindow', () => {
    it('forwards to all implementers', () => {
      const mockWindow = { fake: 'window' } as any
      manager.setMainWindow(mockWindow)

      expect(mockOpencode.setMainWindow).toHaveBeenCalledWith(mockWindow)
      expect(mockClaudeCode.setMainWindow).toHaveBeenCalledWith(mockWindow)
    })

    it('calls each implementer exactly once', () => {
      const mockWindow = { fake: 'window' } as any
      manager.setMainWindow(mockWindow)

      expect(mockOpencode.setMainWindow).toHaveBeenCalledTimes(1)
      expect(mockClaudeCode.setMainWindow).toHaveBeenCalledTimes(1)
    })
  })

  describe('cleanupAll', () => {
    it('calls cleanup on all implementers', async () => {
      await manager.cleanupAll()

      expect(mockOpencode.cleanup).toHaveBeenCalledTimes(1)
      expect(mockClaudeCode.cleanup).toHaveBeenCalledTimes(1)
    })

    it('continues cleanup even if one implementer fails', async () => {
      vi.mocked(mockOpencode.cleanup).mockRejectedValueOnce(new Error('boom'))

      await manager.cleanupAll()

      expect(mockOpencode.cleanup).toHaveBeenCalledTimes(1)
      expect(mockClaudeCode.cleanup).toHaveBeenCalledTimes(1)
    })

    it('does not throw when an implementer cleanup fails', async () => {
      vi.mocked(mockOpencode.cleanup).mockRejectedValueOnce(new Error('boom'))

      await expect(manager.cleanupAll()).resolves.toBeUndefined()
    })
  })
})

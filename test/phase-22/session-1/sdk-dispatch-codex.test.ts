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
import {
  withSdkDispatch,
  withSdkDispatchByHiveSession
} from '../../../src/server/resolvers/helpers/sdk-dispatch'

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

describe('sdk-dispatch helpers with Codex', () => {
  let sdkManager: AgentSdkManager
  let mockCodex: AgentSdkImplementer

  // Minimal mock DB
  function createMockDb(overrides: Record<string, any> = {}) {
    return {
      getAgentSdkForSession: vi.fn().mockReturnValue(null),
      getSession: vi.fn().mockReturnValue(null),
      ...overrides
    }
  }

  beforeEach(() => {
    const mockOpencode = createMockImplementer('opencode')
    const mockClaudeCode = createMockImplementer('claude-code')
    mockCodex = createMockImplementer('codex')
    sdkManager = new AgentSdkManager([mockOpencode, mockClaudeCode, mockCodex])
  })

  describe('withSdkDispatch', () => {
    it('routes codex sessions to the codex implementer', async () => {
      const db = createMockDb({
        getAgentSdkForSession: vi.fn().mockReturnValue('codex')
      })
      const ctx = { sdkManager, db } as any

      const opencodeFn = vi.fn()
      const sdkFn = vi.fn().mockResolvedValue('codex-result')

      const result = await withSdkDispatch(ctx, 'agent-session-1', opencodeFn, sdkFn)

      expect(result).toBe('codex-result')
      expect(sdkFn).toHaveBeenCalledWith(mockCodex)
      expect(opencodeFn).not.toHaveBeenCalled()
    })

    it('routes claude-code sessions to the claude-code implementer', async () => {
      const db = createMockDb({
        getAgentSdkForSession: vi.fn().mockReturnValue('claude-code')
      })
      const ctx = { sdkManager, db } as any

      const opencodeFn = vi.fn()
      const sdkFn = vi.fn().mockResolvedValue('claude-result')

      const result = await withSdkDispatch(ctx, 'agent-session-1', opencodeFn, sdkFn)

      expect(result).toBe('claude-result')
      expect(opencodeFn).not.toHaveBeenCalled()
    })

    it('falls through to opencode for opencode sessions', async () => {
      const db = createMockDb({
        getAgentSdkForSession: vi.fn().mockReturnValue('opencode')
      })
      const ctx = { sdkManager, db } as any

      const opencodeFn = vi.fn().mockResolvedValue('opencode-result')
      const sdkFn = vi.fn()

      const result = await withSdkDispatch(ctx, 'agent-session-1', opencodeFn, sdkFn)

      expect(result).toBe('opencode-result')
      expect(opencodeFn).toHaveBeenCalled()
      expect(sdkFn).not.toHaveBeenCalled()
    })

    it('falls through to opencode when session not found in DB', async () => {
      const db = createMockDb({
        getAgentSdkForSession: vi.fn().mockReturnValue(null)
      })
      const ctx = { sdkManager, db } as any

      const opencodeFn = vi.fn().mockResolvedValue('opencode-fallback')
      const sdkFn = vi.fn()

      const result = await withSdkDispatch(ctx, 'unknown-session', opencodeFn, sdkFn)

      expect(result).toBe('opencode-fallback')
      expect(opencodeFn).toHaveBeenCalled()
      expect(sdkFn).not.toHaveBeenCalled()
    })

    it('handles terminal sessions by falling through to opencode', async () => {
      const db = createMockDb({
        getAgentSdkForSession: vi.fn().mockReturnValue('terminal')
      })
      const ctx = { sdkManager, db } as any

      const opencodeFn = vi.fn().mockResolvedValue('opencode-result')
      const sdkFn = vi.fn()

      const result = await withSdkDispatch(ctx, 'agent-session-1', opencodeFn, sdkFn)

      expect(result).toBe('opencode-result')
      expect(opencodeFn).toHaveBeenCalled()
      expect(sdkFn).not.toHaveBeenCalled()
    })

    it('falls through to opencode when no sdkManager provided', async () => {
      const ctx = { sdkManager: undefined, db: createMockDb() } as any

      const opencodeFn = vi.fn().mockResolvedValue('opencode-result')
      const sdkFn = vi.fn()

      const result = await withSdkDispatch(ctx, 'agent-session-1', opencodeFn, sdkFn)

      expect(result).toBe('opencode-result')
      expect(opencodeFn).toHaveBeenCalled()
    })
  })

  describe('withSdkDispatchByHiveSession', () => {
    it('routes codex sessions to the codex implementer', async () => {
      const db = createMockDb({
        getSession: vi.fn().mockReturnValue({ agent_sdk: 'codex' })
      })
      const ctx = { sdkManager, db } as any

      const opencodeFn = vi.fn()
      const sdkFn = vi.fn().mockResolvedValue('codex-result')

      const result = await withSdkDispatchByHiveSession(
        ctx,
        'hive-session-1',
        opencodeFn,
        sdkFn
      )

      expect(result).toBe('codex-result')
      expect(sdkFn).toHaveBeenCalledWith(mockCodex)
      expect(opencodeFn).not.toHaveBeenCalled()
    })

    it('routes claude-code sessions to the claude-code implementer', async () => {
      const db = createMockDb({
        getSession: vi.fn().mockReturnValue({ agent_sdk: 'claude-code' })
      })
      const ctx = { sdkManager, db } as any

      const opencodeFn = vi.fn()
      const sdkFn = vi.fn().mockResolvedValue('claude-result')

      const result = await withSdkDispatchByHiveSession(
        ctx,
        'hive-session-1',
        opencodeFn,
        sdkFn
      )

      expect(result).toBe('claude-result')
      expect(opencodeFn).not.toHaveBeenCalled()
    })

    it('falls through to opencode for opencode sessions', async () => {
      const db = createMockDb({
        getSession: vi.fn().mockReturnValue({ agent_sdk: 'opencode' })
      })
      const ctx = { sdkManager, db } as any

      const opencodeFn = vi.fn().mockResolvedValue('opencode-result')
      const sdkFn = vi.fn()

      const result = await withSdkDispatchByHiveSession(
        ctx,
        'hive-session-1',
        opencodeFn,
        sdkFn
      )

      expect(result).toBe('opencode-result')
      expect(opencodeFn).toHaveBeenCalled()
      expect(sdkFn).not.toHaveBeenCalled()
    })

    it('handles terminal sessions by falling through to opencode', async () => {
      const db = createMockDb({
        getSession: vi.fn().mockReturnValue({ agent_sdk: 'terminal' })
      })
      const ctx = { sdkManager, db } as any

      const opencodeFn = vi.fn().mockResolvedValue('opencode-result')
      const sdkFn = vi.fn()

      const result = await withSdkDispatchByHiveSession(
        ctx,
        'hive-session-1',
        opencodeFn,
        sdkFn
      )

      expect(result).toBe('opencode-result')
      expect(opencodeFn).toHaveBeenCalled()
      expect(sdkFn).not.toHaveBeenCalled()
    })

    it('falls through to opencode when session not found', async () => {
      const db = createMockDb({
        getSession: vi.fn().mockReturnValue(null)
      })
      const ctx = { sdkManager, db } as any

      const opencodeFn = vi.fn().mockResolvedValue('opencode-fallback')
      const sdkFn = vi.fn()

      const result = await withSdkDispatchByHiveSession(
        ctx,
        'unknown-session',
        opencodeFn,
        sdkFn
      )

      expect(result).toBe('opencode-fallback')
      expect(opencodeFn).toHaveBeenCalled()
      expect(sdkFn).not.toHaveBeenCalled()
    })
  })
})

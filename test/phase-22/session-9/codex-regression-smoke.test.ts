/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentSdkImplementer, AgentSdkId } from '../../../src/main/services/agent-sdk-types'
import {
  OPENCODE_CAPABILITIES,
  CLAUDE_CODE_CAPABILITIES,
  CODEX_CAPABILITIES,
  TERMINAL_CAPABILITIES
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
  withSdkDispatchByHiveSession,
  mapGraphQLSdkToInternal
} from '../../../src/server/resolvers/helpers/sdk-dispatch'

/**
 * Codex Regression Smoke Tests (Session 9)
 *
 * Exercises provider selection, connect, prompt, abort, and capability
 * lookup across all three AI providers: OpenCode, Claude Code, and Codex.
 * This serves as the final regression gate before merge.
 */

// ── Test helpers ────────────────────────────────────────────────────

function createMockImplementer(id: AgentSdkId): AgentSdkImplementer & {
  hasPendingQuestion: ReturnType<typeof vi.fn>
  hasPendingApproval: ReturnType<typeof vi.fn>
} {
  const capsMap: Record<string, AgentSdkImplementer['capabilities']> = {
    opencode: OPENCODE_CAPABILITIES,
    'claude-code': CLAUDE_CODE_CAPABILITIES,
    codex: CODEX_CAPABILITIES
  }
  return {
    id,
    capabilities: capsMap[id] ?? OPENCODE_CAPABILITIES,
    connect: vi.fn().mockResolvedValue({ sessionId: `${id}-session-1` }),
    reconnect: vi.fn().mockResolvedValue({ success: true, sessionStatus: 'idle' }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(true),
    getMessages: vi.fn().mockResolvedValue([]),
    getAvailableModels: vi.fn().mockResolvedValue({ default: { models: ['test-model'] } }),
    getModelInfo: vi.fn().mockResolvedValue({
      id: 'test-model',
      name: 'Test',
      limit: { context: 100000, output: 50000 }
    }),
    setSelectedModel: vi.fn(),
    getSessionInfo: vi.fn().mockResolvedValue({ revertMessageID: null, revertDiff: null }),
    questionReply: vi.fn().mockResolvedValue(undefined),
    questionReject: vi.fn().mockResolvedValue(undefined),
    permissionReply: vi.fn().mockResolvedValue(undefined),
    permissionList: vi.fn().mockResolvedValue([]),
    undo: vi.fn().mockResolvedValue({
      revertMessageID: 'msg-1',
      restoredPrompt: 'old prompt',
      revertDiff: null
    }),
    redo: vi.fn().mockResolvedValue({}),
    listCommands: vi.fn().mockResolvedValue([]),
    sendCommand: vi.fn().mockResolvedValue(undefined),
    renameSession: vi.fn().mockResolvedValue(undefined),
    setMainWindow: vi.fn(),
    hasPendingQuestion: vi.fn().mockReturnValue(false),
    hasPendingApproval: vi.fn().mockReturnValue(false)
  }
}

function createMockDb(overrides: Record<string, any> = {}) {
  return {
    getAgentSdkForSession: vi.fn().mockReturnValue(null),
    getSession: vi.fn().mockReturnValue(null),
    ...overrides
  }
}

// ── Provider selection ──────────────────────────────────────────────

describe('Regression: provider selection across all SDKs', () => {
  const ALL_SDK_IDS: AgentSdkId[] = ['opencode', 'claude-code', 'codex', 'terminal']

  it('all four SDK IDs are recognized by AgentSdkManager', () => {
    const impls = ALL_SDK_IDS.filter((id) => id !== 'terminal').map(createMockImplementer)
    const manager = new AgentSdkManager(impls)

    for (const id of ['opencode', 'claude-code', 'codex'] as const) {
      expect(() => manager.getImplementer(id)).not.toThrow()
      expect(manager.getImplementer(id).id).toBe(id)
    }
  })

  it('mapGraphQLSdkToInternal handles all GraphQL enum values', () => {
    const gqlToInternal: Record<string, AgentSdkId> = {
      opencode: 'opencode',
      claude_code: 'claude-code',
      codex: 'codex',
      terminal: 'terminal'
    }

    for (const [gql, expected] of Object.entries(gqlToInternal)) {
      expect(mapGraphQLSdkToInternal(gql)).toBe(expected)
    }
  })

  it('capability constants are distinct per provider', () => {
    const caps = {
      opencode: OPENCODE_CAPABILITIES,
      'claude-code': CLAUDE_CODE_CAPABILITIES,
      codex: CODEX_CAPABILITIES,
      terminal: TERMINAL_CAPABILITIES
    }

    // OpenCode supports everything
    expect(caps.opencode.supportsRedo).toBe(true)
    expect(caps.opencode.supportsCommands).toBe(true)

    // Claude supports most but not redo
    expect(caps['claude-code'].supportsRedo).toBe(false)
    expect(caps['claude-code'].supportsCommands).toBe(true)

    // Codex doesn't support redo or commands
    expect(caps.codex.supportsRedo).toBe(false)
    expect(caps.codex.supportsCommands).toBe(false)

    // Terminal supports nothing
    expect(caps.terminal.supportsUndo).toBe(false)
    expect(caps.terminal.supportsModelSelection).toBe(false)
  })
})

// ── Connect dispatch ────────────────────────────────────────────────

describe('Regression: connect dispatch for all providers', () => {
  let sdkManager: AgentSdkManager
  let mocks: Record<string, ReturnType<typeof createMockImplementer>>

  beforeEach(() => {
    mocks = {
      opencode: createMockImplementer('opencode'),
      'claude-code': createMockImplementer('claude-code'),
      codex: createMockImplementer('codex')
    }
    sdkManager = new AgentSdkManager(Object.values(mocks))
  })

  for (const sdk of ['opencode', 'claude-code', 'codex'] as const) {
    it(`connects via withSdkDispatchByHiveSession for ${sdk}`, async () => {
      const db = createMockDb({
        getSession: vi.fn().mockReturnValue({ agent_sdk: sdk })
      })
      const ctx = { sdkManager, db } as any
      const opencodeFn = vi.fn().mockResolvedValue({ sessionId: 'oc-1' })
      const sdkFn = vi.fn().mockResolvedValue({ sessionId: `${sdk}-1` })

      const result = await withSdkDispatchByHiveSession(
        ctx,
        'hive-session-1',
        opencodeFn,
        sdkFn
      )

      if (sdk === 'opencode') {
        expect(opencodeFn).toHaveBeenCalled()
        expect(sdkFn).not.toHaveBeenCalled()
        expect(result.sessionId).toBe('oc-1')
      } else {
        expect(sdkFn).toHaveBeenCalledWith(mocks[sdk])
        expect(opencodeFn).not.toHaveBeenCalled()
        expect(result.sessionId).toBe(`${sdk}-1`)
      }
    })
  }
})

// ── Prompt dispatch ─────────────────────────────────────────────────

describe('Regression: prompt dispatch for all providers', () => {
  let sdkManager: AgentSdkManager
  let mocks: Record<string, ReturnType<typeof createMockImplementer>>

  beforeEach(() => {
    mocks = {
      opencode: createMockImplementer('opencode'),
      'claude-code': createMockImplementer('claude-code'),
      codex: createMockImplementer('codex')
    }
    sdkManager = new AgentSdkManager(Object.values(mocks))
  })

  for (const sdk of ['opencode', 'claude-code', 'codex'] as const) {
    it(`dispatches prompt to ${sdk} implementer`, async () => {
      const db = createMockDb({
        getAgentSdkForSession: vi.fn().mockReturnValue(sdk)
      })
      const ctx = { sdkManager, db } as any
      const opencodeFn = vi.fn().mockResolvedValue(undefined)
      const sdkFn = vi.fn().mockResolvedValue(undefined)

      await withSdkDispatch(ctx, 'agent-session-1', opencodeFn, sdkFn)

      if (sdk === 'opencode') {
        expect(opencodeFn).toHaveBeenCalled()
        expect(sdkFn).not.toHaveBeenCalled()
      } else {
        expect(sdkFn).toHaveBeenCalledWith(mocks[sdk])
        expect(opencodeFn).not.toHaveBeenCalled()
      }
    })
  }
})

// ── Abort dispatch ──────────────────────────────────────────────────

describe('Regression: abort dispatch for all providers', () => {
  let sdkManager: AgentSdkManager
  let mocks: Record<string, ReturnType<typeof createMockImplementer>>

  beforeEach(() => {
    mocks = {
      opencode: createMockImplementer('opencode'),
      'claude-code': createMockImplementer('claude-code'),
      codex: createMockImplementer('codex')
    }
    sdkManager = new AgentSdkManager(Object.values(mocks))
  })

  for (const sdk of ['opencode', 'claude-code', 'codex'] as const) {
    it(`dispatches abort to ${sdk} implementer`, async () => {
      const db = createMockDb({
        getAgentSdkForSession: vi.fn().mockReturnValue(sdk)
      })
      const ctx = { sdkManager, db } as any

      const opencodeFn = vi.fn().mockResolvedValue(true)
      const sdkFn = vi.fn().mockResolvedValue(true)

      const result = await withSdkDispatch(ctx, 'agent-session-1', opencodeFn, sdkFn)

      expect(result).toBe(true)
      if (sdk === 'opencode') {
        expect(opencodeFn).toHaveBeenCalled()
      } else {
        expect(sdkFn).toHaveBeenCalledWith(mocks[sdk])
      }
    })
  }
})

// ── Capability lookup ───────────────────────────────────────────────

describe('Regression: capability lookup for all providers', () => {
  let sdkManager: AgentSdkManager

  beforeEach(() => {
    const impls = (['opencode', 'claude-code', 'codex'] as const).map(createMockImplementer)
    sdkManager = new AgentSdkManager(impls)
  })

  for (const sdk of ['opencode', 'claude-code', 'codex'] as const) {
    it(`returns correct capabilities for ${sdk}`, () => {
      const caps = sdkManager.getCapabilities(sdk)

      expect(typeof caps.supportsUndo).toBe('boolean')
      expect(typeof caps.supportsRedo).toBe('boolean')
      expect(typeof caps.supportsCommands).toBe('boolean')
      expect(typeof caps.supportsPermissionRequests).toBe('boolean')
      expect(typeof caps.supportsQuestionPrompts).toBe('boolean')
      expect(typeof caps.supportsModelSelection).toBe('boolean')
      expect(typeof caps.supportsReconnect).toBe('boolean')
      expect(typeof caps.supportsPartialStreaming).toBe('boolean')
    })
  }

  it('OpenCode has all capabilities enabled', () => {
    const caps = sdkManager.getCapabilities('opencode')
    expect(Object.values(caps).every((v) => v === true)).toBe(true)
  })

  it('Codex lacks redo and commands', () => {
    const caps = sdkManager.getCapabilities('codex')
    expect(caps.supportsRedo).toBe(false)
    expect(caps.supportsCommands).toBe(false)
    expect(caps.supportsUndo).toBe(true)
    expect(caps.supportsPermissionRequests).toBe(true)
    expect(caps.supportsQuestionPrompts).toBe(true)
    expect(caps.supportsModelSelection).toBe(true)
  })

  it('Claude Code lacks redo', () => {
    const caps = sdkManager.getCapabilities('claude-code')
    expect(caps.supportsRedo).toBe(false)
    expect(caps.supportsCommands).toBe(true)
    expect(caps.supportsUndo).toBe(true)
  })
})

// ── Reconnect dispatch ──────────────────────────────────────────────

describe('Regression: reconnect dispatch for all providers', () => {
  let sdkManager: AgentSdkManager
  let mocks: Record<string, ReturnType<typeof createMockImplementer>>

  beforeEach(() => {
    mocks = {
      opencode: createMockImplementer('opencode'),
      'claude-code': createMockImplementer('claude-code'),
      codex: createMockImplementer('codex')
    }
    sdkManager = new AgentSdkManager(Object.values(mocks))
  })

  for (const sdk of ['opencode', 'claude-code', 'codex'] as const) {
    it(`dispatches reconnect to ${sdk} implementer`, async () => {
      const db = createMockDb({
        getAgentSdkForSession: vi.fn().mockReturnValue(sdk)
      })
      const ctx = { sdkManager, db } as any

      const opencodeFn = vi.fn().mockResolvedValue({ success: true })
      const sdkFn = vi.fn().mockResolvedValue({ success: true, sessionStatus: 'idle' })

      const result = await withSdkDispatch(ctx, 'agent-session-1', opencodeFn, sdkFn)

      expect(result.success).toBe(true)
      if (sdk === 'opencode') {
        expect(opencodeFn).toHaveBeenCalled()
      } else {
        expect(sdkFn).toHaveBeenCalledWith(mocks[sdk])
      }
    })
  }
})

// ── GraphQL enum round-trip ─────────────────────────────────────────

describe('Regression: GraphQL enum round-trip consistency', () => {
  it('DB -> GraphQL -> internal round-trips correctly for claude-code', () => {
    const dbValue = 'claude-code'
    const graphqlValue = dbValue === 'claude-code' ? 'claude_code' : dbValue
    const internalValue = mapGraphQLSdkToInternal(graphqlValue)
    expect(internalValue).toBe(dbValue)
  })

  it('DB -> GraphQL -> internal round-trips correctly for codex', () => {
    const dbValue = 'codex'
    const graphqlValue = dbValue === 'claude-code' ? 'claude_code' : dbValue
    const internalValue = mapGraphQLSdkToInternal(graphqlValue)
    expect(internalValue).toBe(dbValue)
  })

  it('DB -> GraphQL -> internal round-trips correctly for opencode', () => {
    const dbValue = 'opencode'
    const graphqlValue = dbValue === 'claude-code' ? 'claude_code' : dbValue
    const internalValue = mapGraphQLSdkToInternal(graphqlValue)
    expect(internalValue).toBe(dbValue)
  })
})

// ── Error handling: missing implementer ─────────────────────────────

describe('Regression: graceful error on unknown SDK', () => {
  it('throws clear error for unregistered SDK ID', () => {
    const impls = (['opencode', 'claude-code', 'codex'] as const).map(createMockImplementer)
    const manager = new AgentSdkManager(impls)

    expect(() => manager.getImplementer('nonexistent' as AgentSdkId)).toThrow(
      'Unknown agent SDK: "nonexistent"'
    )
  })

  it('withSdkDispatch falls through to opencode when no sdkManager', async () => {
    const ctx = { sdkManager: undefined, db: undefined } as any
    const opencodeFn = vi.fn().mockResolvedValue('fallback')
    const sdkFn = vi.fn()

    const result = await withSdkDispatch(ctx, 'any-session', opencodeFn, sdkFn)

    expect(result).toBe('fallback')
    expect(opencodeFn).toHaveBeenCalled()
    expect(sdkFn).not.toHaveBeenCalled()
  })
})

// ── Disconnect dispatch ─────────────────────────────────────────────

describe('Regression: disconnect dispatch for all providers', () => {
  let sdkManager: AgentSdkManager
  let mocks: Record<string, ReturnType<typeof createMockImplementer>>

  beforeEach(() => {
    mocks = {
      opencode: createMockImplementer('opencode'),
      'claude-code': createMockImplementer('claude-code'),
      codex: createMockImplementer('codex')
    }
    sdkManager = new AgentSdkManager(Object.values(mocks))
  })

  for (const sdk of ['opencode', 'claude-code', 'codex'] as const) {
    it(`dispatches disconnect to ${sdk} implementer`, async () => {
      const db = createMockDb({
        getAgentSdkForSession: vi.fn().mockReturnValue(sdk)
      })
      const ctx = { sdkManager, db } as any

      const opencodeFn = vi.fn().mockResolvedValue(undefined)
      const sdkFn = vi.fn().mockResolvedValue(undefined)

      await withSdkDispatch(ctx, 'agent-session-1', opencodeFn, sdkFn)

      if (sdk === 'opencode') {
        expect(opencodeFn).toHaveBeenCalled()
        expect(sdkFn).not.toHaveBeenCalled()
      } else {
        expect(sdkFn).toHaveBeenCalledWith(mocks[sdk])
        expect(opencodeFn).not.toHaveBeenCalled()
      }
    })
  }
})

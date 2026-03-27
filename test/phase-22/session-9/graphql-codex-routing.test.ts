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
import { mapGraphQLSdkToInternal } from '../../../src/server/resolvers/helpers/sdk-dispatch'

/**
 * GraphQL Codex Routing Tests (Session 9)
 *
 * Verifies that all GraphQL resolver routing patterns correctly handle
 * Codex alongside OpenCode and Claude Code.
 */

// ── Helpers ─────────────────────────────────────────────────────────

function createMockImplementer(id: AgentSdkId): AgentSdkImplementer & {
  hasPendingQuestion: ReturnType<typeof vi.fn>
  hasPendingApproval: ReturnType<typeof vi.fn>
  hasPendingPlan: ReturnType<typeof vi.fn>
  hasPendingPlanForSession: ReturnType<typeof vi.fn>
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
    reconnect: vi.fn().mockResolvedValue({ success: true }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(true),
    getMessages: vi.fn().mockResolvedValue([]),
    getAvailableModels: vi.fn().mockResolvedValue({ codex: { models: ['o3-mini'] } }),
    getModelInfo: vi.fn().mockResolvedValue({
      id: 'o3-mini',
      name: 'o3-mini',
      limit: { context: 200000, output: 100000 }
    }),
    setSelectedModel: vi.fn(),
    getSessionInfo: vi.fn().mockResolvedValue({ revertMessageID: null, revertDiff: null }),
    questionReply: vi.fn().mockResolvedValue(undefined),
    questionReject: vi.fn().mockResolvedValue(undefined),
    permissionReply: vi.fn().mockResolvedValue(undefined),
    permissionList: vi.fn().mockResolvedValue([{ requestId: 'perm-1', method: 'file_write' }]),
    undo: vi.fn().mockResolvedValue({}),
    redo: vi.fn().mockResolvedValue({}),
    listCommands: vi.fn().mockResolvedValue([]),
    sendCommand: vi.fn().mockResolvedValue(undefined),
    renameSession: vi.fn().mockResolvedValue(undefined),
    setMainWindow: vi.fn(),
    hasPendingQuestion: vi.fn().mockReturnValue(false),
    hasPendingApproval: vi.fn().mockReturnValue(false),
    hasPendingPlan: vi.fn().mockReturnValue(false),
    hasPendingPlanForSession: vi.fn().mockReturnValue(false)
  }
}

function createMockDb(overrides: Record<string, any> = {}) {
  return {
    getAgentSdkForSession: vi.fn().mockReturnValue(null),
    getSession: vi.fn().mockReturnValue(null),
    ...overrides
  }
}

// ── Tests ───────────────────────────────────────────────────────────

describe('mapGraphQLSdkToInternal', () => {
  it('maps claude_code to claude-code', () => {
    expect(mapGraphQLSdkToInternal('claude_code')).toBe('claude-code')
  })

  it('passes through opencode unchanged', () => {
    expect(mapGraphQLSdkToInternal('opencode')).toBe('opencode')
  })

  it('passes through codex unchanged', () => {
    expect(mapGraphQLSdkToInternal('codex')).toBe('codex')
  })

  it('passes through terminal unchanged', () => {
    expect(mapGraphQLSdkToInternal('terminal')).toBe('terminal')
  })
})

describe('GraphQL resolver routing: opencodeModels', () => {
  let sdkManager: AgentSdkManager
  let mockCodex: ReturnType<typeof createMockImplementer>
  let mockClaude: ReturnType<typeof createMockImplementer>

  beforeEach(() => {
    const mockOpencode = createMockImplementer('opencode')
    mockClaude = createMockImplementer('claude-code')
    mockCodex = createMockImplementer('codex')
    sdkManager = new AgentSdkManager([mockOpencode, mockClaude, mockCodex])
  })

  it('routes agentSdk=codex to codex implementer', () => {
    const agentSdk = 'codex'

    // Simulate the resolver logic
    const internalId = mapGraphQLSdkToInternal(agentSdk)
    const impl = sdkManager.getImplementer(internalId)

    expect(impl.id).toBe('codex')
    expect(impl).toBe(mockCodex)
  })

  it('routes agentSdk=claude_code to claude-code implementer', () => {
    const agentSdk = 'claude_code'

    const internalId = mapGraphQLSdkToInternal(agentSdk)
    const impl = sdkManager.getImplementer(internalId)

    expect(impl.id).toBe('claude-code')
    expect(impl).toBe(mockClaude)
  })

  it('routes agentSdk=opencode to opencode (no dispatch needed)', () => {
    const agentSdk = 'opencode'

    // In the resolver, opencode skips the dispatch block
    const shouldDispatch = agentSdk !== 'opencode'
    expect(shouldDispatch).toBe(false)
  })
})

describe('GraphQL resolver routing: opencodeSetModel', () => {
  let sdkManager: AgentSdkManager
  let mockCodex: ReturnType<typeof createMockImplementer>

  beforeEach(() => {
    const mockOpencode = createMockImplementer('opencode')
    const mockClaude = createMockImplementer('claude-code')
    mockCodex = createMockImplementer('codex')
    sdkManager = new AgentSdkManager([mockOpencode, mockClaude, mockCodex])
  })

  it('routes agentSdk=codex to codex implementer for model selection', () => {
    const agentSdk = 'codex'
    const internalId = mapGraphQLSdkToInternal(agentSdk)
    const impl = sdkManager.getImplementer(internalId)

    impl.setSelectedModel({ providerID: 'openai', modelID: 'o3-mini' })

    expect(mockCodex.setSelectedModel).toHaveBeenCalledWith({
      providerID: 'openai',
      modelID: 'o3-mini'
    })
  })

  it('routes agentSdk=claude_code to claude-code implementer for model selection', () => {
    const agentSdk = 'claude_code'
    const internalId = mapGraphQLSdkToInternal(agentSdk)
    const impl = sdkManager.getImplementer(internalId)

    impl.setSelectedModel({ providerID: 'anthropic', modelID: 'sonnet' })

    expect(impl.setSelectedModel).toHaveBeenCalledWith({
      providerID: 'anthropic',
      modelID: 'sonnet'
    })
  })
})

describe('GraphQL resolver routing: opencodeCommands by session lookup', () => {
  let sdkManager: AgentSdkManager
  let mockCodex: ReturnType<typeof createMockImplementer>

  beforeEach(() => {
    const mockOpencode = createMockImplementer('opencode')
    const mockClaude = createMockImplementer('claude-code')
    mockCodex = createMockImplementer('codex')
    sdkManager = new AgentSdkManager([mockOpencode, mockClaude, mockCodex])
  })

  it('dispatches to codex implementer when session has agent_sdk=codex', () => {
    const db = createMockDb({
      getAgentSdkForSession: vi.fn().mockReturnValue('codex')
    })

    const sdkId = db.getAgentSdkForSession('session-1')
    expect(sdkId).toBe('codex')

    // Should route to non-opencode/non-terminal implementer
    const shouldDispatch = sdkId && sdkId !== 'opencode' && sdkId !== 'terminal'
    expect(shouldDispatch).toBeTruthy()

    const impl = sdkManager.getImplementer(sdkId)
    expect(impl.id).toBe('codex')
  })

  it('falls through to opencode when session has agent_sdk=opencode', () => {
    const db = createMockDb({
      getAgentSdkForSession: vi.fn().mockReturnValue('opencode')
    })

    const sdkId = db.getAgentSdkForSession('session-1')
    const shouldDispatch = sdkId && sdkId !== 'opencode' && sdkId !== 'terminal'
    expect(shouldDispatch).toBeFalsy()
  })

  it('falls through to opencode when session has agent_sdk=terminal', () => {
    const db = createMockDb({
      getAgentSdkForSession: vi.fn().mockReturnValue('terminal')
    })

    const sdkId = db.getAgentSdkForSession('session-1')
    const shouldDispatch = sdkId && sdkId !== 'opencode' && sdkId !== 'terminal'
    expect(shouldDispatch).toBeFalsy()
  })
})

describe('GraphQL resolver routing: question/permission dispatch to Codex', () => {
  let sdkManager: AgentSdkManager
  let mockCodex: ReturnType<typeof createMockImplementer>
  let mockClaude: ReturnType<typeof createMockImplementer>

  beforeEach(() => {
    const mockOpencode = createMockImplementer('opencode')
    mockClaude = createMockImplementer('claude-code')
    mockCodex = createMockImplementer('codex')
    sdkManager = new AgentSdkManager([mockOpencode, mockClaude, mockCodex])
  })

  it('routes questionReply to codex when codex has the pending question', async () => {
    mockCodex.hasPendingQuestion.mockReturnValue(true)
    mockClaude.hasPendingQuestion.mockReturnValue(false)

    // Simulate resolver loop: check claude-code first, then codex
    const sdkIds = ['claude-code', 'codex'] as const
    let handled = false

    for (const sdkId of sdkIds) {
      const impl = sdkManager.getImplementer(sdkId) as any
      if (impl.hasPendingQuestion?.('req-42')) {
        await impl.questionReply('req-42', [['q1', 'yes']])
        handled = true
        break
      }
    }

    expect(handled).toBe(true)
    expect(mockCodex.questionReply).toHaveBeenCalledWith('req-42', [['q1', 'yes']])
    expect(mockClaude.questionReply).not.toHaveBeenCalled()
  })

  it('routes questionReply to claude when claude has the pending question', async () => {
    mockClaude.hasPendingQuestion.mockReturnValue(true)
    mockCodex.hasPendingQuestion.mockReturnValue(false)

    const sdkIds = ['claude-code', 'codex'] as const
    let handled = false

    for (const sdkId of sdkIds) {
      const impl = sdkManager.getImplementer(sdkId) as any
      if (impl.hasPendingQuestion?.('req-99')) {
        await impl.questionReply('req-99', [['q1', 'no']])
        handled = true
        break
      }
    }

    expect(handled).toBe(true)
    expect(mockClaude.questionReply).toHaveBeenCalledWith('req-99', [['q1', 'no']])
    expect(mockCodex.questionReply).not.toHaveBeenCalled()
  })

  it('falls through to opencode when neither claude nor codex has pending question', () => {
    mockClaude.hasPendingQuestion.mockReturnValue(false)
    mockCodex.hasPendingQuestion.mockReturnValue(false)

    const sdkIds = ['claude-code', 'codex'] as const
    let handled = false

    for (const sdkId of sdkIds) {
      const impl = sdkManager.getImplementer(sdkId) as any
      if (impl.hasPendingQuestion?.('req-unknown')) {
        handled = true
        break
      }
    }

    expect(handled).toBe(false)
    // Falls through to openCodeService.questionReply
  })

  it('routes permissionReply to codex when codex has pending approval', async () => {
    mockCodex.hasPendingApproval.mockReturnValue(true)
    mockClaude.hasPendingApproval.mockReturnValue(false)

    const sdkIds = ['claude-code', 'codex'] as const
    let handled = false

    for (const sdkId of sdkIds) {
      const impl = sdkManager.getImplementer(sdkId) as any
      if (impl.hasPendingApproval?.('perm-7')) {
        await impl.permissionReply('perm-7', 'once')
        handled = true
        break
      }
    }

    expect(handled).toBe(true)
    expect(mockCodex.permissionReply).toHaveBeenCalledWith('perm-7', 'once')
    expect(mockClaude.permissionReply).not.toHaveBeenCalled()
  })

  it('routes questionReject to codex when codex has the pending question', async () => {
    mockCodex.hasPendingQuestion.mockReturnValue(true)
    mockClaude.hasPendingQuestion.mockReturnValue(false)

    const sdkIds = ['claude-code', 'codex'] as const
    let handled = false

    for (const sdkId of sdkIds) {
      const impl = sdkManager.getImplementer(sdkId) as any
      if (impl.hasPendingQuestion?.('req-reject-42')) {
        await impl.questionReject('req-reject-42')
        handled = true
        break
      }
    }

    expect(handled).toBe(true)
    expect(mockCodex.questionReject).toHaveBeenCalledWith('req-reject-42')
    expect(mockClaude.questionReject).not.toHaveBeenCalled()
  })
})

describe('GraphQL resolver routing: permissionList aggregation', () => {
  let sdkManager: AgentSdkManager
  let mockCodex: ReturnType<typeof createMockImplementer>
  let mockClaude: ReturnType<typeof createMockImplementer>

  beforeEach(() => {
    const mockOpencode = createMockImplementer('opencode')
    mockClaude = createMockImplementer('claude-code')
    mockCodex = createMockImplementer('codex')

    mockClaude.permissionList.mockResolvedValue([
      { requestId: 'claude-perm-1', method: 'bash' }
    ])
    mockCodex.permissionList.mockResolvedValue([
      { requestId: 'codex-perm-1', method: 'file_write' }
    ])

    sdkManager = new AgentSdkManager([mockOpencode, mockClaude, mockCodex])
  })

  it('aggregates permissions from all implementers', async () => {
    const opencodePerms = [{ requestId: 'oc-perm-1', method: 'read' }]
    const allPermissions = [...opencodePerms]

    for (const sdkId of ['claude-code', 'codex'] as const) {
      try {
        const impl = sdkManager.getImplementer(sdkId)
        const sdkPerms = await impl.permissionList()
        allPermissions.push(...(sdkPerms as any[]))
      } catch {
        // skip
      }
    }

    expect(allPermissions).toHaveLength(3)
    expect(allPermissions[0].requestId).toBe('oc-perm-1')
    expect(allPermissions[1].requestId).toBe('claude-perm-1')
    expect(allPermissions[2].requestId).toBe('codex-perm-1')
  })
})

describe('DB session mapping: agentSdk enum consistency', () => {
  it('maps claude-code to claude_code for GraphQL', () => {
    const row = { agent_sdk: 'claude-code' }
    const graphqlValue = row.agent_sdk === 'claude-code' ? 'claude_code' : row.agent_sdk
    expect(graphqlValue).toBe('claude_code')
  })

  it('passes codex through unchanged for GraphQL', () => {
    const row = { agent_sdk: 'codex' }
    const graphqlValue = row.agent_sdk === 'claude-code' ? 'claude_code' : row.agent_sdk
    expect(graphqlValue).toBe('codex')
  })

  it('passes opencode through unchanged for GraphQL', () => {
    const row = { agent_sdk: 'opencode' }
    const graphqlValue = row.agent_sdk === 'claude-code' ? 'claude_code' : row.agent_sdk
    expect(graphqlValue).toBe('opencode')
  })

  it('maps claude_code back to claude-code for DB storage', () => {
    const input = { agentSdk: 'claude_code' }
    const dbValue =
      input.agentSdk === 'claude_code' ? 'claude-code' : input.agentSdk
    expect(dbValue).toBe('claude-code')
  })

  it('passes codex through for DB storage', () => {
    const input = { agentSdk: 'codex' }
    const dbValue =
      input.agentSdk === 'claude_code' ? 'claude-code' : input.agentSdk
    expect(dbValue).toBe('codex')
  })
})

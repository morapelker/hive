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

import { AgentSdkManager } from '../../../src/main/services/agent-sdk-manager'
import { ClaudeCodeImplementer } from '../../../src/main/services/claude-code-implementer'
import type { AgentSdkImplementer } from '../../../src/main/services/agent-sdk-types'

function createMockOpenCodeImpl(): AgentSdkImplementer {
  return {
    id: 'opencode' as const,
    capabilities: {
      supportsUndo: true,
      supportsRedo: true,
      supportsCommands: true,
      supportsPermissionRequests: true,
      supportsQuestionPrompts: true,
      supportsModelSelection: true,
      supportsReconnect: true,
      supportsPartialStreaming: true
    },
    connect: vi.fn(),
    reconnect: vi.fn(),
    disconnect: vi.fn(),
    cleanup: vi.fn(),
    prompt: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(true),
    getMessages: vi.fn().mockResolvedValue([]),
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

describe('AgentSdkManager SDK dispatch', () => {
  let manager: AgentSdkManager
  let mockOC: AgentSdkImplementer
  let claude: ClaudeCodeImplementer

  beforeEach(() => {
    mockOC = createMockOpenCodeImpl()
    claude = new ClaudeCodeImplementer()
    manager = new AgentSdkManager(mockOC, claude)
  })

  it('getImplementer("opencode") returns OpenCode implementer', () => {
    expect(manager.getImplementer('opencode').id).toBe('opencode')
  })

  it('getImplementer("claude-code") returns Claude implementer', () => {
    expect(manager.getImplementer('claude-code').id).toBe('claude-code')
  })

  it('dispatches prompt to OpenCode implementer for opencode SDK', async () => {
    const impl = manager.getImplementer('opencode')
    await impl.prompt('/proj', 'ses-1', 'hello')
    expect(mockOC.prompt).toHaveBeenCalledWith('/proj', 'ses-1', 'hello')
  })

  it('dispatches abort to OpenCode implementer for opencode SDK', async () => {
    const impl = manager.getImplementer('opencode')
    await impl.abort('/proj', 'ses-1')
    expect(mockOC.abort).toHaveBeenCalledWith('/proj', 'ses-1')
  })

  it('throws for unknown SDK id', () => {
    expect(() => manager.getImplementer('unknown' as never)).toThrow(/Unknown agent SDK/)
  })
})

import { vi } from 'vitest'
import type {
  AgentSdkCapabilities,
  AgentSdkImplementer
} from '../../../src/main/services/agent-sdk-types'

export const MOCK_OPENCODE_CAPABILITIES: AgentSdkCapabilities = {
  supportsUndo: true,
  supportsRedo: true,
  supportsCommands: true,
  supportsPermissionRequests: true,
  supportsQuestionPrompts: true,
  supportsModelSelection: true,
  supportsReconnect: true,
  supportsPartialStreaming: true
}

export const MOCK_CLAUDE_CAPABILITIES: AgentSdkCapabilities = {
  supportsUndo: true,
  supportsRedo: false,
  supportsCommands: true,
  supportsPermissionRequests: true,
  supportsQuestionPrompts: true,
  supportsModelSelection: true,
  supportsReconnect: true,
  supportsPartialStreaming: true
}

export function createMockImplementer(
  sdkId: 'opencode' | 'claude-code',
  capabilities: AgentSdkCapabilities
): AgentSdkImplementer & {
  hasPendingQuestion: ReturnType<typeof vi.fn>
  hasPendingPlan: ReturnType<typeof vi.fn>
  hasPendingPlanForSession: ReturnType<typeof vi.fn>
  planApprove: ReturnType<typeof vi.fn>
  planReject: ReturnType<typeof vi.fn>
} {
  return {
    id: sdkId,
    capabilities,
    connect: vi.fn().mockResolvedValue({ sessionId: `${sdkId}-session-1` }),
    reconnect: vi
      .fn()
      .mockResolvedValue({ success: true, sessionStatus: 'idle', revertMessageID: null }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(true),
    getMessages: vi
      .fn()
      .mockResolvedValue([{ id: '1', role: 'user', content: 'hello' }]),
    getAvailableModels: vi
      .fn()
      .mockResolvedValue({ anthropic: [{ id: 'claude-4', name: 'Claude 4' }] }),
    getModelInfo: vi.fn().mockResolvedValue({
      id: 'claude-4',
      name: 'Claude 4',
      limit: { context: 200000, output: 8192 }
    }),
    setSelectedModel: vi.fn(),
    getSessionInfo: vi
      .fn()
      .mockResolvedValue({ revertMessageID: null, revertDiff: null }),
    questionReply: vi.fn().mockResolvedValue(undefined),
    questionReject: vi.fn().mockResolvedValue(undefined),
    permissionReply: vi.fn().mockResolvedValue(undefined),
    permissionList: vi.fn().mockResolvedValue([]),
    undo: vi.fn().mockResolvedValue({
      revertMessageID: 'msg-1',
      restoredPrompt: 'original',
      revertDiff: 'diff'
    }),
    redo: vi.fn().mockResolvedValue({ revertMessageID: 'msg-2' }),
    listCommands: vi.fn().mockResolvedValue([
      { name: 'compact', description: 'Compact context', template: '/compact' }
    ]),
    sendCommand: vi.fn().mockResolvedValue(undefined),
    renameSession: vi.fn().mockResolvedValue(undefined),
    setMainWindow: vi.fn(),
    hasPendingQuestion: vi.fn().mockReturnValue(false),
    hasPendingPlan: vi.fn().mockReturnValue(false),
    hasPendingPlanForSession: vi.fn().mockReturnValue(false),
    planApprove: vi.fn().mockResolvedValue(undefined),
    planReject: vi.fn().mockResolvedValue(undefined)
  }
}

export function createMockSdkManager() {
  const opencodeImpl = createMockImplementer('opencode', MOCK_OPENCODE_CAPABILITIES)
  const claudeImpl = createMockImplementer('claude-code', MOCK_CLAUDE_CAPABILITIES)

  return {
    manager: {
      getImplementer: vi.fn((sdkId: string) => {
        if (sdkId === 'claude-code') return claudeImpl
        return opencodeImpl
      }),
      getCapabilities: vi.fn((sdkId: string) => {
        if (sdkId === 'claude-code') return MOCK_CLAUDE_CAPABILITIES
        return MOCK_OPENCODE_CAPABILITIES
      }),
      setMainWindow: vi.fn(),
      cleanupAll: vi.fn().mockResolvedValue(undefined),
      defaultSdkId: 'opencode' as const
    },
    opencodeImpl,
    claudeImpl
  }
}

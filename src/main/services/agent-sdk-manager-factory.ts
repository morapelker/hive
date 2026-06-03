import type { DatabaseService } from '../db/database'
import { AgentSdkManager } from './agent-sdk-manager'
import type { AgentSdkImplementer } from './agent-sdk-types'
import { ClaudeCodeImplementer } from './claude-code-implementer'
import { CodexImplementer } from './codex-implementer'
import { resolveClaudeBinaryPath } from './claude-binary-resolver'
import { resolveCodexBinaryPath } from './codex-binary-resolver'

export interface AgentSdkManagerFactoryOptions {
  db: DatabaseService
  claudeBinaryPath?: string | null
  codexBinaryPath?: string | null
}

export function createAgentSdkManager(options: AgentSdkManagerFactoryOptions): AgentSdkManager {
  const claudeImpl = new ClaudeCodeImplementer()
  claudeImpl.setDatabaseService(options.db)
  claudeImpl.setClaudeBinaryPath(options.claudeBinaryPath ?? resolveClaudeBinaryPath())

  const codexImpl = new CodexImplementer()
  codexImpl.setDatabaseService(options.db)
  codexImpl.setCodexBinaryPath(options.codexBinaryPath ?? resolveCodexBinaryPath())

  return new AgentSdkManager([createOpenCodePlaceholder(), claudeImpl, codexImpl])
}

function createOpenCodePlaceholder(): AgentSdkImplementer {
  return {
    id: 'opencode',
    capabilities: {
      supportsUndo: true,
      supportsRedo: true,
      supportsCommands: true,
      supportsPermissionRequests: true,
      supportsQuestionPrompts: true,
      supportsModelSelection: true,
      supportsReconnect: true,
      supportsPartialStreaming: true,
      supportsSteer: false
    },
    connect: async () => ({ sessionId: '' }),
    reconnect: async () => ({ success: false }),
    disconnect: async () => {},
    cleanup: async () => {},
    prompt: async () => {},
    abort: async () => false,
    getMessages: async () => [],
    getAvailableModels: async () => ({}),
    getModelInfo: async () => null,
    setSelectedModel: () => {},
    getSessionInfo: async () => ({ revertMessageID: null, revertDiff: null }),
    questionReply: async () => {},
    questionReject: async () => {},
    permissionReply: async () => {},
    permissionList: async () => [],
    undo: async () => ({}),
    redo: async () => ({}),
    listCommands: async () => [],
    sendCommand: async () => {},
    renameSession: async () => {}
  }
}

import type { BrowserWindow } from 'electron'

export type AgentSdkId = 'opencode' | 'claude-code' | 'terminal'

export interface AgentSdkCapabilities {
  supportsUndo: boolean
  supportsRedo: boolean
  supportsCommands: boolean
  supportsPermissionRequests: boolean
  supportsQuestionPrompts: boolean
  supportsModelSelection: boolean
  supportsReconnect: boolean
  supportsPartialStreaming: boolean
}

export interface AgentSdkImplementer {
  readonly id: AgentSdkId
  readonly capabilities: AgentSdkCapabilities

  // Lifecycle
  connect(worktreePath: string, hiveSessionId: string): Promise<{ sessionId: string }>
  reconnect(
    worktreePath: string,
    agentSessionId: string,
    hiveSessionId: string
  ): Promise<{
    success: boolean
    sessionStatus?: 'idle' | 'busy' | 'retry'
    revertMessageID?: string | null
  }>
  disconnect(worktreePath: string, agentSessionId: string): Promise<void>
  cleanup(): Promise<void>

  // Messaging
  prompt(
    worktreePath: string,
    agentSessionId: string,
    message:
      | string
      | Array<
          | { type: 'text'; text: string }
          | { type: 'file'; mime: string; url: string; filename?: string }
        >,
    modelOverride?: { providerID: string; modelID: string; variant?: string }
  ): Promise<void>
  abort(worktreePath: string, agentSessionId: string): Promise<boolean>
  getMessages(worktreePath: string, agentSessionId: string): Promise<unknown[]>

  // Models
  getAvailableModels(): Promise<unknown>
  getModelInfo(
    worktreePath: string,
    modelId: string
  ): Promise<{
    id: string
    name: string
    limit: { context: number; input?: number; output: number }
  } | null>
  setSelectedModel(model: { providerID: string; modelID: string; variant?: string }): void

  // Session info
  getSessionInfo(
    worktreePath: string,
    agentSessionId: string
  ): Promise<{
    revertMessageID: string | null
    revertDiff: string | null
  }>

  // Human-in-the-loop
  questionReply(requestId: string, answers: string[][], worktreePath?: string): Promise<void>
  questionReject(requestId: string, worktreePath?: string): Promise<void>
  permissionReply(
    requestId: string,
    decision: 'once' | 'always' | 'reject',
    worktreePath?: string
  ): Promise<void>
  permissionList(worktreePath?: string): Promise<unknown[]>

  // Undo/Redo
  undo(worktreePath: string, agentSessionId: string, hiveSessionId: string): Promise<unknown>
  redo(worktreePath: string, agentSessionId: string, hiveSessionId: string): Promise<unknown>

  // Commands
  listCommands(worktreePath: string): Promise<unknown[]>
  sendCommand(
    worktreePath: string,
    agentSessionId: string,
    command: string,
    args?: string
  ): Promise<void>

  // Session management
  renameSession(worktreePath: string, agentSessionId: string, name: string): Promise<void>

  // Window binding (for event forwarding to renderer)
  setMainWindow(window: BrowserWindow): void
}

export const OPENCODE_CAPABILITIES: AgentSdkCapabilities = {
  supportsUndo: true,
  supportsRedo: true,
  supportsCommands: true,
  supportsPermissionRequests: true,
  supportsQuestionPrompts: true,
  supportsModelSelection: true,
  supportsReconnect: true,
  supportsPartialStreaming: true
}

export const CLAUDE_CODE_CAPABILITIES: AgentSdkCapabilities = {
  supportsUndo: true,
  supportsRedo: false,
  supportsCommands: true,
  supportsPermissionRequests: true,
  supportsQuestionPrompts: true,
  supportsModelSelection: true,
  supportsReconnect: true,
  supportsPartialStreaming: true
}

export const TERMINAL_CAPABILITIES: AgentSdkCapabilities = {
  supportsUndo: false,
  supportsRedo: false,
  supportsCommands: false,
  supportsPermissionRequests: false,
  supportsQuestionPrompts: false,
  supportsModelSelection: false,
  supportsReconnect: false,
  supportsPartialStreaming: false
}

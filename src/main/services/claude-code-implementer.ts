import type { BrowserWindow } from 'electron'
import { createLogger } from './logger'
import type { AgentSdkCapabilities, AgentSdkImplementer } from './agent-sdk-types'
import { CLAUDE_CODE_CAPABILITIES } from './agent-sdk-types'

const log = createLogger({ component: 'ClaudeCodeImplementer' })

export interface ClaudeSessionState {
  claudeSessionId: string
  hiveSessionId: string
  worktreePath: string
  abortController: AbortController | null
  checkpoints: Map<string, number>
}

export class ClaudeCodeImplementer implements AgentSdkImplementer {
  readonly id = 'claude-code' as const
  readonly capabilities: AgentSdkCapabilities = CLAUDE_CODE_CAPABILITIES

  private mainWindow: BrowserWindow | null = null
  private sessions = new Map<string, ClaudeSessionState>()

  // ── Window binding ───────────────────────────────────────────────

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  async connect(_worktreePath: string, _hiveSessionId: string): Promise<{ sessionId: string }> {
    throw new Error('ClaudeCodeImplementer.connect: not yet implemented (Session 3)')
  }

  async reconnect(
    _worktreePath: string,
    _agentSessionId: string,
    _hiveSessionId: string
  ): Promise<{
    success: boolean
    sessionStatus?: 'idle' | 'busy' | 'retry'
    revertMessageID?: string | null
  }> {
    throw new Error('ClaudeCodeImplementer.reconnect: not yet implemented (Session 4)')
  }

  async disconnect(_worktreePath: string, _agentSessionId: string): Promise<void> {
    throw new Error('ClaudeCodeImplementer.disconnect: not yet implemented (Session 4)')
  }

  async cleanup(): Promise<void> {
    log.info('Cleaning up all Claude Code sessions', { count: this.sessions.size })
    for (const [key, session] of this.sessions) {
      if (session.abortController) {
        log.debug('Aborting session', { key })
        session.abortController.abort()
      }
    }
    this.sessions.clear()
  }

  // ── Messaging ────────────────────────────────────────────────────

  async prompt(
    _worktreePath: string,
    _agentSessionId: string,
    _message:
      | string
      | Array<
          | { type: 'text'; text: string }
          | { type: 'file'; mime: string; url: string; filename?: string }
        >,
    _modelOverride?: { providerID: string; modelID: string; variant?: string }
  ): Promise<void> {
    throw new Error('ClaudeCodeImplementer.prompt: not yet implemented (Session 3)')
  }

  async abort(_worktreePath: string, _agentSessionId: string): Promise<boolean> {
    throw new Error('ClaudeCodeImplementer.abort: not yet implemented (Session 4)')
  }

  async getMessages(_worktreePath: string, _agentSessionId: string): Promise<unknown[]> {
    throw new Error('ClaudeCodeImplementer.getMessages: not yet implemented (Session 4)')
  }

  // ── Models ───────────────────────────────────────────────────────

  async getAvailableModels(): Promise<unknown> {
    throw new Error('ClaudeCodeImplementer.getAvailableModels: not yet implemented (Session 5)')
  }

  async getModelInfo(
    _worktreePath: string,
    _modelId: string
  ): Promise<{
    id: string
    name: string
    limit: { context: number; input?: number; output: number }
  } | null> {
    throw new Error('ClaudeCodeImplementer.getModelInfo: not yet implemented (Session 5)')
  }

  setSelectedModel(_model: { providerID: string; modelID: string; variant?: string }): void {
    throw new Error('ClaudeCodeImplementer.setSelectedModel: not yet implemented (Session 5)')
  }

  // ── Session info ─────────────────────────────────────────────────

  async getSessionInfo(
    _worktreePath: string,
    _agentSessionId: string
  ): Promise<{
    revertMessageID: string | null
    revertDiff: string | null
  }> {
    throw new Error('ClaudeCodeImplementer.getSessionInfo: not yet implemented (Session 4)')
  }

  // ── Human-in-the-loop ────────────────────────────────────────────

  async questionReply(
    _requestId: string,
    _answers: string[][],
    _worktreePath?: string
  ): Promise<void> {
    throw new Error('ClaudeCodeImplementer.questionReply: not yet implemented (Session 4)')
  }

  async questionReject(_requestId: string, _worktreePath?: string): Promise<void> {
    throw new Error('ClaudeCodeImplementer.questionReject: not yet implemented (Session 4)')
  }

  async permissionReply(
    _requestId: string,
    _decision: 'once' | 'always' | 'reject',
    _worktreePath?: string
  ): Promise<void> {
    throw new Error('ClaudeCodeImplementer.permissionReply: not yet implemented (Session 4)')
  }

  async permissionList(_worktreePath?: string): Promise<unknown[]> {
    throw new Error('ClaudeCodeImplementer.permissionList: not yet implemented (Session 4)')
  }

  // ── Undo/Redo ────────────────────────────────────────────────────

  async undo(
    _worktreePath: string,
    _agentSessionId: string,
    _hiveSessionId: string
  ): Promise<unknown> {
    throw new Error('ClaudeCodeImplementer.undo: not yet implemented (Session 5)')
  }

  async redo(
    _worktreePath: string,
    _agentSessionId: string,
    _hiveSessionId: string
  ): Promise<unknown> {
    throw new Error('ClaudeCodeImplementer.redo: not yet implemented (Session 5)')
  }

  // ── Commands ─────────────────────────────────────────────────────

  async listCommands(_worktreePath: string): Promise<unknown[]> {
    throw new Error('ClaudeCodeImplementer.listCommands: not yet implemented (Session 5)')
  }

  async sendCommand(
    _worktreePath: string,
    _agentSessionId: string,
    _command: string,
    _args?: string
  ): Promise<void> {
    throw new Error('ClaudeCodeImplementer.sendCommand: not yet implemented (Session 5)')
  }

  // ── Session management ───────────────────────────────────────────

  async renameSession(
    _worktreePath: string,
    _agentSessionId: string,
    _name: string
  ): Promise<void> {
    throw new Error('ClaudeCodeImplementer.renameSession: not yet implemented (Session 5)')
  }

  // ── Internal helpers ─────────────────────────────────────────────

  protected getSessionKey(worktreePath: string, claudeSessionId: string): string {
    return `${worktreePath}::${claudeSessionId}`
  }

  protected getSession(
    worktreePath: string,
    claudeSessionId: string
  ): ClaudeSessionState | undefined {
    return this.sessions.get(this.getSessionKey(worktreePath, claudeSessionId))
  }

  protected sendToRenderer(channel: string, data: unknown): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data)
    } else {
      log.warn('Cannot send to renderer: window not available')
    }
  }
}

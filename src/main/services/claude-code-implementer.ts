import type { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { createLogger } from './logger'
import type { AgentSdkCapabilities, AgentSdkImplementer } from './agent-sdk-types'
import { CLAUDE_CODE_CAPABILITIES } from './agent-sdk-types'

const log = createLogger({ component: 'ClaudeCodeImplementer' })

export interface ClaudeQuery {
  interrupt(): Promise<void>
  close(): void
  return?(value?: void): Promise<IteratorResult<unknown, void>>
  next(...args: unknown[]): Promise<IteratorResult<unknown, void>>
  [Symbol.asyncIterator](): AsyncGenerator<unknown, void>
}

export interface ClaudeSessionState {
  claudeSessionId: string
  hiveSessionId: string
  worktreePath: string
  abortController: AbortController | null
  checkpoints: Map<string, number>
  query: ClaudeQuery | null
  materialized: boolean
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

  async connect(worktreePath: string, hiveSessionId: string): Promise<{ sessionId: string }> {
    const placeholderId = `pending::${randomUUID()}`

    const key = this.getSessionKey(worktreePath, placeholderId)
    const state: ClaudeSessionState = {
      claudeSessionId: placeholderId,
      hiveSessionId,
      worktreePath,
      abortController: new AbortController(),
      checkpoints: new Map(),
      query: null,
      materialized: false
    }
    this.sessions.set(key, state)

    log.info('Connected (deferred)', { worktreePath, hiveSessionId, placeholderId })
    return { sessionId: placeholderId }
  }

  async reconnect(
    worktreePath: string,
    agentSessionId: string,
    hiveSessionId: string
  ): Promise<{
    success: boolean
    sessionStatus?: 'idle' | 'busy' | 'retry'
    revertMessageID?: string | null
  }> {
    const key = this.getSessionKey(worktreePath, agentSessionId)

    const existing = this.sessions.get(key)
    if (existing) {
      existing.hiveSessionId = hiveSessionId
      log.info('Reconnect: session already registered, updated hiveSessionId', {
        worktreePath,
        agentSessionId,
        hiveSessionId
      })
      return { success: true, sessionStatus: 'idle', revertMessageID: null }
    }

    const state: ClaudeSessionState = {
      claudeSessionId: agentSessionId,
      hiveSessionId,
      worktreePath,
      abortController: new AbortController(),
      checkpoints: new Map(),
      query: null,
      materialized: true
    }
    this.sessions.set(key, state)

    log.info('Reconnected (deferred)', { worktreePath, agentSessionId, hiveSessionId })
    return { success: true, sessionStatus: 'idle', revertMessageID: null }
  }

  async disconnect(worktreePath: string, agentSessionId: string): Promise<void> {
    const key = this.getSessionKey(worktreePath, agentSessionId)
    const session = this.sessions.get(key)

    if (!session) {
      log.warn('Disconnect: session not found, ignoring', { worktreePath, agentSessionId })
      return
    }

    if (session.query) {
      try {
        session.query.close()
      } catch {
        log.warn('Disconnect: query.close() threw, ignoring', { worktreePath, agentSessionId })
      }
      session.query = null
    }

    if (session.abortController) {
      session.abortController.abort()
    }

    this.sessions.delete(key)
    log.info('Disconnected', { worktreePath, agentSessionId })
  }

  async cleanup(): Promise<void> {
    log.info('Cleaning up all Claude Code sessions', { count: this.sessions.size })
    for (const [key, session] of this.sessions) {
      if (session.query) {
        try {
          session.query.close()
        } catch {
          log.warn('Cleanup: query.close() threw, ignoring', { key })
        }
        session.query = null
      }
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
    throw new Error('ClaudeCodeImplementer.prompt: not yet implemented (Session 4)')
  }

  async abort(_worktreePath: string, _agentSessionId: string): Promise<boolean> {
    throw new Error('ClaudeCodeImplementer.abort: not yet implemented (Session 4)')
  }

  async getMessages(_worktreePath: string, _agentSessionId: string): Promise<unknown[]> {
    throw new Error('ClaudeCodeImplementer.getMessages: not yet implemented (Session 4)')
  }

  // ── Models ───────────────────────────────────────────────────────

  async getAvailableModels(): Promise<unknown> {
    throw new Error('ClaudeCodeImplementer.getAvailableModels: not yet implemented (Session 6)')
  }

  async getModelInfo(
    _worktreePath: string,
    _modelId: string
  ): Promise<{
    id: string
    name: string
    limit: { context: number; input?: number; output: number }
  } | null> {
    throw new Error('ClaudeCodeImplementer.getModelInfo: not yet implemented (Session 6)')
  }

  setSelectedModel(_model: { providerID: string; modelID: string; variant?: string }): void {
    throw new Error('ClaudeCodeImplementer.setSelectedModel: not yet implemented (Session 6)')
  }

  // ── Session info ─────────────────────────────────────────────────

  async getSessionInfo(
    _worktreePath: string,
    _agentSessionId: string
  ): Promise<{
    revertMessageID: string | null
    revertDiff: string | null
  }> {
    throw new Error('ClaudeCodeImplementer.getSessionInfo: not yet implemented (Session 5)')
  }

  // ── Human-in-the-loop ────────────────────────────────────────────

  async questionReply(
    _requestId: string,
    _answers: string[][],
    _worktreePath?: string
  ): Promise<void> {
    throw new Error('ClaudeCodeImplementer.questionReply: not yet implemented (Session 7)')
  }

  async questionReject(_requestId: string, _worktreePath?: string): Promise<void> {
    throw new Error('ClaudeCodeImplementer.questionReject: not yet implemented (Session 7)')
  }

  async permissionReply(
    _requestId: string,
    _decision: 'once' | 'always' | 'reject',
    _worktreePath?: string
  ): Promise<void> {
    throw new Error('ClaudeCodeImplementer.permissionReply: not yet implemented (Session 7)')
  }

  async permissionList(_worktreePath?: string): Promise<unknown[]> {
    throw new Error('ClaudeCodeImplementer.permissionList: not yet implemented (Session 7)')
  }

  // ── Undo/Redo ────────────────────────────────────────────────────

  async undo(
    _worktreePath: string,
    _agentSessionId: string,
    _hiveSessionId: string
  ): Promise<unknown> {
    throw new Error('ClaudeCodeImplementer.undo: not yet implemented (Session 8)')
  }

  async redo(
    _worktreePath: string,
    _agentSessionId: string,
    _hiveSessionId: string
  ): Promise<unknown> {
    throw new Error('ClaudeCodeImplementer.redo: not yet implemented (Session 8)')
  }

  // ── Commands ─────────────────────────────────────────────────────

  async listCommands(_worktreePath: string): Promise<unknown[]> {
    throw new Error('ClaudeCodeImplementer.listCommands: not yet implemented (Session 7)')
  }

  async sendCommand(
    _worktreePath: string,
    _agentSessionId: string,
    _command: string,
    _args?: string
  ): Promise<void> {
    throw new Error('ClaudeCodeImplementer.sendCommand: not yet implemented (Session 7)')
  }

  // ── Session management ───────────────────────────────────────────

  async renameSession(
    _worktreePath: string,
    _agentSessionId: string,
    _name: string
  ): Promise<void> {
    throw new Error('ClaudeCodeImplementer.renameSession: not yet implemented (Session 9)')
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

import type { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { createLogger } from './logger'
import { loadClaudeSDK } from './claude-sdk-loader'
import type { AgentSdkCapabilities, AgentSdkImplementer } from './agent-sdk-types'
import { CLAUDE_CODE_CAPABILITIES } from './agent-sdk-types'
import type { DatabaseService } from '../db/database'
import { readClaudeTranscript, translateEntry } from './claude-transcript-reader'

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
  messages: unknown[]
}

export class ClaudeCodeImplementer implements AgentSdkImplementer {
  readonly id = 'claude-code' as const
  readonly capabilities: AgentSdkCapabilities = CLAUDE_CODE_CAPABILITIES

  private mainWindow: BrowserWindow | null = null
  private dbService: DatabaseService | null = null
  private sessions = new Map<string, ClaudeSessionState>()

  // ── Window binding ───────────────────────────────────────────────

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  setDatabaseService(db: DatabaseService): void {
    this.dbService = db
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
      materialized: false,
      messages: []
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
      materialized: true,
      messages: []
    }
    this.sessions.set(key, state)

    log.info('Reconnected (restored from DB)', { worktreePath, agentSessionId, hiveSessionId })
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
    worktreePath: string,
    agentSessionId: string,
    message:
      | string
      | Array<
          | { type: 'text'; text: string }
          | { type: 'file'; mime: string; url: string; filename?: string }
        >,
    _modelOverride?: { providerID: string; modelID: string; variant?: string }
  ): Promise<void> {
    const session = this.getSession(worktreePath, agentSessionId)
    if (!session) {
      throw new Error(`Prompt failed: session not found for ${worktreePath} / ${agentSessionId}`)
    }

    this.emitStatus(session.hiveSessionId, 'busy')

    try {
      const sdk = await loadClaudeSDK()

      // Build prompt string from message parts
      const prompt =
        typeof message === 'string'
          ? message
          : message
              .map((part) =>
                part.type === 'text' ? part.text : `[file: ${part.filename ?? part.url}]`
              )
              .join('\n')

      // Fresh AbortController for this prompt turn
      session.abortController = new AbortController()

      // Build SDK query options
      const options: Record<string, unknown> = {
        cwd: session.worktreePath,
        permissionMode: 'default',
        abortController: session.abortController,
        maxThinkingTokens: 31999
      }

      // If session is materialized (has real SDK ID), add resume
      if (session.materialized) {
        options.resume = session.claudeSessionId
      }

      const queryData = sdk.query({ prompt, options }) as AsyncIterable<Record<string, unknown>>
      session.query = queryData as unknown as ClaudeQuery

      let messageIndex = 0

      for await (const sdkMessage of queryData) {
        // Break if aborted
        if (session.abortController?.signal.aborted) break

        const msgType = sdkMessage.type as string

        // Skip init messages
        if (msgType === 'init') continue

        // Materialize pending:: to real SDK session ID from first message
        const sdkSessionId = sdkMessage.session_id as string | undefined
        if (sdkSessionId && session.claudeSessionId.startsWith('pending::')) {
          const oldKey = this.getSessionKey(worktreePath, session.claudeSessionId)
          session.claudeSessionId = sdkSessionId
          session.materialized = true
          this.sessions.delete(oldKey)
          const newKey = this.getSessionKey(worktreePath, sdkSessionId)
          this.sessions.set(newKey, session)
          log.info('Materialized session ID', { oldKey, newKey })

          // Update DB so future IPC calls with the new ID resolve correctly
          if (this.dbService) {
            try {
              this.dbService.updateSession(session.hiveSessionId, {
                opencode_session_id: sdkSessionId
              })
              log.info('Updated DB opencode_session_id', {
                hiveSessionId: session.hiveSessionId,
                newAgentSessionId: sdkSessionId
              })
            } catch (err) {
              log.error('Failed to update opencode_session_id in DB', {
                hiveSessionId: session.hiveSessionId,
                error: err instanceof Error ? err.message : String(err)
              })
            }
          }
        }

        // Capture user message UUIDs as checkpoints
        if (msgType === 'user' && sdkMessage.uuid) {
          session.checkpoints.set(sdkMessage.uuid as string, messageIndex)
        }

        // Accumulate translated messages in-memory for getMessages()
        if (msgType === 'user' || msgType === 'assistant') {
          const sdkMsg = sdkMessage as Record<string, unknown>
          const translated = translateEntry(
            {
              type: msgType,
              uuid: sdkMsg.uuid as string | undefined,
              timestamp: new Date().toISOString(),
              message: sdkMsg.message as
                | { role?: string; content?: { type: string; [key: string]: unknown }[] | string }
                | undefined,
              isSidechain: false
            },
            session.messages.length
          )
          if (translated) {
            session.messages.push(translated)
          }
        }

        // Emit normalized event
        this.emitSdkMessage(session.hiveSessionId, sdkMessage, messageIndex)
        messageIndex++
      }

      this.emitStatus(session.hiveSessionId, 'idle')
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      log.error('Prompt streaming error', { worktreePath, agentSessionId, error: errorMessage })

      this.sendToRenderer('opencode:stream', {
        type: 'session.error',
        sessionId: session.hiveSessionId,
        data: { error: errorMessage }
      })
      this.emitStatus(session.hiveSessionId, 'idle')
    } finally {
      session.query = null
    }
  }

  async abort(worktreePath: string, agentSessionId: string): Promise<boolean> {
    const session = this.getSession(worktreePath, agentSessionId)
    if (!session) {
      log.warn('Abort: session not found', { worktreePath, agentSessionId })
      return false
    }

    if (session.abortController) {
      session.abortController.abort()
    }

    if (session.query) {
      try {
        await session.query.interrupt()
      } catch {
        log.warn('Abort: query.interrupt() threw, ignoring', { worktreePath, agentSessionId })
      }
    }

    session.query = null
    this.emitStatus(session.hiveSessionId, 'idle')
    return true
  }

  async getMessages(worktreePath: string, agentSessionId: string): Promise<unknown[]> {
    // First: check in-memory cache
    const session = this.getSession(worktreePath, agentSessionId)
    if (session && session.messages.length > 0) {
      return session.messages
    }
    // Fallback: read from JSONL transcript on disk
    return readClaudeTranscript(worktreePath, agentSessionId)
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
    // Revert tracking deferred to Session 8 (undo/redo)
    return { revertMessageID: null, revertDiff: null }
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

  private emitStatus(
    hiveSessionId: string,
    status: 'idle' | 'busy' | 'retry',
    extra?: { attempt?: number; message?: string; next?: number }
  ): void {
    const statusPayload = { type: status, ...extra }
    this.sendToRenderer('opencode:stream', {
      type: 'session.status',
      sessionId: hiveSessionId,
      data: { status: statusPayload },
      statusPayload
    })
  }

  private emitSdkMessage(
    hiveSessionId: string,
    msg: Record<string, unknown>,
    messageIndex: number
  ): void {
    const msgType = msg.type as string
    const content = msg.content as unknown[] | undefined

    switch (msgType) {
      case 'assistant': {
        if (Array.isArray(content)) {
          for (const block of content) {
            this.sendToRenderer('opencode:stream', {
              type: 'message.part.updated',
              sessionId: hiveSessionId,
              data: {
                role: 'assistant',
                content: block,
                messageIndex
              }
            })
          }
        }
        break
      }
      case 'result': {
        this.sendToRenderer('opencode:stream', {
          type: 'message.updated',
          sessionId: hiveSessionId,
          data: {
            role: 'assistant',
            content,
            isError: msg.is_error ?? false,
            messageIndex
          }
        })
        break
      }
      case 'user': {
        if (Array.isArray(content)) {
          for (const block of content) {
            this.sendToRenderer('opencode:stream', {
              type: 'message.part.updated',
              sessionId: hiveSessionId,
              data: {
                role: 'user',
                content: block,
                messageIndex
              }
            })
          }
        }
        break
      }
      case 'tool_use': {
        this.sendToRenderer('opencode:stream', {
          type: 'message.part.updated',
          sessionId: hiveSessionId,
          data: {
            type: 'tool-use',
            content: msg,
            messageIndex
          }
        })
        break
      }
      default: {
        log.debug('Unhandled SDK message type, skipping', { type: msgType })
      }
    }
  }

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

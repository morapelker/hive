import type { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { createLogger } from './logger'
import { loadClaudeSDK } from './claude-sdk-loader'
import type { AgentSdkCapabilities, AgentSdkImplementer } from './agent-sdk-types'
import { CLAUDE_CODE_CAPABILITIES } from './agent-sdk-types'
import type { DatabaseService } from '../db/database'
import { readClaudeTranscript, translateEntry } from './claude-transcript-reader'

const log = createLogger({ component: 'ClaudeCodeImplementer' })

const CLAUDE_MODELS = [
  {
    id: 'opus',
    name: 'Claude Opus 4',
    limit: { context: 200000, output: 32000 }
  },
  {
    id: 'sonnet',
    name: 'Claude Sonnet 4.5',
    limit: { context: 200000, output: 16000 }
  },
  {
    id: 'haiku',
    name: 'Claude Haiku 3.5',
    limit: { context: 200000, output: 8192 }
  }
]

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
  /** Maps tool_use IDs to their tool names for lookup on tool_result completion */
  toolNames: Map<string, string>
}

export class ClaudeCodeImplementer implements AgentSdkImplementer {
  readonly id = 'claude-code' as const
  readonly capabilities: AgentSdkCapabilities = CLAUDE_CODE_CAPABILITIES

  private mainWindow: BrowserWindow | null = null
  private dbService: DatabaseService | null = null
  private sessions = new Map<string, ClaudeSessionState>()
  private selectedModel: string = 'sonnet'
  /** Tracks in-flight tool_use content blocks for input_json_delta accumulation.
   *  Keyed by hiveSessionId → Map<blockIndex, { id, name, inputJson }>. */
  private activeToolBlocks = new Map<
    string,
    Map<number, { id: string; name: string; inputJson: string }>
  >()

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
      messages: [],
      toolNames: new Map()
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
      messages: [],
      toolNames: new Map()
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
    modelOverride?: { providerID: string; modelID: string; variant?: string }
  ): Promise<void> {
    const session = this.getSession(worktreePath, agentSessionId)
    if (!session) {
      throw new Error(`Prompt failed: session not found for ${worktreePath} / ${agentSessionId}`)
    }

    this.emitStatus(session.hiveSessionId, 'busy')
    log.info('Prompt: starting', {
      worktreePath,
      agentSessionId,
      hiveSessionId: session.hiveSessionId,
      materialized: session.materialized,
      claudeSessionId: session.claudeSessionId
    })

    try {
      const sdk = await loadClaudeSDK()
      log.info('Prompt: SDK loaded')

      // Build prompt string from message parts
      const prompt =
        typeof message === 'string'
          ? message
          : message
              .map((part) =>
                part.type === 'text' ? part.text : `[file: ${part.filename ?? part.url}]`
              )
              .join('\n')

      log.info('Prompt: constructed', {
        promptLength: prompt.length,
        promptPreview: prompt.slice(0, 100)
      })

      // Inject a synthetic user message into session.messages so that
      // getMessages() returns it alongside the assistant response.
      // The SDK does NOT emit a `user` type event — without this,
      // loadMessages() on idle would replace state with only the assistant
      // message, causing the user's message to vanish.
      session.messages.push({
        id: `user-${randomUUID()}`,
        role: 'user',
        timestamp: new Date().toISOString(),
        content: prompt,
        parts: [{ type: 'text', text: prompt, timestamp: new Date().toISOString() }]
      })

      // Fresh AbortController for this prompt turn
      session.abortController = new AbortController()

      // Build SDK query options
      const options: Record<string, unknown> = {
        cwd: session.worktreePath,
        permissionMode: 'default',
        abortController: session.abortController,
        maxThinkingTokens: 31999,
        model: modelOverride?.modelID ?? this.selectedModel,
        includePartialMessages: true
      }

      // If session is materialized (has real SDK ID), add resume
      if (session.materialized) {
        options.resume = session.claudeSessionId
      }

      log.info('Prompt: calling sdk.query()', {
        model: options.model,
        resume: !!options.resume,
        cwd: options.cwd
      })

      const queryData = sdk.query({ prompt, options }) as AsyncIterable<Record<string, unknown>>
      session.query = queryData as unknown as ClaudeQuery

      log.info('Prompt: entering async iteration loop')

      let messageIndex = 0

      for await (const sdkMessage of queryData) {
        // Break if aborted
        if (session.abortController?.signal.aborted) {
          log.info('Prompt: aborted, breaking loop')
          break
        }

        const msgType = sdkMessage.type as string

        // stream_event messages fire per-token — log at debug to avoid spam
        if (msgType === 'stream_event') {
          this.emitSdkMessage(session.hiveSessionId, sdkMessage, messageIndex, session.toolNames)
          continue // No materialization/accumulation needed for partials
        }

        log.info('Prompt: received SDK message', {
          type: msgType,
          index: messageIndex,
          hasSessionId: !!sdkMessage.session_id,
          hasContent: !!sdkMessage.content,
          keys: Object.keys(sdkMessage).join(',')
        })

        // Skip init messages
        if (msgType === 'init') {
          log.info('Prompt: skipping init message')
          continue
        }

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

          // Notify renderer so it updates its opencodeSessionId state
          // (otherwise loadMessages() after idle will use the stale pending:: ID)
          this.sendToRenderer('opencode:stream', {
            type: 'session.materialized',
            sessionId: session.hiveSessionId,
            data: { newSessionId: sdkSessionId }
          })
        }

        // Capture user message UUIDs as checkpoints
        if (msgType === 'user' && sdkMessage.uuid) {
          session.checkpoints.set(sdkMessage.uuid as string, messageIndex)
        }

        // Accumulate translated messages in-memory for getMessages()
        if (msgType === 'user' || msgType === 'assistant') {
          const sdkMsg = sdkMessage as Record<string, unknown>
          const msgContent = (
            sdkMsg.message as { content?: { type: string; [key: string]: unknown }[] } | undefined
          )?.content
          const contentBlockTypes = Array.isArray(msgContent) ? msgContent.map((b) => b.type) : []
          const isToolResultOnly =
            msgType === 'user' &&
            contentBlockTypes.length > 0 &&
            contentBlockTypes.every((t) => t === 'tool_result')

          log.info('TOOL_LIFECYCLE: accumulate message', {
            hiveSessionId: session.hiveSessionId,
            msgType,
            contentBlockTypes,
            isToolResultOnly
          })

          if (isToolResultOnly) {
            // Instead of creating an empty user message, merge tool_result
            // output/error into the preceding assistant message's tool_use parts.
            const toolResults = msgContent as {
              type: string
              tool_use_id?: string
              is_error?: boolean
              content?: string | { type: string; text?: string }[]
            }[]
            // Find the last assistant message
            const lastAssistant = [...session.messages]
              .reverse()
              .find((m) => (m as Record<string, unknown>).role === 'assistant') as
              | Record<string, unknown>
              | undefined
            if (lastAssistant) {
              const parts = lastAssistant.parts as Record<string, unknown>[] | undefined
              if (Array.isArray(parts)) {
                for (const tr of toolResults) {
                  if (tr.type !== 'tool_result' || !tr.tool_use_id) continue
                  let output: string | undefined
                  if (typeof tr.content === 'string') {
                    output = tr.content
                  } else if (Array.isArray(tr.content)) {
                    output = tr.content
                      .filter((c) => c.type === 'text')
                      .map((c) => c.text ?? '')
                      .join('\n')
                  }
                  const toolPart = parts.find(
                    (p) =>
                      p.type === 'tool_use' &&
                      (p.toolUse as Record<string, unknown> | undefined)?.id === tr.tool_use_id
                  )
                  if (toolPart) {
                    const tu = toolPart.toolUse as Record<string, unknown>
                    tu.output = output
                    tu.error = tr.is_error ? output : undefined
                    tu.status = tr.is_error ? 'error' : 'success'
                    log.info('TOOL_LIFECYCLE: merged tool_result into assistant tool_use', {
                      toolId: tr.tool_use_id,
                      isError: !!tr.is_error,
                      hasOutput: !!output
                    })
                  }
                }
              }
            }
          } else {
            const translated = translateEntry(
              {
                type: msgType,
                uuid: sdkMsg.uuid as string | undefined,
                timestamp: new Date().toISOString(),
                message: sdkMsg.message as
                  | {
                      role?: string
                      content?: { type: string; [key: string]: unknown }[] | string
                    }
                  | undefined,
                isSidechain: false
              },
              session.messages.length
            )
            if (translated) {
              session.messages.push(translated)
            }
          }
        }

        // Emit normalized event
        this.emitSdkMessage(session.hiveSessionId, sdkMessage, messageIndex, session.toolNames)
        messageIndex++
      }

      log.info('Prompt: async iteration loop finished', {
        totalMessages: messageIndex,
        aborted: session.abortController?.signal.aborted ?? false
      })
      this.emitStatus(session.hiveSessionId, 'idle')
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      log.error('Prompt streaming error', {
        worktreePath,
        agentSessionId,
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined
      })

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
      log.info('TOOL_LIFECYCLE: getMessages returning in-memory', {
        agentSessionId,
        count: session.messages.length,
        breakdown: session.messages.map((m) => {
          const msg = m as Record<string, unknown>
          const parts = msg.parts as Record<string, unknown>[] | undefined
          return {
            role: msg.role,
            partsCount: parts?.length ?? 0,
            types: parts?.map((p) => p.type) ?? [],
            hasToolOutput:
              parts?.some(
                (p) =>
                  p.type === 'tool_use' &&
                  !!(p.toolUse as Record<string, unknown> | undefined)?.output
              ) ?? false
          }
        })
      })
      return session.messages
    }
    log.info('getMessages: no in-memory messages, falling back to transcript', {
      agentSessionId,
      sessionFound: !!session
    })
    // Fallback: read from JSONL transcript on disk
    return readClaudeTranscript(worktreePath, agentSessionId)
  }

  // ── Models ───────────────────────────────────────────────────────

  async getAvailableModels(): Promise<unknown> {
    return [
      {
        id: 'claude-code',
        name: 'Claude Code',
        models: Object.fromEntries(
          CLAUDE_MODELS.map((m) => [m.id, { id: m.id, name: m.name, limit: m.limit }])
        )
      }
    ]
  }

  async getModelInfo(
    _worktreePath: string,
    modelId: string
  ): Promise<{
    id: string
    name: string
    limit: { context: number; input?: number; output: number }
  } | null> {
    const model = CLAUDE_MODELS.find((m) => m.id === modelId)
    if (!model) return null
    return { id: model.id, name: model.name, limit: model.limit }
  }

  setSelectedModel(model: { providerID: string; modelID: string; variant?: string }): void {
    this.selectedModel = model.modelID
    log.info('Selected model set', { model: model.modelID })
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
    messageIndex: number,
    toolNames?: Map<string, string>
  ): void {
    const msgType = msg.type as string

    // SDK messages nest content under `msg.message.content` for assistant/user,
    // and under `msg.result` for result messages (NOT top-level `msg.content`).
    const innerMessage = msg.message as Record<string, unknown> | undefined
    const innerContent = innerMessage?.content as unknown[] | undefined

    switch (msgType) {
      // ── Token-level streaming events (includePartialMessages: true) ──
      case 'stream_event': {
        const rawEvent = msg.event as Record<string, unknown> | undefined
        if (!rawEvent) break

        const eventType = rawEvent.type as string
        // Route child-session stream events by parent_tool_use_id
        const childSessionId = (msg.parent_tool_use_id as string) || undefined

        switch (eventType) {
          case 'content_block_delta': {
            const delta = rawEvent.delta as Record<string, unknown> | undefined
            if (!delta) break
            const deltaType = delta.type as string

            if (deltaType === 'text_delta') {
              const text = delta.text as string
              this.sendToRenderer('opencode:stream', {
                type: 'message.part.updated',
                sessionId: hiveSessionId,
                childSessionId,
                data: {
                  part: { type: 'text', text },
                  delta: text
                }
              })
            } else if (deltaType === 'thinking_delta') {
              const thinking = delta.thinking as string
              this.sendToRenderer('opencode:stream', {
                type: 'message.part.updated',
                sessionId: hiveSessionId,
                childSessionId,
                data: {
                  part: { type: 'reasoning', text: thinking },
                  delta: thinking
                }
              })
            } else if (deltaType === 'input_json_delta') {
              // Tool input arrives as incremental JSON chunks.
              // Accumulate in the active tool block tracker so we can
              // emit a tool update with input once the block stops.
              const partialJson = delta.partial_json as string
              if (partialJson && this.activeToolBlocks.has(hiveSessionId)) {
                const tools = this.activeToolBlocks.get(hiveSessionId)!
                const blockIdx = rawEvent.index as number | undefined
                if (blockIdx !== undefined && tools.has(blockIdx)) {
                  const tool = tools.get(blockIdx)!
                  tool.inputJson += partialJson
                }
              }
            }
            break
          }
          case 'content_block_start': {
            const contentBlock = rawEvent.content_block as Record<string, unknown> | undefined
            if (!contentBlock) break
            const blockType = contentBlock.type as string
            const blockIdx = rawEvent.index as number | undefined

            if (blockType === 'tool_use') {
              const toolId = contentBlock.id as string
              const toolName = contentBlock.name as string
              log.info('TOOL_LIFECYCLE: content_block_start', {
                hiveSessionId,
                toolId,
                toolName,
                blockIdx
              })
              // Remember tool name for later lookup on tool_result
              if (toolNames) {
                toolNames.set(toolId, toolName)
              }
              // Track active tool block for input_json_delta accumulation
              if (!this.activeToolBlocks.has(hiveSessionId)) {
                this.activeToolBlocks.set(hiveSessionId, new Map())
              }
              if (blockIdx !== undefined) {
                this.activeToolBlocks.get(hiveSessionId)!.set(blockIdx, {
                  id: toolId,
                  name: toolName,
                  inputJson: ''
                })
              }
              this.sendToRenderer('opencode:stream', {
                type: 'message.part.updated',
                sessionId: hiveSessionId,
                childSessionId,
                data: {
                  part: {
                    type: 'tool',
                    callID: toolId,
                    tool: toolName,
                    state: { status: 'running', input: undefined }
                  }
                }
              })
            } else if (blockType === 'thinking') {
              // Start of a thinking/reasoning block — the actual content
              // arrives via content_block_delta thinking_delta events.
              // Nothing to emit here; the first delta creates the part.
            }
            break
          }
          case 'content_block_stop': {
            const blockIdx = rawEvent.index as number | undefined
            if (blockIdx !== undefined && this.activeToolBlocks.has(hiveSessionId)) {
              const tools = this.activeToolBlocks.get(hiveSessionId)!
              const tool = tools.get(blockIdx)
              if (tool) {
                log.info('TOOL_LIFECYCLE: content_block_stop', {
                  hiveSessionId,
                  toolId: tool.id,
                  toolName: tool.name,
                  hasInput: !!tool.inputJson,
                  inputLength: tool.inputJson.length
                })
                // Emit tool with accumulated input now that the block is complete
                let parsedInput: unknown = undefined
                if (tool.inputJson) {
                  try {
                    parsedInput = JSON.parse(tool.inputJson)
                  } catch {
                    parsedInput = tool.inputJson
                  }
                }
                this.sendToRenderer('opencode:stream', {
                  type: 'message.part.updated',
                  sessionId: hiveSessionId,
                  childSessionId,
                  data: {
                    part: {
                      type: 'tool',
                      callID: tool.id,
                      tool: tool.name,
                      state: { status: 'running', input: parsedInput }
                    }
                  }
                })
                tools.delete(blockIdx)
              }
              if (tools.size === 0) {
                this.activeToolBlocks.delete(hiveSessionId)
              }
            }
            break
          }
          default: {
            // message_start, message_delta, message_stop — no action needed
            break
          }
        }
        break
      }

      // ── Complete assistant message (arrives AFTER all stream_events) ──
      // With includePartialMessages the renderer already accumulated text/tools
      // via stream_event deltas.  Emit as message.updated for metadata/usage only.
      case 'assistant': {
        const usage = innerMessage?.usage as Record<string, unknown> | undefined
        log.info('emitSdkMessage: assistant (complete)', {
          hiveSessionId,
          messageIndex,
          contentBlocks: Array.isArray(innerContent) ? innerContent.length : 0,
          hasUsage: !!usage
        })
        this.sendToRenderer('opencode:stream', {
          type: 'message.updated',
          sessionId: hiveSessionId,
          data: {
            role: 'assistant',
            messageIndex,
            // Pass usage/model info so the renderer can extract tokens
            info: {
              time: { completed: new Date().toISOString() },
              usage: usage
                ? {
                    input: usage.input_tokens,
                    output: usage.output_tokens,
                    cacheRead: usage.cache_read_input_tokens,
                    cacheCreation: usage.cache_creation_input_tokens
                  }
                : undefined,
              model: innerMessage?.model
            }
          }
        })

        // Also emit tool result status updates.  When the complete assistant
        // message arrives, user-type messages with tool_result content follow.
        // But the tool_use blocks inside the assistant message carry the final
        // input which the renderer needs for tool cards.
        if (Array.isArray(innerContent)) {
          for (const block of innerContent) {
            const b = block as Record<string, unknown>
            if (b.type === 'tool_use') {
              this.sendToRenderer('opencode:stream', {
                type: 'message.part.updated',
                sessionId: hiveSessionId,
                data: {
                  part: {
                    type: 'tool',
                    callID: b.id as string,
                    tool: b.name as string,
                    state: { status: 'running', input: b.input }
                  }
                }
              })
            }
          }
        }
        break
      }

      case 'result': {
        // Result content is in msg.result (array of content blocks or text)
        const resultContent = msg.result as unknown[] | unknown
        const resultArray = Array.isArray(resultContent) ? resultContent : undefined
        log.info('emitSdkMessage: result', {
          hiveSessionId,
          messageIndex,
          isError: msg.is_error,
          resultType: typeof resultContent,
          isArray: Array.isArray(resultContent),
          contentLength: resultArray?.length ?? 0
        })

        // Emit any final result text as a streaming text part so it renders
        // immediately (before finalizeResponse reloads the full transcript).
        if (typeof resultContent === 'string' && resultContent.length > 0) {
          this.sendToRenderer('opencode:stream', {
            type: 'message.part.updated',
            sessionId: hiveSessionId,
            data: {
              part: { type: 'text', text: resultContent },
              delta: resultContent
            }
          })
        }

        this.sendToRenderer('opencode:stream', {
          type: 'message.updated',
          sessionId: hiveSessionId,
          data: {
            role: 'assistant',
            content: resultArray ?? resultContent,
            isError: msg.is_error ?? false,
            messageIndex,
            // Include cost/usage from result for token tracking
            info: {
              time: { completed: new Date().toISOString() },
              cost: msg.total_cost_usd,
              usage: msg.usage
                ? {
                    input: (msg.usage as Record<string, unknown>).input_tokens,
                    output: (msg.usage as Record<string, unknown>).output_tokens
                  }
                : undefined
            }
          }
        })
        break
      }

      case 'user': {
        // User messages are echoes from the SDK; the renderer already has
        // the user message locally.  However we still emit them so the
        // renderer can track tool_result content for tool card completion.
        if (Array.isArray(innerContent)) {
          for (const block of innerContent) {
            const b = block as Record<string, unknown>
            if (b.type === 'tool_result') {
              const toolId = b.tool_use_id as string
              const isError = b.is_error as boolean | undefined
              log.info('TOOL_LIFECYCLE: tool_result received', {
                hiveSessionId,
                toolId,
                isError: !!isError
              })
              // Extract text content from tool result
              let output: string | undefined
              if (typeof b.content === 'string') {
                output = b.content
              } else if (Array.isArray(b.content)) {
                output = (b.content as Record<string, unknown>[])
                  .filter((c) => c.type === 'text')
                  .map((c) => c.text as string)
                  .join('\n')
              }
              log.info('TOOL_LIFECYCLE: emitting tool_result to renderer', {
                hiveSessionId,
                toolId,
                isError: !!isError,
                hasOutput: !!output,
                outputLength: output?.length ?? 0
              })
              this.sendToRenderer('opencode:stream', {
                type: 'message.part.updated',
                sessionId: hiveSessionId,
                data: {
                  part: {
                    type: 'tool',
                    callID: toolId,
                    tool: toolNames?.get(toolId) ?? '',
                    state: {
                      status: isError ? 'error' : 'completed',
                      output: output,
                      error: isError ? output : undefined
                    }
                  }
                }
              })
            }
          }
        }
        break
      }

      // ── System messages (compaction, status) ──
      case 'system': {
        const subtype = msg.subtype as string | undefined
        if (subtype === 'compact_boundary') {
          const meta = msg.compact_metadata as Record<string, unknown> | undefined
          this.sendToRenderer('opencode:stream', {
            type: 'message.part.updated',
            sessionId: hiveSessionId,
            data: {
              part: {
                type: 'compaction',
                auto: meta?.trigger === 'auto'
              }
            }
          })
        }
        break
      }

      // ── Tool progress heartbeats ──
      case 'tool_progress': {
        const toolId = msg.tool_use_id as string
        const toolName = msg.tool_name as string
        this.sendToRenderer('opencode:stream', {
          type: 'message.part.updated',
          sessionId: hiveSessionId,
          data: {
            part: {
              type: 'tool',
              callID: toolId,
              tool: toolName,
              state: { status: 'running' }
            }
          }
        })
        break
      }

      case 'tool_use': {
        log.info('emitSdkMessage: tool_use', { hiveSessionId, messageIndex })
        this.sendToRenderer('opencode:stream', {
          type: 'message.part.updated',
          sessionId: hiveSessionId,
          data: {
            part: {
              type: 'tool',
              callID: ((msg as Record<string, unknown>).id as string) || `tool-${Date.now()}`,
              tool: ((msg as Record<string, unknown>).name as string) || 'unknown',
              state: { status: 'running', input: (msg as Record<string, unknown>).input }
            }
          }
        })
        break
      }

      default: {
        log.warn('emitSdkMessage: unhandled type', {
          type: msgType,
          messageIndex,
          keys: Object.keys(msg).join(',')
        })
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

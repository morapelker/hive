import type { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'

import { createLogger } from './logger'
import { notificationService } from './notification-service'
import { loadClaudeSDK } from './claude-sdk-loader'
import type { AgentSdkCapabilities, AgentSdkImplementer } from './agent-sdk-types'
import { CLAUDE_CODE_CAPABILITIES } from './agent-sdk-types'
import type { DatabaseService } from '../db/database'
import { readClaudeTranscript, translateEntry } from './claude-transcript-reader'
import { generateSessionTitle } from './claude-session-title'
import { autoRenameWorktreeBranch } from './git-service'
import { getEventBus } from '../../server/event-bus'

const log = createLogger({ component: 'ClaudeCodeImplementer' })

const CLAUDE_MODELS = [
  {
    id: 'opus',
    name: 'Opus 4.6',
    limit: { context: 200000, output: 32000 }
  },
  {
    id: 'sonnet',
    name: 'Sonnet 4.6',
    limit: { context: 200000, output: 16000 }
  },
  {
    id: 'haiku',
    name: 'Haiku 4.5',
    limit: { context: 200000, output: 8192 }
  }
]

export interface ClaudeQuery {
  interrupt(): Promise<void>
  close(): void
  return?(value?: void): Promise<IteratorResult<unknown, void>>
  next(...args: unknown[]): Promise<IteratorResult<unknown, void>>
  [Symbol.asyncIterator](): AsyncGenerator<unknown, void>
  rewindFiles?: (
    userMessageId: string,
    options?: { dryRun?: boolean }
  ) => Promise<void | {
    canRewind: boolean
    error?: string
    filesChanged?: string[]
    insertions?: number
    deletions?: number
  }>
  supportedCommands?: () => Promise<
    Array<{ name: string; description: string; argumentHint: string }>
  >
}

interface RewindFilesResult {
  canRewind?: boolean
  error?: string
  filesChanged?: string[]
  insertions?: number
  deletions?: number
}

export interface PendingQuestionState {
  requestId: string
  questions: { question: string; header: string }[]
  resolve: (response: { answers: string[][]; rejected?: boolean }) => void
}

export interface PendingPlanApprovalState {
  requestId: string
  resolve: (response: { approved: boolean; feedback?: string }) => void
}

export interface ClaudeSessionState {
  claudeSessionId: string
  hiveSessionId: string
  worktreePath: string
  abortController: AbortController | null
  checkpointCounter: number
  checkpoints: Map<string, number>
  query: ClaudeQuery | null
  /** Last completed query reference for rewindFiles access */
  lastQuery: ClaudeQuery | null
  materialized: boolean
  messages: unknown[]
  /** Maps tool_use IDs to their tool names for lookup on tool_result completion */
  toolNames: Map<string, string>
  /** Pending AskUserQuestion awaiting user response */
  pendingQuestion: PendingQuestionState | null
  /** Pending ExitPlanMode awaiting user approval/rejection */
  pendingPlanApproval: PendingPlanApprovalState | null
  /** Current revert boundary message ID (hive-side), set by undo */
  revertMessageID: string | null
  /** SDK UUID of the reverted checkpoint, used for boundary lookups in subsequent undos */
  revertCheckpointUuid: string | null
  /** Diff string from last rewindFiles result */
  revertDiff: string | null
  /** Signals next prompt() should use forkSession: true to branch from the undo point */
  pendingFork: boolean
  /** SDK assistant UUID to pass as resumeSessionAt on the forked prompt.
   *  Ensures the fork's context excludes undone messages and throwaway entries. */
  pendingResumeSessionAt: string | null
}

export class ClaudeCodeImplementer implements AgentSdkImplementer {
  readonly id = 'claude-code' as const
  readonly capabilities: AgentSdkCapabilities = CLAUDE_CODE_CAPABILITIES

  private mainWindow: BrowserWindow | null = null
  private dbService: DatabaseService | null = null
  private claudeBinaryPath: string | null = null
  private sessions = new Map<string, ClaudeSessionState>()
  private selectedModel: string = 'sonnet'
  /** Tracks in-flight tool_use content blocks for input_json_delta accumulation.
   *  Keyed by hiveSessionId → Map<blockIndex, { id, name, inputJson }>. */
  private activeToolBlocks = new Map<
    string,
    Map<number, { id: string; name: string; inputJson: string }>
  >()
  /** Maps pending question requestIds to session keys for IPC routing */
  private pendingQuestionSessions = new Map<string, string>()
  /** Maps pending plan approval requestIds to session keys for IPC routing */
  private pendingPlanSessions = new Map<string, string>()
  /** Caches slash commands per worktree path, populated from SDK init messages */
  private cachedSlashCommands = new Map<
    string,
    Array<{ name: string; description: string; argumentHint: string }>
  >()

  // ── Window binding ───────────────────────────────────────────────

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  setDatabaseService(db: DatabaseService): void {
    this.dbService = db
  }

  setClaudeBinaryPath(path: string | null): void {
    this.claudeBinaryPath = path
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
      checkpointCounter: 0,
      checkpoints: new Map(),
      query: null,
      lastQuery: null,
      materialized: false,
      messages: [],
      toolNames: new Map(),
      pendingQuestion: null,
      pendingPlanApproval: null,
      revertMessageID: null,
      revertCheckpointUuid: null,
      revertDiff: null,
      pendingFork: false,
      pendingResumeSessionAt: null
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
      const sessionStatus = existing.query ? 'busy' : 'idle'
      log.info('Reconnect: session already registered, updated hiveSessionId', {
        worktreePath,
        agentSessionId,
        hiveSessionId,
        sessionStatus
      })
      return { success: true, sessionStatus, revertMessageID: existing.revertMessageID ?? null }
    }

    const state: ClaudeSessionState = {
      claudeSessionId: agentSessionId,
      hiveSessionId,
      worktreePath,
      abortController: new AbortController(),
      checkpointCounter: 0,
      checkpoints: new Map(),
      query: null,
      lastQuery: null,
      materialized: true,
      messages: [],
      toolNames: new Map(),
      pendingQuestion: null,
      pendingPlanApproval: null,
      revertMessageID: null,
      revertCheckpointUuid: null,
      revertDiff: null,
      pendingFork: false,
      pendingResumeSessionAt: null
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
    // Clear cached slash commands so a fresh session doesn't show stale entries
    this.cachedSlashCommands.delete(worktreePath)
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
    this.cachedSlashCommands.clear()
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

    // Clear revert boundary — a new prompt invalidates prior undo state
    session.revertMessageID = null
    session.revertCheckpointUuid = null
    session.revertDiff = null

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

      // Build prompt: use structured content blocks when file attachments are present,
      // otherwise use a plain string (preserving the existing fast path).
      const hasFiles = this.hasFileAttachments(message)

      let prompt: string
      let contentBlocks: Array<Record<string, unknown>> | null = null

      if (typeof message === 'string') {
        prompt = message
      } else if (!hasFiles) {
        // No file attachments — flatten to string (existing behavior)
        prompt = message
          .filter((part) => part.type === 'text')
          .map((part) => (part as { type: 'text'; text: string }).text)
          .join('\n')
      } else {
        // Has file attachments — build structured content blocks for the SDK
        contentBlocks = this.buildAnthropicContentBlocks(message)
        // Also build a text-only prompt string for logging and the synthetic user message
        prompt = message
          .map((part) =>
            part.type === 'text' ? part.text : `[attachment: ${part.filename ?? 'file'}]`
          )
          .join('\n')
      }

      log.info('Prompt: constructed', {
        promptLength: prompt.length,
        promptPreview: prompt.slice(0, 100)
      })

      // After undo, the fork creates a new session branch.  Clear the
      // in-memory messages so the new branch starts fresh — the SDK will
      // stream the forked conversation's messages which we'll capture.
      if (session.pendingFork) {
        session.messages = []
        log.debug('Cleared session messages for pending fork')
      } else if (session.messages.length === 0) {
        // Hydrate in-memory messages from the transcript so that
        // getMessages() returns the full history, not just this turn.
        const existing = await readClaudeTranscript(session.worktreePath, session.claudeSessionId)
        session.messages.push(...existing)
        log.debug('Hydrated session messages from transcript', {
          count: existing.length
        })
      }

      // Inject a synthetic user message into session.messages so that
      // getMessages() returns it alongside the assistant response.
      // The SDK does NOT emit a `user` type event — without this,
      // loadMessages() on idle would replace state with only the assistant
      // message, causing the user's message to vanish.
      const syntheticTimestamp = new Date().toISOString()
      const syntheticParts: Array<Record<string, unknown>> = []

      if (typeof message === 'string' || !hasFiles) {
        syntheticParts.push({ type: 'text', text: prompt, timestamp: syntheticTimestamp })
      } else {
        // Include both text and file parts so the renderer can display attachments
        for (const part of message) {
          if (part.type === 'text') {
            syntheticParts.push({ type: 'text', text: part.text, timestamp: syntheticTimestamp })
          } else {
            syntheticParts.push({
              type: 'file',
              mime: part.mime,
              url: part.url,
              filename: part.filename,
              timestamp: syntheticTimestamp
            })
          }
        }
      }

      session.messages.push({
        id: `user-${randomUUID()}`,
        role: 'user',
        timestamp: syntheticTimestamp,
        content: prompt,
        parts: syntheticParts
      })

      // Fresh AbortController for this prompt turn
      session.abortController = new AbortController()

      // Determine permission mode from DB session mode
      // 'plan' mode uses SDK-native plan mode (ExitPlanMode blocking tool)
      // 'build' mode uses 'default' so canUseTool handles AskUserQuestion
      let sdkPermissionMode: string = 'default'
      if (this.dbService) {
        try {
          const dbSession = this.dbService.getSession(session.hiveSessionId)
          if (dbSession?.mode === 'plan') {
            sdkPermissionMode = 'plan'
          }
        } catch {
          // Fall through to default mode
        }
      }

      // Build SDK query options
      const options: Record<string, unknown> = {
        cwd: session.worktreePath,
        permissionMode: sdkPermissionMode,
        abortController: session.abortController,
        maxThinkingTokens: 31999,
        model: modelOverride?.modelID ?? this.selectedModel,
        includePartialMessages: true,
        enableFileCheckpointing: true,
        settingSources: ['user', 'project', 'local'],
        extraArgs: { 'replay-user-messages': null },
        env: {
          ...process.env,
          CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '1'
        },
        canUseTool: this.createCanUseToolCallback(session),
        ...(this.claudeBinaryPath ? { pathToClaudeCodeExecutable: this.claudeBinaryPath } : {})
      }

      // If session is materialized (has real SDK ID), add resume
      if (session.materialized) {
        options.resume = session.claudeSessionId
      }

      // After an undo, fork the conversation so the SDK creates a new branch.
      // forkSession: true tells the SDK to branch from the resume point,
      // returning a new session ID.
      // resumeSessionAt tells the SDK to load history only up to a specific
      // assistant message — this ensures the fork's context excludes both
      // the undone messages and any throwaway entries from rewindWithResumedQuery().
      if (session.pendingFork && session.materialized) {
        options.forkSession = true
        if (session.pendingResumeSessionAt) {
          options.resumeSessionAt = session.pendingResumeSessionAt
          session.pendingResumeSessionAt = null
        }
      }

      log.info('Prompt: calling sdk.query()', {
        model: options.model,
        resume: !!options.resume,
        forkSession: !!options.forkSession,
        resumeSessionAt: options.resumeSessionAt ?? null,
        cwd: options.cwd,
        hasFileAttachments: !!contentBlocks
      })

      // When file attachments are present, use AsyncIterable<SDKUserMessage> prompt path
      // with proper Anthropic content blocks (base64 images/documents);
      // otherwise use the plain string path (preserves all existing behavior).
      const sdkPrompt = contentBlocks
        ? this.createUserMessageIterable(contentBlocks, session.claudeSessionId)
        : prompt

      const queryData = sdk.query({ prompt: sdkPrompt, options }) as AsyncIterable<
        Record<string, unknown>
      >
      session.pendingFork = false
      session.query = queryData as unknown as ClaudeQuery

      // Capture whether this prompt was an explicit fork request (undo+resend).
      // Used to send an authoritative wasFork flag in session.materialized so the
      // renderer doesn't have to guess based on the old session ID format.
      const wasForkRequest = !!options.forkSession

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

        // Log init messages (includes MCP server connection status) and cache slash commands
        if (msgType === 'init') {
          const initMsg = sdkMessage as Record<string, unknown>
          log.info('Prompt: init message received', {
            mcpServers: initMsg.mcp_servers,
            model: initMsg.model,
            slashCommands: initMsg.slash_commands
          })

          // Phase 1: Cache command names from init message as minimal entries
          const initSlashCommandNames = initMsg.slash_commands as string[] | undefined
          if (initSlashCommandNames && Array.isArray(initSlashCommandNames)) {
            const minimal = initSlashCommandNames
              .filter((name): name is string => typeof name === 'string')
              .map((name) => ({
                name,
                description: '',
                argumentHint: ''
              }))
            this.cachedSlashCommands.set(worktreePath, minimal)
            log.info('Prompt: cached slash command names from init', {
              count: minimal.length
            })
          }

          // Phase 2: Enrich with full metadata via supportedCommands() (fire-and-forget)
          if (session.query?.supportedCommands) {
            session.query
              .supportedCommands()
              .then((cmds) => {
                if (cmds?.length) {
                  this.cachedSlashCommands.set(worktreePath, cmds)
                  log.info('Prompt: cached full slash commands from supportedCommands()', {
                    count: cmds.length
                  })
                }
              })
              .catch((err) => {
                log.warn('Prompt: supportedCommands() failed, using init names', {
                  error: err instanceof Error ? err.message : String(err)
                })
              })
          }

          // Notify renderer that commands are now available for fetching
          this.sendToRenderer('opencode:stream', {
            type: 'session.commands_available',
            sessionId: session.hiveSessionId,
            data: {}
          })

          // Send Claude model limits so the renderer can populate contextStore
          this.sendToRenderer('opencode:stream', {
            type: 'session.model_limits',
            sessionId: session.hiveSessionId,
            data: {
              models: CLAUDE_MODELS.map((m) => ({
                modelID: m.id,
                providerID: 'anthropic',
                contextLimit: m.limit.context
              }))
            }
          })

          continue
        }

        // Materialize pending:: to real SDK session ID from first message,
        // or capture a new session ID after a fork (forkSession: true returns a new ID)
        const sdkSessionId = sdkMessage.session_id as string | undefined
        if (
          sdkSessionId &&
          (session.claudeSessionId.startsWith('pending::') ||
            sdkSessionId !== session.claudeSessionId)
        ) {
          const wasPending = session.claudeSessionId.startsWith('pending::')
          const oldKey = this.getSessionKey(worktreePath, session.claudeSessionId)
          session.claudeSessionId = sdkSessionId
          session.materialized = true
          this.sessions.delete(oldKey)
          const newKey = this.getSessionKey(worktreePath, sdkSessionId)
          this.sessions.set(newKey, session)
          log.info(wasPending ? 'Materialized session ID' : 'Forked session ID', {
            oldKey,
            newKey
          })

          // When forking (not initial materialization), reset checkpoints
          // since the new fork starts with its own checkpoint space
          if (!wasPending) {
            session.checkpoints = new Map()
            session.checkpointCounter = 0
            log.info('Reset checkpoints for forked session', {
              hiveSessionId: session.hiveSessionId,
              newSessionId: sdkSessionId
            })
          }

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
              const error = err instanceof Error ? err : new Error(String(err))
              log.error('Failed to update opencode_session_id in DB', error, {
                hiveSessionId: session.hiveSessionId
              })
            }
          }

          // Notify renderer so it updates its opencodeSessionId state
          // (otherwise loadMessages() after idle will use the stale pending:: ID).
          // Include wasFork so the renderer knows whether to clear old messages.
          // wasFork is true ONLY for explicit fork requests (undo+resend), not
          // for normal SDK session ID changes during resume.
          this.sendToRenderer('opencode:stream', {
            type: 'session.materialized',
            sessionId: session.hiveSessionId,
            data: { newSessionId: sdkSessionId, wasFork: !wasPending && wasForkRequest }
          })

          // Fire-and-forget: generate a title for brand-new sessions only.
          // wasPending is only true on initial materialization, not forks.
          if (wasPending) {
            this.handleTitleGeneration(session, prompt).catch(() => {
              // Swallowed — handleTitleGeneration already logs internally
            })
          }
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

          // Capture checkpoints only from actual user prompts on the
          // main conversation thread (not subagent messages).
          // tool_result-only user messages carry UUIDs but do not represent
          // stable rewind points for file checkpointing.
          // Subagent messages have parent_tool_use_id set — their UUIDs live
          // in a separate JSONL file and are not valid fork/resume points.
          const isSubagentMessage = !!(sdkMessage as Record<string, unknown>).parent_tool_use_id
          if (msgType === 'user' && sdkMessage.uuid && !isToolResultOnly && !isSubagentMessage) {
            const checkpointUuid = sdkMessage.uuid as string
            const isFirstSeenCheckpoint = !session.checkpoints.has(checkpointUuid)
            if (isFirstSeenCheckpoint) {
              session.checkpointCounter += 1
              session.checkpoints.set(checkpointUuid, session.checkpointCounter)
              log.info('Checkpoint captured', {
                uuid: checkpointUuid,
                counter: session.checkpointCounter,
                totalCheckpoints: session.checkpoints.size
              })
            }
          } else if (msgType === 'user' && sdkMessage.uuid && isSubagentMessage) {
            log.debug('Skipping subagent user message for checkpoint', {
              uuid: (sdkMessage.uuid as string).slice(0, 12),
              parentToolUseId: (sdkMessage as Record<string, unknown>).parent_tool_use_id
            })
          }

          log.info('TOOL_LIFECYCLE: accumulate message', {
            hiveSessionId: session.hiveSessionId,
            msgType,
            contentBlockTypes,
            isToolResultOnly,
            isSubagentMessage
          })

          // Skip subagent messages from accumulation — they belong to the child
          // session's transcript and should not appear in the main conversation.
          // The renderer routes subagent content into SubtaskCards via childSessionId
          // on stream events; the in-memory cache must not include them either.
          if (isSubagentMessage) {
            log.debug('Skipping subagent message from session.messages accumulation', {
              msgType,
              parentToolUseId: (sdkMessage as Record<string, unknown>).parent_tool_use_id
            })
          } else if (isToolResultOnly) {
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
              const isUserMessage = msgType === 'user'
              const translatedContent = (translated as Record<string, unknown>).content
              let optimisticIndex = -1

              if (isUserMessage && typeof translatedContent === 'string') {
                for (let i = session.messages.length - 1; i >= 0; i--) {
                  const candidate = session.messages[i] as Record<string, unknown>
                  if (
                    candidate.role === 'user' &&
                    typeof candidate.id === 'string' &&
                    candidate.id.startsWith('user-') &&
                    typeof candidate.content === 'string' &&
                    candidate.content === translatedContent
                  ) {
                    optimisticIndex = i
                    break
                  }
                }
              }

              if (optimisticIndex >= 0) {
                session.messages[optimisticIndex] = translated
              } else {
                session.messages.push(translated)
              }
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
      log.error(
        'Prompt streaming error',
        error instanceof Error ? error : new Error(errorMessage),
        {
          worktreePath,
          agentSessionId,
          error: errorMessage
        }
      )

      this.sendToRenderer('opencode:stream', {
        type: 'session.error',
        sessionId: session.hiveSessionId,
        data: { error: errorMessage }
      })
      this.emitStatus(session.hiveSessionId, 'idle')
    } finally {
      session.lastQuery = session.query
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
    const transcript = await readClaudeTranscript(worktreePath, agentSessionId)
    // Warm the in-memory cache so future calls (and prompt() hydration)
    // don't re-read from disk and always have the latest state.
    if (session && transcript.length > 0) {
      session.messages = [...transcript]
      log.info('getMessages: warmed in-memory cache from transcript', {
        agentSessionId,
        count: transcript.length
      })
    }
    return transcript
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
    worktreePath: string,
    agentSessionId: string
  ): Promise<{
    revertMessageID: string | null
    revertDiff: string | null
  }> {
    const session = this.getSession(worktreePath, agentSessionId)
    return {
      revertMessageID: session?.revertMessageID ?? null,
      revertDiff: session?.revertDiff ?? null
    }
  }

  // ── Human-in-the-loop ────────────────────────────────────────────

  async questionReply(
    requestId: string,
    answers: string[][],
    _worktreePath?: string
  ): Promise<void> {
    const sessionKey = this.pendingQuestionSessions.get(requestId)
    if (!sessionKey) {
      throw new Error(`No pending question found for requestId: ${requestId}`)
    }

    const session = this.sessions.get(sessionKey)
    if (!session?.pendingQuestion || session.pendingQuestion.requestId !== requestId) {
      throw new Error(`Session pending question mismatch for requestId: ${requestId}`)
    }

    log.info('questionReply: resolving pending question', {
      requestId,
      hiveSessionId: session.hiveSessionId,
      answerCount: answers.length
    })

    // Resolve the blocked canUseTool Promise with the user's answers
    session.pendingQuestion.resolve({ answers })

    // Emit question.replied so the renderer removes the QuestionPrompt
    this.sendToRenderer('opencode:stream', {
      type: 'question.replied',
      sessionId: session.hiveSessionId,
      data: { requestId, id: requestId }
    })
  }

  async questionReject(requestId: string, _worktreePath?: string): Promise<void> {
    const sessionKey = this.pendingQuestionSessions.get(requestId)
    if (!sessionKey) {
      throw new Error(`No pending question found for requestId: ${requestId}`)
    }

    const session = this.sessions.get(sessionKey)
    if (!session?.pendingQuestion || session.pendingQuestion.requestId !== requestId) {
      throw new Error(`Session pending question mismatch for requestId: ${requestId}`)
    }

    log.info('questionReject: rejecting pending question', {
      requestId,
      hiveSessionId: session.hiveSessionId
    })

    // Resolve the blocked canUseTool Promise with rejection
    session.pendingQuestion.resolve({ answers: [], rejected: true })

    // Emit question.rejected so the renderer removes the QuestionPrompt
    this.sendToRenderer('opencode:stream', {
      type: 'question.rejected',
      sessionId: session.hiveSessionId,
      data: { requestId, id: requestId }
    })
  }

  async permissionReply(
    requestId: string,
    _decision: 'once' | 'always' | 'reject',
    _worktreePath?: string
  ): Promise<void> {
    // Claude Code handles permissions inline via the canUseTool callback
    // during prompt() streaming. There are no separate pending permission
    // requests to reply to — canUseTool auto-allows all non-question tools.
    log.warn('permissionReply: no-op for Claude Code (permissions handled via canUseTool)', {
      requestId
    })
  }

  async permissionList(_worktreePath?: string): Promise<unknown[]> {
    // Claude Code handles permissions inline via canUseTool during prompt()
    // streaming. There is no separate permission queue to list.
    return []
  }

  /** Check if a question requestId belongs to this implementer */
  hasPendingQuestion(requestId: string): boolean {
    return this.pendingQuestionSessions.has(requestId)
  }

  // ── Plan approval ───────────────────────────────────────────────

  /** Check if a plan requestId belongs to this implementer */
  hasPendingPlan(requestId: string): boolean {
    return this.pendingPlanSessions.has(requestId)
  }

  /** Check if a session (by hiveSessionId) has a pending plan */
  hasPendingPlanForSession(hiveSessionId: string): boolean {
    for (const session of this.sessions.values()) {
      if (session.hiveSessionId === hiveSessionId && session.pendingPlanApproval) {
        return true
      }
    }
    return false
  }

  /** Find a session state by hiveSessionId */
  findSessionByHiveId(hiveSessionId: string): ClaudeSessionState | undefined {
    for (const session of this.sessions.values()) {
      if (session.hiveSessionId === hiveSessionId) {
        return session
      }
    }
    return undefined
  }

  /** Find a session state by pending plan requestId */
  private findSessionByPendingPlanRequestId(requestId: string): ClaudeSessionState | undefined {
    const sessionKey = this.pendingPlanSessions.get(requestId)
    if (!sessionKey) return undefined
    return this.sessions.get(sessionKey)
  }

  /** Approve a pending plan — unblocks the SDK to continue implementation */
  async planApprove(
    _worktreePath: string,
    hiveSessionId: string,
    requestId?: string
  ): Promise<void> {
    // Prefer requestId routing (stable and specific) when available.
    // Fall back to hiveSessionId scan for compatibility.
    let session: ClaudeSessionState | undefined = requestId
      ? this.findSessionByPendingPlanRequestId(requestId)
      : undefined

    if (!session) {
      for (const s of this.sessions.values()) {
        if (s.hiveSessionId === hiveSessionId && s.pendingPlanApproval) {
          session = s
          break
        }
      }
    }

    if (!session || !session.pendingPlanApproval) {
      throw new Error(`planApprove: no pending plan for session: ${hiveSessionId}`)
    }

    log.info('planApprove: approving plan', {
      hiveSessionId,
      requestId: session.pendingPlanApproval.requestId
    })

    const resolvedRequestId = session.pendingPlanApproval.requestId

    // Resolve the blocked canUseTool Promise with approval
    session.pendingPlanApproval.resolve({ approved: true })
    session.pendingPlanApproval = null
    this.pendingPlanSessions.delete(resolvedRequestId)

    // Emit plan.resolved so the renderer clears the plan UI
    this.sendToRenderer('opencode:stream', {
      type: 'plan.resolved',
      sessionId: hiveSessionId,
      data: { approved: true }
    })
  }

  /** Reject a pending plan with user feedback — Claude will revise */
  async planReject(
    _worktreePath: string,
    hiveSessionId: string,
    feedback?: string,
    requestId?: string
  ): Promise<void> {
    // Prefer requestId routing (stable and specific) when available.
    let session: ClaudeSessionState | undefined = requestId
      ? this.findSessionByPendingPlanRequestId(requestId)
      : undefined

    if (!session) {
      for (const s of this.sessions.values()) {
        if (s.hiveSessionId === hiveSessionId && s.pendingPlanApproval) {
          session = s
          break
        }
      }
    }

    if (!session || !session.pendingPlanApproval) {
      throw new Error(`planReject: no pending plan for session: ${hiveSessionId}`)
    }

    log.info('planReject: rejecting plan with feedback', {
      hiveSessionId,
      requestId: session.pendingPlanApproval.requestId,
      hasFeedback: !!feedback
    })

    const resolvedRequestId = session.pendingPlanApproval.requestId

    // Resolve the blocked canUseTool Promise with rejection + feedback
    session.pendingPlanApproval.resolve({ approved: false, feedback })
    session.pendingPlanApproval = null
    this.pendingPlanSessions.delete(resolvedRequestId)

    // Emit plan.resolved so the renderer clears the plan UI
    this.sendToRenderer('opencode:stream', {
      type: 'plan.resolved',
      sessionId: hiveSessionId,
      data: { approved: false, feedback }
    })
  }

  // ── Undo/Redo ────────────────────────────────────────────────────

  async undo(
    worktreePath: string,
    agentSessionId: string,
    _hiveSessionId: string
  ): Promise<{ revertMessageID: string; restoredPrompt: string; revertDiff: string | null }> {
    const session = this.getSession(worktreePath, agentSessionId)
    if (!session) {
      throw new Error(`Undo failed: session not found for ${worktreePath} / ${agentSessionId}`)
    }

    if (session.checkpoints.size === 0) {
      throw new Error('Nothing to undo')
    }

    // Find the current revert boundary's checkpoint index (if any).
    // Use revertCheckpointUuid (SDK UUID) directly against checkpoints map
    // to avoid roundabout hive-side ID lookups that can fail when IDs diverge.
    const currentBoundaryCheckpointIdx = session.revertCheckpointUuid
      ? (session.checkpoints.get(session.revertCheckpointUuid) ?? null)
      : null

    // Walk checkpoints in reverse order (by checkpoint counter, descending)
    // to find the last user message UUID BEFORE the current revert boundary.
    // After finding the undo target, also locate the checkpoint immediately
    // before it — used as context for the fork boundary on the next prompt().
    const sortedCheckpoints = [...session.checkpoints.entries()].sort(
      ([, idxA], [, idxB]) => idxB - idxA
    )

    let targetUuid: string | null = null
    let targetCheckpointIdx: number | null = null
    let targetMessage: Record<string, unknown> | undefined
    let previousCheckpointUuid: string | null = null
    let foundTarget = false
    for (const [uuid, msgIndex] of sortedCheckpoints) {
      // Skip checkpoints at or after the current boundary
      if (currentBoundaryCheckpointIdx !== null && msgIndex >= currentBoundaryCheckpointIdx) {
        continue
      }

      // Ignore UUIDs that don't map to a real rendered user message.
      // This filters out tool_result-only user messages that can carry UUIDs
      // but are not reliable file rewind checkpoints.
      const candidateMessage = this.findMessageByUuid(session, uuid)
      if (!candidateMessage || candidateMessage.role !== 'user') {
        continue
      }

      if (!foundTarget) {
        targetUuid = uuid
        targetCheckpointIdx = msgIndex
        targetMessage = candidateMessage
        foundTarget = true
      } else {
        // This is the checkpoint BEFORE the target — the one we keep.
        previousCheckpointUuid = uuid
        break
      }
    }

    if (!targetUuid || targetCheckpointIdx === null || !targetMessage) {
      throw new Error('Nothing to undo')
    }

    let rawRewindResult: void | RewindFilesResult | undefined
    let usedConversationOnlyFallback = false

    try {
      // During an active stream, rewind on the live query transport.
      if (session.query) {
        if (!session.query.rewindFiles) {
          throw new Error('Cannot undo: SDK query does not support rewindFiles')
        }
        rawRewindResult = await session.query.rewindFiles(targetUuid)
      } else {
        // After stream completion, the previous transport is closed.
        // Resume with an empty prompt and rewind on the new query.
        rawRewindResult = await this.rewindWithResumedQuery(session, targetUuid)
      }
    } catch (error) {
      if (!this.isNoFileCheckpointFoundError(error)) {
        throw error
      }

      // Fallback path: conversation-only rewind boundary.
      // We cannot restore files for this UUID, but we can still continue the
      // session from this checkpoint on the next prompt.
      usedConversationOnlyFallback = true
      log.info('Undo: falling back to conversation-only checkpoint boundary', {
        worktreePath,
        agentSessionId,
        targetUuid,
        previousCheckpointUuid
      })
    }

    const rewindResult = usedConversationOnlyFallback
      ? null
      : this.normalizeRewindResult(rawRewindResult)
    if (rewindResult?.canRewind === false) {
      throw new Error(rewindResult.error ?? 'Cannot rewind to this point')
    }

    // Build a diff summary string
    const diffParts: string[] = []
    if (rewindResult?.filesChanged && rewindResult.filesChanged.length > 0) {
      diffParts.push(`${rewindResult.filesChanged.length} file(s) changed`)
    }
    if (rewindResult?.insertions) {
      diffParts.push(`+${rewindResult.insertions}`)
    }
    if (rewindResult?.deletions) {
      diffParts.push(`-${rewindResult.deletions}`)
    }
    const revertDiff = diffParts.length > 0 ? diffParts.join(', ') : null

    const restoredPrompt = this.extractPromptFromMessage(targetMessage)

    // Use the hive-side message ID, or fall back to the SDK UUID
    const revertMessageID = (targetMessage?.id as string) ?? targetUuid

    // Update session revert state
    session.revertMessageID = revertMessageID
    session.revertCheckpointUuid = targetUuid
    session.revertDiff = revertDiff

    // Don't splice in-memory messages or delete checkpoints during undo.
    // The SDK's JSONL is append-only with parentUuid branching; the fork
    // on next prompt() creates a new branch and the messages array will be
    // cleared at that point.  Leaving messages intact lets getMessages()
    // continue to work (the renderer's visibleMessages filter handles
    // hiding the reverted tail via revertMessageID).

    // Signal the next prompt() to use forkSession: true + resumeSessionAt.
    //
    // forkSession tells the SDK to create a new conversation branch.
    // resumeSessionAt tells the SDK to load history only up to a specific
    // assistant message, so the fork's context excludes both the undone
    // messages AND the throwaway entries from rewindWithResumedQuery().
    //
    // We need the assistant message UUID immediately preceding the target
    // user message — that's the last "good" assistant response.
    //
    // When undoing the very first prompt (no previous checkpoint exists),
    // we de-materialize the session so the next prompt() starts a completely
    // fresh SDK conversation instead of resuming the old one.  No fork is
    // needed in that case since there's nothing to fork from.
    if (previousCheckpointUuid) {
      session.pendingFork = true

      // Find the assistant UUID preceding the undo target in session.messages.
      // Walk backward from the target to find the nearest assistant message.
      const targetMsgIndex = session.messages.findIndex(
        (m) => (m as Record<string, unknown>).id === targetUuid
      )
      let precedingAssistantUuid: string | null = null
      if (targetMsgIndex > 0) {
        for (let i = targetMsgIndex - 1; i >= 0; i--) {
          const msg = session.messages[i] as Record<string, unknown>
          if (
            msg.role === 'assistant' &&
            typeof msg.id === 'string' &&
            !msg.id.startsWith('user-')
          ) {
            precedingAssistantUuid = msg.id
            break
          }
        }
      }
      session.pendingResumeSessionAt = precedingAssistantUuid
      log.info('Undo: set pendingResumeSessionAt', {
        precedingAssistantUuid,
        targetUuid,
        targetMsgIndex
      })
    } else {
      // Undoing the very first prompt — nothing before it to resume to.
      // Clear materialisation so the next prompt() starts a fresh session.
      session.pendingFork = false
      session.pendingResumeSessionAt = null
      session.materialized = false
      log.info('Undo: de-materialized session (undoing first prompt)', {
        oldClaudeSessionId: session.claudeSessionId
      })
    }

    log.info('Undo: rewindFiles succeeded', {
      worktreePath,
      agentSessionId,
      targetUuid,
      targetCheckpointIdx,
      revertMessageID,
      pendingFork: session.pendingFork,
      previousCheckpointUuid,
      messagesRemaining: session.messages.length,
      checkpointsRemaining: session.checkpoints.size,
      filesChanged: rewindResult?.filesChanged?.length ?? 0
    })

    return { revertMessageID, restoredPrompt, revertDiff }
  }

  async redo(
    _worktreePath: string,
    _agentSessionId: string,
    _hiveSessionId: string
  ): Promise<unknown> {
    throw new Error('Redo is not supported for Claude Code sessions')
  }

  // ── Commands ─────────────────────────────────────────────────────

  async listCommands(worktreePath: string): Promise<unknown[]> {
    const cached = this.cachedSlashCommands.get(worktreePath)
    if (!cached?.length) {
      log.info('listCommands: no cached commands', { worktreePath })
      return []
    }

    // Map SDK SlashCommand format to Hive's expected command format
    return cached.map((cmd) => ({
      name: cmd.name,
      description: cmd.description || undefined,
      template: `/${cmd.name}${cmd.argumentHint ? ' ' + cmd.argumentHint : ''}`
    }))
  }

  async sendCommand(
    worktreePath: string,
    agentSessionId: string,
    command: string,
    args?: string
  ): Promise<void> {
    // Translate slash command into a prompt message. The Claude CLI
    // subprocess parses slash command prefixes from prompt text.
    const prompt = args ? `/${command} ${args}` : `/${command}`
    log.info('sendCommand: dispatching as prompt', {
      worktreePath,
      agentSessionId,
      command,
      hasArgs: !!args
    })
    await this.prompt(worktreePath, agentSessionId, prompt)
  }

  // ── Session management ───────────────────────────────────────────

  async renameSession(_worktreePath: string, agentSessionId: string, name: string): Promise<void> {
    // The Claude SDK has no session rename API. Session titles are stored
    // in Hive's local DB only. Find the session and update via dbService.
    if (!this.dbService) {
      log.warn('renameSession: no dbService available', { agentSessionId })
      return
    }

    // Find the hive session ID from our session map
    let hiveSessionId: string | null = null
    for (const session of this.sessions.values()) {
      if (session.claudeSessionId === agentSessionId) {
        hiveSessionId = session.hiveSessionId
        break
      }
    }

    if (!hiveSessionId) {
      log.warn('renameSession: session not found in active map', { agentSessionId })
      return
    }

    try {
      this.dbService.updateSession(hiveSessionId, { name })
      log.info('renameSession: updated title in DB', { hiveSessionId, name })
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      log.error('renameSession: failed to update title', error, { hiveSessionId })
    }
  }

  // ── Title generation ────────────────────────────────────────────

  /**
   * Asynchronously generate a session title via Agent SDK with Haiku.
   * On success: updates DB, notifies renderer, and auto-renames branch if applicable.
   * Fire-and-forget — errors are logged and swallowed.
   */
  private async handleTitleGeneration(
    session: ClaudeSessionState,
    userMessage: string
  ): Promise<void> {
    try {
      const title = await generateSessionTitle(userMessage, this.claudeBinaryPath)
      if (!title) return

      // 1. Update session name in DB
      if (this.dbService) {
        this.dbService.updateSession(session.hiveSessionId, { name: title })
        log.info('handleTitleGeneration: updated DB', {
          hiveSessionId: session.hiveSessionId,
          title
        })
      }

      // 2. Notify renderer with session.updated event (same format as OpenCode)
      // The renderer's SessionView.tsx and useOpenCodeGlobalListener.ts both
      // read: event.data?.info?.title || event.data?.title
      this.sendToRenderer('opencode:stream', {
        type: 'session.updated',
        sessionId: session.hiveSessionId,
        data: {
          title,
          info: { title }
        }
      })

      // 3. Auto-rename branch for the session's direct worktree
      if (!this.dbService) return
      const worktree = this.dbService.getWorktreeBySessionId(session.hiveSessionId)
      if (worktree && !worktree.branch_renamed) {
        try {
          const result = await autoRenameWorktreeBranch({
            worktreeId: worktree.id,
            worktreePath: worktree.path,
            currentBranchName: worktree.branch_name,
            sessionTitle: title,
            db: this.dbService
          })
          if (result.renamed) {
            this.sendToRenderer('worktree:branchRenamed', {
              worktreeId: worktree.id,
              newBranch: result.newBranch
            })
            log.info('handleTitleGeneration: auto-renamed branch', {
              oldBranch: worktree.branch_name,
              newBranch: result.newBranch
            })
          } else if (result.error) {
            log.warn('handleTitleGeneration: rename failed', { error: result.error })
          }
        } catch (err) {
          if (this.dbService) {
            this.dbService.updateWorktree(worktree.id, { branch_renamed: 1 })
          }
          log.warn('handleTitleGeneration: branch rename error', { err })
        }
      }

      // 4. Auto-rename branches for all connection member worktrees
      if (this.dbService) {
        const dbSession = this.dbService.getSession(session.hiveSessionId)
        if (dbSession?.connection_id) {
          const connection = this.dbService.getConnection(dbSession.connection_id)
          if (connection) {
            for (const member of connection.members) {
              if (worktree && member.worktree_id === worktree.id) continue
              try {
                const memberWorktree = this.dbService.getWorktree(member.worktree_id)
                if (!memberWorktree || memberWorktree.branch_renamed) continue

                const result = await autoRenameWorktreeBranch({
                  worktreeId: memberWorktree.id,
                  worktreePath: memberWorktree.path,
                  currentBranchName: memberWorktree.branch_name,
                  sessionTitle: title,
                  db: this.dbService
                })
                if (result.renamed) {
                  this.sendToRenderer('worktree:branchRenamed', {
                    worktreeId: memberWorktree.id,
                    newBranch: result.newBranch
                  })
                  log.info('handleTitleGeneration: auto-renamed connection member', {
                    connectionId: dbSession.connection_id,
                    worktreeId: memberWorktree.id,
                    oldBranch: memberWorktree.branch_name,
                    newBranch: result.newBranch
                  })
                } else if (result.error) {
                  log.warn('handleTitleGeneration: connection member rename failed', {
                    connectionId: dbSession.connection_id,
                    worktreeId: memberWorktree.id,
                    error: result.error
                  })
                }
              } catch (err) {
                log.warn('handleTitleGeneration: connection member rename error', {
                  worktreeId: member.worktree_id,
                  err
                })
              }
            }
          }
        }
      }
    } catch (err) {
      log.warn('handleTitleGeneration: unexpected error', {
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  // ── Internal helpers ─────────────────────────────────────────────

  /**
   * Handles ExitPlanMode tool invocation from the SDK.
   * Blocks execution with a Promise that waits for user approval/rejection
   * via the plan approval IPC handlers. If approved, allows the tool to proceed
   * (SDK exits plan mode and continues with implementation). If rejected,
   * denies the tool with feedback so Claude revises the plan.
   */
  private async handleExitPlanMode(
    session: ClaudeSessionState,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; toolUseID: string; [key: string]: unknown }
  ): Promise<
    | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
    | { behavior: 'deny'; message: string }
  > {
    const requestId = `plan-${Date.now()}-${randomUUID().slice(0, 8)}`
    const toolUseID = options.toolUseID

    log.info('canUseTool: ExitPlanMode intercepted', {
      hiveSessionId: session.hiveSessionId,
      requestId,
      toolUseID,
      inputKeys: Object.keys(input).join(',')
    })

    // Track this pending plan for IPC routing
    const sessionKey = this.getSessionKey(session.worktreePath, session.claudeSessionId)
    this.pendingPlanSessions.set(requestId, sessionKey)

    // Block execution with a Promise that waits for user response
    const userResponse = await new Promise<{ approved: boolean; feedback?: string }>((resolve) => {
      session.pendingPlanApproval = { requestId, resolve }

      // Emit plan.ready event to renderer — include plan content from tool input
      // The renderer reads data.id, data.plan, data.toolUseID
      const planContent =
        typeof input.plan === 'string'
          ? input.plan
          : input.plan !== undefined
            ? JSON.stringify(input.plan, null, 2)
            : ''

      this.sendToRenderer('opencode:stream', {
        type: 'plan.ready',
        sessionId: session.hiveSessionId,
        data: {
          id: requestId,
          plan: planContent,
          toolUseID
        }
      })

      log.info('canUseTool: emitted plan.ready, waiting for approval', {
        requestId,
        hiveSessionId: session.hiveSessionId
      })

      // If the session is aborted while waiting, auto-reject and notify renderer
      const onAbort = (): void => {
        if (session.pendingPlanApproval?.requestId === requestId) {
          log.info('canUseTool: session aborted while plan pending, auto-rejecting', { requestId })
          session.pendingPlanApproval = null
          this.pendingPlanSessions.delete(requestId)
          // Notify renderer to clear stale pending plan UI
          this.sendToRenderer('opencode:stream', {
            type: 'plan.resolved',
            sessionId: session.hiveSessionId,
            data: { approved: false, aborted: true }
          })
          resolve({ approved: false })
        }
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
    })

    // Clean up tracking state
    session.pendingPlanApproval = null
    this.pendingPlanSessions.delete(requestId)

    if (userResponse.approved) {
      log.info('canUseTool: ExitPlanMode approved by user', { requestId })
      return { behavior: 'allow' as const, updatedInput: input }
    }

    log.info('canUseTool: ExitPlanMode rejected by user', {
      requestId,
      hasFeedback: !!userResponse.feedback
    })
    return {
      behavior: 'deny' as const,
      message: userResponse.feedback || 'The user rejected the plan. Please revise.'
    }
  }

  /**
   * Creates a canUseTool callback for the Claude Agent SDK.
   * Intercepts AskUserQuestion and ExitPlanMode to block execution and wait
   * for user input, translating between the SDK format and Hive's event format.
   */
  private createCanUseToolCallback(
    session: ClaudeSessionState
  ): (
    toolName: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; toolUseID: string; [key: string]: unknown }
  ) => Promise<
    | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
    | { behavior: 'deny'; message: string }
  > {
    return async (toolName, input, options) => {
      // Handle ExitPlanMode — blocks until user approves or rejects the plan
      if (toolName === 'ExitPlanMode') {
        return this.handleExitPlanMode(session, input, options)
      }

      if (toolName !== 'AskUserQuestion') {
        // Auto-allow all non-question tools (normal permissions handled by permissionMode)
        return { behavior: 'allow' as const, updatedInput: input }
      }

      const requestId = `askuser-${Date.now()}-${randomUUID().slice(0, 8)}`
      const toolUseID = options.toolUseID

      log.info('canUseTool: AskUserQuestion intercepted', {
        hiveSessionId: session.hiveSessionId,
        requestId,
        toolUseID,
        questionCount: (input.questions as unknown[])?.length ?? 0
      })

      // Translate SDK AskUserQuestionInput to Hive QuestionRequest format
      const sdkQuestions = input.questions as Array<{
        question: string
        header: string
        options: Array<{ label: string; description: string }>
        multiSelect?: boolean
      }>

      const questionRequest = {
        id: requestId,
        sessionID: session.hiveSessionId,
        questions: sdkQuestions.map((q) => ({
          question: q.question,
          header: q.header,
          options: q.options,
          multiple: q.multiSelect ?? false,
          custom: true // SDK says "Other" option is auto-provided by client
        })),
        tool: { messageID: `msg-${Date.now()}`, callID: toolUseID }
      }

      // Track this pending question for IPC routing
      const sessionKey = this.getSessionKey(session.worktreePath, session.claudeSessionId)
      this.pendingQuestionSessions.set(requestId, sessionKey)

      // Block execution with a Promise that waits for user response
      const userResponse = await new Promise<{ answers: string[][]; rejected?: boolean }>(
        (resolve) => {
          session.pendingQuestion = {
            requestId,
            questions: sdkQuestions.map((q) => ({ question: q.question, header: q.header })),
            resolve
          }

          // Emit question.asked event to renderer (matches OpenCode event format)
          this.sendToRenderer('opencode:stream', {
            type: 'question.asked',
            sessionId: session.hiveSessionId,
            data: questionRequest
          })

          log.info('canUseTool: emitted question.asked, waiting for response', {
            requestId,
            hiveSessionId: session.hiveSessionId
          })

          // If the session is aborted while waiting, auto-reject
          const onAbort = (): void => {
            if (session.pendingQuestion?.requestId === requestId) {
              log.info('canUseTool: session aborted while question pending, auto-rejecting', {
                requestId
              })
              session.pendingQuestion = null
              this.pendingQuestionSessions.delete(requestId)
              resolve({ answers: [], rejected: true })
            }
          }
          options.signal.addEventListener('abort', onAbort, { once: true })
        }
      )

      // Clean up tracking state
      session.pendingQuestion = null
      this.pendingQuestionSessions.delete(requestId)

      if (userResponse.rejected) {
        log.info('canUseTool: AskUserQuestion rejected by user', { requestId })
        return {
          behavior: 'deny' as const,
          message: 'The user dismissed the question without answering.'
        }
      }

      // Translate Hive string[][] answers back to SDK Record<string, string> format
      // The SDK expects { answers: { "question text": "selected label(s)" } }
      const sdkAnswers: Record<string, string> = {}
      sdkQuestions.forEach((q, i) => {
        const selected = userResponse.answers[i] || []
        sdkAnswers[q.question] = selected.join(', ')
      })

      log.info('canUseTool: AskUserQuestion answered', {
        requestId,
        answerCount: Object.keys(sdkAnswers).length
      })

      return {
        behavior: 'allow' as const,
        updatedInput: { ...input, answers: sdkAnswers }
      }
    }
  }

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

    if (status === 'idle') {
      this.maybeNotifySessionComplete(hiveSessionId)
    }
  }

  /**
   * Show a native notification when a session completes while the app window is unfocused
   */
  private maybeNotifySessionComplete(hiveSessionId: string): void {
    try {
      if (!this.mainWindow || this.mainWindow.isDestroyed() || this.mainWindow.isFocused()) {
        return
      }

      if (!this.dbService) return

      const session = this.dbService.getSession(hiveSessionId)
      if (!session) {
        log.warn('Cannot notify: session not found', { hiveSessionId })
        return
      }

      const project = this.dbService.getProject(session.project_id)
      if (!project) {
        log.warn('Cannot notify: project not found', { projectId: session.project_id })
        return
      }

      notificationService.showSessionComplete({
        projectName: project.name,
        sessionName: session.name || 'Untitled',
        projectId: session.project_id,
        worktreeId: session.worktree_id || '',
        sessionId: hiveSessionId
      })
    } catch (error) {
      log.warn('Failed to show session completion notification', { hiveSessionId, error })
    }
  }

  private emitSdkMessage(
    hiveSessionId: string,
    msg: Record<string, unknown>,
    messageIndex: number,
    toolNames?: Map<string, string>
  ): void {
    const msgType = msg.type as string
    const childSessionId = (msg.parent_tool_use_id as string) || undefined

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
          childSessionId,
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
                childSessionId,
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

        // NOTE: Previously this emitted the result text as message.part.updated,
        // but that duplicated text already streamed via stream_event deltas.
        // Removed to fix duplicate message display.

        this.sendToRenderer('opencode:stream', {
          type: 'message.updated',
          sessionId: hiveSessionId,
          childSessionId,
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
                    output: (msg.usage as Record<string, unknown>).output_tokens,
                    cacheRead: (msg.usage as Record<string, unknown>).cache_read_input_tokens,
                    cacheCreation: (msg.usage as Record<string, unknown>)
                      .cache_creation_input_tokens
                  }
                : undefined,
              modelUsage: msg.modelUsage
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
                childSessionId,
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
            childSessionId,
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
          childSessionId,
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
          childSessionId,
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

  private normalizeRewindResult(result: void | RewindFilesResult): RewindFilesResult | null {
    if (!result || typeof result !== 'object') return null
    return result
  }

  private isNoFileCheckpointFoundError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error)
    return message.toLowerCase().includes('no file checkpoint found')
  }

  /**
   * Resume the session solely to get access to `rewindFiles()`, then
   * immediately close the query.
   *
   * This follows the official SDK file-checkpointing pattern: resume
   * with a lightweight prompt, iterate one message to establish the
   * transport, call rewindFiles(), then close.
   *
   * We use `prompt: '.'` because the SDK documented pattern uses an
   * empty string, but the API rejects both empty and whitespace-only
   * text blocks.  A single dot is the minimal non-whitespace prompt.
   * See: https://github.com/anthropics/claude-agent-sdk-typescript/issues
   *
   * The throwaway entries this writes to the JSONL don't matter — the
   * next prompt uses `forkSession: true` + `resumeSessionAt` to branch
   * from the correct point, so the throwaway entries are excluded from
   * the forked session's context entirely.
   *
   * `maxTurns: 1` prevents the assistant from doing real work.
   */
  private async rewindWithResumedQuery(
    session: ClaudeSessionState,
    targetUuid: string
  ): Promise<void | RewindFilesResult> {
    const sdk = await loadClaudeSDK()

    const rewindQueryRaw = sdk.query({
      prompt: '.',
      options: {
        cwd: session.worktreePath,
        resume: session.claudeSessionId,
        enableFileCheckpointing: true,
        maxTurns: 1,
        env: {
          ...process.env,
          CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '1'
        },
        ...(this.claudeBinaryPath ? { pathToClaudeCodeExecutable: this.claudeBinaryPath } : {})
      }
    })

    if (
      !rewindQueryRaw ||
      typeof (rewindQueryRaw as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !==
        'function'
    ) {
      throw new Error('Cannot undo: failed to resume session for rewinding')
    }

    const rewindQuery = rewindQueryRaw as AsyncIterable<Record<string, unknown>>
    const queryObj = rewindQueryRaw as unknown as ClaudeQuery
    if (!queryObj.rewindFiles) {
      throw new Error('Cannot undo: SDK query does not support rewindFiles')
    }

    let result: void | RewindFilesResult | undefined
    let gotMessage = false
    try {
      for await (const _message of rewindQuery) {
        gotMessage = true
        result = await queryObj.rewindFiles(targetUuid)
        break
      }
    } finally {
      // Forcefully terminate the throwaway query subprocess
      if (queryObj.close) {
        queryObj.close()
      } else if (queryObj.return) {
        await queryObj.return().catch(() => {})
      }
    }

    if (!gotMessage) {
      throw new Error('Cannot undo: failed to resume session for rewinding')
    }

    return result
  }

  /**
   * Extract prompt text from a session message's parts array or content string.
   */
  private extractPromptFromMessage(msg: Record<string, unknown> | undefined): string {
    if (!msg) return ''

    // Try parts array first
    const parts = msg.parts as Array<Record<string, unknown>> | undefined
    if (Array.isArray(parts)) {
      const textParts = parts
        .filter((p) => p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text as string)
      if (textParts.length > 0) return textParts.join('\n')
    }

    // Fall back to content string
    if (typeof msg.content === 'string') return msg.content

    return ''
  }

  /**
   * Find a message in session.messages by UUID (checking the `id` field).
   * Returns the message object or undefined if not found.
   */
  private findMessageByUuid(
    session: ClaudeSessionState,
    uuid: string
  ): Record<string, unknown> | undefined {
    for (const msg of session.messages) {
      const m = msg as Record<string, unknown>
      if (m.id === uuid) return m
    }
    return undefined
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
      // Headless mode — no renderer window. Events still reach mobile
      // clients via the EventBus emit below, so this is expected.
      log.debug('sendToRenderer: no window (headless)')
    }
    try {
      const bus = getEventBus()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (channel === 'opencode:stream') bus.emit('opencode:stream', data as any)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      else if (channel === 'worktree:branchRenamed') bus.emit('worktree:branchRenamed', data as any)
    } catch {
      // EventBus not available
    }
  }

  // ── File attachment helpers ──────────────────────────────────────

  /**
   * Returns true if the message array contains at least one file part (image/PDF).
   */
  private hasFileAttachments(
    message:
      | string
      | Array<
          | { type: 'text'; text: string }
          | { type: 'file'; mime: string; url: string; filename?: string }
        >
  ): boolean {
    if (typeof message === 'string') return false
    return message.some((part) => part.type === 'file')
  }

  /**
   * Parse a data URL into its media type and raw base64 data.
   * Input format: "data:<mime>;base64,<data>"
   * Returns { mediaType, data } or null if the URL is not a valid data URL.
   */
  private parseDataUrl(url: string): { mediaType: string; data: string } | null {
    const match = url.match(/^data:([^;]+);base64,(.+)$/)
    if (!match) return null
    return { mediaType: match[1], data: match[2] }
  }

  /**
   * Convert Hive message parts into Anthropic API content blocks.
   * - Text parts → { type: 'text', text }
   * - Image files (image/*) → { type: 'image', source: { type: 'base64', media_type, data } }
   * - PDF files (application/pdf) → { type: 'document', source: { type: 'base64', media_type, data } }
   * - Unrecognized file types → text placeholder fallback
   */
  private buildAnthropicContentBlocks(
    message: Array<
      | { type: 'text'; text: string }
      | { type: 'file'; mime: string; url: string; filename?: string }
    >
  ): Array<Record<string, unknown>> {
    const blocks: Array<Record<string, unknown>> = []

    for (const part of message) {
      if (part.type === 'text') {
        if (part.text.trim()) {
          blocks.push({ type: 'text', text: part.text })
        }
        continue
      }

      // part.type === 'file'
      const parsed = this.parseDataUrl(part.url)
      if (!parsed) {
        // Fallback for non-data URLs: include as text placeholder
        blocks.push({ type: 'text', text: `[file: ${part.filename ?? part.url}]` })
        continue
      }

      const { mediaType, data } = parsed

      if (mediaType.startsWith('image/')) {
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: mediaType,
            data
          }
        })
      } else if (mediaType === 'application/pdf') {
        blocks.push({
          type: 'document',
          source: {
            type: 'base64',
            media_type: mediaType,
            data
          }
        })
      } else {
        // Unsupported file type fallback
        blocks.push({ type: 'text', text: `[file: ${part.filename ?? 'attachment'}]` })
      }
    }

    return blocks
  }

  /**
   * Create an AsyncIterable that yields a single SDKUserMessage with the given content blocks.
   * Used when the prompt contains file attachments that need structured content blocks
   * instead of a plain text string.
   */
  private createUserMessageIterable(
    contentBlocks: Array<Record<string, unknown>>,
    sessionId: string
  ): AsyncIterable<Record<string, unknown>> {
    const message = {
      type: 'user' as const,
      message: {
        role: 'user' as const,
        content: contentBlocks
      },
      parent_tool_use_id: null,
      session_id: sessionId
    }

    return {
      [Symbol.asyncIterator]() {
        let done = false
        return {
          async next() {
            if (done) return { value: undefined, done: true as const }
            done = true
            return { value: message, done: false as const }
          }
        }
      }
    }
  }
}

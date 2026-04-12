import type { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'

import type { AgentSdkCapabilities, AgentSdkImplementer, PromptOptions } from './agent-sdk-types'
import { CODEX_CAPABILITIES } from './agent-sdk-types'
import {
  getAvailableCodexModels,
  getCodexModelInfo,
  CODEX_DEFAULT_MODEL,
  resolveCodexModelSlug
} from './codex-models'
import { createLogger } from './logger'
import { CodexAppServerManager, type CodexManagerEvent } from './codex-app-server-manager'
import { mapCodexManagerEventToActivity } from './codex-activity-mapper'
import { mapCodexEventToStreamEvents, contentStreamKindFromMethod } from './codex-event-mapper'
import { asNumber, asObject, asString, toJsonSnapshot } from './codex-utils'
import { generateCodexSessionTitle } from './codex-session-title'
import type { DatabaseService } from '../db/database'
import { autoRenameWorktreeBranch } from './git-service'
import { normalizeCodexToolName, stripShellPrefix } from '@shared/codex-tool-normalizer'

const log = createLogger({ component: 'CodexImplementer' })
// Balances write coalescing during rapid streaming against data freshness for crash recovery.
const PERSIST_DEBOUNCE_MS = 2000

// ── Session state ─────────────────────────────────────────────────

export interface CodexSessionState {
  threadId: string
  hiveSessionId: string
  worktreePath: string
  status: 'connecting' | 'ready' | 'running' | 'error' | 'closed'
  messages: unknown[]
  liveAssistantDraft?: CodexLiveAssistantDraft | null
  currentTurnId: string | null
  currentAssistantMessageId: string | null
  revertMessageID: string | null
  revertDiff: string | null
  titleGenerated: boolean
  titleGenerationStarted: boolean
  persistDebounceTimer: ReturnType<typeof setTimeout> | null
}

interface CodexLiveToolPart {
  type: 'tool'
  callID: string
  tool: string
  state: {
    status: 'running' | 'completed' | 'error'
    input?: unknown
    output?: unknown
    error?: unknown
  }
}

type CodexLiveDraftPart =
  | { type: 'text'; text: string; timestamp: string }
  | { type: 'reasoning'; text: string; timestamp: string }
  | CodexLiveToolPart

interface CodexLiveAssistantDraft {
  id: string
  timestamp: string
  parts: CodexLiveDraftPart[]
  toolIndexById: Map<string, number>
}

// ── Pending HITL entry (shared by questions and approvals) ────────

interface PendingHitlEntry {
  threadId: string
  hiveSessionId: string
  worktreePath: string
  turnId?: string
}

interface CodexPermissionRequest {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
  always: string[]
}

/**
 * Extracts the markdown content from a `<proposed_plan>` XML block.
 * Returns the inner content trimmed, or null if no block is found.
 */
function extractProposedPlanMarkdown(text: string): string | null {
  const match = text.match(/<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i)
  return match ? (match[1]?.trim() ?? null) : null
}

// ── Title helpers ───────────────────────────────────────────────────────────

function isDefaultSessionTitle(title: string | null | undefined): boolean {
  const normalized = title?.trim() ?? ''
  if (!normalized) return true

  return (
    /^Session \d+$/.test(normalized) ||
    /^New session\s*-?\s*\d{4}-\d{2}-\d{2}/i.test(normalized)
  )
}

export function normalizeCodexMessageTimestamps<T extends { created_at: string }>(rows: T[]): T[] {
  let lastTimestampMs = Number.NEGATIVE_INFINITY

  return rows.map((row) => {
    const parsed = Date.parse(row.created_at)
    const baseTimestampMs = Number.isFinite(parsed) ? parsed : Date.now()
    const nextTimestampMs =
      baseTimestampMs > lastTimestampMs ? baseTimestampMs : lastTimestampMs + 1
    lastTimestampMs = nextTimestampMs

    return {
      ...row,
      created_at: new Date(nextTimestampMs).toISOString()
    }
  })
}

// ── Snapshot tool-call helpers ────────────────────────────────────

function extractSnapshotToolCommand(itemObj: Record<string, unknown>): string | undefined {
  const inputObj =
    typeof itemObj.input === 'object' && itemObj.input !== null
      ? (itemObj.input as Record<string, unknown>)
      : undefined

  const candidates = [itemObj.command, inputObj?.command, itemObj.cmd, inputObj?.cmd]

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return stripShellPrefix(candidate.trim())
    }
    if (Array.isArray(candidate)) {
      const joined = candidate
        .filter((entry): entry is string => typeof entry === 'string')
        .join(' ')
        .trim()
      if (joined.length > 0) return stripShellPrefix(joined)
    }
  }
  return undefined
}

function buildSnapshotToolInput(itemObj: Record<string, unknown>): Record<string, unknown> {
  const inputObj =
    typeof itemObj.input === 'object' && itemObj.input !== null && !Array.isArray(itemObj.input)
      ? (itemObj.input as Record<string, unknown>)
      : {}
  const command = extractSnapshotToolCommand(itemObj)
  const changes = Array.isArray(itemObj.changes) ? itemObj.changes : undefined

  return {
    ...inputObj,
    ...(command ? { command } : {}),
    ...(changes ? { changes } : {})
  }
}

function extractMessageText(parts: unknown[]): string {
  const segments: string[] = []

  for (const part of parts) {
    const partObj = asObject(part)
    if (!partObj) continue

    const type = asString(partObj.type)
    if (type === 'text' || type === 'reasoning') {
      const text = asString(partObj.text)
      if (text) segments.push(text)
    }
  }

  return segments.join('')
}

export class CodexImplementer implements AgentSdkImplementer {
  readonly id = 'codex' as const
  readonly capabilities: AgentSdkCapabilities = CODEX_CAPABILITIES

  private mainWindow: BrowserWindow | null = null
  private dbService: DatabaseService | null = null
  private selectedModel: string = CODEX_DEFAULT_MODEL
  private selectedVariant: string | undefined
  private manager: CodexAppServerManager = new CodexAppServerManager()
  private sessions = new Map<string, CodexSessionState>()
  private pendingQuestions = new Map<string, PendingHitlEntry>()
  private pendingApprovalSessions = new Map<string, PendingHitlEntry>()

  // ── Window binding ───────────────────────────────────────────────

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  setDatabaseService(db: DatabaseService): void {
    this.dbService = db
  }

  // ── Manager event listener (handles approval/question routing) ──

  private managerListenerAttached = false

  private attachManagerListener(): void {
    if (this.managerListenerAttached) return
    this.managerListenerAttached = true

    this.manager.on('event', (event: CodexManagerEvent) => {
      this.handleManagerEvent(event)
    })
  }

  private handleManagerEvent(event: CodexManagerEvent): void {
    // DEBUG: Log ALL notification events to discover title-related methods
    if (event.kind === 'notification') {
      log.info('DEBUG handleManagerEvent: notification received', {
        method: event.method,
        threadId: event.threadId,
        payloadKeys: event.payload ? Object.keys(event.payload as Record<string, unknown>) : [],
        payloadSnapshot: toJsonSnapshot(event.payload, 500)
      })
    }

    const targetSession = this.findSessionByThreadId(event.threadId)
    if (targetSession) {
      this.persistActivity(targetSession, event)
    }

    // Clean up stale pending entries when a session closes
    if (
      event.kind === 'session' &&
      (event.method === 'session/closed' || event.method === 'session/exited')
    ) {
      this.cleanupPendingForThread(event.threadId)
      return
    }

    // Handle thread name updates from the Codex provider (title generation)
    if (event.kind === 'notification' && event.method === 'thread/name/updated') {
      this.handleProviderTitleUpdate(event).catch(() => {})
      return
    }

    // Handle token usage updates from the Codex provider
    if (event.kind === 'notification' && event.method === 'thread/tokenUsage/updated') {
      if (!targetSession) return

      const payload = asObject(event.payload)
      const tokenUsage = asObject(payload?.tokenUsage)
      // Use "last" (per-turn prompt size) not "total" (cumulative).
      // The context window shows how full the current prompt is,
      // not the sum of all tokens consumed across every turn.
      const last = asObject(tokenUsage?.last)
      const contextWindow = asNumber(tokenUsage?.modelContextWindow) ?? 0

      const inputTokens = asNumber(last?.inputTokens) ?? 0
      const cachedInputTokens = asNumber(last?.cachedInputTokens) ?? 0
      const outputTokens = asNumber(last?.outputTokens) ?? 0
      const reasoningTokens = asNumber(last?.reasoningOutputTokens) ?? 0

      const modelID = resolveCodexModelSlug(asString(payload?.model) ?? this.selectedModel)

      this.sendToRenderer('opencode:stream', {
        type: 'session.context_usage',
        sessionId: targetSession.hiveSessionId,
        data: {
          tokens: {
            // inputTokens includes cached; subtract so
            // input + cacheRead = total prompt tokens in store
            input: inputTokens - cachedInputTokens,
            cacheRead: cachedInputTokens,
            cacheWrite: 0,
            output: outputTokens,
            reasoning: reasoningTokens
          },
          model: { providerID: 'codex', modelID },
          contextWindow
        }
      })
      return
    }

    // Handle thread compaction notifications
    if (event.kind === 'notification' && event.method === 'thread/compacted') {
      if (!targetSession) return

      this.sendToRenderer('opencode:stream', {
        type: 'session.context_compacted',
        sessionId: targetSession.hiveSessionId,
        data: {}
      })
      return
    }

    // Only handle request events (approvals + user inputs)
    if (event.kind !== 'request') return

    if (!targetSession) return

    const requestId = event.requestId
    if (!requestId) return

    // Handle approval requests
    if (
      event.method === 'item/commandExecution/requestApproval' ||
      event.method === 'item/fileChange/requestApproval' ||
      event.method === 'item/fileRead/requestApproval'
    ) {
      this.pendingApprovalSessions.set(requestId, {
        threadId: targetSession.threadId,
        hiveSessionId: targetSession.hiveSessionId,
        worktreePath: targetSession.worktreePath,
        turnId: event.turnId
      })

      const payload = asObject(event.payload)
      this.sendToRenderer('opencode:stream', {
        type: 'permission.asked',
        sessionId: targetSession.hiveSessionId,
        data: this.toPermissionRequest(
          requestId,
          targetSession.hiveSessionId,
          event.method,
          payload,
          event.turnId,
          event.itemId
        )
      })
      return
    }

    // Handle user input requests (questions)
    if (event.method === 'item/tool/requestUserInput') {
      this.pendingQuestions.set(requestId, {
        threadId: targetSession.threadId,
        hiveSessionId: targetSession.hiveSessionId,
        worktreePath: targetSession.worktreePath,
        turnId: event.turnId
      })

      const payload = asObject(event.payload)
      const questions = (payload?.questions ?? []) as unknown[]

      this.sendToRenderer('opencode:stream', {
        type: 'question.asked',
        sessionId: targetSession.hiveSessionId,
        data: {
          requestId,
          id: requestId,
          questions
        }
      })
    }
  }

  private async handleProviderTitleUpdate(event: CodexManagerEvent): Promise<void> {
    const payload = asObject(event.payload)
    log.info('DEBUG handleProviderTitleUpdate: raw payload', {
      payloadKeys: payload ? Object.keys(payload) : [],
      fullPayload: toJsonSnapshot(event.payload, 1000)
    })
    const title = asString(payload?.threadName)
    if (!title) {
      log.warn(
        'DEBUG handleProviderTitleUpdate: threadName field empty/missing, tried payload?.threadName'
      )
      return
    }

    // Find session by threadId
    let targetSession: CodexSessionState | undefined
    for (const session of this.sessions.values()) {
      if (session.threadId === event.threadId) {
        targetSession = session
        break
      }
    }
    if (!targetSession) return

    await this.applyGeneratedTitle(targetSession, title)
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  async connect(worktreePath: string, hiveSessionId: string): Promise<{ sessionId: string }> {
    const resolvedModel = resolveCodexModelSlug(this.selectedModel)
    log.info('Connecting', { worktreePath, hiveSessionId, model: resolvedModel })

    // Ensure the manager event listener is attached for HITL flows
    this.attachManagerListener()

    const providerSession = await this.manager.startSession({
      cwd: worktreePath,
      model: resolvedModel
    })

    const threadId = providerSession.threadId
    if (!threadId) {
      throw new Error('Codex session started but no thread ID was returned.')
    }

    const key = this.getSessionKey(worktreePath, threadId)
    const state: CodexSessionState = {
      threadId,
      hiveSessionId,
      worktreePath,
      status: this.mapProviderStatus(providerSession.status),
      messages: [],
      liveAssistantDraft: null,
      currentTurnId: null,
      currentAssistantMessageId: null,
      revertMessageID: null,
      revertDiff: null,
      titleGenerated: false,
      titleGenerationStarted: false,
      persistDebounceTimer: null
    }
    this.sessions.set(key, state)

    // Notify renderer that the session has materialized
    this.sendToRenderer('opencode:stream', {
      type: 'session.materialized',
      sessionId: hiveSessionId,
      data: { newSessionId: threadId, wasFork: false }
    })

    log.info('Connected', { worktreePath, hiveSessionId, threadId })
    return { sessionId: threadId }
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

    // If session already exists locally, just update the hiveSessionId
    const existing = this.sessions.get(key)
    if (existing) {
      existing.hiveSessionId = hiveSessionId
      const sessionStatus = this.statusToHive(existing.status)
      log.info('Reconnect: session already registered, updated hiveSessionId', {
        worktreePath,
        agentSessionId,
        hiveSessionId,
        sessionStatus
      })
      return { success: true, sessionStatus, revertMessageID: null }
    }

    // Otherwise, start a new session with thread resume
    try {
      // Ensure the manager event listener is attached so notifications
      // like thread/tokenUsage/updated reach handleManagerEvent.
      this.attachManagerListener()

      const resolvedModel = resolveCodexModelSlug(this.selectedModel)
      const providerSession = await this.manager.startSession({
        cwd: worktreePath,
        model: resolvedModel,
        resumeThreadId: agentSessionId
      })

      const threadId = providerSession.threadId
      if (!threadId) {
        throw new Error('Codex session started but no thread ID was returned.')
      }

      const newKey = this.getSessionKey(worktreePath, threadId)
      const state: CodexSessionState = {
        threadId,
        hiveSessionId,
        worktreePath,
        status: this.mapProviderStatus(providerSession.status),
        messages: [],
        liveAssistantDraft: null,
        currentTurnId: null,
        currentAssistantMessageId: null,
        revertMessageID: null,
        revertDiff: null,
        titleGenerated: true,
        titleGenerationStarted: true,
        persistDebounceTimer: null
      }
      this.sessions.set(newKey, state)

      log.info('Reconnected via thread resume', { worktreePath, agentSessionId, threadId })

      // Fire-and-forget: hydrate token usage so the context bar shows
      // accumulated usage from previous turns, not 0/200k.
      this.hydrateTokenUsageFromThread(state).catch(() => {})

      return {
        success: true,
        sessionStatus: this.statusToHive(state.status),
        revertMessageID: null
      }
    } catch (error) {
      log.error('Reconnect failed', error instanceof Error ? error : new Error(String(error)), {
        worktreePath,
        agentSessionId
      })
      return { success: false }
    }
  }

  async disconnect(worktreePath: string, agentSessionId: string): Promise<void> {
    const key = this.getSessionKey(worktreePath, agentSessionId)
    const session = this.sessions.get(key)

    if (!session) {
      log.warn('Disconnect: session not found, ignoring', { worktreePath, agentSessionId })
      return
    }

    // Stop the manager session
    this.manager.stopSession(agentSessionId)

    // Flush any pending debounced persist before removing the session
    this.flushPendingPersist(session)

    // Clean up local state
    this.sessions.delete(key)
    this.cleanupPendingForThread(agentSessionId)

    log.info('Disconnected', { worktreePath, agentSessionId })
  }

  async cleanup(): Promise<void> {
    log.info('Cleaning up CodexImplementer state', { sessionCount: this.sessions.size })

    // Stop all manager sessions
    this.manager.stopAll()

    // Clear pending debounce timers (don't flush — avoid DB writes during teardown)
    for (const session of this.sessions.values()) {
      if (session.persistDebounceTimer) {
        clearTimeout(session.persistDebounceTimer)
        session.persistDebounceTimer = null
      }
    }

    // Clear local state
    this.sessions.clear()
    this.pendingQuestions.clear()
    this.pendingApprovalSessions.clear()
    this.managerListenerAttached = false
    this.mainWindow = null
    this.selectedModel = CODEX_DEFAULT_MODEL
    this.selectedVariant = undefined
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
    modelOverride?: { providerID: string; modelID: string; variant?: string },
    options?: PromptOptions
  ): Promise<void> {
    const key = this.getSessionKey(worktreePath, agentSessionId)
    const session = this.sessions.get(key)
    if (!session) {
      throw new Error(`Prompt failed: session not found for ${worktreePath} / ${agentSessionId}`)
    }

    // Extract text from message
    let text: string
    if (typeof message === 'string') {
      text = message
    } else {
      text = message
        .filter((part) => part.type === 'text')
        .map((part) => (part as { type: 'text'; text: string }).text)
        .join('\n')
    }

    if (!text.trim()) {
      log.warn('Prompt: empty text, ignoring', { worktreePath, agentSessionId })
      return
    }

    if (!session.titleGenerationStarted) {
      const currentTitle = this.dbService?.getSession(session.hiveSessionId)?.name ?? null
      if (isDefaultSessionTitle(currentTitle)) {
        session.titleGenerationStarted = true
        this.handleTitleGeneration(session, text).catch(() => {})
      } else {
        session.titleGenerated = true
        session.titleGenerationStarted = true
        log.info('Prompt: skipped title generation for pre-titled session', {
          hiveSessionId: session.hiveSessionId,
          currentTitle
        })
      }
    }

    // Inject synthetic user message so getMessages() returns it
    const syntheticTimestamp = new Date().toISOString()
    session.messages.push({
      id: `user-${randomUUID()}`,
      role: 'user',
      parts: [{ type: 'text', text, timestamp: syntheticTimestamp }],
      timestamp: syntheticTimestamp
    })
    this.persistCanonicalMessages(session)
    this.resetLiveAssistantDraft(session)
    session.currentTurnId = null
    session.currentAssistantMessageId = null

    // Emit busy status
    session.status = 'running'
    this.emitStatus(session.hiveSessionId, 'busy')

    log.info('Prompt: starting', {
      worktreePath,
      agentSessionId,
      hiveSessionId: session.hiveSessionId,
      textLength: text.length
    })

    // Set up event listener for streaming
    let interactionMode: 'default' | 'plan' = 'default'
    // Fallback accumulators: only populated when canonical path is not active.
    // Used for: (1) fallback message if canonical path fails, (2) plan extraction
    // last resort, (3) logging. Stay empty when canonical path is active.
    let assistantText = ''
    let reasoningText = ''
    let pendingPlanText: string | null = null
    let turnCompleted = false
    let turnFailed = false
    let completedTurnId: string | undefined

    const handleEvent = (event: CodexManagerEvent) => {
      // Only handle events for this thread
      if (event.threadId !== session.threadId) return

      const streamEvents = mapCodexEventToStreamEvents(event, session.hiveSessionId)
      for (const streamEvent of streamEvents) {
        if (
          event.method === 'turn/completed' &&
          streamEvent.type === 'session.status' &&
          streamEvent.statusPayload?.type === 'idle'
        ) {
          continue
        }
        this.sendToRenderer('opencode:stream', streamEvent)
        this.updateLiveAssistantDraftFromStreamEvent(session, streamEvent)
        if (this.synchronizeCanonicalAssistantFromStreamEvent(session, event, streamEvent)) {
          this.persistCanonicalMessagesDebounced(session)
        }
      }

      // Accumulate text for message history (only when canonical path is not active)
      if (!session.currentAssistantMessageId) {
        const streamKind = contentStreamKindFromMethod(event.method)
        if (streamKind) {
          const payload = event.payload as Record<string, unknown> | undefined
          const deltaText =
            event.textDelta ??
            asString(asObject(payload)?.delta) ??
            asString(asObject(payload)?.text) ??
            ''

          if (streamKind === 'reasoning' || streamKind === 'reasoning_summary') {
            reasoningText += deltaText
          } else {
            assistantText += deltaText
          }
        }
      }

      if (interactionMode === 'plan') {
        // Only extract plan from streaming events when <proposed_plan> XML
        // tags are present — the tag-based extraction is reliable.  Without
        // tags these events carry only the LAST message fragment, so we let
        // the post-turn fallback use the full accumulated assistantText.
        if (event.method === 'codex/event/task_complete') {
          const payload = asObject(event.payload)
          const msg = asObject(payload?.msg)
          const planText = asString(msg?.last_agent_message)
          if (planText) {
            const extracted = extractProposedPlanMarkdown(planText)
            if (extracted) pendingPlanText = extracted
          }
        }

        if (event.method === 'item/completed') {
          const payload = asObject(event.payload)
          const item = asObject(payload?.item)
          const itemType = asString(item?.type)?.toLowerCase()
          const planText = asString(item?.text)
          if (itemType === 'agentmessage' && planText) {
            const extracted = extractProposedPlanMarkdown(planText)
            if (extracted) pendingPlanText = extracted
          }
        }
      }

      // Detect turn completion and whether it failed
      if (event.method === 'turn/completed') {
        turnCompleted = true
        const payload = event.payload as Record<string, unknown> | undefined
        const turnObj = payload?.turn as Record<string, unknown> | undefined
        completedTurnId =
          event.turnId ?? (typeof turnObj?.id === 'string' ? (turnObj.id as string) : undefined)
        const status = (turnObj?.status as string) ?? (payload?.state as string)
        if (status === 'failed') {
          turnFailed = true
        }
      }
    }

    this.manager.on('event', handleEvent)

    try {
      const model = resolveCodexModelSlug(modelOverride?.modelID ?? this.selectedModel)

      // Determine interaction mode from DB session mode (same pattern as claude-code-implementer)
      if (this.dbService) {
        try {
          const dbSession = this.dbService.getSession(session.hiveSessionId)
          if (dbSession?.mode === 'plan') {
            interactionMode = 'plan'
          }
        } catch {
          // Fall through to default mode
        }
      }

      const reasoningEffort = modelOverride?.variant ?? this.selectedVariant
      await this.manager.sendTurn(session.threadId, {
        text,
        model,
        ...(options?.codexFastMode ? { serviceTier: 'fast' } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        interactionMode
      })

      // Wait for turn completion (the sendTurn starts the turn, but
      // events stream asynchronously via the manager's event emitter)
      await this.waitForTurnCompletion(session, () => turnCompleted)

      // Persist the canonical streamed transcript first. This keeps reload
      // aligned with the exact structure that was rendered during streaming.
      this.flushPendingPersist(session)
      if (session.currentAssistantMessageId) {
        this.persistCanonicalMessages(session)
        session.liveAssistantDraft = null
      } else {
        // Fallback: use accumulated text as single message
        const assistantParts: unknown[] = []
        if (assistantText) {
          assistantParts.push({
            type: 'text',
            text: assistantText,
            timestamp: new Date().toISOString()
          })
        }
        if (reasoningText) {
          assistantParts.push({
            type: 'reasoning',
            text: reasoningText,
            timestamp: new Date().toISOString()
          })
        }
        if (assistantParts.length > 0) {
          session.messages.push({
            id: `assistant-${completedTurnId ?? randomUUID()}`,
            role: 'assistant',
            parts: assistantParts,
            timestamp: new Date().toISOString()
          })
        }
        this.persistCanonicalMessages(session)
        session.liveAssistantDraft = null
      }

      // If no plan was detected from streaming events, extract from the parsed
      // thread snapshot.  session.messages has properly separated messages
      // (unlike assistantText which concatenates all deltas without separators).
      // Use the last assistant text message — in plan mode that's the plan.
      if (interactionMode === 'plan' && !pendingPlanText) {
        const msgs = session.messages as Array<Record<string, unknown>>
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i]?.role !== 'assistant') continue
          const parts = msgs[i].parts as Array<Record<string, unknown>> | undefined
          if (!Array.isArray(parts)) continue
          for (let j = parts.length - 1; j >= 0; j--) {
            if (parts[j]?.type === 'text' && typeof parts[j]?.text === 'string') {
              const text = parts[j].text as string
              const extracted = extractProposedPlanMarkdown(text)
              pendingPlanText = extracted ?? text
              break
            }
          }
          if (pendingPlanText) break
        }

        // Ultimate fallback: accumulated streaming text (lossy but better than nothing)
        if (!pendingPlanText && assistantText) {
          const extracted = extractProposedPlanMarkdown(assistantText)
          pendingPlanText = extracted ?? assistantText
        }
      }

      if (interactionMode === 'plan' && pendingPlanText) {
        const toolUseID = `codex-exitplan-${session.threadId}-${Date.now()}`
        const requestId = `codex-plan:${session.threadId}`
        this.persistSyntheticActivity(session, {
          id: requestId,
          kind: 'plan.ready',
          tone: 'info',
          summary: 'Plan ready',
          requestId,
          turnId: completedTurnId,
          payload: { plan: pendingPlanText, toolUseID }
        })
        this.sendToRenderer('opencode:stream', {
          type: 'plan.ready',
          sessionId: session.hiveSessionId,
          data: {
            id: requestId,
            requestId,
            plan: pendingPlanText,
            toolUseID
          }
        })
      }

      session.status = turnFailed ? 'error' : 'ready'
      this.emitStatus(session.hiveSessionId, 'idle')

      log.info('Prompt: completed', {
        worktreePath,
        agentSessionId,
        assistantTextLength: assistantText.length,
        reasoningTextLength: reasoningText.length
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      log.error(
        'Prompt streaming error',
        error instanceof Error ? error : new Error(errorMessage),
        { worktreePath, agentSessionId, error: errorMessage }
      )

      session.status = 'error'
      session.liveAssistantDraft = null
      this.sendToRenderer('opencode:stream', {
        type: 'session.error',
        sessionId: session.hiveSessionId,
        data: { error: errorMessage }
      })
      this.emitStatus(session.hiveSessionId, 'idle')
    } finally {
      this.flushPendingPersist(session)
      session.currentTurnId = null
      session.currentAssistantMessageId = null
      this.manager.removeListener('event', handleEvent)
    }
  }

  async abort(worktreePath: string, agentSessionId: string): Promise<boolean> {
    const key = this.getSessionKey(worktreePath, agentSessionId)
    const session = this.sessions.get(key)
    if (!session) {
      log.warn('Abort: session not found', { worktreePath, agentSessionId })
      return false
    }

    try {
      await this.manager.interruptTurn(session.threadId)
    } catch (error) {
      log.warn('Abort: interruptTurn failed, continuing cleanup', {
        worktreePath,
        agentSessionId,
        error: error instanceof Error ? error.message : String(error)
      })
    }

    session.status = 'ready'
    session.liveAssistantDraft = null
    session.currentTurnId = null
    session.currentAssistantMessageId = null
    this.flushPendingPersist(session)
    this.persistCanonicalMessages(session)
    this.emitStatus(session.hiveSessionId, 'idle')
    return true
  }

  async getMessages(worktreePath: string, agentSessionId: string): Promise<unknown[]> {
    const key = this.getSessionKey(worktreePath, agentSessionId)
    let session = this.sessions.get(key)
    if (!session) {
      const recoveredSession = await this.recoverSessionForRead(worktreePath, agentSessionId)
      session = recoveredSession ?? undefined
    }

    if (!session) {
      log.warn('getMessages: session not found', { worktreePath, agentSessionId })
      return []
    }

    // Return in-memory messages if available
    if (session.messages.length > 0) {
      return [...session.messages]
    }

    if (session.status === 'running') {
      const liveDraftMessage = this.cloneLiveAssistantDraftMessage(session)
      if (liveDraftMessage) {
        return [liveDraftMessage]
      }
    }

    if (this.dbService) {
      try {
        const persistedMessages = this.dbService.getSessionMessages(session.hiveSessionId)
        if (persistedMessages.length > 0) {
          const parsed = persistedMessages.flatMap((message) => {
            const raw = message.opencode_message_json ?? message.opencode_timeline_json
            if (!raw) return []
            try {
              return [JSON.parse(raw)]
            } catch {
              return []
            }
          })
          if (parsed.length > 0) {
            session.messages = parsed
            return [...parsed]
          }
        }
      } catch (error) {
        log.warn('getMessages: failed to load persisted Codex messages', {
          agentSessionId,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }

    // Fallback: try reading from thread via the server
    if (session.status !== 'closed') {
      try {
        const threadSnapshot = await this.manager.readThread(session.threadId)
        const parsed = this.parseThreadSnapshot(threadSnapshot)
        if (parsed.length > 0) {
          session.messages = parsed
          this.persistCanonicalMessages(session)
          log.info('getMessages: warmed in-memory cache from thread/read', {
            agentSessionId,
            count: parsed.length
          })
          return [...parsed]
        }
      } catch (error) {
        log.warn('getMessages: readThread fallback failed', {
          agentSessionId,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }

    return []
  }

  // ── Models ───────────────────────────────────────────────────────

  async getAvailableModels(): Promise<unknown> {
    return getAvailableCodexModels()
  }

  async getModelInfo(
    _worktreePath: string,
    modelId: string
  ): Promise<{
    id: string
    name: string
    limit: { context: number; input?: number; output: number }
  } | null> {
    return getCodexModelInfo(modelId)
  }

  setSelectedModel(model: { providerID: string; modelID: string; variant?: string }): void {
    this.selectedModel = resolveCodexModelSlug(model.modelID)
    this.selectedVariant = model.variant
    log.info('Selected model set', {
      raw: model.modelID,
      resolved: this.selectedModel,
      variant: model.variant
    })
  }

  clearSelectedModel(): void {
    this.selectedModel = CODEX_DEFAULT_MODEL
    this.selectedVariant = undefined
    log.info('Selected model cleared, reset to default', { model: this.selectedModel })
  }

  // ── Session info ─────────────────────────────────────────────────

  async getSessionInfo(
    worktreePath: string,
    agentSessionId: string
  ): Promise<{
    revertMessageID: string | null
    revertDiff: string | null
  }> {
    const sessionKey = this.getSessionKey(worktreePath, agentSessionId)
    const session = this.sessions.get(sessionKey)
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
    const pending = this.pendingQuestions.get(requestId)
    if (!pending) {
      throw new Error(`No pending question found for requestId: ${requestId}`)
    }

    // Convert string[][] answers to the format Codex expects
    const codexAnswers = answers.map(([id, answer]) => ({
      id: id ?? requestId,
      answer: answer ?? ''
    }))

    log.info('questionReply: responding to pending question', {
      requestId,
      hiveSessionId: pending.hiveSessionId,
      answerCount: codexAnswers.length
    })

    this.manager.respondToUserInput(pending.threadId, requestId, codexAnswers)
    this.pendingQuestions.delete(requestId)
    const session = this.findSessionByThreadId(pending.threadId)
    if (session) {
      this.persistSyntheticActivity(session, {
        id: `${requestId}:resolved`,
        kind: 'user-input.resolved',
        tone: 'approval',
        summary: 'User input answered',
        requestId,
        turnId: pending.turnId,
        payload: { answers: codexAnswers }
      })
    }

    this.sendToRenderer('opencode:stream', {
      type: 'question.replied',
      sessionId: pending.hiveSessionId,
      data: { requestId, id: requestId }
    })
  }

  async questionReject(requestId: string, _worktreePath?: string): Promise<void> {
    const pending = this.pendingQuestions.get(requestId)
    if (!pending) {
      throw new Error(`No pending question found for requestId: ${requestId}`)
    }

    log.info('questionReject: rejecting pending question', {
      requestId,
      hiveSessionId: pending.hiveSessionId
    })

    this.manager.rejectUserInput(pending.threadId, requestId)
    this.pendingQuestions.delete(requestId)
    const session = this.findSessionByThreadId(pending.threadId)
    if (session) {
      this.persistSyntheticActivity(session, {
        id: `${requestId}:resolved`,
        kind: 'user-input.resolved',
        tone: 'approval',
        summary: 'User input dismissed',
        requestId,
        turnId: pending.turnId,
        payload: { dismissed: true }
      })
    }

    this.sendToRenderer('opencode:stream', {
      type: 'question.rejected',
      sessionId: pending.hiveSessionId,
      data: { requestId, id: requestId }
    })
  }

  async permissionReply(
    requestId: string,
    decision: 'once' | 'always' | 'reject',
    _worktreePath?: string
  ): Promise<void> {
    const pending = this.pendingApprovalSessions.get(requestId)
    if (!pending) {
      throw new Error(`No pending approval found for requestId: ${requestId}`)
    }

    log.info('permissionReply: responding to pending approval', {
      requestId,
      hiveSessionId: pending.hiveSessionId,
      decision
    })

    this.manager.respondToApproval(pending.threadId, requestId, decision)
    this.pendingApprovalSessions.delete(requestId)
    const session = this.findSessionByThreadId(pending.threadId)
    if (session) {
      this.persistSyntheticActivity(session, {
        id: `${requestId}:resolved`,
        kind: 'approval.resolved',
        tone: 'approval',
        summary: 'Approval resolved',
        requestId,
        turnId: pending.turnId,
        payload: { decision }
      })
    }

    this.sendToRenderer('opencode:stream', {
      type: 'permission.replied',
      sessionId: pending.hiveSessionId,
      data: { requestId, id: requestId, decision }
    })
  }

  async permissionList(_worktreePath?: string): Promise<unknown[]> {
    // Aggregate pending approvals across all sessions
    const result: unknown[] = []
    for (const session of this.sessions.values()) {
      const approvals = this.manager.getPendingApprovals(session.threadId)
      for (const approval of approvals) {
        const payload = asObject(approval.payload)
        result.push({
          ...this.toPermissionRequest(
            approval.requestId,
            session.hiveSessionId,
            approval.method,
            payload,
            approval.turnId,
            approval.itemId
          )
        })
      }
    }
    return result
  }

  private toPermissionRequest(
    requestId: string,
    hiveSessionId: string,
    method: string,
    payload: Record<string, unknown> | undefined,
    turnId?: string,
    itemId?: string
  ): CodexPermissionRequest {
    const permission = this.permissionFromApprovalMethod(method)
    const patterns = this.patternsFromApprovalPayload(method, payload)

    return {
      id: requestId,
      sessionID: hiveSessionId,
      permission,
      patterns,
      metadata: {
        method,
        ...(payload ? { payload } : {}),
        ...(turnId ? { turnId } : {}),
        ...(itemId ? { itemId } : {})
      },
      always: []
    }
  }

  private permissionFromApprovalMethod(method: string): string {
    switch (method) {
      case 'item/commandExecution/requestApproval':
        return 'bash'
      case 'item/fileRead/requestApproval':
        return 'read'
      case 'item/fileChange/requestApproval':
        return 'edit'
      default:
        return 'unknown'
    }
  }

  private patternsFromApprovalPayload(
    method: string,
    payload: Record<string, unknown> | undefined
  ): string[] {
    if (!payload) return []

    if (method === 'item/commandExecution/requestApproval') {
      const command = asString(payload.command)
      return command ? [command] : []
    }

    const filePath =
      asString(payload.path) ?? asString(payload.filePath) ?? asString(payload.target)
    return filePath ? [filePath] : []
  }

  /** Check if a question requestId belongs to this implementer */
  hasPendingQuestion(requestId: string): boolean {
    return this.pendingQuestions.has(requestId)
  }

  /** Check if a permission requestId belongs to this implementer */
  hasPendingApproval(requestId: string): boolean {
    return this.pendingApprovalSessions.has(requestId)
  }

  // ── Undo/Redo ────────────────────────────────────────────────────

  async undo(
    worktreePath: string,
    agentSessionId: string,
    _hiveSessionId: string
  ): Promise<{ revertMessageID: string; restoredPrompt: string; revertDiff: string | null }> {
    const sessionKey = this.getSessionKey(worktreePath, agentSessionId)
    const session = this.sessions.get(sessionKey)
    if (!session) {
      throw new Error(`Undo failed: session not found for ${worktreePath} / ${agentSessionId}`)
    }

    if (session.messages.length === 0) {
      throw new Error('Nothing to undo')
    }

    // Rollback 1 turn via the Codex server
    const snapshot = await this.manager.rollbackThread(session.threadId, 1)

    // Try to extract the last user prompt from in-memory messages
    const restoredPrompt = this.extractLastUserPrompt(session)

    // Pop the last exchange (assistant + user) from in-memory messages
    // Find the last user message boundary
    const revertMessageID = this.popLastExchange(session)

    // Store revert state
    session.revertMessageID = revertMessageID
    session.revertDiff = null

    // Emit session info update to renderer
    this.sendToRenderer('opencode:stream', {
      type: 'session.updated',
      sessionId: session.hiveSessionId,
      data: { revertMessageID }
    })

    log.info('Undo completed', {
      worktreePath,
      agentSessionId,
      revertMessageID,
      restoredPrompt: restoredPrompt.slice(0, 50),
      snapshotReceived: !!snapshot
    })

    return { revertMessageID, restoredPrompt, revertDiff: null }
  }

  async redo(
    _worktreePath: string,
    _agentSessionId: string,
    _hiveSessionId: string
  ): Promise<unknown> {
    throw new Error('Redo is not supported for Codex sessions')
  }

  // ── Commands ─────────────────────────────────────────────────────

  async listCommands(_worktreePath: string): Promise<unknown[]> {
    throw new Error('CodexImplementer.listCommands() not yet implemented')
  }

  async sendCommand(
    _worktreePath: string,
    _agentSessionId: string,
    _command: string,
    _args?: string
  ): Promise<void> {
    throw new Error('CodexImplementer.sendCommand() not yet implemented')
  }

  // ── Session management ───────────────────────────────────────────

  async renameSession(_worktreePath: string, agentSessionId: string, name: string): Promise<void> {
    // Codex has no server-side rename — just update Hive's local DB
    if (!this.dbService) {
      log.warn('renameSession: no dbService available', { agentSessionId })
      return
    }

    // Find hive session by matching agentSessionId (threadId)
    const sessionKey = this.findSessionKeyByAgentId(agentSessionId)
    if (sessionKey) {
      const session = this.sessions.get(sessionKey)
      if (session?.hiveSessionId) {
        try {
          this.dbService.updateSession(session.hiveSessionId, { name })
          log.info('renameSession: updated title in DB', {
            hiveSessionId: session.hiveSessionId,
            name
          })
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err))
          log.error('renameSession: failed to update title', error, {
            hiveSessionId: session.hiveSessionId
          })
        }
      }
    } else {
      log.warn('renameSession: session not found in active map', { agentSessionId })
    }
  }

  // ── Internal helpers (exposed for testing) ───────────────────────

  /** @internal */
  getSelectedModel(): string {
    return this.selectedModel
  }

  /** @internal */
  getSelectedVariant(): string | undefined {
    return this.selectedVariant
  }

  /** @internal */
  getMainWindow(): BrowserWindow | null {
    return this.mainWindow
  }

  /** @internal */
  getManager(): CodexAppServerManager {
    return this.manager
  }

  /** @internal */
  getSessions(): Map<string, CodexSessionState> {
    return this.sessions
  }

  /** @internal */
  getPendingQuestions(): Map<string, PendingHitlEntry> {
    return this.pendingQuestions
  }

  /** @internal */
  getPendingApprovalSessions(): Map<string, PendingHitlEntry> {
    return this.pendingApprovalSessions
  }

  // ── Private helpers ──────────────────────────────────────────────

  private cleanupPendingForThread(threadId: string): void {
    for (const [reqId, entry] of this.pendingQuestions.entries()) {
      if (entry.threadId === threadId) {
        this.pendingQuestions.delete(reqId)
      }
    }
    for (const [reqId, entry] of this.pendingApprovalSessions.entries()) {
      if (entry.threadId === threadId) {
        this.pendingApprovalSessions.delete(reqId)
      }
    }
  }

  /**
   * Hydrate token usage on reconnect by reading the session JSONL file.
   *
   * thread/read does NOT include tokenUsage data, but the JSONL session
   * file contains event_msg entries with type "token_count" that carry
   * full cumulative token data.  We read the file, find the LAST
   * token_count event, and emit a session.context_usage event.
   */
  private async hydrateTokenUsageFromThread(session: CodexSessionState): Promise<void> {
    try {
      // 1. Get the JSONL path from thread/read
      const snapshot = await this.manager.readThread(session.threadId)
      const obj = asObject(snapshot)
      const threadObj = asObject(obj?.thread) ?? obj
      const jsonlPath = asString(threadObj?.path)
      if (!jsonlPath) {
        log.debug('hydrateTokenUsage: no path in thread/read response')
        return
      }

      // 2. Read the JSONL file and find the last token_count event
      const { readFile } = await import('node:fs/promises')
      const content = await readFile(jsonlPath, 'utf-8')
      const lines = content.split('\n').filter((l) => l.trim())

      let lastTokenCount: Record<string, unknown> | undefined
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]) as Record<string, unknown>
          const msg = asObject(entry.msg)
          if (msg?.type === 'token_count') {
            lastTokenCount = asObject(msg.info)
            break
          }
        } catch {
          continue
        }
      }

      if (!lastTokenCount) {
        log.debug('hydrateTokenUsage: no token_count in JSONL')
        return
      }

      // 3. Extract token data (snake_case fields from JSONL)
      // Use last_token_usage (per-turn prompt size), not total_token_usage
      // (cumulative). The context bar shows current prompt fill, not
      // lifetime consumption.
      const lastUsage = asObject(lastTokenCount.last_token_usage)
      if (!lastUsage) return

      const inputTokens = asNumber(lastUsage.input_tokens) ?? 0
      const cachedInputTokens = asNumber(lastUsage.cached_input_tokens) ?? 0
      const outputTokens = asNumber(lastUsage.output_tokens) ?? 0
      const reasoningTokens = asNumber(lastUsage.reasoning_output_tokens) ?? 0
      const contextWindow = asNumber(lastTokenCount.model_context_window) ?? 0

      if (inputTokens === 0 && outputTokens === 0) return

      const modelID = resolveCodexModelSlug(this.selectedModel)

      this.sendToRenderer('opencode:stream', {
        type: 'session.context_usage',
        sessionId: session.hiveSessionId,
        data: {
          tokens: {
            input: inputTokens - cachedInputTokens,
            cacheRead: cachedInputTokens,
            cacheWrite: 0,
            output: outputTokens,
            reasoning: reasoningTokens
          },
          model: { providerID: 'codex', modelID },
          contextWindow
        }
      })

      log.info('hydrateTokenUsage: emitted context_usage from JSONL', {
        hiveSessionId: session.hiveSessionId,
        inputTokens,
        contextWindow,
        modelID
      })
    } catch (error) {
      log.debug('hydrateTokenUsage: failed', {
        hiveSessionId: session.hiveSessionId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private findSessionByThreadId(threadId: string): CodexSessionState | undefined {
    for (const session of this.sessions.values()) {
      if (session.threadId === threadId) {
        return session
      }
    }
    return undefined
  }

  private getSessionKey(worktreePath: string, agentSessionId: string): string {
    return `${worktreePath}::${agentSessionId}`
  }

  private sendToRenderer(channel: string, data: unknown): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data)
    } else {
      log.debug('sendToRenderer: no window')
    }
  }

  private persistActivity(session: CodexSessionState, event: CodexManagerEvent): void {
    if (!this.dbService) return

    const activity = mapCodexManagerEventToActivity(session.hiveSessionId, session.threadId, event)
    if (!activity) return

    try {
      this.dbService.upsertSessionActivity(activity)
    } catch (error) {
      log.warn('Failed to persist Codex activity', {
        hiveSessionId: session.hiveSessionId,
        method: event.method,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private persistSyntheticActivity(
    session: CodexSessionState,
    params: {
      id: string
      kind:
        | 'approval.resolved'
        | 'user-input.resolved'
        | 'plan.ready'
        | 'plan.resolved'
        | 'session.error'
        | 'session.info'
      tone: 'approval' | 'info' | 'error'
      summary: string
      requestId?: string
      turnId?: string
      payload?: unknown
    }
  ): void {
    if (!this.dbService) return

    try {
      this.dbService.upsertSessionActivity({
        id: params.id,
        session_id: session.hiveSessionId,
        agent_session_id: session.threadId,
        thread_id: session.threadId,
        turn_id: params.turnId ?? null,
        request_id: params.requestId ?? null,
        kind: params.kind,
        tone: params.tone,
        summary: params.summary,
        payload_json: params.payload ? JSON.stringify(params.payload) : null
      })
    } catch (error) {
      log.warn('Failed to persist synthetic Codex activity', {
        hiveSessionId: session.hiveSessionId,
        kind: params.kind,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private persistCanonicalMessagesDebounced(session: CodexSessionState): void {
    if (session.persistDebounceTimer) clearTimeout(session.persistDebounceTimer)
    session.persistDebounceTimer = setTimeout(() => {
      session.persistDebounceTimer = null
      this.persistCanonicalMessages(session)
    }, PERSIST_DEBOUNCE_MS)
  }

  private flushPendingPersist(session: CodexSessionState): void {
    if (session.persistDebounceTimer) {
      clearTimeout(session.persistDebounceTimer)
      session.persistDebounceTimer = null
      this.persistCanonicalMessages(session)
    }
  }

  private persistCanonicalMessages(session: CodexSessionState): void {
    if (!this.dbService) return

    try {
      const rows = session.messages.flatMap((message) => {
        const record = asObject(message)
        if (!record) return []

        const role = asString(record.role)
        const timestamp = asString(record.timestamp) ?? new Date().toISOString()
        if (role !== 'user' && role !== 'assistant' && role !== 'system') return []

        const parts = Array.isArray(record.parts) ? record.parts : []
        const textContent = extractMessageText(parts)
        const canonicalMessage = {
          ...record,
          id: asString(record.id) ?? `${role}-${randomUUID()}`,
          role,
          parts,
          timestamp
        }

        return [
          {
            session_id: session.hiveSessionId,
            role,
            content: textContent,
            opencode_message_id: canonicalMessage.id,
            opencode_message_json: JSON.stringify(canonicalMessage),
            opencode_parts_json: JSON.stringify(parts),
            opencode_timeline_json: JSON.stringify(canonicalMessage),
            created_at: timestamp
          }
        ]
      })

      this.dbService.replaceSessionMessages(
        session.hiveSessionId,
        normalizeCodexMessageTimestamps(rows)
      )
    } catch (error) {
      log.warn('Failed to persist Codex canonical messages', {
        hiveSessionId: session.hiveSessionId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private mapProviderStatus(
    status: 'connecting' | 'ready' | 'running' | 'error' | 'closed'
  ): CodexSessionState['status'] {
    return status
  }

  private statusToHive(status: CodexSessionState['status']): 'idle' | 'busy' | 'retry' {
    if (status === 'running') return 'busy'
    return 'idle'
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
  }

  private resetLiveAssistantDraft(session: CodexSessionState): void {
    session.liveAssistantDraft = {
      id: `codex-live-${session.threadId}`,
      timestamp: new Date().toISOString(),
      parts: [],
      toolIndexById: new Map()
    }
  }

  private ensureLiveAssistantDraft(session: CodexSessionState): CodexLiveAssistantDraft {
    if (!session.liveAssistantDraft) {
      this.resetLiveAssistantDraft(session)
    }
    return session.liveAssistantDraft!
  }

  private getAssistantMessageId(session: CodexSessionState, turnId?: string): string {
    if (turnId) return `${turnId}:assistant`
    if (session.currentAssistantMessageId) return session.currentAssistantMessageId
    return `codex-live-${session.threadId}`
  }

  private getOrCreateCanonicalAssistantMessage(
    session: CodexSessionState,
    turnId?: string
  ): Record<string, unknown> {
    const messageId = this.getAssistantMessageId(session, turnId)
    session.currentAssistantMessageId = messageId
    if (turnId) session.currentTurnId = turnId

    const existingIndex = session.messages.findIndex((message) => {
      const record = asObject(message)
      return asString(record?.id) === messageId
    })

    if (existingIndex >= 0) {
      const existing = asObject(session.messages[existingIndex])
      if (existing) {
        if (typeof existing.timestamp !== 'string') {
          existing.timestamp = new Date().toISOString()
        }
        return existing
      }
    }

    const timestamp = new Date().toISOString()
    const message: Record<string, unknown> = {
      id: messageId,
      role: 'assistant',
      parts: [],
      timestamp
    }
    session.messages.push(message)
    return message
  }

  private renameCanonicalAssistantMessage(
    session: CodexSessionState,
    nextMessageId: string
  ): Record<string, unknown> {
    const currentId = session.currentAssistantMessageId
    if (!currentId || currentId === nextMessageId) {
      session.currentAssistantMessageId = nextMessageId
      return this.getOrCreateCanonicalAssistantMessage(session, session.currentTurnId ?? undefined)
    }

    const existingIndex = session.messages.findIndex((message) => {
      const record = asObject(message)
      return asString(record?.id) === currentId
    })

    if (existingIndex >= 0) {
      const record = asObject(session.messages[existingIndex])
      if (record) {
        record.id = nextMessageId
        session.currentAssistantMessageId = nextMessageId
        return record
      }
    }

    session.currentAssistantMessageId = nextMessageId
    return this.getOrCreateCanonicalAssistantMessage(session, session.currentTurnId ?? undefined)
  }

  private appendCanonicalAssistantText(
    session: CodexSessionState,
    kind: 'text' | 'reasoning',
    text: string,
    turnId?: string
  ): void {
    if (!text) return

    const message = this.getOrCreateCanonicalAssistantMessage(session, turnId)
    const parts = Array.isArray(message.parts) ? (message.parts as Array<Record<string, unknown>>) : []
    const lastPart = parts[parts.length - 1]
    const timestamp = new Date().toISOString()

    if (lastPart && asString(lastPart.type) === kind) {
      lastPart.text = `${asString(lastPart.text) ?? ''}${text}`
    } else {
      parts.push({ type: kind, text, timestamp })
    }

    message.parts = parts
    message.timestamp = asString(message.timestamp) ?? timestamp
  }

  private upsertCanonicalAssistantTool(
    session: CodexSessionState,
    tool: {
      callID: string
      tool: string
      state: {
        status: 'running' | 'completed' | 'error'
        input?: unknown
        output?: unknown
        error?: unknown
      }
    },
    turnId?: string
  ): void {
    if (!tool.callID) return

    const message = this.getOrCreateCanonicalAssistantMessage(session, turnId)
    const parts = Array.isArray(message.parts) ? (message.parts as Array<Record<string, unknown>>) : []
    const existingIndex = parts.findIndex((part) => {
      const partObj = asObject(part)
      const toolUse = asObject(partObj?.toolUse)
      return asString(partObj?.type) === 'tool_use' && asString(toolUse?.id) === tool.callID
    })

    const nextToolUse = {
      id: tool.callID,
      name: tool.tool || 'unknown',
      input:
        tool.state.input && typeof tool.state.input === 'object' && !Array.isArray(tool.state.input)
          ? (tool.state.input as Record<string, unknown>)
          : {},
      status:
        tool.state.status === 'completed'
          ? 'success'
          : tool.state.status === 'error'
            ? 'error'
            : 'running',
      startTime: Date.now(),
      ...(tool.state.output !== undefined ? { output: tool.state.output } : {}),
      ...(tool.state.error !== undefined ? { error: tool.state.error } : {}),
      ...(tool.state.status !== 'running' ? { endTime: Date.now() } : {})
    }
    // Remove outputDelta from nextToolUse — it's transient
    delete (nextToolUse as any).outputDelta

    if (existingIndex >= 0) {
      const existingToolUse = asObject(asObject(parts[existingIndex])?.toolUse)
      // Handle outputDelta accumulation
      const prevOutput = existingToolUse?.output
      const outputDelta = (tool.state as any).outputDelta
      const accumulatedOutput = outputDelta
        ? ((prevOutput as string) ?? '') + outputDelta
        : undefined

      parts[existingIndex] = {
        type: 'tool_use',
        toolUse: {
          ...(existingToolUse ?? {}),
          ...nextToolUse,
          ...(accumulatedOutput !== undefined ? { output: accumulatedOutput } : {}),
          startTime:
            typeof existingToolUse?.startTime === 'number'
              ? existingToolUse.startTime
              : nextToolUse.startTime
        }
      }
    } else {
      parts.push({ type: 'tool_use', toolUse: nextToolUse })
    }

    message.parts = parts
  }

  private synchronizeCanonicalAssistantFromStreamEvent(
    session: CodexSessionState,
    event: CodexManagerEvent,
    streamEvent: { type?: string; data?: unknown }
  ): boolean {
    if (event.method === 'turn/started' && event.turnId) {
      const previousId = session.currentAssistantMessageId
      session.currentTurnId = event.turnId
      if (!previousId) {
        session.currentAssistantMessageId = `${event.turnId}:assistant`
        return false
      }

      const nextId = this.getAssistantMessageId(session, event.turnId)
      this.renameCanonicalAssistantMessage(session, nextId)
      return previousId !== nextId
    }

    if (streamEvent.type !== 'message.part.updated') return false

    const data = asObject(streamEvent.data)
    const part = asObject(data?.part)
    if (!part) return false

    const partType = asString(part.type)
    if (partType === 'text') {
      const delta = asString(data?.delta) ?? asString(part.text) ?? ''
      this.appendCanonicalAssistantText(session, 'text', delta, event.turnId ?? session.currentTurnId ?? undefined)
      return delta.length > 0
    }

    if (partType === 'reasoning') {
      const delta = asString(data?.delta) ?? asString(part.text) ?? ''
      this.appendCanonicalAssistantText(
        session,
        'reasoning',
        delta,
        event.turnId ?? session.currentTurnId ?? undefined
      )
      return delta.length > 0
    }

    if (partType === 'tool') {
      const state = asObject(part.state)
      const statusValue = asString(state?.status)
      const status =
        statusValue === 'completed' || statusValue === 'error' ? statusValue : 'running'

      this.upsertCanonicalAssistantTool(
        session,
        {
          callID: asString(part.callID) ?? asString(part.id) ?? '',
          tool: asString(part.tool) ?? 'unknown',
          state: {
            status,
            ...(state?.input !== undefined ? { input: state.input } : {}),
            ...(state?.output !== undefined ? { output: state.output } : {}),
            ...(state?.error !== undefined ? { error: state.error } : {}),
            ...(state?.outputDelta !== undefined ? { outputDelta: state.outputDelta } : {})
          } as any
        },
        event.turnId ?? session.currentTurnId ?? undefined
      )
      return true
    }

    return false
  }

  private appendLiveAssistantText(
    session: CodexSessionState,
    kind: 'text' | 'reasoning',
    text: string
  ): void {
    if (!text) return

    const draft = this.ensureLiveAssistantDraft(session)
    const lastPart = draft.parts[draft.parts.length - 1]
    const timestamp = new Date().toISOString()

    if (lastPart && lastPart.type === kind) {
      lastPart.text += text
      return
    }

    draft.parts.push({ type: kind, text, timestamp })
  }

  private upsertLiveAssistantTool(
    session: CodexSessionState,
    tool: {
      callID: string
      tool: string
      state: {
        status: 'running' | 'completed' | 'error'
        input?: unknown
        output?: unknown
        error?: unknown
      }
    }
  ): void {
    if (!tool.callID) return

    const draft = this.ensureLiveAssistantDraft(session)
    const existingIndex = draft.toolIndexById.get(tool.callID)

    if (existingIndex !== undefined) {
      const existing = draft.parts[existingIndex]
      if (existing && existing.type === 'tool') {
        existing.tool = tool.tool || existing.tool
        const appendedOutput = (tool.state as any).outputDelta
          ? ((existing.state.output as string) ?? '') + (tool.state as any).outputDelta
          : undefined
        existing.state = {
          ...existing.state,
          ...tool.state,
          ...(tool.state.input === undefined ? { input: existing.state.input } : {}),
          ...(appendedOutput !== undefined
            ? { output: appendedOutput }
            : tool.state.output === undefined ? { output: existing.state.output } : {}),
          ...(tool.state.error === undefined ? { error: existing.state.error } : {})
        }
        // Remove outputDelta from persisted state — it's transient
        delete (existing.state as any).outputDelta
      }
      return
    }

    draft.toolIndexById.set(tool.callID, draft.parts.length)
    draft.parts.push({
      type: 'tool',
      callID: tool.callID,
      tool: tool.tool,
      state: tool.state
    })
    // Remove outputDelta from persisted state — it's transient (new-tool path)
    delete (draft.parts[draft.parts.length - 1].state as any).outputDelta
  }

  private updateLiveAssistantDraftFromStreamEvent(
    session: CodexSessionState,
    streamEvent: { type?: string; data?: unknown }
  ): void {
    if (streamEvent.type !== 'message.part.updated') return

    const data = asObject(streamEvent.data)
    const part = asObject(data?.part)
    if (!part) return

    const partType = asString(part.type)
    if (partType === 'text') {
      const delta = asString(data?.delta) ?? asString(part.text) ?? ''
      this.appendLiveAssistantText(session, 'text', delta)
      return
    }

    if (partType === 'reasoning') {
      const delta = asString(data?.delta) ?? asString(part.text) ?? ''
      this.appendLiveAssistantText(session, 'reasoning', delta)
      return
    }

    if (partType === 'tool') {
      const state = asObject(part.state)
      const statusValue = asString(state?.status)
      const status =
        statusValue === 'completed' || statusValue === 'error' ? statusValue : 'running'

      this.upsertLiveAssistantTool(session, {
        callID: asString(part.callID) ?? asString(part.id) ?? '',
        tool: asString(part.tool) ?? 'unknown',
        state: {
          status,
          ...(state?.input !== undefined ? { input: state.input } : {}),
          ...(state?.output !== undefined ? { output: state.output } : {}),
          ...(state?.error !== undefined ? { error: state.error } : {}),
          ...(state?.outputDelta !== undefined ? { outputDelta: state.outputDelta } : {})
        } as any
      })
    }
  }

  private cloneLiveAssistantDraftMessage(session: CodexSessionState): unknown | null {
    const draft = session.liveAssistantDraft
    if (!draft || draft.parts.length === 0) return null

    return {
      id: draft.id,
      role: 'assistant',
      parts: draft.parts.map((part) => {
        if (part.type === 'text' || part.type === 'reasoning') {
          return { ...part }
        }

        return {
          type: 'tool',
          callID: part.callID,
          tool: part.tool,
          state: { ...part.state }
        }
      }),
      timestamp: draft.timestamp
    }
  }

  private waitForTurnCompletion(
    session: CodexSessionState,
    isComplete: () => boolean,
    timeoutMs = 300_000
  ): Promise<void> {
    if (isComplete()) return Promise.resolve()

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('Turn timed out'))
      }, timeoutMs)

      const checkEvent = (event: CodexManagerEvent) => {
        if (event.threadId !== session.threadId) return

        if (event.method === 'turn/completed') {
          cleanup()
          resolve()
          return
        }

        // Only reject on truly fatal errors — not stderr warnings.
        // The Codex app-server may output benign stderr content (warnings,
        // progress info, non-standard log formats) that should not abort
        // the turn. Only process crashes and session exits are fatal.
        const isFatalError =
          event.method === 'process/error' ||
          event.method === 'session/exited' ||
          event.method === 'session/closed'

        if (isFatalError) {
          cleanup()
          reject(new Error(event.message ?? 'Codex process error'))
          return
        }

        const isErrorStateChange =
          (event.method === 'session.state.changed' || event.method === 'session/state/changed') &&
          (event.payload as Record<string, unknown> | undefined)?.state === 'error'

        if (isErrorStateChange) {
          const payload = event.payload as Record<string, unknown>
          const reason =
            (payload?.reason as string) ??
            (payload?.error as string) ??
            event.message ??
            'Session entered error state'
          cleanup()
          reject(new Error(reason))
        }
      }

      const cleanup = () => {
        clearTimeout(timer)
        this.manager.removeListener('event', checkEvent)
      }

      this.manager.on('event', checkEvent)

      // Check again in case it completed between the start and listener setup
      if (isComplete()) {
        cleanup()
        resolve()
      }
    })
  }

  /** Find a session key by its agentSessionId (threadId) */
  private findSessionKeyByAgentId(agentSessionId: string): string | null {
    for (const [key, session] of this.sessions.entries()) {
      if (session.threadId === agentSessionId) {
        return key
      }
    }
    return null
  }

  /** Extract the last user prompt text from in-memory messages */
  private extractLastUserPrompt(session: CodexSessionState): string {
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const msg = asObject(session.messages[i])
      if (msg?.role === 'user') {
        const parts = msg.parts as unknown[] | undefined
        if (Array.isArray(parts)) {
          for (const part of parts) {
            const partObj = asObject(part)
            if (partObj?.type === 'text' && typeof partObj.text === 'string') {
              return partObj.text
            }
          }
        }
      }
    }
    return ''
  }

  /**
   * Pop the last user+assistant exchange from in-memory messages.
   * Returns the ID/timestamp of the new last message (the revert boundary),
   * or a synthetic boundary ID if no messages remain.
   */
  private popLastExchange(session: CodexSessionState): string {
    // Remove trailing assistant message(s)
    while (session.messages.length > 0) {
      const last = asObject(session.messages[session.messages.length - 1])
      if (last?.role === 'assistant') {
        session.messages.pop()
      } else {
        break
      }
    }

    // Remove the trailing user message
    if (session.messages.length > 0) {
      const last = asObject(session.messages[session.messages.length - 1])
      if (last?.role === 'user') {
        session.messages.pop()
      }
    }

    // Return the ID of what's now the last message, or a synthetic boundary
    if (session.messages.length > 0) {
      const last = asObject(session.messages[session.messages.length - 1])
      return asString(last?.id) ?? asString(last?.timestamp) ?? `revert-${session.messages.length}`
    }

    return 'revert-0'
  }

  private async recoverSessionForRead(
    worktreePath: string,
    agentSessionId: string
  ): Promise<CodexSessionState | null> {
    if (!this.dbService) {
      return null
    }

    const persistedSession = this.dbService.getSessionByOpenCodeSessionId(agentSessionId)
    if (!persistedSession || persistedSession.agent_sdk !== 'codex') {
      return null
    }

    try {
      const providerSession = await this.manager.startSession({
        cwd: worktreePath,
        model: resolveCodexModelSlug(persistedSession.model_id ?? this.selectedModel),
        resumeThreadId: agentSessionId
      })

      const threadId = providerSession.threadId
      if (!threadId) {
        throw new Error('Codex session resumed for read but no thread ID was returned.')
      }

      const recovered: CodexSessionState = {
        threadId,
        hiveSessionId: persistedSession.id,
        worktreePath,
        status: this.mapProviderStatus(providerSession.status),
        messages: [],
        liveAssistantDraft: null,
        currentTurnId: null,
        currentAssistantMessageId: null,
        revertMessageID: null,
        revertDiff: null,
        titleGenerated: true,
        titleGenerationStarted: true,
        persistDebounceTimer: null
      }

      this.sessions.set(this.getSessionKey(worktreePath, threadId), recovered)

      log.info('Recovered persisted Codex session for transcript read', {
        worktreePath,
        agentSessionId,
        threadId,
        hiveSessionId: persistedSession.id
      })

      return recovered
    } catch (error) {
      log.warn('Failed to recover persisted Codex session for transcript read', {
        worktreePath,
        agentSessionId,
        error: error instanceof Error ? error.message : String(error)
      })
      return null
    }
  }

  private async handleTitleGeneration(
    session: CodexSessionState,
    userMessage: string
  ): Promise<void> {
    try {
      const title = await generateCodexSessionTitle(userMessage, session.worktreePath)
      if (!title) return
      await this.applyGeneratedTitle(session, title)
    } catch (err) {
      log.warn('handleTitleGeneration: failed', {
        hiveSessionId: session.hiveSessionId,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  private async applyGeneratedTitle(session: CodexSessionState, title: string): Promise<void> {
    const trimmedTitle = title.trim()
    if (!trimmedTitle) return
    session.titleGenerated = true

    let currentTitle: string | null = null
    if (this.dbService) {
      try {
        currentTitle = this.dbService.getSession(session.hiveSessionId)?.name ?? null
      } catch {
        currentTitle = null
      }
    }

    const titleChanged = currentTitle !== trimmedTitle

    if (this.dbService && titleChanged) {
      this.dbService.updateSession(session.hiveSessionId, { name: trimmedTitle })
      log.info('applyGeneratedTitle: updated DB', {
        hiveSessionId: session.hiveSessionId,
        title: trimmedTitle
      })
    }

    if (titleChanged) {
      this.sendToRenderer('opencode:stream', {
        type: 'session.updated',
        sessionId: session.hiveSessionId,
        data: { title: trimmedTitle, info: { title: trimmedTitle } }
      })
    } else {
      log.debug('applyGeneratedTitle: title unchanged, skipping session rename event', {
        hiveSessionId: session.hiveSessionId,
        title: trimmedTitle
      })
    }

    if (!this.dbService) return
    const worktree = this.dbService.getWorktreeBySessionId(session.hiveSessionId)
    if (worktree && !worktree.branch_renamed) {
      try {
        const result = await autoRenameWorktreeBranch({
          worktreeId: worktree.id,
          worktreePath: worktree.path,
          currentBranchName: worktree.branch_name,
          sessionTitle: trimmedTitle,
          db: this.dbService
        })
        if (result.renamed) {
          this.sendToRenderer('worktree:branchRenamed', {
            worktreeId: worktree.id,
            newBranch: result.newBranch
          })
          log.info('applyGeneratedTitle: auto-renamed branch', {
            oldBranch: worktree.branch_name,
            newBranch: result.newBranch
          })
        } else if (result.error) {
          log.warn('applyGeneratedTitle: rename failed', { error: result.error })
        }
      } catch (err) {
        this.dbService.updateWorktree(worktree.id, { branch_renamed: 1 })
        log.warn('applyGeneratedTitle: branch rename error', { err })
      }
    }

    const dbSession = this.dbService.getSession(session.hiveSessionId)
    if (!dbSession?.connection_id) return

    const connection = this.dbService.getConnection(dbSession.connection_id)
    if (!connection) return

    for (const member of connection.members) {
      if (worktree && member.worktree_id === worktree.id) continue
      try {
        const memberWorktree = this.dbService.getWorktree(member.worktree_id)
        if (!memberWorktree || memberWorktree.branch_renamed) continue

        const result = await autoRenameWorktreeBranch({
          worktreeId: memberWorktree.id,
          worktreePath: memberWorktree.path,
          currentBranchName: memberWorktree.branch_name,
          sessionTitle: trimmedTitle,
          db: this.dbService
        })
        if (result.renamed) {
          this.sendToRenderer('worktree:branchRenamed', {
            worktreeId: memberWorktree.id,
            newBranch: result.newBranch
          })
          log.info('applyGeneratedTitle: auto-renamed connection member', {
            connectionId: dbSession.connection_id,
            worktreeId: memberWorktree.id,
            oldBranch: memberWorktree.branch_name,
            newBranch: result.newBranch
          })
        } else if (result.error) {
          log.warn('applyGeneratedTitle: connection member rename failed', {
            connectionId: dbSession.connection_id,
            worktreeId: memberWorktree.id,
            error: result.error
          })
        }
      } catch (err) {
        log.warn('applyGeneratedTitle: connection member rename error', {
          worktreeId: member.worktree_id,
          err
        })
      }
    }
  }

  /** Parse a thread/read snapshot into a message array for getMessages() */
  private parseThreadSnapshot(snapshot: unknown): unknown[] {
    const obj = asObject(snapshot)
    if (!obj) return []

    const threadObj = asObject(obj.thread) ?? obj
    const turns = threadObj.turns as unknown[] | undefined
    if (!Array.isArray(turns)) return []

    const messages: Array<{ message: unknown; sortTime: number; order: number }> = []
    let order = 0
    const pushMessage = (message: unknown, timestamp: string | null | undefined): void => {
      const parsedTimestamp = timestamp ? Date.parse(timestamp) : Number.NaN
      messages.push({
        message,
        sortTime: Number.isFinite(parsedTimestamp) ? parsedTimestamp : Number.MAX_SAFE_INTEGER,
        order: order++
      })
    }

    for (const turn of turns) {
      const turnObj = asObject(turn)
      if (!turnObj) continue

      const turnId = asString(turnObj.id)
      const turnTimestamp = asString(turnObj.createdAt) ?? asString(turnObj.updatedAt)
      const items = turnObj.items as unknown[] | undefined
      if (Array.isArray(items) && items.length > 0) {
        let assistantItemOrdinal = 0
        let userItemOrdinal = 0

        const makeUserMessageId = (itemId?: string): string | undefined => {
          if (!turnId) return itemId
          if (userItemOrdinal === 0) {
            userItemOrdinal += 1
            return `${turnId}:user`
          }
          const suffix = itemId ?? `item-${userItemOrdinal + 1}`
          userItemOrdinal += 1
          return `${turnId}:user:${suffix}`
        }

        const makeAssistantMessageId = (itemId?: string): string | undefined => {
          if (!turnId) return itemId
          if (assistantItemOrdinal === 0) {
            assistantItemOrdinal += 1
            return `${turnId}:assistant`
          }
          const suffix = itemId ?? `item-${assistantItemOrdinal + 1}`
          assistantItemOrdinal += 1
          return `${turnId}:assistant:${suffix}`
        }

        for (const item of items) {
          const itemObj = asObject(item)
          if (!itemObj) continue

          const itemType = asString(itemObj.type)
          const itemId = asString(itemObj.id)
          const itemTimestamp = turnTimestamp ?? new Date().toISOString()

          if (itemType === 'userMessage') {
            const content = itemObj.content as unknown[] | undefined
            const textParts: unknown[] = []

            if (Array.isArray(content)) {
              for (const entry of content) {
                const entryObj = asObject(entry)
                if (entryObj?.type === 'text' && typeof entryObj.text === 'string') {
                  textParts.push({
                    type: 'text',
                    text: entryObj.text,
                    timestamp: itemTimestamp
                  })
                }
              }
            }

            if (textParts.length > 0) {
              const messageId = makeUserMessageId(itemId)
              pushMessage(
                {
                  ...(messageId ? { id: messageId } : {}),
                  role: 'user',
                  parts: textParts,
                  timestamp: itemTimestamp
                },
                itemTimestamp
              )
            }
            continue
          }

          if (itemType === 'agentMessage' || itemType === 'plan') {
            const text = asString(itemObj.text)
            if (text) {
              const messageId = makeAssistantMessageId(itemId)
              pushMessage(
                {
                  ...(messageId ? { id: messageId } : {}),
                  role: 'assistant',
                  parts: [
                    {
                      type: 'text',
                      text,
                      timestamp: itemTimestamp
                    }
                  ],
                  timestamp: itemTimestamp
                },
                itemTimestamp
              )
            }
            continue
          }

          if (itemType === 'reasoning') {
            const summary = Array.isArray(itemObj.summary)
              ? itemObj.summary.filter((entry): entry is string => typeof entry === 'string')
              : []
            const content = Array.isArray(itemObj.content)
              ? itemObj.content.filter((entry): entry is string => typeof entry === 'string')
              : []
            const reasoningText = [...summary, ...content].join('\n').trim()

            if (reasoningText) {
              const messageId = makeAssistantMessageId(itemId)
              pushMessage(
                {
                  ...(messageId ? { id: messageId } : {}),
                  role: 'assistant',
                  parts: [
                    {
                      type: 'reasoning',
                      text: reasoningText,
                      timestamp: itemTimestamp
                    }
                  ],
                  timestamp: itemTimestamp
                },
                itemTimestamp
              )
            }
            continue
          }

          if (itemType === 'commandExecution' || itemType === 'fileChange') {
            const toolName = normalizeCodexToolName(
              asString(itemObj.toolName) ?? asString(itemObj.name) ?? itemType
            )
            const input = buildSnapshotToolInput(itemObj)
            const output = itemObj.output ?? itemObj.aggregatedOutput
            const status = asString(itemObj.status)

            const stringifiedOutput =
              output !== undefined && output !== null
                ? typeof output === 'string'
                  ? output
                  : JSON.stringify(output)
                : undefined

            const messageId = makeAssistantMessageId(itemId)
            pushMessage(
              {
                ...(messageId ? { id: messageId } : {}),
                role: 'assistant',
                parts: [
                  {
                    type: 'tool_use',
                    toolUse: {
                      id: itemId ?? `tool-${order}`,
                      name: toolName,
                      input,
                      // Snapshots only contain completed turns — never 'running'
                      status: status === 'failed' ? 'error' : 'success',
                      startTime: Date.parse(itemTimestamp) || Date.now(),
                      endTime: Date.parse(itemTimestamp) || Date.now(),
                      output: status !== 'failed' ? stringifiedOutput : undefined,
                      error:
                        status === 'failed'
                          ? (stringifiedOutput ?? 'Tool execution failed')
                          : undefined
                    }
                  }
                ],
                timestamp: itemTimestamp
              },
              itemTimestamp
            )
            continue
          }
        }

        continue
      }

      // Extract user input
      const input = turnObj.input as unknown[] | undefined
      if (Array.isArray(input)) {
        const textParts: unknown[] = []
        for (const item of input) {
          const itemObj = asObject(item)
          if (itemObj?.type === 'text' && typeof itemObj.text === 'string') {
            textParts.push({
              type: 'text',
              text: itemObj.text,
              timestamp: asString(turnObj.createdAt) ?? new Date().toISOString()
            })
          }
        }
        if (textParts.length > 0) {
          const timestamp = asString(turnObj.createdAt) ?? new Date().toISOString()
          pushMessage(
            {
              ...(turnId ? { id: `${turnId}:user` } : {}),
              role: 'user',
              parts: textParts,
              timestamp
            },
            timestamp
          )
        }
      }

      // Extract assistant output
      const output = turnObj.output as unknown[] | undefined
      const outputText = asString(turnObj.outputText)
      if (outputText) {
        const timestamp = asString(turnObj.updatedAt) ?? new Date().toISOString()
        pushMessage(
          {
            ...(turnId ? { id: `${turnId}:assistant` } : {}),
            role: 'assistant',
            parts: [
              {
                type: 'text',
                text: outputText,
                timestamp
              }
            ],
            timestamp
          },
          timestamp
        )
      } else if (Array.isArray(output)) {
        const assistantParts: unknown[] = []
        for (const item of output) {
          const itemObj = asObject(item)
          if (!itemObj) continue
          if (itemObj.type === 'text' && typeof itemObj.text === 'string') {
            assistantParts.push({
              type: 'text',
              text: itemObj.text,
              timestamp: asString(turnObj.updatedAt) ?? new Date().toISOString()
            })
          }
        }
        if (assistantParts.length > 0) {
          const timestamp = asString(turnObj.updatedAt) ?? new Date().toISOString()
          pushMessage(
            {
              ...(turnId ? { id: `${turnId}:assistant` } : {}),
              role: 'assistant',
              parts: assistantParts,
              timestamp
            },
            timestamp
          )
        }
      }
    }

    return messages
      .sort((a, b) => {
        if (a.sortTime !== b.sortTime) return a.sortTime - b.sortTime
        return a.order - b.order
      })
      .map((entry) => entry.message)
  }
}

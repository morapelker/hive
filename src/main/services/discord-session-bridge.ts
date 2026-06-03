import type { OpenCodeStreamEvent } from '@shared/types/opencode'
import type { PermissionRequest } from '@shared/types/opencode'
import { OPENCODE_STREAM_CHANNEL } from '@shared/opencode-events'
import { applyModePrefix } from '@shared/agent-mode-prefixes'
import {
  normalizeAgentSdk,
  resolveSessionCreation,
  type ModelResolutionSettings,
  type SharedSelectedModel
} from '@shared/model-resolution'
import { APP_SETTINGS_DB_KEY } from '@shared/types/settings'
import type { AgentSdk } from '@shared/types/agent-sdk'
import type { DiscordEmissionMode } from '@shared/types/discord'
import { getDiscordToolEmoji, getToolLabel, isFileChangeTool } from '@shared/tool-label'
import type { DatabaseService } from '../db/database'
import { getDatabase } from '../db'
import type { DiscordResource, Session, SessionMode } from '../db/types'
import { agentEventBus } from './agent-event-bus'
import type { AgentSdkManager } from './agent-sdk-manager'
import { createLogger } from './logger'
import {
  abortOpenCodeSession,
  connectOpenCodeSession,
  disconnectOpenCodeSession,
  promptOpenCodeSession,
  reconnectOpenCodeSession
} from './opencode-session-commands'
import { claudeCliDiscordBridge } from './claude-cli-discord-bridge'
import {
  createInteractiveReplyRouter,
  type InteractiveReplyRouter
} from './interactive-reply-router'

const log = createLogger({ component: 'DiscordSessionBridge' })

const DISCORD_EMISSION_MODE_KEY = 'discord_emission_mode'

type PromptPart = { type: 'text'; text: string }
type ModelOverride = { providerID: string; modelID: string; variant?: string }
type BackendEventPublisher = (channel: string, payload: unknown) => void

interface DiscordTextChannel {
  send(content: unknown): Promise<unknown> | unknown
  sendTyping(): Promise<unknown> | unknown
}

interface DiscordSentMessage {
  id: string
  content?: string
  edit(update: { content?: string; components?: unknown[] }): Promise<unknown> | unknown
}

interface OpenCodeBridgeService {
  connect(worktreePath: string, hiveSessionId: string): Promise<{ sessionId: string }>
  reconnect(
    worktreePath: string,
    opencodeSessionId: string,
    hiveSessionId: string
  ): Promise<{ success: boolean; sessionStatus?: 'idle' | 'busy' | 'retry' }>
  prompt(
    worktreePath: string,
    opencodeSessionId: string,
    parts: PromptPart[],
    modelOverride?: ModelOverride
  ): Promise<void>
  abort(worktreePath: string, opencodeSessionId: string): Promise<boolean>
  disconnect(worktreePath: string, opencodeSessionId: string): Promise<void>
}

interface ChannelRuntime {
  channelId: string
  channel: DiscordTextChannel
  hiveSessionId: string
  worktreePath: string
  opencodeSessionId: string
  model: SharedSelectedModel
  mode: SessionMode
  agentSdk: AgentSdk
  busy: boolean
  currentAssistantMessageId: string | null
  textBuffer: string
  pendingUserEchoText: string | null
  postedToolIds: Set<string>
  typingInterval: ReturnType<typeof setInterval> | null
  queue: string[]
  sendChain: Promise<void>
}

export interface DiscordSessionBridgeDependencies {
  db?: DatabaseService
  openCodeService?: OpenCodeBridgeService
  subscribeToAgentEvents?: (listener: (event: OpenCodeStreamEvent) => void) => () => void
  publishEvent?: BackendEventPublisher
  resolveChannel?: (channelId: string) => Promise<DiscordTextChannel | null>
  replyRouter?: InteractiveReplyRouter
  typingIntervalMs?: number
}

export interface DiscordUserMessageInput {
  channelId: string
  worktreeId: string
  projectId: string
  worktreePath: string
  text: string
  channel: DiscordTextChannel
}

type DiscordPendingKind = 'question' | 'permission' | 'command' | 'plan'

interface PendingQuestion {
  header?: string
  question: string
  options: Array<{ label: string; description?: string }>
  multiple: boolean
}

interface PendingDiscordMessage {
  id: string
  message: DiscordSentMessage
  originalContent: string
}

interface DiscordPendingInteraction {
  kind: DiscordPendingKind
  requestId: string
  channelId: string
  sessionId: string
  worktreePath?: string
  agentSdk: AgentSdk
  messages: PendingDiscordMessage[]
  questions?: PendingQuestion[]
  partialAnswers?: string[][]
  optionValueLabels?: Map<string, string>
  permissionRequest?: PermissionRequest
  patternSuggestions?: string[]
  plan?: string
  handoffAgentSdk?: AgentSdk
  handoffModel?: SharedSelectedModel
}

interface ParsedCustomId {
  kind: DiscordPendingKind
  requestId: string
  action: string
  questionIndex?: number
}

interface InteractiveTarget {
  channelId: string
  channel: DiscordTextChannel
  hiveSessionId: string
  worktreePath?: string
  agentSdk: AgentSdk
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function normalizeToolStatus(status: unknown): 'running' | 'success' | 'error' {
  if (status === 'error') return 'error'
  if (status === 'success' || status === 'completed') return 'success'
  return 'running'
}

function getImplementerSdk(sdk: AgentSdk): AgentSdk {
  return sdk === 'claude-code-cli' ? 'claude-code' : sdk
}

function displayToolName(name: string): string {
  const lower = name.toLowerCase()
  if (lower.includes('bash') || lower.includes('shell') || lower.includes('exec')) return 'Bash'
  if (isFileChangeTool(lower)) return 'Edited'
  if (!name) return 'Tool'
  return name
}

export function splitDiscordMessage(text: string, max = 2000): string[] {
  if (text.length <= max) return text ? [text] : []

  const chunks: string[] = []
  let remaining = text
  while (remaining.length > max) {
    const candidate = remaining.slice(0, max)
    const splitAt = Math.max(
      candidate.lastIndexOf('\n'),
      candidate.lastIndexOf(' '),
      candidate.lastIndexOf('\t')
    )
    const cut = splitAt > Math.floor(max * 0.6) ? splitAt : max
    const chunk = remaining.slice(0, cut).trimEnd()
    chunks.push(chunk)
    remaining = remaining.slice(cut).trimStart()
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

export class DiscordSessionBridge {
  private db: DatabaseService | null
  private readonly openCode: OpenCodeBridgeService
  private readonly subscribeToAgentEvents: (
    listener: (event: OpenCodeStreamEvent) => void
  ) => () => void
  private readonly typingIntervalMs: number
  private publishEvent: BackendEventPublisher | null
  private resolveChannel: ((channelId: string) => Promise<DiscordTextChannel | null>) | null
  private readonly replyRouter: InteractiveReplyRouter
  private sdkManager: AgentSdkManager | null = null
  private unsubscribe: (() => void) | null = null
  private unsubscribeCliBridge: (() => void) | null = null
  private runtimesBySessionId = new Map<string, ChannelRuntime>()
  private channelModeByWorktree = new Map<string, SessionMode>()
  private emissionMode: DiscordEmissionMode = 'all'
  private discordPending = new Map<string, DiscordPendingInteraction>()
  private requestTokens = new Map<string, string>()
  private tokenRequestIds = new Map<string, string>()
  private localResolutionOutcomes = new Map<string, string>()

  constructor(dependencies: DiscordSessionBridgeDependencies = {}) {
    this.db = dependencies.db ?? null
    this.openCode = dependencies.openCodeService ?? this.createSdkAwareOpenCodeBridge()
    this.subscribeToAgentEvents =
      dependencies.subscribeToAgentEvents ?? ((listener) => agentEventBus.subscribe(listener))
    this.typingIntervalMs = dependencies.typingIntervalMs ?? 8000
    this.publishEvent = dependencies.publishEvent ?? null
    this.resolveChannel = dependencies.resolveChannel ?? null
    this.replyRouter = dependencies.replyRouter ?? createInteractiveReplyRouter()
  }

  setBackendEventPublisher(publishEvent: BackendEventPublisher | null): void {
    this.publishEvent = publishEvent
  }

  setAgentSdkManager(manager: AgentSdkManager | null): void {
    this.sdkManager = manager
    this.replyRouter.setAgentSdkManager(manager)
  }

  setChannelResolver(
    resolveChannel: ((channelId: string) => Promise<DiscordTextChannel | null>) | null
  ): void {
    this.resolveChannel = resolveChannel
  }

  private createSdkAwareOpenCodeBridge(): OpenCodeBridgeService {
    return {
      connect: async (worktreePath, hiveSessionId) => {
        const result = await connectOpenCodeSession(
          worktreePath,
          hiveSessionId,
          this.sdkManager ?? undefined,
          this.getDb()
        )
        if (!result.success || !result.sessionId) {
          throw new Error(result.error ?? 'Failed to connect session')
        }
        return { sessionId: result.sessionId }
      },
      reconnect: async (worktreePath, opencodeSessionId, hiveSessionId) =>
        reconnectOpenCodeSession(
          worktreePath,
          opencodeSessionId,
          hiveSessionId,
          this.sdkManager ?? undefined,
          this.getDb()
        ),
      prompt: async (worktreePath, opencodeSessionId, parts, modelOverride) => {
        const result = await promptOpenCodeSession(
          worktreePath,
          opencodeSessionId,
          parts,
          modelOverride,
          undefined,
          this.sdkManager ?? undefined,
          this.getDb()
        )
        if (!result.success) {
          throw new Error(result.error ?? 'Failed to prompt session')
        }
      },
      abort: async (worktreePath, opencodeSessionId) => {
        const result = await abortOpenCodeSession(
          worktreePath,
          opencodeSessionId,
          this.sdkManager ?? undefined,
          this.getDb()
        )
        return result.success
      },
      disconnect: async (worktreePath, opencodeSessionId) => {
        const result = await disconnectOpenCodeSession(
          worktreePath,
          opencodeSessionId,
          this.sdkManager ?? undefined,
          this.getDb()
        )
        if (!result.success) {
          throw new Error(result.error ?? 'Failed to disconnect session')
        }
      }
    }
  }

  start(): void {
    if (this.unsubscribe) return
    this.loadEmissionMode()
    this.unsubscribe = this.subscribeToAgentEvents((event) => this.onStreamEvent(event))
    this.unsubscribeCliBridge = claudeCliDiscordBridge.subscribe((event) =>
      this.onStreamEvent(event)
    )
  }

  getEmissionMode(): DiscordEmissionMode {
    return this.emissionMode
  }

  setEmissionMode(mode: DiscordEmissionMode): void {
    this.emissionMode = mode
    try {
      this.getDb().setSetting(DISCORD_EMISSION_MODE_KEY, mode)
    } catch (error) {
      log.warn('Failed to persist Discord emission mode', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private loadEmissionMode(): void {
    try {
      const stored = this.getDb().getSetting(DISCORD_EMISSION_MODE_KEY)
      this.emissionMode = stored === 'qa' ? 'qa' : 'all'
    } catch (error) {
      this.emissionMode = 'all'
      log.warn('Failed to load Discord emission mode', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.unsubscribeCliBridge?.()
    this.unsubscribeCliBridge = null
    for (const runtime of this.runtimesBySessionId.values()) {
      this.stopTyping(runtime)
    }
    this.runtimesBySessionId.clear()
    this.discordPending.clear()
  }

  async handleUserMessage(input: DiscordUserMessageInput): Promise<void> {
    const { resource, session } = await this.resolveManagedSession(input)
    const runtime = this.registerRuntime(input, session, resource)
    const pendingPlan = this.getPendingPlanForRuntime(runtime)
    const followup = input.text.trim()

    if (pendingPlan && followup) {
      await this.sendPlanFeedback(pendingPlan, followup)
      return
    }

    if (runtime.busy) {
      runtime.queue.push(input.text)
      return
    }

    await this.dispatch(runtime, input.text)
  }

  async setWorktreeMode(
    input: { worktreeId: string; projectId: string; worktreePath: string },
    mode: SessionMode
  ): Promise<void> {
    const { session } = await this.resolveManagedSession(
      {
        channelId: '',
        worktreeId: input.worktreeId,
        projectId: input.projectId,
        worktreePath: input.worktreePath,
        text: '',
        channel: {
          send: async () => undefined,
          sendTyping: async () => undefined
        }
      },
      mode
    )

    this.getDb().updateSession(session.id, { mode })
    const runtime = this.runtimesBySessionId.get(session.id)
    if (runtime) {
      runtime.mode = mode
    }
    this.channelModeByWorktree.set(input.worktreeId, mode)
  }

  async clearManagedSession(input: { worktreeId: string; worktreePath: string }): Promise<void> {
    const db = this.getDb()
    const resource = db.getDiscordChannelResourceByWorktree(input.worktreeId)
    if (!resource?.managed_session_id) return

    const session = db.getSession(resource.managed_session_id)
    const runtime = session ? this.runtimesBySessionId.get(session.id) : undefined
    if (runtime) {
      this.stopTyping(runtime)
      this.runtimesBySessionId.delete(runtime.hiveSessionId)
    }
    this.clearPendingForSession(resource.managed_session_id, 'Session cleared')
    claudeCliDiscordBridge.cancelSession(resource.managed_session_id)

    if (session?.opencode_session_id) {
      try {
        await this.openCode.abort(input.worktreePath, session.opencode_session_id)
      } catch (error) {
        log.warn('Failed to abort cleared Discord managed session', {
          worktreeId: input.worktreeId,
          opencodeSessionId: session.opencode_session_id,
          error: error instanceof Error ? error.message : String(error)
        })
      }

      try {
        await this.openCode.disconnect(input.worktreePath, session.opencode_session_id)
      } catch (error) {
        log.warn('Failed to disconnect cleared Discord managed session', {
          worktreeId: input.worktreeId,
          opencodeSessionId: session.opencode_session_id,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }

    db.setDiscordResourceManagedSession(resource.id, null)
  }

  private async resolveManagedSession(
    input: DiscordUserMessageInput,
    createMode?: SessionMode
  ): Promise<{
    resource: DiscordResource
    session: Session
  }> {
    const db = this.getDb()
    const resource = db.getDiscordChannelResourceByWorktree(input.worktreeId)
    if (!resource) {
      throw new Error(`No Discord channel resource found for worktree ${input.worktreeId}`)
    }

    if (resource.managed_session_id) {
      const existing = db.getSession(resource.managed_session_id)
      if (existing?.opencode_session_id) {
        const runtime = this.runtimesBySessionId.get(existing.id)
        if (runtime) {
          runtime.model = this.getSessionModel(existing)
          return { resource, session: existing }
        }

        const reconnect = await this.openCode.reconnect(
          input.worktreePath,
          existing.opencode_session_id,
          existing.id
        )
        if (reconnect.success) {
          return { resource, session: existing }
        }
      }
    }

    const effectiveCreateMode =
      createMode ?? this.channelModeByWorktree.get(input.worktreeId) ?? 'build'
    const creation = this.resolveCreation(effectiveCreateMode)
    const session = db.createSession({
      worktree_id: input.worktreeId,
      project_id: input.projectId,
      agent_sdk: creation.agentSdk,
      mode: effectiveCreateMode,
      session_type: 'default',
      model_provider_id: creation.model.providerID,
      model_id: creation.model.modelID,
      model_variant: creation.model.variant ?? null
    })
    const connection = await this.openCode.connect(input.worktreePath, session.id)
    const updated = db.updateSession(session.id, { opencode_session_id: connection.sessionId }) ?? {
      ...session,
      opencode_session_id: connection.sessionId
    }
    db.setDiscordResourceManagedSession(resource.id, updated.id)
    return { resource: { ...resource, managed_session_id: updated.id }, session: updated }
  }

  private registerRuntime(
    input: DiscordUserMessageInput,
    session: Session,
    resource: DiscordResource
  ): ChannelRuntime {
    const existing = this.runtimesBySessionId.get(session.id)
    if (existing) {
      existing.channelId = input.channelId
      existing.channel = input.channel
      existing.worktreePath = input.worktreePath
      existing.opencodeSessionId = session.opencode_session_id ?? existing.opencodeSessionId
      existing.mode = session.mode
      existing.model = this.getSessionModel(session)
      existing.agentSdk = session.agent_sdk
      if (session.agent_sdk === 'claude-code-cli') {
        claudeCliDiscordBridge.register(session.id)
      }
      return existing
    }

    if (!session.opencode_session_id) {
      throw new Error(`Managed session ${session.id} does not have an OpenCode session id`)
    }

    const runtime: ChannelRuntime = {
      channelId: resource.discord_id || input.channelId,
      channel: input.channel,
      hiveSessionId: session.id,
      worktreePath: input.worktreePath,
      opencodeSessionId: session.opencode_session_id,
      model: this.getSessionModel(session),
      mode: session.mode,
      agentSdk: session.agent_sdk,
      busy: false,
      currentAssistantMessageId: null,
      textBuffer: '',
      pendingUserEchoText: null,
      postedToolIds: new Set(),
      typingInterval: null,
      queue: [],
      sendChain: Promise.resolve()
    }
    this.runtimesBySessionId.set(session.id, runtime)
    if (session.agent_sdk === 'claude-code-cli') {
      claudeCliDiscordBridge.register(session.id)
    }
    return runtime
  }

  private async dispatch(runtime: ChannelRuntime, text: string): Promise<void> {
    runtime.busy = true
    const prompt = applyModePrefix(text, runtime.mode)
    runtime.pendingUserEchoText = prompt
    this.startTyping(runtime)
    try {
      await this.openCode.prompt(
        runtime.worktreePath,
        runtime.opencodeSessionId,
        [{ type: 'text', text: prompt }],
        runtime.model
      )
    } catch (error) {
      runtime.queue.unshift(text)
      runtime.busy = false
      this.stopTyping(runtime)
      const message = error instanceof Error ? error.message : String(error)
      await this.postDiscordMessage(runtime, `Could not send prompt to session: ${message}`)
      log.error(
        'Failed to dispatch Discord prompt to OpenCode',
        error instanceof Error ? error : new Error(message),
        {
          channelId: runtime.channelId,
          hiveSessionId: runtime.hiveSessionId
        }
      )
    }
  }

  private onStreamEvent(event: OpenCodeStreamEvent): void {
    const runtime = this.runtimesBySessionId.get(event.sessionId)

    if (this.isInteractiveResolutionEvent(event.type)) {
      void this.resolveFromEvent(event)
      return
    }

    if (this.isInteractiveAskEvent(event.type)) {
      void this.forwardInteractiveEvent(event, runtime)
      return
    }

    if (!runtime) return

    this.publishEvent?.(OPENCODE_STREAM_CHANNEL, event)

    if (event.childSessionId) return

    if (event.type === 'message.part.updated') {
      this.handlePartUpdated(runtime, event)
      return
    }

    if (event.type === 'message.updated') {
      this.handleMessageUpdated(runtime, event)
      return
    }

    if (event.type === 'session.status') {
      if (event.statusPayload?.type === 'busy') {
        runtime.busy = true
        this.startTyping(runtime)
      } else if (event.statusPayload?.type === 'idle') {
        void this.handleIdle(runtime)
      }
      return
    }

    if (event.type === 'session.idle') {
      void this.handleIdle(runtime)
    }
  }

  private handleMessageUpdated(runtime: ChannelRuntime, event: OpenCodeStreamEvent): void {
    const data = asRecord(event.data)
    const role = asString(data?.role)
    if (role === 'user') return
    const content = asString(data?.content)
    if (!content) return
    runtime.textBuffer += this.consumePotentialUserEcho(runtime, content)
  }

  private handlePartUpdated(runtime: ChannelRuntime, event: OpenCodeStreamEvent): void {
    const data = asRecord(event.data)
    const role = asString(data?.role) ?? asString(asRecord(data?.message)?.role)
    if (role === 'user') return

    const part = asRecord(data?.part)
    if (!part) return

    if (part.type === 'text') {
      const text = asString(data?.delta) ?? asString(part.text) ?? ''
      const assistantText = this.consumePotentialUserEcho(runtime, text)
      if (!assistantText) return

      const messageId =
        asString(part.messageID) ??
        asString(part.messageId) ??
        asString(asRecord(data?.message)?.id) ??
        'assistant'
      if (runtime.currentAssistantMessageId && runtime.currentAssistantMessageId !== messageId) {
        void this.flushAssistantBuffer(runtime)
      }
      runtime.currentAssistantMessageId = messageId
      runtime.textBuffer += assistantText
      return
    }

    if (part.type !== 'tool') return

    const state = asRecord(part.state) ?? part
    const status = normalizeToolStatus(state.status)
    if (status !== 'success' && status !== 'error') return

    const toolId =
      asString(state.toolCallId) ??
      asString(part.callID) ??
      asString(part.id) ??
      asString(state.id) ??
      `${asString(part.tool) ?? 'tool'}-${runtime.postedToolIds.size}`
    if (runtime.postedToolIds.has(toolId)) return
    runtime.postedToolIds.add(toolId)

    if (this.emissionMode === 'qa') {
      // QA mode: drop the tool line and discard any buffered intermediate text so
      // only the final assistant message survives until idle.
      void this.flushAssistantBuffer(runtime)
      return
    }

    const toolLine = this.formatToolLine(part, state, status)
    void this.flushAssistantBuffer(runtime).then(() => this.postDiscordMessage(runtime, toolLine))
  }

  private formatToolLine(
    part: Record<string, unknown>,
    state: Record<string, unknown>,
    status: 'success' | 'error'
  ): string {
    const name = asString(part.tool) ?? asString(state.name) ?? 'Tool'
    const input = asRecord(state.input) ?? asRecord(part.input) ?? {}
    const label = getToolLabel(name, input)
    const prefix = status === 'error' ? '❌' : getDiscordToolEmoji(name)
    const displayName = displayToolName(name)
    if (label && displayName === 'Edited') return `${prefix} ${displayName} ${label}`
    return label ? `${prefix} ${displayName}: ${label}` : `${prefix} ${displayName}`
  }

  private consumePotentialUserEcho(runtime: ChannelRuntime, text: string): string {
    const pending = runtime.pendingUserEchoText
    if (!pending || !text) return text

    if (pending.startsWith(text)) {
      runtime.pendingUserEchoText = pending.slice(text.length) || null
      return ''
    }

    if (text.startsWith(pending)) {
      runtime.pendingUserEchoText = null
      return text.slice(pending.length)
    }

    if (pending.trim() === text.trim()) {
      runtime.pendingUserEchoText = null
      return ''
    }

    runtime.pendingUserEchoText = null
    return text
  }

  private async handleIdle(runtime: ChannelRuntime): Promise<void> {
    await this.flushAssistantBuffer(runtime, { final: true })
    runtime.pendingUserEchoText = null
    this.stopTyping(runtime)
    runtime.busy = false
    const next = runtime.queue.shift()
    if (next) {
      await this.dispatch(runtime, next)
    }
  }

  private async flushAssistantBuffer(
    runtime: ChannelRuntime,
    opts?: { final?: boolean }
  ): Promise<void> {
    const text = runtime.textBuffer.trim()
    runtime.textBuffer = ''
    runtime.currentAssistantMessageId = null
    if (!text) return
    // In QA mode, suppress intermediate flushes (message boundaries, pre-tool) and
    // only post the final message of a run. The buffer is still cleared above so
    // boundaries reset correctly and only the latest segment reaches idle.
    if (this.emissionMode === 'qa' && !opts?.final) return
    await this.postDiscordMessage(runtime, text)
  }

  private async postDiscordMessage(runtime: ChannelRuntime, text: string): Promise<void> {
    const chunks = splitDiscordMessage(text)
    runtime.sendChain = runtime.sendChain.then(async () => {
      for (const chunk of chunks) {
        await runtime.channel.send(chunk)
      }
    })
    return runtime.sendChain
  }

  async handleComponentInteraction(interaction: {
    isButton(): boolean
    isStringSelectMenu(): boolean
    customId: string
    values?: string[]
    message?: DiscordSentMessage
    deferUpdate?: () => Promise<unknown>
    reply?: (payload: { content: string; ephemeral?: boolean }) => Promise<unknown>
    showModal?: (payload: unknown) => Promise<unknown>
  }): Promise<boolean> {
    if (!interaction.isButton() && !interaction.isStringSelectMenu()) return false
    const parsed = this.parseCustomId(interaction.customId)
    if (!parsed) return false

    const pending = this.discordPending.get(parsed.requestId)
    if (!pending) {
      await this.replyEphemeral(interaction, 'Already handled')
      return true
    }

    if (interaction.isStringSelectMenu()) {
      if (pending.kind !== 'question' || parsed.action !== 'select') {
        await this.replyEphemeral(interaction, 'Already handled')
        return true
      }
      const questionIndex = parsed.questionIndex ?? 0
      const values = asStringArray(interaction.values)
      pending.partialAnswers ??= []
      pending.partialAnswers[questionIndex] = values.map(
        (value) => pending.optionValueLabels?.get(`${questionIndex}:${value}`) ?? value
      )
      await interaction.deferUpdate?.()
      return true
    }

    if (pending.kind === 'plan' && parsed.action === 'reject') {
      await interaction.showModal?.(this.buildPlanRejectModal(parsed.requestId))
      return true
    }

    try {
      if (pending.kind === 'question') {
        await this.handleQuestionButton(pending, parsed, interaction)
      } else if (pending.kind === 'permission') {
        await interaction.deferUpdate?.()
        const outcome = parsed.action === 'allow' ? 'Allowed always' : 'Denied'
        this.localResolutionOutcomes.set(pending.requestId, outcome)
        await this.replyRouter.replyPermission({
          requestId: pending.requestId,
          decision: parsed.action === 'allow' ? 'always' : 'reject',
          worktreePath: pending.worktreePath,
          agentSdk: pending.agentSdk,
          permissionRequest: pending.permissionRequest
        })
        await this.resolveDiscordMessage(pending.requestId, outcome)
      } else if (pending.kind === 'command') {
        await interaction.deferUpdate?.()
        const outcome = parsed.action === 'allow' ? 'Allowed always' : 'Denied'
        this.localResolutionOutcomes.set(pending.requestId, outcome)
        await this.replyRouter.replyCommandApproval({
          requestId: pending.requestId,
          approved: parsed.action === 'allow',
          patternSuggestions: pending.patternSuggestions
        })
        await this.resolveDiscordMessage(pending.requestId, outcome)
      } else if (pending.kind === 'plan' && parsed.action === 'approve') {
        await interaction.deferUpdate?.()
        this.localResolutionOutcomes.set(pending.requestId, 'Approved')
        await this.replyRouter.replyPlan({
          requestId: pending.requestId,
          sessionId: pending.sessionId,
          worktreePath: pending.worktreePath,
          approve: true
        })
        await this.resolveDiscordMessage(pending.requestId, 'Approved')
      } else if (
        pending.kind === 'plan' &&
        (parsed.action === 'handoff' || parsed.action === 'handoff_goal')
      ) {
        await interaction.deferUpdate?.()
        await this.handoffPlan(pending, parsed.action === 'handoff_goal')
      }
    } catch (error) {
      this.localResolutionOutcomes.delete(pending.requestId)
      await this.resolveDiscordMessage(
        pending.requestId,
        `Failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    return true
  }

  async handleModalSubmit(interaction: {
    isModalSubmit(): boolean
    customId: string
    fields?: { getTextInputValue?: (customId: string) => string }
    deferUpdate?: () => Promise<unknown>
    deferReply?: (payload?: { ephemeral?: boolean }) => Promise<unknown>
    editReply?: (content: string) => Promise<unknown>
    reply?: (payload: { content: string; ephemeral?: boolean }) => Promise<unknown>
  }): Promise<boolean> {
    if (!interaction.isModalSubmit()) return false
    const parsed = this.parseCustomId(interaction.customId)
    if (!parsed || parsed.kind !== 'plan' || parsed.action !== 'reject_modal') return false

    const pending = this.discordPending.get(parsed.requestId)
    if (!pending || pending.kind !== 'plan') {
      await this.replyEphemeral(interaction, 'Already handled')
      return true
    }

    await interaction.deferUpdate?.()
    const feedback = interaction.fields?.getTextInputValue?.('feedback')?.trim() ?? ''
    try {
      this.localResolutionOutcomes.set(pending.requestId, 'Rejected with feedback')
      await this.replyRouter.replyPlan({
        requestId: pending.requestId,
        sessionId: pending.sessionId,
        worktreePath: pending.worktreePath,
        approve: false,
        feedback
      })
      await this.resolveDiscordMessage(pending.requestId, 'Rejected with feedback')
    } catch (error) {
      this.localResolutionOutcomes.delete(pending.requestId)
      await this.resolveDiscordMessage(
        pending.requestId,
        `Failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    return true
  }

  private async handleQuestionButton(
    pending: DiscordPendingInteraction,
    parsed: ParsedCustomId,
    interaction: {
      deferUpdate?: () => Promise<unknown>
      reply?: (payload: { content: string; ephemeral?: boolean }) => Promise<unknown>
    }
  ): Promise<void> {
    if (parsed.action === 'cancel') {
      await interaction.deferUpdate?.()
      this.localResolutionOutcomes.set(pending.requestId, 'Cancelled')
      await this.replyRouter.rejectQuestion({
        requestId: pending.requestId,
        worktreePath: pending.worktreePath,
        agentSdk: pending.agentSdk
      })
      await this.resolveDiscordMessage(pending.requestId, 'Cancelled')
      return
    }
    if (parsed.action !== 'submit') return

    const answers = pending.partialAnswers ?? []
    const questions = pending.questions ?? []
    const missingIndex = questions.findIndex((_, index) => (answers[index] ?? []).length === 0)
    if (missingIndex >= 0) {
      await this.replyEphemeral(interaction, `Select an answer for question ${missingIndex + 1}`)
      return
    }

    const flatAnswers = answers.flat().join(', ')
    const outcome = flatAnswers ? `Answered: ${flatAnswers}` : 'Answered'
    this.localResolutionOutcomes.set(pending.requestId, outcome)
    await interaction.deferUpdate?.()
    await this.replyRouter.replyQuestion({
      requestId: pending.requestId,
      answers,
      worktreePath: pending.worktreePath,
      agentSdk: pending.agentSdk
    })
    await this.resolveDiscordMessage(pending.requestId, outcome)
  }

  private isInteractiveAskEvent(type: string): boolean {
    return (
      type === 'question.asked' ||
      type === 'permission.asked' ||
      type === 'command.approval_needed' ||
      type === 'plan.ready'
    )
  }

  private isInteractiveResolutionEvent(type: string): boolean {
    return (
      type === 'question.replied' ||
      type === 'question.rejected' ||
      type === 'permission.replied' ||
      type === 'command.approval_replied' ||
      type === 'plan.resolved'
    )
  }

  private async forwardInteractiveEvent(
    event: OpenCodeStreamEvent,
    runtime?: ChannelRuntime
  ): Promise<void> {
    const target = await this.resolveInteractiveTarget(event, runtime)
    if (!target) return

    if (event.type === 'question.asked') {
      await this.forwardQuestion(event, target)
    } else if (event.type === 'permission.asked') {
      await this.forwardPermission(event, target)
    } else if (event.type === 'command.approval_needed') {
      await this.forwardCommandApproval(event, target)
    } else if (event.type === 'plan.ready') {
      await this.forwardPlan(event, target)
    }
  }

  private async forwardQuestion(
    event: OpenCodeStreamEvent,
    target: InteractiveTarget
  ): Promise<void> {
    const data = asRecord(event.data)
    const requestId = this.requestIdFromData(data)
    if (!requestId || this.discordPending.has(requestId)) return

    const questions = this.parseQuestions(data?.questions)
    if (questions.length === 0) return

    const pending: DiscordPendingInteraction = {
      kind: 'question',
      requestId,
      channelId: target.channelId,
      sessionId: target.hiveSessionId,
      worktreePath: target.worktreePath,
      agentSdk: target.agentSdk,
      messages: [],
      questions,
      partialAnswers: [],
      optionValueLabels: new Map()
    }
    this.discordPending.set(requestId, pending)

    const chunks = this.chunkQuestions(questions)
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      const chunk = chunks[chunkIndex]
      const startIndex = chunkIndex * 4
      const isLast = chunkIndex === chunks.length - 1
      const content = this.formatQuestionContent(chunk, startIndex, questions.length)
      const components = this.buildQuestionComponents(requestId, chunk, startIndex, isLast, pending)
      const sent = await target.channel.send({ content, components })
      this.trackSentMessage(pending, sent, content)
    }
  }

  private async forwardPermission(
    event: OpenCodeStreamEvent,
    target: InteractiveTarget
  ): Promise<void> {
    const request = asRecord(event.data) as PermissionRequest
    const requestId = this.requestIdFromData(request)
    if (!requestId || this.discordPending.has(requestId)) return

    const content = [
      '**Permission requested**',
      request.permission ? `Type: ${request.permission}` : '',
      ...(Array.isArray(request.patterns)
        ? request.patterns.map((pattern) => `\`${pattern}\``)
        : [])
    ]
      .filter(Boolean)
      .join('\n')
    const pending: DiscordPendingInteraction = {
      kind: 'permission',
      requestId,
      channelId: target.channelId,
      sessionId: target.hiveSessionId,
      worktreePath: target.worktreePath,
      agentSdk: target.agentSdk,
      messages: [],
      permissionRequest: request
    }
    this.discordPending.set(requestId, pending)
    const sent = await target.channel.send({
      content,
      components: [this.buttonRow(requestId, 'permission', ['allow', 'deny'])]
    })
    this.trackSentMessage(pending, sent, content)
  }

  private async forwardCommandApproval(
    event: OpenCodeStreamEvent,
    target: InteractiveTarget
  ): Promise<void> {
    const data = asRecord(event.data)
    const requestId = this.requestIdFromData(data)
    if (!requestId || this.discordPending.has(requestId)) return
    const commandStr = asString(data?.commandStr) ?? asString(data?.toolName) ?? 'Command'
    const patternSuggestions = [
      ...asStringArray(data?.subCommandPatterns),
      ...asStringArray(data?.patternSuggestions)
    ]
    const content = [
      '**Command approval requested**',
      `\`${this.truncate(commandStr, 1500)}\``
    ].join('\n')
    const pending: DiscordPendingInteraction = {
      kind: 'command',
      requestId,
      channelId: target.channelId,
      sessionId: target.hiveSessionId,
      worktreePath: target.worktreePath,
      agentSdk: target.agentSdk,
      messages: [],
      patternSuggestions
    }
    this.discordPending.set(requestId, pending)
    const sent = await target.channel.send({
      content,
      components: [this.buttonRow(requestId, 'command', ['allow', 'deny'])]
    })
    this.trackSentMessage(pending, sent, content)
  }

  private async forwardPlan(event: OpenCodeStreamEvent, target: InteractiveTarget): Promise<void> {
    const data = asRecord(event.data)
    const requestId = this.requestIdFromData(data)
    if (!requestId || this.discordPending.has(requestId)) return
    const plan = asString(data?.plan) ?? ''
    const content = ['**Plan ready**', this.truncate(plan, 1800)].filter(Boolean).join('\n\n')
    const handoff = this.resolveCreation('build')
    const pending: DiscordPendingInteraction = {
      kind: 'plan',
      requestId,
      channelId: target.channelId,
      sessionId: target.hiveSessionId,
      worktreePath: target.worktreePath,
      agentSdk: target.agentSdk,
      messages: [],
      plan,
      handoffAgentSdk: handoff.agentSdk,
      handoffModel: handoff.model
    }
    this.discordPending.set(requestId, pending)
    const sent = await target.channel.send({
      content,
      components: this.buildPlanComponents(requestId, handoff.agentSdk === 'codex')
    })
    this.trackSentMessage(pending, sent, content)
  }

  private async sendPlanFeedback(
    pending: DiscordPendingInteraction,
    feedback: string
  ): Promise<void> {
    this.localResolutionOutcomes.set(pending.requestId, 'Feedback sent')
    try {
      await this.replyRouter.replyPlan({
        requestId: pending.requestId,
        sessionId: pending.sessionId,
        worktreePath: pending.worktreePath,
        approve: false,
        feedback
      })
      await this.resolveDiscordMessage(pending.requestId, 'Feedback sent')
    } catch (error) {
      this.localResolutionOutcomes.delete(pending.requestId)
      await this.resolveDiscordMessage(
        pending.requestId,
        `Failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  private async handoffPlan(pending: DiscordPendingInteraction, goalMode: boolean): Promise<void> {
    const feedback = 'Plan handed off to a new session'
    this.localResolutionOutcomes.set(pending.requestId, 'Handoff started')
    await this.replyRouter.replyPlan({
      requestId: pending.requestId,
      sessionId: pending.sessionId,
      worktreePath: pending.worktreePath,
      approve: false,
      feedback
    })

    const oldRuntime = this.runtimesBySessionId.get(pending.sessionId)
    if (oldRuntime) {
      this.stopTyping(oldRuntime)
      this.runtimesBySessionId.delete(pending.sessionId)
    }

    const db = this.getDb()
    const sourceSession = db.getSession(pending.sessionId)
    if (!sourceSession?.worktree_id) {
      throw new Error('Plan session is not attached to a worktree')
    }

    const resource = db.getDiscordChannelResourceByWorktree(sourceSession.worktree_id)
    if (!resource) {
      throw new Error('Discord channel is no longer linked to this worktree')
    }

    const worktreePath = pending.worktreePath
    if (!worktreePath) {
      throw new Error('Missing worktree path for handoff')
    }

    const channel = oldRuntime?.channel ?? (await this.resolveChannel?.(pending.channelId))
    if (!channel) {
      throw new Error('Discord channel is unavailable')
    }

    const selection = pending.handoffModel
      ? { agentSdk: pending.handoffAgentSdk ?? 'opencode', model: pending.handoffModel }
      : this.resolveCreation('build')
    const newSession = db.createSession({
      worktree_id: sourceSession.worktree_id,
      project_id: sourceSession.project_id ?? resource.project_id,
      agent_sdk: selection.agentSdk,
      mode: 'build',
      session_type: 'default',
      model_provider_id: selection.model.providerID,
      model_id: selection.model.modelID,
      model_variant: selection.model.variant ?? null
    })
    const connection = await this.openCode.connect(worktreePath, newSession.id)
    const updated = db.updateSession(newSession.id, {
      opencode_session_id: connection.sessionId
    }) ?? {
      ...newSession,
      opencode_session_id: connection.sessionId
    }
    db.setDiscordResourceManagedSession(resource.id, updated.id)

    const runtime = this.registerRuntime(
      {
        channelId: pending.channelId,
        worktreeId: sourceSession.worktree_id,
        projectId: sourceSession.project_id ?? resource.project_id,
        worktreePath,
        text: '',
        channel
      },
      updated,
      { ...resource, managed_session_id: updated.id }
    )
    await this.dispatch(runtime, this.buildHandoffPrompt(pending.plan ?? '', goalMode))
    await this.resolveDiscordMessage(pending.requestId, 'Handoff started')
  }

  private async resolveFromEvent(event: OpenCodeStreamEvent): Promise<void> {
    const data = asRecord(event.data)
    const requestId = this.requestIdFromData(data)
    const pending = requestId
      ? this.discordPending.get(requestId)
      : [...this.discordPending.values()].find(
          (candidate) => candidate.sessionId === event.sessionId && candidate.kind === 'plan'
        )
    if (!pending) return
    const outcome = this.localResolutionOutcomes.get(pending.requestId) ?? 'Resolved in Hive'
    await this.resolveDiscordMessage(pending.requestId, outcome)
  }

  private async resolveDiscordMessage(requestId: string, outcome: string): Promise<void> {
    const pending = this.discordPending.get(requestId)
    if (!pending) return
    this.discordPending.delete(requestId)
    this.localResolutionOutcomes.delete(requestId)
    for (const item of pending.messages) {
      await Promise.resolve(
        item.message.edit({
          content: `${item.originalContent}\n\n${outcome}`,
          components: []
        })
      ).catch((error) => {
        log.warn('Failed to edit resolved Discord interaction message', {
          requestId,
          messageId: item.id,
          error: error instanceof Error ? error.message : String(error)
        })
      })
    }
  }

  private async resolveInteractiveTarget(
    event: OpenCodeStreamEvent,
    runtime?: ChannelRuntime
  ): Promise<InteractiveTarget | null> {
    if (runtime) {
      return {
        channelId: runtime.channelId,
        channel: runtime.channel,
        hiveSessionId: runtime.hiveSessionId,
        worktreePath: runtime.worktreePath,
        agentSdk: runtime.agentSdk
      }
    }

    const session = this.getDb().getSession(event.sessionId)
    if (!session?.worktree_id) return null
    const resource = this.getDb().getDiscordChannelResourceByWorktree(session.worktree_id)
    if (!resource || resource.managed_session_id !== session.id) return null
    const channel = await this.resolveChannel?.(resource.discord_id)
    if (!channel) return null
    const worktree = this.getDb().getWorktree?.(session.worktree_id)
    return {
      channelId: resource.discord_id,
      channel,
      hiveSessionId: session.id,
      worktreePath: worktree?.path,
      agentSdk: session.agent_sdk
    }
  }

  private requestIdFromData(data: Record<string, unknown> | null): string | null {
    return (
      asString(data?.requestId) ??
      asString(data?.id) ??
      asString(asRecord(data?.properties)?.requestId) ??
      null
    )
  }

  private parseQuestions(value: unknown): PendingQuestion[] {
    if (!Array.isArray(value)) return []
    return value
      .map((raw): PendingQuestion | null => {
        const question = asRecord(raw)
        const text = asString(question?.question)
        if (!text) return null
        const rawOptions = Array.isArray(question?.options) ? question.options : []
        const options = rawOptions
          .slice(0, 25)
          .map((option): { label: string; description?: string } | null => {
            const record = asRecord(option)
            const label = asString(record?.label) ?? (typeof option === 'string' ? option : null)
            if (!label) return null
            const description = asString(record?.description)
            return { label, ...(description ? { description } : {}) }
          })
          .filter((option): option is { label: string; description?: string } => !!option)
        return {
          header: asString(question?.header) ?? undefined,
          question: text,
          options,
          multiple: question?.multiple === true || question?.multiSelect === true
        }
      })
      .filter((question): question is PendingQuestion => !!question)
  }

  private chunkQuestions(questions: PendingQuestion[]): PendingQuestion[][] {
    const chunks: PendingQuestion[][] = []
    for (let index = 0; index < questions.length; index += 4) {
      chunks.push(questions.slice(index, index + 4))
    }
    return chunks
  }

  private formatQuestionContent(
    questions: PendingQuestion[],
    startIndex: number,
    total: number
  ): string {
    return questions
      .map((question, offset) => {
        const index = startIndex + offset + 1
        const title =
          total > 1 ? `${question.header ?? 'Question'} (${index}/${total})` : question.header
        return [title, question.question].filter(Boolean).join('\n')
      })
      .join('\n\n')
  }

  private buildQuestionComponents(
    requestId: string,
    questions: PendingQuestion[],
    startIndex: number,
    includeSubmit: boolean,
    pending: DiscordPendingInteraction
  ): unknown[] {
    const rows = questions.map((question, offset) => {
      const questionIndex = startIndex + offset
      const maxValues = question.multiple ? Math.max(1, question.options.length) : 1
      return {
        type: 1,
        components: [
          {
            type: 3,
            custom_id: this.buildCustomId('question', requestId, 'select', questionIndex),
            placeholder: this.truncate(question.header ?? question.question, 100),
            min_values: 1,
            max_values: maxValues,
            options: question.options.map((option, optionIndex) => {
              const value = String(optionIndex)
              pending.optionValueLabels?.set(`${questionIndex}:${value}`, option.label)
              return {
                label: this.truncate(option.label, 100),
                value,
                ...(option.description
                  ? { description: this.truncate(option.description, 100) }
                  : {})
              }
            })
          }
        ]
      }
    })

    if (includeSubmit) {
      rows.push({
        type: 1,
        components: [
          this.button('Submit', this.buildCustomId('question', requestId, 'submit'), 3),
          this.button('Cancel', this.buildCustomId('question', requestId, 'cancel'), 4)
        ]
      })
    }
    return rows
  }

  private buttonRow(
    requestId: string,
    kind: DiscordPendingKind,
    actions: Array<'allow' | 'deny' | 'approve' | 'reject'>
  ): unknown {
    return {
      type: 1,
      components: actions.map((action) => {
        const label =
          action === 'allow'
            ? 'Allow'
            : action === 'deny'
              ? 'Deny'
              : action === 'approve'
                ? 'Approve'
                : 'Reject'
        const style = action === 'allow' || action === 'approve' ? 3 : 4
        return this.button(label, this.buildCustomId(kind, requestId, action), style)
      })
    }
  }

  private button(label: string, customId: string, style: number): unknown {
    return { type: 2, label, custom_id: customId, style }
  }

  private buildPlanComponents(requestId: string, includeGoalHandoff: boolean): unknown[] {
    return [
      {
        type: 1,
        components: [
          this.button('Implement', this.buildCustomId('plan', requestId, 'approve'), 3),
          this.button('Handoff', this.buildCustomId('plan', requestId, 'handoff'), 2),
          ...(includeGoalHandoff
            ? [
                this.button(
                  'Handoff (goal)',
                  this.buildCustomId('plan', requestId, 'handoff_goal'),
                  1
                )
              ]
            : []),
          this.button('Reject', this.buildCustomId('plan', requestId, 'reject'), 4)
        ]
      }
    ]
  }

  private buildHandoffPrompt(plan: string, goalMode: boolean): string {
    const prefix = goalMode ? '/goal ' : ''
    return `${prefix}Implement the following plan\n${plan}`
  }

  private buildPlanRejectModal(requestId: string): unknown {
    return {
      title: 'Reject plan',
      custom_id: this.buildCustomId('plan', requestId, 'reject_modal'),
      components: [
        {
          type: 1,
          components: [
            {
              type: 4,
              custom_id: 'feedback',
              label: 'Feedback',
              style: 2,
              required: true,
              max_length: 1800
            }
          ]
        }
      ]
    }
  }

  private buildCustomId(
    kind: DiscordPendingKind,
    requestId: string,
    action: string,
    questionIndex?: number
  ): string {
    const suffix = questionIndex === undefined ? '' : `:${questionIndex}`
    const direct = `${kind}:${requestId}:${action}${suffix}`
    if (direct.length <= 100) return direct

    let token = this.requestTokens.get(requestId)
    if (!token) {
      token = `t${this.requestTokens.size + 1}`
      this.requestTokens.set(requestId, token)
      this.tokenRequestIds.set(token, requestId)
    }
    return `${kind}:${token}:${action}${suffix}`
  }

  private parseCustomId(customId: string): ParsedCustomId | null {
    const parts = customId.split(':')
    if (parts.length < 3) return null
    const kind = parts[0] as DiscordPendingKind
    if (!['question', 'permission', 'command', 'plan'].includes(kind)) return null
    const requestId = this.tokenRequestIds.get(parts[1]) ?? parts[1]
    const questionIndex =
      parts[3] === undefined || Number.isNaN(Number(parts[3])) ? undefined : Number(parts[3])
    return { kind, requestId, action: parts[2], questionIndex }
  }

  private trackSentMessage(
    pending: DiscordPendingInteraction,
    sent: unknown,
    originalContent: string
  ): void {
    const message = sent as DiscordSentMessage
    if (!message || typeof message.id !== 'string' || typeof message.edit !== 'function') return
    pending.messages.push({ id: message.id, message, originalContent })
  }

  private clearPendingForSession(sessionId: string | null | undefined, outcome: string): void {
    if (!sessionId) return
    const requestIds = [...this.discordPending.values()]
      .filter((pending) => pending.sessionId === sessionId)
      .map((pending) => pending.requestId)
    for (const requestId of requestIds) {
      void this.resolveDiscordMessage(requestId, outcome)
    }
  }

  private getPendingPlanForRuntime(runtime: ChannelRuntime): DiscordPendingInteraction | null {
    return (
      [...this.discordPending.values()].find(
        (pending) =>
          pending.kind === 'plan' &&
          (pending.sessionId === runtime.hiveSessionId || pending.channelId === runtime.channelId)
      ) ?? null
    )
  }

  private async replyEphemeral(
    interaction: {
      reply?: (payload: { content: string; ephemeral?: boolean }) => Promise<unknown>
      deferUpdate?: () => Promise<unknown>
    },
    content: string
  ): Promise<void> {
    if (interaction.reply) {
      await interaction.reply({ content, ephemeral: true }).catch(() => undefined)
      return
    }
    await interaction.deferUpdate?.().catch(() => undefined)
  }

  private truncate(value: string, max: number): string {
    if (value.length <= max) return value
    return `${value.slice(0, Math.max(0, max - 1))}…`
  }

  private startTyping(runtime: ChannelRuntime): void {
    if (runtime.typingInterval) return
    void Promise.resolve(runtime.channel.sendTyping()).catch(() => undefined)
    runtime.typingInterval = setInterval(() => {
      void Promise.resolve(runtime.channel.sendTyping()).catch(() => undefined)
    }, this.typingIntervalMs)
  }

  private stopTyping(runtime: ChannelRuntime): void {
    if (!runtime.typingInterval) return
    clearInterval(runtime.typingInterval)
    runtime.typingInterval = null
  }

  private getSessionModel(session: Session): SharedSelectedModel {
    if (session.model_provider_id && session.model_id) {
      return {
        providerID: session.model_provider_id,
        modelID: session.model_id,
        ...(session.model_variant ? { variant: session.model_variant } : {})
      }
    }
    return this.resolveCreation(session.mode).model
  }

  private resolveCreation(mode: SessionMode): { agentSdk: AgentSdk; model: SharedSelectedModel } {
    const resolved = resolveSessionCreation({
      settings: this.readModelSettings(),
      mode
    })
    if (resolved.agentSdk === 'opencode' || !this.sdkManager) return resolved

    try {
      this.sdkManager.getImplementer(getImplementerSdk(resolved.agentSdk))
      return resolved
    } catch (error) {
      log.warn('Falling back to OpenCode for unregistered Discord agent SDK', {
        requestedSdk: resolved.agentSdk,
        error: error instanceof Error ? error.message : String(error)
      })
      return { agentSdk: 'opencode', model: resolved.model }
    }
  }

  private readModelSettings(): ModelResolutionSettings {
    try {
      const value = this.getDb().getSetting(APP_SETTINGS_DB_KEY)
      if (!value) return {}
      const parsed = asRecord(JSON.parse(value))
      if (!parsed) return {}

      const selectedModel = this.parseSelectedModel(parsed.selectedModel)
      const selectedModelByProvider = this.parseModelMap(parsed.selectedModelByProvider)
      const defaultModels = this.parseModelMap(parsed.defaultModels)
      return {
        ...(typeof parsed.defaultAgentSdk === 'string'
          ? { defaultAgentSdk: normalizeAgentSdk(parsed.defaultAgentSdk) }
          : {}),
        ...(selectedModel ? { selectedModel } : {}),
        ...(selectedModelByProvider ? { selectedModelByProvider } : {}),
        ...(defaultModels ? { defaultModels } : {})
      }
    } catch (error) {
      log.warn('Failed to load model settings for Discord session', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
    return {}
  }

  private parseModelMap(value: unknown): Record<string, SharedSelectedModel> | null {
    const record = asRecord(value)
    if (!record) return null

    const parsed: Record<string, SharedSelectedModel> = {}
    for (const [key, rawModel] of Object.entries(record)) {
      const model = this.parseSelectedModel(rawModel)
      if (model) {
        parsed[key] = model
      }
    }
    return parsed
  }

  private parseSelectedModel(value: unknown): SharedSelectedModel | null {
    const record = asRecord(value)
    const providerID = asString(record?.providerID)
    const modelID = asString(record?.modelID)
    if (!providerID || !modelID) return null
    const variant = asString(record?.variant)
    const agentSdk = asString(record?.agentSdk)
    return {
      providerID,
      modelID,
      ...(variant ? { variant } : {}),
      ...(agentSdk ? { agentSdk } : {})
    }
  }

  private getDb(): DatabaseService {
    if (!this.db) {
      this.db = getDatabase()
    }
    return this.db
  }
}

export const discordSessionBridge = new DiscordSessionBridge()

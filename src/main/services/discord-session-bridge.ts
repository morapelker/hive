import type { OpenCodeStreamEvent } from '@shared/types/opencode'
import { OPENCODE_STREAM_CHANNEL } from '@shared/opencode-events'
import { applyModePrefix } from '@shared/agent-mode-prefixes'
import {
  getDiscordToolEmoji,
  getToolLabel,
  isFileChangeTool
} from '@shared/tool-label'
import type { DatabaseService } from '../db/database'
import { getDatabase } from '../db'
import type { DiscordResource, Session, SessionMode } from '../db/types'
import { agentEventBus } from './agent-event-bus'
import { createLogger } from './logger'
import { openCodeService } from './opencode-service'

const log = createLogger({ component: 'DiscordSessionBridge' })

const SELECTED_MODEL_DB_KEY = 'selected_model'
const DEFAULT_MODEL = {
  providerID: 'anthropic',
  modelID: 'claude-opus-4-5-20251101'
}

type PromptPart = { type: 'text'; text: string }
type BackendEventPublisher = (channel: string, payload: unknown) => void

interface DiscordTextChannel {
  send(content: string): Promise<unknown> | unknown
  sendTyping(): Promise<unknown> | unknown
}

interface OpenCodeBridgeService {
  connect(worktreePath: string, hiveSessionId: string): Promise<{ sessionId: string }>
  reconnect(
    worktreePath: string,
    opencodeSessionId: string,
    hiveSessionId: string
  ): Promise<{ success: boolean; sessionStatus?: 'idle' | 'busy' | 'retry' }>
  prompt(worktreePath: string, opencodeSessionId: string, parts: PromptPart[]): Promise<void>
}

interface ChannelRuntime {
  channelId: string
  channel: DiscordTextChannel
  hiveSessionId: string
  worktreePath: string
  opencodeSessionId: string
  mode: SessionMode
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function normalizeToolStatus(status: unknown): 'running' | 'success' | 'error' {
  if (status === 'error') return 'error'
  if (status === 'success' || status === 'completed') return 'success'
  return 'running'
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
  private readonly subscribeToAgentEvents: (listener: (event: OpenCodeStreamEvent) => void) => () => void
  private readonly typingIntervalMs: number
  private publishEvent: BackendEventPublisher | null
  private unsubscribe: (() => void) | null = null
  private runtimesBySessionId = new Map<string, ChannelRuntime>()

  constructor(dependencies: DiscordSessionBridgeDependencies = {}) {
    this.db = dependencies.db ?? null
    this.openCode = dependencies.openCodeService ?? openCodeService
    this.subscribeToAgentEvents =
      dependencies.subscribeToAgentEvents ?? ((listener) => agentEventBus.subscribe(listener))
    this.typingIntervalMs = dependencies.typingIntervalMs ?? 8000
    this.publishEvent = dependencies.publishEvent ?? null
  }

  setBackendEventPublisher(publishEvent: BackendEventPublisher | null): void {
    this.publishEvent = publishEvent
  }

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.subscribeToAgentEvents((event) => this.onStreamEvent(event))
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    for (const runtime of this.runtimesBySessionId.values()) {
      this.stopTyping(runtime)
    }
    this.runtimesBySessionId.clear()
  }

  async handleUserMessage(input: DiscordUserMessageInput): Promise<void> {
    const { resource, session } = await this.resolveManagedSession(input)
    const runtime = this.registerRuntime(input, session, resource)

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
    const { session } = await this.resolveManagedSession({
      channelId: '',
      worktreeId: input.worktreeId,
      projectId: input.projectId,
      worktreePath: input.worktreePath,
      text: '',
      channel: {
        send: async () => undefined,
        sendTyping: async () => undefined
      }
    })

    this.getDb().updateSession(session.id, { mode })
    const runtime = this.runtimesBySessionId.get(session.id)
    if (runtime) {
      runtime.mode = mode
    }
  }

  private async resolveManagedSession(input: DiscordUserMessageInput): Promise<{
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

    const selectedModel = this.getSelectedModel()
    const session = db.createSession({
      worktree_id: input.worktreeId,
      project_id: input.projectId,
      agent_sdk: 'opencode',
      mode: 'build',
      session_type: 'default',
      model_provider_id: selectedModel.providerID,
      model_id: selectedModel.modelID,
      model_variant: selectedModel.variant ?? null
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
      mode: session.mode,
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
    return runtime
  }

  private async dispatch(runtime: ChannelRuntime, text: string): Promise<void> {
    runtime.busy = true
    const prompt = applyModePrefix(text, runtime.mode)
    runtime.pendingUserEchoText = prompt
    this.startTyping(runtime)
    try {
      await this.openCode.prompt(runtime.worktreePath, runtime.opencodeSessionId, [
        { type: 'text', text: prompt }
      ])
    } catch (error) {
      runtime.queue.unshift(text)
      runtime.busy = false
      this.stopTyping(runtime)
      const message = error instanceof Error ? error.message : String(error)
      await this.postDiscordMessage(runtime, `Could not send prompt to session: ${message}`)
      log.error('Failed to dispatch Discord prompt to OpenCode', error instanceof Error ? error : new Error(message), {
        channelId: runtime.channelId,
        hiveSessionId: runtime.hiveSessionId
      })
    }
  }

  private onStreamEvent(event: OpenCodeStreamEvent): void {
    const runtime = this.runtimesBySessionId.get(event.sessionId)
    if (!runtime) return

    this.publishEvent?.(OPENCODE_STREAM_CHANNEL, event)

    if (event.childSessionId) return

    if (event.type === 'message.part.updated') {
      this.handlePartUpdated(runtime, event)
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
    await this.flushAssistantBuffer(runtime)
    runtime.pendingUserEchoText = null
    this.stopTyping(runtime)
    runtime.busy = false
    const next = runtime.queue.shift()
    if (next) {
      await this.dispatch(runtime, next)
    }
  }

  private async flushAssistantBuffer(runtime: ChannelRuntime): Promise<void> {
    const text = runtime.textBuffer.trim()
    runtime.textBuffer = ''
    runtime.currentAssistantMessageId = null
    if (!text) return
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

  private getSelectedModel(): { providerID: string; modelID: string; variant?: string } {
    try {
      const value = this.getDb().getSetting(SELECTED_MODEL_DB_KEY)
      if (value) {
        const parsed = JSON.parse(value) as {
          providerID?: unknown
          modelID?: unknown
          variant?: unknown
        }
        if (typeof parsed.providerID === 'string' && typeof parsed.modelID === 'string') {
          return {
            providerID: parsed.providerID,
            modelID: parsed.modelID,
            ...(typeof parsed.variant === 'string' ? { variant: parsed.variant } : {})
          }
        }
      }
    } catch (error) {
      log.warn('Failed to load selected model for Discord session', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
    return DEFAULT_MODEL
  }

  private getDb(): DatabaseService {
    if (!this.db) {
      this.db = getDatabase()
    }
    return this.db
  }
}

export const discordSessionBridge = new DiscordSessionBridge()

import type { OpenCodeStreamEvent } from '@shared/types/opencode'
import type {
  TelegramConfig,
  TelegramDiscoveredChat,
  TelegramForwardingStatus,
  TelegramMode
} from '@shared/types/telegram'
import {
  TELEGRAM_PLAN_IMPLEMENT_REQUESTED_CHANNEL,
  TELEGRAM_STATUS_CHANGED_CHANNEL,
  type TelegramPlanImplementRequestedPayload
} from '@shared/telegram-events'
import { isClaudeCli } from '@shared/types/agent-sdk'
import { openCodeService } from './opencode-service'
import { ClaudeCodeImplementer } from './claude-code-implementer'
import { CodexImplementer } from './codex-implementer'
import type { AgentSdkManager } from './agent-sdk-manager'
import type { DatabaseService } from '../db/database'
import { agentEventBus } from './agent-event-bus'
import { claudeCliTelegramBridge } from './claude-cli-telegram-bridge'
import { writeClaudeCliPrompt } from './claude-cli-pty-prompt'

const TELEGRAM_CONFIG_KEY = 'telegram_config'
const MAX_TELEGRAM_TEXT = 4096
const ASSISTANT_FLUSH_INTERVAL_MS = 2000
const LONG_PLAN_THRESHOLD = 3500

type CallbackKind = 'question' | 'permission' | 'command' | 'plan'
type TrackedKind = 'question' | 'permission' | 'command' | 'plan'
type BackendEventPublisher = (channel: string, payload: unknown) => void

interface ForwardingState {
  sessionId: string
  worktreeId: string | null
  connectionId: string | null
  mode: TelegramMode
  contextSize: number
  recentAssistantTurns: string[]
  assistantBuffer: string
  assistantFlushTimer: NodeJS.Timeout | null
  currentTurnText: string
  pendingQueuedPrompt: string | null
  lastUpdateId: number
  startedAtSeconds: number
  isBusy: boolean
  previousWasAssistantText: boolean
  hasOutstandingInteraction: boolean
  pollAbort: AbortController | null
  firstFailureSurfaced: boolean
}

interface TrackedInteraction {
  kind: TrackedKind
  requestId: string
  messageId: number
  questionIndex?: number
  worktreePath?: string
  plan?: string
  promptTitle: string
  patternSuggestions?: string[]
  options?: string[]
}

interface TelegramQuestion {
  header: string
  question: string
  options: string[]
}

interface QuestionBatch {
  total: number
  answers: string[][]
  worktreePath?: string
  questions: TelegramQuestion[]
  currentIndex: number
  contextMessageId?: number
}

interface TelegramApiResponse<T> {
  ok: boolean
  result?: T
  description?: string
  error_code?: number
  parameters?: { retry_after?: number }
}

interface TelegramMessage {
  message_id: number
  date?: number
  text?: string
  chat: {
    id: number
    type: 'private' | 'group' | 'supergroup'
    first_name?: string
    title?: string
    username?: string
  }
  reply_to_message?: TelegramMessage
}

interface TelegramCallbackQuery {
  id: string
  data?: string
  message?: TelegramMessage
}

interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  callback_query?: TelegramCallbackQuery
}

interface InlineKeyboardButton {
  text: string
  callback_data: string
}

interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function requestIdFromData(data: unknown): string | null {
  const record = asRecord(data)
  return (
    asString(record?.requestId) ??
    asString(record?.id) ??
    asString(asRecord(record?.properties)?.requestId) ??
    null
  )
}

function stripControlChars(text: string): string {
  return Array.from(text)
    .filter((char) => {
      const code = char.charCodeAt(0)
      return code === 0x09 || code === 0x0a || code === 0x0d || (code >= 0x20 && code !== 0x7f)
    })
    .join('')
}

export function formatTelegramText(text: string, limit = MAX_TELEGRAM_TEXT): string {
  const clean = stripControlChars(text).trim()
  if (clean.length <= limit) return clean
  return `${clean.slice(0, Math.max(0, limit - 3)).trimEnd()}...`
}

export function extractAssistantText(event: OpenCodeStreamEvent): string | null {
  const data = asRecord(event.data)
  if (!data) return null

  const role = asString(data.role) ?? asString(asRecord(data.info)?.role)
  if (role && role !== 'assistant') return null

  const part = asRecord(data.part)
  if (part) {
    if (part.type !== 'text') return null
    const text = asString(part.text) ?? asString(data.delta)
    return text && text.trim().length > 0 ? text : null
  }

  const content = data.content
  if (typeof content === 'string' && content.trim().length > 0) return content
  if (Array.isArray(content)) {
    const text = content
      .map((item) => {
        const itemRecord = asRecord(item)
        return itemRecord?.type === 'text' ? asString(itemRecord.text) : null
      })
      .filter((item): item is string => !!item)
      .join('\n')
    return text.trim().length > 0 ? text : null
  }

  return null
}

export function buildTelegramCallbackData(
  kind: CallbackKind,
  requestId: string,
  action: string
): string {
  const prefix =
    kind === 'question' ? 'q' : kind === 'permission' ? 'p' : kind === 'command' ? 'c' : 'pl'
  const data = `${prefix}:${requestId}:${action}`
  if (data.length > 64) {
    return `${prefix}:${requestId.slice(0, 64 - prefix.length - action.length - 2)}:${action}`
  }
  return data
}

export function isTrackedInteractionStale(
  tracked: Map<string, unknown>,
  requestId: string
): boolean {
  return !tracked.has(requestId)
}

export class TelegramForwardingService {
  private db: DatabaseService | null = null
  private sdkManager: AgentSdkManager | null = null
  private state: ForwardingState | null = null
  private messageIndex = new Map<string, TrackedInteraction>()
  private questionBatches = new Map<string, QuestionBatch>()
  private callbackRequestIds = new Map<string, string>()
  private unsubscribeBus: (() => void) | null = null
  private backendEventPublisher: BackendEventPublisher | null = null
  private unsubscribeBridge: (() => void) | null = null

  initialize(opts: { db: DatabaseService; sdkManager: AgentSdkManager }): void {
    this.db = opts.db
    this.sdkManager = opts.sdkManager
    if (!this.unsubscribeBus) {
      this.unsubscribeBus = agentEventBus.subscribe((event) => {
        void this.handleAgentEvent(event)
      })
    }
    // Claude CLI hook events arrive on the bridge's private channel (not the
    // renderer-visible agentEventBus), routed through the same handler.
    if (!this.unsubscribeBridge) {
      this.unsubscribeBridge = claudeCliTelegramBridge.subscribe((event) => {
        void this.handleAgentEvent(event)
      })
    }
  }

  setBackendEventPublisher(publisher: BackendEventPublisher | null): void {
    this.backendEventPublisher = publisher
  }

  dispose(): void {
    this.stopPolling()
    this.cancelAssistantFlush()
    this.unsubscribeBus?.()
    this.unsubscribeBus = null
    this.unsubscribeBridge?.()
    this.unsubscribeBridge = null
  }

  getConfig(): TelegramConfig | null {
    const raw = this.db?.getSetting(TELEGRAM_CONFIG_KEY)
    if (!raw) return null
    try {
      return this.normalizeConfig(JSON.parse(raw))
    } catch {
      return null
    }
  }

  setConfig(config: TelegramConfig | null): void {
    if (!this.db) throw new Error('Telegram service not initialized')
    if (!config) {
      this.db.deleteSetting(TELEGRAM_CONFIG_KEY)
      return
    }
    this.db.setSetting(TELEGRAM_CONFIG_KEY, JSON.stringify(this.normalizeConfig(config)))
  }

  getStatus(): TelegramForwardingStatus {
    return {
      active: !!this.state,
      sessionId: this.state?.sessionId ?? null,
      worktreeId: this.state?.worktreeId ?? null,
      connectionId: this.state?.connectionId ?? null,
      mode: this.state?.mode ?? null,
      health: this.state?.firstFailureSurfaced ? 'error' : 'ok',
      lastError: this.state?.firstFailureSurfaced ? 'Telegram delivery failed' : null
    }
  }

  async verifyToken(
    botToken: string
  ): Promise<{ ok: boolean; botUsername?: string; error?: string }> {
    try {
      const result = await this.api<{ username?: string; first_name?: string }>(botToken, 'getMe')
      return { ok: true, botUsername: result.username ?? result.first_name }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async discoverChats(config?: TelegramConfig | null): Promise<TelegramDiscoveredChat[]> {
    const cfg = config ?? this.getConfig()
    if (!cfg?.botToken) return []
    const updates = await this.api<TelegramUpdate[]>(cfg.botToken, 'getUpdates', { timeout: 0 })
    const chats = new Map<number, TelegramDiscoveredChat>()
    for (const update of updates) {
      const chat = update.message?.chat ?? update.callback_query?.message?.chat
      if (!chat || !['private', 'group', 'supergroup'].includes(chat.type)) continue
      chats.set(chat.id, {
        chatId: chat.id,
        firstName: chat.first_name ?? chat.title ?? chat.username ?? String(chat.id),
        type: chat.type
      })
    }
    return Array.from(chats.values())
  }

  async sendTestMessage(): Promise<{ ok: boolean; error?: string }> {
    const cfg = this.getConfig()
    if (!cfg?.botToken || !cfg.chatId) return { ok: false, error: 'Telegram is not configured' }
    try {
      await this.sendMessage(cfg, 'Hive connected ✅')
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async startForwarding(params: {
    sessionId: string
    worktreeId: string | null
    connectionId: string | null
    mode: TelegramMode
  }): Promise<TelegramForwardingStatus> {
    const cfg = this.getConfig()
    if (!cfg?.botToken || !cfg.chatId) {
      throw new Error('Telegram is not configured')
    }
    if (!!params.worktreeId === !!params.connectionId) {
      throw new Error('Telegram forwarding requires exactly one target')
    }

    const previous = this.state
    if (previous) {
      await this.stopForwarding(previous.sessionId !== params.sessionId ? 'move' : 'replace')
    }

    this.state = {
      sessionId: params.sessionId,
      worktreeId: params.worktreeId,
      connectionId: params.connectionId,
      mode: params.mode,
      contextSize: Math.min(10, Math.max(1, cfg.contextSize || 3)),
      recentAssistantTurns: [],
      assistantBuffer: '',
      assistantFlushTimer: null,
      currentTurnText: '',
      pendingQueuedPrompt: null,
      lastUpdateId: 0,
      startedAtSeconds: Math.floor(Date.now() / 1000),
      isBusy: false,
      previousWasAssistantText: false,
      hasOutstandingInteraction: false,
      pollAbort: null,
      firstFailureSurfaced: false
    }

    // Claude CLI sessions have no SDK implementer to route answers to; the bridge
    // intercepts their hooks instead. Only intercept while forwarding is enabled.
    const session = this.db?.getSession(params.sessionId)
    if (session && isClaudeCli(session.agent_sdk)) {
      claudeCliTelegramBridge.register(params.sessionId)
    }

    const label = this.getSessionLabel(params.sessionId)
    const verb =
      previous && previous.sessionId !== params.sessionId
        ? 'Forwarding moved to'
        : 'Forwarding started'
    this.state.lastUpdateId = await this.discardPendingUpdates(cfg)
    await this.sendMessage(cfg, `${verb}: ${label}. Mode: ${params.mode}.`)
    this.startPolling()
    this.emitStatus()
    return this.getStatus()
  }

  async stopForwarding(
    reason: 'manual' | 'move' | 'replace' | 'session-ended' = 'manual'
  ): Promise<TelegramForwardingStatus> {
    const cfg = this.getConfig()
    const state = this.state
    if (!state) return this.getStatus()

    // Unblock any held CLI hook (resolves with `{}` → CLI falls back to its
    // terminal prompt) and stop intercepting this session. Covers manual stop,
    // move (handoff), replace, and session-ended.
    claudeCliTelegramBridge.cancelSession(state.sessionId)

    this.stopPolling()
    this.cancelAssistantFlush()
    for (const interaction of this.messageIndex.values()) {
      await this.resolveTelegramMessage(interaction, 'Forwarding stopped').catch(() => {})
    }
    this.messageIndex.clear()
    this.questionBatches.clear()
    this.callbackRequestIds.clear()
    this.state = null

    if (cfg && reason === 'manual') {
      await this.sendMessage(cfg, 'Forwarding stopped.').catch(() => {})
    }
    this.emitStatus()
    return this.getStatus()
  }

  private async handleAgentEvent(event: OpenCodeStreamEvent): Promise<void> {
    const state = this.state
    if (!state || event.sessionId !== state.sessionId || event.childSessionId) return

    if (event.type === 'session.status') {
      const statusType = event.statusPayload?.type
      if (statusType === 'busy') state.isBusy = true
      if (statusType === 'idle') {
        await this.handleSessionIdle()
      }
    }

    if (event.type === 'session.busy') {
      state.isBusy = true
      return
    }

    if (event.type === 'message.part.updated' || event.type === 'message.updated') {
      const text = extractAssistantText(event)
      if (text) {
        state.currentTurnText += text
        state.previousWasAssistantText = true
        if (state.mode === 'all') {
          state.assistantBuffer += text
          this.scheduleAssistantFlush()
        }
      }
      return
    }

    if (event.type === 'question.asked') {
      await this.forwardQuestion(event)
      return
    }

    if (event.type === 'permission.asked') {
      await this.forwardPermission(event)
      return
    }

    if (event.type === 'command.approval_needed') {
      await this.forwardCommandApproval(event)
      return
    }

    if (event.type === 'plan.ready') {
      await this.forwardPlan(event)
      return
    }

    if (
      event.type === 'question.replied' ||
      event.type === 'question.rejected' ||
      event.type === 'permission.replied' ||
      event.type === 'plan.resolved'
    ) {
      await this.resolveTrackedFromEvent(event)
      return
    }

    if (event.type === 'session.idle') {
      await this.handleSessionIdle()
      return
    }

    if (event.type === 'session.deleted' || event.type === 'session.error') {
      await this.endActiveSession()
    }
  }

  private async forwardQuestion(event: OpenCodeStreamEvent): Promise<void> {
    const cfg = this.getConfig()
    const state = this.state
    if (!cfg || !state) return
    const data = asRecord(event.data)
    const requestId = requestIdFromData(event.data)
    const questions = Array.isArray(data?.questions) ? data.questions : []
    if (!requestId || questions.length === 0) return

    if (this.questionBatches.has(requestId)) return

    const telegramQuestions = questions
      .map((item) => {
        const question = asRecord(item)
        if (!question) return null
        return {
          header: question.header ? String(question.header) : 'Question',
          question: question.question ? String(question.question) : '',
          options: Array.isArray(question.options)
            ? question.options
                .map((option) => asRecord(option)?.label)
                .filter((label): label is string => typeof label === 'string')
            : []
        }
      })
      .filter((question): question is TelegramQuestion => !!question)

    if (telegramQuestions.length === 0) return

    state.hasOutstandingInteraction = true
    const batch: QuestionBatch = {
      total: telegramQuestions.length,
      answers: Array.from({ length: telegramQuestions.length }, () => []),
      worktreePath: this.getSessionWorkspacePath(),
      questions: telegramQuestions,
      currentIndex: 0
    }
    this.questionBatches.set(requestId, batch)

    try {
      const context = this.contextPrefix() || 'Hive needs your input.'
      const contextMessage = await this.sendMessage(cfg, context)
      batch.contextMessageId = contextMessage.message_id
      await this.sendQuestionStep(requestId, 0)
    } catch (error) {
      this.questionBatches.delete(requestId)
      throw error
    }
  }

  private async forwardPermission(event: OpenCodeStreamEvent): Promise<void> {
    const cfg = this.getConfig()
    const state = this.state
    if (!cfg || !state) return
    const requestId = requestIdFromData(event.data)
    if (!requestId) return
    state.hasOutstandingInteraction = true
    const data = asRecord(event.data)
    const prompt = [
      this.contextPrefix(),
      'Permission requested',
      asString(data?.permission) ?? asString(data?.message) ?? ''
    ]
      .filter(Boolean)
      .join('\n\n')
    const sent = await this.sendMessage(cfg, prompt, {
      inline_keyboard: [
        [
          {
            text: 'Allow Once',
            callback_data: this.encodeCallbackData('permission', requestId, 'o')
          },
          {
            text: 'Allow Always',
            callback_data: this.encodeCallbackData('permission', requestId, 'a')
          },
          { text: 'Reject', callback_data: this.encodeCallbackData('permission', requestId, 'r') }
        ]
      ]
    })
    this.messageIndex.set(requestId, {
      kind: 'permission',
      requestId,
      messageId: sent.message_id,
      worktreePath: this.getSessionWorkspacePath(),
      promptTitle: 'Permission'
    })
  }

  private async forwardCommandApproval(event: OpenCodeStreamEvent): Promise<void> {
    const cfg = this.getConfig()
    const state = this.state
    if (!cfg || !state) return
    const requestId = requestIdFromData(event.data)
    if (!requestId) return
    state.hasOutstandingInteraction = true
    const data = asRecord(event.data)
    const command =
      asString(data?.commandStr) ?? asString(data?.command) ?? 'Command approval needed'
    const prompt = [this.contextPrefix(), 'Command approval requested', command]
      .filter(Boolean)
      .join('\n\n')
    const patternSuggestions = Array.isArray(data?.patternSuggestions)
      ? data.patternSuggestions.filter((item): item is string => typeof item === 'string')
      : []
    const sent = await this.sendMessage(cfg, prompt, {
      inline_keyboard: [
        [
          { text: 'Allow Once', callback_data: this.encodeCallbackData('command', requestId, 'o') },
          {
            text: 'Allow Always',
            callback_data: this.encodeCallbackData('command', requestId, 'a')
          }
        ],
        [
          {
            text: 'Block Always',
            callback_data: this.encodeCallbackData('command', requestId, 'b')
          },
          { text: 'Deny', callback_data: this.encodeCallbackData('command', requestId, 'r') }
        ]
      ]
    })
    this.messageIndex.set(requestId, {
      kind: 'command',
      requestId,
      messageId: sent.message_id,
      worktreePath: this.getSessionWorkspacePath(),
      promptTitle: 'Command approval',
      patternSuggestions
    })
  }

  private async forwardPlan(event: OpenCodeStreamEvent): Promise<void> {
    const cfg = this.getConfig()
    const state = this.state
    if (!cfg || !state) return
    const requestId = requestIdFromData(event.data)
    const data = asRecord(event.data)
    const plan = asString(data?.plan) ?? asString(data?.content) ?? ''
    if (!requestId || !plan) return
    state.hasOutstandingInteraction = true
    const keyboard = {
      inline_keyboard: [
        [
          { text: 'Implement', callback_data: this.encodeCallbackData('plan', requestId, 'i') },
          { text: 'Handoff', callback_data: this.encodeCallbackData('plan', requestId, 'h') }
        ]
      ]
    }

    if (plan.length > LONG_PLAN_THRESHOLD) {
      await this.sendDocument(cfg, `${this.getBranchLabel()}-plan.md`, plan)
      const sent = await this.sendMessage(
        cfg,
        formatTelegramText(`Plan ready. Full plan attached.\n\n${plan.slice(0, 900)}`),
        keyboard
      )
      this.trackPlan(requestId, sent.message_id, plan)
      return
    }

    const sent = await this.sendMessage(
      cfg,
      `${this.contextPrefix()}\n\nPlan ready:\n\n${plan}`,
      keyboard
    )
    this.trackPlan(requestId, sent.message_id, plan)
  }

  private trackPlan(requestId: string, messageId: number, plan: string): void {
    const interaction: TrackedInteraction = {
      kind: 'plan',
      requestId,
      messageId,
      worktreePath: this.getSessionWorkspacePath(),
      promptTitle: 'Plan',
      plan
    }
    this.messageIndex.set(requestId, interaction)
  }

  private async resolveTrackedFromEvent(event: OpenCodeStreamEvent): Promise<void> {
    const requestId = requestIdFromData(event.data)
    if (!requestId) return
    for (const [key, interaction] of this.messageIndex.entries()) {
      if (interaction.requestId !== requestId) continue
      await this.resolveTelegramMessage(interaction, 'Answered in Hive').catch(() => {})
      this.messageIndex.delete(key)
    }
    if (this.messageIndex.size === 0 && this.state) {
      this.state.hasOutstandingInteraction = false
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (this.isStaleTelegramUpdate(update)) return

    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query)
      return
    }
    if (update.message?.text) {
      await this.handleTextMessage(update.message)
    }
  }

  private async handleCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
    const cfg = this.getConfig()
    if (!cfg || !query.data) return
    const parsed = this.parseCallbackData(query.data)
    if (!parsed) return
    const { prefix, requestId, action } = parsed

    const interaction = this.findInteraction(requestId, prefix === 'q' ? action : undefined)
    if (!interaction) {
      await this.answerCallbackQuery(cfg, query.id, 'Already handled in Hive')
      return
    }

    try {
      await this.answerCallbackQuery(cfg, query.id)
      if (prefix === 'q') {
        const optionAction = action.includes('-') ? action.split('-')[1] : action
        const option = interaction.options?.[Number(optionAction)] ?? optionAction
        await this.answerQuestionInteraction(interaction, option)
      } else if (prefix === 'p') {
        const reply = action === 'a' ? 'always' : action === 'r' ? 'reject' : 'once'
        await this.replyPermission(interaction.requestId, reply, interaction.worktreePath)
        await this.resolveTelegramMessage(interaction, `Resolved: ${reply}`)
      } else if (prefix === 'c') {
        await this.replyCommand(interaction, action)
        await this.resolveTelegramMessage(interaction, 'Command approval resolved')
      } else if (prefix === 'pl' && action === 'i') {
        await this.approvePlan(interaction)
        this.publishPlanResolved(interaction, true, 'implement')
        await this.resolveTelegramMessage(interaction, 'Implementing plan')
      } else if (prefix === 'pl' && action === 'h') {
        await this.requestPlanHandoff(interaction)
        this.publishPlanResolved(interaction, true, 'handoff')
        await this.resolveTelegramMessage(interaction, 'Starting handoff')
      }
      this.deleteInteraction(interaction)
    } catch (error) {
      await this.resolveTelegramMessage(
        interaction,
        `Failed: ${error instanceof Error ? error.message : 'Failed to route response'}`
      ).catch(() => {})
      throw error
    }
  }

  private async handleTextMessage(message: TelegramMessage): Promise<void> {
    const cfg = this.getConfig()
    const state = this.state
    if (!cfg) return
    if (!state) {
      await this.sendMessage(cfg, 'No active forwarding session.')
      return
    }

    const text = message.text?.trim()
    if (!text) return

    const repliedTo = message.reply_to_message?.message_id
    if (repliedTo) {
      const interaction = Array.from(this.messageIndex.values()).find(
        (item) => item.messageId === repliedTo
      )
      if (interaction?.kind === 'question') {
        await this.answerQuestionInteraction(interaction, text)
        return
      }
      if (interaction?.kind === 'plan') {
        await this.sendPlanFeedback(interaction, text)
        return
      }
    }

    const pendingQuestion = this.getPendingQuestionInteraction()
    if (pendingQuestion) {
      await this.answerQuestionInteraction(pendingQuestion, text)
      return
    }

    const pendingPlan = this.getPendingPlanInteraction()
    if (pendingPlan) {
      await this.sendPlanFeedback(pendingPlan, text)
      return
    }

    if (state.isBusy) {
      state.pendingQueuedPrompt = text
      await this.sendMessage(cfg, 'Queued. I will send this when the session is idle.')
      return
    }
    await this.sendPrompt(text)
  }

  private async replyQuestion(
    requestId: string,
    answers: string[][],
    worktreePath?: string
  ): Promise<void> {
    if (claudeCliTelegramBridge.hasPendingQuestion(requestId)) {
      claudeCliTelegramBridge.resolveQuestion(requestId, answers)
      return
    }
    if (this.sdkManager) {
      const claudeImpl = this.sdkManager.getImplementer('claude-code') as ClaudeCodeImplementer
      if (claudeImpl.hasPendingQuestion(requestId)) {
        await claudeImpl.questionReply(requestId, answers, worktreePath)
        return
      }
      const codexImpl = this.sdkManager.getImplementer('codex') as CodexImplementer
      if (codexImpl.hasPendingQuestion(requestId)) {
        await codexImpl.questionReply(requestId, answers, worktreePath)
        return
      }
    }
    await openCodeService.questionReply(requestId, answers, worktreePath)
  }

  private async answerQuestionInteraction(
    interaction: TrackedInteraction,
    answer: string
  ): Promise<void> {
    const batch = this.questionBatches.get(interaction.requestId)
    const questionIndex = interaction.questionIndex ?? 0
    if (!batch) {
      await this.replyQuestion(interaction.requestId, [[answer]], interaction.worktreePath)
      this.publishQuestionResolved(interaction.requestId)
      await this.resolveTelegramMessage(interaction, `Answered: ${answer}`)
      this.deleteInteraction(interaction)
      return
    }

    batch.answers[questionIndex] = [answer]
    await this.resolveTelegramMessage(interaction, `Answered: ${answer}`)
    this.deleteInteraction(interaction)

    const complete =
      batch.answers.length === batch.total && batch.answers.every((item) => item.length > 0)
    if (!complete) {
      await this.sendQuestionStep(interaction.requestId, questionIndex + 1)
      return
    }

    await this.replyQuestion(interaction.requestId, batch.answers, batch.worktreePath)
    this.publishQuestionResolved(interaction.requestId)
    this.questionBatches.delete(interaction.requestId)
  }

  private async sendQuestionStep(requestId: string, questionIndex: number): Promise<void> {
    const cfg = this.getConfig()
    const batch = this.questionBatches.get(requestId)
    if (!cfg || !batch) return

    const question = batch.questions[questionIndex]
    if (!question) return
    batch.currentIndex = questionIndex

    const title =
      batch.total > 1 ? `${question.header} (${questionIndex + 1}/${batch.total})` : question.header
    const prompt = [title, question.question].filter(Boolean).join('\n\n')
    const keyboard = question.options.map((label, optionIdx) => [
      {
        text: label,
        callback_data: this.encodeCallbackData(
          'question',
          requestId,
          `${questionIndex}-${optionIdx}`
        )
      }
    ])
    const sent = await this.sendMessage(cfg, prompt, { inline_keyboard: keyboard })
    this.messageIndex.set(`${requestId}:${questionIndex}`, {
      kind: 'question',
      requestId,
      questionIndex,
      messageId: sent.message_id,
      worktreePath: batch.worktreePath,
      promptTitle: title,
      options: question.options
    })
  }

  private parseCallbackData(
    data: string
  ): { prefix: string; requestId: string; action: string } | null {
    const firstSeparator = data.indexOf(':')
    const lastSeparator = data.lastIndexOf(':')
    if (firstSeparator <= 0 || lastSeparator <= firstSeparator) return null

    const prefix = data.slice(0, firstSeparator)
    const encodedRequestId = data.slice(firstSeparator + 1, lastSeparator)
    const action = data.slice(lastSeparator + 1)
    if (!prefix || !encodedRequestId || !action) return null

    return {
      prefix,
      requestId: this.callbackRequestIds.get(encodedRequestId) ?? encodedRequestId,
      action
    }
  }

  private async replyPermission(
    requestId: string,
    reply: 'once' | 'always' | 'reject',
    worktreePath?: string
  ): Promise<void> {
    if (this.sdkManager) {
      const codexImpl = this.sdkManager.getImplementer('codex') as CodexImplementer
      if (codexImpl.hasPendingApproval(requestId)) {
        await codexImpl.permissionReply(requestId, reply, worktreePath)
        return
      }
    }
    await openCodeService.permissionReply(requestId, reply, worktreePath)
  }

  private async replyCommand(interaction: TrackedInteraction, action: string): Promise<void> {
    const impl = this.sdkManager?.getImplementer('claude-code')
    if (!(impl instanceof ClaudeCodeImplementer))
      throw new Error('Claude Code implementer not available')
    if (action === 'o') {
      impl.handleApprovalReply(interaction.requestId, true)
    } else if (action === 'a') {
      impl.handleApprovalReply(
        interaction.requestId,
        true,
        'allow',
        interaction.patternSuggestions?.[0]
      )
    } else if (action === 'b') {
      impl.handleApprovalReply(
        interaction.requestId,
        false,
        'block',
        interaction.patternSuggestions?.[0]
      )
    } else {
      impl.handleApprovalReply(interaction.requestId, false)
    }
  }

  private async requestPlanHandoff(interaction: TrackedInteraction): Promise<void> {
    if (!this.state) return
    // For a CLI session the ExitPlanMode hook is held open; resolve it (deny) so
    // the original session parks while the handoff spawns a new session below.
    if (claudeCliTelegramBridge.hasPendingPlan(interaction.requestId)) {
      claudeCliTelegramBridge.resolvePlan(
        interaction.requestId,
        false,
        'Plan handed off to a new session'
      )
    }
    const payload: TelegramPlanImplementRequestedPayload = {
      sessionId: this.state.sessionId,
      worktreeId: this.state.worktreeId ?? null,
      connectionId: this.state.connectionId ?? null,
      requestId: interaction.requestId,
      plan: interaction.plan ?? ''
    }
    this.backendEventPublisher?.(TELEGRAM_PLAN_IMPLEMENT_REQUESTED_CHANNEL, payload)
  }

  private async rejectPlan(interaction: TrackedInteraction, feedback: string): Promise<void> {
    if (claudeCliTelegramBridge.hasPendingPlan(interaction.requestId)) {
      claudeCliTelegramBridge.resolvePlan(interaction.requestId, false, feedback)
      return
    }
    const state = this.state
    const impl = this.sdkManager?.getImplementer('claude-code')
    if (
      impl instanceof ClaudeCodeImplementer &&
      state &&
      (impl.hasPendingPlan(interaction.requestId) || impl.hasPendingPlanForSession(state.sessionId))
    ) {
      await impl.planReject(
        interaction.worktreePath ?? '',
        state.sessionId,
        feedback,
        interaction.requestId
      )
      return
    }
    await this.sendPrompt(feedback)
  }

  private async approvePlan(interaction: TrackedInteraction): Promise<void> {
    const state = this.state
    if (!state) return
    if (claudeCliTelegramBridge.hasPendingPlan(interaction.requestId)) {
      claudeCliTelegramBridge.resolvePlan(interaction.requestId, true)
      return
    }
    const impl = this.sdkManager?.getImplementer('claude-code')
    if (
      impl instanceof ClaudeCodeImplementer &&
      (impl.hasPendingPlan(interaction.requestId) || impl.hasPendingPlanForSession(state.sessionId))
    ) {
      await impl.planApprove(interaction.worktreePath ?? '', state.sessionId, interaction.requestId)
      return
    }
    await this.sendPrompt(this.buildPlanImplementationPrompt(interaction.plan))
  }

  private getPendingPlanInteraction(): TrackedInteraction | null {
    return Array.from(this.messageIndex.values()).find((item) => item.kind === 'plan') ?? null
  }

  private getPendingQuestionInteraction(): TrackedInteraction | null {
    return Array.from(this.messageIndex.values()).find((item) => item.kind === 'question') ?? null
  }

  private async sendPlanFeedback(interaction: TrackedInteraction, feedback: string): Promise<void> {
    await this.rejectPlan(interaction, feedback)
    this.publishPlanResolved(interaction, false, 'feedback', feedback)
    await this.resolveTelegramMessage(interaction, 'Feedback sent')
    this.deleteInteraction(interaction)
  }

  private publishQuestionResolved(requestId: string): void {
    const state = this.state
    if (!state) return
    agentEventBus.publish({
      type: 'question.replied',
      sessionId: state.sessionId,
      data: { requestId, id: requestId }
    })
  }

  private publishPlanResolved(
    interaction: TrackedInteraction,
    approved: boolean,
    resolution: 'implement' | 'handoff' | 'feedback',
    feedback?: string
  ): void {
    const state = this.state
    if (!state) return
    agentEventBus.publish({
      type: 'plan.resolved',
      sessionId: state.sessionId,
      data: {
        requestId: interaction.requestId,
        id: interaction.requestId,
        approved,
        resolution,
        ...(feedback ? { feedback } : {})
      }
    })
  }

  private buildPlanImplementationPrompt(plan?: string): string {
    const text = plan?.trim()
    return text ? `PLEASE IMPLEMENT THIS PLAN:\n${text}` : 'Implement'
  }

  private async sendPrompt(text: string): Promise<void> {
    const state = this.state
    if (!state) return
    const session = this.db?.getSession(state.sessionId)
    if (!session) throw new Error('Active session not found')

    // CLI sessions have no implementer; inject the prompt straight into the PTY.
    if (isClaudeCli(session.agent_sdk)) {
      const { delivered } = writeClaudeCliPrompt(state.sessionId, text)
      // No live PTY yet — keep it queued for the next idle flush (best-effort).
      if (!delivered) state.pendingQueuedPrompt = text
      return
    }

    const workspacePath = this.getSessionWorkspacePath()
    if (!workspacePath) throw new Error('Active session not found')
    const agentSessionId = session.opencode_session_id ?? state.sessionId
    const parts = [{ type: 'text' as const, text }]

    if (session.agent_sdk !== 'opencode' && session.agent_sdk !== 'terminal' && this.sdkManager) {
      await this.sdkManager
        .getImplementer(session.agent_sdk)
        .prompt(workspacePath, agentSessionId, parts)
    } else {
      await openCodeService.prompt(workspacePath, agentSessionId, parts)
    }
  }

  private async flushQueuedPrompt(): Promise<void> {
    const state = this.state
    if (!state?.pendingQueuedPrompt) return
    const prompt = state.pendingQueuedPrompt
    state.pendingQueuedPrompt = null
    await this.sendPrompt(prompt)
  }

  private async handleSessionIdle(): Promise<void> {
    const state = this.state
    if (!state) return
    state.isBusy = false
    await this.flushQueuedPrompt()
    this.cancelAssistantFlush()
    await this.flushAssistantBuffer()

    if (state.currentTurnText.trim().length > 0) {
      this.recordAssistantText(state.currentTurnText)
      state.currentTurnText = ''
    }

    if (
      state.mode === 'questions' &&
      !state.hasOutstandingInteraction &&
      state.previousWasAssistantText
    ) {
      await this.safeSend(`Session idle.\n\n${this.contextPrefix()}`)
      state.previousWasAssistantText = false
    }
  }

  private scheduleAssistantFlush(): void {
    const state = this.state
    if (!state || state.assistantFlushTimer) return
    state.assistantFlushTimer = setTimeout(() => {
      if (this.state) this.state.assistantFlushTimer = null
      void this.flushAssistantBuffer()
    }, ASSISTANT_FLUSH_INTERVAL_MS)
  }

  private async flushAssistantBuffer(): Promise<void> {
    const state = this.state
    if (!state || state.assistantBuffer.length === 0) return
    const text = state.assistantBuffer
    state.assistantBuffer = ''
    const formatted = formatTelegramText(text)
    if (formatted) await this.safeSend(formatted)
  }

  private cancelAssistantFlush(): void {
    const state = this.state
    if (!state?.assistantFlushTimer) return
    clearTimeout(state.assistantFlushTimer)
    state.assistantFlushTimer = null
  }

  private recordAssistantText(text: string): void {
    const state = this.state
    if (!state) return
    const clean = formatTelegramText(text, 2000)
    if (!clean) return
    state.recentAssistantTurns.push(clean)
    if (state.recentAssistantTurns.length > 10) state.recentAssistantTurns.shift()
  }

  private contextPrefix(): string {
    const state = this.state
    if (!state) return ''
    const turns = state.recentAssistantTurns.slice(-state.contextSize)
    if (turns.length === 0) return ''
    return `Recent context:\n${turns.join('\n\n')}`
  }

  private findInteraction(requestId: string, questionAction?: string): TrackedInteraction | null {
    if (questionAction !== undefined) {
      const questionIndex = questionAction.includes('-') ? questionAction.split('-')[0] : '0'
      return this.messageIndex.get(`${requestId}:${questionIndex}`) ?? null
    }
    return this.messageIndex.get(requestId) ?? null
  }

  private encodeCallbackData(kind: CallbackKind, requestId: string, action: string): string {
    const prefix =
      kind === 'question' ? 'q' : kind === 'permission' ? 'p' : kind === 'command' ? 'c' : 'pl'
    const direct = `${prefix}:${requestId}:${action}`
    if (direct.length <= 64) return direct

    const token = `t${this.callbackRequestIds.size.toString(36)}`
    this.callbackRequestIds.set(token, requestId)
    return `${prefix}:${token}:${action}`
  }

  private deleteInteraction(interaction: TrackedInteraction): void {
    for (const [key, value] of this.messageIndex.entries()) {
      if (value === interaction) this.messageIndex.delete(key)
    }
    if (this.messageIndex.size === 0 && this.state) {
      this.state.hasOutstandingInteraction = false
    }
  }

  private async resolveTelegramMessage(
    interaction: TrackedInteraction,
    status: string
  ): Promise<void> {
    const cfg = this.getConfig()
    if (!cfg) return
    await this.editMessageText(
      cfg,
      interaction.messageId,
      `${interaction.promptTitle} - ${status}`,
      { inline_keyboard: [] }
    )
  }

  private async endActiveSession(): Promise<void> {
    const cfg = this.getConfig()
    const state = this.state
    if (!cfg || !state) return
    this.cancelAssistantFlush()
    await this.sendMessage(cfg, `Session ended: ${this.getSessionLabel(state.sessionId)}.`)
    await this.stopForwarding('session-ended')
  }

  private getSessionLabel(sessionId: string): string {
    const state = this.state
    const session = this.db?.getSession(sessionId)
    if (state?.connectionId) {
      const connection = this.db?.getConnection(state.connectionId)
      const connectionName = connection?.custom_name ?? connection?.name ?? 'Connection'
      const sdk = session?.agent_sdk ?? 'agent'
      return `${connectionName} (connection · ${sdk})`
    }
    const worktree = state?.worktreeId ? this.db?.getWorktree(state.worktreeId) : null
    const project = session?.project_id ? this.db?.getProject(session.project_id) : null
    const branch = worktree?.branch_name ?? worktree?.name ?? 'unknown'
    const projectName = project?.name ?? 'Project'
    const sdk = session?.agent_sdk ?? 'agent'
    return `${projectName} → ${branch} (${sdk})`
  }

  private getBranchLabel(): string {
    const state = this.state
    if (!state) return 'hive'
    if (state.connectionId) {
      const connection = this.db?.getConnection(state.connectionId)
      return this.slugLabel(connection?.custom_name ?? connection?.name ?? 'hive')
    }
    const worktree = state.worktreeId ? this.db?.getWorktree(state.worktreeId) : null
    return this.slugLabel(worktree?.branch_name ?? worktree?.name ?? 'hive')
  }

  private getSessionWorkspacePath(): string | undefined {
    const state = this.state
    if (!state) return undefined
    if (state.connectionId) return this.db?.getConnection(state.connectionId)?.path
    if (state.worktreeId) return this.db?.getWorktree(state.worktreeId)?.path
    return undefined
  }

  private slugLabel(label: string): string {
    return label.replace(/[^a-zA-Z0-9._-]+/g, '-')
  }

  private normalizeConfig(value: unknown): TelegramConfig {
    const record = asRecord(value) ?? {}
    return {
      botToken: asString(record.botToken) ?? '',
      chatId: Number(record.chatId) || 0,
      chatName: asString(record.chatName) ?? '',
      contextSize: Math.min(10, Math.max(1, Number(record.contextSize) || 3))
    }
  }

  private startPolling(): void {
    const state = this.state
    if (!state) return
    state.pollAbort = new AbortController()
    void this.pollLoop(state.pollAbort)
  }

  private stopPolling(): void {
    this.state?.pollAbort?.abort()
    if (this.state) this.state.pollAbort = null
  }

  private async discardPendingUpdates(cfg: TelegramConfig): Promise<number> {
    let maxUpdateId = 0
    let offset: number | undefined

    for (let attempts = 0; attempts < 20; attempts++) {
      const updates = await this.api<TelegramUpdate[]>(cfg.botToken, 'getUpdates', {
        timeout: 0,
        limit: 100,
        ...(offset !== undefined ? { offset } : {})
      })
      if (updates.length === 0) break

      for (const update of updates) {
        maxUpdateId = Math.max(maxUpdateId, update.update_id)
      }
      offset = maxUpdateId + 1
      if (updates.length < 100) break
    }

    return maxUpdateId
  }

  private isStaleTelegramUpdate(update: TelegramUpdate): boolean {
    const state = this.state
    if (!state) return true
    const updateDate = update.message?.date ?? update.callback_query?.message?.date
    return typeof updateDate === 'number' && updateDate < state.startedAtSeconds
  }

  private async pollLoop(controller: AbortController): Promise<void> {
    while (!controller.signal.aborted && this.state) {
      const cfg = this.getConfig()
      if (!cfg) return
      try {
        const updates = await this.api<TelegramUpdate[]>(
          cfg.botToken,
          'getUpdates',
          {
            timeout: 30,
            offset: this.state.lastUpdateId + 1
          },
          controller.signal
        )
        for (const update of updates) {
          if (!this.state) return
          this.state.lastUpdateId = Math.max(this.state.lastUpdateId, update.update_id)
          await this.handleUpdate(update)
        }
      } catch (error) {
        if (controller.signal.aborted) return
        await this.surfaceFailure(error)
        await new Promise((resolve) => setTimeout(resolve, 3000))
      }
    }
  }

  private async safeSend(text: string): Promise<void> {
    const cfg = this.getConfig()
    if (!cfg) return
    try {
      await this.sendMessage(cfg, text)
      if (this.state?.firstFailureSurfaced) {
        this.state.firstFailureSurfaced = false
        this.emitStatus()
      }
    } catch (error) {
      await this.surfaceFailure(error)
    }
  }

  private async surfaceFailure(error: unknown): Promise<void> {
    const state = this.state
    if (!state) return
    state.firstFailureSurfaced = true
    this.emitStatus(error instanceof Error ? error.message : String(error))
  }

  private emitStatus(lastError?: string): void {
    const status = this.getStatus()
    const payload = {
      ...status,
      lastError: lastError ?? status.lastError
    }
    this.backendEventPublisher?.(TELEGRAM_STATUS_CHANGED_CHANNEL, payload)
  }

  private async sendMessage(
    cfg: TelegramConfig,
    text: string,
    replyMarkup?: InlineKeyboardMarkup
  ): Promise<TelegramMessage> {
    return this.api<TelegramMessage>(cfg.botToken, 'sendMessage', {
      chat_id: cfg.chatId,
      text: formatTelegramText(text || ' '),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    })
  }

  private async sendDocument(cfg: TelegramConfig, filename: string, body: string): Promise<void> {
    const form = new FormData()
    form.set('chat_id', String(cfg.chatId))
    form.set('document', new Blob([body], { type: 'text/markdown' }), filename)
    await this.api<TelegramMessage>(cfg.botToken, 'sendDocument', form)
  }

  private async editMessageText(
    cfg: TelegramConfig,
    messageId: number,
    text: string,
    replyMarkup?: InlineKeyboardMarkup
  ): Promise<void> {
    await this.api(cfg.botToken, 'editMessageText', {
      chat_id: cfg.chatId,
      message_id: messageId,
      text: formatTelegramText(text),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    })
  }

  private async answerCallbackQuery(
    cfg: TelegramConfig,
    callbackQueryId: string,
    text?: string
  ): Promise<void> {
    await this.api(cfg.botToken, 'answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {})
    })
  }

  private async api<T>(
    botToken: string,
    method: string,
    body?: Record<string, unknown> | FormData,
    signal?: AbortSignal
  ): Promise<T> {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: body ? 'POST' : 'GET',
      headers: body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
      signal
    })
    const json = (await response.json().catch(() => null)) as TelegramApiResponse<T> | null
    if (!response.ok || !json?.ok) {
      if (json?.parameters?.retry_after) {
        await new Promise((resolve) => setTimeout(resolve, json.parameters!.retry_after! * 1000))
      }
      throw new Error(json?.description ?? `Telegram API failed (${response.status})`)
    }
    return json.result as T
  }
}

export const telegramForwardingService = new TelegramForwardingService()

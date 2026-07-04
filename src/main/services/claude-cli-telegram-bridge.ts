import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import type { OpenCodeStreamEvent } from '@shared/types/opencode'
import { TELEGRAM_CLAUDE_CLI_EVENT_CHANNEL } from '@shared/telegram-events'
import { agentEventBus } from './agent-event-bus'
import { publishDesktopBackendEvent } from '../desktop/backend-event-publisher'
import {
  CliHookHoldCore,
  type ClaudeHookBody,
  type CliHookRouteContext
} from './cli-hook-hold-core'

export type { ClaudeHookBody } from './cli-hook-hold-core'

class ClaudeCliTelegramBridge {
  readonly name = 'telegram'
  private readonly emitter = new EventEmitter()
  private readonly core = new CliHookHoldCore({
    name: 'Telegram',
    emitShared: (event) => agentEventBus.publish(event),
    emitTransport: (event) => this.emitTelegram(event)
  })

  register(sessionId: string): void {
    this.core.register(sessionId)
  }

  isRegistered(sessionId: string): boolean {
    return this.core.isRegistered(sessionId)
  }

  subscribe(listener: (event: OpenCodeStreamEvent) => void): () => void {
    this.emitter.on('event', listener)
    return () => this.emitter.off('event', listener)
  }

  onHook(
    sessionId: string,
    body: ClaudeHookBody,
    res: ServerResponse,
    ctx?: CliHookRouteContext
  ): boolean {
    return this.core.onHook(sessionId, body, res, ctx)
  }

  notifySessionIdle(sessionId: string, lastAssistantMessage?: string): void {
    this.core.emitSessionIdle(sessionId, lastAssistantMessage)
  }

  hasPendingQuestion(requestId: string): boolean {
    return this.core.hasPendingQuestion(requestId)
  }

  hasPendingPlan(requestId: string): boolean {
    return this.core.hasPendingPlan(requestId)
  }

  hasPendingPlanForSession(sessionId: string): boolean {
    return this.core.hasPendingPlanForSession(sessionId)
  }

  resolveQuestion(requestId: string, answers: string[][]): void {
    this.core.resolveQuestion(requestId, answers)
  }

  rejectQuestion(requestId: string): void {
    this.core.rejectQuestion(requestId)
  }

  resolvePlan(requestId: string, approve: boolean, feedback?: string): void {
    this.core.resolvePlan(requestId, approve, feedback)
  }

  cancelSession(sessionId: string): void {
    this.core.cancelSession(sessionId)
  }

  cancelAll(): void {
    this.core.cancelAll()
  }

  private emitTelegram(event: OpenCodeStreamEvent): void {
    this.emitter.emit('event', event)
    void publishDesktopBackendEvent(TELEGRAM_CLAUDE_CLI_EVENT_CHANNEL, event)
  }
}

export const claudeCliTelegramBridge = new ClaudeCliTelegramBridge()

import { randomUUID } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import type { OpenCodeStreamEvent } from '@shared/types/opencode'
import { createLogger } from './logger'

export const SAFETY_TIMEOUT_MS = 9 * 60 * 1000

export interface ClaudeHookBody {
  hook_event_name?: string
  tool_name?: string
  tool_input?: { plan?: unknown; questions?: unknown }
  assistant_message?: string
  last_assistant_message?: string
  agent_id?: string
}

export interface CliHookRouteContext {
  suppressIdle?: boolean
}

type InteractionKind = 'question' | 'plan'

interface PendingInteraction {
  res: ServerResponse
  sessionId: string
  kind: InteractionKind
  toolInput: Record<string, unknown>
  questions: Array<Record<string, unknown>>
  timer: NodeJS.Timeout
  onClose: () => void
}

export interface HeldInteractionEvents {
  name: string
  emitShared: (event: OpenCodeStreamEvent) => void
  emitTransport: (event: OpenCodeStreamEvent) => void
}

const log = createLogger({ component: 'CliHookHoldCore' })

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null
}

function questionText(question: Record<string, unknown>): string {
  return typeof question.question === 'string' ? question.question : ''
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export class CliHookHoldCore {
  private readonly events: HeldInteractionEvents
  private readonly registered = new Set<string>()
  private readonly pending = new Map<string, PendingInteraction>()

  constructor(events: HeldInteractionEvents) {
    this.events = events
  }

  register(sessionId: string): void {
    this.registered.add(sessionId)
  }

  unregister(sessionId: string): void {
    this.registered.delete(sessionId)
  }

  isRegistered(sessionId: string): boolean {
    return this.registered.has(sessionId)
  }

  onHook(
    sessionId: string,
    body: ClaudeHookBody,
    res: ServerResponse,
    ctx?: CliHookRouteContext
  ): boolean {
    if (!this.registered.has(sessionId)) return false

    const event = body.hook_event_name
    if (event === 'PreToolUse' && body.tool_name === 'AskUserQuestion') {
      return this.holdQuestion(sessionId, body, res)
    }
    if (event === 'PreToolUse' && body.tool_name === 'ExitPlanMode') {
      return this.holdPlan(sessionId, body, res)
    }
    if (event === 'Stop') {
      if (!ctx?.suppressIdle) this.emitIdle(sessionId, body)
      return false
    }
    if (
      event === 'UserPromptSubmit' ||
      event === 'PostToolUse' ||
      event === 'PostToolUseFailure'
    ) {
      this.events.emitTransport({ type: 'session.busy', sessionId, data: {} })
      return false
    }
    return false
  }

  hasPendingQuestion(requestId: string): boolean {
    return this.pending.get(requestId)?.kind === 'question'
  }

  hasPendingPlan(requestId: string): boolean {
    return this.pending.get(requestId)?.kind === 'plan'
  }

  hasPendingPlanForSession(sessionId: string): boolean {
    for (const entry of this.pending.values()) {
      if (entry.kind === 'plan' && entry.sessionId === sessionId) return true
    }
    return false
  }

  resolveQuestion(requestId: string, answers: string[][]): void {
    const entry = this.pending.get(requestId)
    if (!entry || entry.kind !== 'question') return

    const answerMap: Record<string, string> = {}
    entry.questions.forEach((question, index) => {
      const text = questionText(question)
      const selected = (answers[index] ?? []).filter((value) => typeof value === 'string')
      if (text && selected.length > 0) answerMap[text] = selected.join(', ')
    })

    this.finalize(requestId, {
      responseBody: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: `Answered via ${this.events.name}`,
          updatedInput: { ...entry.toolInput, answers: answerMap }
        }
      })
    })
    this.events.emitShared({
      type: 'question.replied',
      sessionId: entry.sessionId,
      data: { requestId, id: requestId }
    })
  }

  rejectQuestion(requestId: string): void {
    const entry = this.pending.get(requestId)
    if (!entry || entry.kind !== 'question') return
    this.finalize(requestId, { responseBody: '{}', emitCleanup: true })
  }

  resolvePlan(requestId: string, approve: boolean, feedback?: string): void {
    const entry = this.pending.get(requestId)
    if (!entry || entry.kind !== 'plan') return

    const hookSpecificOutput = approve
      ? {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: `Approved via ${this.events.name}`
        }
      : {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: feedback?.trim() || `Rejected via ${this.events.name}`
        }

    this.finalize(requestId, { responseBody: JSON.stringify({ hookSpecificOutput }) })
  }

  cancelSession(sessionId: string): void {
    const requestIds = [...this.pending.entries()]
      .filter(([, entry]) => entry.sessionId === sessionId)
      .map(([requestId]) => requestId)
    for (const requestId of requestIds) {
      this.finalize(requestId, { emitCleanup: true })
    }
    this.unregister(sessionId)
  }

  cancelAll(): void {
    for (const requestId of [...this.pending.keys()]) {
      this.finalize(requestId, {})
    }
    this.registered.clear()
  }

  private holdQuestion(sessionId: string, body: ClaudeHookBody, res: ServerResponse): boolean {
    const rawQuestions = asArray(body.tool_input?.questions)
    const questions = (rawQuestions ?? []).filter(
      (item): item is Record<string, unknown> =>
        typeof item === 'object' && item !== null && !Array.isArray(item)
    )
    if (questions.length === 0) return false

    const requestId = this.hold(sessionId, body, res, 'question', questions)
    this.events.emitShared({
      type: 'question.asked',
      sessionId,
      data: { requestId, id: requestId, sessionID: sessionId, questions }
    })
    return true
  }

  private holdPlan(sessionId: string, body: ClaudeHookBody, res: ServerResponse): boolean {
    const plan = typeof body.tool_input?.plan === 'string' ? body.tool_input.plan : ''
    if (!plan) return false

    const requestId = this.hold(sessionId, body, res, 'plan', [])
    this.events.emitTransport({
      type: 'plan.ready',
      sessionId,
      data: { requestId, id: requestId, plan }
    })
    return true
  }

  private hold(
    sessionId: string,
    body: ClaudeHookBody,
    res: ServerResponse,
    kind: InteractionKind,
    questions: Array<Record<string, unknown>>
  ): string {
    const requestId = randomUUID()
    res.setTimeout(0)
    const onClose = (): void => this.finalize(requestId, { emitCleanup: true, skipWrite: true })
    res.on('close', onClose)
    const timer = setTimeout(() => {
      log.warn('Held Claude CLI hook expired; falling back to terminal', {
        sessionId,
        kind,
        transport: this.events.name
      })
      this.finalize(requestId, { emitCleanup: true })
    }, SAFETY_TIMEOUT_MS)

    this.pending.set(requestId, {
      res,
      sessionId,
      kind,
      toolInput: asRecord(body.tool_input),
      questions,
      timer,
      onClose
    })
    return requestId
  }

  emitSessionIdle(sessionId: string, lastAssistantMessage?: string): void {
    if (typeof lastAssistantMessage === 'string' && lastAssistantMessage.trim().length > 0) {
      this.events.emitTransport({
        type: 'message.updated',
        sessionId,
        data: { role: 'assistant', content: lastAssistantMessage }
      })
    }
    this.events.emitTransport({ type: 'session.idle', sessionId, data: {} })
  }

  private emitIdle(sessionId: string, body: ClaudeHookBody): void {
    const text = body.last_assistant_message ?? body.assistant_message
    this.emitSessionIdle(sessionId, text)
  }

  private finalize(
    requestId: string,
    opts: { responseBody?: string; emitCleanup?: boolean; skipWrite?: boolean }
  ): void {
    const entry = this.pending.get(requestId)
    if (!entry) return
    this.pending.delete(requestId)
    clearTimeout(entry.timer)
    entry.res.removeListener('close', entry.onClose)

    if (!opts.skipWrite) {
      try {
        if (!entry.res.writableEnded) {
          entry.res.writeHead(200, { 'content-type': 'application/json' })
          entry.res.end(opts.responseBody ?? '{}')
        }
      } catch (error) {
        log.warn('Failed to write held Claude CLI hook response', {
          error: error instanceof Error ? error.message : String(error),
          transport: this.events.name
        })
      }
    }

    if (!opts.emitCleanup) return
    if (entry.kind === 'question') {
      this.events.emitShared({
        type: 'question.rejected',
        sessionId: entry.sessionId,
        data: { requestId, id: requestId }
      })
    } else {
      this.events.emitTransport({
        type: 'plan.resolved',
        sessionId: entry.sessionId,
        data: { requestId, id: requestId, approved: false }
      })
    }
  }
}

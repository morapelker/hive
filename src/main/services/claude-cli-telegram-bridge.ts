import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import type { OpenCodeStreamEvent } from '@shared/types/opencode'
import { createLogger } from './logger'
import { agentEventBus } from './agent-event-bus'

const log = createLogger({ component: 'ClaudeCliTelegramBridge' })

/**
 * Resolve a held hook a little before the Claude HTTP-hook `timeout` (600s) so we
 * proactively unblock the CLI (falling back to its terminal prompt) rather than
 * letting Claude's own timeout fire with undocumented behavior.
 */
const SAFETY_TIMEOUT_MS = 9 * 60 * 1000

/** Minimal shape of the Claude hook POST body the bridge inspects. */
export interface ClaudeHookBody {
  hook_event_name?: string
  tool_name?: string
  tool_input?: { plan?: unknown; questions?: unknown }
  /** The turn's final assistant message. Docs call it `assistant_message`; */
  assistant_message?: string
  /** real Claude CLI payloads have shown `last_assistant_message` — read both. */
  last_assistant_message?: string
}

type InteractionKind = 'question' | 'plan'

interface PendingInteraction {
  res: ServerResponse
  sessionId: string
  kind: InteractionKind
  toolInput: Record<string, unknown>
  /** Raw `AskUserQuestion` questions (each `{ question, header, options:[{label}] }`). */
  questions: Array<Record<string, unknown>>
  timer: NodeJS.Timeout
  onClose: () => void
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null
}

function questionText(question: Record<string, unknown>): string {
  return typeof question.question === 'string' ? question.question : ''
}

/**
 * Bridges Claude CLI hook events to the Telegram forwarding service — but ONLY
 * for sessions the user has enabled Telegram forwarding on.
 *
 * The Claude CLI answers questions/plans in its terminal; there is no SDK
 * implementer to route a Telegram answer to. This bridge holds the blocking
 * `PreToolUse` HTTP hook response open, forwards the question/plan to Telegram
 * via the existing event pipeline, and resolves the held response with the
 * answer (so Claude proceeds without ever prompting in the terminal).
 *
 * Delivery uses two channels:
 *  - QUESTION events (`question.asked` / `question.replied` / `question.rejected`)
 *    go through `agentEventBus` so they reach BOTH the Telegram service AND the
 *    renderer — the renderer renders the same in-app question UI the SDK
 *    providers use (since the question never shows in the CLI's terminal while
 *    intercepted). The store only fills while forwarding, so the in-app UI is
 *    implicitly gated on forwarding.
 *  - PLAN / status / assistant-text events go through this object's OWN private
 *    EventEmitter (Telegram only). Pushing those to the renderer would collide
 *    with the CLI's existing in-app plan card / status pipeline.
 */
class ClaudeCliTelegramBridge {
  private registered = new Set<string>()
  private pending = new Map<string, PendingInteraction>()
  private emitter = new EventEmitter()

  /** Mark a CLI session as Telegram-forwarded so its hooks get intercepted. */
  register(sessionId: string): void {
    this.registered.add(sessionId)
  }

  isRegistered(sessionId: string): boolean {
    return this.registered.has(sessionId)
  }

  /** The Telegram service subscribes here and routes events to handleAgentEvent. */
  subscribe(listener: (event: OpenCodeStreamEvent) => void): () => void {
    this.emitter.on('event', listener)
    return () => this.emitter.off('event', listener)
  }

  /**
   * Called by the hook server for every Claude CLI hook. Returns true when the
   * bridge has taken ownership of `res` (held open, to be resolved later); the
   * caller must then NOT write to `res`. Returns false for unregistered sessions
   * and non-intercepted events, preserving the hook server's default behavior.
   */
  onHook(sessionId: string, body: ClaudeHookBody, res: ServerResponse): boolean {
    if (!this.registered.has(sessionId)) return false

    const event = body.hook_event_name
    if (event === 'PreToolUse' && body.tool_name === 'AskUserQuestion') {
      return this.holdQuestion(sessionId, body, res)
    }
    if (event === 'PreToolUse' && body.tool_name === 'ExitPlanMode') {
      return this.holdPlan(sessionId, body, res)
    }
    if (event === 'Stop') {
      this.emitIdle(sessionId, body)
      return false
    }
    if (
      event === 'UserPromptSubmit' ||
      event === 'PostToolUse' ||
      event === 'PostToolUseFailure'
    ) {
      this.emitTelegram({ type: 'session.busy', sessionId, data: {} })
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

  /**
   * Resolve a held `AskUserQuestion` hook with the Telegram answers, auto-answering
   * the tool so Claude proceeds without a terminal prompt. `answers` is the
   * Telegram batch shape (one inner array of selected labels per question); the
   * hook contract wants `updatedInput.answers` keyed by each question's text.
   */
  resolveQuestion(requestId: string, answers: string[][]): void {
    const entry = this.pending.get(requestId)
    if (!entry || entry.kind !== 'question') return

    const answerMap: Record<string, string> = {}
    entry.questions.forEach((question, index) => {
      const text = questionText(question)
      const selected = (answers[index] ?? []).filter((value) => typeof value === 'string')
      if (text && selected.length > 0) answerMap[text] = selected.join(', ')
    })

    const sessionId = entry.sessionId
    this.finalize(requestId, {
      responseBody: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: 'Answered via Telegram',
          updatedInput: { ...entry.toolInput, answers: answerMap }
        }
      })
    })
    // Clear the in-app question UI (renderer) and any tracked Telegram message.
    this.emitShared({ type: 'question.replied', sessionId, data: { requestId, id: requestId } })
  }

  /**
   * Dismiss a held question (in-app "Dismiss"): unblock the hook with `{}` so the
   * CLI falls back to its terminal prompt, and clear the in-app/Telegram UI.
   */
  rejectQuestion(requestId: string): void {
    const entry = this.pending.get(requestId)
    if (!entry || entry.kind !== 'question') return
    this.finalize(requestId, { responseBody: '{}', emitCleanup: true })
  }

  /**
   * Resolve a held `ExitPlanMode` hook: `allow` to exit plan mode and implement,
   * or `deny` with the feedback as the reason (Claude revises the plan).
   */
  resolvePlan(requestId: string, approve: boolean, feedback?: string): void {
    const entry = this.pending.get(requestId)
    if (!entry || entry.kind !== 'plan') return

    const hookSpecificOutput = approve
      ? {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: 'Approved via Telegram'
        }
      : {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: feedback?.trim() || 'Rejected via Telegram'
        }

    this.finalize(requestId, { responseBody: JSON.stringify({ hookSpecificOutput }) })
  }

  /**
   * Stop intercepting a session and unblock any held hook with `{}` so the CLI
   * falls back to its terminal prompt. Called when forwarding stops/moves and on
   * PTY teardown — guarantees turning Telegram off never freezes the CLI.
   */
  cancelSession(sessionId: string): void {
    const requestIds = [...this.pending.entries()]
      .filter(([, entry]) => entry.sessionId === sessionId)
      .map(([requestId]) => requestId)
    for (const requestId of requestIds) {
      // emitCleanup clears the in-app question UI when forwarding stops/moves.
      this.finalize(requestId, { emitCleanup: true })
    }
    this.registered.delete(sessionId)
  }

  /** Unblock every held hook (app shutdown / hook-server close). */
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
    this.emitShared({
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
    this.emitTelegram({ type: 'plan.ready', sessionId, data: { requestId, id: requestId, plan } })
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
    // Disable Node's per-socket inactivity timeout so a long-held response isn't
    // dropped while a human answers on Telegram.
    res.setTimeout(0)
    const onClose = (): void => this.finalize(requestId, { emitCleanup: true, skipWrite: true })
    res.on('close', onClose)
    const timer = setTimeout(() => {
      log.warn('Held Claude CLI hook expired; falling back to terminal', { sessionId, kind })
      this.finalize(requestId, { emitCleanup: true })
    }, SAFETY_TIMEOUT_MS)

    this.pending.set(requestId, {
      res,
      sessionId,
      kind,
      toolInput:
        typeof body.tool_input === 'object' && body.tool_input !== null
          ? (body.tool_input as Record<string, unknown>)
          : {},
      questions,
      timer,
      onClose
    })
    return requestId
  }

  private emitIdle(sessionId: string, body: ClaudeHookBody): void {
    const text = body.last_assistant_message ?? body.assistant_message
    if (typeof text === 'string' && text.trim().length > 0) {
      this.emitTelegram({
        type: 'message.updated',
        sessionId,
        data: { role: 'assistant', content: text }
      })
    }
    this.emitTelegram({ type: 'session.idle', sessionId, data: {} })
  }

  /**
   * Single exit path for a held interaction: drop it, clear the timer/listener,
   * write the response (unless the socket is already gone), and optionally emit a
   * cleanup event so the Telegram service clears its tracked message.
   */
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
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }

    if (opts.emitCleanup) {
      if (entry.kind === 'question') {
        this.emitShared({
          type: 'question.rejected',
          sessionId: entry.sessionId,
          data: { requestId, id: requestId }
        })
      } else {
        this.emitTelegram({
          type: 'plan.resolved',
          sessionId: entry.sessionId,
          data: { requestId, id: requestId, approved: false }
        })
      }
    }
  }

  /** Telegram-only delivery (plan/status/assistant-text — kept off the renderer). */
  private emitTelegram(event: OpenCodeStreamEvent): void {
    this.emitter.emit('event', event)
  }

  /**
   * Renderer + Telegram delivery for QUESTION events. agentEventBus reaches the
   * renderer (in-app question UI) and the Telegram service (its own subscription).
   */
  private emitShared(event: OpenCodeStreamEvent): void {
    agentEventBus.publish(event)
  }
}

export const claudeCliTelegramBridge = new ClaudeCliTelegramBridge()

/**
 * Puts a Claude CLI session back to work after its turn died of a transient
 * API failure.
 *
 * When the API hangs or the network drops for longer than the CLI's retry
 * budget (about 3 minutes of connection errors, or 4 + 10 minutes of silence),
 * the CLI prints "API Error: …", fires `StopFailure`, and sits at its prompt.
 * Nothing re-sends the prompt; with thirty sessions that used to mean thirty
 * dead tickets and an app restart. This service watches those failures,
 * waits until the API is reachable through the proxy again, and — as long as
 * the session is still idle on that failure and the user has not touched it —
 * types a short "continue" prompt into the PTY, exactly as the user would.
 *
 * Only failures that look transient are resumed (connection errors, no
 * response, 5xx/overloaded, the machine slept); authentication, billing,
 * invalid requests, usage limits and content filters are left alone. At most
 * a few resumes per session per hour, so a session that keeps failing does
 * not loop.
 */
import {
  CLAUDE_CLI_AUTO_RESUME_CHANNEL,
  type ClaudeCliApiErrorPayload,
  type ClaudeCliAutoResumePayload
} from '@shared/types/claude-cli-api-error'
import type { SessionStatusType } from '@shared/types/session-status'

export type ApiErrorRecoveryClass = 'transient' | 'permanent'

/** StopFailure classifications that no re-prompt can fix. */
const PERMANENT_ERROR_CODES = new Set([
  'authentication_failed',
  'oauth_org_not_allowed',
  'billing_error',
  'invalid_request',
  'model_not_found',
  'max_output_tokens',
  'rate_limit'
])

/** Error texts (from the CLI's last assistant message) that no re-prompt can fix. */
const PERMANENT_TEXT_PATTERNS = [
  /content filtering/i,
  /safeguards flagged/i,
  /prompt is too long/i,
  /credit balance/i,
  /usage limit/i,
  /hit your limit/i,
  /please run \/login/i,
  /authentication/i,
  /invalid api key/i,
  /permission denied/i
]

/** Error texts that are the transient class this service exists for. */
const TRANSIENT_TEXT_PATTERNS = [
  /no response from api/i,
  /connection error/i,
  /connection lost/i,
  /went to sleep/i,
  /server error/i,
  /overloaded/i,
  /internal server error/i,
  /socket hang up/i,
  /econnreset|etimedout|enotfound|eaddrnotavail|epipe/i,
  /local proxy: upstream/i,
  /fetch failed/i,
  /\b5\d\d\b/,
  /\b529\b/
]

export function classifyApiErrorForRecovery(payload: ClaudeCliApiErrorPayload): ApiErrorRecoveryClass {
  if (PERMANENT_ERROR_CODES.has(payload.error)) return 'permanent'
  const text = `${payload.lastAssistantMessage ?? ''} ${payload.errorDetails ?? ''}`
  if (PERMANENT_TEXT_PATTERNS.some((pattern) => pattern.test(text))) return 'permanent'
  if (payload.error === 'server_error' || payload.error === 'overloaded') return 'transient'
  if (TRANSIENT_TEXT_PATTERNS.some((pattern) => pattern.test(text))) return 'transient'
  // `unknown` with no recognisable text: the CLI could not classify it either.
  // A re-prompt after the API is reachable again is cheap; a wrong guess here
  // costs one prompt the user can see.
  return payload.error === 'unknown' ? 'transient' : 'permanent'
}

/** The one-line summary of the failure quoted in the resume prompt. */
export function summariseApiError(payload: ClaudeCliApiErrorPayload): string {
  const text = (payload.lastAssistantMessage ?? payload.errorDetails ?? '').replace(/\s+/g, ' ').trim()
  const firstSentence = text.split(/(?<=\.)\s/)[0] ?? ''
  const excerpt = firstSentence.length > 160 ? `${firstSentence.slice(0, 157)}…` : firstSentence
  return excerpt || payload.error
}

export function buildResumePrompt(payload: ClaudeCliApiErrorPayload): string {
  return (
    `Your previous turn ended with a transient API error (${summariseApiError(payload)}) ` +
    'while a request was in flight; the API is reachable again. Please continue from where ' +
    'you left off, re-running any step whose result you did not receive.'
  )
}

/** Terminal input that is not the user typing: focus reports and mouse events. */
// eslint-disable-next-line no-control-regex
const NON_USER_INPUT = /^\x1b\[(I|O|<[\d;]+[Mm])$/

export function isUserTerminalInput(data: string): boolean {
  return data.length > 0 && !NON_USER_INPUT.test(data)
}

export interface ClaudeCliSessionRecoveryDeps {
  hasLivePty: (sessionId: string) => boolean
  getLastStatus: (sessionId: string) => SessionStatusType | undefined
  /** The session's agent (`claude-code-cli`, `codex-cli`, …) or null when unknown. */
  getAgentSdk: (sessionId: string) => string | null
  writePrompt: (sessionId: string, prompt: string) => { delivered: boolean }
  probeUpstream: (timeoutMs: number) => Promise<{ ok: boolean; status: number | null; ms: number; error: string | null }>
  /** The user's switch (Settings → Advanced). */
  isEnabled: () => boolean
  publish: (channel: string, payload: unknown) => unknown
  log: {
    info: (message: string, data?: Record<string, unknown>) => void
    warn: (message: string, data?: Record<string, unknown>) => void
  }
  /** Perf-log hook. */
  mark?: (name: string, data: Record<string, unknown>) => void
  now?: () => number
  setTimeout?: typeof setTimeout
  clearTimeout?: typeof clearTimeout
  /** Wait this long after the failure before the first reachability check. Default 20 s. */
  initialDelayMs?: number
  /** Between reachability checks while the API stays unreachable. Default 30 s. */
  probeIntervalMs?: number
  /** Give up on a failure after this long. Default 30 min. */
  maxWaitMs?: number
  /** Grace after a successful probe before typing, so a flapping link settles. Default 5 s. */
  settleMs?: number
  /** Cap per session. Default 3 per hour. */
  maxResumesPerHour?: number
  probeTimeoutMs?: number
}

interface PendingRecovery {
  sessionId: string
  payload: ClaudeCliApiErrorPayload
  failedAt: number
  attempts: number
  timer: ReturnType<typeof setTimeout> | null
}

const DEFAULT_INITIAL_DELAY_MS = 20_000
const DEFAULT_PROBE_INTERVAL_MS = 30_000
const DEFAULT_MAX_WAIT_MS = 30 * 60_000
const DEFAULT_SETTLE_MS = 5_000
const DEFAULT_MAX_RESUMES_PER_HOUR = 3
const DEFAULT_PROBE_TIMEOUT_MS = 10_000
const HOUR_MS = 60 * 60_000

const IDLE_STATUSES = new Set<SessionStatusType | undefined>(['completed', 'unread', undefined])

export class ClaudeCliSessionRecovery {
  private readonly deps: ClaudeCliSessionRecoveryDeps
  private readonly pending = new Map<string, PendingRecovery>()
  private readonly userInputAt = new Map<string, number>()
  private readonly resumedAt = new Map<string, number[]>()
  private disposed = false

  constructor(deps: ClaudeCliSessionRecoveryDeps) {
    this.deps = deps
  }

  pendingSessions(): string[] {
    return [...this.pending.keys()]
  }

  /** A turn ended with an API error (the hook server's StopFailure). */
  noteApiError(payload: ClaudeCliApiErrorPayload): void {
    if (this.disposed) return
    const classification = classifyApiErrorForRecovery(payload)
    const agent = this.deps.getAgentSdk(payload.sessionId)
    if (agent !== 'claude-code-cli') {
      // Codex and SDK sessions report through other paths; only the Claude CLI
      // sits at a prompt that typing can resume.
      return
    }
    if (classification === 'permanent') {
      this.deps.log.info('API error is not recoverable by a re-prompt; leaving the session alone', {
        sessionId: payload.sessionId,
        error: payload.error
      })
      return
    }
    if (!this.deps.isEnabled()) {
      this.deps.log.info('Auto-resume after API errors is off; leaving the session alone', {
        sessionId: payload.sessionId,
        error: payload.error
      })
      return
    }
    const now = this.now()
    const recent = (this.resumedAt.get(payload.sessionId) ?? []).filter((at) => at > now - HOUR_MS)
    this.resumedAt.set(payload.sessionId, recent)
    if (recent.length >= (this.deps.maxResumesPerHour ?? DEFAULT_MAX_RESUMES_PER_HOUR)) {
      this.deps.log.warn('Not resuming the session again: too many API errors in the last hour', {
        sessionId: payload.sessionId,
        resumesInLastHour: recent.length
      })
      this.deps.mark?.('session-auto-resume-skipped', {
        sessionId: payload.sessionId,
        reason: 'budget',
        resumesInLastHour: recent.length
      })
      return
    }
    this.cancel(payload.sessionId)
    const entry: PendingRecovery = {
      sessionId: payload.sessionId,
      payload,
      failedAt: now,
      attempts: 0,
      timer: null
    }
    this.pending.set(payload.sessionId, entry)
    this.deps.log.info('Session turn died of a transient API error; will resume it once the API answers', {
      sessionId: payload.sessionId,
      error: payload.error,
      summary: summariseApiError(payload)
    })
    this.deps.mark?.('session-auto-resume-armed', { sessionId: payload.sessionId, error: payload.error })
    this.schedule(entry, this.deps.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS)
  }

  /** The user typed into the session's terminal: they are handling it. */
  noteUserInput(sessionId: string, data: string): void {
    if (!isUserTerminalInput(data)) return
    this.userInputAt.set(sessionId, this.now())
    if (this.pending.has(sessionId)) {
      this.deps.log.info('User typed into the session; cancelling its auto-resume', { sessionId })
      this.deps.mark?.('session-auto-resume-cancelled', { sessionId, reason: 'user-input' })
      this.cancel(sessionId)
    }
  }

  /** The session's PTY went away (destroyed, relaunched): nothing to resume. */
  noteSessionGone(sessionId: string): void {
    this.cancel(sessionId)
    this.userInputAt.delete(sessionId)
  }

  cancel(sessionId: string): void {
    const entry = this.pending.get(sessionId)
    if (!entry) return
    if (entry.timer) this.clearTimeoutFn(entry.timer)
    this.pending.delete(sessionId)
  }

  dispose(): void {
    this.disposed = true
    for (const sessionId of [...this.pending.keys()]) this.cancel(sessionId)
  }

  /** Run one check for a pending session now (tests). */
  async check(sessionId: string): Promise<void> {
    const entry = this.pending.get(sessionId)
    if (entry) await this.attempt(entry)
  }

  // ------------------------------------------------------------------ internals

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private get clearTimeoutFn(): typeof clearTimeout {
    return this.deps.clearTimeout ?? clearTimeout
  }

  private schedule(entry: PendingRecovery, delayMs: number): void {
    const schedule = this.deps.setTimeout ?? setTimeout
    entry.timer = schedule(() => {
      entry.timer = null
      void this.attempt(entry)
    }, delayMs)
    ;(entry.timer as { unref?: () => void }).unref?.()
  }

  private giveUp(entry: PendingRecovery, reason: string, data: Record<string, unknown> = {}): void {
    this.pending.delete(entry.sessionId)
    if (entry.timer) this.clearTimeoutFn(entry.timer)
    this.deps.log.info('Not resuming the session', { sessionId: entry.sessionId, reason, ...data })
    this.deps.mark?.('session-auto-resume-cancelled', { sessionId: entry.sessionId, reason, ...data })
  }

  private async attempt(entry: PendingRecovery): Promise<void> {
    if (this.disposed || this.pending.get(entry.sessionId) !== entry) return
    entry.attempts += 1
    const sessionId = entry.sessionId
    if (!this.deps.isEnabled()) return this.giveUp(entry, 'disabled')
    if (!this.deps.hasLivePty(sessionId)) return this.giveUp(entry, 'no-pty')
    const status = this.deps.getLastStatus(sessionId)
    if (!IDLE_STATUSES.has(status)) return this.giveUp(entry, 'session-busy', { status })
    const typedAt = this.userInputAt.get(sessionId)
    if (typedAt !== undefined && typedAt >= entry.failedAt) return this.giveUp(entry, 'user-input')
    const waited = this.now() - entry.failedAt
    if (waited > (this.deps.maxWaitMs ?? DEFAULT_MAX_WAIT_MS)) {
      return this.giveUp(entry, 'timeout', { waitedMs: waited, attempts: entry.attempts })
    }

    const probe = await this.deps.probeUpstream(this.deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS)
    if (this.pending.get(entry.sessionId) !== entry) return
    if (!probe.ok) {
      this.deps.log.info('API still unreachable; will check again', {
        sessionId,
        attempt: entry.attempts,
        error: probe.error,
        waitedMs: waited
      })
      this.schedule(entry, this.deps.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS)
      return
    }

    // Reachable. Let a flapping link settle, then re-check the gates and type.
    await new Promise<void>((resolve) => {
      const schedule = this.deps.setTimeout ?? setTimeout
      const timer = schedule(resolve, this.deps.settleMs ?? DEFAULT_SETTLE_MS)
      ;(timer as { unref?: () => void }).unref?.()
    })
    if (this.pending.get(entry.sessionId) !== entry) return
    if (!this.deps.hasLivePty(sessionId)) return this.giveUp(entry, 'no-pty')
    if (!IDLE_STATUSES.has(this.deps.getLastStatus(sessionId))) return this.giveUp(entry, 'session-busy')
    const typedLater = this.userInputAt.get(sessionId)
    if (typedLater !== undefined && typedLater >= entry.failedAt) return this.giveUp(entry, 'user-input')

    const prompt = buildResumePrompt(entry.payload)
    const { delivered } = this.deps.writePrompt(sessionId, prompt)
    this.pending.delete(sessionId)
    if (!delivered) return this.giveUp(entry, 'not-delivered')
    const at = this.now()
    this.resumedAt.set(sessionId, [...(this.resumedAt.get(sessionId) ?? []), at])
    const info = {
      sessionId,
      error: entry.payload.error,
      waitedMs: at - entry.failedAt,
      attempts: entry.attempts,
      probeMs: probe.ms,
      probeStatus: probe.status
    }
    this.deps.log.info('Resumed the session after a transient API error', info)
    this.deps.mark?.('session-auto-resume', info)
    const payload: ClaudeCliAutoResumePayload = {
      sessionId,
      error: entry.payload.error,
      summary: summariseApiError(entry.payload),
      waitedMs: at - entry.failedAt
    }
    try {
      await this.deps.publish(CLAUDE_CLI_AUTO_RESUME_CHANNEL, payload)
    } catch {
      // a missing renderer is not a failure
    }
  }
}

// ------------------------------------------------------------------ singleton

let instance: ClaudeCliSessionRecovery | null = null

/** Wire the service with its main-process dependencies (once, at startup). */
export function configureClaudeCliSessionRecovery(deps: ClaudeCliSessionRecoveryDeps): ClaudeCliSessionRecovery {
  instance?.dispose()
  instance = new ClaudeCliSessionRecovery(deps)
  return instance
}

export function getClaudeCliSessionRecovery(): ClaudeCliSessionRecovery | null {
  return instance
}

/** Hook server entry point: a StopFailure arrived for a session. */
export function noteClaudeCliApiErrorForRecovery(payload: ClaudeCliApiErrorPayload): void {
  instance?.noteApiError(payload)
}

/** Terminal write entry point: the user typed into a session. */
export function noteClaudeCliUserInputForRecovery(sessionId: string, data: string): void {
  instance?.noteUserInput(sessionId, data)
}

export function noteClaudeCliSessionGoneForRecovery(sessionId: string): void {
  instance?.noteSessionGone(sessionId)
}

export function disposeClaudeCliSessionRecovery(): void {
  instance?.dispose()
  instance = null
}

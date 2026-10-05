import {
  USER_INTERRUPT_DETAIL,
  WAITING_PREFIX,
  isRunSettled,
  isRunWaitingOnUser,
  isTerminalItemStatus,
  launchableItems,
  nextMergeCandidate,
  ticketBranchHint
} from '@shared/document-flow/planning'
import {
  buildConflictPrompt,
  buildContinuePrompt,
  buildFixTicket,
  buildLaunchPrompt,
  buildNudgePrompt
} from '@shared/document-flow/prompts'
import {
  DOCUMENT_RUN_ITEM_MERGE_STATUSES,
  type DocumentRun,
  type DocumentRunDetail,
  type DocumentRunItem,
  type DocumentRunItemPatch,
  type DocumentRunItemStatus,
  type DocumentRunLaunchConfig,
  type DocumentVerifyResult,
  type SessionFinalMessage
} from '@shared/types/document-flow'
import type { TicketLaunchResult, TicketLaunchSpec } from '@/lib/ticket-launch'
import type { RunnerPorts, RunnerTicket, RunnerTimer, RunnerWorktree } from './runner-ports'
import { USER_ABORT_REASON, type SessionBlockReason, type SessionSignal } from './session-signal'

// The orchestrator of a launched document run. It is a level-triggered reconciliation loop:
// the run's state lives in the server's rows, and every tick compares each item's persisted
// status with what can be observed (the session's signal, the board, git through the RPC
// API) and moves the item at most one step. Nothing here is authoritative — after a reload
// or an app restart a fresh runner picks every item up from its row, so each step is written
// to be safe to repeat. Memory holds only what prevents doing the same thing twice at once.

export const TICK_INTERVAL_MS = 10_000
export const TICK_DEBOUNCE_MS = 100
/** A turn end must stand this long before it is acted on: sessions bounce in and out of completed. */
export const SETTLE_MS = 3_000
export const MAX_CONTINUE = 5
/** Wait before the n-th automatic "continue" after an API error. */
export const BACKOFF_MINUTES = [2, 10, 30, 60, 60]
export const MAX_NUDGES = 2
export const MAX_CONFLICT_ATTEMPTS = 2
export const MAX_FIX_ATTEMPTS = 2

const LEASE_RENEW_MS = 5_000
const SESSION_TURN_POLL_MS = 5_000
const SNAPSHOT_GRACE_MS = 3_000
/** After a step failed to reach the server, the item is left alone until an interval tick. */
const RETRY_COOLDOWN_MS = 5_000
const FINALIZE_RETRY_MS = 60_000
const VERIFY_OUTPUT_TAIL = 600

const API_ERROR_PREFIX = 'API error ('
// A fix session has no Retry: its merge stays in the integration worktree until it goes on.
const FIX_INTERRUPT_DETAIL = `${WAITING_PREFIX}you interrupted the fix session. Send it a message to continue.`
const SETUP_WAIT_DETAIL = 'Waiting for the setup script to finish in the integration worktree.'
const NO_CHANGES_DETAIL = 'The agent reported done, but its branch has no commits to merge.'

const BLOCK_LABELS: Record<SessionBlockReason, string> = {
  question: 'a question',
  permission: 'a permission request',
  command_approval: 'a command to approve',
  plan: 'a plan to approve'
}

// Ends that are not the agent finishing a turn, for sessions that carry no `completion`
// (codex, SDK): the user pressed Escape or Stop, or the process went away.
const USER_INTERRUPT_REASONS: ReadonlySet<string> = new Set([
  'user_interrupt',
  'codex_turn_aborted',
  USER_ABORT_REASON
])
const PROCESS_END_REASONS: ReadonlySet<string> = new Set(['pty_exit'])
// The CLI's own lifecycle hooks also publish "completed": SessionEnd when the process goes
// away (its pty_exit is then deduplicated away), SessionStart moments before the launch
// prompt is submitted — as does the PTY bridge when it starts a process with nothing to do.
const PROCESS_END_HOOKS: ReadonlySet<string> = new Set(['SessionEnd'])
const SESSION_START_HOOK = 'SessionStart'
const PROCESS_START_REASON = 'pty_start'

// The server records the blocking status under the CLI's name for it, and a turn the user
// stopped under `Interrupt`.
const RECORDED_BLOCK_REASONS: Record<string, SessionBlockReason> = {
  answering: 'question',
  permission: 'permission',
  plan_ready: 'plan',
  command_approval: 'command_approval'
}
const RECORDED_INTERRUPT_EVENT = 'Interrupt'

/**
 * A run the orchestrator is busy on between sessions (classifying, merging, verifying, about
 * to launch): launched, with work left, and not merely waiting on the user. Keep-awake and
 * sleep-when-idle read this, because no session need be streaming at those moments.
 */
export function isDocumentRunBusy(detail: DocumentRunDetail): boolean {
  if (detail.run.status !== 'running') return false
  const hasOpenItems = detail.items.some(
    (item) => item.selected && !isTerminalItemStatus(item.status)
  )
  return (
    hasOpenItems &&
    !isRunSettled(detail.items) &&
    !isRunWaitingOnUser(detail.items, detail.run.config.maxParallel)
  )
}

export function hasBusyDocumentRun(runsById: Record<string, DocumentRunDetail>): boolean {
  return Object.values(runsById).some(isDocumentRunBusy)
}

/** The run or the item moved on under a step (user action, pause, cancel): stop, flag nothing. */
class Superseded extends Error {}

interface RunState {
  ticking: boolean
  again: boolean
  lease: { owned: boolean; at: number; serverStartedAt: number } | null
  /** The project's worktrees and board were loaded for this run in this renderer session. */
  loaded: boolean
  /** In-memory half of "one merge at a time"; the items' merge statuses are the other half. */
  merging: boolean
  /** Ticket launches queued or under way: each cuts a branch from the integration tip. */
  launching: number
  finalizing: boolean
  finalizeRetryAt: number
}

interface ItemOp {
  runId: string
  /** The item's row as this step last read or wrote it. */
  item: DocumentRunItem
  /** The step persisted something, so the run is worth another look once it is done. */
  changed: boolean
}

interface SessionTarget {
  sessionId: string
  ticketId: string | null
}

type Observation =
  | { kind: 'working' }
  | { kind: 'blocked'; reason: SessionBlockReason; detail: string | null }
  /** A finished turn, newer than the last prompt and the last check, that has settled. */
  | { kind: 'turn_ended' }
  /** A fresh turn end that is still too young to trust. */
  | { kind: 'settling'; until: number }
  | { kind: 'api_error'; error: string }
  | { kind: 'interrupted'; byUser: boolean }
  /** No signal, and the app was restarted since the last prompt: the session died with it. */
  | { kind: 'restarted' }
  | { kind: 'idle' }

const IDLE: Observation = { kind: 'idle' }

const noop = (): void => {}

const toMs = (value: string | null | undefined): number => {
  if (!value) return 0
  // SQLite's own timestamps ("YYYY-MM-DD HH:MM:SS") are UTC without saying so.
  const sqlite = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value)
  const ms = Date.parse(sqlite ? `${value.replace(' ', 'T')}Z` : value)
  return Number.isNaN(ms) ? 0 : ms
}

const toIso = (ms: number): string => new Date(ms).toISOString()

const clockTime = (ms: number): string => {
  const date = new Date(ms)
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const describeError = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : String(error)

const tail = (text: string, max: number): string => {
  const trimmed = text.trim()
  return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed
}

const firstLine = (text: string): string => text.split('\n', 1)[0]

const waitingDetail = (block: { reason: SessionBlockReason; detail: string | null }): string =>
  `${WAITING_PREFIX}${block.detail ?? BLOCK_LABELS[block.reason]}`

/** Details that describe a passing condition and go stale once the session works again. */
const isTransientDetail = (detail: string | null): boolean =>
  detail !== null &&
  (detail.startsWith(WAITING_PREFIX) ||
    detail.startsWith(API_ERROR_PREFIX) ||
    detail === USER_INTERRUPT_DETAIL)

const ticketRef = (item: DocumentRunItem): { key: string; title: string } => ({
  key: item.key,
  title: item.title
})

type EndedSignal = Extract<SessionSignal, { kind: 'ended' }>

/** The server's record of a session, read like the renderer's status store. */
const recordedSignal = (turn: SessionFinalMessage, at: number): SessionSignal => {
  switch (turn.state) {
    case 'working':
      return { kind: 'working', since: at }
    case 'blocked': {
      const reason = RECORDED_BLOCK_REASONS[turn.hook_event] ?? 'question'
      const detail = turn.detail?.trim() || null
      return {
        kind: 'blocked',
        reason,
        detail: reason === 'permission' && detail ? `Permission to use ${detail}` : detail
      }
    }
    default:
      return {
        kind: 'ended',
        at,
        completion: turn.completion === 'waiting' ? 'waiting' : undefined,
        apiError: turn.api_error,
        reason: turn.hook_event === RECORDED_INTERRUPT_EVENT ? 'user_interrupt' : null,
        hookEvent: turn.hook_event || null,
        hasBackgroundWork: false
      }
  }
}

export class DocumentFlowRunner {
  private readonly runs = new Map<string, RunState>()
  /** Items with a step in flight (item id → run id): a tick never starts a second one. */
  private readonly inFlight = new Map<string, string>()
  private readonly lastWrites = new Map<string, { status: DocumentRunItemStatus; at: number }>()
  private readonly retryAfter = new Map<string, number>()
  private readonly turnPolls = new Map<string, { at: number; value: SessionFinalMessage | null }>()
  private readonly closedPolls = new Map<string, { at: number; value: boolean }>()
  /** Every launch goes through this chain: worktree and session creation never overlap. */
  private launchChain: Promise<unknown> = Promise.resolve()
  private started = false
  private unsubscribe: (() => void) | null = null
  private debounceTimer: RunnerTimer | null = null
  private intervalTimer: RunnerTimer | null = null
  private wakeTimer: RunnerTimer | null = null
  private wakeTime = 0

  constructor(private readonly ports: RunnerPorts) {}

  start(): void {
    if (this.started) return
    this.started = true
    this.unsubscribe = this.ports.subscribe(() => this.requestTick())
    this.armInterval()
    this.requestTick()
  }

  stop(): void {
    this.started = false
    this.unsubscribe?.()
    this.unsubscribe = null
    for (const timer of [this.debounceTimer, this.intervalTimer, this.wakeTimer]) {
      if (timer !== null) this.ports.clearTimeout(timer)
    }
    this.debounceTimer = null
    this.intervalTimer = null
    this.wakeTimer = null
  }

  /** Ask for a tick soon. Requests made while one is already scheduled fold into it. */
  requestTick(): void {
    if (!this.started || this.debounceTimer !== null) return
    this.debounceTimer = this.ports.setTimeout(() => {
      this.debounceTimer = null
      this.runTick()
    }, TICK_DEBOUNCE_MS)
  }

  // ── Scheduling ───────────────────────────────────────────────────────────

  private armInterval(): void {
    this.intervalTimer = this.ports.setTimeout(() => {
      this.requestTick()
      this.armInterval()
    }, TICK_INTERVAL_MS)
  }

  /** Tick again at `time` (a settle delay or a retry coming due) instead of on the interval. */
  private wakeAt(time: number): void {
    if (!this.started) return
    if (this.wakeTimer !== null) {
      if (this.wakeTime <= time) return
      this.ports.clearTimeout(this.wakeTimer)
    }
    this.wakeTime = time
    this.wakeTimer = this.ports.setTimeout(
      () => {
        this.wakeTimer = null
        this.requestTick()
      },
      Math.max(0, time - this.ports.now())
    )
  }

  private runTick(): void {
    const present = new Set<string>()
    for (const detail of this.ports.getRuns()) {
      present.add(detail.run.id)
      if (detail.run.status === 'running') void this.tickRun(detail.run.id)
    }
    for (const runId of this.runs.keys()) {
      if (!present.has(runId)) this.runs.delete(runId)
    }
  }

  private stateFor(runId: string): RunState {
    let state = this.runs.get(runId)
    if (!state) {
      state = {
        ticking: false,
        again: false,
        lease: null,
        loaded: false,
        merging: false,
        launching: 0,
        finalizing: false,
        finalizeRetryAt: 0
      }
      this.runs.set(runId, state)
    }
    return state
  }

  private async tickRun(runId: string): Promise<void> {
    const state = this.stateFor(runId)
    if (state.ticking) {
      state.again = true
      return
    }
    state.ticking = true
    try {
      await this.reconcileRun(runId, state)
    } catch (error) {
      // Left for the next interval tick; a failing tick must not retry itself hot.
      this.ports.warn(`tick failed for run ${runId}`, error)
    } finally {
      state.ticking = false
      if (state.again) {
        state.again = false
        this.requestTick()
      }
    }
  }

  // ── One tick of one run ──────────────────────────────────────────────────

  private async reconcileRun(runId: string, state: RunState): Promise<void> {
    if (!(await this.claim(runId, state))) return

    if (!state.loaded) {
      const project = this.ports.getRun(runId)?.run.project_id
      if (!project) return
      await this.ports.loadProject(project)
      state.loaded = true
      const loaded = this.ports.getRun(runId)
      if (loaded?.run.status === 'running') this.startIntegrationSetup(loaded)
    }

    const detail = this.ports.getRun(runId)
    if (!detail || detail.run.status !== 'running') return
    const { run, items } = detail
    const now = this.ports.now()

    for (const item of items) {
      if (!this.canStep(item, now)) continue
      switch (item.status) {
        case 'launching':
          this.spawn(runId, item, (op) => this.recoverLaunch(op))
          break
        case 'running':
        case 'needs_input':
        case 'resolving_conflicts':
        case 'fixing':
          this.spawn(runId, item, (op) => this.watch(op))
          break
        case 'checking':
          this.spawn(runId, item, (op) => this.check(op))
          break
        case 'merging':
        case 'verifying':
          this.spawnMerge(state, runId, item)
          break
        default:
          break
      }
    }

    for (const item of launchableItems(items, run.config.maxParallel)) {
      if (this.canStep(item, now)) this.enqueueLaunch(runId, item)
    }

    const candidate = state.merging ? null : nextMergeCandidate(items)
    if (candidate && this.canStep(candidate, now)) this.spawnMerge(state, runId, candidate)

    if (isRunSettled(items) && !this.hasStepInFlight(runId)) this.finalize(state, runId)
  }

  /** Take or renew the lease. Renewed at most every few seconds, however often ticks run. */
  private async claim(runId: string, state: RunState): Promise<boolean> {
    const now = this.ports.now()
    if (state.lease && now - state.lease.at < LEASE_RENEW_MS) return state.lease.owned
    try {
      const claim = await this.ports.api.claimRunner(runId, this.ports.clientId)
      state.lease = {
        owned: claim.owned,
        at: this.ports.now(),
        serverStartedAt: toMs(claim.serverStartedAt)
      }
    } catch (error) {
      state.lease = null
      if (!this.ports.isTransportError(error)) {
        this.ports.warn(`could not claim run ${runId}`, error)
      }
      return false
    }
    return state.lease.owned
  }

  /**
   * The server created the integration worktree, so nothing has installed its dependencies.
   * Only before the first ticket starts: a reload in the middle of a run must not start an
   * install under a verify or a fix session.
   */
  private startIntegrationSetup(detail: DocumentRunDetail): void {
    const { run, items } = detail
    const worktreeId = run.integration_worktree_id
    const cwd = run.integration_worktree_path
    if (!worktreeId || !cwd) return
    if (items.some((item) => item.started_at || item.session_id || item.merge_sha)) return
    if (this.ports.isSetupScriptRunning(worktreeId)) return
    this.ports.fireSetupScript(run.project_id, worktreeId, cwd)
  }

  private canStep(item: DocumentRunItem, now: number): boolean {
    if (!item.selected || this.inFlight.has(item.id)) return false
    const retryAfter = this.retryAfter.get(item.id)
    if (retryAfter !== undefined) {
      if (now < retryAfter) return false
      this.retryAfter.delete(item.id)
    }
    // A re-read of the run that left the server before our last write can land after it.
    // Wait for the store to show what was written rather than act on the older row.
    const written = this.lastWrites.get(item.id)
    if (!written) return true
    if (now - written.at >= SNAPSHOT_GRACE_MS) {
      this.lastWrites.delete(item.id)
      return true
    }
    if (written.status === item.status) return true
    this.wakeAt(written.at + SNAPSHOT_GRACE_MS)
    return false
  }

  private hasStepInFlight(runId: string): boolean {
    for (const owner of this.inFlight.values()) {
      if (owner === runId) return true
    }
    return false
  }

  // ── Running one item's step ──────────────────────────────────────────────

  private spawn(
    runId: string,
    item: DocumentRunItem,
    work: (op: ItemOp) => Promise<void>,
    onDone: () => void = noop
  ): void {
    const op: ItemOp = { runId, item, changed: false }
    this.inFlight.set(item.id, runId)
    void this.runStep(op, work).finally(() => {
      this.inFlight.delete(item.id)
      onDone()
      if (op.changed) this.requestTick()
    })
  }

  private spawnMerge(state: RunState, runId: string, item: DocumentRunItem): void {
    // A launch under way cuts its branch from the integration tip, which must not move under
    // it; the merge waits for the launch, as a launch waits for a merge (see `launchBase`).
    if (state.merging || state.launching > 0) return
    state.merging = true
    this.spawn(
      runId,
      item,
      (op) => this.merge(op),
      () => {
        state.merging = false
      }
    )
  }

  /** Never rejects: a failing step flags its own item and nothing else. */
  private async runStep(op: ItemOp, work: (op: ItemOp) => Promise<void>): Promise<void> {
    try {
      await work(op)
    } catch (error) {
      if (error instanceof Superseded) return
      if (this.ports.isTransportError(error)) {
        // The server is unreachable: the item stays as it is and a later tick retries.
        this.retryAfter.set(op.item.id, this.ports.now() + RETRY_COOLDOWN_MS)
        this.ports.warn(`${op.item.key}: server unreachable, will retry`, error)
        return
      }
      try {
        await this.giveUp(op, describeError(error))
      } catch (flagError) {
        if (flagError instanceof Superseded) return
        this.retryAfter.set(op.item.id, this.ports.now() + RETRY_COOLDOWN_MS)
        this.ports.warn(`${op.item.key}: could not record a failure`, flagError)
      }
    }
  }

  private currentItem(op: ItemOp): { run: DocumentRun; item: DocumentRunItem } | null {
    const detail = this.ports.getRun(op.runId)
    const item = detail?.items.find((candidate) => candidate.id === op.item.id)
    return detail && item ? { run: detail.run, item } : null
  }

  /** The run, if this runner may still act on it; steps call this before every side effect. */
  private requireActive(op: ItemOp): DocumentRun {
    const current = this.currentItem(op)
    const lease = this.runs.get(op.runId)?.lease
    if (!current || current.run.status !== 'running' || !lease?.owned) throw new Superseded()
    return current.run
  }

  /**
   * Persist a transition. Refused when the item is no longer in the status this step is
   * working on (the user skipped or retried it meanwhile) or the run is over; a paused run
   * still records the result of a step that was already under way.
   */
  private async patch(op: ItemOp, patch: DocumentRunItemPatch): Promise<DocumentRunItem> {
    const current = this.currentItem(op)
    if (
      !current ||
      (current.run.status !== 'running' && current.run.status !== 'paused') ||
      current.item.status !== op.item.status
    ) {
      throw new Superseded()
    }
    const updated = await this.ports.updateItem(op.runId, op.item.id, patch)
    op.item = updated
    op.changed = true
    this.lastWrites.set(updated.id, { status: updated.status, at: this.ports.now() })
    this.requestTick()
    return updated
  }

  private event(op: ItemOp, type: string, message: string, data?: unknown): void {
    this.ports.api
      .logEvent({
        runId: op.runId,
        itemId: op.item.id,
        type,
        message,
        ...(data === undefined ? {} : { data })
      })
      .catch(noop)
  }

  private async flag(op: ItemOp, detail: string, extra: DocumentRunItemPatch = {}): Promise<void> {
    await this.patch(op, { ...extra, status: 'needs_attention', status_detail: detail })
    this.ports.notify({
      level: 'warning',
      message: `${op.item.key} needs attention: ${firstLine(detail)}`
    })
    this.event(op, 'needs_attention', detail)
  }

  /**
   * Give up on an item. While it is being verified or fixed, its merge sits on the integration
   * branch without passing checks; that must not stay underneath the tickets merged next.
   */
  private async giveUp(op: ItemOp, detail: string): Promise<void> {
    if (op.item.status !== 'verifying' && op.item.status !== 'fixing') {
      return this.flag(op, detail)
    }
    const rollbackError = await this.rollback(op)
    const reason = /[.!?]$/.test(detail) ? detail : `${detail}.`
    await this.flag(
      op,
      rollbackError
        ? `${reason} The merge could not be rolled back: ${rollbackError}`
        : `${reason} The merge was rolled back.`
    )
  }

  private async waitForUser(op: ItemOp, detail: string): Promise<void> {
    if (op.item.status === 'running') {
      await this.patch(op, { status: 'needs_input', status_detail: detail, retry_at: null })
    } else if (op.item.status_detail !== detail) {
      // Merging and fixing keep their status (and so the integration worktree) while they wait.
      await this.patch(op, { status_detail: detail })
    } else {
      return
    }
    this.ports.notify({ level: 'info', message: `${op.item.key} is waiting for you: ${detail}` })
    this.event(op, 'needs_input', detail)
  }

  // ── Watching a session ───────────────────────────────────────────────────

  /** Ask the server about a session at most once per poll interval, however often ticks run. */
  private async polled<T>(
    cache: Map<string, { at: number; value: T }>,
    key: string,
    fetch: () => Promise<T>
  ): Promise<T> {
    const now = this.ports.now()
    const cached = cache.get(key)
    if (cached && now - cached.at < SESSION_TURN_POLL_MS) return cached.value
    const value = await fetch()
    cache.set(key, { at: now, value })
    return value
  }

  /**
   * The server's record of what the session last did, and when. A turn end stays true for as
   * long as it stands; a blocked or working state from before the app started belongs to a
   * process that died with it.
   */
  private async recordedState(
    op: ItemOp,
    sessionId: string
  ): Promise<{ at: number; signal: SessionSignal } | null> {
    const turn = await this.polled(this.turnPolls, sessionId, () =>
      this.ports.api.sessionTurn(sessionId)
    )
    if (!turn) return null
    const at = toMs(turn.updated_at)
    const serverStartedAt = this.runs.get(op.runId)?.lease?.serverStartedAt ?? 0
    if (turn.state !== 'ended' && at < serverStartedAt) return null
    return { at, signal: recordedSignal(turn, at) }
  }

  /**
   * The renderer's signal, corrected by the server's record where that is newer. The status
   * store misses what happened while the session's view was unmounted, a push was lost or the
   * page reloaded; the record misses nothing but says less, so it only overrides a status it
   * postdates — and only after the last prompt, which both must answer.
   */
  private async reconcile(
    op: ItemOp,
    sessionId: string,
    signal: SessionSignal
  ): Promise<SessionSignal> {
    if (signal.kind === 'blocked') return signal
    const promptedAt = toMs(op.item.last_prompt_at)
    if (signal.kind === 'ended' && signal.at > promptedAt) return signal
    const recorded = await this.recordedState(op, sessionId)
    if (!recorded || recorded.at <= promptedAt) return signal
    if (signal.kind === 'working' && recorded.at <= (signal.since ?? 0)) return signal
    // Closing a session in the app kills its process without a status and clears its entry;
    // the working or blocked state the server recorded before that is no longer true (so a
    // Retry or a "mark done" can judge or merge it), while a turn that had ended stands.
    if (
      signal.kind === 'unknown' &&
      recorded.signal.kind !== 'ended' &&
      (await this.isClosed(sessionId))
    ) {
      return signal
    }
    return recorded.signal
  }

  private async observe(op: ItemOp, sessionId: string): Promise<Observation> {
    const raw = this.ports.getSessionSignal(sessionId)
    const signal = await this.reconcile(op, sessionId, raw)
    if (signal.kind === 'working' || signal.kind === 'blocked') return signal

    const promptedAt = toMs(op.item.last_prompt_at)
    if (signal.kind === 'ended' && signal.at > promptedAt) {
      const seen = this.observeEnd(op, signal)
      if (seen) return seen
    }
    // No signal and no turn end recorded since the prompt: the user closed the session in the
    // app (its tab, its ticket moved back), or it died with the app.
    if (raw.kind === 'unknown') {
      if (await this.isClosed(sessionId)) return { kind: 'interrupted', byUser: true }
      const serverStartedAt = this.runs.get(op.runId)?.lease?.serverStartedAt ?? 0
      if (promptedAt < serverStartedAt) return { kind: 'restarted' }
    }
    return IDLE
  }

  private isClosed(sessionId: string): Promise<boolean> {
    return this.polled(this.closedPolls, sessionId, () => this.ports.isSessionClosed(sessionId))
  }

  /** What an end newer than the last prompt means; null when it means nothing yet. */
  private observeEnd(op: ItemOp, end: EndedSignal): Observation | null {
    const now = this.ports.now()
    // Every kind of end waits out the settle delay: a CLI session publishes a bare
    // "completed" at startup, moments before its first prompt puts it to work.
    if (now - end.at < SETTLE_MS) return { kind: 'settling', until: end.at + SETTLE_MS }
    if (end.apiError) return { kind: 'api_error', error: end.apiError }
    const reason = end.reason ?? ''
    if (USER_INTERRUPT_REASONS.has(reason)) return { kind: 'interrupted', byUser: true }
    // A session that is starting up has not been interrupted; its prompt is on its way.
    if (end.hookEvent === SESSION_START_HOOK || reason === PROCESS_START_REASON) return IDLE
    if (
      end.completion === 'none' ||
      PROCESS_END_REASONS.has(reason) ||
      PROCESS_END_HOOKS.has(end.hookEvent ?? '')
    ) {
      return { kind: 'interrupted', byUser: false }
    }
    // `waiting`: the agent paused for background work and will wake itself.
    if (end.completion !== 'waiting' && end.at > toMs(op.item.last_checked_at)) {
      return { kind: 'turn_ended' }
    }
    return null
  }

  private async watch(op: ItemOp): Promise<void> {
    const item = op.item
    const fixing = item.status === 'fixing'
    const sessionId = fixing ? item.fix_session_id : item.session_id
    if (!sessionId) {
      if (fixing) return this.recoverFixLaunch(op)
      return this.flag(op, 'It has no session to watch.')
    }
    const target: SessionTarget = {
      sessionId,
      ticketId: fixing ? item.fix_ticket_id : item.ticket_id
    }
    const seen = await this.observe(op, sessionId)

    if (seen.kind === 'settling') {
      this.wakeAt(seen.until)
      return
    }

    if (item.status === 'needs_input') {
      // Never prompted on its own: an item that waits for the user only follows the session.
      if (seen.kind === 'working') {
        await this.patch(op, { status: 'running', status_detail: null })
      } else if (seen.kind === 'turn_ended') {
        await this.patch(op, { status: 'checking', status_detail: null })
      } else if (seen.kind === 'blocked') {
        await this.waitForUser(op, waitingDetail(seen))
      }
      return
    }

    switch (seen.kind) {
      case 'working': {
        const stale = isTransientDetail(item.status_detail)
        if (!item.retry_at && !stale) return
        await this.patch(op, {
          status_detail: stale ? this.workingDetail(item) : item.status_detail,
          retry_at: null
        })
        return
      }
      case 'blocked':
        return this.waitForUser(op, waitingDetail(seen))
      case 'turn_ended':
        return this.turnEnded(op)
      default:
        return this.stalled(op, target, seen)
    }
  }

  private workingDetail(item: DocumentRunItem): string | null {
    if (item.status === 'resolving_conflicts') return 'Resolving conflicts'
    if (item.status === 'fixing') return `Fixing failed checks (attempt ${item.fix_attempts})`
    return null
  }

  private async turnEnded(op: ItemOp): Promise<void> {
    // A turn that ended cleanly: the session is healthy again, so later failures start over.
    const healthy: DocumentRunItemPatch = { status_detail: null, retry_at: null }
    if (op.item.continue_attempts > 0) healthy.continue_attempts = 0

    switch (op.item.status) {
      case 'running':
        await this.patch(op, { ...healthy, status: 'checking' })
        return
      case 'resolving_conflicts':
        // Judged again: the resolution may end on a question, and what the first verdict
        // said about manual steps and migrations predates the merge. The next dry run
        // still decides whether the conflicts are gone.
        await this.patch(op, { ...healthy, status: 'checking' })
        return
      case 'fixing': {
        const state = this.stateFor(op.runId)
        if (state.merging) return
        state.merging = true
        try {
          await this.afterFix(op, healthy)
        } finally {
          state.merging = false
        }
        return
      }
      default:
        return
    }
  }

  /** The session is not working and has not finished: an API error, an interruption, a restart. */
  private async stalled(op: ItemOp, target: SessionTarget, seen: Observation): Promise<void> {
    const item = op.item
    const now = this.ports.now()

    if (item.retry_at) {
      const retryAt = toMs(item.retry_at)
      if (now < retryAt) {
        this.wakeAt(retryAt)
        return
      }
      return this.sendContinue(op, target, 'api_error')
    }

    switch (seen.kind) {
      case 'api_error': {
        if (item.continue_attempts >= MAX_CONTINUE) {
          return this.giveUp(op, `The session keeps failing with an API error (${seen.error}).`)
        }
        const minutes =
          BACKOFF_MINUTES[Math.min(item.continue_attempts, BACKOFF_MINUTES.length - 1)]
        const retryAt = now + minutes * 60_000
        await this.patch(op, {
          retry_at: toIso(retryAt),
          status_detail: `${API_ERROR_PREFIX}${seen.error}). Retrying at ${clockTime(retryAt)}.`
        })
        this.event(op, 'api_error', `API error (${seen.error}); retrying in ${minutes} min`)
        return
      }
      case 'interrupted':
        if (seen.byUser) {
          return this.waitForUser(
            op,
            item.status === 'fixing' ? FIX_INTERRUPT_DETAIL : USER_INTERRUPT_DETAIL
          )
        }
        return this.resumeInterrupted(op, target)
      case 'restarted':
        return this.resumeInterrupted(op, target)
      default:
        return
    }
  }

  private async resumeInterrupted(op: ItemOp, target: SessionTarget): Promise<void> {
    if (op.item.continue_attempts >= MAX_CONTINUE) {
      return this.giveUp(op, 'The session was interrupted and could not be resumed.')
    }
    return this.sendContinue(op, target, 'interrupted')
  }

  private async sendContinue(
    op: ItemOp,
    target: SessionTarget,
    reason: 'api_error' | 'interrupted'
  ): Promise<void> {
    this.requireActive(op)
    const transient = isTransientDetail(op.item.status_detail)
    const sent = await this.followUp(op, target, buildContinuePrompt(reason), {
      continue_attempts: op.item.continue_attempts + 1,
      retry_at: null,
      status_detail: transient ? this.workingDetail(op.item) : op.item.status_detail
    })
    if (sent) this.event(op, 'continue_sent', `Asked the session to continue (${reason})`)
  }

  /**
   * Send a prompt to a session the item waits on. `last_prompt_at` is written first, so the
   * completed signal still standing from the previous turn can never read as the answer.
   */
  private async followUp(
    op: ItemOp,
    target: SessionTarget,
    prompt: string,
    patch: DocumentRunItemPatch
  ): Promise<boolean> {
    await this.patch(op, { ...patch, last_prompt_at: toIso(this.ports.now()) })
    try {
      await this.ports.sendFollowup({
        sessionId: target.sessionId,
        ticketId: target.ticketId ?? '',
        prompt
      })
      return true
    } catch (error) {
      await this.giveUp(op, `Could not send a message to the session: ${describeError(error)}`)
      return false
    }
  }

  // ── Checking a finished turn ─────────────────────────────────────────────

  private async check(op: ItemOp): Promise<void> {
    const item = op.item
    const sessionId = item.session_id
    if (!sessionId) return this.flag(op, 'It has no session to check.')

    // Judge only a session at rest; one that is busy again will end another turn, and one
    // that failed since is handled by the watcher's backoff, not by a verdict.
    const before = await this.reconcile(op, sessionId, this.ports.getSessionSignal(sessionId))
    if (await this.followMovingSession(op, before)) return
    if (before.kind === 'ended' && before.apiError && before.at > toMs(item.last_prompt_at)) {
      await this.patch(op, { status: 'running' })
      return
    }

    const judgedAt = toIso(before.kind === 'ended' ? before.at : this.ports.now())
    const finalMessage = await this.ports.readFinalMessage(sessionId).catch(() => null)
    const verdict = await this.ports.api.classify({
      runId: op.runId,
      itemId: item.id,
      ...(finalMessage ? { finalMessage } : {})
    })
    const checked: DocumentRunItemPatch = { last_checked_at: judgedAt }

    // Classifying takes a while; the verdict is void if the session moved on meanwhile.
    const after = await this.reconcile(op, sessionId, this.ports.getSessionSignal(sessionId))
    if (await this.followMovingSession(op, after, checked)) return

    const reason = verdict.reason.trim() || 'The agent did not finish the task.'
    switch (verdict.status) {
      case 'done':
        await this.patch(op, { ...checked, status: 'ready', status_detail: null })
        return
      case 'needs_input': {
        const question = verdict.question?.trim() || reason
        await this.patch(op, { ...checked, status: 'needs_input', status_detail: question })
        this.ports.notify({ level: 'info', message: `${item.key} is waiting for you: ${question}` })
        this.event(op, 'needs_input', question)
        return
      }
      case 'partial': {
        if (item.nudge_count >= MAX_NUDGES) return this.flag(op, reason, checked)
        this.requireActive(op)
        const sent = await this.followUp(
          op,
          { sessionId, ticketId: item.ticket_id },
          buildNudgePrompt({ reason }),
          {
            ...checked,
            status: 'running',
            nudge_count: item.nudge_count + 1,
            status_detail: `Asked to finish: ${reason}`
          }
        )
        if (sent) this.event(op, 'nudged', reason)
        return
      }
      default:
        return this.flag(op, reason, checked)
    }
  }

  private async followMovingSession(
    op: ItemOp,
    signal: SessionSignal,
    extra: DocumentRunItemPatch = {}
  ): Promise<boolean> {
    if (signal.kind === 'working') {
      await this.patch(op, { ...extra, status: 'running', status_detail: null })
      return true
    }
    if (signal.kind === 'blocked') {
      const detail = waitingDetail(signal)
      await this.patch(op, { ...extra, status: 'needs_input', status_detail: detail })
      this.ports.notify({ level: 'info', message: `${op.item.key} is waiting for you: ${detail}` })
      this.event(op, 'needs_input', detail)
      return true
    }
    return false
  }

  // ── Launching ────────────────────────────────────────────────────────────

  private exclusiveLaunch(spec: TicketLaunchSpec): Promise<TicketLaunchResult> {
    const result = this.launchChain.then(() => this.ports.launchTicket(spec))
    this.launchChain = result.catch(noop)
    return result
  }

  private enqueueLaunch(runId: string, item: DocumentRunItem): void {
    const op: ItemOp = { runId, item, changed: false }
    const state = this.stateFor(runId)
    this.inFlight.set(item.id, runId)
    state.launching += 1
    const turn = this.launchChain.then(() => this.runStep(op, (step) => this.launchItem(step)))
    this.launchChain = turn
    void turn.finally(() => {
      this.inFlight.delete(item.id)
      state.launching -= 1
      if (op.changed) this.requestTick()
    })
  }

  /**
   * The commit a ticket branch is cut from: the integration tip, unless a merge is landing on
   * it. A merge is only safe to build on once its checks passed — until then it may be rolled
   * back — so while one is merging, verifying or being fixed, the branch starts from the
   * commit before it. Undefined while that commit is not recorded yet (the next tick retries).
   */
  private launchBase(
    items: readonly DocumentRunItem[],
    state: RunState,
    branch: string
  ): string | undefined {
    const landing = items.find(
      (item) => item.selected && DOCUMENT_RUN_ITEM_MERGE_STATUSES.includes(item.status)
    )
    if (landing) return landing.pre_merge_sha ?? undefined
    return state.merging ? undefined : branch
  }

  private launchConfig(run: DocumentRun, item: DocumentRunItem): DocumentRunLaunchConfig {
    return item.launch_config ?? run.config.defaultLaunch ?? this.ports.resolveDefaultLaunch()
  }

  private ticketExtras(projectId: string): TicketLaunchSpec['ticketUpdateExtras'] {
    return {
      column: 'in_progress',
      sort_order: this.ports.topSortOrder(projectId, 'in_progress'),
      plan_ready: false,
      pending_launch_config: null
    }
  }

  private async findTicket(
    projectId: string,
    ticketId: string | null
  ): Promise<RunnerTicket | null> {
    if (!ticketId) return null
    const loaded = this.ports.getTicket(projectId, ticketId)
    if (loaded) return loaded
    await this.ports.reloadTickets(projectId)
    return this.ports.getTicket(projectId, ticketId)
  }

  private async findWorktree(
    projectId: string,
    worktreeId: string | null | undefined
  ): Promise<RunnerWorktree | null> {
    if (!worktreeId) return null
    const loaded = this.ports.getWorktree(worktreeId)
    if (loaded) return loaded
    await this.ports.reloadWorktrees(projectId)
    return this.ports.getWorktree(worktreeId)
  }

  private async launchItem(op: ItemOp): Promise<void> {
    // The item waited in the launch chain: launch only if it is still its turn.
    const detail = this.ports.getRun(op.runId)
    const item = detail?.items.find((candidate) => candidate.id === op.item.id)
    if (!detail || !item) return
    if (!launchableItems(detail.items, detail.run.config.maxParallel).includes(item)) return
    op.item = item
    const run = this.requireActive(op)
    const branch = run.integration_branch
    if (!branch) return this.flag(op, 'The run has no integration branch to start from.')
    const baseRef = this.launchBase(detail.items, this.stateFor(op.runId), branch)
    if (baseRef === undefined) return

    const startedAt = toIso(this.ports.now())
    await this.patch(op, { status: 'launching', status_detail: null, started_at: startedAt })

    const ticket = await this.findTicket(run.project_id, item.ticket_id)
    if (!ticket) return this.flag(op, 'Its ticket no longer exists.')

    const modelConfig = this.launchConfig(run, item)
    // The agent gets the brief alone: the ticket's description and attachments stay on the
    // board for people, and the agent reads the task in the document itself.
    const prompt = buildLaunchPrompt({
      key: item.key,
      title: item.title,
      sourcePath: run.source_path,
      promptStyle: run.config.promptStyle,
      interactive: run.config.interactive,
      sdk: modelConfig.sdk
    })

    const result = await this.ports.launchTicket({
      ticketId: ticket.id,
      projectId: run.project_id,
      ticketTitle: ticket.title,
      // `baseRef` cuts the branch from the verified integration commit without copying the
      // integration worktree's uncommitted files; no auto-pull, which could move the user's
      // checkout. The source branch is only what the worktree records as its merge target:
      // the run's base branch, so the board merges this ticket (a follow-up after the run,
      // say) straight into it, also once the integration branch is gone.
      worktree: {
        type: 'new',
        sourceBranch: run.base_branch ?? branch,
        baseRef,
        autoPull: false,
        select: false,
        nameHint: ticketBranchHint(item.key, item.title)
      },
      prompt,
      mode: 'build',
      modelConfig,
      goalMode: false,
      goalSuccessCriteria: null,
      ticketUpdateExtras: this.ticketExtras(run.project_id)
    })

    if (!result.success || !result.sessionId) {
      const error = result.error ?? 'unknown error'
      await this.cleanUpFailedLaunch(run.project_id, ticket.id, result.sessionId)
      this.event(op, 'launch_failed', error, { worktreeId: result.worktreeId ?? null })
      // No session is recorded, so Retry launches the ticket again.
      return this.flag(op, `Could not launch: ${error}`, { session_id: null })
    }

    // The created row carries the real branch name: a taken name gets a numeric suffix.
    const worktree = await this.findWorktree(run.project_id, result.worktreeId)
    await this.patch(op, {
      status: 'running',
      status_detail: null,
      session_id: result.sessionId,
      worktree_id: result.worktreeId ?? null,
      branch_name: worktree?.branch_name ?? null,
      // Launch start, not now: whatever the new session reports is newer than this.
      last_prompt_at: startedAt
    })
    this.event(op, 'launched', `Launched ${item.key} on ${worktree?.branch_name ?? 'a new branch'}`)
  }

  /** Same recovery as a failed multi-model launch: no phantom session, ticket back in To Do. */
  private async cleanUpFailedLaunch(
    projectId: string,
    ticketId: string,
    sessionId: string | undefined
  ): Promise<void> {
    if (sessionId) {
      await this.ports
        .completeOrphanSession(sessionId)
        .catch((error) => this.ports.warn('could not close the session of a failed launch', error))
    }
    await this.ports
      .resetTicketToTodo(projectId, ticketId)
      .catch((error) => this.ports.warn('could not reset the ticket of a failed launch', error))
  }

  /** `launching` with no launch in flight: this renderer was reloaded in the middle of one. */
  private async recoverLaunch(op: ItemOp): Promise<void> {
    const run = this.requireActive(op)
    const ticket = await this.findTicket(run.project_id, op.item.ticket_id)
    if (!ticket?.current_session_id) {
      await this.patch(op, { status: 'pending', status_detail: null, started_at: null })
      return
    }
    // The ticket is linked to its session before the agent is started with the prompt, which
    // lived only in the reloaded page: a session that never started cannot be adopted.
    if (!(await this.ports.isSessionStarted(ticket.current_session_id))) {
      await this.cleanUpFailedLaunch(run.project_id, ticket.id, ticket.current_session_id)
      this.event(op, 'launch_failed', 'The session was never started; launching again')
      await this.patch(op, { status: 'pending', status_detail: null, started_at: null })
      return
    }
    const worktree = await this.findWorktree(run.project_id, ticket.worktree_id)
    await this.patch(op, {
      status: 'running',
      status_detail: null,
      session_id: ticket.current_session_id,
      worktree_id: ticket.worktree_id,
      branch_name: worktree?.branch_name ?? null,
      last_prompt_at: op.item.started_at ?? toIso(this.ports.now())
    })
    this.event(op, 'launched', `Picked up the session ${op.item.key} was launched with`)
  }

  // ── Merging ──────────────────────────────────────────────────────────────

  private async merge(op: ItemOp): Promise<void> {
    const run = this.requireActive(op)
    // Picked up in the middle (a reload, a crash): a recorded merge commit means the merge
    // itself is behind us. A ticket coming from `ready` always goes through the dry run.
    const resumed = op.item.status !== 'ready'
    if (!resumed) {
      // Judged done, but busy again since (told to go on by the user, or marked done by hand
      // while its agent still works): what is on the branch now is not the end of its work.
      if (op.item.session_id) {
        const signal = this.ports.getSessionSignal(op.item.session_id)
        const current = await this.reconcile(op, op.item.session_id, signal)
        if (await this.followMovingSession(op, current)) return
      }
      await this.patch(op, { status: 'merging', status_detail: null })
    }
    if (op.item.status === 'verifying' || (resumed && op.item.merge_sha)) return this.verify(op)

    const check = await this.ports.api.prepareMerge(op.runId, op.item.id)
    if (check.state === 'error') {
      return this.flag(op, check.error ?? 'The merge could not be prepared.')
    }
    const integrationCommit = check.integrationHead ?? null
    if (check.state === 'conflict') {
      return this.resolveConflict(op, run, check.conflictedFiles, integrationCommit)
    }
    if (check.state === 'no_changes' && !check.alreadyMerged) {
      return this.flag(op, NO_CHANGES_DETAIL)
    }

    this.requireActive(op)
    const result = await this.ports.api.merge(op.runId, op.item.id)
    if (result.success) return this.verify(op)
    if (result.conflictedFiles?.length) {
      return this.resolveConflict(op, run, result.conflictedFiles, integrationCommit)
    }
    return this.flag(op, result.error ?? 'The merge failed.')
  }

  /** Conflicts are resolved by the ticket's own session, on its own branch. */
  private async resolveConflict(
    op: ItemOp,
    run: DocumentRun,
    files: string[],
    integrationCommit: string | null
  ): Promise<void> {
    const item = op.item
    const branch = run.integration_branch ?? 'the integration branch'
    this.event(op, 'conflict', `Conflicts with ${branch} in ${files.length} file(s)`, { files })
    // A session that resolved against one tip and was overtaken by another ticket's merge has
    // not failed: only attempts against the same integration commit count towards the limit.
    // Each such lap needs another merge to land, so the tickets of the run bound them.
    const overtaken =
      integrationCommit !== null &&
      item.conflict_head !== null &&
      item.conflict_head !== integrationCommit
    const attempts = overtaken ? 0 : item.conflict_attempts
    if (attempts >= MAX_CONFLICT_ATTEMPTS) {
      return this.flag(
        op,
        `Still conflicts with ${branch} after ${MAX_CONFLICT_ATTEMPTS} attempts: ${files.join(', ')}`
      )
    }
    if (!item.session_id) {
      return this.flag(
        op,
        `Conflicts with ${branch}, and there is no session to resolve them: ${files.join(', ')}`
      )
    }
    this.requireActive(op)
    const items = this.ports.getRun(op.runId)?.items ?? []
    const attempt = attempts + 1
    // Only what landed after this ticket's branch was cut is news to its session; what was
    // merged before is on its branch already.
    const cutAt = toMs(item.started_at)
    await this.followUp(
      op,
      { sessionId: item.session_id, ticketId: item.ticket_id },
      buildConflictPrompt({
        integrationBranch: branch,
        integrationCommit,
        conflictedFiles: files,
        mergedTickets: items
          .filter(
            (other) =>
              other.selected &&
              other.status === 'merged' &&
              (!other.finished_at || toMs(other.finished_at) > cutAt)
          )
          .map(ticketRef),
        attempt
      }),
      {
        status: 'resolving_conflicts',
        conflict_attempts: attempt,
        conflict_head: integrationCommit,
        status_detail:
          files.length > 0
            ? `Resolving conflicts in ${files.length} file(s)`
            : 'Resolving conflicts'
      }
    )
  }

  private async verify(op: ItemOp): Promise<void> {
    const run = this.requireActive(op)
    if (!run.config.verifyCommand?.trim()) return this.markMerged(op)
    if (op.item.status !== 'verifying') {
      await this.patch(op, { status: 'verifying', status_detail: null })
    }

    // The checks need the dependencies the setup script is still installing; the next tick
    // finds the item verifying with nothing in flight and comes back here.
    const worktreeId = run.integration_worktree_id
    if (worktreeId && this.ports.isSetupScriptRunning(worktreeId)) {
      if (op.item.status_detail !== SETUP_WAIT_DETAIL) {
        await this.patch(op, { status_detail: SETUP_WAIT_DETAIL })
      }
      return
    }
    if (op.item.status_detail !== null) await this.patch(op, { status_detail: null })

    const result = await this.ports.api.verify(op.runId)
    if (result.ok || result.skipped) return this.markMerged(op)

    this.event(op, 'verify_failed', `Checks failed after merging ${op.item.key}`, {
      exitCode: result.exitCode,
      timedOut: result.timedOut
    })
    this.requireActive(op)
    if (op.item.fix_attempts < MAX_FIX_ATTEMPTS) return this.startFix(op, run, result)

    const rollbackError = await this.rollback(op)
    const outcome = rollbackError
      ? `and the merge could not be rolled back (${rollbackError}).`
      : 'the merge was rolled back.'
    await this.flag(
      op,
      `Checks still fail after ${MAX_FIX_ATTEMPTS} fix attempts; ${outcome}\n${tail(result.output, VERIFY_OUTPUT_TAIL)}`
    )
  }

  /** Null when the integration branch is back at the item's pre-merge commit, else why not. */
  private async rollback(op: ItemOp): Promise<string | null> {
    try {
      const result = await this.ports.api.rollbackMerge(op.runId, op.item.id)
      if (!result.success) return result.error ?? 'unknown error'
    } catch (error) {
      if (this.ports.isTransportError(error)) throw error
      return describeError(error)
    }
    this.event(op, 'rolled_back', `Rolled back the merge of ${op.item.key}`)
    return null
  }

  /** The merge was clean but the checks fail on the result: a session repairs it in place. */
  private async startFix(
    op: ItemOp,
    run: DocumentRun,
    failure: DocumentVerifyResult
  ): Promise<void> {
    const item = op.item
    const attempt = item.fix_attempts + 1
    const worktreeId = run.integration_worktree_id
    if (!worktreeId || !run.integration_branch) {
      return this.giveUp(op, 'The run has no integration worktree to fix the checks in.')
    }

    let ticket: RunnerTicket
    try {
      ticket = await this.ports.createTicket(
        run.project_id,
        buildFixTicket({
          documentTitle: run.title,
          key: item.key,
          title: item.title,
          integrationBranch: run.integration_branch,
          verifyCommand: run.config.verifyCommand ?? '',
          verifyOutput: failure.output,
          attempt
        })
      )
    } catch (error) {
      if (this.ports.isTransportError(error)) throw error
      return this.giveUp(op, `Could not create the fix ticket: ${describeError(error)}.`)
    }

    // Recorded before the launch: a reload in the middle finds the ticket instead of
    // starting a second fix session in the same worktree.
    await this.patch(op, {
      status: 'fixing',
      status_detail: `Fixing failed checks (attempt ${attempt})`,
      fix_ticket_id: ticket.id,
      fix_session_id: null,
      fix_attempts: attempt,
      last_prompt_at: toIso(this.ports.now())
    })

    const result = await this.exclusiveLaunch({
      ticketId: ticket.id,
      projectId: run.project_id,
      ticketTitle: ticket.title,
      worktree: { type: 'existing', worktreeId },
      prompt: this.ports.buildTicketPrompt(ticket),
      mode: 'build',
      modelConfig: this.launchConfig(run, item),
      goalMode: false,
      goalSuccessCriteria: null,
      ticketUpdateExtras: this.ticketExtras(run.project_id)
    })
    if (!result.success || !result.sessionId) {
      await this.cleanUpFailedLaunch(run.project_id, ticket.id, result.sessionId)
      return this.giveUp(op, `Could not start a fix session: ${result.error ?? 'unknown error'}.`)
    }
    await this.patch(op, { fix_session_id: result.sessionId })
    this.event(op, 'fix_started', `Started fix attempt ${attempt} for ${item.key}`)
  }

  /** `fixing` without a session: this renderer was reloaded while the fix session started. */
  private async recoverFixLaunch(op: ItemOp): Promise<void> {
    const run = this.requireActive(op)
    const ticket = await this.findTicket(run.project_id, op.item.fix_ticket_id)
    if (ticket?.current_session_id) {
      // Linked before the agent was started with the prompt, as in `recoverLaunch`: adopting
      // a session that never started would hold the integration worktree forever.
      if (await this.ports.isSessionStarted(ticket.current_session_id)) {
        await this.patch(op, { fix_session_id: ticket.current_session_id })
        return
      }
      await this.cleanUpFailedLaunch(run.project_id, ticket.id, ticket.current_session_id)
      this.event(op, 'launch_failed', 'The fix session was never started; verifying again')
    }
    // It never started. Verifying again starts the next attempt, or rolls the merge back.
    await this.patch(op, { status: 'verifying', status_detail: null })
  }

  private async afterFix(op: ItemOp, healthy: DocumentRunItemPatch): Promise<void> {
    const run = this.requireActive(op)
    const item = op.item
    const commit = await this.ports.api.commitIntegration(
      op.runId,
      `Fix checks after merging ${item.key}`
    )
    if (!commit.success) {
      return this.giveUp(op, `Could not commit the fix: ${commit.error ?? 'unknown error'}.`)
    }
    if (item.fix_ticket_id) {
      await this.ports
        .moveTicket(run.project_id, item.fix_ticket_id, 'done', { skipCompletionEffects: true })
        .catch((error) => this.ports.warn('could not move the fix ticket to done', error))
    }
    await this.patch(op, { ...healthy, status: 'verifying' })
    return this.verify(op)
  }

  private async markMerged(op: ItemOp): Promise<void> {
    const projectId = this.currentItem(op)?.run.project_id
    const item = await this.patch(op, {
      status: 'merged',
      status_detail: null,
      finished_at: toIso(this.ports.now())
    })
    if (projectId && item.ticket_id) {
      // A plain move to merged would fire the board's completion effects (dependent
      // auto-launch); the run schedules its own dependents.
      await this.ports
        .moveTicket(projectId, item.ticket_id, 'merged', { skipCompletionEffects: true })
        .catch((error) => this.ports.warn(`could not move ${item.key} to merged`, error))
    }
    this.event(op, 'merged', `Merged ${item.key}`)
  }

  // ── Finishing ────────────────────────────────────────────────────────────

  private finalize(state: RunState, runId: string): void {
    if (state.finalizing || this.ports.now() < state.finalizeRetryAt) return
    state.finalizing = true
    void this.ports.api
      .finalize(runId)
      .then((detail) => {
        this.ports.applyDetail(detail)
        if (detail.run.status === 'running') {
          // Not finalized after all; asking again on every tick would spin.
          state.finalizeRetryAt = this.ports.now() + FINALIZE_RETRY_MS
          return
        }
        const selected = detail.items.filter((item) => item.selected)
        const merged = selected.filter((item) => item.status === 'merged').length
        if (detail.run.status === 'completed') {
          this.ports.notify({
            level: 'success',
            message: `Document run finished: ${merged} merged`
          })
        } else {
          this.ports.notify({
            level: 'warning',
            message: `Document run finished with issues: ${merged} of ${selected.length} merged`
          })
        }
      })
      .catch((error) => {
        state.finalizeRetryAt = this.ports.now() + FINALIZE_RETRY_MS
        this.ports.warn(`could not finalize run ${runId}`, error)
      })
      .finally(() => {
        state.finalizing = false
      })
  }
}

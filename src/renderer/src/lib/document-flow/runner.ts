import {
  USER_INTERRUPT_DETAIL,
  WAITING_FOR_WORK_PREFIX,
  WAITING_PREFIX,
  isItemWaitingOnUser,
  isRunSettled,
  isRunWaitingOnUser,
  isTerminalItemStatus,
  launchableItems,
  mergeCandidates,
  mergeLaneOwner,
  ticketBranchHint
} from '@shared/document-flow/planning'
import {
  buildConflictPrompt,
  buildContinuePrompt,
  buildFixTicket,
  buildLaunchPrompt,
  buildNudgePrompt,
  withRunRules,
  workspaceOfMembers,
  type ConnectionWorkspaceMember,
  type NudgeVerdict
} from '@shared/document-flow/prompts'
import {
  DOCUMENT_RUN_ITEM_MERGE_STATUSES,
  hasVerifyCommand,
  isConnectionRun,
  runVerifyCommands,
  type DocumentMergeCheckMember,
  type DocumentMergeCheckResult,
  type DocumentRun,
  type DocumentRunDetail,
  type DocumentRunItem,
  type DocumentRunItemMember,
  type DocumentRunItemPatch,
  type DocumentRunItemStatus,
  type DocumentRunLaunchConfig,
  type DocumentRunMember,
  type DocumentVerificationMethod,
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
/**
 * How long a ticket waits for background work its agent said it was waiting on (a `waiting`
 * verdict) before the agent is told to check on that work and finish.
 */
export const WAIT_FOR_WORK_MS = 30 * 60_000
/** Wait timeouts that only remind the agent; the next one counts as a nudge (MAX_NUDGES). */
export const MAX_WAIT_TIMEOUTS = 1
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
const UNCHANGED_DETAIL =
  'Nothing to merge: the agent reported the task done without changing anything.'
/** `status_detail` prefix of a ticket merged although its agent's last message was not `done`. */
const MERGED_AS_IS_PREFIX = 'Merged as it stood. The agent ended on: '
/** `status_detail` prefix of a ready ticket whose merge waits for the one in the lane. */
export const WAITING_TO_MERGE_PREFIX = 'Waiting to merge: '

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
    detail.startsWith(WAITING_FOR_WORK_PREFIX) ||
    detail.startsWith(API_ERROR_PREFIX) ||
    detail === USER_INTERRUPT_DETAIL)

/**
 * The item the other ready ones wait behind: the one in the integration worktree, else the one
 * holding the lane while it resolves conflicts (in whatever status the resolution has it).
 */
function mergeBlocker(items: readonly DocumentRunItem[]): { key: string; doing: string } | null {
  const landing = items.find(
    (item) => item.selected && DOCUMENT_RUN_ITEM_MERGE_STATUSES.includes(item.status)
  )
  if (landing) {
    const doing =
      landing.status === 'merging'
        ? 'merging'
        : landing.status === 'verifying'
          ? 'being verified'
          : 'having its checks fixed'
    return { key: landing.key, doing }
  }
  const owner = mergeLaneOwner(items)
  if (!owner) return null
  return {
    key: owner.key,
    doing: isItemWaitingOnUser(owner)
      ? 'resolving conflicts and waiting for you'
      : 'resolving conflicts'
  }
}

const ticketRef = (item: DocumentRunItem): { key: string; title: string } => ({
  key: item.key,
  title: item.title
})

// ── Connection runs ──────────────────────────────────────────────────────────
// A run on a connection project has no integration worktree but an integration INSTANCE: one
// integration worktree per member project (`run.members`), and every ticket gets an instance
// of its own with a worktree per member (`item.members`). The merge, the verify and the fix
// are the server's per member; here only where a branch is cut from, where a session runs
// and what the agents are told change.

/** The members of the connection directory, as the prompts name them. */
/** The integration checkouts whose setup script may be running: one, or one per member. */
const integrationWorktreeIds = (run: DocumentRun): string[] =>
  isConnectionRun(run)
    ? run.members.map((member) => member.integration_worktree_id)
    : run.integration_worktree_id
      ? [run.integration_worktree_id]
      : []

/**
 * The branch name an item of a connection run is recorded under: the one the member
 * worktrees share (the first member's when a taken name got a suffix in one of them).
 */
const commonBranchName = (members: readonly { branch_name: string }[]): string | null =>
  members[0]?.branch_name ?? null

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
      const run = this.ports.getRun(runId)?.run
      if (!run) return
      // A connection run's instances live in the members' worktrees and the connection store.
      if (isConnectionRun(run)) {
        await this.ports.loadProject(
          run.project_id,
          run.members.map((member) => member.project_id)
        )
      } else {
        await this.ports.loadProject(run.project_id)
      }
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
          this.spawnMerge(state, runId, [item])
          break
        default:
          break
      }
    }

    for (const item of launchableItems(items, run.config.maxParallel)) {
      if (this.canStep(item, now)) this.enqueueLaunch(runId, item)
    }

    // The merge lane: one item at a time, from the dry run to the verified merge, including
    // the resolution of its conflicts by its session. Of the ready items, the first that merges
    // clean goes; the rest wait, and say what for.
    const candidates = state.merging
      ? []
      : mergeCandidates(items).filter((item) => this.canStep(item, now))
    if (candidates.length > 0) this.spawnMerge(state, runId, candidates)
    this.describeWaiting(state, runId, items, candidates, now)

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
    if (items.some((item) => item.started_at || item.session_id || item.merge_sha)) return
    if (isConnectionRun(run)) {
      // One install per member integration worktree, each the member project's own script.
      for (const member of run.members) {
        if (this.ports.isSetupScriptRunning(member.integration_worktree_id)) continue
        this.ports.fireSetupScript(
          member.project_id,
          member.integration_worktree_id,
          member.integration_worktree_path
        )
      }
      return
    }
    const worktreeId = run.integration_worktree_id
    const cwd = run.integration_worktree_path
    if (!worktreeId || !cwd) return
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

  /**
   * Take the merge lane for one turn over the candidates (see `mergeNext`). All of them are
   * held in flight while the turn picks among them, so no other step touches them meanwhile;
   * the ones not taken are let go as soon as the pick is made.
   */
  private spawnMerge(state: RunState, runId: string, candidates: readonly DocumentRunItem[]): void {
    // A launch under way cuts its branch from the integration tip, which must not move under
    // it; the merge waits for the launch, as a launch waits for a merge (see `launchBase`).
    if (state.merging || state.launching > 0 || candidates.length === 0) return
    state.merging = true
    const op: ItemOp = { runId, item: candidates[0], changed: false }
    const held = new Set(candidates.map((item) => item.id))
    for (const id of held) this.inFlight.set(id, runId)
    const take = (taken: DocumentRunItem): void => {
      for (const id of held) {
        if (id === taken.id) continue
        this.inFlight.delete(id)
        held.delete(id)
      }
    }
    void this.runStep(op, (step) => this.mergeNext(step, candidates, take)).finally(() => {
      for (const id of held) this.inFlight.delete(id)
      state.merging = false
      if (op.changed) this.requestTick()
    })
  }

  /**
   * Tell the ready items that are not merging what they wait for, so the dashboard shows it.
   * Only a null or an earlier waiting detail is replaced: what a merge or a flag writes
   * stands.
   */
  private describeWaiting(
    state: RunState,
    runId: string,
    items: readonly DocumentRunItem[],
    candidates: readonly DocumentRunItem[],
    now: number
  ): void {
    const blocker = mergeBlocker(items)
    // No item holds the lane, but a merge turn is under way in memory: it ends in a moment.
    if (!blocker && state.merging) return
    for (const item of items) {
      if (!item.selected || item.status !== 'ready' || candidates.includes(item)) continue
      const detail = item.status_detail
      if (detail !== null && !detail.startsWith(WAITING_TO_MERGE_PREFIX)) continue
      const wanted =
        blocker && blocker.key !== item.key
          ? `${WAITING_TO_MERGE_PREFIX}${blocker.key} is ${blocker.doing}`
          : null
      if (wanted === detail || !this.canStep(item, now)) continue
      this.spawn(runId, item, async (op) => {
        await this.patch(op, { status_detail: wanted })
      })
    }
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

  /** Whether the run's agents may ask right now; the dashboard can flip it mid-run. */
  private interactive(op: ItemOp): boolean {
    return this.currentItem(op)?.run.config.interactive ?? true
  }

  /**
   * How the ticket's agent is asked to verify its work, as chosen right now: the ticket's own
   * methods, or none while the run skips verification (both can change while it waits).
   */
  private verification(op: ItemOp): DocumentVerificationMethod[] {
    const current = this.currentItem(op)
    if (!current || current.run.config.verificationDisabled) return []
    return current.item.verification
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
      } else if (
        seen.kind === 'idle' &&
        !isTransientDetail(item.status_detail) &&
        !this.interactive(op)
      ) {
        // Parked on a question its agent asked in its message, in a run whose agents may no
        // longer ask: nobody is coming to answer, so the check tells the agent to decide.
        await this.patch(op, { status: 'checking', status_detail: null })
      }
      return
    }

    switch (seen.kind) {
      case 'working': {
        const stale = isTransientDetail(item.status_detail)
        if (!item.retry_at && !item.wait_until && !stale) return
        // Woken (or prompted) while it waited for background work: the wait is over.
        await this.patch(op, {
          status_detail: stale ? this.workingDetail(item) : item.status_detail,
          retry_at: null,
          wait_until: null
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
    const healthy: DocumentRunItemPatch = { status_detail: null, retry_at: null, wait_until: null }
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

    // Waiting for background work its agent said would wake it: the standing turn end was
    // judged already, so nothing happens until the wake arrives or the wait runs out.
    if (item.wait_until && seen.kind === 'idle') {
      const waitUntil = toMs(item.wait_until)
      if (now < waitUntil) {
        this.wakeAt(waitUntil)
        return
      }
      return this.waitTimedOut(op, target)
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
    const sent = await this.followUp(
      op,
      target,
      buildContinuePrompt(reason, this.interactive(op)),
      {
        continue_attempts: op.item.continue_attempts + 1,
        retry_at: null,
        wait_until: null,
        status_detail: transient ? this.workingDetail(op.item) : op.item.status_detail
      }
    )
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
    // A run whose agents may not ask has nobody to hand a question or a stop to: whatever
    // the message says short of done, the session is sent back to finish on its own.
    const unattended = !this.interactive(op)
    switch (verdict.status) {
      case 'done':
        await this.patch(op, { ...checked, status: 'ready', status_detail: null })
        return
      case 'needs_input': {
        const question = verdict.question?.trim() || reason
        if (unattended) return this.nudge(op, sessionId, { ...verdict, reason, question }, checked)
        await this.patch(op, { ...checked, status: 'needs_input', status_detail: question })
        this.ports.notify({ level: 'info', message: `${item.key} is waiting for you: ${question}` })
        this.event(op, 'needs_input', question)
        return
      }
      case 'partial':
        return this.nudge(op, sessionId, { ...verdict, reason }, checked)
      case 'waiting':
        return this.waitForWork(op, reason, checked)
      default:
        if (unattended) return this.nudge(op, sessionId, { ...verdict, reason }, checked)
        return this.flag(op, reason, checked)
    }
  }

  /**
   * The agent stopped to wait for background work it started (checks, a build) and will be
   * woken when it ends: nothing is asked of the user. The item stays running, says what it
   * waits for, and keeps a deadline: a wait that nothing wakes is not left standing forever.
   * The board's ticket, which the turn end moved to review, goes back to in progress as
   * "awaiting completion", the way a Monitor pause keeps it.
   */
  private async waitForWork(
    op: ItemOp,
    reason: string,
    checked: DocumentRunItemPatch
  ): Promise<void> {
    const until = this.ports.now() + WAIT_FOR_WORK_MS
    await this.patch(op, {
      ...checked,
      status: 'running',
      status_detail: `${WAITING_FOR_WORK_PREFIX}${reason}`,
      retry_at: null,
      wait_until: toIso(until)
    })
    this.event(op, 'waiting', reason)
    await this.holdTicket(op)
    this.wakeAt(until)
  }

  /** Keep the item's board ticket in progress while its session waits for background work. */
  private async holdTicket(op: ItemOp): Promise<void> {
    const current = this.currentItem(op)
    const ticketId = op.item.ticket_id
    if (!current || !ticketId) return
    const projectId = current.run.project_id
    const ticket = this.ports.getTicket(projectId, ticketId)
    if (!ticket || (ticket.column !== 'review' && ticket.column !== 'in_progress')) return
    try {
      await this.ports.holdTicketForWork(projectId, ticketId)
    } catch (error) {
      this.ports.warn(`Could not hold ${op.item.key}'s ticket in progress`, error)
    }
  }

  /**
   * The wait ran out with no wake: the work may have finished quietly, or died. The agent is
   * told to check on it and finish. The first time is a reminder; after that the reminders
   * count as nudges, so a session that only ever waits still reaches the end of the run.
   */
  private async waitTimedOut(op: ItemOp, target: SessionTarget): Promise<void> {
    const item = op.item
    const detail = item.status_detail ?? ''
    const reason = detail.startsWith(WAITING_FOR_WORK_PREFIX)
      ? detail.slice(WAITING_FOR_WORK_PREFIX.length)
      : item.verdict?.reason || 'background work it started'
    const verdict: NudgeVerdict = {
      status: 'waiting',
      reason,
      ...(item.verdict?.source ? { source: item.verdict.source } : {})
    }
    this.event(op, 'wait_timed_out', reason)
    if (item.wait_timeouts >= MAX_WAIT_TIMEOUTS) {
      return this.nudge(op, target.sessionId, verdict, { wait_until: null })
    }
    this.requireActive(op)
    const sent = await this.followUp(op, target, buildNudgePrompt(verdict, this.interactive(op)), {
      wait_until: null,
      wait_timeouts: item.wait_timeouts + 1,
      status_detail: `Told its wait ran out: ${reason}`
    })
    if (sent) this.event(op, 'nudged', reason)
  }

  /**
   * Send the session back to finish what its last message left open. Once it has been told
   * MAX_NUDGES times, an attended run flags the ticket; an unattended one merges what the
   * branch holds as it is (the verdict stays on the item, and ends up in its detail), so the
   * tickets behind it are not left waiting for someone who is not there.
   */
  private async nudge(
    op: ItemOp,
    sessionId: string,
    verdict: NudgeVerdict,
    checked: DocumentRunItemPatch
  ): Promise<void> {
    const item = op.item
    const interactive = this.interactive(op)
    if (item.nudge_count >= MAX_NUDGES) {
      if (interactive) return this.flag(op, verdict.reason, checked)
      await this.patch(op, { ...checked, status: 'ready', status_detail: null })
      this.event(
        op,
        'accepted_as_is',
        `${item.key} did not report done after ${MAX_NUDGES} reminders; merging its branch as it is (${verdict.reason})`
      )
      return
    }
    this.requireActive(op)
    const waits = verdict.status === 'needs_input'
    const sent = await this.followUp(
      op,
      { sessionId, ticketId: item.ticket_id },
      buildNudgePrompt(verdict, interactive),
      {
        ...checked,
        status: 'running',
        nudge_count: item.nudge_count + 1,
        status_detail: waits
          ? `Told to decide on its own: ${verdict.question?.trim() || verdict.reason}`
          : `Asked to finish: ${verdict.reason}`
      }
    )
    if (sent) this.event(op, 'nudged', verdict.reason)
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
    branch: string,
    // The commit the landing item's merge sits on: the item's own for a git run, the member's
    // for one member of a connection run.
    preMergeSha: (landing: DocumentRunItem) => string | null | undefined = (landing) =>
      landing.pre_merge_sha
  ): string | undefined {
    const landing = items.find(
      (item) => item.selected && DOCUMENT_RUN_ITEM_MERGE_STATUSES.includes(item.status)
    )
    if (landing) return preMergeSha(landing) ?? undefined
    return state.merging ? undefined : branch
  }

  /** Where each member's branch is cut from; undefined while any member's commit is unknown. */
  private memberLaunchBases(
    items: readonly DocumentRunItem[],
    state: RunState,
    members: readonly DocumentRunMember[]
  ): Map<string, string> | undefined {
    const bases = new Map<string, string>()
    for (const member of members) {
      const base = this.launchBase(
        items,
        state,
        member.integration_branch,
        (landing) =>
          landing.members?.find((own) => own.project_id === member.project_id)?.pre_merge_sha
      )
      if (base === undefined) return undefined
      bases.set(member.project_id, base)
    }
    return bases
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
    if (isConnectionRun(run)) return this.launchConnectionItem(op, run, detail.items)
    const branch = run.integration_branch
    if (!branch) return this.flag(op, 'The run has no integration branch to start from.')
    const baseRef = this.launchBase(detail.items, this.stateFor(op.runId), branch)
    if (baseRef === undefined) return

    const startedAt = toIso(this.ports.now())
    await this.patch(op, { status: 'launching', status_detail: null, started_at: startedAt })

    const ticket = await this.findTicket(run.project_id, item.ticket_id)
    if (!ticket) return this.flag(op, 'Its ticket no longer exists.')

    // From the row the `launching` write returned, not the one read before it: the model can
    // be changed from the dashboard until that write lands, and nothing is accepted after it.
    const modelConfig = this.launchConfig(run, op.item)
    // Read now, not from the run captured before the awaits above: the setting can be flipped
    // mid-run from the dashboard.
    const briefed = this.interactive(op)
    const { prompt } = this.launchBrief(op, run, item, ticket, modelConfig, briefed, null)

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
    await this.tellIfFlipped(op, result.sessionId, briefed)
  }

  /**
   * The brief a ticket session is launched with. The ticket's description is the brief, sent
   * as it reads on the board (the user may have edited it), with no ticket wrapper and no
   * attachments: the agent reads the task in the document itself. A ticket left without a
   * description gets the standard brief. The rules of the run are settled now, whatever the
   * description says: it was written when the run started, under the settings and
   * verification choice of that moment. `workspace` names the members of a connection run.
   */
  private launchBrief(
    op: ItemOp,
    run: DocumentRun,
    item: DocumentRunItem,
    ticket: RunnerTicket,
    modelConfig: DocumentRunLaunchConfig,
    briefed: boolean,
    workspace: readonly ConnectionWorkspaceMember[] | null
  ): { prompt: string } {
    const verification = this.verification(op)
    const rules = {
      interactive: briefed,
      sdk: modelConfig.sdk,
      verification,
      ...(workspace ? { workspace } : {})
    }
    const prompt = withRunRules(
      ticket.description?.trim() ||
        buildLaunchPrompt({
          key: item.key,
          title: item.title,
          sourcePath: run.source_path,
          promptStyle: run.config.promptStyle,
          ...rules
        }),
      rules
    )
    return { prompt }
  }

  /**
   * A ticket of a connection run launches into a NEW instance: a worktree in every member,
   * each cut from that member's launch base (its integration tip, or the commit before a
   * merge that is landing there) and named after the ticket; the session runs on the
   * instance. The item records the instance and its member worktrees.
   */
  private async launchConnectionItem(
    op: ItemOp,
    run: DocumentRun & { members: DocumentRunMember[] },
    items: readonly DocumentRunItem[]
  ): Promise<void> {
    const item = op.item
    const bases = this.memberLaunchBases(items, this.stateFor(op.runId), run.members)
    if (bases === undefined) return

    const startedAt = toIso(this.ports.now())
    await this.patch(op, { status: 'launching', status_detail: null, started_at: startedAt })

    const ticket = await this.findTicket(run.project_id, item.ticket_id)
    if (!ticket) return this.flag(op, 'Its ticket no longer exists.')

    // As in launchItem: the row the `launching` write returned carries the last model chosen.
    const modelConfig = this.launchConfig(run, op.item)
    const briefed = this.interactive(op)
    const { prompt } = this.launchBrief(
      op,
      run,
      item,
      ticket,
      modelConfig,
      briefed,
      workspaceOfMembers(run.members)
    )

    const result = await this.ports.launchTicket({
      ticketId: ticket.id,
      projectId: run.project_id,
      ticketTitle: ticket.title,
      // Each member's branch is cut from that member's verified integration commit, recorded
      // against the member's base branch (so the board merges the ticket straight into it),
      // without auto-pull; the pipeline names every worktree after the ticket.
      worktree: {
        type: 'connection-new',
        savedProjectId: run.project_id,
        members: run.members.map((member) => ({
          projectId: member.project_id,
          sourceBranch: member.base_branch,
          baseRef: bases.get(member.project_id) as string
        })),
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
      this.event(op, 'launch_failed', error, { connectionId: result.connectionId ?? null })
      // No session is recorded, so Retry launches the ticket again.
      return this.flag(op, `Could not launch: ${error}`, { session_id: null })
    }

    // The created rows carry the real branch names: a taken name gets a numeric suffix.
    const members: DocumentRunItemMember[] = (result.worktrees ?? []).map((worktree) => ({
      project_id: worktree.projectId,
      worktree_id: worktree.worktreeId,
      branch_name: worktree.branchName,
      pre_merge_sha: null,
      merge_sha: null
    }))
    const branch = commonBranchName(members)
    await this.patch(op, {
      status: 'running',
      status_detail: null,
      session_id: result.sessionId,
      connection_id: result.connectionId ?? null,
      members,
      branch_name: branch,
      // Launch start, not now: whatever the new session reports is newer than this.
      last_prompt_at: startedAt
    })
    this.event(
      op,
      'launched',
      `Launched ${item.key} on ${branch ?? 'a new branch'} in a new instance of ${run.members.length} member repositories`
    )
    await this.tellIfFlipped(op, result.sessionId, briefed)
  }

  /**
   * The setting was flipped while a session was being launched: the flip could not message a
   * session that did not exist yet, and its prompt was built under the old setting.
   */
  private async tellIfFlipped(op: ItemOp, sessionId: string, briefed: boolean): Promise<void> {
    const interactive = this.interactive(op)
    if (interactive === briefed) return
    try {
      await this.ports.tellQuestionMode(sessionId, interactive)
    } catch (error) {
      // Advisory: the next prompt this session gets carries the setting anyway.
      this.ports.warn(`${op.item.key}: could not tell the new session about questions`, error)
    }
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
    const lastPromptAt = op.item.started_at ?? toIso(this.ports.now())
    if (isConnectionRun(run)) {
      // The board ticket of a connection session has no worktree: the session knows its
      // instance, and the instance knows the member worktrees the item merges from.
      const connectionId = await this.ports.getSessionConnectionId(ticket.current_session_id)
      if (!connectionId) {
        return this.flag(op, 'The session it was launched with runs on no connection instance.')
      }
      const connection = await this.ports.getConnection(connectionId)
      if (!connection) return this.flag(op, 'The instance it was launched into no longer exists.')
      const members: DocumentRunItemMember[] = connection.members.map((member) => ({
        project_id: member.project_id,
        worktree_id: member.worktree_id,
        branch_name: member.branch_name,
        pre_merge_sha: null,
        merge_sha: null
      }))
      await this.patch(op, {
        status: 'running',
        status_detail: null,
        session_id: ticket.current_session_id,
        connection_id: connectionId,
        members,
        branch_name: commonBranchName(members),
        last_prompt_at: lastPromptAt
      })
      this.event(op, 'launched', `Picked up the session ${op.item.key} was launched with`)
      return
    }
    const worktree = await this.findWorktree(run.project_id, ticket.worktree_id)
    await this.patch(op, {
      status: 'running',
      status_detail: null,
      session_id: ticket.current_session_id,
      worktree_id: ticket.worktree_id,
      branch_name: worktree?.branch_name ?? null,
      last_prompt_at: lastPromptAt
    })
    this.event(op, 'launched', `Picked up the session ${op.item.key} was launched with`)
  }

  // ── Merging ──────────────────────────────────────────────────────────────

  /**
   * One turn of the merge lane. The candidates are dry-run in order, and the first whose
   * branch does not conflict is taken: merged, or dealt with for what the dry run found. Only
   * when every one conflicts is the first sent to resolve its conflicts; it then holds the
   * lane (`mergeLaneOwner`) until it is merged or flagged, so what it resolves against is
   * what it lands on. A conflicting branch is never resolved while a clean one could land.
   */
  private async mergeNext(
    op: ItemOp,
    candidates: readonly DocumentRunItem[],
    take: (item: DocumentRunItem) => void
  ): Promise<void> {
    let conflicted: { item: DocumentRunItem; check: DocumentMergeCheckResult } | null = null
    const passedOver: string[] = []
    for (const item of candidates) {
      op.item = item
      const run = this.requireActive(op)
      // Picked up in the middle (a reload, a crash): a recorded merge commit means the merge
      // itself is behind us; otherwise the dry run is made again. Such an item comes alone.
      if (item.status !== 'ready') {
        take(item)
        if (item.status === 'verifying' || item.merge_sha) return this.verify(op)
        const check = await this.ports.api.prepareMerge(op.runId, item.id)
        return this.mergeChecked(op, run, check)
      }
      // Judged done, but busy again since (told to go on by the user, or marked done by hand
      // while its agent still works): what is on the branch now is not the end of its work.
      if (item.session_id) {
        const signal = this.ports.getSessionSignal(item.session_id)
        const current = await this.reconcile(op, item.session_id, signal)
        if (await this.followMovingSession(op, current)) continue
      }
      const check = await this.ports.api.prepareMerge(op.runId, item.id)
      if (check.state === 'conflict') {
        if (conflicted) passedOver.push(item.key)
        else conflicted = { item: op.item, check }
        continue
      }
      if (conflicted) {
        const waiting = [conflicted.item.key, ...passedOver]
        this.event(
          op,
          'merged_first',
          `Merging ${item.key} before ${waiting.join(', ')}, which conflict${waiting.length === 1 ? 's' : ''} with ${run.integration_branch ?? 'the integration branch'}`
        )
      }
      take(item)
      return this.mergeChecked(op, run, check)
    }
    if (!conflicted) return
    op.item = conflicted.item
    take(op.item)
    return this.mergeChecked(op, this.requireActive(op), conflicted.check)
  }

  /** Act on the dry run of the item that holds the lane: merge, resolve, or flag. */
  private async mergeChecked(
    op: ItemOp,
    run: DocumentRun,
    check: DocumentMergeCheckResult
  ): Promise<void> {
    if (op.item.status !== 'merging') {
      // A run paused under the dry run leaves the item ready: the dry run is made again later.
      this.requireActive(op)
      await this.patch(op, { status: 'merging', status_detail: null })
    }
    if (check.state === 'error') {
      return this.flag(op, check.error ?? 'The merge could not be prepared.')
    }
    const integrationCommit = check.integrationHead ?? null
    if (check.state === 'conflict') {
      return this.resolveConflict(op, run, check.conflictedFiles, integrationCommit, check.members)
    }
    if (check.state === 'no_changes' && !check.alreadyMerged) return this.nothingToMerge(op)

    this.requireActive(op)
    const result = await this.ports.api.merge(op.runId, op.item.id)
    if (result.success) return this.verify(op)
    if (result.conflictedFiles?.length) {
      // The merge itself has no per-member report: the dry run's members say which branch
      // and commit each repository merges.
      return this.resolveConflict(op, run, result.conflictedFiles, integrationCommit, check.members)
    }
    return this.flag(op, result.error ?? 'The merge failed.')
  }

  /**
   * The members a conflict prompt sends the session into: those whose dry run conflicted, or
   * every member when the merge itself conflicted after a clean dry run (merging an already
   * merged commit again is a no-op). Null for a git run.
   */
  private conflictMembers(members: readonly DocumentMergeCheckMember[] | undefined):
    | {
        symlinkName: string
        projectName: string
        integrationBranch: string
        integrationCommit: string | null
      }[]
    | null {
    if (!members || members.length === 0) return null
    const conflicted = members.filter((member) => member.state === 'conflict')
    return (conflicted.length > 0 ? conflicted : members).map((member) => ({
      symlinkName: member.symlink_name,
      projectName: member.project_name,
      integrationBranch: member.integrationBranch,
      integrationCommit: member.integrationHead
    }))
  }

  /**
   * The branch holds nothing the integration branch lacks. After a `done` verdict that is an
   * agent that found the task already implemented: an unattended run closes the ticket (so
   * the ones that depend on it go on), an attended one lets the user look first.
   */
  private async nothingToMerge(op: ItemOp): Promise<void> {
    const verdict = op.item.verdict
    if (verdict && verdict.status !== 'done') {
      return this.flag(op, `Its branch has nothing to merge. ${verdict.reason}`)
    }
    if (!verdict || this.interactive(op)) return this.flag(op, NO_CHANGES_DETAIL)
    await this.patch(op, {
      status: 'skipped',
      status_detail: UNCHANGED_DETAIL,
      finished_at: toIso(this.ports.now())
    })
    this.event(op, 'skipped', `${op.item.key}: ${UNCHANGED_DETAIL}`)
  }

  /** Conflicts are resolved by the ticket's own session, on its own branch. */
  private async resolveConflict(
    op: ItemOp,
    run: DocumentRun,
    files: string[],
    integrationCommit: string | null,
    checkMembers?: readonly DocumentMergeCheckMember[]
  ): Promise<void> {
    const item = op.item
    const branch = run.integration_branch ?? 'the integration branch'
    const members = this.conflictMembers(checkMembers)
    this.event(
      op,
      'conflict',
      members
        ? `Conflicts with ${branch} in ${files.length} file(s) across ${members.map((member) => member.symlinkName).join(', ')}`
        : `Conflicts with ${branch} in ${files.length} file(s)`,
      { files }
    )
    // A session that resolved against one tip and was overtaken by another ticket's merge has
    // not failed: only attempts against the same integration commit count towards the limit.
    // The lane it holds while resolving keeps that from happening within a run; a row written
    // before the lane existed, or a tip moved by hand, can still get there.
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
        attempt,
        interactive: this.interactive(op),
        ...(members ? { members } : {})
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
    if (!hasVerifyCommand(run)) return this.markMerged(op)
    if (op.item.status !== 'verifying') {
      await this.patch(op, { status: 'verifying', status_detail: null })
    }

    // The checks need the dependencies the setup script is still installing; the next tick
    // finds the item verifying with nothing in flight and comes back here. A connection run
    // waits for every member's install.
    if (integrationWorktreeIds(run).some((id) => this.ports.isSetupScriptRunning(id))) {
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
    const briefed = this.interactive(op)
    // Where the fix session runs: the integration worktree, or a connection run's integration
    // instance (the session sees every member's integration checkout through it).
    const target = this.fixTarget(run)
    if (!target || !run.integration_branch) {
      return this.giveUp(
        op,
        isConnectionRun(run)
          ? 'The run has no integration instance to fix the checks in.'
          : 'The run has no integration worktree to fix the checks in.'
      )
    }
    // A connection run's failure names the member whose command failed; its command is the
    // one to make pass. Without one (an older server), the first configured command.
    const failedMember = failure.failedMember ?? null
    const verifyCommand = isConnectionRun(run)
      ? (failedMember?.command ?? runVerifyCommands(run)[0]?.command ?? '')
      : (run.config.verifyCommand ?? '')

    let ticket: RunnerTicket
    try {
      ticket = await this.ports.createTicket(
        run.project_id,
        buildFixTicket({
          documentTitle: run.title,
          key: item.key,
          title: item.title,
          integrationBranch: run.integration_branch,
          verifyCommand,
          verifyOutput: failure.output,
          attempt,
          interactive: briefed,
          ...(isConnectionRun(run)
            ? {
                workspace: workspaceOfMembers(run.members),
                failedMember: failedMember
                  ? {
                      symlinkName: failedMember.symlink_name,
                      projectName: failedMember.project_name
                    }
                  : null
              }
            : {})
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
      worktree: target,
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
    await this.tellIfFlipped(op, result.sessionId, briefed)
  }

  /** The launch target of a fix session: the run's integration checkout(s); null when it has none. */
  private fixTarget(run: DocumentRun): TicketLaunchSpec['worktree'] | null {
    if (isConnectionRun(run)) {
      return run.integration_connection_id
        ? { type: 'existing-connection', connectionId: run.integration_connection_id }
        : null
    }
    return run.integration_worktree_id
      ? { type: 'existing', worktreeId: run.integration_worktree_id }
      : null
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
    // Merged on the user's word or for want of anyone to ask, not on the agent's: its last
    // verdict is the caveat the dashboard and the report show next to the ticket.
    const verdict = op.item.verdict
    const item = await this.patch(op, {
      status: 'merged',
      status_detail:
        verdict && verdict.status !== 'done' ? `${MERGED_AS_IS_PREFIX}${verdict.reason}` : null,
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

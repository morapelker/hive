import { buildMigrationPrompt, workspaceOfMembers } from '@shared/document-flow/prompts'
import { isEndedRunStatus } from '@shared/document-flow/run-ticket'
import { isAgentCli } from '@shared/types/agent-sdk'
import {
  isConnectionRun,
  isTicketRun,
  type DocumentMigrationOutcome,
  type DocumentRun
} from '@shared/types/document-flow'
import { dbApi } from '@/api/db-api'
import { documentFlowApi } from '@/api/document-flow-api'
import { opencodeApi } from '@/api/opencode-api'
import { terminalApi } from '@/api/terminal-api'
import { unwrapEnvelope } from '@/lib/ipc-envelope'
import { findSessionById } from '@/lib/session-followup'
import {
  launchSessionOnConnection,
  launchSessionWithModel,
  type SessionLaunchCreated,
  type SessionLaunchResult
} from '@/lib/ticket-launch'
import { toast } from '@/lib/toast'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import type { Session } from '../../../../main/db/types'
import { resolveDefaultLaunchConfig } from './runner-ports'
import { getSessionSignal, startSessionSignalLatch, USER_ABORT_REASON } from './session-signal'

// Executing the migrations of a finished run: one agent session in the run's integration
// worktree (the branch the run's tickets were merged into), started from the report in the run
// dashboard. The server records the session on the run (`migration_session_id`) and holds the
// run's ticket In Progress while it is set, so every window and a reloaded one see the same
// thing; this module starts the session, stops it, and tells the server when it is over.

/** A turn end must stand this long before it counts: sessions bounce in and out of completed. */
export const MIGRATION_SETTLE_MS = 3_000
/** How often a session this page has no status for (after a reload) is looked up on the server. */
export const MIGRATION_POLL_MS = 10_000
/** How long a CLI session gets to report the interrupt before its process is closed instead. */
export const CLI_INTERRUPT_WAIT_MS = 3_000
const CLI_INTERRUPT_POLL_MS = 100
const TICK_DEBOUNCE_MS = 100

// A lone Escape: what the user presses in a CLI session to stop its turn.
const CLI_INTERRUPT_KEY = '\x1b'
const USER_STOP_REASONS: ReadonlySet<string> = new Set([
  'user_interrupt',
  'codex_turn_aborted',
  USER_ABORT_REASON
])
// A CLI publishes "completed" as its process starts, moments before the launch prompt puts
// it to work: not the end of anything.
const SESSION_START_HOOK = 'SessionStart'
const PROCESS_START_REASON = 'pty_start'
// Ends that are the process going away, not the agent finishing its turn.
const PROCESS_END_REASON = 'pty_exit'
const PROCESS_END_HOOK = 'SessionEnd'
const RECORDED_INTERRUPT_EVENT = 'Interrupt'

/** Runs whose migration session is being started by this page (no session id on the run yet). */
const starting = new Set<string>()
/** Sessions this page started for migrations, known before the server has recorded them. */
const launched = new Set<string>()
/** Runs whose migration session this page is reporting as over. */
const ending = new Set<string>()

const describeError = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

type MigrationRun = Pick<
  DocumentRun,
  | 'status'
  | 'report'
  | 'project_id'
  | 'integration_branch'
  | 'integration_worktree_id'
  | 'integration_connection_id'
  | 'members'
  | 'migration_session_id'
>

/**
 * Why the migrations of `run` cannot be executed right now, or null when they can.
 * `worktreeIds` are the project's worktrees as loaded (archived ones are not listed);
 * undefined while they are not loaded, which refuses nothing. A connection run's checkout is
 * its integration instance: `connectionIds` are the active connections as loaded, checked the
 * same way (and `worktreeIds` is not read).
 */
export function migrationsRefusal(
  run: MigrationRun,
  worktreeIds: ReadonlySet<string> | undefined,
  connectionIds?: ReadonlySet<string> | undefined
): string | null {
  if (run.migration_session_id) return 'The migrations of this run are already being executed.'
  if (!isEndedRunStatus(run.status) || !run.report) {
    return 'Only a run that has finished has migrations to execute.'
  }
  if (run.report.migrations.length === 0) return 'This run has no migrations to execute.'
  if (isConnectionRun(run)) {
    if (!run.integration_connection_id || !run.integration_branch) {
      return 'The run has no integration instance to execute the migrations in.'
    }
    if (connectionIds && !connectionIds.has(run.integration_connection_id)) {
      return `The instance of ${run.integration_branch} was archived or deleted, so there is no checkout of the branches to execute the migrations in.`
    }
    return null
  }
  if (!run.integration_worktree_id || !run.integration_branch) {
    return 'The run has no integration worktree to execute the migrations in.'
  }
  if (worktreeIds && !worktreeIds.has(run.integration_worktree_id)) {
    return `The worktree of ${run.integration_branch} was archived, so there is no checkout of the branch to execute the migrations in.`
  }
  return null
}

function loadedWorktreeIds(projectId: string): ReadonlySet<string> | undefined {
  const worktrees = useWorktreeStore.getState().worktreesByProject.get(projectId)
  return worktrees ? new Set(worktrees.map((worktree) => worktree.id)) : undefined
}

/** The active connections as loaded; undefined before the store has loaded them. */
/**
 * The ids of the active connections, as loaded; undefined while the store has not loaded them,
 * which refuses nothing. The dashboard's gate and `startRunMigrations` read the same set.
 */
export function activeConnectionIds(
  state: Pick<ReturnType<typeof useConnectionStore.getState>, 'loaded' | 'connections'>
): ReadonlySet<string> | undefined {
  if (!state.loaded) return undefined
  return new Set(state.connections.filter((c) => c.status === 'active').map((c) => c.id))
}

function loadedConnectionIds(): ReadonlySet<string> | undefined {
  return activeConnectionIds(useConnectionStore.getState())
}

/**
 * Whether `sessionId` executes the migrations of a run. Such a session belongs to the run's
 * own ticket, which shows it; the board must not open a ticket of its own for it.
 */
export function isMigrationSession(sessionId: string): boolean {
  if (launched.has(sessionId)) return true
  return Object.values(useDocumentFlowStore.getState().runsById).some(
    (detail) => detail.run.migration_session_id === sessionId
  )
}

/**
 * A session that will never be the run's migration session: closed for good, so it neither
 * keeps running nor lingers as a tab whose queued prompt would run the migrations, untracked,
 * the moment someone opens it.
 */
async function discardSession(sessionId: string): Promise<void> {
  useSessionStore.getState().dequeuePendingMessage(sessionId)
  await abortSdkSession(sessionId).catch(() => undefined)
  try {
    // Marks the row completed, destroys a CLI's process and disconnects an SDK session.
    await useSessionStore.getState().closeSession(sessionId)
  } catch {
    // Best effort: at worst an idle session tab is left in the integration worktree.
  }
}

/**
 * Start a session in the run's integration worktree that executes its migrations against
 * production, with the model the run launches its tickets with (the app's default launch when
 * the run has none). Rejects with a message for the user when it could not be started.
 */
export async function startRunMigrations(runId: string): Promise<void> {
  const store = useDocumentFlowStore.getState()
  const run = store.runsById[runId]?.run
  if (!run) throw new Error('The run is not loaded.')
  if (starting.has(runId)) throw new Error('The migration session is already being started.')
  starting.add(runId)
  try {
    const connectionRun = isConnectionRun(run)
    // An archived worktree (or instance) is told apart from one that is merely not loaded yet.
    if (connectionRun) await useConnectionStore.getState().loadConnections()
    else await useWorktreeStore.getState().loadWorktrees(run.project_id)
    const refusal = migrationsRefusal(
      run,
      connectionRun ? undefined : loadedWorktreeIds(run.project_id),
      connectionRun ? loadedConnectionIds() : undefined
    )
    if (refusal) throw new Error(refusal)
    const branch = run.integration_branch as string

    const modelConfig = run.config.defaultLaunch ?? resolveDefaultLaunchConfig()
    let recorded = false
    const onSessionCreated = async ({ session }: SessionLaunchCreated): Promise<void> => {
      // Known as a migration session before its first prompt is seen by anyone.
      launched.add(session.id)
      await useSessionStore.getState().updateSessionName(session.id, `Migrations — ${branch}`)
      // Recorded before the agent is started: from here on the run shows the session and
      // can stop it, also from a window reloaded while the prompt is still on its way. A
      // refusal (another session is at it) fails the launch before anything runs.
      store.applyDetail(await documentFlowApi.startMigrations(runId, session.id))
      recorded = true
    }
    const prompt = buildMigrationPrompt({
      documentTitle: run.title,
      integrationBranch: branch,
      migrations: run.report?.migrations ?? [],
      sdk: modelConfig.sdk,
      sourceKind: run.source_kind,
      // A connection run's session runs in the integration connection directory, where the
      // migration paths start with the member's directory.
      ...(connectionRun ? { workspace: workspaceOfMembers(run.members) } : {})
    })
    const result: SessionLaunchResult = connectionRun
      ? await launchSessionOnConnection({
          connectionId: run.integration_connection_id as string,
          connectionPath:
            run.integration_connection_path ??
            useConnectionStore
              .getState()
              .connections.find((c) => c.id === run.integration_connection_id)?.path ??
            null,
          prompt,
          mode: 'build',
          modelConfig,
          goalMode: false,
          goalSuccessCriteria: null,
          onSessionCreated
        })
      : await launchSessionWithModel({
          projectId: run.project_id,
          worktreeId: run.integration_worktree_id as string,
          prompt,
          mode: 'build',
          modelConfig,
          goalMode: false,
          goalSuccessCriteria: null,
          // The run's own ticket shows this session; a ticket that merely waits on the
          // integration worktree must not be handed it.
          skipKanbanAttach: true,
          onSessionCreated
        })
    if (result.success && result.sessionId) {
      // Stopped (here, or in another window) while the prompt was on its way: the stop found
      // no turn to abort, and the agent that has started since is the run's no longer. The
      // server is asked, since this window's copy of the run can lag another window's stop.
      const current = await documentFlowApi.get(runId).catch(() => null)
      if (current && current.run.migration_session_id !== result.sessionId) {
        useDocumentFlowStore.getState().applyDetail(current)
        launched.delete(result.sessionId)
        await discardSession(result.sessionId)
      }
      return
    }

    const sessionId = result.sessionId
    if (!sessionId) throw new Error(result.error ?? 'The session could not be started.')
    // Stopped by the user while its prompt was on its way: that is not a failed start.
    const current = useDocumentFlowStore.getState().runsById[runId]?.run.migration_session_id
    if (recorded && current !== sessionId) return
    // Nothing would ever finish it: it must neither keep running nor hold the run.
    await discardSession(sessionId)
    launched.delete(sessionId)
    if (recorded) {
      await documentFlowApi
        .endMigrations(runId, sessionId, 'stopped')
        .then((detail) => useDocumentFlowStore.getState().applyDetail(detail))
        .catch(() => undefined)
    }
    throw new Error(result.error ?? 'The session could not be started.')
  } finally {
    starting.delete(runId)
  }
}

/** Abort the turn of an SDK session; a CLI session, or one with no backend session yet, is left alone. */
async function abortSdkSession(sessionId: string): Promise<void> {
  const found = await findSessionById(sessionId)
  if (!found || isAgentCli(found.session.agent_sdk)) return
  const { session, workingPath } = found
  if (!workingPath || !session.opencode_session_id) return
  const result = unwrapEnvelope(await opencodeApi.abort(workingPath, session.opencode_session_id))
  if (!result.success) throw new Error('The session did not stop.')
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Stop a CLI session: Escape, as the user would press it, which keeps the session open to be
 * read. Escape interrupts a turn and nothing else: a CLI that is still starting, or parked on
 * background work between turns, carries on regardless. So unless the interrupt is reported
 * within CLI_INTERRUPT_WAIT_MS the process is closed, which stops whatever it was at.
 */
async function stopCliSession(sessionId: string): Promise<void> {
  const since = Date.now()
  terminalApi.write(sessionId, CLI_INTERRUPT_KEY)
  for (let waited = 0; waited < CLI_INTERRUPT_WAIT_MS; waited += CLI_INTERRUPT_POLL_MS) {
    await delay(CLI_INTERRUPT_POLL_MS)
    const signal = getSessionSignal(sessionId)
    const interrupted =
      signal.kind === 'ended' && signal.at >= since && USER_STOP_REASONS.has(signal.reason ?? '')
    // An interrupted turn with background work still going has not stopped everything.
    if (interrupted && !signal.hasBackgroundWork) return
  }
  const closed = await useSessionStore.getState().closeSession(sessionId)
  if (!closed.success) throw new Error(closed.error ?? 'The session did not stop.')
}

/** Stop a session for good: the abort RPC for an SDK session, Escape (or closing it) for a CLI one. */
async function abortSession(sessionId: string): Promise<void> {
  const found = await findSessionById(sessionId)
  if (!found) return
  if (isAgentCli(found.session.agent_sdk)) return stopCliSession(sessionId)
  return abortSdkSession(sessionId)
}

/**
 * Stop the run's migration session and release the run: its ticket returns to Review. The
 * session is kept, so what it did until then can be read. A session that could not be reached
 * is reported, but the run is released all the same.
 */
export async function stopRunMigrations(runId: string): Promise<void> {
  const store = useDocumentFlowStore.getState()
  const sessionId = store.runsById[runId]?.run.migration_session_id
  if (!sessionId) return
  let abortError: unknown = null
  // The watcher stands back: the end it would see is this stop, which reports it itself.
  ending.add(runId)
  try {
    try {
      await abortSession(sessionId)
    } catch (error) {
      abortError = error
    }
    store.applyDetail(await documentFlowApi.endMigrations(runId, sessionId, 'stopped'))
    launched.delete(sessionId)
  } finally {
    ending.delete(runId)
  }
  if (abortError) {
    throw new Error(
      `The run was released, but its migration session could not be stopped (${describeError(abortError)}). Open the session to stop it.`
    )
  }
}

// ── Watching ───────────────────────────────────────────────────────────────

type Observation =
  | { kind: 'running' }
  | { kind: 'settling'; until: number }
  /** `died`: the session ended without its agent finishing the turn (a crash, an API error). */
  | { kind: 'over'; outcome: DocumentMigrationOutcome; died?: boolean }
  /** This page has no status for the session: only the server's record can tell. */
  | { kind: 'unknown' }

/** What the page's own session status says about a migration session started at `startedAt`. */
export function observeMigrationSession(
  sessionId: string,
  startedAt: number,
  now: number
): Observation {
  const signal = getSessionSignal(sessionId)
  if (signal.kind === 'working' || signal.kind === 'blocked') return { kind: 'running' }
  if (signal.kind === 'unknown') return { kind: 'unknown' }

  const reason = signal.reason ?? ''
  if (signal.hookEvent === SESSION_START_HOOK || reason === PROCESS_START_REASON) {
    return { kind: 'running' }
  }
  // `waiting`: the agent paused for background work and wakes itself.
  if (signal.completion === 'waiting') return { kind: 'running' }
  // An end from before the session was recorded says nothing about its first turn.
  if (signal.at < startedAt) return { kind: 'unknown' }
  if (now - signal.at < MIGRATION_SETTLE_MS) {
    return { kind: 'settling', until: signal.at + MIGRATION_SETTLE_MS }
  }
  if (USER_STOP_REASONS.has(reason)) return { kind: 'over', outcome: 'stopped' }
  const died =
    Boolean(signal.apiError) ||
    signal.completion === 'none' ||
    reason === PROCESS_END_REASON ||
    signal.hookEvent === PROCESS_END_HOOK
  return { kind: 'over', outcome: 'finished', ...(died ? { died } : {}) }
}

/**
 * A session this page cannot see (it was reloaded since the launch): over when its row was
 * closed, or when the main process recorded a turn end since the session was started.
 */
async function lookUpMigrationSession(
  sessionId: string,
  startedAt: number
): Promise<DocumentMigrationOutcome | null> {
  const row =
    useSessionStore.getState().getSessionById(sessionId) ??
    (await dbApi.session.get<Session>(sessionId))
  if (!row || row.status === 'completed') return 'stopped'
  const turn = await documentFlowApi.sessionTurn(sessionId)
  if (!turn || turn.state !== 'ended' || turn.hook_event === SESSION_START_HOOK) return null
  if (turn.completion === 'waiting') return null
  const endedAt = Date.parse(turn.updated_at)
  if (!Number.isFinite(endedAt) || endedAt < startedAt) return null
  if (Date.now() - endedAt < MIGRATION_SETTLE_MS) return null
  return turn.hook_event === RECORDED_INTERRUPT_EVENT ? 'stopped' : 'finished'
}

async function reportOver(
  run: DocumentRun,
  sessionId: string,
  outcome: DocumentMigrationOutcome,
  died = false
): Promise<void> {
  if (ending.has(run.id)) return
  ending.add(run.id)
  try {
    const detail = await documentFlowApi.endMigrations(run.id, sessionId, outcome)
    useDocumentFlowStore.getState().applyDetail(detail)
    launched.delete(sessionId)
    const name = run.title || (isTicketRun(run) ? 'the orchestrator' : 'the document run')
    if (died) {
      toast.warning(
        `The migration session of ${name} ended before it was done. Open it to see how far it got.`
      )
    } else if (outcome === 'finished') {
      toast.success(`The migration session of ${name} finished. Open it to read what it ran.`)
    } else {
      toast.info(`The migration session of ${name} was stopped.`)
    }
  } catch (error) {
    // Left as it is: the next tick asks again.
    console.warn('[documentFlow] could not report the end of a migration session', error)
  } finally {
    ending.delete(run.id)
  }
}

/**
 * Mount-once (with the document-flow runner): follows the migration session of every loaded
 * run and tells the server when it is over, which returns the run's ticket to Review. Safe in
 * several windows at once: the server ends a session once.
 */
export function startMigrationWatcher(): () => void {
  startSessionSignalLatch()
  let stopped = false
  let debounce: ReturnType<typeof setTimeout> | null = null
  let wake: ReturnType<typeof setTimeout> | null = null
  const lookups = new Map<string, number>()

  const schedule = (): void => {
    if (stopped || debounce) return
    debounce = setTimeout(() => {
      debounce = null
      tick()
    }, TICK_DEBOUNCE_MS)
  }

  const wakeAt = (at: number): void => {
    if (wake) clearTimeout(wake)
    wake = setTimeout(
      () => {
        wake = null
        schedule()
      },
      Math.max(0, at - Date.now())
    )
  }

  const lookUp = (run: DocumentRun, sessionId: string, startedAt: number, now: number): void => {
    if (now - (lookups.get(sessionId) ?? 0) < MIGRATION_POLL_MS) return
    lookups.set(sessionId, now)
    lookUpMigrationSession(sessionId, startedAt)
      .then((outcome) => {
        if (!stopped && outcome) void reportOver(run, sessionId, outcome)
      })
      .catch(() => undefined)
  }

  const tick = (): void => {
    if (stopped) return
    const now = Date.now()
    for (const { run } of Object.values(useDocumentFlowStore.getState().runsById)) {
      const sessionId = run.migration_session_id
      if (!sessionId || ending.has(run.id)) continue
      const startedAt = Date.parse(run.migration_started_at ?? '') || 0
      const seen = observeMigrationSession(sessionId, startedAt, now)
      if (seen.kind === 'over') void reportOver(run, sessionId, seen.outcome, seen.died)
      else if (seen.kind === 'settling') wakeAt(seen.until)
      else if (seen.kind === 'unknown') lookUp(run, sessionId, startedAt, now)
    }
  }

  const unsubscribes = [
    useDocumentFlowStore.subscribe((state, previous) => {
      if (state.runsById !== previous.runsById) schedule()
    }),
    useWorktreeStatusStore.subscribe((state, previous) => {
      if (state.sessionStatuses !== previous.sessionStatuses) schedule()
    })
  ]
  const interval = setInterval(schedule, MIGRATION_POLL_MS)
  schedule()

  return () => {
    stopped = true
    for (const unsubscribe of unsubscribes) unsubscribe()
    clearInterval(interval)
    if (debounce) clearTimeout(debounce)
    if (wake) clearTimeout(wake)
  }
}

export function resetMigrationStateForTests(): void {
  starting.clear()
  launched.clear()
  ending.clear()
}

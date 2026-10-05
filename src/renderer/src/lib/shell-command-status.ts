/**
 * Maps the run state of shell-command sessions onto useWorktreeStatusStore, which
 * drives the unchanged kanban machinery (session_working / session_completed /
 * session_error) and the ticket card's error badge.
 *
 * Contract (D2): running -> In Progress; succeeded -> Review; failed / interrupted ->
 * Review with the red error mark (exit code in the text); cancelled (user Stop) ->
 * Review without a mark; pending -> nothing. Main is the only writer of the state:
 * this module only mirrors it, live (applyShellCommandRunStatus) or from the persisted
 * snapshots after a board load (reconcileShellCommandTickets).
 */
import type { ShellCommandStatusPayload } from '@shared/shell-command-events'
import { describeShellCommandFailure, type SessionShellCommand } from '@shared/lib/shell-commands'
import { useShellCommandRunStore } from '@/stores/useShellCommandRunStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { lastSendMode, messageSendTimes, userExplicitSendTimes } from '@/lib/message-send-times'

type RunOutcome = Pick<SessionShellCommand, 'state' | 'exitCode' | 'reason' | 'error'>

/** The error mark of a failed / interrupted run (never null for those states). */
function failureMessage(run: RunOutcome): string {
  return describeShellCommandFailure(run) ?? 'Command failed'
}

/**
 * Seed the elapsed-timer maps from the run's start time when they have no entry yet
 * (a run adopted after a reload / restart). Called AFTER the status flip on purpose:
 * a fresh userExplicitSendTimes stamp would make setSessionStatus('working') count
 * as an explicit send and reopen a done/merged ticket.
 */
function stampTimerMapsFromStart(sessionId: string, startedAt: string | null): void {
  if (!startedAt) return
  const time = Date.parse(startedAt)
  if (!Number.isFinite(time)) return
  if (!messageSendTimes.has(sessionId)) messageSendTimes.set(sessionId, time)
  if (!userExplicitSendTimes.has(sessionId)) userExplicitSendTimes.set(sessionId, time)
}

/** Idempotent: the status flips to 'working' only when it is not already there. */
function markWorking(sessionId: string, startedAt: string | null): void {
  const status = useWorktreeStatusStore.getState()
  lastSendMode.set(sessionId, 'build')
  if (status.sessionStatuses[sessionId]?.status !== 'working') {
    // Main's 'running' is the authority that a new run began: the previous run's
    // error mark goes (setSessionStatus only drops it on Claude hook evidence).
    status.clearSessionApiError(sessionId)
    status.setSessionStatus(sessionId, 'working')
  }
  stampTimerMapsFromStart(sessionId, startedAt)
}

/**
 * Seed 'working' for every run the index says is running. For a renderer that mounted
 * after the runs started (window reload, second window): the live 'running' event is
 * gone and the board-load reconcile only covers the boards it loads.
 */
export function markRunningShellCommandsWorking(): void {
  const runs = useShellCommandRunStore.getState().runsBySession
  for (const [sessionId, run] of Object.entries(runs)) {
    if (run.state === 'running') markWorking(sessionId, run.startedAt)
  }
}

function markSucceeded(sessionId: string): void {
  const status = useWorktreeStatusStore.getState()
  status.clearSessionApiError(sessionId)
  lastSendMode.set(sessionId, 'build')
  status.setSessionStatus(sessionId, 'completed')
}

function markFailed(sessionId: string, message: string): void {
  const status = useWorktreeStatusStore.getState()
  status.setSessionApiError(sessionId, message)
  status.setSessionStatus(sessionId, 'completed', { apiError: message })
}

function markCancelled(sessionId: string): void {
  useWorktreeStatusStore
    .getState()
    .setSessionStatus(sessionId, 'completed', { reason: 'user_interrupt' })
}

/** Live mapping of one `shell-command:status` event (main publishes one per transition). */
export function applyShellCommandRunStatus(payload: ShellCommandStatusPayload): void {
  const { sessionId } = payload
  const runStore = useShellCommandRunStore.getState()
  const known = runStore.mergeRun(sessionId, {
    state: payload.state,
    runId: payload.runId,
    exitCode: payload.exitCode,
    signal: payload.signal,
    detached: payload.detached,
    reason: payload.reason,
    error: payload.error,
    startedAt: payload.startedAt,
    finishedAt: payload.finishedAt
  })
  // A session this renderer has not indexed yet (created by another window, or the
  // index was never loaded): pull the whole list rather than guessing its snapshot.
  if (!known) void runStore.loadAll()

  const current = useWorktreeStatusStore.getState().sessionStatuses[sessionId]?.status ?? null
  switch (payload.state) {
    case 'running':
      markWorking(sessionId, payload.startedAt)
      return
    case 'succeeded':
      markSucceeded(sessionId)
      return
    case 'failed':
    case 'interrupted':
      markFailed(sessionId, failureMessage(payload))
      return
    case 'cancelled':
      // When the status was already cleared (tab close, ticket dragged back) the
      // teardown path owns the outcome: do nothing.
      if (current === 'working') markCancelled(sessionId)
      return
    case 'pending':
      return
  }
}

/**
 * The renderer could not start (or restart) the run: record the failure locally. It
 * produces the same text main publishes for a start failure, so it is idempotent
 * with the status event when main does get to publish one.
 */
export function markShellCommandStartFailed(sessionId: string, error: string): void {
  useShellCommandRunStore.getState().mergeRun(sessionId, {
    state: 'failed',
    reason: 'start-failed',
    error,
    finishedAt: new Date().toISOString()
  })
  markFailed(
    sessionId,
    failureMessage({ state: 'failed', reason: 'start-failed', error, exitCode: null })
  )
}

/**
 * Repeat the mapping from the persisted run snapshots for every ticket of a project
 * (called at the end of every board load): a run that finished while the board was
 * not loaded, or while the app was closed, still moves its ticket. Never rejects.
 */
export async function reconcileShellCommandTickets(projectId: string): Promise<void> {
  try {
    await useShellCommandRunStore.getState().loadAll()
    const runs = useShellCommandRunStore.getState().runsBySession
    const tickets = useKanbanStore.getState().tickets.get(projectId) ?? []
    for (const ticket of tickets) {
      if (ticket.archived_at || !ticket.current_session_id) continue
      const sessionId = ticket.current_session_id
      const run = runs[sessionId]
      if (!run) continue
      const status = useWorktreeStatusStore.getState()
      const inProgress = ticket.column === 'in_progress'
      switch (run.state) {
        case 'running':
          markWorking(sessionId, run.startedAt)
          break
        case 'succeeded':
          if (inProgress) markSucceeded(sessionId)
          break
        case 'failed':
        case 'interrupted': {
          const message = failureMessage(run)
          if (
            (inProgress || ticket.column === 'review') &&
            status.sessionApiErrors[sessionId] !== message
          ) {
            // Restores the badge after a restart (sessionApiErrors is not persisted).
            status.setSessionApiError(sessionId, message)
          }
          if (inProgress) status.setSessionStatus(sessionId, 'completed', { apiError: message })
          break
        }
        case 'cancelled':
          if (inProgress) markCancelled(sessionId)
          break
        case 'pending':
          break
      }
    }
  } catch {
    // Best-effort: the next board load tries again.
  }
}

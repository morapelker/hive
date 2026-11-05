import { useEffect, useMemo, useState } from 'react'
import { documentFlowApi } from '@/api/document-flow-api'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useQuestionStore } from '@/stores/useQuestionStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { runBoardCardState, type RunBoardCardState } from './document-flow-ui'

export interface DocumentRunTicketView {
  /** Null until the run is loaded, and for good when its record is gone. */
  state: RunBoardCardState | null
  /** The server no longer knows the run: it was deleted without its ticket. */
  missing: boolean
}

/**
 * Whether a run's migration session waits on the user: a question it asked, a permission or a
 * command to approve. The run's ticket holds no session, so nothing else on the board says so.
 */
export function useMigrationSessionWaiting(sessionId: string | null): boolean {
  const asked = useQuestionStore(
    (s) => sessionId !== null && (s.pendingBySession.get(sessionId)?.length ?? 0) > 0
  )
  const blocked = useWorktreeStatusStore((s) => {
    const status = sessionId ? s.sessionStatuses[sessionId]?.status : undefined
    return status === 'answering' || status === 'permission' || status === 'command_approval'
  })
  return asked || blocked
}

/**
 * What the ticket of a document run shows, from the run it stands for (an orchestrator made
 * from board tickets too: `state.sourceKind` tells the card which marker to wear). Runs past
 * the listed page (and runs of a board opened before the list arrived) are fetched once.
 */
export function useDocumentRunTicket(
  runId: string | null,
  column: string
): DocumentRunTicketView | null {
  const detail = useDocumentFlowStore((s) => (runId ? s.runsById[runId] : undefined))
  const [missing, setMissing] = useState(false)
  const loaded = detail !== undefined

  useEffect(() => {
    if (!runId || loaded) return
    let cancelled = false
    // Not `refreshRun`: a fetch that failed says nothing about the record being gone.
    documentFlowApi
      .get(runId)
      .then((found) => {
        if (found) useDocumentFlowStore.getState().applyDetail(found)
        else if (!cancelled) setMissing(true)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [runId, loaded])

  const migrationWaiting = useMigrationSessionWaiting(detail?.run.migration_session_id ?? null)
  const state = useMemo(
    () => (detail ? runBoardCardState(detail, column, migrationWaiting) : null),
    [detail, column, migrationWaiting]
  )
  if (!runId) return null
  return { state, missing: missing && !loaded }
}

/**
 * The tone of the 2px stripe at the left of a run's ticket (drawn by `.ticket-elite::after` from
 * `--ticket-state-tone`): the same cue a ticket at work has, in the run's state. Without a
 * state the stripe falls back to the muted gray.
 */
export function documentRunTicketToneClass(view: DocumentRunTicketView): string | null {
  const { state } = view
  if (!state) return null
  if (state.waitingOnUser) return '[--ticket-state-tone:#f97316]'
  // The only session at work is a merged ticket's updating the document: the pink of its bar
  if (state.editingDocument) return '[--ticket-state-tone:#ec4899]'
  switch (state.phase) {
    // Before launch: blue while the tickets are extracted, green once they are ready
    case 'extracting':
    case 'running':
      return '[--ticket-state-tone:#3b82f6]'
    case 'ready':
      return '[--ticket-state-tone:#10b981]'
    case 'extract_failed':
      return '[--ticket-state-tone:#ef4444]'
    case 'paused':
    case 'cancelled':
      return '[--ticket-state-tone:var(--muted-foreground)]'
    case 'issues':
      return '[--ticket-state-tone:#ef4444]'
    case 'completed':
      return '[--ticket-state-tone:#10b981]'
    case 'migrating':
      return '[--ticket-state-tone:#d946ef]'
  }
}

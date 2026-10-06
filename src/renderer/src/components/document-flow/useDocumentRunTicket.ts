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
 * What the ticket of a document run shows, from the run it stands for. Runs past the listed
 * page (and runs of a board opened before the list arrived) are fetched once.
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

/** The 2px left rail of a run's ticket: the same cue a ticket at work has, in the run's state. */
export function documentRunTicketRailClass(view: DocumentRunTicketView): string | null {
  const { state } = view
  if (!state) return null
  if (state.waitingOnUser) return 'border-l-2 !border-l-orange-500'
  switch (state.phase) {
    case 'running':
      return 'border-l-2 !border-l-blue-500/60'
    case 'paused':
    case 'cancelled':
      return 'border-l-2 !border-l-muted-foreground/40'
    case 'issues':
      return 'border-l-2 !border-l-amber-500/70'
    case 'completed':
      return 'border-l-2 !border-l-emerald-500/60'
    case 'migrating':
      return 'border-l-2 !border-l-fuchsia-500/60'
  }
}

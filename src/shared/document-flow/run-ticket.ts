import type { DocumentRunStatus } from '../types/document-flow'

// A run has one ticket of its own on the board from the moment it is created: in To Do it shows
// the extraction and, once the tickets are ready, opens the run's preview to launch it; launched,
// it moves In Progress, shows the run's progress, opens the run dashboard, and moving it to Done
// merges the integration branch like any ticket's worktree. It is an ordinary ticket row marked
// through the external-source fields, which both board backends (database and markdown) already
// store, so no ticket column is needed.

/** `external_provider` of a run's own ticket; `external_id` is then the run id. */
export const DOCUMENT_RUN_TICKET_PROVIDER = 'document-run'

interface ExternalRef {
  external_provider?: string | null
  external_id?: string | null
}

export function isDocumentRunTicket(ticket: ExternalRef | null | undefined): boolean {
  return ticket?.external_provider === DOCUMENT_RUN_TICKET_PROVIDER
}

/** The run a ticket stands for; null for every other ticket. */
export function documentRunIdOf(ticket: ExternalRef | null | undefined): string | null {
  return isDocumentRunTicket(ticket) ? ticket?.external_id || null : null
}

/**
 * Not launched yet: its tickets are being extracted, could not be, or wait in the preview. The
 * run's ticket sits in To Do meanwhile, and only launching moves it on.
 */
export function isUnlaunchedRunStatus(status: DocumentRunStatus): boolean {
  return status === 'extracting' || status === 'extract_failed' || status === 'preview'
}

/** Running or paused: the orchestrator still owns the run, and its ticket stays In Progress. */
export function isActiveRunStatus(status: DocumentRunStatus): boolean {
  return status === 'running' || status === 'paused'
}

/** Finished or cancelled after launch: the run's ticket is the user's to review and merge. */
export function isEndedRunStatus(status: DocumentRunStatus): boolean {
  return status === 'completed' || status === 'completed_with_issues' || status === 'cancelled'
}

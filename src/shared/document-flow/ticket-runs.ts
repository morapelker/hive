// Runs made from board tickets ("orchestrators"): which tickets a run may adopt, the keys and
// title it gives them, and the wording that tells such a run from one made from a document.
// Pure and shared: the service enforces these rules, the renderer shows them before asking.

import { shellCommandIdOfTicket } from '../lib/shell-commands'
import { ticketKeyOf } from '../ticket-key'
import type {
  DocumentRun,
  DocumentRunItem,
  DocumentRunItemDraft,
  DocumentRunLaunchConfig,
  DocumentRunStatus
} from '../types/document-flow'
import { DOCUMENT_RUN_TICKET_PROVIDER } from './run-ticket'

/** A board ticket as far as adopting it into a run goes (`KanbanTicket` satisfies it). */
export interface TicketRunCandidate {
  id: string
  project_id: string
  title: string
  description: string | null
  column: string
  archived_at: string | null
  current_session_id: string | null
  external_provider: string | null
  external_id: string | null
  ticket_prefix: string | null
  ticket_number: number | null
  pending_launch_config?: string | null
}

/** The run that holds a ticket already, as the eligibility check needs it. */
export interface TicketRunOwner {
  runId: string
  title: string
  status: DocumentRunStatus
}

/** Run statuses in which a run still owns its tickets (one run per ticket at a time). */
const OWNING_RUN_STATUSES: readonly DocumentRunStatus[] = [
  'extracting',
  'extract_failed',
  'preview',
  'running',
  'paused'
]

/** Whether a run in `status` still owns the tickets of its items. */
export function runOwnsItsTickets(status: DocumentRunStatus): boolean {
  return OWNING_RUN_STATUSES.includes(status)
}

/** Run statuses that take more tickets: before launch, while it runs, and once it finished. */
const TICKET_RUN_ADDABLE_STATUSES: readonly DocumentRunStatus[] = [
  'preview',
  'running',
  'paused',
  'completed',
  'completed_with_issues'
]

/**
 * Whether tickets can be added to the run now. A finished run (not a cancelled one) takes them
 * too: it resumes on its integration branch. Only runs made from board tickets take tickets.
 */
export function canAddTicketsToRun(
  run: Pick<DocumentRun, 'source_kind' | 'status' | 'migration_session_id'>
): boolean {
  return (
    run.source_kind === 'tickets' &&
    TICKET_RUN_ADDABLE_STATUSES.includes(run.status) &&
    !run.migration_session_id
  )
}

/** A finished run that adding tickets would resume. */
export function addingTicketsResumesRun(run: Pick<DocumentRun, 'status'>): boolean {
  return run.status === 'completed' || run.status === 'completed_with_issues'
}

/**
 * Why `ticket` cannot join a run, or null when it can. `owner` is the run that holds it already
 * (a run that still owns its tickets, see `runOwnsItsTickets`), if any; `runId` is the run it
 * would join (a ticket already in that run is refused as such).
 */
export function ticketRunRefusal(
  ticket: TicketRunCandidate,
  owner: TicketRunOwner | null,
  runId: string | null = null
): string | null {
  if (ticket.external_provider === DOCUMENT_RUN_TICKET_PROVIDER) {
    return 'An orchestrator ticket cannot be part of another run.'
  }
  if (shellCommandIdOfTicket(ticket)) return 'A shell command ticket runs no agent.'
  if (ticket.archived_at) return 'It is archived.'
  if (owner && runId && owner.runId === runId) return 'It is already part of this run.'
  if (owner) return `It is already part of “${owner.title}”.`
  if (ticket.current_session_id) {
    return 'It already has a session. Only tickets that have not been launched can be orchestrated.'
  }
  if (ticket.column === 'todo') return null
  // "Save & Queue" leaves a blocked ticket In Progress without a session: it has not started.
  if (ticket.column === 'in_progress') return null
  return `It is in ${COLUMN_NAMES[ticket.column] ?? ticket.column}; only tickets that have not been launched can be orchestrated.`
}

const COLUMN_NAMES: Record<string, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  review: 'Review',
  merged: 'Merged',
  done: 'Done'
}

/**
 * The item keys for `tickets`, unique among themselves and `takenKeys`: the ticket's own key
 * (`TD-12`) when it has one, else `T1`, `T2`, … (markdown boards have no ticket keys).
 */
export function mintTicketRunKeys(
  tickets: readonly Pick<TicketRunCandidate, 'ticket_prefix' | 'ticket_number'>[],
  takenKeys: Iterable<string> = []
): string[] {
  const taken = new Set(takenKeys)
  let counter = 0
  const next = (): string => {
    let key: string
    do key = `T${++counter}`
    while (taken.has(key))
    return key
  }
  return tickets.map((ticket) => {
    let key = ticketKeyOf(ticket) ?? next()
    if (taken.has(key)) {
      let suffix = 2
      while (taken.has(`${key}-${suffix}`)) suffix += 1
      key = `${key}-${suffix}`
    }
    taken.add(key)
    return key
  })
}

const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim()

/** Default title of a run made from `tickets`: "First ticket", or "First ticket + 2 more". */
export function defaultTicketRunTitle(
  tickets: readonly Pick<TicketRunCandidate, 'title'>[]
): string {
  const first = oneLine(tickets[0]?.title ?? '') || 'Orchestrator'
  const head = first.length > 60 ? `${first.slice(0, 59).trimEnd()}…` : first
  return tickets.length > 1 ? `${head} + ${tickets.length - 1} more` : head
}

/**
 * A queued launch's model (the ticket's `pending_launch_config`, written by "Save & Queue"),
 * as the item's launch config; null when it has none or it cannot be read. A multi-model
 * queue keeps its first model: a run gives each ticket one session.
 */
export function launchConfigFromQueued(
  pendingLaunchConfig: string | null | undefined
): DocumentRunLaunchConfig | null {
  if (!pendingLaunchConfig) return null
  try {
    const parsed = JSON.parse(pendingLaunchConfig) as Record<string, unknown>
    const first =
      Array.isArray(parsed.models) && parsed.models.length > 0
        ? (parsed.models[0] as Record<string, unknown>)
        : parsed
    const sdk = (first.sdk ?? parsed.sdk) as DocumentRunLaunchConfig['sdk'] | undefined
    const model = (first.model ?? parsed.model) as DocumentRunLaunchConfig['model'] | undefined
    if (typeof sdk !== 'string') return null
    const validModel =
      model &&
      typeof model === 'object' &&
      typeof model.providerID === 'string' &&
      typeof model.modelID === 'string'
        ? {
            providerID: model.providerID,
            modelID: model.modelID,
            ...(typeof model.variant === 'string' ? { variant: model.variant } : {})
          }
        : null
    const customProviderId = first.customProviderId ?? parsed.customProviderId
    return {
      sdk,
      model: validModel,
      codexFastMode: Boolean(first.codexFastMode ?? parsed.codexFastMode),
      ...(typeof customProviderId === 'string' ? { customProviderId } : {})
    }
  } catch {
    return null
  }
}

/** The item draft for an adopted ticket: no extraction, the ticket is the task. */
export function ticketRunItemDraft(
  ticket: TicketRunCandidate,
  key: string
): DocumentRunItemDraft & { ticket_id: string } {
  return {
    key,
    title: oneLine(ticket.title) || key,
    summary: '',
    description: ticket.description ?? '',
    kind: 'change',
    depends_on: [],
    has_migration: false,
    size: null,
    conflict_risk: null,
    doc_status: 'open',
    selected: true,
    figures: [],
    open_questions: [],
    verification_suggested: [],
    verification: [],
    verification_reason: '',
    launch_config: launchConfigFromQueued(ticket.pending_launch_config),
    ticket_id: ticket.id
  }
}

/**
 * Board dependency edges (`dependent_id` waits for `blocker_id`) as the items' `depends_on`
 * keys: only edges between two of the run's tickets count. Keys follow item order.
 */
export function dependsOnFromBoard(
  items: readonly Pick<DocumentRunItem, 'key' | 'ticket_id'>[],
  edges: readonly { dependent_id: string; blocker_id: string }[]
): Record<string, string[]> {
  const keyOfTicket = new Map<string, string>()
  for (const item of items) if (item.ticket_id) keyOfTicket.set(item.ticket_id, item.key)
  const order = new Map(items.map((item, index) => [item.key, index]))
  const result: Record<string, string[]> = Object.fromEntries(items.map((item) => [item.key, []]))
  for (const edge of edges) {
    const dependent = keyOfTicket.get(edge.dependent_id)
    const blocker = keyOfTicket.get(edge.blocker_id)
    if (!dependent || !blocker || dependent === blocker) continue
    if (!result[dependent].includes(blocker)) result[dependent].push(blocker)
  }
  for (const key of Object.keys(result)) {
    result[key].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
  }
  return result
}

/** "Orchestrator" for a run made from board tickets, "Document run" otherwise (UI copy). */
export function runKindLabel(run: Pick<DocumentRun, 'source_kind'> | null | undefined): string {
  return run?.source_kind === 'tickets' ? 'Orchestrator' : 'Document run'
}

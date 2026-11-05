import {
  buildTicketBrief,
  runRulesParagraphs,
  type TicketBriefInput
} from '@shared/document-flow/prompts'
import { DOCUMENT_RUN_TICKET_PROVIDER } from '@shared/document-flow/run-ticket'
import {
  runKindLabel,
  runOwnsItsTickets,
  type TicketRunCandidate,
  type TicketRunOwner
} from '@shared/document-flow/ticket-runs'
import { shellCommandIdOfTicket } from '@shared/lib/shell-commands'
import { ticketKeyOf } from '@shared/ticket-key'
import type { DocumentRunDetail, DocumentRunItem } from '@shared/types/document-flow'
import { pluralize } from './document-flow-ui'

// What the wizard and the dashboard show of an orchestrator made from board tickets (a run
// whose `source_kind` is `tickets`): which board tickets the picker lists and which it can
// take, the order they join the run in, the blockers left out of the pick, and the prompt an
// agent receives. Pure, like document-flow-ui; the eligibility rules themselves are shared
// with the service (shared/document-flow/ticket-runs.ts).

/** Where the wizard's pick step takes the tickets from. */
export type WizardSource = 'document' | 'tickets'

/** The wizard's empty state when the board offers nothing the run could take. */
export const NO_ORCHESTRATABLE_TICKETS =
  'No tickets to orchestrate yet. Create tickets on the board — they can depend on each other — then come back.'

/** What the ticket editor says about where its text goes. */
export const TICKET_BRIEF_HELP =
  "This is the ticket on your board: the agent gets its title and description as written, plus the run's rules."

// ── Board tickets ──────────────────────────────────────────────────────────

/** A board ticket as the picker reads it (`KanbanTicket` satisfies it). */
export interface PickerTicket extends TicketRunCandidate {
  sort_order: number
}

/**
 * Tickets the picker leaves out entirely rather than listing them disabled: a run's own
 * ticket, a shell command ticket (no agent to orchestrate) and an archived ticket. Everything
 * else is listed, and the ones that cannot join say why.
 */
export function isHiddenFromTicketPicker(
  ticket: Pick<TicketRunCandidate, 'external_provider' | 'external_id' | 'archived_at'>
): boolean {
  return (
    ticket.external_provider === DOCUMENT_RUN_TICKET_PROVIDER ||
    shellCommandIdOfTicket(ticket) !== null ||
    !!ticket.archived_at
  )
}

/** Board order of the columns, for sorting a project's tickets the way its board reads. */
const COLUMN_RANK: Record<string, number> = {
  todo: 0,
  in_progress: 1,
  review: 2,
  merged: 3,
  done: 4
}

/** The project's tickets in board order: column by column, each in its own order. */
export function sortBoardTickets<T extends Pick<PickerTicket, 'column' | 'sort_order'>>(
  tickets: readonly T[]
): T[] {
  return [...tickets].sort(
    (a, b) =>
      (COLUMN_RANK[a.column] ?? 9) - (COLUMN_RANK[b.column] ?? 9) || a.sort_order - b.sort_order
  )
}

/** Whether a ticket matches the picker's search: its title or its key (`td-12`), any case. */
export function ticketMatchesSearch(
  ticket: Pick<TicketRunCandidate, 'title' | 'ticket_prefix' | 'ticket_number'>,
  query: string
): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  if (ticket.title.toLowerCase().includes(needle)) return true
  return (ticketKeyOf(ticket) ?? '').toLowerCase().includes(needle)
}

/** How a ticket is named in a sentence: its key (`TD-12`), else its title in quotes. */
export function ticketLabel(
  ticket: Pick<TicketRunCandidate, 'title' | 'ticket_prefix' | 'ticket_number'>
): string {
  return ticketKeyOf(ticket) ?? `“${ticket.title.trim() || 'Untitled ticket'}”`
}

/**
 * The run that holds each ticket, for every run that still owns its tickets (see
 * `runOwnsItsTickets`): an item's ticket belongs to one such run at a time.
 */
export function ticketRunOwners(
  runs: Iterable<Pick<DocumentRunDetail, 'run' | 'items'>>
): Map<string, TicketRunOwner> {
  const owners = new Map<string, TicketRunOwner>()
  for (const { run, items } of runs) {
    if (!runOwnsItsTickets(run.status)) continue
    const owner: TicketRunOwner = {
      runId: run.id,
      title: run.title || runKindLabel(run),
      status: run.status
    }
    for (const item of items) if (item.ticket_id) owners.set(item.ticket_id, owner)
  }
  return owners
}

/** Board columns whose tickets count as finished blockers (their work has landed). */
const FINISHED_COLUMNS = new Set(['done', 'merged'])

/** The blockers of a ticket that still hold it back on the board (not Done nor Merged). */
export function unresolvedBlockers<T extends Pick<TicketRunCandidate, 'column'>>(
  ticketId: string,
  blockersOf: ReadonlyMap<string, readonly string[]>,
  ticketsById: ReadonlyMap<string, T>
): T[] {
  return (blockersOf.get(ticketId) ?? []).flatMap((blockerId) => {
    const blocker = ticketsById.get(blockerId)
    return blocker && !FINISHED_COLUMNS.has(blocker.column) ? [blocker] : []
  })
}

export interface MissingBlockers {
  /** Picked tickets that wait for tickets left out, each with the ones it waits for directly. */
  dependents: { ticketId: string; missing: string[] }[]
  /**
   * Everything "Add them" adds: the left-out blockers that could join, and theirs in turn, so
   * one click closes the pick over the board's dependencies (board order).
   */
  closure: string[]
}

/**
 * Board blockers of the picked tickets that could join the run but were not picked. A blocker
 * that cannot join (launched, done, in another run) is not offered: the run cannot wait for
 * it, and the board's own rules still apply to it.
 */
export function missingBlockers(
  selectedIds: readonly string[],
  blockersOf: ReadonlyMap<string, readonly string[]>,
  canJoin: (ticketId: string) => boolean,
  boardOrder: readonly string[] = []
): MissingBlockers {
  const selected = new Set(selectedIds)
  const dependents: MissingBlockers['dependents'] = []
  const closure = new Set<string>()
  const stack: string[] = []
  for (const ticketId of selectedIds) {
    const missing = (blockersOf.get(ticketId) ?? []).filter(
      (blockerId) => !selected.has(blockerId) && canJoin(blockerId)
    )
    if (missing.length === 0) continue
    dependents.push({ ticketId, missing })
    stack.push(...missing)
  }
  while (stack.length > 0) {
    const ticketId = stack.pop() as string
    if (closure.has(ticketId)) continue
    closure.add(ticketId)
    for (const blockerId of blockersOf.get(ticketId) ?? []) {
      if (!selected.has(blockerId) && !closure.has(blockerId) && canJoin(blockerId)) {
        stack.push(blockerId)
      }
    }
  }
  const rank = new Map(boardOrder.map((id, index) => [id, index]))
  return {
    dependents,
    closure: [...closure].sort(
      (a, b) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER)
    )
  }
}

/**
 * The note under the picker: "TD-12 waits for 2 tickets you have not picked." for one picked
 * ticket, "3 picked tickets wait for tickets you have not picked." for more.
 */
export function describeMissingBlockers(
  dependents: MissingBlockers['dependents'],
  labelOf: (ticketId: string) => string
): string | null {
  if (dependents.length === 0) return null
  if (dependents.length === 1) {
    const [only] = dependents
    const count = only.missing.length
    return `${labelOf(only.ticketId)} waits for ${count === 1 ? 'a ticket' : `${count} tickets`} you have not picked.`
  }
  return `${dependents.length} picked tickets wait for tickets you have not picked.`
}

/**
 * The order picked tickets join the run in (their items' positions): blockers before the
 * tickets that wait for them, otherwise board order. The scheduler goes by dependencies, so
 * this only decides how the list reads (and the T1… keys of a board without ticket keys).
 */
export function orderTicketIdsForRun(
  ids: readonly string[],
  boardOrder: readonly string[],
  blockersOf: ReadonlyMap<string, readonly string[]>
): string[] {
  const picked = new Set(ids)
  const rank = new Map(boardOrder.map((id, index) => [id, index]))
  const byBoard = [...picked].sort(
    (a, b) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER)
  )
  const placed = new Set<string>()
  const visiting = new Set<string>()
  const ordered: string[] = []
  const place = (id: string): void => {
    if (placed.has(id) || visiting.has(id)) return
    visiting.add(id)
    const blockers = (blockersOf.get(id) ?? [])
      .filter((blocker) => picked.has(blocker))
      .sort(
        (a, b) =>
          (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER)
      )
    for (const blocker of blockers) place(blocker)
    visiting.delete(id)
    placed.add(id)
    ordered.push(id)
  }
  for (const id of byBoard) place(id)
  return ordered
}

// ── The run ────────────────────────────────────────────────────────────────

/** "3 tickets · 2 selected": the line under an orchestrator's title in the preview. */
export function ticketRunMeta(items: readonly Pick<DocumentRunItem, 'selected'>[]): string {
  const selected = items.filter((item) => item.selected).length
  return `${pluralize(items.length, 'ticket')} · ${selected} selected`
}

/**
 * What deleting an orchestrator does: its own ticket goes, the tickets it orchestrated stay on
 * the board as they are (they were the user's before the run), and so do branches and worktrees.
 */
export function describeTicketRunDeletion(launched: boolean): string {
  return launched
    ? "The run's own ticket is removed from the board. The tickets it orchestrated stay on the board, and branches and worktrees are not touched."
    : "The run's own ticket is removed from the board. The tickets it holds stay on the board, free to be launched or orchestrated again."
}

/** "Add 3 tickets", or "Add & resume" for a finished run the tickets would resume. */
export function addTicketsLabel(count: number, resumes: boolean): string {
  if (resumes) return 'Add & resume'
  return count > 0 ? `Add ${pluralize(count, 'ticket')}` : 'Add tickets'
}

// ── The prompt ─────────────────────────────────────────────────────────────

export interface TicketRunPromptParts {
  /** The user's ticket, as the board launches it in build mode. */
  brief: string
  /** What the run adds after it (verification, asking, commit and follow-up rules). */
  rules: string
}

/**
 * The prompt of a ticket in a run made from board tickets, in its two parts: the brief the
 * user wrote and the rules the run adds. Joined by a blank line they are exactly what
 * `buildTicketRunPrompt` sends.
 */
export function ticketRunPromptParts(
  ticket: TicketBriefInput,
  rules: Parameters<typeof runRulesParagraphs>[0]
): TicketRunPromptParts {
  return { brief: buildTicketBrief(ticket), rules: runRulesParagraphs(rules) }
}

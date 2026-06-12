import { ticketKey } from '@/stores/useKanbanStore'
import type { KanbanTicket, MarkdownCardDiagnostic } from '../../../../main/db/types'

export function cardOccurrenceKey(
  ticket: KanbanTicket,
  index: number,
  diagnostics: MarkdownCardDiagnostic[],
  occurrenceCounts: Map<string, number>
): string {
  const logicalKey = ticketKey(ticket.project_id, ticket.id)
  const duplicateDiagnostics = diagnostics.filter(
    (diagnostic) => diagnostic.kind === 'duplicate_id' && diagnostic.ticketId === ticket.id
  )
  if (duplicateDiagnostics.length === 0) return logicalKey

  const occurrenceIndex = occurrenceCounts.get(logicalKey) ?? 0
  occurrenceCounts.set(logicalKey, occurrenceIndex + 1)
  const filePath = duplicateDiagnostics[occurrenceIndex]?.filePath
  return filePath
    ? `${logicalKey}:duplicate:${encodeURIComponent(filePath)}`
    : `${logicalKey}:duplicate:index-${index}`
}

export function cardOccurrenceKeys(
  tickets: KanbanTicket[],
  diagnosticsByProject: Map<string, MarkdownCardDiagnostic[]>,
  occurrenceCounts: Map<string, number> = new Map()
): string[] {
  return tickets.map((ticket, index) =>
    cardOccurrenceKey(
      ticket,
      index,
      diagnosticsByProject.get(ticket.project_id) ?? [],
      occurrenceCounts
    )
  )
}

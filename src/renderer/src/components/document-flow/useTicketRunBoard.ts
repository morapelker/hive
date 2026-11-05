import { useCallback, useEffect, useMemo, useState } from 'react'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { parseTicketKey, useKanbanStore } from '@/stores/useKanbanStore'
import { ticketRunRefusal } from '@shared/document-flow/ticket-runs'
import type { KanbanTicket } from '../../../../main/db/types'
import { isHiddenFromTicketPicker, sortBoardTickets, ticketRunOwners } from './ticket-run-ui'

// What a run made from board tickets reads off the board: the project's tickets and their
// dependencies for the ticket picker, and one ticket for the brief editor and its prompt
// preview. Both read the kanban store: the board is the source of truth for a ticket's text
// and for what it waits for.

const EMPTY_TICKETS: KanbanTicket[] = []

/** The board as a run made from tickets reads it: what can be picked, and what waits for what. */
export interface BoardTicketsForRun {
  /** False until the project's tickets have been read once. */
  loaded: boolean
  /** Every ticket the picker lists (not a run ticket, a shell command or archived), board order. */
  tickets: KanbanTicket[]
  ticketsById: ReadonlyMap<string, KanbanTicket>
  /** Board dependencies: ticket id → the ids of the tickets it waits for. */
  blockersOf: ReadonlyMap<string, readonly string[]>
  /** Why a ticket cannot join the run, or null when it can (see `ticketRunRefusal`). */
  refusalOf: (ticketId: string) => string | null
}

/**
 * The project's board tickets and dependencies for a run made from tickets, read afresh on
 * mount (a ticket launched or edited since the board was last loaded must say so; the board
 * loads its dependencies with its tickets). `runId` is the run the tickets would join (its own
 * tickets are refused as "already part of this run"); the runs of the project are loaded too,
 * so a ticket another run holds says so. `load: false` reads what is there without fetching.
 */
export function useBoardTicketsForRun(
  projectId: string,
  runId: string | null = null,
  { load = true }: { load?: boolean } = {}
): BoardTicketsForRun {
  const allTickets = useKanbanStore(
    useCallback((state) => state.tickets.get(projectId) ?? EMPTY_TICKETS, [projectId])
  )
  const boardLoaded = useKanbanStore(
    useCallback((state) => state.tickets.has(projectId), [projectId])
  )
  const dependencyMap = useKanbanStore((state) => state.dependencyMap)
  const runsById = useDocumentFlowStore((state) => state.runsById)
  const runsLoaded = useDocumentFlowStore((state) => state.loadedProjects[projectId] === true)
  // A board that could not be read shows as empty rather than loading forever.
  const [attemptedFor, setAttemptedFor] = useState<string | null>(null)

  useEffect(() => {
    if (!load) return
    let cancelled = false
    void Promise.resolve(useKanbanStore.getState().loadTickets(projectId)).finally(() => {
      if (!cancelled) setAttemptedFor(projectId)
    })
    return () => {
      cancelled = true
    }
  }, [projectId, load])
  useEffect(() => {
    if (load && !runsLoaded) void useDocumentFlowStore.getState().loadRuns(projectId)
  }, [projectId, runsLoaded, load])
  const loaded = boardLoaded || attemptedFor === projectId

  const tickets = useMemo(
    () => sortBoardTickets(allTickets.filter((ticket) => !isHiddenFromTicketPicker(ticket))),
    [allTickets]
  )
  const ticketsById = useMemo(
    () => new Map(allTickets.map((ticket) => [ticket.id, ticket])),
    [allTickets]
  )
  const blockersOf = useMemo(() => {
    const result = new Map<string, string[]>()
    for (const [dependentKey, blockerKeys] of dependencyMap) {
      const dependent = parseTicketKey(dependentKey)
      if (dependent.projectId !== projectId) continue
      const blockers = [...blockerKeys]
        .map((key) => parseTicketKey(key))
        .filter((ref) => ref.projectId === projectId)
        .map((ref) => ref.ticketId)
      if (blockers.length > 0) result.set(dependent.ticketId, blockers)
    }
    return result
  }, [dependencyMap, projectId])
  const owners = useMemo(() => ticketRunOwners(Object.values(runsById)), [runsById])
  // The tickets of the run they would join, whatever its status: a finished run no longer owns
  // its tickets (`runOwnsItsTickets`), yet one it skipped still sits in To Do and would read as
  // free — the server leaves a ticket the run holds already as it is, so it is "in this run".
  const joinedRun = runId ? runsById[runId] : undefined
  const inJoinedRun = useMemo(
    () => new Set((joinedRun?.items ?? []).flatMap((item) => item.ticket_id ?? [])),
    [joinedRun]
  )
  const refusalOf = useCallback(
    (ticketId: string): string | null => {
      const ticket = ticketsById.get(ticketId)
      if (!ticket) return 'It is no longer on the board.'
      if (inJoinedRun.has(ticketId)) return 'It is already part of this run.'
      return ticketRunRefusal(ticket, owners.get(ticketId) ?? null, runId)
    },
    [inJoinedRun, owners, runId, ticketsById]
  )

  return { loaded, tickets, ticketsById, blockersOf, refusalOf }
}

/** Boards being read for a brief, so several rows asking at once read it once. */
const boardsLoading = new Set<string>()

/**
 * The board ticket an item of a run made from tickets stands for, as the board holds it now
 * (null until the board is loaded, or when the ticket is gone). The board is loaded when it
 * was not yet: the editor writes the ticket through it, and the brief preview reads it.
 */
export function useBoardTicket(projectId: string, ticketId: string | null): KanbanTicket | null {
  const ticket = useKanbanStore(
    useCallback(
      (state): KanbanTicket | null =>
        ticketId
          ? (state.tickets.get(projectId)?.find((candidate) => candidate.id === ticketId) ?? null)
          : null,
      [projectId, ticketId]
    )
  )
  const loaded = useKanbanStore(useCallback((state) => state.tickets.has(projectId), [projectId]))
  useEffect(() => {
    if (loaded || boardsLoading.has(projectId)) return
    boardsLoading.add(projectId)
    void Promise.resolve(useKanbanStore.getState().loadTickets(projectId)).finally(() =>
      boardsLoading.delete(projectId)
    )
  }, [loaded, projectId])
  return ticket
}

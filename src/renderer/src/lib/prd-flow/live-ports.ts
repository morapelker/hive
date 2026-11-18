import { PRD_FLOW_CLI_LEAD } from '@shared/document-flow/prd-flow'
import { dbApi } from '@/api/db-api'
import { documentFlowApi } from '@/api/document-flow-api'
import { worktreeApi } from '@/api/worktree-api'
import { markRunAwaitingPrefs } from '@/components/document-flow/useRunConfigDraft'
import { isSessionClosed, isSessionStarted } from '@/lib/document-flow/runner-ports'
import { getSessionSignal, startSessionSignalLatch } from '@/lib/document-flow/session-signal'
import { sendFollowupToSession } from '@/lib/session-followup'
import { toast } from '@/lib/toast'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { resolveDocumentFlowGeneration, useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useKanbanStore, whenKanbanMutationsSettled } from '@/stores/useKanbanStore'
import { usePrdFlowStore, type PrdFlow } from '@/stores/usePrdFlowStore'
import { useQuestionStore } from '@/stores/useQuestionStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import type { Project, Session } from '../../../../main/db/types'
import { findPrdFlowTicket, movePrdFlowTicket } from './board'
import type { PrdFlowPorts, PrdFlowTicketState } from './ports'
import { discardPrdFlowLaunch, isPrdFlowLaunching } from './start'

// The PRD flow driver's ports (./ports) wired to the real stores and the RPC client: the one
// place of the flow that knows them, as lib/document-flow/runner-ports is for a document run.

/** How long the app's start time is kept before the main process is asked again. */
export const APP_STARTED_AT_TTL_MS = 5_000

/**
 * Reads a flow's ticket off the board, and is to be believed when it says the ticket is gone.
 * A ticket that is not in the store may only be missing from what this page holds: the
 * project's board was never read here, or the list is one an earlier read left behind. So a
 * missing ticket is `loading`, and its project's board is read (one read per project at a
 * time); only a read that began after the ticket was missed, and came back without it, makes
 * it `gone`. A flow is ended over that answer, so it must not come from a stale list. A board
 * that cannot be read says nothing, with one exception: the board of a project that was
 * deleted can never be read again, so when the database says the project is no more, its
 * tickets are gone with it.
 */
function createBoardReader(): (flow: PrdFlow) => PrdFlowTicketState {
  /** Tickets a read of their board, begun after they were missed, did not bring back. */
  const gone = new Set<string>()
  /** The read in flight of each project, with the tickets it is to settle. */
  const reads = new Map<string, { asked: Set<string>; sent: boolean }>()

  const read = (projectId: string, ticketId: string): void => {
    const inFlight = reads.get(projectId)
    if (inFlight) {
      // Not sent yet: its answer is as good for this ticket. Once it is on its way the ticket
      // waits for a read of its own, which the next look starts.
      if (!inFlight.sent) inFlight.asked.add(ticketId)
      return
    }
    const current = { asked: new Set([ticketId]), sent: false }
    reads.set(projectId, current)
    void (async () => {
      try {
        // A list fetched under an optimistic write (the ticket's own creation) predates it.
        await whenKanbanMutationsSettled(projectId)
        current.sent = true
        // `rethrow`: a board that could not be read says nothing about its tickets.
        await useKanbanStore.getState().loadTickets(projectId, { rethrow: true })
        const tickets = useKanbanStore.getState().tickets.get(projectId) ?? []
        for (const id of current.asked) {
          if (!tickets.some((ticket) => ticket.id === id)) gone.add(id)
        }
      } catch (error) {
        if (await isProjectDeleted(projectId)) {
          for (const id of current.asked) gone.add(id)
          return
        }
        // Nothing is known; the driver's next look asks again.
        console.warn('[prdFlow] could not read the board of a flow', error)
      } finally {
        reads.delete(projectId)
      }
    })()
  }

  return (flow) => {
    const ticket = findPrdFlowTicket(flow.projectId, flow.ticketId)
    if (!ticket) {
      if (gone.has(flow.ticketId)) return { state: 'gone' }
      read(flow.projectId, flow.ticketId)
      return { state: 'loading' }
    }
    gone.delete(flow.ticketId)
    return {
      state: 'present',
      column: ticket.column,
      archived: Boolean(ticket.archived_at),
      sessionId: ticket.current_session_id ?? null,
      // Markdown-backed boards have no ticket rows, and so no parent to point at.
      linkable: ticket.ticket_number !== null && ticket.ticket_number !== undefined
    }
  }
}

/**
 * Whether the project is no longer in the database. Asked of the database itself, not of the
 * projects this page lists (which are not loaded yet in a new window): only its own "there is
 * no such project" counts, and a lookup that failed says nothing.
 */
async function isProjectDeleted(projectId: string): Promise<boolean> {
  try {
    return (await dbApi.project.get<Project>(projectId)) === null
  } catch {
    return false
  }
}

/**
 * When this app instance started (epoch ms), as the main process says; 0 while that is not
 * known (the call failed, or answered something that is not a date). Asked at most once per
 * APP_STARTED_AT_TTL_MS, whatever the answer was.
 */
function createAppStartedAtReader(): () => Promise<number> {
  let last: { askedAt: number; answer: Promise<number> } | null = null
  return () => {
    const now = Date.now()
    if (last && now - last.askedAt < APP_STARTED_AT_TTL_MS) return last.answer
    const answer = (async () => {
      try {
        const startedAt = Date.parse(await documentFlowApi.appStartedAt())
        return Number.isFinite(startedAt) ? startedAt : 0
      } catch {
        return 0
      }
    })()
    last = { askedAt: now, answer }
    return answer
  }
}

/**
 * A session on a connection instance is found by the stores alone (lib/session-followup reads
 * its directory off the connection): after a restart neither the instance nor the session's
 * row is necessarily on this page, and the prompt would have nowhere to go.
 */
async function loadConnectionSession(connectionId: string, sessionId: string): Promise<void> {
  if (!useConnectionStore.getState().connections.some((c) => c.id === connectionId)) {
    await useConnectionStore.getState().loadConnections()
  }
  if (useSessionStore.getState().getSessionById(sessionId)) return
  const row = await dbApi.session.get<Session>(sessionId)
  if (row) useSessionStore.getState().hydrateSession(row)
}

export function createLivePrdFlowPorts(): PrdFlowPorts {
  startSessionSignalLatch()

  return {
    now: () => Date.now(),

    flows: () => Object.values(usePrdFlowStore.getState().flows),
    flow: (ticketId) => usePrdFlowStore.getState().flows[ticketId] ?? null,
    patch: (ticketId, patch) => {
      usePrdFlowStore.getState().patchFlow(ticketId, patch)
    },
    remove: (ticketId) => usePrdFlowStore.getState().removeFlow(ticketId),
    isLaunching: isPrdFlowLaunching,

    ticket: createBoardReader(),
    moveTicket: (flow, column) => movePrdFlowTicket(flow.projectId, flow.ticketId, column),
    linkToRun: (flow, runTicketId) =>
      useKanbanStore
        .getState()
        .updateTicket(flow.ticketId, flow.projectId, { parent_ticket_id: runTicketId }),

    signal: getSessionSignal,
    sessionTurn: (sessionId) => documentFlowApi.sessionTurn(sessionId),
    isSessionClosed,
    appStartedAt: createAppStartedAtReader(),
    sendPrompt: async (flow, prompt) => {
      const { sessionId, checkout } = flow
      if (!sessionId) throw new Error('The flow has no session to prompt.')
      if (checkout.kind === 'connection')
        await loadConnectionSession(checkout.connectionId, sessionId)
      try {
        // The session keeps the model it was launched with; the app's build default must not
        // replace it on a prompt the flow sends.
        await sendFollowupToSession({
          sessionId,
          prompt,
          followUpMode: 'build',
          ticketId: flow.ticketId,
          preserveSessionModel: true,
          cliLead: PRD_FLOW_CLI_LEAD
        })
      } catch (error) {
        // The follow-up shows the session as working before it delivers the prompt, and
        // leaves that standing when the delivery fails: the driver would take the session for
        // at work on a prompt it never got.
        useWorktreeStatusStore.getState().clearSessionStatus(sessionId)
        throw error
      }
    },
    forgetSessionStatus: (sessionId) =>
      useWorktreeStatusStore.getState().clearSessionStatus(sessionId),
    isSessionStarted,
    discardLaunch: (flow, sessionId) => discardPrdFlowLaunch(flow, sessionId),

    fileExists: (path) => worktreeApi.exists(path),
    findRun: async (flow, tasksPath) => {
      // Newest first. A run older than the flow was made from an earlier document of that name.
      const runs = await documentFlowApi.list(flow.projectId)
      const found = runs.find(
        ({ run }) => run.source_path === tasksPath && Date.parse(run.created_at) >= flow.createdAt
      )
      return found ? { runId: found.run.id, ticketId: found.run.ticket_id } : null
    },
    createRun: async (flow, tasksPath) => {
      // Not the store's own "create run", which also points an open wizard at the new run.
      const detail = await documentFlowApi.createRun({
        projectId: flow.projectId,
        documentPath: tasksPath,
        generation: resolveDocumentFlowGeneration()
      })
      useDocumentFlowStore.getState().applyDetail(detail)
      // The remembered run settings are applied when the person first opens it, as for a run
      // they made by hand.
      markRunAwaitingPrefs(detail.run.id)
      return { runId: detail.run.id, ticketId: detail.run.ticket_id }
    },

    notify: (level, message) => {
      toast[level](message)
    },
    subscribe: (listener) => {
      const stops = [
        usePrdFlowStore.subscribe((state, previous) => {
          if (state.flows !== previous.flows) listener()
        }),
        useWorktreeStatusStore.subscribe((state, previous) => {
          if (
            state.sessionStatuses !== previous.sessionStatuses ||
            state.sessionApiErrors !== previous.sessionApiErrors ||
            state.backgroundWorkBySession !== previous.backgroundWorkBySession
          ) {
            listener()
          }
        }),
        useQuestionStore.subscribe((state, previous) => {
          if (state.pendingBySession !== previous.pendingBySession) listener()
        }),
        useKanbanStore.subscribe((state, previous) => {
          if (state.tickets !== previous.tickets) listener()
        })
      ]
      return () => {
        for (const stop of stops) stop()
      }
    }
  }
}

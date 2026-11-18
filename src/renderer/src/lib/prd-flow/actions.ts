import { isClaudeCliCompletionDetected } from '@shared/types/claude-cli-stop-completion'
import { isSessionClosed } from '@/lib/document-flow/runner-ports'
import { getSessionSignal, type SessionSignal } from '@/lib/document-flow/session-signal'
import { toast } from '@/lib/toast'
import { usePrdFlowStore, type PrdFlow } from '@/stores/usePrdFlowStore'
import { isTicketLaunching } from '@/stores/useTicketLaunchStore'
import { findPrdFlowTicket, movePrdFlowTicket } from './board'
import { discardPrdFlowLaunch, launchPrdFlowSession } from './start'

// What the person does to a PRD flow from its ticket's card: "Retry PRD flow" when it needs
// attention, "Cancel PRD flow" at any time. Neither prompts the session itself: a retry puts
// the flow back on, and the driver (./driver) prompts on its next look; a cancel only makes
// the app forget the flow.

const describeError = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/**
 * "Retry PRD flow": the flow is on again, with its counts of re-prompts and resumes cleared. A
 * flow whose session never started gets a new launch; any other is prompted again whatever
 * state its session is found in (`forcePrompt`), except when only the orchestrator ticket is
 * still to be made. Its ticket returns to In Progress, where a flow that is on keeps it.
 * Nothing happens for a flow that is gone or does not need attention. Never rejects.
 */
export async function retryPrdFlow(ticketId: string): Promise<void> {
  const store = usePrdFlowStore.getState()
  const flow = store.flows[ticketId]
  if (!flow || flow.status !== 'needs_attention') return

  if (flow.stage === 'launching') return retryLaunch(flow)

  store.patchFlow(ticketId, {
    status: 'running',
    attention: null,
    detail: null,
    reprompts: 0,
    resumes: 0,
    waitingSince: null,
    retryAt: null,
    forcePrompt: flow.stage !== 'creating_run'
  })
  const column = findPrdFlowTicket(flow.projectId, ticketId)?.column
  if (column !== 'review' && column !== 'todo') return
  try {
    await movePrdFlowTicket(flow.projectId, ticketId, 'in_progress')
  } catch (error) {
    // The driver makes the same move before it prompts.
    console.warn('[prdFlow] could not move the ticket of a retried flow to In Progress', error)
  }
}

/**
 * Retry of a flow whose session never started: a new launch. What the failed launch left on
 * the ticket goes first: the session the flow remembers (it could not be taken off the ticket
 * then, and perhaps not be closed) is discarded once more, and the launch replaces it should
 * that fail again. Not over a session somebody gave the ticket meanwhile (they launched it by
 * hand): the launch would put its own session on the ticket in place of theirs, so the flow
 * ends instead, as the driver ends it when it sees the same. A closed session on the ticket
 * is taken for a failed launch's too, for a flow that no longer knows which session that was.
 * And not beside a launch of the ticket that is under way (they started it by hand, and its
 * worktree is still being made): the ticket has no session yet, and would get two.
 */
async function retryLaunch(flow: PrdFlow): Promise<void> {
  const { ticketId } = flow
  /** Cancelled, or retried from elsewhere, while something was waited for. */
  const moved = (): boolean => usePrdFlowStore.getState().flows[ticketId] !== flow
  /** Somebody is launching the ticket at this moment: the retry keeps off, and says so. */
  const startingElsewhere = (): boolean => {
    if (!isTicketLaunching(ticketId)) return false
    toast.info(`PRD flow of “${flow.name}” was not retried: its ticket is already starting.`)
    return true
  }
  // Before anything is taken off the ticket their launch is about to link, and once more
  // below: a launch may begin while the sessions are looked at.
  if (startingElsewhere()) return
  try {
    if (flow.sessionId) {
      await discardPrdFlowLaunch(flow, flow.sessionId)
      if (moved()) return
    }
    const linked = findPrdFlowTicket(flow.projectId, ticketId)?.current_session_id
    if (linked && linked !== flow.sessionId) {
      const closed = await isSessionClosed(linked)
      if (moved()) return
      if (!closed) {
        usePrdFlowStore.getState().removeFlow(ticketId)
        toast.info(`PRD flow of “${flow.name}” stopped: its ticket was given another session.`)
        return
      }
    }
  } catch (error) {
    toast.error(`PRD flow of “${flow.name}” could not be retried: ${describeError(error)}`)
    return
  }
  if (startingElsewhere()) return
  // The card stops asking for attention at once; the launch stamps the rest.
  const retried = usePrdFlowStore
    .getState()
    .patchFlow(ticketId, { status: 'running', attention: null, detail: null })
  if (retried) void launchPrdFlowSession(retried)
}

/**
 * Whether a turn end is only a pause, by the rule the board keeps a ticket In Progress with
 * (useKanbanStore's reconcileFinishedSessions): a Claude CLI stop that was no completion (the
 * agent waits for work it started, or no Stop hook ended the turn) and no API error.
 */
function isPause(end: Extract<SessionSignal, { kind: 'ended' }>): boolean {
  return (
    !end.apiError && end.completion !== undefined && !isClaudeCliCompletionDetected(end.completion)
  )
}

/**
 * "Cancel PRD flow": the app forgets the flow and does nothing more for it. The ticket, its
 * session and whatever the session wrote stay. A ticket whose session had already finished
 * its turn goes to Review, where that end would have put it had the flow not kept it In
 * Progress. A turn that only paused is no such end: the board keeps its ticket In Progress
 * until the session is really done, and so does a cancel. Never rejects.
 */
export async function cancelPrdFlow(ticketId: string): Promise<void> {
  const store = usePrdFlowStore.getState()
  const flow = store.flows[ticketId]
  if (!flow) return
  store.removeFlow(ticketId)
  toast.info(`PRD flow of “${flow.name}” cancelled. Its ticket and session stay as they are.`)

  if (!flow.sessionId) return
  if (findPrdFlowTicket(flow.projectId, ticketId)?.column !== 'in_progress') return
  const signal = getSessionSignal(flow.sessionId)
  if (signal.kind !== 'ended' || isPause(signal)) return
  try {
    await movePrdFlowTicket(flow.projectId, ticketId, 'review')
  } catch (error) {
    console.warn('[prdFlow] could not move the ticket of a cancelled flow to Review', error)
  }
}

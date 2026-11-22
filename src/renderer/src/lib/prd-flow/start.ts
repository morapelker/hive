import { buildPrdPrompt, prdFileName, prdFlowPrefix } from '@shared/document-flow/prd-flow'
import { findCustomProvider } from '@shared/types/custom-provider'
import type { DocumentRunLaunchConfig } from '@shared/types/document-flow'
import { getUnavailableAgentSdkMessage } from '@/lib/agent-sdk-availability'
import { autoPinForBoardPrompt } from '@/lib/auto-pin'
import { discardSession } from '@/lib/document-flow/migrations'
import { resetTicketToTodo, resolveDefaultLaunchConfig } from '@/lib/document-flow/runner-ports'
import { isWindows } from '@/lib/platform'
import {
  launchSessionOnConnection,
  launchSessionWithModel,
  resolveBadgeModel,
  resolveCustomProviderBadge,
  type SessionLaunchCreated,
  type SessionLaunchResult
} from '@/lib/ticket-launch'
import { toast } from '@/lib/toast'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { usePrdFlowStore, type PrdFlow } from '@/stores/usePrdFlowStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import {
  beginTicketLaunch,
  isTicketLaunching,
  settleTicketLaunch
} from '@/stores/useTicketLaunchStore'
import { findPrdFlowTicket } from './board'
import {
  describeExistingPrdFlowFiles,
  findExistingPrdFlowFiles,
  resolvePrdFlowTarget
} from './target'

// Starting a PRD flow ("New PRD → orchestrator ticket…"): the form's answers become a ticket on
// the board, a flow in the store, and one session in the project's root that is asked for
// <PREFIX>_PRD.html. Everything after that first prompt is the driver's (./driver). The launch
// is a step of its own because "Retry PRD flow" runs it again when the session could not be
// started. A flow that was saved for later (./draft) starts here as well: its ticket is on the
// board already, and the flow takes it over instead of making one.

export interface StartPrdFlowInput {
  projectId: string
  name: string
  prompt: string
  research: boolean
  clarify: boolean
  /** The agent and model chosen in the form; null = the app's default launch. */
  launch: DocumentRunLaunchConfig | null
  /**
   * The ticket of a saved draft (./draft) that is being launched: the flow becomes that
   * ticket's, and the draft is forgotten. Absent for a new flow, which gets a new ticket.
   */
  ticketId?: string
}

export type StartPrdFlowResult = { ok: true; ticketId: string } | { ok: false; error: string }

/** Tickets whose flow this page is starting a session for at this moment. */
const launching = new Set<string>()

// What a launch is failed with when its flow was cancelled while the session was being made.
// Never shown: a cancelled flow has no card to say it on.
const CANCELLED = 'The PRD flow was cancelled.'

const describeError = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/**
 * Why a session with this agent cannot be created on this Mac, in the words session creation
 * itself would refuse it with (useSessionStore.createSession); null when it can. A custom
 * provider runs its own command, so whether the stock agent is installed says nothing of it.
 */
function launchRefusal(launch: DocumentRunLaunchConfig): string | null {
  const { customProviders, availableAgentSdks } = useSettingsStore.getState()
  // As the launch resolves it: a provider that was deleted, or has no command, is a plain
  // Claude CLI launch.
  const provider =
    launch.sdk === 'claude-code-cli'
      ? findCustomProvider(customProviders, launch.customProviderId)
      : undefined
  if (provider?.command.trim()) {
    return isWindows() ? 'Custom providers are not supported on Windows yet' : null
  }
  return getUnavailableAgentSdkMessage(launch.sdk, availableAgentSdks)
}

/**
 * Makes the ticket of a saved draft the ticket of the flow that is about to start: it must
 * still wait in To Do with no session and no launch under way, and it takes the name and the
 * prompt the flow starts with. Resolves with why it cannot be taken over, or null when it was.
 */
async function adoptDraftTicket(
  projectId: string,
  ticketId: string,
  name: string,
  prompt: string
): Promise<string | null> {
  const ticket = findPrdFlowTicket(projectId, ticketId)
  if (!ticket) return 'The ticket of this draft is no longer on the board.'
  if (ticket.archived_at) return 'The ticket of this draft was archived.'
  if (usePrdFlowStore.getState().flows[ticketId]) return 'This ticket already has a PRD flow.'
  if (ticket.current_session_id || ticket.column !== 'todo' || isTicketLaunching(ticketId)) {
    return 'The ticket of this draft was already started.'
  }
  if (ticket.title === name && (ticket.description ?? '') === prompt) return null
  try {
    await useKanbanStore
      .getState()
      .updateTicket(ticketId, projectId, { title: name, description: prompt })
    return null
  } catch (error) {
    console.warn('[prdFlow] could not update the ticket of a launched draft', error)
    return 'The ticket could not be updated.'
  }
}

/**
 * Starts a flow from the form's answers: checks them, creates the ticket (in To Do, until its
 * session exists; a saved draft's ticket is taken over instead), records the flow and starts
 * its session without waiting for it. Never rejects: whatever stops the start comes back as `ok: false` with the sentence the form shows.
 */
export async function startPrdFlow(input: StartPrdFlowInput): Promise<StartPrdFlowResult> {
  const name = input.name.trim()
  const prompt = input.prompt.trim()
  if (!name) return { ok: false, error: 'Give the ticket a name.' }
  const prefix = prdFlowPrefix(name)
  if (!prefix) return { ok: false, error: 'The name needs at least one letter or digit.' }
  if (!prompt) return { ok: false, error: 'Say what you want to create.' }

  try {
    const resolved = await resolvePrdFlowTarget(input.projectId)
    if (!resolved.ok) return { ok: false, error: resolved.error }
    const { checkout, cwd, memberDirs } = resolved.target

    // Two flows asking for the same file in the same directory would each take the other's
    // document for its own; a flow that is still on has not necessarily written it yet.
    const clash = Object.values(usePrdFlowStore.getState().flows).find(
      (flow) => flow.cwd === cwd && flow.prefix === prefix
    )
    if (clash) {
      return {
        ok: false,
        error: `The PRD flow of “${clash.name}” is already writing ${prdFileName(prefix)} in ${cwd}. Pick another name, or cancel that flow.`
      }
    }
    const existing = await findExistingPrdFlowFiles({ cwd, memberDirs }, prefix)
    if (existing.length > 0) return { ok: false, error: describeExistingPrdFlowFiles(existing) }

    const launch = input.launch ?? resolveDefaultLaunchConfig()
    // A launch that is certain to be refused leaves a ticket and a flow that Retry cannot
    // help: the form says so instead, and the person picks another agent.
    const refusal = launchRefusal(launch)
    if (refusal) return { ok: false, error: refusal }
    let ticketId: string
    if (input.ticketId) {
      const problem = await adoptDraftTicket(input.projectId, input.ticketId, name, prompt)
      if (problem) return { ok: false, error: problem }
      ticketId = input.ticketId
    } else {
      try {
        const ticket = await useKanbanStore.getState().createTicket(input.projectId, {
          project_id: input.projectId,
          title: name,
          description: prompt,
          column: 'todo'
        })
        ticketId = ticket.id
      } catch (error) {
        console.warn('[prdFlow] could not create the ticket of a flow', error)
        return { ok: false, error: 'The ticket could not be created.' }
      }
    }

    const now = Date.now()
    const flow: PrdFlow = {
      ticketId,
      projectId: input.projectId,
      name,
      prefix,
      prompt,
      research: input.research,
      clarify: input.clarify,
      launch,
      checkout,
      cwd,
      memberDirs,
      sessionId: null,
      stage: 'launching',
      status: 'running',
      attention: null,
      detail: null,
      promptedAt: now,
      reprompts: 0,
      resumes: 0,
      waitingSince: null,
      retryAt: null,
      forcePrompt: false,
      prdPath: null,
      tasksPath: null,
      runId: null,
      createdAt: now
    }
    // Marked before the flow is in the store: the driver never finds it with nobody starting it.
    launching.add(ticketId)
    const store = usePrdFlowStore.getState()
    store.putFlow(flow)
    // A launched draft is a flow from here on (nothing happens for a ticket that had none).
    store.removeDraft(ticketId)
    // The next form opens on the same agent and model (null: the app's default).
    store.setLaunchPref(input.launch)
    void runLaunch(flow)
    return { ok: true, ticketId }
  } catch (error) {
    console.warn('[prdFlow] could not start a flow', error)
    return { ok: false, error: `The PRD flow could not be started: ${describeError(error)}` }
  }
}

/** This page is starting the session of that ticket's flow: the driver keeps off it meanwhile. */
export function isPrdFlowLaunching(ticketId: string): boolean {
  return launching.has(ticketId)
}

/**
 * Starts the flow's session with the PRD prompt, in the checkout pinned on the flow, and links
 * it to the flow's ticket before the agent is started. Never rejects: a session that could not
 * be started leaves the flow needing attention ("Retry PRD flow" comes back here), with its
 * ticket back in To Do. Does nothing while a launch of the same flow is still running.
 */
export async function launchPrdFlowSession(flow: PrdFlow): Promise<void> {
  if (launching.has(flow.ticketId)) return
  launching.add(flow.ticketId)
  await runLaunch(flow)
}

/** The launch itself; the ticket is already marked as launching, and is unmarked when it is over. */
async function runLaunch(flow: PrdFlow): Promise<void> {
  const { ticketId } = flow
  // The card says "Starting session…" until the ticket is linked to its session.
  const hold = beginTicketLaunch(ticketId, 'session')
  try {
    const result = await startSession(flow)
    if (!result) return
    if (result.success && result.sessionId) {
      // Nothing more when the flow was cancelled while the prompt was on its way.
      usePrdFlowStore.getState().patchFlow(ticketId, { sessionId: result.sessionId, stage: 'prd' })
      return
    }
    await undoFailedLaunch(flow, result.sessionId ?? null)
    reportFailedLaunch(
      flow,
      result.error ?? 'The session could not be started.',
      leftoverSession(flow, result.sessionId)
    )
  } catch (error) {
    console.warn('[prdFlow] the launch of a flow failed', error)
    // The session this launch made, if it got that far, is the one the flow was given.
    const made = usePrdFlowStore.getState().flows[ticketId]?.sessionId
    reportFailedLaunch(flow, describeError(error), leftoverSession(flow, made))
  } finally {
    hold.release()
    launching.delete(ticketId)
  }
}

/** Resolves with the launch's outcome, or null when the flow was cancelled before anything was started. */
async function startSession(flow: PrdFlow): Promise<SessionLaunchResult | null> {
  const { ticketId, projectId, checkout } = flow
  // Stamped before anything is sent: a turn end older than this says nothing about the prompt.
  const stamped = usePrdFlowStore.getState().patchFlow(ticketId, {
    promptedAt: Date.now(),
    status: 'running',
    attention: null,
    detail: null,
    stage: 'launching',
    sessionId: null
  })
  if (!stamped) return null

  const prompt = buildPrdPrompt({
    prompt: flow.prompt,
    prefix: flow.prefix,
    research: flow.research,
    clarify: flow.clarify,
    sdk: flow.launch.sdk
  })

  const onSessionCreated = async (created: SessionLaunchCreated): Promise<void> => {
    const { session, customProviderId, model } = created
    // Cancelled while the session was being made: the launch fails here, before the agent is
    // started, and the session is closed again (undoFailedLaunch).
    if (!usePrdFlowStore.getState().patchFlow(ticketId, { sessionId: session.id })) {
      throw new Error(CANCELLED)
    }
    try {
      await useSessionStore.getState().updateSessionName(session.id, `PRD — ${flow.name}`)
    } catch {
      // Best effort: a session that kept its "Session n" name runs all the same.
    }
    // The ticket is linked and In Progress before the agent is started, as a launched ticket
    // is: what the session does from its first moment is the ticket's.
    const badge =
      resolveCustomProviderBadge(customProviderId, model) ?? resolveBadgeModel(flow.launch, session)
    const kanban = useKanbanStore.getState()
    await kanban.updateTicket(ticketId, projectId, {
      current_session_id: session.id,
      // A connection project's session runs on its base instance: no worktree to name.
      worktree_id: checkout.kind === 'worktree' ? checkout.worktreeId : null,
      mode: 'build',
      column: 'in_progress',
      sort_order: kanban.computeSortOrder(kanban.getTicketsByColumn(projectId, 'in_progress'), 0),
      plan_ready: false,
      pending_launch_config: null,
      model_provider_id: badge.providerID,
      model_id: badge.modelID,
      model_variant: badge.variant
    })
    // The ticket has its session: the card shows that from here. The flow stays at its
    // launch until the agent is started (runLaunch): a launch cut off before that left a
    // session that can never be prompted, which the driver must not take for one at work.
    settleTicketLaunch(ticketId)
  }

  if (checkout.kind === 'connection') {
    void autoPinForBoardPrompt({ projectId, connectionId: checkout.connectionId })
    return launchSessionOnConnection({
      connectionId: checkout.connectionId,
      connectionPath: flow.cwd,
      prompt,
      mode: 'build',
      modelConfig: flow.launch,
      goalMode: false,
      goalSuccessCriteria: null,
      onSessionCreated
    })
  }
  void autoPinForBoardPrompt({ projectId, worktreeId: checkout.worktreeId })
  return launchSessionWithModel({
    projectId,
    worktreeId: checkout.worktreeId,
    prompt,
    mode: 'build',
    modelConfig: flow.launch,
    goalMode: false,
    goalSuccessCriteria: null,
    // The session is linked to the flow's own ticket above: a ticket that merely waits on the
    // main checkout must not be handed it.
    skipKanbanAttach: true,
    onSessionCreated
  })
}

/**
 * Takes back what a failed launch left behind: the session it created is closed for good (it
 * would otherwise linger as a tab whose queued prompt runs, unwatched, the moment someone
 * opens it), and a ticket that was linked to it returns to To Do with nothing of the launch
 * on it. A ticket the launch never reached is left as it is.
 */
async function undoFailedLaunch(flow: PrdFlow, sessionId: string | null): Promise<void> {
  if (sessionId) await discardPrdFlowLaunch(flow, sessionId)
}

/**
 * Closes a session a launch of the flow made and could not start, and returns the flow's
 * ticket to To Do when it still points at that session. A failed launch does this for itself;
 * the driver (./driver) does it for a launch that was cut off before it could, and "Retry PRD
 * flow" (./actions) once more for what an earlier attempt could not clear away. Never rejects
 * over the ticket: one that could not be put back keeps its link to the session, and the
 * answer says so. Resolves true when the ticket points at that session all the same
 * afterwards. Closing is best effort too, so that session is not necessarily closed.
 */
export async function discardPrdFlowLaunch(
  flow: Pick<PrdFlow, 'projectId' | 'ticketId'>,
  sessionId: string
): Promise<boolean> {
  const pointsAtIt = (): boolean =>
    findPrdFlowTicket(flow.projectId, flow.ticketId)?.current_session_id === sessionId
  await discardSession(sessionId)
  if (!pointsAtIt()) return false
  await resetTicketToTodo(flow.projectId, flow.ticketId).catch(() => undefined)
  return pointsAtIt()
}

/**
 * The session of the flow's own launches that its ticket points at after a launch failed;
 * null when it points at none of them. `made` is the session the failed launch made;
 * the flow as the launch got it names the one an earlier failed launch left (a Retry starts
 * from such a flow), which is still on the ticket when this launch never came to replace it.
 */
function leftoverSession(flow: PrdFlow, made: string | null | undefined): string | null {
  const linked = findPrdFlowTicket(flow.projectId, flow.ticketId)?.current_session_id
  return linked && (linked === made || linked === flow.sessionId) ? linked : null
}

/**
 * The flow needs attention, and the person is told why. Says nothing of a flow that was
 * cancelled. `leftover` is the session of the flow's own that could not be taken off its
 * ticket: the flow remembers it, so that nothing takes it for a session somebody else gave
 * the ticket (the driver ends a flow over that), and Retry clears it away.
 */
function reportFailedLaunch(flow: PrdFlow, error: string, leftover: string | null): void {
  const failed = usePrdFlowStore.getState().patchFlow(flow.ticketId, {
    sessionId: leftover,
    stage: 'launching',
    status: 'needs_attention',
    attention: 'launch_failed',
    detail: `The session could not be started: ${error}`
  })
  if (failed) toast.error(`PRD flow of “${flow.name}”: the session could not be started: ${error}`)
}

export function resetPrdFlowLaunchesForTests(): void {
  launching.clear()
}

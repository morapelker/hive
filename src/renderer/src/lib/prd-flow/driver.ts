import {
  buildPrdFlowRepromptPrompt,
  buildPrdPrompt,
  buildTasksPrompt,
  tasksFileName,
  type PrdFlowDocument
} from '@shared/document-flow/prd-flow'
import type { SessionFinalMessage } from '@shared/types/document-flow'
import type { SessionSignal } from '@/lib/document-flow/session-signal'
import type { PrdFlow, PrdFlowAttention, PrdFlowPatch } from '@/stores/usePrdFlowStore'
import type { KanbanTicketColumn } from '../../../../main/db/types'
import {
  observeRecord,
  observeSignal,
  recordShowsDelivery,
  type PrdFlowObservation
} from './observe'
import { prdFlowDocumentCandidates, prdFlowDocumentPath, prdFlowFileName } from './paths'
import {
  PRD_FLOW_API_ERROR_BACKOFF_MS,
  PRD_FLOW_MAX_REPROMPTS,
  PRD_FLOW_MAX_RESUMES,
  PRD_FLOW_TICK_DEBOUNCE_MS,
  PRD_FLOW_TICK_INTERVAL_MS,
  PRD_FLOW_TURN_POLL_MS,
  PRD_FLOW_UNCONFIRMED_WORK_MS,
  PRD_FLOW_UNDELIVERED_GRACE_MS,
  PRD_FLOW_WAIT_FOR_WORK_MS,
  type PrdFlowPorts,
  type PrdFlowRun
} from './ports'

// The driver of "New PRD → orchestrator ticket…": it takes every flow in the store from the
// session's first prompt to the orchestrator ticket. Level-triggered, like the document run's
// runner: each tick looks at where a flow stands and at what its session is doing, and does
// the one thing that is due — wait, ask for the document again, send the tasks prompt, make
// the orchestrator of the tasks document, or stop and say that the flow needs the person. It
// reads nothing but its ports (./ports), so the whole state machine runs against an in-memory
// world in the tests (./driver-fakes).
//
// Two rules keep a flow from prompting its session twice for the same thing. The stamp of a
// prompt (`promptedAt`) is written before the prompt is sent, so whatever the session did
// earlier is older than the stamp and says nothing about it. And a flow has one step in flight:
// a tick that finds one under way leaves the flow to it.
//
// One rule stands over both: no prompt goes into a session that is at work, that the person
// has just put to work, or that shows them a dialog. What the page shows of a session and what
// the main process recorded of it can each be wrong for a while (a "working" status is written
// by whoever sends a prompt, before it is delivered; a record stays as it was when a process
// dies without a word), so a flow that cannot tell waits, or says that it waits for the
// person. Three questions settle most of it: is the "working" the page shows older than the
// wait a prompt is given to show as work, and has the main process recorded anything since
// (`judgeWork`); is the session's process there at all (`isSessionStarted`); and is the page's
// status still the one that was judged once the answers are in (`unchanged`).

/** How long a flow whose step threw is left alone. */
const STEP_FAILURE_REST_MS = 5_000

const WAITING_FOR_YOU_PREFIX = 'Waiting for you: '
const WAITING_FOR_WORK_DETAIL = 'Waiting for work the session left running.'
const API_ERROR_WAIT_DETAIL = 'The session ended on an API error. It is asked to continue shortly.'
const USER_STOPPED_DETAIL = 'You stopped the session. Retry continues the flow.'
const NOT_STARTED_DETAIL = 'The session was not started.'
const SESSION_HELD_DETAIL = `${WAITING_FOR_YOU_PREFIX}the session has not started. Open it and answer what it asks.`

/** What a flow that needs attention can come back from by itself, once its document is there. */
const SELF_HEALING: ReadonlySet<PrdFlowAttention> = new Set([
  'missing_file',
  'api_error',
  'interrupted'
])
/** The session is at rest: nothing it does can still write the document. */
const AT_REST: ReadonlySet<PrdFlowObservation['kind']> = new Set([
  'ended',
  'died',
  'idle',
  'api_error',
  'closed'
])

const describeError = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/**
 * Whether the page shows of a session what it showed before: the same kind of status, and for
 * work or a turn end the same one (a status written anew has a time of its own).
 */
function isSameStatus(before: SessionSignal, now: SessionSignal): boolean {
  if (before.kind === 'working') return now.kind === 'working' && now.since === before.since
  if (before.kind === 'ended') return now.kind === 'ended' && now.at === before.at
  return now.kind === before.kind
}

export class PrdFlowDriver {
  /** Flows with a step in flight, by ticket id: a tick never starts a second one. */
  private readonly inFlight = new Set<string>()
  /** Flows a tick passed over because their step was in flight: looked at again when it ends. */
  private readonly passedOver = new Set<string>()
  /** Flows whose step threw, and until when they are left alone. */
  private readonly resting = new Map<string, number>()
  /** The main process's last answer about each session's turn, and when it was asked. */
  private readonly turnPolls = new Map<string, { at: number; turn: SessionFinalMessage | null }>()
  /**
   * When the main process last recorded something of each session, as far as a judgement of
   * its "working" status found out. A prompt stamped before that, or a status written before
   * that, has a record behind it and is not asked about again; a later one is. Kept by the
   * record's time, not by the prompt that was asked about, so that it holds for exactly as
   * long as the record itself would say the same.
   */
  private readonly recordSeenAt = new Map<string, number>()
  /**
   * Sessions a look left alone because their process is there (or could not be asked about),
   * and until when the main process is not asked about them again. Nothing is sent to such a
   * session, so an answer a few seconds old will do, however often ticks run.
   */
  private readonly leftAloneUntil = new Map<string, number>()
  private started = false
  private unsubscribe: (() => void) | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private intervalTimer: ReturnType<typeof setInterval> | null = null
  private wakeTimer: ReturnType<typeof setTimeout> | null = null
  private wakeTime = 0

  constructor(private readonly ports: PrdFlowPorts) {}

  start(): void {
    if (this.started) return
    this.started = true
    this.unsubscribe = this.ports.subscribe(() => this.requestTick())
    this.intervalTimer = setInterval(() => this.requestTick(), PRD_FLOW_TICK_INTERVAL_MS)
    this.requestTick()
  }

  /** Stops for good: a step in flight writes and sends nothing more once it gets here. */
  stop(): void {
    this.started = false
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer)
    if (this.intervalTimer !== null) clearInterval(this.intervalTimer)
    if (this.wakeTimer !== null) clearTimeout(this.wakeTimer)
    this.debounceTimer = null
    this.intervalTimer = null
    this.wakeTimer = null
  }

  /** Ask for a tick soon. Requests made while one is already scheduled fold into it. */
  requestTick(): void {
    if (!this.started || this.debounceTimer !== null) return
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      this.tick()
    }, PRD_FLOW_TICK_DEBOUNCE_MS)
  }

  // ── Scheduling ───────────────────────────────────────────────────────────

  /** Tick again at `time` (a settle delay, a wait or a backoff coming due) instead of on the interval. */
  private wakeAt(time: number): void {
    if (!this.started) return
    if (this.wakeTimer !== null) {
      if (this.wakeTime <= time) return
      clearTimeout(this.wakeTimer)
    }
    this.wakeTime = time
    this.wakeTimer = setTimeout(
      () => {
        this.wakeTimer = null
        this.requestTick()
      },
      Math.max(0, time - this.ports.now())
    )
  }

  private tick(): void {
    if (!this.started) return
    try {
      const flows = this.ports.flows()
      const now = this.ports.now()
      this.forget(flows)
      for (const flow of flows) {
        if (this.inFlight.has(flow.ticketId)) {
          this.passedOver.add(flow.ticketId)
          continue
        }
        const restsUntil = this.resting.get(flow.ticketId)
        if (restsUntil !== undefined && now < restsUntil) {
          this.wakeAt(restsUntil)
          continue
        }
        this.resting.delete(flow.ticketId)
        void this.run(flow)
      }
    } catch (error) {
      // Left for the next tick: nothing was started.
      console.warn('[prdFlow] tick failed', error)
    }
  }

  /** What was kept about flows and sessions that are no longer there. */
  private forget(flows: readonly PrdFlow[]): void {
    const ticketIds = new Set(flows.map((flow) => flow.ticketId))
    for (const ticketId of this.resting.keys()) {
      if (!ticketIds.has(ticketId)) this.resting.delete(ticketId)
    }
    const sessionIds = new Set(flows.map((flow) => flow.sessionId))
    for (const sessionId of this.turnPolls.keys()) {
      if (!sessionIds.has(sessionId)) this.turnPolls.delete(sessionId)
    }
    for (const sessionId of this.recordSeenAt.keys()) {
      if (!sessionIds.has(sessionId)) this.recordSeenAt.delete(sessionId)
    }
    for (const sessionId of this.leftAloneUntil.keys()) {
      if (!sessionIds.has(sessionId)) this.leftAloneUntil.delete(sessionId)
    }
  }

  /** One step of one flow. Never rejects: a step that throws rests the flow for a while. */
  private async run(flow: PrdFlow): Promise<void> {
    const { ticketId } = flow
    this.inFlight.add(ticketId)
    try {
      await this.step(flow)
    } catch (error) {
      console.warn(`[prdFlow] a step of the flow of “${flow.name}” failed`, error)
      const until = this.ports.now() + STEP_FAILURE_REST_MS
      this.resting.set(ticketId, until)
      this.wakeAt(until)
    } finally {
      this.inFlight.delete(ticketId)
      if (this.passedOver.delete(ticketId)) this.requestTick()
    }
  }

  // ── A step's hold on its flow ────────────────────────────────────────────

  /**
   * The flow as it is now, when it is still the one the step read. Null when the step has
   * nothing more to do with it: the flow is gone (cancelled, or over), its stage, status,
   * session or prompt stamp changed under the step (the person pressed Retry, the launch
   * finished), or the driver was stopped. Asked after every await of a step.
   */
  private current(flow: PrdFlow): PrdFlow | null {
    if (!this.started) return null
    const now = this.ports.flow(flow.ticketId)
    if (!now) return null
    const same =
      now.stage === flow.stage &&
      now.status === flow.status &&
      now.sessionId === flow.sessionId &&
      now.promptedAt === flow.promptedAt
    return same ? now : null
  }

  /**
   * Whether the step may still act on what it saw of the session: the flow is the one it read,
   * and the page shows of the session what it showed (`shown`) when the step looked. Asked
   * after every await that stands between a look at the session and a prompt into it: the
   * person may have sent it a message meanwhile, or the session may have come to life, and
   * the next look judges that.
   */
  private unchanged(flow: PrdFlow, sessionId: string, shown: SessionSignal): boolean {
    return this.current(flow) !== null && isSameStatus(shown, this.ports.signal(sessionId))
  }

  /** Writes the flow and answers it as written, which the step goes on from; null when it is gone. */
  private write(flow: PrdFlow, patch: PrdFlowPatch): PrdFlow | null {
    this.ports.patch(flow.ticketId, patch)
    return this.ports.flow(flow.ticketId)
  }

  /** The column the flow's ticket sits in; null when the board cannot say. */
  private column(flow: PrdFlow): KanbanTicketColumn | null {
    const ticket = this.ports.ticket(flow)
    return ticket.state === 'present' ? ticket.column : null
  }

  /** Where the ticket sits is the board's to show: a move that fails holds nothing up. */
  private async move(flow: PrdFlow, column: 'in_progress' | 'review'): Promise<void> {
    try {
      await this.ports.moveTicket(flow, column)
    } catch (error) {
      console.warn(`[prdFlow] could not move the ticket of “${flow.name}” to ${column}`, error)
    }
  }

  // ── One step of one flow ─────────────────────────────────────────────────

  private async step(flow: PrdFlow): Promise<void> {
    // The page that starts the session writes the flow itself until the launch is over.
    if (this.ports.isLaunching(flow.ticketId)) return

    const ticket = this.ports.ticket(flow)
    if (ticket.state === 'loading') return
    if (ticket.state === 'gone') return this.drop(flow, 'was removed')
    if (ticket.archived) return this.drop(flow, 'was archived')
    if (ticket.column === 'done' || ticket.column === 'merged') {
      return this.drop(flow, 'was moved to Done')
    }
    // The flow's prompts belong in the session it started, and nowhere else.
    if (flow.stage !== 'launching' && flow.sessionId && ticket.sessionId !== flow.sessionId) {
      return this.drop(
        flow,
        ticket.sessionId ? 'was given another session' : 'was taken off its session'
      )
    }

    if (flow.stage === 'launching') return this.pickUpLaunch(flow, ticket.sessionId)

    if (flow.stage === 'creating_run') {
      if (flow.status === 'running') await this.createRun(flow)
      return
    }

    const sessionId = flow.sessionId
    if (!sessionId) {
      // A document stage with no session to watch: back to the start, where the ticket's
      // session is adopted, or the person is told there is none.
      this.ports.patch(flow.ticketId, { stage: 'launching' })
      return
    }
    if (flow.status === 'running') return this.watch(flow, sessionId, flow.stage)
    return this.watchForReturn(flow, sessionId, flow.stage)
  }

  /**
   * A flow at its launch that nobody on this page is launching. Either the launch failed and
   * waits for Retry, or it was cut off (the window was reloaded, the app quit) somewhere
   * between making the session and starting its agent. `linked` is the session the ticket
   * points at.
   */
  private async pickUpLaunch(flow: PrdFlow, linked: string | null): Promise<void> {
    if (flow.status === 'needs_attention') {
      // Retry starts a session of its own, and would put it on the ticket over one somebody
      // gave the ticket meanwhile (they launched it by hand): the ticket is theirs then. The
      // session the flow remembers is no such thing: it is its own failed launch's, which
      // could not be taken off the ticket (and perhaps not be closed either), and Retry clears
      // it away. Nor is a closed session, for a flow that no longer knows which session its
      // launch left: nobody launches a ticket into a closed session.
      if (!linked || linked === flow.sessionId) return
      const closed = await this.ports.isSessionClosed(linked)
      if (!this.current(flow) || this.linkedSession(flow) !== linked) return
      if (!closed) this.drop(flow, 'was given another session')
      return
    }
    // The launch got nowhere near the ticket.
    if (!linked) return this.launchFailed(flow, null)

    // The ticket is linked before the agent is started: a session whose agent was never
    // started can never be prompted, and is no session to wait for.
    let started: boolean
    try {
      started = await this.ports.isSessionStarted(linked)
    } catch (error) {
      // Not known: nothing is decided on it, and the next look asks again.
      console.warn(`[prdFlow] could not tell whether the session of “${flow.name}” started`, error)
      return
    }
    if (!this.current(flow) || this.linkedSession(flow) !== linked) return
    if (started) {
      // The prompt went with the launch: its stamp stays as the launch wrote it.
      this.ports.patch(flow.ticketId, { sessionId: linked, stage: 'prd' })
      return
    }
    const stillLinked = await this.ports.discardLaunch(flow, linked)
    if (!this.current(flow)) return
    return this.launchFailed(flow, stillLinked ? linked : null)
  }

  /** The session the flow's ticket points at now; null when it has none, or is not on the board. */
  private linkedSession(flow: PrdFlow): string | null {
    const ticket = this.ports.ticket(flow)
    return ticket.state === 'present' ? ticket.sessionId : null
  }

  /**
   * The flow has no session to prompt: it waits for Retry, which launches one afresh.
   * `leftover` is the session of the launch that the ticket could not be taken off. The flow
   * remembers it, so that it is not taken for a session somebody else gave the ticket.
   */
  private launchFailed(flow: PrdFlow, leftover: string | null): Promise<void> {
    return this.attention(flow, 'launch_failed', NOT_STARTED_DETAIL, { sessionId: leftover })
  }

  /** The flow has no ticket to work for any more: it is forgotten, and the person is told why. */
  private drop(flow: PrdFlow, what: string): void {
    this.ports.remove(flow.ticketId)
    this.ports.notify('info', `PRD flow of “${flow.name}” stopped: its ticket ${what}.`)
  }

  // ── Watching the session ─────────────────────────────────────────────────

  /**
   * Ask the main process about a session at most once per poll interval, however often ticks
   * run. `fresh`: ask it now whatever was answered a moment ago, for a decision to prompt
   * that an answer a few seconds old must not be trusted with.
   */
  private async recordedTurn(
    sessionId: string,
    fresh = false
  ): Promise<SessionFinalMessage | null> {
    const now = this.ports.now()
    const last = this.turnPolls.get(sessionId)
    if (!fresh && last && now - last.at < PRD_FLOW_TURN_POLL_MS) return last.turn
    const turn = await this.ports.sessionTurn(sessionId)
    this.turnPolls.set(sessionId, { at: now, turn })
    return turn
  }

  /**
   * Whether the session's agent is there (`isSessionStarted`); null when that could not be
   * found out. A session that is there, or cannot be asked about, is left alone for a poll
   * interval: `isLeftAlone` says so to the looks that would ask again.
   */
  private async sessionIsThere(flow: PrdFlow, sessionId: string): Promise<boolean | null> {
    let started: boolean | null
    try {
      started = await this.ports.isSessionStarted(sessionId)
    } catch (error) {
      // Not known: nothing is decided on it, and a later look asks again.
      console.warn(`[prdFlow] could not tell whether the session of “${flow.name}” is there`, error)
      started = null
    }
    if (started !== false) {
      this.leftAloneUntil.set(sessionId, this.ports.now() + PRD_FLOW_TURN_POLL_MS)
    }
    return started
  }

  /** The session was found to be there (or could not be asked about) a moment ago. */
  private isLeftAlone(sessionId: string): boolean {
    return this.ports.now() < (this.leftAloneUntil.get(sessionId) ?? 0)
  }

  /**
   * What this page's own status of the session says it did since the flow's last prompt; null
   * when it says nothing (the page was reloaded, or nothing happened yet).
   */
  private observeLive(flow: PrdFlow, sessionId: string): PrdFlowObservation | null {
    return observeSignal(this.ports.signal(sessionId), flow.promptedAt ?? 0, this.ports.now())
  }

  /**
   * What the session did since the flow's last prompt, for a page whose own status of it says
   * nothing: the main process's record is asked, then whether the session was closed, and
   * whether the prompt is from before this app instance started, which no agent survived.
   */
  private async observeRecorded(flow: PrdFlow, sessionId: string): Promise<PrdFlowObservation> {
    const promptedAt = flow.promptedAt ?? 0
    const turn = await this.recordedTurn(sessionId)
    const appStartedAt = await this.ports.appStartedAt()
    const recorded = observeRecord(turn, promptedAt, appStartedAt, this.ports.now())
    // A recorded turn end stands, whatever became of the session since.
    if (recorded && recorded.kind !== 'working' && recorded.kind !== 'blocked') return recorded

    // Closing a session kills its process without a word: the work or the question the main
    // process recorded before that is no longer true.
    if (await this.ports.isSessionClosed(sessionId)) return { kind: 'closed' }
    if (recorded) return recorded
    if (appStartedAt > 0 && promptedAt < appStartedAt) {
      // The app may have quit between the stamp and the delivery: only what the main process
      // recorded of the session after the stamp says that the prompt arrived.
      return { kind: 'died', delivered: recordShowsDelivery(turn, promptedAt) }
    }
    return { kind: 'idle' }
  }

  /**
   * What stands behind the "working" this page shows of the session. Whoever sends a prompt
   * writes that status, before the prompt is delivered (the flow's own send, and the person's
   * when they type into the session), and nothing takes it back when the session never gets to
   * the prompt (a revived process that exits before its first word, a prompt the session
   * swallowed). So once the status has stood for a while the main process is asked, and its
   * record decides. The while runs from the later of the flow's stamp and the status's own
   * time: a session the person has just put to work, long after the flow's last prompt, is
   * given as long as a prompt of the flow is.
   *
   * Something recorded after the stamp, or after the status was written: the session got to
   * work, and is not asked about again for as long as that says so (`recordSeenAt`). Nothing
   * recorded at all, or a turn end from before both with nothing since (work would have been
   * recorded over it): the session never worked on what it was sent, and the status is a
   * `phantom`. A working or blocked state from before both cannot say by itself: a session
   * that was at work already records nothing new, and neither does a process that died in the
   * middle of its turn and whose revival died before its first word. Whether the session has a
   * process at all tells those two apart: with none the status is a phantom; with one the flow
   * keeps waiting, and asks again on a later look, as it does while that cannot be found out.
   * `moved_on`: the flow or the status changed while the questions were out, and the next look
   * judges what is there now.
   */
  private async judgeWork(
    flow: PrdFlow,
    sessionId: string
  ): Promise<'at_work' | 'phantom' | 'moved_on'> {
    const { promptedAt } = flow
    if (promptedAt === null) return 'at_work'
    const shown = this.ports.signal(sessionId)
    const since = shown.kind === 'working' ? (shown.since ?? promptedAt) : promptedAt
    const seenAt = this.recordSeenAt.get(sessionId)
    if (seenAt !== undefined && (seenAt > promptedAt || seenAt > since)) return 'at_work'
    const due = Math.max(promptedAt, since) + PRD_FLOW_UNCONFIRMED_WORK_MS
    if (this.ports.now() < due) {
      this.wakeAt(due)
      return 'at_work'
    }
    const turn = await this.recordedTurn(sessionId)
    if (!this.unchanged(flow, sessionId, shown)) return 'moved_on'
    if (!turn) return 'phantom'
    const at = Date.parse(turn.updated_at)
    if (!Number.isFinite(at)) return 'at_work'
    if (at > promptedAt || at > since) {
      this.recordSeenAt.set(sessionId, at)
      return 'at_work'
    }
    if (turn.state === 'ended') return 'phantom'

    if (this.isLeftAlone(sessionId)) return 'at_work'
    const there = await this.sessionIsThere(flow, sessionId)
    if (!this.unchanged(flow, sessionId, shown)) return 'moved_on'
    return there === false ? 'phantom' : 'at_work'
  }

  /** The first place the stage's document is found at; null when it is nowhere. */
  private async find(flow: PrdFlow, document: PrdFlowDocument): Promise<string | null> {
    for (const path of prdFlowDocumentCandidates(flow, document)) {
      if (await this.ports.fileExists(path)) return path
    }
    return null
  }

  /** A flow that is on: what its session did decides what is due. */
  private async watch(flow: PrdFlow, sessionId: string, document: PrdFlowDocument): Promise<void> {
    const shown = this.ports.signal(sessionId)
    const live = this.observeLive(flow, sessionId)
    const seen = live ?? (await this.observeRecorded(flow, sessionId))
    if (!this.current(flow)) return

    switch (seen.kind) {
      // A session that is at work, or waits for the person, is not prompted: a Retry that
      // finds it so has nothing left to force, and a stop of theirs later on stands.
      case 'working': {
        // Only this page's status can be a send's own (the flow's, or the person's); what the
        // main process recorded is the session's.
        const work = live ? await this.judgeWork(flow, sessionId) : 'at_work'
        if (work === 'moved_on') return
        if (work === 'phantom') return this.resendUndelivered(flow, sessionId, document)
        this.ports.patch(flow.ticketId, {
          detail: null,
          waitingSince: null,
          retryAt: null,
          forcePrompt: false
        })
        return
      }
      case 'blocked':
        this.ports.patch(flow.ticketId, {
          detail: `${WAITING_FOR_YOU_PREFIX}${seen.detail}`,
          forcePrompt: false
        })
        return
      case 'settling':
        this.wakeAt(seen.until)
        return
      case 'paused':
        // The agent wakes itself when its work is done, and may still be writing: the document
        // is not looked for until the pause has lasted too long.
        if (this.waitForWork(flow)) return
        return this.advanceOr(flow, document, () => this.reprompt(flow, document))
      case 'ended':
        return this.advanceOr(flow, document, async () => {
          if (seen.hasBackgroundWork && this.waitForWork(flow)) return
          await this.reprompt(flow, document)
        })
      case 'api_error':
        return this.advanceOr(flow, document, async () => {
          const retryAt = flow.retryAt ?? seen.at + PRD_FLOW_API_ERROR_BACKOFF_MS
          if (this.ports.now() < retryAt) {
            this.ports.patch(flow.ticketId, { retryAt, detail: API_ERROR_WAIT_DETAIL })
            this.wakeAt(retryAt)
            return
          }
          await this.resume(flow, document, 'api_error')
        })
      case 'user_stopped':
        // The person's stop stands until they say otherwise, whatever is on disk.
        if (!flow.forcePrompt) return this.attention(flow, 'user_stopped', USER_STOPPED_DETAIL)
        return this.advanceOr(flow, document, () => this.reprompt(flow, document))
      case 'closed':
        return this.advanceOr(flow, document, () => {
          if (flow.forcePrompt) return this.reprompt(flow, document)
          const fileName = prdFlowFileName(document, flow.prefix)
          return this.attention(
            flow,
            'session_closed',
            `The session was closed. Retry reopens it and asks for ${fileName} again.`
          )
        })
      case 'died': {
        let { delivered } = seen
        let turn: SessionFinalMessage | null | undefined
        if (delivered === null) {
          if (this.isLeftAlone(sessionId)) return
          // The page saw the process go away after the prompt was stamped, which is not to say
          // that the prompt had reached it: a process that exits before its first word (the
          // person said no to the dialog it opened with, its command failed) never got it. What
          // the main process has on record now says which, not what it said a moment ago.
          turn = await this.recordedTurn(sessionId, true)
          if (!this.unchanged(flow, sessionId, shown)) return
          delivered = recordShowsDelivery(turn, flow.promptedAt ?? 0)
        }
        if (!delivered) return this.resendUndelivered(flow, sessionId, document, turn)
        return this.advanceOr(flow, document, () => this.resume(flow, document, 'interrupted'))
      }
      case 'idle': {
        if (flow.forcePrompt) {
          return this.advanceOr(flow, document, () => this.reprompt(flow, document))
        }
        // Nothing to measure the silence from: the flow waits for a sign of its session.
        if (flow.promptedAt === null) return
        // A prompt takes a moment to show as work; one that never does did not arrive.
        const due = flow.promptedAt + PRD_FLOW_UNDELIVERED_GRACE_MS
        if (this.ports.now() < due) {
          this.wakeAt(due)
          return
        }
        return this.resendUndelivered(flow, sessionId, document)
      }
    }
  }

  /**
   * The flow's prompt never reached its session: it is sent again as it was. Every such send
   * goes through here, whichever look found the prompt undelivered (a "working" nothing stood
   * behind, a process that went away before the prompt got to it, a silence that lasted too
   * long), because each of them can be wrong in the same two ways.
   *
   * The main process may have recorded the prompt arriving a moment ago. It is asked now, not
   * believed on an answer a few seconds old (`turn` is its answer when the caller has just
   * asked), and when it has the prompt on record nothing is sent: the next look judges that.
   *
   * And when it has nothing at all on record of the session, the session may have a process
   * all the same, held before its first word: at the dialog that asks whether the folder is
   * trusted, at a login screen, or slow to start. A prompt sent there is typed into that
   * dialog. So the session is asked about (not known: nothing is done on this look), and one
   * that has a process is left alone: the flow stays on, says that it waits for the person and
   * counts no resume, and it goes on by itself once the session records anything. The
   * "working" the page may show of such a session is left standing: what the session does
   * next is written over it. The sentence is the only thing written, and only once: a look
   * that finds the session still held changes nothing.
   */
  private async resendUndelivered(
    flow: PrdFlow,
    sessionId: string,
    document: PrdFlowDocument,
    turn?: SessionFinalMessage | null
  ): Promise<void> {
    if (this.isLeftAlone(sessionId)) return
    const shown = this.ports.signal(sessionId)
    let recorded = turn
    if (recorded === undefined) {
      recorded = await this.recordedTurn(sessionId, true)
      if (!this.unchanged(flow, sessionId, shown)) return
    }
    if (recordShowsDelivery(recorded, flow.promptedAt ?? 0)) return
    if (!recorded) {
      const there = await this.sessionIsThere(flow, sessionId)
      if (there === null || !this.unchanged(flow, sessionId, shown)) return
      if (there) {
        if (flow.detail !== SESSION_HELD_DETAIL) {
          this.ports.patch(flow.ticketId, { detail: SESSION_HELD_DETAIL })
        }
        return
      }
    }

    // A status nothing stood behind goes first: nothing must take the session for at work
    // from here on, also when the flow has no resume left and stops.
    if (shown.kind === 'working') this.ports.forgetSessionStatus(sessionId)
    const left = this.ports.signal(sessionId)
    return this.advanceOr(flow, document, async () => {
      // The document was looked for meanwhile: the session must still be as it was left.
      if (!this.unchanged(flow, sessionId, left)) return
      await this.resume(flow, document, 'undelivered')
    })
  }

  /**
   * A flow that needs attention prompts nothing. It comes back by itself in two cases: the
   * person put the session to work again, or the session is at rest and the document it could
   * not be brought to write is there after all (they asked for it themselves, or wrote it).
   * Only this page's own status says that the session is at work again: what the main process
   * recorded may be older than the stop (a turn the person interrupts records nothing), and
   * a flow that came back on its word would wait for a session that does nothing.
   */
  private async watchForReturn(
    flow: PrdFlow,
    sessionId: string,
    document: PrdFlowDocument
  ): Promise<void> {
    const live = this.observeLive(flow, sessionId)
    const seen = live ?? (await this.observeRecorded(flow, sessionId))
    if (!this.current(flow)) return

    if (seen.kind === 'working' || seen.kind === 'blocked') {
      if (!live) return
      this.ports.patch(flow.ticketId, {
        status: 'running',
        attention: null,
        detail: null,
        reprompts: 0,
        resumes: 0,
        forcePrompt: false
      })
      return
    }
    if (seen.kind === 'settling') {
      this.wakeAt(seen.until)
      return
    }
    if (!flow.attention || !SELF_HEALING.has(flow.attention) || !AT_REST.has(seen.kind)) return
    const found = await this.find(flow, document)
    if (!found || !this.current(flow)) return
    await this.advance(flow, document, found)
  }

  /**
   * Keeps the flow waiting for work the session left running, for as long as that is
   * reasonable. True while it waits; false once it has waited too long.
   */
  private waitForWork(flow: PrdFlow): boolean {
    const waitingSince = flow.waitingSince ?? this.ports.now()
    const limit = waitingSince + PRD_FLOW_WAIT_FOR_WORK_MS
    if (this.ports.now() >= limit) return false
    this.ports.patch(flow.ticketId, { waitingSince, detail: WAITING_FOR_WORK_DETAIL })
    this.wakeAt(limit)
    return true
  }

  // ── Moving the flow along ────────────────────────────────────────────────

  /** Goes on to the next stage when the stage's document is there; does `otherwise` when it is not. */
  private async advanceOr(
    flow: PrdFlow,
    document: PrdFlowDocument,
    otherwise: () => Promise<void>
  ): Promise<void> {
    const found = await this.find(flow, document)
    if (!this.current(flow)) return
    if (found) return this.advance(flow, document, found)
    await otherwise()
  }

  /** The stage's document exists at `found`: the PRD leads to the tasks prompt, the tasks to the orchestrator. */
  private async advance(flow: PrdFlow, document: PrdFlowDocument, found: string): Promise<void> {
    if (document === 'prd') {
      return this.stampAndSend(
        flow,
        { stage: 'tasks', prdPath: found, reprompts: 0, resumes: 0 },
        buildTasksPrompt({ prefix: flow.prefix, prdPath: found }),
        // The session never got the tasks prompt: the flow stays at the PRD, so that Retry
        // sends that prompt, not a reminder of a message that did not arrive.
        { stage: 'prd' }
      )
    }
    const next = this.write(flow, {
      stage: 'creating_run',
      tasksPath: found,
      status: 'running',
      attention: null,
      detail: null,
      forcePrompt: false,
      waitingSince: null,
      retryAt: null
    })
    if (next) await this.createRun(next)
  }

  /** The session came to rest without the document: it is asked once more, then the person is. */
  private async reprompt(flow: PrdFlow, document: PrdFlowDocument): Promise<void> {
    const fileName = prdFlowFileName(document, flow.prefix)
    if (flow.reprompts >= PRD_FLOW_MAX_REPROMPTS) {
      return this.attention(flow, 'missing_file', `${fileName} was not created.`)
    }
    return this.stampAndSend(
      flow,
      { reprompts: flow.reprompts + 1 },
      buildPrdFlowRepromptPrompt({
        document,
        reason: 'missing',
        prefix: flow.prefix,
        path: prdFlowDocumentPath(flow, document)
      })
    )
  }

  /**
   * The turn did not come to its end: it broke on an API error, its session went away, or the
   * prompt never reached it. The session is asked to carry on a few times (a prompt that never
   * arrived is sent again in full, and only by way of `resendUndelivered`), then the person is.
   */
  private async resume(
    flow: PrdFlow,
    document: PrdFlowDocument,
    reason: 'api_error' | 'interrupted' | 'undelivered'
  ): Promise<void> {
    if (flow.resumes >= PRD_FLOW_MAX_RESUMES) {
      if (reason === 'api_error') {
        return this.attention(flow, 'api_error', 'The session keeps ending on an API error.')
      }
      const fileName = prdFlowFileName(document, flow.prefix)
      return this.attention(
        flow,
        'interrupted',
        `The session keeps stopping before ${fileName} is written.`
      )
    }
    // A prompt that never arrived is sent again as it was; a turn that was cut off is told so.
    const prompt =
      reason === 'undelivered'
        ? this.stagePrompt(flow, document)
        : buildPrdFlowRepromptPrompt({
            document,
            reason,
            prefix: flow.prefix,
            path: prdFlowDocumentPath(flow, document)
          })
    return this.stampAndSend(flow, { resumes: flow.resumes + 1 }, prompt)
  }

  /** The prompt the stage began with. */
  private stagePrompt(flow: PrdFlow, document: PrdFlowDocument): string {
    if (document === 'prd') {
      return buildPrdPrompt({
        prompt: flow.prompt,
        prefix: flow.prefix,
        research: flow.research,
        clarify: flow.clarify,
        sdk: flow.launch.sdk
      })
    }
    return buildTasksPrompt({
      prefix: flow.prefix,
      prdPath: flow.prdPath ?? prdFlowDocumentPath(flow, 'prd')
    })
  }

  /**
   * Sends a prompt into the flow's session. The stamp is written first, always: from then on
   * the flow is on, everything the session did before is older than the stamp, and a tick that
   * comes while the prompt is on its way finds a flow that was just prompted. A ticket that
   * sat in Review or To Do is back In Progress before its session is. A prompt that could not
   * be delivered stops the flow; `unsent` is what the stamp's patch takes back then.
   */
  private async stampAndSend(
    flow: PrdFlow,
    patch: PrdFlowPatch,
    prompt: string,
    unsent: PrdFlowPatch = {}
  ): Promise<void> {
    const stamped = this.write(flow, {
      ...patch,
      promptedAt: this.ports.now(),
      waitingSince: null,
      retryAt: null,
      detail: null,
      forcePrompt: false,
      status: 'running',
      attention: null
    })
    if (!stamped) return

    const column = this.column(stamped)
    if (column === 'review' || column === 'todo') {
      await this.move(stamped, 'in_progress')
      if (!this.current(stamped)) return
    }
    try {
      await this.ports.sendPrompt(stamped, prompt)
    } catch (error) {
      if (!this.current(stamped)) return
      const failed = this.write(stamped, unsent)
      if (!failed) return
      await this.attention(
        failed,
        'send_failed',
        `Could not send a message to the session: ${describeError(error)}`
      )
    }
  }

  /**
   * The tasks document exists: an orchestrator is made of it, the planning ticket becomes its
   * child, and the flow is over. A run the server already lists for the document is taken
   * instead of making a second one (the app went away between creating it and recording it).
   */
  private async createRun(flow: PrdFlow): Promise<void> {
    const tasksPath = flow.tasksPath ?? prdFlowDocumentPath(flow, 'tasks')
    let run: PrdFlowRun | null
    try {
      run = flow.runId ? { runId: flow.runId, ticketId: null } : null
      if (!run) {
        run = await this.ports.findRun(flow, tasksPath)
        if (!this.current(flow)) return
      }
      if (!run) {
        run = await this.ports.createRun(flow, tasksPath)
        if (!this.current(flow)) return
      }
    } catch (error) {
      const failed = this.current(flow)
      if (!failed) return
      return this.attention(
        failed,
        'run_failed',
        `The orchestrator ticket could not be created: ${describeError(error)}`
      )
    }

    const recorded = this.write(flow, { runId: run.runId })
    if (!recorded) return
    const ticket = this.ports.ticket(recorded)
    if (run.ticketId && ticket.state === 'present' && ticket.linkable) {
      try {
        await this.ports.linkToRun(recorded, run.ticketId)
      } catch (error) {
        console.warn(
          `[prdFlow] could not put the ticket of “${flow.name}” under its orchestrator`,
          error
        )
      }
      if (!this.current(recorded)) return
    }

    // The flow is over, and its hold with it: the ticket waits in Review with its session open.
    this.ports.remove(flow.ticketId)
    if (this.column(recorded) === 'in_progress') await this.move(recorded, 'review')
    this.ports.notify(
      'success',
      `“${flow.name}”: ${tasksFileName(flow.prefix)} became an orchestrator ticket in To Do. Launch it once its tickets are extracted.`
    )
  }

  /**
   * The flow stops and prompts nothing until the person retries (or puts the session back to
   * work): its ticket goes to Review, where what needs them is looked for, and they are told
   * once. `also` is written with the stop.
   */
  private async attention(
    flow: PrdFlow,
    kind: PrdFlowAttention,
    detail: string,
    also: PrdFlowPatch = {}
  ): Promise<void> {
    if (flow.status === 'needs_attention' && flow.attention === kind && flow.detail === detail) {
      return
    }
    const flagged = this.write(flow, {
      ...also,
      status: 'needs_attention',
      attention: kind,
      detail,
      forcePrompt: false,
      waitingSince: null,
      retryAt: null
    })
    if (!flagged) return
    if (this.column(flagged) === 'in_progress') {
      await this.move(flagged, 'review')
      if (!this.current(flagged)) return
    }
    this.ports.notify('warning', `PRD flow of “${flow.name}”: ${detail}`)
  }
}

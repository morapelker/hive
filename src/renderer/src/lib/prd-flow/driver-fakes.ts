import { vi } from 'vitest'
import type { SessionFinalMessage } from '@shared/types/document-flow'
import type { SessionSignal } from '@/lib/document-flow/session-signal'
import type { PrdFlow, PrdFlowPatch } from '@/stores/usePrdFlowStore'
import {
  PRD_FLOW_SETTLE_MS,
  type PrdFlowNoticeLevel,
  type PrdFlowPorts,
  type PrdFlowRun,
  type PrdFlowTicketState
} from './ports'

// Test support for the PRD flow driver: an in-memory stand-in for everything behind its ports.
// Flows live in a map that behaves like the store (a write that changes nothing keeps the
// object and tells nobody; any other write notifies the subscribers), the session is whatever
// signal and recorded turn a test scripts for it, and the disk is a set of paths. Meant to be
// used with `vi.useFakeTimers()`; time is `Date.now()`.
//
// The session is faked the way the app shows one. A session that is at work shows as working
// on the page and has that recorded by the main process. A prompt that is sent shows the
// session as working at once, before it is delivered: that status is the send's own, taken
// back when the send fails (`failNextSend`) and left standing with nothing behind it when the
// session never gets to the prompt (`silentSessions`). The person's own message into a session
// writes the same status the same way: `setSignal` with `recorded: false`.
//
// Whether a session's agent is there is faked as the app answers it: a session the main
// process has recorded something of is started, and so is one whose process is alive and held
// before its first word (`heldSessions`); one with neither is not (an SDK session that was
// never prompted, a CLI whose process is gone), and nor is one a test says is gone
// (`unstartedSessions`), whatever was recorded of it.

export const TICKET_ID = 'ticket-1'
export const PROJECT_ID = 'project-1'
export const SESSION_ID = 'session-1'
export const NAME = 'Code mode'
export const PREFIX = 'CODE_MODE'
export const CWD = '/repo/shop'
export const PRD_PATH = '/repo/shop/CODE_MODE_PRD.html'
export const TASKS_PATH = '/repo/shop/CODE_MODE_TASKS.html'
export const RUN_ID = 'run-1'
/** The board ticket of the orchestrator run the fake server creates. */
export const RUN_TICKET_ID = 'ticket-run'
/** The fake app instance "started" at this time; tests start the clock an hour later. */
export const APP_STARTED_AT = '2026-05-04T09:00:00.000Z'
export const TEST_NOW = '2026-05-04T10:00:00.000Z'
/** When the flow's stage was last prompted: a minute before the test clock, after the app started. */
export const PROMPTED_AT = Date.parse('2026-05-04T09:59:00.000Z')

/** A flow whose session was asked for the PRD a minute ago. */
export function makeFlow(overrides: Partial<PrdFlow> = {}): PrdFlow {
  return {
    ticketId: TICKET_ID,
    projectId: PROJECT_ID,
    name: NAME,
    prefix: PREFIX,
    prompt: 'Add a code mode to the editor.',
    research: true,
    clarify: true,
    launch: {
      sdk: 'claude-code-cli',
      model: { providerID: 'anthropic', modelID: 'opus' },
      codexFastMode: false,
      customProviderId: null
    },
    checkout: { kind: 'worktree', worktreeId: 'wt-main' },
    cwd: CWD,
    memberDirs: [],
    sessionId: SESSION_ID,
    stage: 'prd',
    status: 'running',
    attention: null,
    detail: null,
    promptedAt: PROMPTED_AT,
    reprompts: 0,
    resumes: 0,
    waitingSince: null,
    retryAt: null,
    forcePrompt: false,
    prdPath: null,
    tasksPath: null,
    runId: null,
    createdAt: PROMPTED_AT,
    ...overrides
  }
}

/** The main process's record of a turn that ended half a minute after the prompt. */
export function makeTurn(overrides: Partial<SessionFinalMessage> = {}): SessionFinalMessage {
  return {
    session_id: SESSION_ID,
    state: 'ended',
    text: 'All done.',
    completion: 'completed',
    api_error: null,
    hook_event: 'Stop',
    detail: null,
    background_work: null,
    updated_at: new Date(PROMPTED_AT + 30_000).toISOString(),
    ...overrides
  }
}

type PresentTicket = Extract<PrdFlowTicketState, { state: 'present' }>
type EndedSignal = Extract<SessionSignal, { kind: 'ended' }>

/** A prompt the driver sent, with the flow as the store held it at that moment. */
export interface SentPrompt {
  sessionId: string | null
  prompt: string
  at: number
  flow: PrdFlow | null
}

export interface WorldOptions {
  /** The one flow in the store; `null` for an empty store. */
  flow?: Partial<PrdFlow> | null
  /** The flow's ticket on the board: In Progress and linked to the flow's session by default. */
  ticket?: Partial<Omit<PresentTicket, 'state'>> | 'gone' | 'loading'
  /**
   * What the page knows of the session. By default it is at work on the flow's prompt, which
   * the main process recorded as well; `null` for a page that knows nothing (it was reloaded
   * since), with nothing recorded.
   */
  signal?: SessionSignal | null
}

export type PrdFlowWorld = ReturnType<typeof createWorld>

const sameValue = (a: unknown, b: unknown): boolean =>
  a === b || (typeof a === 'object' && JSON.stringify(a) === JSON.stringify(b))

export function createWorld(options: WorldOptions = {}) {
  const flows = new Map<string, PrdFlow>()
  const listeners = new Set<() => void>()
  const tickets = new Map<string, PrdFlowTicketState>()
  const signals = new Map<string, SessionSignal>()
  const turns = new Map<string, SessionFinalMessage>()
  /** Sessions whose row was closed. */
  const closedSessions = new Set<string>()
  /**
   * Sessions a prompt does not put to work: it is sent, the page shows the session as working
   * (the send's own status), and the session never does anything with it.
   */
  const silentSessions = new Set<string>()
  /**
   * Sessions whose agent is not there: it was never started (a launch was cut off before
   * that), or its process went away.
   */
  const unstartedSessions = new Set<string>()
  /**
   * Sessions whose process is alive and has not taken a turn: it is held at something it
   * shows the person before its first word (whether the folder is trusted, a login), or is
   * slow to start. Nothing is recorded of such a session, and a prompt sent into it is typed
   * into whatever it shows.
   */
  const heldSessions = new Set<string>()
  /** What the next sends are rejected with, in order. */
  const sendFailures: Error[] = []
  /** The sessions closed as what a cut-off launch left behind. */
  const discarded: { ticketId: string; sessionId: string }[] = []
  /** Tickets whose session this page is starting at this moment. */
  const launching = new Set<string>()
  /** The paths that exist on the fake disk. */
  const files = new Set<string>()
  /** The runs the fake server lists, by the document they were made from. */
  const runs = new Map<string, PrdFlowRun>()
  const sent: SentPrompt[] = []
  const notices: { level: PrdFlowNoticeLevel; message: string }[] = []
  const moves: { ticketId: string; column: 'in_progress' | 'review' }[] = []
  const links: { ticketId: string; runTicketId: string }[] = []
  let appStartedAt = Date.parse(APP_STARTED_AT)

  const notifyListeners = (): void => {
    for (const listener of [...listeners]) listener()
  }

  /** Like the store's patchFlow: present keys only, and nothing happens when nothing changes. */
  const patchFlow = (ticketId: string, patch: PrdFlowPatch): void => {
    const current = flows.get(ticketId)
    if (!current) return
    const changed = (Object.keys(patch) as (keyof PrdFlowPatch)[]).some(
      (key) => !sameValue(current[key], patch[key])
    )
    if (!changed) return
    flows.set(ticketId, { ...current, ...patch })
    notifyListeners()
  }

  const putFlow = (flow: PrdFlow): void => {
    flows.set(flow.ticketId, flow)
    notifyListeners()
  }

  const presentTicket = (ticketId: string): PresentTicket => {
    const ticket = tickets.get(ticketId)
    if (!ticket || ticket.state !== 'present') throw new Error(`no ticket ${ticketId} on the board`)
    return ticket
  }

  /** What the board says of the ticket from now on: a change of it, or that it is gone or not loaded. */
  const setTicket = (
    ticket: Partial<Omit<PresentTicket, 'state'>> | 'gone' | 'loading',
    ticketId: string = TICKET_ID
  ): void => {
    if (ticket === 'gone' || ticket === 'loading') {
      tickets.set(ticketId, { state: ticket })
    } else {
      const current = tickets.get(ticketId)
      tickets.set(ticketId, {
        state: 'present',
        column: 'in_progress',
        archived: false,
        sessionId: flows.get(ticketId)?.sessionId ?? null,
        linkable: true,
        ...(current?.state === 'present' ? current : {}),
        ...ticket
      })
    }
    notifyListeners()
  }

  /** The main process recorded the session at work at `at`. */
  const recordWork = (sessionId: string, at: number): void => {
    turns.set(
      sessionId,
      makeTurn({
        session_id: sessionId,
        state: 'working',
        text: '',
        completion: null,
        hook_event: 'Working',
        updated_at: new Date(at).toISOString()
      })
    )
  }

  /**
   * What the page shows of the session from now on. A session that shows as working is at
   * work: the main process records that too, as it does for every session that reports work.
   * `recorded: false` for a working status nothing is recorded behind: the one a send writes
   * before its prompt is delivered, as when the person types a message into the session.
   */
  const setSignal = (
    sessionId: string,
    signal: SessionSignal,
    { recorded = true }: { recorded?: boolean } = {}
  ): void => {
    // Like the status store: a working status knows when it was written.
    signals.set(
      sessionId,
      signal.kind === 'working' && signal.since === undefined
        ? { ...signal, since: Date.now() }
        : signal
    )
    if (signal.kind === 'working' && recorded) recordWork(sessionId, Date.now())
    notifyListeners()
  }

  /** The session's turn ends now; `overrides` scripts an API error, a pause, an interrupt. */
  const endTurn = (overrides: Partial<EndedSignal> = {}, sessionId: string = SESSION_ID): void =>
    setSignal(sessionId, {
      kind: 'ended',
      at: Date.now(),
      completion: 'completed',
      apiError: null,
      reason: null,
      hookEvent: null,
      hasBackgroundWork: false,
      ...overrides
    })

  /** The main process recorded this of the session's last turn. */
  const recordTurn = (overrides: Partial<SessionFinalMessage> = {}): void => {
    const turn = makeTurn(overrides)
    turns.set(turn.session_id, turn)
  }

  /** The person closed the session: its row is closed, and the page has no status for it. */
  const closeSession = (sessionId: string = SESSION_ID): void => {
    closedSessions.add(sessionId)
    signals.delete(sessionId)
    notifyListeners()
  }

  const writeFile = (path: string): void => {
    files.add(path)
  }

  /** The next prompt is not delivered: the send rejects with `error`. */
  const failNextSend = (error: Error): void => {
    sendFailures.push(error)
  }

  /** The app was restarted at `at`: this page has no status for any session. */
  const restartApp = (at: number = Date.now()): void => {
    appStartedAt = at
    signals.clear()
    notifyListeners()
  }

  /** The flow in the store; fails the test when it is gone. */
  const flow = (ticketId: string = TICKET_ID): PrdFlow => {
    const found = flows.get(ticketId)
    if (!found) throw new Error(`no flow of ${ticketId}`)
    return found
  }

  /**
   * "Retry PRD flow" as ./actions does it for a flow past its launch: the flow is on again
   * with its counts fresh, its session is to be prompted whatever state it is in, and a ticket
   * that sat in Review or To Do is back In Progress.
   */
  const retry = (ticketId: string = TICKET_ID): void => {
    const current = flow(ticketId)
    const ticket = tickets.get(ticketId)
    if (ticket?.state === 'present' && (ticket.column === 'review' || ticket.column === 'todo')) {
      tickets.set(ticketId, { ...ticket, column: 'in_progress' })
    }
    patchFlow(ticketId, {
      status: 'running',
      attention: null,
      detail: null,
      reprompts: 0,
      resumes: 0,
      waitingSince: null,
      retryAt: null,
      forcePrompt: current.stage !== 'creating_run'
    })
  }

  if (options.flow !== null) {
    const initial = makeFlow(options.flow)
    flows.set(initial.ticketId, initial)
    const ticket = options.ticket ?? {}
    tickets.set(
      initial.ticketId,
      ticket === 'gone' || ticket === 'loading'
        ? { state: ticket }
        : {
            state: 'present',
            column: 'in_progress',
            archived: false,
            sessionId: initial.sessionId,
            linkable: true,
            ...ticket
          }
    )
    const signal =
      options.signal === undefined
        ? ({ kind: 'working', since: initial.promptedAt ?? PROMPTED_AT } satisfies SessionSignal)
        : options.signal
    if (signal && initial.sessionId) signals.set(initial.sessionId, signal)
    // The session got the flow's prompt and went to work on it a moment later.
    if (options.signal === undefined && initial.sessionId) {
      recordWork(initial.sessionId, (initial.promptedAt ?? PROMPTED_AT) + 1_000)
    }
  }

  const ports = {
    now: () => Date.now(),

    flows: () => [...flows.values()],
    flow: (ticketId: string) => flows.get(ticketId) ?? null,
    patch: vi.fn(patchFlow),
    remove: vi.fn((ticketId: string) => {
      if (flows.delete(ticketId)) notifyListeners()
    }),
    isLaunching: (ticketId: string) => launching.has(ticketId),

    ticket: (target: PrdFlow): PrdFlowTicketState =>
      tickets.get(target.ticketId) ?? { state: 'gone' },
    moveTicket: vi.fn(async (target: PrdFlow, column: 'in_progress' | 'review') => {
      moves.push({ ticketId: target.ticketId, column })
      const ticket = tickets.get(target.ticketId)
      if (ticket?.state === 'present') tickets.set(target.ticketId, { ...ticket, column })
      notifyListeners()
    }),
    linkToRun: vi.fn(async (target: PrdFlow, runTicketId: string) => {
      links.push({ ticketId: target.ticketId, runTicketId })
    }),

    signal: (sessionId: string): SessionSignal => signals.get(sessionId) ?? { kind: 'unknown' },
    sessionTurn: vi.fn(async (sessionId: string) => turns.get(sessionId) ?? null),
    isSessionClosed: vi.fn(async (sessionId: string) => closedSessions.has(sessionId)),
    appStartedAt: vi.fn(async () => appStartedAt),
    sendPrompt: vi.fn(async (target: PrdFlow, prompt: string) => {
      const { sessionId } = target
      // Like the real send: the page shows the session as working from the moment the prompt
      // is sent, before it is delivered.
      if (sessionId) {
        signals.set(sessionId, { kind: 'working', since: Date.now() })
        notifyListeners()
      }
      const failure = sendFailures.shift()
      if (failure) {
        // The prompt was not delivered: the port takes the status it wrote back, and rejects.
        if (sessionId) {
          signals.delete(sessionId)
          notifyListeners()
        }
        throw failure
      }
      sent.push({ sessionId, prompt, at: Date.now(), flow: flows.get(target.ticketId) ?? null })
      if (!sessionId || silentSessions.has(sessionId) || heldSessions.has(sessionId)) return
      // The session got the prompt: one that was closed is open again, and the main process
      // records it at work a moment later.
      closedSessions.delete(sessionId)
      recordWork(sessionId, Date.now() + 1)
    }),
    forgetSessionStatus: vi.fn((sessionId: string) => {
      if (signals.delete(sessionId)) notifyListeners()
    }),
    isSessionStarted: vi.fn(
      async (sessionId: string) =>
        !unstartedSessions.has(sessionId) && (turns.has(sessionId) || heldSessions.has(sessionId))
    ),
    discardLaunch: vi.fn(async (target: PrdFlow, sessionId: string): Promise<boolean> => {
      discarded.push({ ticketId: target.ticketId, sessionId })
      closedSessions.add(sessionId)
      signals.delete(sessionId)
      // The ticket returns to To Do when it still points at that session.
      const ticket = tickets.get(target.ticketId)
      if (ticket?.state === 'present' && ticket.sessionId === sessionId) {
        tickets.set(target.ticketId, { ...ticket, column: 'todo', sessionId: null })
      }
      notifyListeners()
      return false
    }),

    fileExists: vi.fn(async (path: string) => files.has(path)),
    findRun: vi.fn(
      async (_target: PrdFlow, tasksPath: string): Promise<PrdFlowRun | null> =>
        runs.get(tasksPath) ?? null
    ),
    createRun: vi.fn(async (_target: PrdFlow, tasksPath: string): Promise<PrdFlowRun> => {
      const run: PrdFlowRun = { runId: RUN_ID, ticketId: RUN_TICKET_ID }
      runs.set(tasksPath, run)
      return run
    }),

    notify: (level: PrdFlowNoticeLevel, message: string) => {
      notices.push({ level, message })
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  } satisfies PrdFlowPorts

  return {
    ports,
    flows,
    tickets,
    signals,
    turns,
    closedSessions,
    silentSessions,
    unstartedSessions,
    heldSessions,
    discarded,
    launching,
    files,
    runs,
    sent,
    notices,
    moves,
    links,
    flow,
    /** Whether the store still holds the flow. */
    hasFlow: (ticketId: string = TICKET_ID): boolean => flows.has(ticketId),
    putFlow,
    /** A write of the flow from outside the driver (the launch, an action of the person). */
    patchFlow: (patch: PrdFlowPatch, ticketId: string = TICKET_ID): void =>
      patchFlow(ticketId, patch),
    retry,
    /** The flow's ticket as the board has it; fails the test when it is not on the board. */
    ticket: presentTicket,
    /** The column the flow's ticket sits in. */
    column: (ticketId: string = TICKET_ID) => presentTicket(ticketId).column,
    setTicket,
    setSignal,
    endTurn,
    recordTurn,
    closeSession,
    writeFile,
    failNextSend,
    restartApp,
    /** The prompts the driver sent, in order. */
    prompts: (): string[] => sent.map((entry) => entry.prompt),
    /** The messages of the notices of one level, in order. */
    noticesOf: (level: PrdFlowNoticeLevel): string[] =>
      notices.filter((notice) => notice.level === level).map((notice) => notice.message)
  }
}

/** Let the driver work for `ms` of fake time (timers and the promise chains between them). */
export async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

/** Let a turn end stand until it counts, and the driver act on it. */
export async function settle(): Promise<void> {
  await advance(PRD_FLOW_SETTLE_MS + 1_000)
}

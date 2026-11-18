import type { SessionFinalMessage } from '@shared/types/document-flow'
import type { SessionSignal } from '@/lib/document-flow/session-signal'
import type { PrdFlow, PrdFlowPatch } from '@/stores/usePrdFlowStore'
import type { KanbanTicketColumn } from '../../../../main/db/types'

// What the PRD flow driver (./driver) needs from the app, behind one interface so the state
// machine is tested against an in-memory world (./driver-fakes) with a fake clock. ./live-ports
// wires it to the stores and the RPC client.

/** A turn end must stand this long before it counts: sessions bounce in and out of completed. */
export const PRD_FLOW_SETTLE_MS = 3_000
/** The driver looks at every flow at least this often, whatever the stores say. */
export const PRD_FLOW_TICK_INTERVAL_MS = 10_000
export const PRD_FLOW_TICK_DEBOUNCE_MS = 100
/** How often the main process is asked about a session this page has no status for. */
export const PRD_FLOW_TURN_POLL_MS = 5_000
/** Times a document is asked for again after a turn that ended without it. */
export const PRD_FLOW_MAX_REPROMPTS = 1
/** Times a stage is resumed after an API error, an interruption or an undelivered prompt. */
export const PRD_FLOW_MAX_RESUMES = 3
/** How long work the session left running may keep the flow waiting before it is prompted anyway. */
export const PRD_FLOW_WAIT_FOR_WORK_MS = 30 * 60_000
/** How long after an API error the session is left alone before it is asked to continue. */
export const PRD_FLOW_API_ERROR_BACKOFF_MS = 2 * 60_000
/**
 * A prompt that shows no sign of having reached the session after this long is sent again,
 * unless its session turns out to have a process that has not taken a turn yet: that one is
 * held at something it shows the person, and is waited for.
 */
export const PRD_FLOW_UNDELIVERED_GRACE_MS = 60_000
/**
 * How long this page's "working" status of a session is taken at its word, from the later of
 * the flow's prompt and the moment the status was written. Whoever sends a prompt writes that
 * status, before the prompt is delivered (the flow, and the person when they type into the
 * session); once it has stood this long the main process is asked whether the session really
 * got to work, and a session it never saw at work is prompted again.
 */
export const PRD_FLOW_UNCONFIRMED_WORK_MS = 3 * 60_000

/** The flow's ticket as the board has it. */
export type PrdFlowTicketState =
  /** The project's board is not loaded on this page yet: nothing can be said. */
  | { state: 'loading' }
  /** The board is loaded and the ticket is not on it. */
  | { state: 'gone' }
  | {
      state: 'present'
      column: KanbanTicketColumn
      archived: boolean
      /** The session the ticket is linked to. */
      sessionId: string | null
      /** A ticket of the database board: only those can be made the child of another. */
      linkable: boolean
    }

/** The orchestrator run made from a tasks document, with its own board ticket (null when the board could not be written). */
export interface PrdFlowRun {
  runId: string
  ticketId: string | null
}

export type PrdFlowNoticeLevel = 'success' | 'info' | 'warning' | 'error'

export interface PrdFlowPorts {
  now(): number

  // ── The flows (stores/usePrdFlowStore) ──
  flows(): PrdFlow[]
  flow(ticketId: string): PrdFlow | null
  patch(ticketId: string, patch: PrdFlowPatch): void
  remove(ticketId: string): void
  /** This page is starting the flow's session at this moment (./start): the driver keeps off. */
  isLaunching(ticketId: string): boolean

  // ── The board ──
  /** Asks for the project's board to be loaded when it is not. */
  ticket(flow: PrdFlow): PrdFlowTicketState
  /** Puts the ticket in the column (top of it) without closing or reviving its session. */
  moveTicket(flow: PrdFlow, column: 'in_progress' | 'review'): Promise<void>
  /** Makes the flow's ticket a child of the orchestrator's. */
  linkToRun(flow: PrdFlow, runTicketId: string): Promise<void>

  // ── The session ──
  /** What this page knows of the session's turn (lib/document-flow/session-signal). */
  signal(sessionId: string): SessionSignal
  /** The main process's durable record of the session's last turn state; null when none. */
  sessionTurn(sessionId: string): Promise<SessionFinalMessage | null>
  /** The session's row is closed (the person closed it, or its ticket went to Done). */
  isSessionClosed(sessionId: string): Promise<boolean>
  /** When this app instance started (epoch ms); 0 while it is not known. */
  appStartedAt(): Promise<number>
  /**
   * Sends a prompt into the flow's session, reviving it when it has no live process. The
   * session shows as working on this page from the moment the prompt is sent. Rejects when it
   * was not delivered, and leaves no working status of the send behind then.
   */
  sendPrompt(flow: PrdFlow, prompt: string): Promise<void>
  /**
   * Drops this page's status of the session: it was the send's own, and the session never
   * confirmed it.
   */
  forgetSessionStatus(sessionId: string): void
  /**
   * The session's agent was really started: a live process for a CLI, a prompted backend
   * session for an SDK. Rejects when that could not be found out. Asked of a launch that was
   * cut off, and of a session the main process has no word of (or only an old one): a CLI
   * that has a process and has not taken a turn is held at something it shows the person, and
   * is not to be prompted; one that has none is not at work, whatever the page shows.
   */
  isSessionStarted(sessionId: string): Promise<boolean>
  /**
   * Closes a session a launch that got nowhere left behind and returns the ticket to To Do
   * when it still points at it. Resolves true when the ticket points at that session all the
   * same afterwards (it could not be put back): the flow remembers the session then.
   */
  discardLaunch(flow: PrdFlow, sessionId: string): Promise<boolean>

  // ── Files and the orchestrator ──
  fileExists(path: string): Promise<boolean>
  /**
   * A run of the flow's project already made from that document, as the server lists them (the
   * app went away between creating the run and recording it); null when there is none.
   */
  findRun(flow: PrdFlow, tasksPath: string): Promise<PrdFlowRun | null>
  /** Creates the orchestrator run of the tasks document: it starts extracting, with its ticket in To Do. */
  createRun(flow: PrdFlow, tasksPath: string): Promise<PrdFlowRun>

  notify(level: PrdFlowNoticeLevel, message: string): void
  /** Calls back when anything the driver reads may have changed. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void
}

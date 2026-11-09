import { CLI_FOLLOW_UP_LEAD } from '@shared/document-flow/prompts'
import { isAgentCli } from '@shared/types/agent-sdk'
import type {
  DocumentRunDetail,
  DocumentRunItem,
  DocumentRunItemPatch,
  DocumentRunLaunchConfig
} from '@shared/types/document-flow'
import { dbApi } from '@/api/db-api'
import { documentFlowApi, type DocumentFlowApi } from '@/api/document-flow-api'
import { opencodeApi } from '@/api/opencode-api'
import { getRendererRpcClient } from '@/api/rpc-client'
import { systemApi } from '@/api/system-api'
import { getRendererClientId } from '@/api/hive-client'
import { buildTicketPrompt } from '@/lib/connection-project-launch'
import { unwrapEnvelope } from '@/lib/ipc-envelope'
import { mapOpencodeMessagesToSessionViewMessages } from '@/lib/opencode-transcript'
import { findSessionById, sendFollowupToSession } from '@/lib/session-followup'
import { resolveDefaultLaunchModel } from '@/lib/launch-model'
import {
  launchTicketWithModel,
  type TicketLaunchResult,
  type TicketLaunchSpec
} from '@/lib/ticket-launch'
import { toast } from '@/lib/toast'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import {
  closeSessionOfFinishedTicket,
  useKanbanStore,
  whenKanbanMutationsSettled
} from '@/stores/useKanbanStore'
import { useQuestionStore } from '@/stores/useQuestionStore'
import { useScriptStore } from '@/stores/useScriptStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { resolvePreferredAgentSdk, useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { fireSetupScript, useWorktreeStore } from '@/stores/useWorktreeStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { connectionApi } from '@/api/connection-api'
import type { KanbanTicket, KanbanTicketColumn, Session } from '../../../../main/db/types'
import { tellQuestionMode } from './question-mode'
import { getSessionSignal, startSessionSignalLatch, type SessionSignal } from './session-signal'

// Everything the document-run orchestrator touches outside its own logic. The runner only
// sees this interface, so its whole state machine runs against an in-memory fake in tests;
// `createLiveRunnerPorts` is the one place that knows the real stores and RPC APIs.

export type RunnerApi = Pick<
  DocumentFlowApi,
  | 'claimRunner'
  | 'sessionTurn'
  | 'classify'
  | 'prepareMerge'
  | 'merge'
  | 'verify'
  | 'commitIntegration'
  | 'rollbackMerge'
  | 'finalize'
  | 'logEvent'
  | 'inspectSource'
>

export type RunnerTicket = Pick<
  KanbanTicket,
  | 'id'
  | 'project_id'
  | 'title'
  | 'description'
  | 'attachments'
  | 'column'
  | 'current_session_id'
  | 'worktree_id'
  | 'archived_at'
>

export interface RunnerWorktree {
  id: string
  branch_name: string
  path: string
}

/** A connection instance as the runner needs it: where it is, and which worktree is whose. */
export interface RunnerConnection {
  id: string
  path: string
  status: 'active' | 'archived'
  members: { project_id: string; worktree_id: string; branch_name: string; path: string }[]
}

export interface RunnerNotice {
  level: 'info' | 'success' | 'warning' | 'error'
  message: string
  /**
   * The system notification's title: what kind of run speaks ("Orchestrator" for one made from
   * board tickets). Absent for a document run's notices, which go out as "Document run".
   */
  title?: string
}

export type RunnerTimer = ReturnType<typeof setTimeout>

export interface RunnerPorts {
  api: RunnerApi
  /** This renderer page's id: the owner name on the run's lease. */
  clientId: string

  // ── Runs (through the document-flow store, so the UI moves with the runner) ──
  getRuns(): DocumentRunDetail[]
  getRun(runId: string): DocumentRunDetail | null
  applyDetail(detail: DocumentRunDetail): void
  /** Persists the patch and applies the returned row. */
  updateItem(runId: string, itemId: string, patch: DocumentRunItemPatch): Promise<DocumentRunItem>
  /** Fires whenever something a tick reads may have changed: runs, session statuses, questions. */
  subscribe(listener: () => void): () => void

  // ── Board and worktrees ──
  /**
   * Make sure the project's worktrees and board tickets are in the stores. A connection
   * project names its members: their worktrees and the connections are loaded too.
   */
  loadProject(projectId: string, memberProjectIds?: readonly string[]): Promise<void>
  getTicket(projectId: string, ticketId: string): RunnerTicket | null
  reloadTickets(projectId: string): Promise<void>
  createTicket(
    projectId: string,
    draft: { title: string; description: string; parent_ticket_id?: string | null }
  ): Promise<RunnerTicket>
  moveTicket(
    projectId: string,
    ticketId: string,
    column: KanbanTicketColumn,
    options: { skipCompletionEffects: boolean; keepSession?: boolean }
  ): Promise<void>
  /** The sort order that puts a ticket at the top of `column`. */
  topSortOrder(projectId: string, column: KanbanTicketColumn): number
  /**
   * Put a ticket back in progress, marked as awaiting its session's completion, while the
   * session waits for background work it started (the turn end had moved it to review).
   */
  holdTicketForWork(projectId: string, ticketId: string): Promise<void>
  buildTicketPrompt(ticket: RunnerTicket): string
  getWorktree(worktreeId: string): RunnerWorktree | null
  reloadWorktrees(projectId: string): Promise<void>
  /** A connection instance, from the store or the server; null when it no longer exists. */
  getConnection(connectionId: string): Promise<RunnerConnection | null>

  // ── Sessions ──
  /** The instance a connection session runs on; null for a worktree session or an unknown one. */
  getSessionConnectionId(sessionId: string): Promise<string | null>
  /** The app's default launch: what "Create & Send" would run with. */
  resolveDefaultLaunch(): DocumentRunLaunchConfig
  /** Never rejects; a failure comes back as `{ success: false }`. */
  launchTicket(spec: TicketLaunchSpec): Promise<TicketLaunchResult>
  /** A launch failed after its session row existed: close it so it does not linger as working. */
  completeOrphanSession(sessionId: string): Promise<void>
  /**
   * The run has nothing more to ask of a merged ticket's session (its document update is
   * over): close it, as a move to Merged closes any ticket's session. Left alone while it is
   * working, serves another live ticket, is being revived, or is closed already. Never
   * rejects for a close that failed; that is reported to the user.
   */
  closeTicketSession(projectId: string, ticketId: string, sessionId: string): Promise<void>
  resetTicketToTodo(projectId: string, ticketId: string): Promise<void>
  /**
   * Drop the ticket's link to a session that is over, and nothing else: the ticket stays where
   * the user left it until the launch that follows links its own session. Rejects when the
   * write fails, as nothing may be launched over a link still in place.
   */
  unlinkTicketSession(projectId: string, ticketId: string): Promise<void>
  /** Rejects when the prompt could not be delivered. */
  sendFollowup(target: { sessionId: string; ticketId: string; prompt: string }): Promise<void>
  /**
   * Queue the "agents may ask" notice for a session whose launch prompt was built under the
   * other setting. Advisory: it never starts or interrupts a turn.
   */
  tellQuestionMode(sessionId: string, interactive: boolean): Promise<void>
  getSessionSignal(sessionId: string): SessionSignal
  /** The last assistant text of an SDK session; null for CLI sessions (the server reads those). */
  readFinalMessage(sessionId: string): Promise<string | null>
  /** The session's row is closed (its tab was closed, its ticket moved back): no signal will come. */
  isSessionClosed(sessionId: string): Promise<boolean>
  /** The session's agent was really started: a live PTY for a CLI, a backend session for an SDK. */
  isSessionStarted(sessionId: string): Promise<boolean>

  // ── Setup script ──
  fireSetupScript(projectId: string, worktreeId: string, cwd: string): void
  isSetupScriptRunning(worktreeId: string): boolean

  // ── Environment ──
  notify(notice: RunnerNotice): void
  /** True when a call failed because the server could not be reached, not because it said no. */
  isTransportError(error: unknown): boolean
  now(): number
  setTimeout(callback: () => void, ms: number): RunnerTimer
  clearTimeout(timer: RunnerTimer): void
  warn(message: string, error?: unknown): void
}

// The WebSocket transport rejects with a plain Error; an RPC the server answered with a
// failure carries the server's error code as `name` instead.
const TRANSPORT_ERROR_PATTERN =
  /WebSocket|RPC client has not been initialized|backend session|transport closed/i

export function isRpcTransportError(error: unknown): boolean {
  return (
    error instanceof Error && error.name === 'Error' && TRANSPORT_ERROR_PATTERN.test(error.message)
  )
}

async function readSdkFinalMessage(sessionId: string): Promise<string | null> {
  const found = await findSessionById(sessionId)
  if (!found || isAgentCli(found.session.agent_sdk)) return null
  const { workingPath, session } = found
  if (!workingPath || !session.opencode_session_id) return null
  const result = unwrapEnvelope(
    await opencodeApi.getMessages(workingPath, session.opencode_session_id)
  )
  if (!result.success) return null
  const messages = mapOpencodeMessagesToSessionViewMessages(result.messages)
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role === 'assistant' && message.content.trim()) return message.content
  }
  return null
}

async function isSessionClosed(sessionId: string): Promise<boolean> {
  const row =
    useSessionStore.getState().getSessionById(sessionId) ??
    (await dbApi.session.get<Session>(sessionId))
  return row?.status === 'completed'
}

async function isSessionStarted(sessionId: string): Promise<boolean> {
  const found = await findSessionById(sessionId)
  if (!found) return false
  if (!isAgentCli(found.session.agent_sdk)) {
    // The backend session is connected one RPC before the launch prompt is sent; the turn
    // recorder writes a row on the `busy` every prompt emits, so a row is the evidence.
    if (!found.session.opencode_session_id) return false
    return (await documentFlowApi.sessionTurn(sessionId)) !== null
  }
  // A CLI session's PTY is keyed by its session id. Asked through the RPC client rather than
  // `terminalApi.getLiveTerminalIds`, which answers an empty list on any error: a failed
  // lookup must surface as a failure, not as "the session never started".
  const live = await getRendererRpcClient().request<{ terminalIds: string[] }>(
    'terminalOps.getLiveTerminalIds',
    {}
  )
  return live.terminalIds.includes(sessionId)
}

/** What the store's connection and the server's `ConnectionWithMembers` both carry. */
interface ConnectionLike {
  id: string
  path: string
  status: 'active' | 'archived'
  members: {
    project_id: string
    worktree_id: string
    worktree_branch: string
    worktree_path: string
  }[]
}

const toRunnerConnection = (connection: ConnectionLike): RunnerConnection => ({
  id: connection.id,
  path: connection.path,
  status: connection.status,
  members: connection.members.map((member) => ({
    project_id: member.project_id,
    worktree_id: member.worktree_id,
    branch_name: member.worktree_branch,
    path: member.worktree_path
  }))
})

/** The store first (it holds what this page created), then the server (another window may have). */
async function getConnection(connectionId: string): Promise<RunnerConnection | null> {
  const loaded = useConnectionStore.getState().connections.find((c) => c.id === connectionId)
  if (loaded) return toRunnerConnection(loaded)
  const result = await connectionApi.get(connectionId)
  return result.success && result.connection ? toRunnerConnection(result.connection) : null
}

async function getSessionConnectionId(sessionId: string): Promise<string | null> {
  const row =
    useSessionStore.getState().getSessionById(sessionId) ??
    (await dbApi.session.get<Session>(sessionId))
  return row?.connection_id ?? null
}

/** The app's default launch: what "Create & Send" would run with. */
export function resolveDefaultLaunchConfig(): DocumentRunLaunchConfig {
  const sdk = resolvePreferredAgentSdk()
  const model = resolveDefaultLaunchModel(sdk)
  return {
    sdk,
    model: {
      providerID: model.providerID,
      modelID: model.modelID,
      ...(model.variant ? { variant: model.variant } : {})
    },
    codexFastMode: useSettingsStore.getState().codexFastMode,
    customProviderId: null
  }
}

/** Back to To Do with nothing of the launch left on it: no session, no worktree, no badge. */
export function resetTicketToTodo(projectId: string, ticketId: string): Promise<void> {
  const store = useKanbanStore.getState()
  return store.updateTicket(ticketId, projectId, {
    column: 'todo',
    sort_order: store.computeSortOrder(store.getTicketsByColumn(projectId, 'todo'), 0),
    current_session_id: null,
    worktree_id: null,
    plan_ready: false,
    mode: null,
    goal_mode: false,
    goal_success_criteria: null,
    model_provider_id: null,
    model_id: null,
    model_variant: null
  })
}

export function createLiveRunnerPorts(): RunnerPorts {
  startSessionSignalLatch()

  return {
    api: documentFlowApi,
    clientId: getRendererClientId(),

    getRuns: () => Object.values(useDocumentFlowStore.getState().runsById),
    getRun: (runId) => useDocumentFlowStore.getState().runsById[runId] ?? null,
    applyDetail: (detail) => useDocumentFlowStore.getState().applyDetail(detail),
    updateItem: (runId, itemId, patch) =>
      useDocumentFlowStore.getState().updateItem(runId, itemId, patch),
    subscribe: (listener) => {
      const stops = [
        useDocumentFlowStore.subscribe((state, previous) => {
          if (state.runsById !== previous.runsById) listener()
        }),
        useWorktreeStatusStore.subscribe((state, previous) => {
          if (
            state.sessionStatuses !== previous.sessionStatuses ||
            state.sessionApiErrors !== previous.sessionApiErrors
          ) {
            listener()
          }
        }),
        useQuestionStore.subscribe((state, previous) => {
          if (state.pendingBySession !== previous.pendingBySession) listener()
        })
      ]
      return () => {
        for (const stop of stops) stop()
      }
    },

    loadProject: async (projectId, memberProjectIds) => {
      await useWorktreeStore.getState().loadWorktrees(projectId)
      if (!useKanbanStore.getState().tickets.has(projectId)) {
        await useKanbanStore.getState().loadTickets(projectId)
      }
      if (memberProjectIds && memberProjectIds.length > 0) {
        // The run's instances are connections over the members' worktrees: both must be in
        // the stores for the launch pipeline to find them, and the server made the
        // integration instance behind this page's back.
        await Promise.all(
          memberProjectIds.map((memberId) => useWorktreeStore.getState().loadWorktrees(memberId))
        )
        await useConnectionStore.getState().loadConnections()
      }
    },
    getTicket: (projectId, ticketId) =>
      useKanbanStore
        .getState()
        .tickets.get(projectId)
        ?.find((ticket) => ticket.id === ticketId) ?? null,
    reloadTickets: async (projectId) => {
      // A fetch that overlaps an optimistic board mutation would clobber it.
      await whenKanbanMutationsSettled(projectId)
      await useKanbanStore.getState().loadTickets(projectId)
    },
    createTicket: (projectId, draft) =>
      useKanbanStore.getState().createTicket(projectId, {
        project_id: projectId,
        title: draft.title,
        description: draft.description,
        column: 'todo',
        parent_ticket_id: draft.parent_ticket_id ?? null
      }),
    moveTicket: (projectId, ticketId, column, options) => {
      const store = useKanbanStore.getState()
      const sortOrder = store.computeSortOrder(store.getTicketsByColumn(projectId, column), 0)
      return store.moveTicket(ticketId, projectId, column, sortOrder, options)
    },
    topSortOrder: (projectId, column) => {
      const store = useKanbanStore.getState()
      return store.computeSortOrder(store.getTicketsByColumn(projectId, column), 0)
    },
    holdTicketForWork: (projectId, ticketId) => {
      const store = useKanbanStore.getState()
      const ticket = store.tickets.get(projectId)?.find((candidate) => candidate.id === ticketId)
      return store.updateTicket(ticketId, projectId, {
        ...(ticket?.column === 'in_progress'
          ? {}
          : {
              column: 'in_progress',
              sort_order: store.computeSortOrder(
                store.getTicketsByColumn(projectId, 'in_progress'),
                0
              )
            }),
        awaiting_completion: true
      })
    },
    buildTicketPrompt: (ticket) => buildTicketPrompt('build', ticket),
    getWorktree: (worktreeId) => {
      for (const worktrees of useWorktreeStore.getState().worktreesByProject.values()) {
        const worktree = worktrees.find((candidate) => candidate.id === worktreeId)
        if (worktree) return worktree
      }
      return null
    },
    reloadWorktrees: (projectId) =>
      useWorktreeStore.getState().loadWorktrees(projectId, { force: true }),
    getConnection,

    getSessionConnectionId,
    resolveDefaultLaunch: resolveDefaultLaunchConfig,
    launchTicket: (spec) => launchTicketWithModel(spec),
    completeOrphanSession: async (sessionId) => {
      await dbApi.session.update(sessionId, {
        status: 'completed',
        completed_at: new Date().toISOString()
      })
      useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'completed')
    },
    closeTicketSession: (projectId, ticketId, sessionId) => {
      const ticket = useKanbanStore
        .getState()
        .tickets.get(projectId)
        ?.find((candidate) => candidate.id === ticketId)
      return closeSessionOfFinishedTicket(
        sessionId,
        ticketId,
        ticket?.column === 'done' ? 'done' : 'merged'
      )
    },
    resetTicketToTodo,
    unlinkTicketSession: (projectId, ticketId) =>
      useKanbanStore.getState().updateTicket(ticketId, projectId, { current_session_id: null }),
    sendFollowup: ({ sessionId, ticketId, prompt }) =>
      // The ticket keeps the model it was launched with; the app's build default must not
      // replace it on a nudge or a conflict prompt.
      sendFollowupToSession({
        sessionId,
        prompt,
        followUpMode: 'build',
        ticketId,
        preserveSessionModel: true,
        cliLead: CLI_FOLLOW_UP_LEAD
      }),
    tellQuestionMode: async (sessionId, interactive) => {
      await tellQuestionMode(sessionId, interactive, { justLaunched: true })
    },
    getSessionSignal,
    readFinalMessage: readSdkFinalMessage,
    isSessionClosed,
    isSessionStarted,

    fireSetupScript,
    isSetupScriptRunning: (worktreeId) =>
      useScriptStore.getState().scriptStates[worktreeId]?.setupRunning ?? false,

    notify: ({ level, message, title }) => {
      toast[level](message)
      // Shown by the main process only while the window is in the background.
      systemApi.showNotification({ title: title ?? 'Document run', body: message }).catch(() => {})
    },
    isTransportError: isRpcTransportError,
    now: () => Date.now(),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (timer) => clearTimeout(timer),
    warn: (message, error) => {
      if (error === undefined) console.warn(`[documentFlow] ${message}`)
      else console.warn(`[documentFlow] ${message}`, error)
    }
  }
}

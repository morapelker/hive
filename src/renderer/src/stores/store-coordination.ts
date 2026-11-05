/**
 * Cross-store coordination helpers.
 *
 * These functions use a registration pattern to break the circular dependency
 * chain between useConnectionStore and useWorktreeStore, while keeping the
 * deconfliction logic synchronous (no microtask delay).
 *
 * Each store registers its "clear selection" callback after creation. The
 * counterpart store calls the registered function synchronously, so both
 * state changes (select one + clear the other) happen in the same tick.
 */

import type { ClaudeCliCompletion } from '@shared/types/claude-cli-stop-completion'

let _clearWorktreeSelection: (() => void) | null = null
let _clearConnectionSelection: (() => void) | null = null

export function registerWorktreeClear(fn: () => void): void {
  _clearWorktreeSelection = fn
}

export function registerConnectionClear(fn: () => void): void {
  _clearConnectionSelection = fn
}

export function clearWorktreeSelection(): void {
  _clearWorktreeSelection?.()
}

export function clearConnectionSelection(): void {
  _clearConnectionSelection?.()
}

// ── Data projects ↔ git projects / worktrees / connections ────────────
// A data project (database connection, useDataProjectStore) is the main-pane content instead of
// a git project, worktree or connection. Selecting any of those clears the data project
// selection through this callback; the data store registers it when its module loads (until
// then nothing can be selected, so a missing callback is a no-op). With table edits staged the
// data project stays on screen until the user chose to discard them or keep editing.
let _clearDataProjectSelection: (() => void) | null = null

export function registerDataProjectClear(fn: () => void): void {
  _clearDataProjectSelection = fn
}

export function clearDataProjectSelection(): void {
  _clearDataProjectSelection?.()
}

// Staged (unsaved) table edits of the open data project live in its view, which unmounts when
// another selection replaces it. Entry points that replace it (a git project, worktree,
// connection, the Pinned Board or board view) run their change through `leaveDataProjectThen`:
// at once, in the same tick, when no data project is open or nothing is staged; otherwise only
// after the user chose to discard the staged edits (never after "Keep editing"). The data store
// registers the guard; it returns true when it took the change over (it asks first).
type DataProjectLeaveGuard = (proceed: () => void) => boolean

let _dataProjectLeaveGuard: DataProjectLeaveGuard | null = null

export function registerDataProjectLeaveGuard(fn: DataProjectLeaveGuard): void {
  _dataProjectLeaveGuard = fn
}

export function leaveDataProjectThen(proceed: () => void): void {
  if (_dataProjectLeaveGuard?.(proceed)) return
  proceed()
}

// ── Kanban ↔ Session coordination ──────────────────────────────────────
// Breaks the circular dependency between useKanbanStore and the stores /
// components that change session status.  The kanban store registers its
// sync callback after creation; callers (worktree-status store, session
// view supercharge handlers) invoke `notifyKanbanSessionSync` without
// importing useKanbanStore.

export interface KanbanSessionEvent {
  type: 'session_completed' | 'session_error' | 'plan_ready' | 'plan_followup' | 'supercharge' | 'mode_change' | 'implement' | 'session_working' | 'status_cleared'
  /** The mode the session was running in — relevant for completed / mode_change events */
  sessionMode?: 'build' | 'plan' | 'super-plan' | 'super-build'
  /** For supercharge: the newly-created session that replaces the old one */
  newSessionId?: string
  /**
   * For session_working: the status change was caused by a user-initiated
   * message send (composer/modal send, or a non-task-notification
   * UserPromptSubmit hook) rather than a status replay or streaming activity.
   * Only explicit sends may pull a ticket out of the terminal done/merged
   * columns.
   */
  explicitSend?: boolean
  /** Tokens consumed during the session — accumulated to the ticket's persistent total */
  tokenDelta?: number
  /**
   * For session_completed from a Claude CLI session: whether the turn ended
   * with a detected completion (Stop with nothing pending), a pause (Stop
   * with background tasks / scheduled wakeups still pending), or no Stop at
   * all. Absent for every other provider — they have no such signal.
   */
  completion?: ClaudeCliCompletion
}

type KanbanSessionSyncFn = (sessionId: string, event: KanbanSessionEvent) => void

let _kanbanSessionSync: KanbanSessionSyncFn | null = null

export function registerKanbanSessionSync(fn: KanbanSessionSyncFn): void {
  _kanbanSessionSync = fn
}

export function notifyKanbanSessionSync(
  sessionId: string,
  event: KanbanSessionEvent
): void {
  _kanbanSessionSync?.(sessionId, event)
}

// ── Kanban ↔ Session: new session created in a worktree ──────────────
type KanbanNewSessionFn = (sessionId: string, worktreeId: string, projectId: string, sessionMode: string) => void

let _kanbanNewSession: KanbanNewSessionFn | null = null

export function registerKanbanNewSession(fn: KanbanNewSessionFn): void {
  _kanbanNewSession = fn
}

export function notifyKanbanNewSession(
  sessionId: string,
  worktreeId: string,
  projectId: string,
  sessionMode: string
): void {
  _kanbanNewSession?.(sessionId, worktreeId, projectId, sessionMode)
}

// ── Kanban ↔ Session: auto-create a ticket from a session's first message ──
// Fired when the user sends the first message in a manually-created session.
// The kanban store decides (setting gate, exclusions, idempotency) whether to
// create a ticket; the renderer resolves project/worktree/mode from the
// session record, so only the prompt text needs to travel here.
export interface KanbanAutoCreateTicketParams {
  sessionId: string
  /** The raw text the user typed (NOT the augmented / mode-prefixed payload). */
  rawPrompt: string
}

type KanbanAutoCreateTicketFn = (params: KanbanAutoCreateTicketParams) => void

let _kanbanAutoCreateTicket: KanbanAutoCreateTicketFn | null = null

export function registerKanbanAutoCreateTicket(fn: KanbanAutoCreateTicketFn): void {
  _kanbanAutoCreateTicket = fn
}

export function notifyKanbanAutoCreateTicket(params: KanbanAutoCreateTicketParams): void {
  _kanbanAutoCreateTicket?.(params)
}

// ── Kanban ↔ Session: session renamed (manual or LLM auto-title) ──────────
// Fired after a session's name is persisted. The kanban store syncs the title
// of the auto-created ticket linked to this session (if the setting is on).
type KanbanRenameSyncFn = (sessionId: string, name: string) => void

let _kanbanRenameSync: KanbanRenameSyncFn | null = null

export function registerKanbanRenameSync(fn: KanbanRenameSyncFn): void {
  _kanbanRenameSync = fn
}

export function notifyKanbanRenameSync(sessionId: string, name: string): void {
  _kanbanRenameSync?.(sessionId, name)
}

// ── Kanban ↔ Session: mid-session model change detected in the CLI ─────────
// Fired after a model change detected from the claude-cli transcript (usage
// limit / safety degradation, /model) is applied to the session store. The
// kanban store syncs the model badge of the ticket linked to this session.
export interface KanbanModelSyncModel {
  modelId: string
  /** Present only when main clamped the effort variant for the new model. */
  modelVariant?: string
}

type KanbanModelSyncFn = (sessionId: string, model: KanbanModelSyncModel) => void

let _kanbanModelSync: KanbanModelSyncFn | null = null

export function registerKanbanModelSync(fn: KanbanModelSyncFn): void {
  _kanbanModelSync = fn
}

export function notifyKanbanModelSync(sessionId: string, model: KanbanModelSyncModel): void {
  _kanbanModelSync?.(sessionId, model)
}

// ── Pinned ↔ Connection: resolve a connection's saved (connection) project ──
// usePinnedStore derives `pinnedProjectIds` from pinned connections too (an
// instance of a connection project pins that project's board onto the pinned
// board). The connection store registers the lookup so the pinned store never
// imports it (useConnectionStore → useKanbanStore → usePinnedStore would cycle).
type ConnectionSavedProjectResolver = (connectionId: string) => string | null | undefined

let _resolveConnectionSavedProjectId: ConnectionSavedProjectResolver | null = null

export function registerConnectionSavedProjectResolver(fn: ConnectionSavedProjectResolver): void {
  _resolveConnectionSavedProjectId = fn
}

/** The connection project a connection is an instance of, or null (ad-hoc / unknown). */
export function resolveConnectionSavedProjectId(connectionId: string): string | null {
  return _resolveConnectionSavedProjectId?.(connectionId) ?? null
}

// ── Kanban ↔ Document flow: tickets in a document run's document edit lane ──
// Once a document run merged a ticket, the run sends that ticket's own session one more
// prompt: update the document the run was made from. The kanban store asks the document flow
// store where a ticket stands in that lane, which registers the lookup. It never imports it:
// useDocumentFlowStore → … → useWorktreeStore → useKanbanStore would cycle.
//   - `updating`: the session is at the edit. The kanban store must not read that session's
//     work as the ticket's (no reopen of the merged ticket, no move to Review).
//   - `queued`: the session is still to be prompted. Its ticket moves as usual, but the
//     session must stay open for the prompt: a move to Merged or Done, an archive or a delete
//     leave it to the run, which closes it once the document is updated.
export type DocumentUpdateLane = 'queued' | 'updating'
type DocumentUpdateLaneFn = (ticketId: string) => DocumentUpdateLane | null

let _documentUpdateLane: DocumentUpdateLaneFn | null = null

export function registerDocumentUpdateLane(fn: DocumentUpdateLaneFn): void {
  _documentUpdateLane = fn
}

/**
 * The ticket's session is at the edit of its document run's document. False until the document
 * flow store registers its lookup: with that store not loaded there are no runs either.
 */
export function isTicketHeldByDocumentUpdate(ticketId: string): boolean {
  return _documentUpdateLane?.(ticketId) === 'updating'
}

/**
 * The ticket's session is still to update, or is updating, its document run's document: the
 * run has one more prompt for it, and closes it once that is over. False until the document
 * flow store registers its lookup.
 */
export function isTicketInDocumentUpdateLane(ticketId: string): boolean {
  return (_documentUpdateLane?.(ticketId) ?? null) !== null
}

// ── Kanban ↔ Document flow: tickets a run is holding ──
// A ticket a run will launch, or is launching this moment, is the run's to start. The kanban
// store asks the document flow store, which registers the lookup, for the same reason as above:
// a new session in the worktree such a ticket was pre-assigned to must not attach to it, or the
// run would later flag the ticket as launched from the board though the user launched nothing.
type TicketRunHoldFn = (ticketId: string) => boolean

let _ticketRunHold: TicketRunHoldFn | null = null

export function registerTicketRunHold(fn: TicketRunHoldFn): void {
  _ticketRunHold = fn
}

/**
 * A run is holding the ticket for its own launch. False until the document flow store registers
 * its lookup: with that store not loaded there are no runs either.
 */
export function isTicketHeldByRun(ticketId: string): boolean {
  return _ticketRunHold?.(ticketId) ?? false
}

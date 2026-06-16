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

// ── Kanban ↔ Session coordination ──────────────────────────────────────
// Breaks the circular dependency between useKanbanStore and the stores /
// components that change session status.  The kanban store registers its
// sync callback after creation; callers (worktree-status store, session
// view supercharge handlers) invoke `notifyKanbanSessionSync` without
// importing useKanbanStore.

export interface KanbanSessionEvent {
  type: 'session_completed' | 'session_error' | 'plan_ready' | 'plan_followup' | 'supercharge' | 'mode_change' | 'implement' | 'session_working'
  /** The mode the session was running in (build / plan) — relevant for completed events */
  sessionMode?: 'build' | 'plan'
  /** For supercharge: the newly-created session that replaces the old one */
  newSessionId?: string
  /** Tokens consumed during the session — accumulated to the ticket's persistent total */
  tokenDelta?: number
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

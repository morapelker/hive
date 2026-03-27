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
  type: 'session_completed' | 'session_error' | 'plan_ready' | 'supercharge' | 'mode_change'
  /** The mode the session was running in (build / plan) — relevant for completed events */
  sessionMode?: 'build' | 'plan'
  /** For supercharge: the newly-created session that replaces the old one */
  newSessionId?: string
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

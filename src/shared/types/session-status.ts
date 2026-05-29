/**
 * The set of session-activity statuses surfaced in the UI (tab badges, worktree
 * indicators, pet) and emitted across the IPC boundary by the Claude CLI hook
 * server. Defined once here so the main process, preload, and renderer share a
 * single source of truth instead of re-declaring the union in three places.
 */
export type SessionStatusType =
  | 'working'
  | 'planning'
  | 'answering'
  | 'permission'
  | 'command_approval'
  | 'unread'
  | 'completed'
  | 'plan_ready'

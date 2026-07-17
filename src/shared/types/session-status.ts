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

// Priority ranking for status aggregation (higher number = higher priority)
export const STATUS_PRIORITY: Record<SessionStatusType, number> = {
  answering: 8,
  command_approval: 7,
  permission: 6,
  planning: 5,
  working: 4,
  plan_ready: 3,
  completed: 2,
  unread: 1
}

export function higherPriority(
  a: SessionStatusType | null,
  b: SessionStatusType | null
): SessionStatusType | null {
  if (!a) return b
  if (!b) return a
  return STATUS_PRIORITY[a] >= STATUS_PRIORITY[b] ? a : b
}

import type { SessionStatusType } from '@shared/types/session-status'

/**
 * Whether a session's current status represents a blocking interaction that a
 * busy/idle stream event must not overwrite. command_approval and permission
 * are preserved unconditionally (their prompts stay mounted until replied);
 * answering is preserved only while a question is actually pending, so a stale
 * status can't stick after the question store has drained.
 */
export function shouldPreserveBlockingSessionStatus(
  currentStatus: SessionStatusType | null | undefined,
  hasPendingQuestion: boolean
): boolean {
  if (currentStatus === 'command_approval' || currentStatus === 'permission') return true
  return currentStatus === 'answering' && hasPendingQuestion
}

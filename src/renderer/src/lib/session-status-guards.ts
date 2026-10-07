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

export interface CliQuestionResolutionCandidate {
  status: SessionStatusType
  hookEventName?: string
  toolName?: string
  reason?: string
}

/**
 * Whether a CLI session status entry is the evidence that the question the
 * session was blocked on got its answer — as opposed to any other
 * answering → working flip (a background subagent's tool hook, a stray
 * optimistic status write, a held question falling back to the terminal).
 *
 * Claude CLI: the PostToolUse (or PostToolUseFailure) hook of the
 * AskUserQuestion tool call, which the main-process interaction ledger only
 * lets through for a question it had latched. Codex: the terminal title
 * dropping its "Action Required" prefix (codex questions fire no usable
 * PostToolUse — see terminal-pty-bridge's handleCodexActionRequired).
 */
export function isCliQuestionResolutionEntry(
  entry: CliQuestionResolutionCandidate | null | undefined
): boolean {
  if (!entry) return false
  if (entry.status !== 'working' && entry.status !== 'planning') return false
  if (entry.reason === 'codex_title_action_resolved') return true
  return (
    (entry.hookEventName === 'PostToolUse' || entry.hookEventName === 'PostToolUseFailure') &&
    entry.toolName === 'AskUserQuestion'
  )
}

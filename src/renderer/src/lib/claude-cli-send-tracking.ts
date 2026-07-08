import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { lastSendMode, messageSendTimes, userExplicitSendTimes } from '@/lib/message-send-times'
import { snapshotTokenBaseline } from '@/lib/token-baselines'

/**
 * Records the send-time / status bookkeeping for a prompt just delivered to a
 * claude-cli session (handoff or background follow-up). The opencode paths do
 * this inline after connect; the CLI paths deliver via the PTY bridge instead
 * and get their status from PTY hook events — but the elapsed ticket timer
 * reads userExplicitSendTimes, which nothing event-driven ever writes. Call
 * this only after delivery succeeds so a failed spawn does not leave the
 * session stuck 'working'.
 */
export function markClaudeCliPromptStarted(sessionId: string): void {
  messageSendTimes.set(sessionId, Date.now())
  userExplicitSendTimes.set(sessionId, Date.now())
  snapshotTokenBaseline(sessionId)
  lastSendMode.set(sessionId, 'build')
  useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'working')
}

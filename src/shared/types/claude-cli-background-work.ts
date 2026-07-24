/**
 * Live background-work counts for a Claude CLI session: how many background
 * shells (Bash with run_in_background) and monitors (Monitor tool) are running
 * right now. Published by the main-process hook server on the dedicated
 * channel below (the status channel dedups by status string, which would
 * swallow count-only changes).
 */
export const CLAUDE_CLI_BACKGROUND_WORK_CHANNEL = 'claude-cli:background-work'

export interface ClaudeCliBackgroundWorkPayload {
  sessionId: string
  runningShells: number
  runningMonitors: number
}

export function isClaudeCliBackgroundWorkPayload(
  value: unknown
): value is ClaudeCliBackgroundWorkPayload {
  if (typeof value !== 'object' || value === null) return false
  const payload = value as Record<string, unknown>
  return (
    typeof payload.sessionId === 'string' &&
    typeof payload.runningShells === 'number' &&
    typeof payload.runningMonitors === 'number'
  )
}

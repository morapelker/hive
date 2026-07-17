// In-memory registry of claude-cli sessions armed for one-shot plan
// auto-approval. The durable flag lives on the kanban ticket
// (auto_approve_plan); the renderer mirrors it here so the hook server can
// answer the ExitPlanMode PermissionRequest without a DB lookup.
const armedSessions = new Set<string>()

export function setClaudeCliPlanAutoApprove(sessionId: string, enabled: boolean): void {
  if (enabled) armedSessions.add(sessionId)
  else armedSessions.delete(sessionId)
}

export function isClaudeCliPlanAutoApproveArmed(sessionId: string): boolean {
  return armedSessions.has(sessionId)
}

/** One-shot consume: disarms the session and reports whether it was armed. */
export function consumeClaudeCliPlanAutoApprove(sessionId: string): boolean {
  return armedSessions.delete(sessionId)
}

export function clearAllClaudeCliPlanAutoApprove(): void {
  armedSessions.clear()
}

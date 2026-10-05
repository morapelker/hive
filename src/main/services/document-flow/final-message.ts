import { isClaudeFamily, isCodexFamily } from '@shared/types/agent-sdk'

// The final assistant message of a session, read without the renderer. The Stop-hook capture
// (`session_final_messages`) is the exact text of the turn that just ended; the transcript and
// the stored messages are what is left when the hook was missed (an app restart mid-turn).

export interface FinalMessageSession {
  agent_sdk: string
  claude_session_id: string | null
  opencode_session_id: string | null
  worktree_id: string | null
}

export interface FinalMessageDeps {
  getRecordedFinalMessage: (sessionId: string) => { text: string } | null
  getSession: (sessionId: string) => FinalMessageSession | null
  getWorktreePath: (worktreeId: string) => string | null
  readClaudeTranscript: (worktreePath: string, claudeSessionId: string) => Promise<unknown[]>
  getSessionMessages: (sessionId: string) => readonly { role: string; content: string }[]
}

/** Content of the last assistant message that has text; tool-only turns are skipped. */
function lastAssistantText(messages: readonly unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (typeof message !== 'object' || message === null) continue
    const { role, content } = message as { role?: unknown; content?: unknown }
    if (role === 'assistant' && typeof content === 'string' && content.trim() !== '') {
      return content
    }
  }
  return null
}

/**
 * The session's final assistant message, or null when none can be found. `worktreePath` is
 * the caller's own idea of where the session runs, used when the session row has no worktree.
 */
export async function resolveSessionFinalMessage(
  input: { sessionId: string; worktreePath?: string | null },
  deps: FinalMessageDeps
): Promise<string | null> {
  const recorded = deps.getRecordedFinalMessage(input.sessionId)?.text
  if (recorded && recorded.trim() !== '') return recorded

  const session = deps.getSession(input.sessionId)
  if (!session) return null

  if (isClaudeFamily(session.agent_sdk)) {
    // The SDK-driven session keeps Claude's own session id in `opencode_session_id`.
    const transcriptId =
      session.claude_session_id ??
      (session.agent_sdk === 'claude-code' ? session.opencode_session_id : null)
    const worktreePath =
      (session.worktree_id ? deps.getWorktreePath(session.worktree_id) : null) ??
      input.worktreePath ??
      null
    if (!transcriptId || !worktreePath) return null
    try {
      return lastAssistantText(await deps.readClaudeTranscript(worktreePath, transcriptId))
    } catch {
      return null
    }
  }

  if (isCodexFamily(session.agent_sdk)) {
    try {
      return lastAssistantText(deps.getSessionMessages(input.sessionId))
    } catch {
      return null
    }
  }

  return null
}

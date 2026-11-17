// "A Claude account's organization was just stored" and "organizations are needed", between the
// two processes that deal with them.
//
// Organizations are learned where the accounts' credentials are used: in the server child, by
// the usage poll (saved-usage-orchestrator.ts) and by the learner for the accounts the poll did
// not teach (claude-organization-learner.ts). The live usage updater that waits for them lives in
// the Electron main process (claude-api-proxy/claude-usage-live.ts). So:
//   - "learned" goes child -> main, the way a usage poll does (claude-usage-poll-signal.ts):
//     inside the child, `setClaudeOrganizationLearnedPublisher` (installed by server.ts) forwards
//     the email to main as the `claudeOrganizationLearned` desktop command; inside main there is
//     no publisher and the listeners hear it directly;
//   - "needed" goes main -> child as a backend event on CLAUDE_ORGANIZATIONS_NEEDED_CHANNEL.
// Only the email travels; the organization stays in the database, where main reads it.
// Nothing here may throw into the code that learned the organization.

/** Backend event main publishes when a live reading names an organization no account maps to. */
export const CLAUDE_ORGANIZATIONS_NEEDED_CHANNEL = 'usage:claudeOrganizationsNeeded'

export type ClaudeOrganizationLearnedPublisher = (email: string) => void | Promise<void>
export type ClaudeOrganizationLearnedListener = (email: string) => void

let publisher: ClaudeOrganizationLearnedPublisher | null = null
const listeners = new Set<ClaudeOrganizationLearnedListener>()

/** The server child registers how the signal reaches main; `null` (main itself) delivers in-process. */
export const setClaudeOrganizationLearnedPublisher = (
  next: ClaudeOrganizationLearnedPublisher | null
): void => {
  publisher = next
}

/** Hear every stored organization main learns about. Returns the unsubscribe. */
export const subscribeClaudeOrganizationLearned = (
  listener: ClaudeOrganizationLearnedListener
): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Main's end: the organization of `email` was stored, here or in the child. */
export const receiveClaudeOrganizationLearned = (email: string): void => {
  for (const listener of [...listeners]) {
    try {
      listener(email)
    } catch {
      // One listener's trouble is not the next one's, and never the learner's.
    }
  }
}

/** Called where an account's organization has just been stored. Never throws. */
export const emitClaudeOrganizationLearned = (email: string): void => {
  if (!email) return
  try {
    if (publisher) {
      void Promise.resolve(publisher(email)).catch(() => undefined)
      return
    }
    receiveClaudeOrganizationLearned(email)
  } catch {
    // Best-effort: main re-checks the readings it holds every second anyway.
  }
}

/** Tests only. */
export const __resetClaudeOrganizationSignalForTests = (): void => {
  publisher = null
  listeners.clear()
}

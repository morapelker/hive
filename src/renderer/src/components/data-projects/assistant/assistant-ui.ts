// Non-component helpers of the assistant panel (kept out of the .tsx files so React fast
// refresh keeps working on them): example prompts per engine and the header's status line.

import type { DataEngine } from '@shared/data-projects/types'
import type { AssistantConversation } from '@/stores/useDataAssistantStore'

/** Elapsed seconds appear once a run has taken this long. */
export const ELAPSED_AFTER_SECONDS = 3

/** Three starting points for an empty conversation, phrased for the engine. */
export function assistantExamplePrompts(engine: DataEngine): string[] {
  switch (engine) {
    case 'mongodb':
      return [
        'Documents created since yesterday in the orders collection',
        'Describe the fields of the biggest collection',
        'Turn the query in the editor into an aggregation grouped by status'
      ]
    case 'clickhouse':
      return [
        'Rows per day for the last 7 days in the biggest table',
        'Which tables have the most rows, and what are their sorting keys?',
        'Explain and speed up the query in the editor'
      ]
    case 'sqlite':
      return [
        'Rows added since yesterday in the most recently used table',
        'Which tables reference each other through foreign keys?',
        'Fix the query in the editor'
      ]
    default:
      return [
        'Orders created since yesterday, newest first',
        'Which tables reference users, and through which columns?',
        'Explain or fix the query in the editor'
      ]
  }
}

/** The header's one-line status. */
export function assistantStatusLine(
  conversation: Pick<AssistantConversation, 'status' | 'activity' | 'error'>,
  elapsedSeconds: number
): string {
  if (conversation.status === 'cancelling') return 'Stopping…'
  if (conversation.status === 'running') {
    const base = conversation.activity ?? 'Thinking…'
    return elapsedSeconds >= ELAPSED_AFTER_SECONDS ? `${base} · ${elapsedSeconds}s` : base
  }
  if (conversation.error) return 'Something went wrong'
  return 'Ready'
}

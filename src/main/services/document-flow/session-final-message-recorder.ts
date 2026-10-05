import { getDatabase } from '../../db'
import { createLogger } from '../logger'
import type { SessionFinalMessageUpsert } from './db-port'

const log = createLogger({ component: 'SessionFinalMessage' })

/**
 * Persist what a session's main agent was last seen doing: its turn ended (with the final
 * message), it stopped for the user, or it got back to work. Turn status otherwise lives only
 * in renderer memory, so a document run resumed after a reload or a restart reads this row to
 * learn what happened while nobody was watching. Called from the hook pipeline and the SDK
 * stream: a failed write is logged and never thrown.
 */
export function recordSessionFinalMessage(input: SessionFinalMessageUpsert): void {
  try {
    getDatabase().upsertSessionFinalMessage(input)
  } catch (error) {
    log.warn('Failed to record a session final message', {
      sessionId: input.session_id,
      hookEvent: input.hook_event,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

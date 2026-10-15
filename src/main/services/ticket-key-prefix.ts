// Keeps the ticket-key prefix (TD in TD-12) in the database in step with the signed-in session.
//
// The prefix comes from the signed-in user's email domain (shared/ticket-key.ts), which only
// the renderer knows; it reaches main inside the session context the shell pushes. The first
// organisation to sign in on a machine names the keys for good (the boards are shared across
// organisations and app instances), so later sessions only stamp tickets that have no prefix
// yet — those created before the first sign-in, including by the server child, which has no
// session of its own and reads the prefix from the settings table when it inserts a ticket.
import { getDatabase } from '../db'
import { ticketKeyPrefixFromSession } from '@shared/ticket-key'
import { createLogger } from './logger'
import {
  getDevSessionProvider,
  type DevSessionProvider,
  type DevSessionSnapshot
} from './tedooo-dev-session'

const log = createLogger({ component: 'TicketKeyPrefix' })

export interface TicketKeyPrefixSyncDeps {
  provider?: DevSessionProvider | null
  ensurePrefix?: (prefix: string) => string
}

/** The prefix a session snapshot asks for, null when it carries no organisation. */
export function prefixForSnapshot(snapshot: DevSessionSnapshot): string | null {
  const context = snapshot.context
  if (!context?.orgId) return null
  return ticketKeyPrefixFromSession(context.email, context.orgName)
}

/**
 * Applies the current session once and then follows every change. Returns the stop function.
 * Not hosted (no provider): nothing to do.
 */
export function startTicketKeyPrefixSync(deps: TicketKeyPrefixSyncDeps = {}): () => void {
  const provider = deps.provider === undefined ? getDevSessionProvider() : deps.provider
  if (!provider) return () => undefined
  const ensurePrefix = deps.ensurePrefix ?? ((prefix) => getDatabase().ensureTicketKeyPrefix(prefix))
  let lastApplied: string | null = null

  const apply = (snapshot: DevSessionSnapshot): void => {
    const prefix = prefixForSnapshot(snapshot)
    if (!prefix || prefix === lastApplied) return
    try {
      const effective = ensurePrefix(prefix)
      lastApplied = prefix
      if (effective !== prefix) {
        log.info('Ticket keys keep the prefix of the first organisation on this machine', {
          stored: effective,
          derived: prefix
        })
      }
    } catch (error) {
      log.warn('Could not record the ticket key prefix', {
        prefix,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  apply(provider.get())
  return provider.subscribe(apply)
}

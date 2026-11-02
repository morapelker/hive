// Keeps the ticket-key prefix (the HV in HV-12) in the database. Tedooo Code derives it from the
// signed-in organisation; Hive has no sign-in, so the prefix comes from the git identity on this
// machine — the organisation label of `user.email`, else `user.name` — and falls back to "HIVE".
// The first prefix stamped on a machine names the keys for good (ensureTicketKeyPrefix keeps the
// stored one), and the tickets created before it get that prefix then.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getDatabase } from '../db'
import { ticketKeyPrefixFromSession } from '@shared/ticket-key'
import { createLogger } from './logger'

const log = createLogger({ component: 'TicketKeyPrefix' })
const execFileAsync = promisify(execFile)

export const DEFAULT_TICKET_KEY_PREFIX = 'HIVE'

export interface GitIdentity {
  email: string | null
  name: string | null
}

export interface TicketKeyPrefixDeps {
  readIdentity?: () => Promise<GitIdentity>
  ensurePrefix?: (prefix: string) => string
}

/** The global git identity, each half null when unset or git is unavailable. */
export async function readGitIdentity(): Promise<GitIdentity> {
  const read = async (key: string): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync('git', ['config', '--global', '--get', key], {
        timeout: 5_000
      })
      const value = stdout.trim()
      return value.length > 0 ? value : null
    } catch {
      return null
    }
  }
  const [email, name] = await Promise.all([read('user.email'), read('user.name')])
  return { email, name }
}

/** The prefix an identity asks for: the email's organisation label, else the name, else HIVE. */
export function prefixForIdentity(identity: GitIdentity): string {
  return ticketKeyPrefixFromSession(identity.email, identity.name) ?? DEFAULT_TICKET_KEY_PREFIX
}

/**
 * Stamps the prefix once (at server start). Returns the effective prefix — the one already
 * stored on this machine wins — or null when the database refused.
 */
export async function ensureTicketKeyPrefixFromIdentity(
  deps: TicketKeyPrefixDeps = {}
): Promise<string | null> {
  const identity = await (deps.readIdentity ?? readGitIdentity)()
  const prefix = prefixForIdentity(identity)
  const ensurePrefix = deps.ensurePrefix ?? ((value) => getDatabase().ensureTicketKeyPrefix(value))
  try {
    const effective = ensurePrefix(prefix)
    if (effective !== prefix) {
      log.info('Ticket keys keep the prefix first stamped on this machine', {
        stored: effective,
        derived: prefix
      })
    }
    return effective
  } catch (error) {
    log.warn('Could not record the ticket key prefix', {
      prefix,
      error: error instanceof Error ? error.message : String(error)
    })
    return null
  }
}

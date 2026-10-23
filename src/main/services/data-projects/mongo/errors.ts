// MongoDB errors → DataDriverError: codeName as the code, validation details (errInfo) as the
// detail, a hint for the errors users can act on (timeouts, auth, unreachable server), and the
// `cancelled` flag for operations the user stopped. Every message goes through the project's
// redactor (known secrets, user:pass@ in URLs) before it leaves this module.

import { DataDriverError } from '../contracts'
import { relaxedText } from './runtime'

const SERVER_SELECTION_HINT =
  'Check the host and port, TLS settings, replica set name / directConnection, and that the server is reachable from this Mac.'

/** Server codes meaning "the operation was killed" (killOp, killSessions, client disconnect). */
const INTERRUPTED_CODES = new Set([11601, 11600, 11602, 237, 262])

interface MongoLikeError {
  name?: string
  message?: string
  code?: number | string
  codeName?: string
  errInfo?: unknown
  errorResponse?: { errmsg?: string }
}

export function cancelledError(): DataDriverError {
  return new DataDriverError('Query cancelled', { cancelled: true, code: 'Cancelled' })
}

export function toMongoDriverError(
  error: unknown,
  redact: (text: string) => string,
  context: { cancelled?: boolean; timeoutMs?: number | null } = {}
): DataDriverError {
  if (error instanceof DataDriverError) {
    const message = redact(error.message)
    if (message === error.message) return error
    return new DataDriverError(message, {
      code: error.code,
      position: error.position,
      hint: error.hint,
      detail: error.detail ? redact(error.detail) : undefined,
      sandboxRejected: error.sandboxRejected,
      cancelled: error.cancelled
    })
  }
  const e = (error ?? {}) as MongoLikeError
  const name = typeof e.name === 'string' ? e.name : 'Error'
  const numericCode = typeof e.code === 'number' ? e.code : undefined
  const rawMessage = typeof e.message === 'string' && e.message ? e.message : String(error)
  // Interrupted codes only mean "cancelled" when we cancelled: an admin's killOp elsewhere keeps
  // the server's own message.
  if (context.cancelled || name === 'AbortError') return cancelledError()
  if (numericCode !== undefined && INTERRUPTED_CODES.has(numericCode)) {
    return new DataDriverError(redact(rawMessage), {
      code: e.codeName ?? String(numericCode),
      hint: 'The operation was killed on the server (killOp, session end or shutdown).'
    })
  }
  const code =
    e.codeName ??
    (numericCode !== undefined ? String(numericCode) : typeof e.code === 'string' ? e.code : name)
  let hint: string | undefined
  if (numericCode === 50 || e.codeName === 'MaxTimeMSExpired') {
    hint = context.timeoutMs
      ? `The server stopped it after maxTimeMS ${context.timeoutMs} ms. Add .maxTimeMS(<ms>) or raise the query timeout in the connection settings.`
      : 'The server stopped it after its maxTimeMS. Add .maxTimeMS(<ms>) to allow more time.'
  } else if (numericCode === 13 || e.codeName === 'Unauthorized') {
    hint = 'The connected user lacks the privileges for this operation.'
  } else if (numericCode === 18 || e.codeName === 'AuthenticationFailed') {
    hint = 'Check the user name, password, authSource and authMechanism.'
  } else if (name === 'MongoServerSelectionError' || name === 'MongoTopologyClosedError') {
    hint = SERVER_SELECTION_HINT
  } else if (name === 'MongoNetworkError' || name === 'MongoNetworkTimeoutError') {
    hint = 'The connection to the server was lost. Reconnect and try again.'
  }
  const detail = e.errInfo !== undefined ? redact(relaxedSafe(e.errInfo)) : undefined
  return new DataDriverError(redact(rawMessage), { code, hint, detail })
}

function relaxedSafe(value: unknown): string {
  try {
    return relaxedText(value, 4000)
  } catch {
    try {
      return JSON.stringify(value).slice(0, 4000)
    } catch {
      return String(value)
    }
  }
}

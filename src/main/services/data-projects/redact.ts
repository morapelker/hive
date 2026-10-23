// What may leave the data-projects engine: every driver error, status message and log line goes
// through `redactSecrets` before it reaches the renderer, the history table or the log file.
// Drivers echo surprisingly much (mysql2 "Access denied for user 'u'@'h' (using password: YES)",
// URI parse errors that print the whole URI, ssh2 auth failures), so the rule is blunt: replace
// every known secret of the project (exact substring, also URL-encoded) and any
// `scheme://user:pass@` userinfo, whatever the text looks like.
//
// Also home of `DataEngineError`: an RpcRouteError whose code is a DATA_ERROR_CODES value, so it
// crosses the RPC boundary with its code intact (toRpcError keeps RpcRouteError codes; any other
// Error becomes INTERNAL_ERROR) and the renderer sees the code as `error.name`.

import { DATA_ERROR_CODES, type DataErrorCode } from '../../../shared/data-projects/types'
import { RpcRouteError } from '../../../shared/rpc/errors'

const MASK = '***'

/** Secrets shorter than this are only masked as whole tokens (masking every "a" helps no one). */
const SHORT_SECRET = 4

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `scheme://user:password@host` → `scheme://user:***@host`; also `//:password@`. */
export function redactUrlCredentials(text: string): string {
  // Userinfo cannot contain '/', '@' or whitespace unencoded; the password part is greedy up to
  // the LAST '@' before the host so passwords with a raw '@' are still fully covered. A scheme
  // only starts after a non-scheme character: without that, every position inside a long word
  // (a hex or base64 blob echoed in an error) would rescan the rest of it, quadratically.
  return text.replace(
    /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]*):([^\s/]*)@(?=[^\s@/]*(?:[/?#\s]|$))/gi,
    (_m, scheme: string, user: string) => `${scheme}${user}:${MASK}@`
  )
}

/** Masks `password=...` style key/values (libpq DSNs, JDBC/ODBC strings, driver option dumps). */
const SECRET_KEYS =
  'password|passwd|pwd|pass|sslpassword|passphrase|secret|token|tlsCertificateKeyFilePassword'

function redactKeyValueSecrets(text: string): string {
  return (
    text
      // key=value (libpq DSN, JDBC/ODBC, URL query). "using password: YES" is left alone.
      .replace(
        new RegExp(`\\b(${SECRET_KEYS})(\\s*=\\s*)("[^"]*"|'[^']*'|[^\\s&;,'"]+)`, 'gi'),
        (_m, key: string, sep: string) => `${key}${sep}${MASK}`
      )
      // "key": "value" (JSON-ish option dumps)
      .replace(
        new RegExp(`(["']?)(${SECRET_KEYS})\\1(\\s*:\\s*)("[^"]*"|'[^']*')`, 'gi'),
        (_m, q: string, key: string, sep: string) => `${q}${key}${q}${sep}"${MASK}"`
      )
  )
}

/**
 * Masks every known secret (exact substring and its percent-encoded form), URL userinfo and
 * `password=` pairs. Longer secrets first so a secret that contains another is fully masked.
 */
export function redactSecrets(text: string, knownSecrets: readonly string[] = []): string {
  if (!text) return text
  let out = text
  const variants = new Set<string>()
  for (const secret of knownSecrets) {
    if (typeof secret !== 'string' || secret.length === 0) continue
    variants.add(secret)
    try {
      const encoded = encodeURIComponent(secret)
      if (encoded !== secret) variants.add(encoded)
    } catch {
      // Lone surrogates cannot be encoded; the raw form is still masked.
    }
  }
  const sorted = [...variants].sort((a, b) => b.length - a.length)
  for (const secret of sorted) {
    if (secret.length >= SHORT_SECRET) {
      out = out.split(secret).join(MASK)
    } else {
      // Whole-token match only: delimited by start/end, whitespace, quotes or punctuation.
      const re = new RegExp(
        `(^|[\\s'"\`:=@/(),;])${escapeRegExp(secret)}(?=$|[\\s'"\`@/(),;:])`,
        'g'
      )
      out = out.replace(re, (_m, lead: string) => `${lead}${MASK}`)
    }
  }
  return redactKeyValueSecrets(redactUrlCredentials(out))
}

/** A redactor bound to a live list of secrets (the list may change after a re-auth). */
export function createRedactor(getSecrets: () => readonly string[]): (text: string) => string {
  return (text: string) => redactSecrets(text, getSecrets())
}

/** The non-empty secret strings of a DataSecrets-like object. */
export function secretValues(secrets: Record<string, unknown> | null | undefined): string[] {
  if (!secrets) return []
  return Object.values(secrets).filter((v): v is string => typeof v === 'string' && v.length > 0)
}

/** Message of anything thrown, redacted, never empty. */
export function errorMessage(error: unknown, redact: (text: string) => string = (t) => t): string {
  // AggregateError (net.connect to "localhost" trying ::1 then 127.0.0.1) has an empty message.
  if (error instanceof AggregateError && !error.message && error.errors.length > 0) {
    return errorMessage(error.errors[0], redact)
  }
  let message: string
  if (error instanceof Error) message = error.message || error.name || 'Unknown error'
  else if (typeof error === 'string') message = error
  else if (
    error &&
    typeof error === 'object' &&
    typeof (error as { message?: unknown }).message === 'string'
  )
    message = (error as { message: string }).message
  else message = 'Unknown error'
  return redact(message) || 'Unknown error'
}

// ---------------------------------------------------------------------------------------------
// Coded errors for the RPC layer
// ---------------------------------------------------------------------------------------------

/**
 * An error whose `name` and `code` are a DATA_ERROR_CODES value. The RPC domain turns it into
 * an RpcRouteError with that code; the renderer reads it as `error.name`. The message must
 * already be redacted.
 */
export class DataEngineError extends RpcRouteError {
  declare readonly code: DataErrorCode

  constructor(code: DataErrorCode, message: string, details?: unknown) {
    super(code, message, details)
    this.name = code
  }
}

export const isDataEngineError = (error: unknown): error is DataEngineError =>
  error instanceof DataEngineError ||
  (error instanceof Error &&
    typeof (error as { code?: unknown }).code === 'string' &&
    (Object.values(DATA_ERROR_CODES) as string[]).includes(
      (error as unknown as { code: string }).code
    ))

export const notFoundError = (what = 'Data project'): DataEngineError =>
  new DataEngineError(DATA_ERROR_CODES.notFound, `${what} not found`)

export const credentialsRequiredError = (message?: string): DataEngineError =>
  new DataEngineError(
    DATA_ERROR_CODES.credentialsRequired,
    message ?? 'The password for this connection is not available. Enter it to connect.'
  )

export const invalidInputError = (message: string): DataEngineError =>
  new DataEngineError(DATA_ERROR_CODES.invalidInput, message)

export const unsupportedError = (message: string): DataEngineError =>
  new DataEngineError(DATA_ERROR_CODES.unsupported, message)

export const forbiddenError = (message: string): DataEngineError =>
  new DataEngineError(DATA_ERROR_CODES.forbidden, message)

export const busyError = (message: string): DataEngineError =>
  new DataEngineError(DATA_ERROR_CODES.busy, message)

export const connectionFailedError = (message: string): DataEngineError =>
  new DataEngineError(DATA_ERROR_CODES.connectionFailed, message)

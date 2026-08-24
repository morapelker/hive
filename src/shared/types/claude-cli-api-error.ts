/**
 * A Claude CLI turn that ended with an API error: claude-cli fires a
 * `StopFailure` hook instead of `Stop`, carrying a structured error
 * classification. Published by the main-process hook server on the dedicated
 * channel below (the status channel dedups by status string, which could
 * swallow the error when a synthetic 'completed' was already published).
 */
export const CLAUDE_CLI_API_ERROR_CHANNEL = 'claude-cli:api-error'

/**
 * Documented StopFailure `error` values: rate_limit, overloaded,
 * authentication_failed, oauth_org_not_allowed, billing_error,
 * invalid_request, model_not_found, server_error, max_output_tokens, unknown.
 * Kept as a plain string so new classifications flow through untouched.
 */
export interface ClaudeCliApiErrorPayload {
  sessionId: string
  error: string
  errorDetails?: string
  /** Rendered failure text, e.g. "API Error: 500 Internal server error…". */
  lastAssistantMessage?: string
}

export function isClaudeCliApiErrorPayload(value: unknown): value is ClaudeCliApiErrorPayload {
  if (typeof value !== 'object' || value === null) return false
  const payload = value as Record<string, unknown>
  return (
    typeof payload.sessionId === 'string' &&
    typeof payload.error === 'string' &&
    (payload.errorDetails === undefined || typeof payload.errorDetails === 'string') &&
    (payload.lastAssistantMessage === undefined || typeof payload.lastAssistantMessage === 'string')
  )
}

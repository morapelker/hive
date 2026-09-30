import {
  describeOpenCodeSessionError,
  type OpenCodeSessionErrorPayload
} from '@shared/opencode-session-error'

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Human-readable message for a `session.error` stream event's payload. */
export function extractSessionErrorMessage(data: unknown): string {
  if (typeof data === 'string') return data

  const record = asRecord(data)
  if (!record) return 'OpenCode session failed'

  const nestedError = asRecord(record.error)
  const nestedData = asRecord(record.data)

  // OpenCode puts the real text in error.data.message and leaves error.message
  // unset, so without this the banner degrades to a bare "UnknownError".
  if (nestedError && asString(asRecord(nestedError.data)?.message)) {
    return describeOpenCodeSessionError(nestedError as OpenCodeSessionErrorPayload)
  }

  return (
    asString(nestedError?.message) ||
    asString(nestedError?.name) ||
    asString(nestedData?.message) ||
    asString(record.message) ||
    asString(record.error) ||
    'OpenCode session failed'
  )
}

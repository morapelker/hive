import { Cause, Option } from 'effect'

/**
 * Normalize an unknown thrown value into a proper Error instance.
 */
export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export interface CauseEnvelope {
  readonly errorCode: string
  readonly error: string
  readonly details?: unknown
}

const isJsonPrimitive = (value: unknown): value is string | number | boolean | null =>
  value === null ||
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'boolean'

const toSerializable = (value: unknown): unknown => {
  if (isJsonPrimitive(value)) {
    return typeof value === 'number' && !Number.isFinite(value) ? null : value
  }
  if (Array.isArray(value)) {
    return value.map(toSerializable).filter((item) => item !== undefined)
  }
  if (typeof value !== 'object' || value === null) return undefined

  const entries = Object.entries(value)
    .map(([key, entryValue]) => [key, toSerializable(entryValue)] as const)
    .filter(([, entryValue]) => entryValue !== undefined)

  if (entries.length === 0) return undefined
  return Object.fromEntries(entries)
}

const serializableFields = (error: unknown): Record<string, unknown> | undefined => {
  if (typeof error !== 'object' || error === null) return undefined

  const entries = Object.entries(error)
    .filter(([key]) => key !== '_tag' && key !== 'message')
    .map(([key, value]) => [key, toSerializable(value)] as const)
    .filter(([, value]) => value !== undefined)

  if (entries.length === 0) return undefined
  return Object.fromEntries(entries)
}

export const fromCause = <E>(
  cause: Cause.Cause<E>,
  options?: { humanize?: (error: E) => string }
): CauseEnvelope => {
  const failure = Cause.failureOption(cause)
  if (Option.isSome(failure)) {
    const error = failure.value
    const tag = (error as { _tag?: string })._tag ?? 'UnknownError'
    const message =
      options?.humanize?.(error) ?? (error instanceof Error ? error.message : String(error))
    const details = serializableFields(error)

    return { errorCode: tag, error: message, details }
  }

  return {
    errorCode: 'UnexpectedDefect',
    error: Cause.pretty(cause),
    details: undefined
  }
}

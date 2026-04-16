/**
 * Normalize an unknown thrown value into a proper Error instance.
 */
export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

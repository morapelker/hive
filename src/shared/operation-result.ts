/** The `{ success, error? }` shape most of Hive's operations return. */
export interface OperationResult {
  success: boolean
  error?: string
}

/**
 * Turn a failed operation result into a thrown error, for multi step flows that
 * should stop at the first failure rather than check every return value.
 */
export function requireSuccess(result: OperationResult, fallback: string): void {
  if (!result.success) throw new Error(result.error || fallback)
}

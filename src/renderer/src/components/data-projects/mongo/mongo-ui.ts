// Small helpers shared by the Mongo workspace components: ids, error text (and the credentials
// prompt when the server says the password is missing), number/size formatting, and the gated
// call wrapper that turns a `runWithConfirmation` outcome into one of four plain results.

import type { DataExecutionPlan, DataProject } from '@shared/data-projects/types'
import {
  errorMessage,
  isCredentialsRequiredError
} from '@/components/data-projects/data-project-ui'
import { runWithConfirmation } from '@/components/data-projects/shared'
import { useDataProjectStore } from '@/stores/useDataProjectStore'

export const newQueryId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

/** True for errors caused by the user's cancel (server: "Query cancelled", code Cancelled). */
export function isCancelError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const name = (error as { name?: unknown }).name
  const message = (error as { message?: unknown }).message
  return (
    name === 'Cancelled' ||
    name === 'AbortError' ||
    (typeof message === 'string' && /^(query|operation) (was )?cancell?ed/i.test(message))
  )
}

/**
 * The message to show for a failed call. A DATA_CREDENTIALS_REQUIRED error also opens the
 * credentials prompt (the connection lost its password), so the user can fix it in place.
 */
export function mongoErrorText(
  project: Pick<DataProject, 'id'>,
  error: unknown,
  fallback: string
): string {
  const message = errorMessage(error, fallback)
  if (isCredentialsRequiredError(error)) {
    try {
      useDataProjectStore.getState().openCredentialsPrompt(project.id, message)
    } catch {
      // The prompt is a convenience; the message below still explains what happened.
    }
  }
  return message
}

const nf = new Intl.NumberFormat('en-US')
export const formatCount = (n: number | null | undefined): string =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : nf.format(n)

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB', 'PB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

export const formatDuration = (ms: number | null | undefined): string =>
  ms === null || ms === undefined
    ? ''
    : ms < 1000
      ? `${Math.round(ms)} ms`
      : `${(ms / 1000).toFixed(2)} s`

/** Badge text per collection type from the explorer listing (DataObjectInfo.engine). */
export const COLLECTION_TYPE_BADGE: Readonly<Record<string, string>> = {
  view: 'view',
  timeseries: 'time-series',
  capped: 'capped'
}

export const isReadOnlyCollectionType = (type: string | undefined): boolean => type === 'view'

type GatedResponse =
  | { status: 'ok' }
  | { status: 'confirmation_required'; plan: DataExecutionPlan; confirmToken: string }
  | { status: 'blocked'; plan: DataExecutionPlan; reason: string }
  | { status: 'cancelled' }

export type GatedOutcome<R> =
  | { kind: 'ok'; response: Extract<R, { status: 'ok' }> }
  | { kind: 'declined' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string }

/**
 * Runs a gated Mongo call (writes, index/collection changes, $out pipelines): the safe mode may
 * answer `confirmation_required`, then the shared confirm dialog asks and the call is re-sent
 * with the token. Errors are caught and returned as text so every caller handles them alike.
 */
export async function runGated<R extends GatedResponse>(
  project: Pick<DataProject, 'id'>,
  call: (confirmToken?: string) => Promise<R>,
  fallback: string
): Promise<GatedOutcome<R>> {
  try {
    const result = (await runWithConfirmation(call)) as R | { status: 'declined' }
    switch (result.status) {
      case 'ok':
        return { kind: 'ok', response: result as Extract<R, { status: 'ok' }> }
      case 'declined':
        return { kind: 'declined' }
      case 'blocked':
        return { kind: 'blocked', reason: (result as { reason: string }).reason }
      case 'cancelled':
        return { kind: 'cancelled' }
      default:
        // A confirmation_required that came back after confirming would be a server bug.
        return { kind: 'error', message: 'The server asked for confirmation again; nothing ran' }
    }
  } catch (error) {
    return { kind: 'error', message: mongoErrorText(project, error, fallback) }
  }
}

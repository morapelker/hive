// Saving results to files.
// - Visible results (what the grid holds) are formatted in the renderer and written through the
//   native save dialog (`dataProjectsApi.saveTextFile`).
// - Full exports (a whole table / query / collection, no auto-limit, no hard cap) stream on the
//   server (`dataProjectsApi.exportStart`); a query export goes through the same safety gate as a
//   run, so it is wrapped in `runWithConfirmation`. Progress arrives as `dataProjects:export`
//   events and is shown in a toast with a Cancel action (created on the first progress event,
//   i.e. after the native save dialog closed).

import type {
  DataCell,
  DataColumnMeta,
  DataExportFormat,
  DataExportRequest,
  DataExportResponse,
  SqlDialect
} from '@shared/data-projects/types'
import { dataProjectsApi } from '@/api/data-projects-api'
import { errorMessage } from '@/components/data-projects/data-project-ui'
import {
  formatRows,
  type CopyFormat,
  type SqlInsertOptions
} from '@/components/data-projects/grid/export-format'
import { toast } from '@/lib/toast'
import { runWithConfirmation, type DeclinedResponse } from './confirm'
import { formatBytes, formatCount, safeFileStem } from './format-utils'

const EXTENSIONS: Record<CopyFormat, string> = {
  csv: 'csv',
  tsv: 'tsv',
  json: 'json',
  sql: 'sql',
  markdown: 'md'
}

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path

/** Saves the given rows (already loaded) as a file. Returns the path, or null when cancelled. */
export async function saveVisibleResults(
  columns: DataColumnMeta[],
  rows: DataCell[][],
  format: CopyFormat,
  name: string,
  options: { dialect?: SqlDialect; table?: SqlInsertOptions['table'] } = {}
): Promise<string | null> {
  const ext = EXTENSIONS[format]
  try {
    const content = formatRows(format, columns, rows, { ...options, header: true })
    const { filePath } = await dataProjectsApi.saveTextFile(
      `${safeFileStem(name)}.${ext}`,
      content,
      [ext]
    )
    if (filePath) {
      toast.success(
        `Saved ${formatCount(rows.length)} ${rows.length === 1 ? 'row' : 'rows'} to ${baseName(filePath)}`
      )
    }
    return filePath
  } catch (error) {
    toast.error(`Could not save the file: ${errorMessage(error)}`)
    return null
  }
}

const newExportId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `export-${Date.now()}-${Math.random().toString(36).slice(2)}`

export type FullExportInput = Omit<DataExportRequest, 'exportId' | 'confirmToken'>

/**
 * Streams a full export to a file chosen in the native save dialog, with a progress toast and
 * Cancel. Resolves with the final response (null when the request failed: already toasted).
 */
export async function startFullExport(
  input: FullExportInput
): Promise<DataExportResponse | DeclinedResponse | null> {
  const exportId = newExportId()
  let toastId: string | number | undefined
  const what = input.format === 'csv' ? 'CSV' : input.format === 'json' ? 'JSON' : 'SQL'
  const cancelAction = {
    label: 'Cancel',
    onClick: () => {
      void dataProjectsApi.exportCancel(exportId).catch(() => undefined)
    }
  }
  const unsubscribe = dataProjectsApi.onExportProgress((event) => {
    if (event.exportId !== exportId || event.done) return
    const text = `Exporting ${what}… ${formatCount(event.rows)} rows · ${formatBytes(event.bytes)}`
    toastId = toast.loading(text, {
      ...(toastId !== undefined ? { id: toastId } : {}),
      action: cancelAction
    })
  })
  try {
    const response = await runWithConfirmation<DataExportResponse>((confirmToken) =>
      dataProjectsApi.exportStart({ ...input, exportId, ...(confirmToken ? { confirmToken } : {}) })
    )
    const opts = toastId !== undefined ? { id: toastId } : {}
    switch (response.status) {
      case 'ok':
        toast.success(
          `Exported ${formatCount(response.rows)} rows (${formatBytes(response.bytes)}) to ${baseName(response.filePath)}`,
          { ...opts, action: undefined }
        )
        break
      case 'cancelled':
        if (toastId !== undefined) toast.info('Export cancelled', { ...opts, action: undefined })
        break
      default:
        if (toastId !== undefined) toast.dismiss(toastId)
    }
    return response
  } catch (error) {
    toast.error(`Export failed: ${errorMessage(error)}`, {
      ...(toastId !== undefined ? { id: toastId } : {}),
      action: undefined
    })
    return null
  } finally {
    unsubscribe()
  }
}

/** Format choices offered by export menus. */
export const FULL_EXPORT_FORMATS: ReadonlyArray<{ format: DataExportFormat; label: string }> = [
  { format: 'csv', label: 'CSV' },
  { format: 'json', label: 'JSON' },
  { format: 'sql', label: 'SQL INSERT' }
]

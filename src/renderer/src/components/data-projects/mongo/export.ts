// Exports from the Mongo workspace.
// - Full exports (a collection, a query, a pipeline) stream server-side with no row limit through
//   the shared `startFullExport` (sql-ui): `dataProjects.export.start` with a `mongo` source, a
//   native save dialog, a progress toast with Cancel. JSON is relaxed EJSON (what mongoexport
//   writes); CSV flattens fields to dotted columns.
// - "Export results" saves the documents on screen as a relaxed-EJSON JSON array.

import type { DataExportSource, DataProject } from '@shared/data-projects/types'
import { dataProjectsApi } from '@/api/data-projects-api'
import { safeFileStem, startFullExport } from '@/components/data-projects/shared'
import { toast } from '@/lib/toast'
import { toRelaxedJsonText } from './ejson'
import { formatCount, mongoErrorText } from './mongo-ui'

export type MongoExportSource = Extract<DataExportSource, { kind: 'mongo' }>

/** Streams the source to a file the user picks; resolves when finished, cancelled or failed. */
export async function exportMongoSource(
  project: DataProject,
  source: MongoExportSource,
  format: 'json' | 'csv'
): Promise<void> {
  const response = await startFullExport({ dataProjectId: project.id, source, format })
  if (response?.status === 'blocked') toast.error(`Export blocked: ${response.reason}`)
}

/** Saves the documents currently shown as a JSON array (relaxed EJSON). */
export async function saveVisibleDocuments(
  project: DataProject,
  baseName: string,
  documents: ReadonlyArray<Record<string, unknown>>
): Promise<void> {
  if (documents.length === 0) {
    toast.info('Nothing to export: no documents are shown')
    return
  }
  try {
    const { filePath } = await dataProjectsApi.saveTextFile(
      `${safeFileStem(baseName) || 'documents'}.json`,
      `${toRelaxedJsonText(documents)}\n`,
      ['json']
    )
    if (filePath)
      toast.success(`Saved ${formatCount(documents.length)} documents`, { description: filePath })
  } catch (error) {
    toast.error(mongoErrorText(project, error, 'Could not save the file'))
  }
}

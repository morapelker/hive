// Export support for MongoDB (DataDriver.streamRows).
//
// streamRows only receives a statement string, so the export path describes what to stream with
// a small JSON "export spec" built by `mongoExportStatement(source, format)`:
//   { "tedoooMongoExport": 1, "format": "csv"|"json", "database", "collection", "filter",
//     "projection", "sort", "collation", "hint", "pipeline" }
//   — or { ..., "shell": "<mongosh find/aggregate>" }
// The spec also carries the format, which decides the row shape:
// - json → columns = [MONGO_EJSON_COLUMN] and every row is [relaxedEjsonDocument] (a JSON-safe
//   object: write row[0] as the document, one per array element / NDJSON line);
// - csv  → columns = dotted field paths (union over the whole result, found in a first pass),
//   cells = strings/numbers/booleans/null; arrays and empty objects are relaxed-EJSON text.
// A plain mongosh statement (no spec) streams as json.

import type { DataExportFormat, DataExportSource } from '../../../../shared/data-projects/types'
import { isPlainObject, relaxedText, scalarText } from './runtime'

/** The single column of JSON-format Mongo export rows (row[0] = relaxed EJSON document). */
export const MONGO_EJSON_COLUMN = '__ejson__'
const SPEC_KEY = 'tedoooMongoExport'

export interface MongoExportSpec {
  format: 'csv' | 'json'
  database?: string
  collection?: string
  filter?: string
  projection?: string
  sort?: string
  /** Shell/EJSON text, as in the Documents query bar (also applied to a pipeline). */
  collation?: string
  /** Index name or key document text, as in the Documents query bar. */
  hint?: string
  pipeline?: string
  /** A mongosh find/aggregate statement instead of the collection fields. */
  shell?: string
}

/**
 * The `statement` to pass to MongoDriver.streamRows for an export. `format: 'sql'` is not
 * supported for MongoDB (streamRows rejects it with DATA_UNSUPPORTED).
 */
export function mongoExportStatement(source: DataExportSource, format: DataExportFormat): string {
  const spec: Record<string, unknown> = { [SPEC_KEY]: 1, format }
  switch (source.kind) {
    case 'mongo': {
      // The query bar's collation and hint ride along so the export matches what was shown.
      const { collation, hint } = source
      spec.database = source.database
      spec.collection = source.collection
      if (source.filter?.trim()) spec.filter = source.filter
      if (source.projection?.trim()) spec.projection = source.projection
      if (source.sort?.trim()) spec.sort = source.sort
      if (collation?.trim()) spec.collation = collation
      if (hint?.trim()) spec.hint = hint
      if (source.pipeline?.trim()) spec.pipeline = source.pipeline
      break
    }
    case 'query':
      spec.shell = source.text
      if (source.database) spec.database = source.database
      break
    case 'table':
      spec.collection = source.ref.name
      if (source.ref.database) spec.database = source.ref.database
      break
  }
  return JSON.stringify(spec)
}

/** The spec inside a streamRows statement, or null for a plain mongosh statement. */
export function parseMongoExportSpec(
  statement: string
): (MongoExportSpec & { format: string }) | null {
  const text = statement.trim()
  if (!text.startsWith('{') || !text.includes(`"${SPEC_KEY}"`)) return null
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || (value as Record<string, unknown>)[SPEC_KEY] !== 1)
    return null
  const raw = value as Record<string, unknown>
  const str = (key: string): string | undefined =>
    typeof raw[key] === 'string' ? (raw[key] as string) : undefined
  return {
    format: str('format') ?? 'json',
    database: str('database'),
    collection: str('collection'),
    filter: str('filter'),
    projection: str('projection'),
    sort: str('sort'),
    collation: str('collation'),
    hint: str('hint'),
    pipeline: str('pipeline'),
    shell: str('shell')
  } as MongoExportSpec & { format: string }
}

/** Calls `visit(path, value)` for every leaf of a document (sub-documents become dotted paths). */
export function flattenDocument(
  doc: Record<string, unknown>,
  visit: (path: string, value: unknown) => void,
  prefix = '',
  depth = 0
): void {
  for (const [key, value] of Object.entries(doc)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (isPlainObject(value) && Object.keys(value).length > 0 && depth < 32) {
      flattenDocument(value, visit, path, depth + 1)
    } else {
      visit(path, value)
    }
  }
}

/** A CSV cell for one leaf value. */
export function csvCell(value: unknown): string | number | boolean | null {
  if (Array.isArray(value) || isPlainObject(value))
    return relaxedText(value, Number.MAX_SAFE_INTEGER)
  return scalarText(value)
}

/** Collects the union of dotted paths (first-seen order, _id first), capped at `max`. */
export class CsvColumnCollector {
  private readonly seen = new Set<string>()
  private readonly order: string[] = []

  constructor(private readonly max = 5000) {}

  add(doc: Record<string, unknown>): void {
    flattenDocument(doc, (path) => {
      if (this.seen.has(path) || this.order.length >= this.max) return
      this.seen.add(path)
      this.order.push(path)
    })
  }

  columns(): string[] {
    const idIndex = this.order.indexOf('_id')
    if (idIndex <= 0) return [...this.order]
    return ['_id', ...this.order.filter((path) => path !== '_id')]
  }
}

/** One CSV row in `columns` order. */
export function csvRow(
  doc: Record<string, unknown>,
  columns: readonly string[],
  index: Map<string, number>
): unknown[] {
  const row: unknown[] = new Array(columns.length).fill(null)
  flattenDocument(doc, (path, value) => {
    const at = index.get(path)
    if (at !== undefined) row[at] = csvCell(value)
  })
  return row
}

// Sampled schema analysis for collections (Schema tab, describe, autocomplete, AI context).
// A small deterministic analyzer instead of mongodb-schema: we need exactly dotted paths with
// presence, type mix, a few sample values and a uniqueness ratio, computed over documents read
// with promoteValues:false (so Int32 / Double / Long stay distinguishable).
//
// Paths: sub-documents add ".key"; documents inside arrays contribute to the same dotted path
// ("items.productId"), as Compass and the query language treat them. Presence counts each
// document once per path. Array elements that are scalars feed the array path's sample values.

import type { DataColumnInfo, MongoSchemaField } from '../../../../shared/data-projects/types'
import { bsonTypeName, isPlainObject, relaxedText } from './runtime'

export interface SchemaAnalysisOptions {
  /** Stop adding new paths after this many (wide dynamic-key documents). Default 1000. */
  maxFields?: number
  /** Nesting depth of sub-documents to descend into. Default 8. */
  maxDepth?: number
  /** Sample values kept per field. Default 8. */
  maxSampleValues?: number
  /** Distinct values tracked per field for uniqueness. Default 2000. */
  maxDistinct?: number
  /** Array elements inspected per array. Default 50. */
  maxArrayElements?: number
}

interface FieldStats {
  path: string
  docCount: number
  lastDoc: number
  types: Map<string, number>
  samples: string[]
  distinct: Set<string>
  distinctOverflow: boolean
  valueCount: number
}

const SCALAR_SAMPLE_MAX = 120
const cut = (text: string): string =>
  text.length > SCALAR_SAMPLE_MAX ? `${text.slice(0, SCALAR_SAMPLE_MAX - 1)}…` : text
const NON_SCALAR = new Set(['Document', 'Array', 'Null', 'Undefined', 'MinKey', 'MaxKey'])

export function analyzeMongoDocuments(
  docs: readonly unknown[],
  options: SchemaAnalysisOptions = {}
): MongoSchemaField[] {
  const maxFields = options.maxFields ?? 1000
  const maxDepth = options.maxDepth ?? 8
  const maxSamples = options.maxSampleValues ?? 8
  const maxDistinct = options.maxDistinct ?? 2000
  const maxElements = options.maxArrayElements ?? 50
  const fields = new Map<string, FieldStats>()

  const statsFor = (path: string): FieldStats | null => {
    let stats = fields.get(path)
    if (!stats) {
      if (fields.size >= maxFields) return null
      stats = {
        path,
        docCount: 0,
        lastDoc: -1,
        types: new Map(),
        samples: [],
        distinct: new Set(),
        distinctOverflow: false,
        valueCount: 0
      }
      fields.set(path, stats)
    }
    return stats
  }

  const recordScalar = (stats: FieldStats, value: unknown, type: string): void => {
    if (NON_SCALAR.has(type)) return
    const text = type === 'String' ? (value as string) : relaxedText(value, 400)
    stats.valueCount++
    if (!stats.distinctOverflow) {
      stats.distinct.add(text)
      if (stats.distinct.size > maxDistinct) {
        stats.distinctOverflow = true
        stats.distinct.clear()
      }
    }
    if (stats.samples.length < maxSamples) {
      // Relaxed EJSON text: strings stay quoted so "5" and 5 read differently.
      const sample =
        type === 'String' ? cut(JSON.stringify(value)) : relaxedText(value, SCALAR_SAMPLE_MAX)
      if (!stats.samples.includes(sample)) stats.samples.push(sample)
    }
  }

  const visitDocument = (
    doc: Record<string, unknown>,
    prefix: string,
    docIndex: number,
    depth: number
  ): void => {
    for (const [key, value] of Object.entries(doc)) {
      visitField(prefix ? `${prefix}.${key}` : key, value, docIndex, depth)
    }
  }

  const visitField = (path: string, value: unknown, docIndex: number, depth: number): void => {
    const stats = statsFor(path)
    if (!stats) return
    if (stats.lastDoc !== docIndex) {
      stats.docCount++
      stats.lastDoc = docIndex
    }
    const type = bsonTypeName(value)
    stats.types.set(type, (stats.types.get(type) ?? 0) + 1)
    if (type === 'Document') {
      if (depth < maxDepth && isPlainObject(value)) visitDocument(value, path, docIndex, depth + 1)
      return
    }
    if (type === 'Array') {
      const items = value as unknown[]
      const limit = Math.min(items.length, maxElements)
      for (let i = 0; i < limit; i++) {
        const item = items[i]
        if (isPlainObject(item)) {
          if (depth < maxDepth) visitDocument(item, path, docIndex, depth + 1)
        } else if (!Array.isArray(item)) {
          recordScalar(stats, item, bsonTypeName(item))
        }
      }
      return
    }
    recordScalar(stats, value, type)
  }

  docs.forEach((doc, index) => {
    if (isPlainObject(doc)) visitDocument(doc, '', index, 0)
  })

  const total = docs.length || 1
  const result: MongoSchemaField[] = []
  for (const stats of fields.values()) {
    const typeTotal = [...stats.types.values()].reduce((a, b) => a + b, 0) || 1
    const field: MongoSchemaField = {
      path: stats.path,
      probability: round(stats.docCount / total),
      types: [...stats.types.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([type, count]) => ({ type, probability: round(count / typeTotal) }))
    }
    if (stats.samples.length > 0) field.sampleValues = stats.samples
    if (stats.valueCount > 0 && !stats.distinctOverflow) {
      field.uniqueness = round(stats.distinct.size / stats.valueCount)
    }
    result.push(field)
  }
  // _id first, then first-seen order (document order of the sample).
  result.sort((a, b) => (a.path === '_id' ? -1 : b.path === '_id' ? 1 : 0))
  return result
}

const round = (value: number): number => Math.round(value * 10_000) / 10_000

/** "String | Null" style type label. */
export const schemaTypeLabel = (field: MongoSchemaField): string =>
  field.types.map((t) => t.type).join(' | ') || 'Unknown'

/** Sampled fields as DataColumnInfo rows for describe(). */
export function schemaFieldsToColumns(fields: readonly MongoSchemaField[]): DataColumnInfo[] {
  return fields.map((field, index) => ({
    name: field.path,
    type: schemaTypeLabel(field),
    nullable:
      field.probability < 1 || field.types.some((t) => t.type === 'Null' || t.type === 'Undefined'),
    isPrimaryKey: field.path === '_id',
    ordinal: index + 1,
    extra: `${Math.round(field.probability * 100)}% of sampled documents`
  }))
}

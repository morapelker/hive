// Request shaping for the Mongo workspace, kept pure so the rules are testable: the query bar →
// MongoFindRequest with paging, "x–y of N", `_id` filters for single-document writes, the
// optimistic-concurrency filter of a document edit, the create-index and create-collection
// option documents, name validation, and the shell text that describes a query (assistant
// context, "Open in shell").

import type { MongoCreateIndexRequest, MongoFindRequest } from '@shared/data-projects/types'
import {
  MONGO_DATABASE_METHODS,
  MONGO_DATABASE_NAVIGATION_METHODS
} from '@shared/data-projects/mongo-shell'
import {
  formatShellDocument,
  formatShellValue,
  mongoValueType,
  quoteShellString,
  shellKey
} from './ejson'
import { lexShell } from './shell-lexer'

// ---------------------------------------------------------------------------------------------
// Query bar
// ---------------------------------------------------------------------------------------------

/** The query bar as typed (text inputs; numbers are validated when the query runs). */
export interface MongoQueryDraft {
  filter: string
  project: string
  sort: string
  collation: string
  hint: string
  skip: string
  limit: string
  maxTimeMS: string
}

export const EMPTY_QUERY: Readonly<MongoQueryDraft> = Object.freeze({
  filter: '',
  project: '',
  sort: '',
  collation: '',
  hint: '',
  skip: '',
  limit: '',
  maxTimeMS: ''
})

export const PAGE_SIZES = [20, 50, 100, 250, 500] as const
export const DEFAULT_PAGE_SIZE = 20

/** Non-negative integer from a text input; '' → undefined. */
export function parseCount(
  text: string,
  label: string
): { ok: true; value: number | undefined } | { ok: false; error: string } {
  const trimmed = text.trim().replace(/[_,\s]/g, '')
  if (!trimmed) return { ok: true, value: undefined }
  if (!/^\d+$/.test(trimmed)) return { ok: false, error: `${label} must be a whole number ≥ 0` }
  const value = Number(trimmed)
  if (!Number.isSafeInteger(value)) return { ok: false, error: `${label} is too large` }
  return { ok: true, value }
}

const textOrUndefined = (text: string): string | undefined => {
  const trimmed = text.trim()
  return trimmed ? trimmed : undefined
}

export interface FindRequestBase {
  dataProjectId: string
  database: string
  collection: string
  queryId: string
}

export interface ParsedQueryNumbers {
  /** Skip typed in the query bar (base of every page). */
  skip: number
  /** Limit typed in the query bar (null = no limit: page through everything). */
  limit: number | null
  maxTimeMS: number | undefined
}

export function parseQueryNumbers(
  query: MongoQueryDraft
): { ok: true; value: ParsedQueryNumbers } | { ok: false; error: string } {
  const skip = parseCount(query.skip, 'Skip')
  if (!skip.ok) return skip
  const limit = parseCount(query.limit, 'Limit')
  if (!limit.ok) return limit
  const maxTime = parseCount(query.maxTimeMS, 'maxTimeMS')
  if (!maxTime.ok) return maxTime
  return {
    ok: true,
    value: {
      skip: skip.value ?? 0,
      limit: limit.value ? limit.value : null,
      maxTimeMS: maxTime.value ? maxTime.value : undefined
    }
  }
}

/**
 * The find request for one page. Pages sit on top of the query bar's own skip/limit: page p of
 * size s skips `skip + p·s` documents and fetches min(s, limit − p·s) of them.
 */
export function buildFindRequest(
  base: FindRequestBase,
  query: MongoQueryDraft,
  page: number,
  pageSize: number
):
  | { ok: true; request: MongoFindRequest; numbers: ParsedQueryNumbers }
  | { ok: false; error: string } {
  const parsed = parseQueryNumbers(query)
  if (!parsed.ok) return parsed
  const numbers = parsed.value
  const offset = page * pageSize
  const limit = numbers.limit === null ? pageSize : Math.min(pageSize, numbers.limit - offset)
  if (limit <= 0) return { ok: false, error: 'This page is past the query limit' }
  const request: MongoFindRequest = {
    dataProjectId: base.dataProjectId,
    queryId: base.queryId,
    database: base.database,
    collection: base.collection,
    limit,
    withCount: true
  }
  const filter = textOrUndefined(query.filter)
  if (filter) request.filter = filter
  const projection = textOrUndefined(query.project)
  if (projection) request.projection = projection
  const sort = textOrUndefined(query.sort)
  if (sort) request.sort = sort
  const collation = textOrUndefined(query.collation)
  if (collation) request.collation = collation
  const hint = textOrUndefined(query.hint)
  if (hint) request.hint = hint
  if (numbers.skip + offset > 0) request.skip = numbers.skip + offset
  if (numbers.maxTimeMS) request.maxTimeMS = numbers.maxTimeMS
  return { ok: true, request, numbers }
}

export interface PageInfo {
  /** 1-based position of the first shown document within the query result (0 when empty). */
  first: number
  last: number
  /** Documents the query matches (after the bar's skip/limit), null when unknown. */
  total: number | null
  hasPrev: boolean
  hasNext: boolean
  /** "1–20 of 1,284", "21–40 of many", "No documents". */
  label: string
}

const fmt = (n: number): string => n.toLocaleString('en-US')

export function pageInfo(input: {
  page: number
  pageSize: number
  shown: number
  truncated: boolean
  count: number | null
  numbers: ParsedQueryNumbers
}): PageInfo {
  const { page, pageSize, shown, truncated, count, numbers } = input
  const offset = page * pageSize
  let total: number | null = null
  if (count !== null) {
    total = Math.max(0, count - numbers.skip)
    if (numbers.limit !== null) total = Math.min(total, numbers.limit)
  }
  const first = shown > 0 ? offset + 1 : 0
  const last = offset + shown
  const withinLimit = numbers.limit === null || offset + pageSize < numbers.limit
  const hasNext = withinLimit && (total !== null ? last < total : truncated)
  let label: string
  if (shown === 0) label = page === 0 ? 'No documents' : `Nothing on page ${page + 1}`
  else if (total !== null) label = `${fmt(first)}–${fmt(last)} of ${fmt(total)}`
  else label = `${fmt(first)}–${fmt(last)}${truncated ? ' of many' : ''}`
  return { first, last, total, hasPrev: page > 0, hasNext, label }
}

// ---------------------------------------------------------------------------------------------
// Shell text
// ---------------------------------------------------------------------------------------------

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** `db.orders` when that is unambiguous shell, else `db.getCollection('order-items')`. */
export function collectionAccessor(collection: string): string {
  return IDENT.test(collection) &&
    !(collection in MONGO_DATABASE_METHODS) &&
    !(collection in MONGO_DATABASE_NAVIGATION_METHODS)
    ? `db.${collection}`
    : `db.getCollection(${quoteShellString(collection)})`
}

const isBlankObject = (text: string): boolean => text.replace(/\s+/g, '') === '{}' || !text.trim()

/**
 * A user-typed fragment placed before a `,` or `)` of generated shell text: a trailing line
 * comment (`{ a: 1 } // note`) would swallow what follows on its line, so the line ends first.
 */
export function shellFragment(text: string): string {
  const trimmed = text.trim()
  const last = lexShell(trimmed).at(-1)
  return last?.type === 'comment' && last.text.startsWith('//') ? `${trimmed}\n` : trimmed
}

/** The query bar's hint as shell: a bare index name (status_1) is quoted, like the server does. */
export function hintShellText(hint: string): string {
  const trimmed = hint.trim()
  return /^[\w.$-]+$/.test(trimmed) && !/^\d/.test(trimmed)
    ? quoteShellString(trimmed)
    : shellFragment(trimmed)
}

/** The query bar as one mongosh statement (assistant context, "Open in shell", copy). */
export function findShellText(collection: string, query: MongoQueryDraft): string {
  const filter = query.filter.trim()
  const projection = query.project.trim()
  const args = isBlankObject(projection)
    ? isBlankObject(filter)
      ? ''
      : shellFragment(filter)
    : `${filter ? shellFragment(filter) : '{}'}, ${shellFragment(projection)}`
  let text = `${collectionAccessor(collection)}.find(${args})`
  if (!isBlankObject(query.sort)) text += `.sort(${shellFragment(query.sort)})`
  if (query.collation.trim()) text += `.collation(${shellFragment(query.collation)})`
  if (query.hint.trim()) text += `.hint(${hintShellText(query.hint)})`
  const skip = parseCount(query.skip, 'Skip')
  if (skip.ok && skip.value) text += `.skip(${skip.value})`
  const limit = parseCount(query.limit, 'Limit')
  if (limit.ok && limit.value) text += `.limit(${limit.value})`
  const maxTime = parseCount(query.maxTimeMS, 'maxTimeMS')
  if (maxTime.ok && maxTime.value) text += `.maxTimeMS(${maxTime.value})`
  return text
}

/** An aggregation as one mongosh statement. */
export function aggregateShellText(collection: string, pipelineText: string): string {
  return `${collectionAccessor(collection)}.aggregate(${shellFragment(pipelineText) || '[]'})`
}

// ---------------------------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------------------------

/** `{ _id: ObjectId('…') }` (lossless) for replaceOne/deleteOne; null when there is no _id. */
export function idFilterText(doc: Record<string, unknown>): string | null {
  if (!('_id' in doc)) return null
  return `{ _id: ${formatShellValue(doc._id, { mode: 'edit' })} }`
}

/**
 * The collation an edit's concurrencyFilterText is matched with: binary comparison. Without it
 * the collection's default collation applies, and under a case-insensitive one an 'ALICE'
 * written meanwhile still equals the loaded 'alice', so the other writer's change would be
 * overwritten without the conflict dialog.
 */
export const CONCURRENCY_COLLATION = "{ locale: 'simple' }"

/** The RPC caps a filter at 1 MB; past this the edit filter falls back to `_id` + field count. */
export const CONCURRENCY_FILTER_MAX = 900_000

/** Integer-like keys ('0', '12'): JS objects reorder them, so the loaded order is unknown. */
function hasReorderedKeys(value: unknown): boolean {
  const type = mongoValueType(value)
  if (type === 'array') return (value as unknown[]).some(hasReorderedKeys)
  if (type !== 'object') return false
  return Object.entries(value as Record<string, unknown>).some(
    ([key, v]) => /^(?:0|[1-9]\d*)$/.test(key) || hasReorderedKeys(v)
  )
}

/**
 * The filter that saves an edited document only if it is still the one that was loaded
 * (optimistic concurrency): its `_id`, every top-level field equal to the loaded value, and the
 * same number of fields (`$expr` on `$$ROOT`), so a field changed, added or removed meanwhile
 * makes replaceOne match nothing instead of silently undoing someone else's write. Objects,
 * arrays and regexes compare with `$eq` (a bare regex would be a pattern match, a `$key` inside
 * an object an operator). Fields a filter cannot address exactly — names with `.` or a leading
 * `$`, values whose key order JS lost — are left to the field count. null without an _id.
 * Send it with CONCURRENCY_COLLATION.
 */
export function concurrencyFilterText(doc: Record<string, unknown>): string | null {
  if (!('_id' in doc)) return null
  const id = `_id: ${formatShellValue(doc._id, { mode: 'edit' })}`
  const count = `$expr: { $eq: [{ $size: { $objectToArray: '$$ROOT' } }, ${Object.keys(doc).length}] }`
  const fields: string[] = []
  for (const [key, value] of Object.entries(doc)) {
    if (key === '_id' || !key || key.startsWith('$') || key.includes('.')) continue
    const type = mongoValueType(value)
    if (type === 'undefined' || hasReorderedKeys(value)) continue
    const text = formatShellValue(value, { mode: 'edit' })
    const exact = type === 'object' || type === 'array' || type === 'regex' || type === 'dbRef'
    fields.push(`${shellKey(key)}: ${exact ? `{ $eq: ${text} }` : text}`)
  }
  const full = `{ ${[id, ...fields, count].join(', ')} }`
  return full.length <= CONCURRENCY_FILTER_MAX ? full : `{ ${id}, ${count} }`
}

/** The document without `_id`, as editable shell text (Clone: the server assigns a new _id). */
export function cloneDocumentText(doc: Record<string, unknown>): string {
  const copy: Record<string, unknown> = {}
  for (const key of Object.keys(doc)) if (key !== '_id') copy[key] = doc[key]
  return formatShellDocument(copy, 'edit')
}

/** Shell text that the Add document dialog opens with. */
export const NEW_DOCUMENT_TEXT = '{\n  \n}'

/**
 * Adds `path: ` to the filter for the Schema tab's "click a field". Returns the new text and the
 * cursor offset (right after the colon) so the user can type the value.
 */
export function appendFilterField(filter: string, path: string): { text: string; cursor: number } {
  const key = shellKey(path)
  const trimmed = filter.trim()
  if (!trimmed || isBlankObject(trimmed)) {
    const text = `{ ${key}:  }`
    return { text, cursor: text.length - 2 }
  }
  const close = trimmed.lastIndexOf('}')
  if (!trimmed.startsWith('{') || close < 0) {
    const text = `${trimmed}`
    return { text, cursor: text.length }
  }
  const head = trimmed.slice(0, close).trimEnd()
  const needsComma = !head.endsWith('{') && !head.endsWith(',')
  const insert = `${needsComma ? ',' : ''} ${key}: `
  const text = `${head}${insert} ${trimmed.slice(close)}`
  return { text, cursor: head.length + insert.length }
}

// ---------------------------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------------------------

export interface MongoIndexForm {
  /** Key spec as shell text: { createdAt: -1 } */
  keys: string
  name: string
  unique: boolean
  sparse: boolean
  hidden: boolean
  /** TTL in seconds ('' = no TTL). */
  ttlSeconds: string
  /** Partial filter expression as shell text ('' = none). */
  partialFilter: string
}

export const EMPTY_INDEX_FORM: Readonly<MongoIndexForm> = Object.freeze({
  keys: '{\n  field: 1\n}',
  name: '',
  unique: false,
  sparse: false,
  hidden: false,
  ttlSeconds: '',
  partialFilter: ''
})

/** The options document of createIndex, or undefined when every option is default. */
export function buildIndexOptionsText(
  form: MongoIndexForm
): { ok: true; text: string | undefined } | { ok: false; error: string } {
  const parts: string[] = []
  const name = form.name.trim()
  if (name) parts.push(`name: ${quoteShellString(name)}`)
  if (form.unique) parts.push('unique: true')
  if (form.sparse) parts.push('sparse: true')
  if (form.hidden) parts.push('hidden: true')
  const ttl = parseCount(form.ttlSeconds, 'TTL')
  if (!ttl.ok) return ttl
  if (ttl.value !== undefined) parts.push(`expireAfterSeconds: ${ttl.value}`)
  const partial = form.partialFilter.trim()
  if (partial) {
    if (!partial.startsWith('{'))
      return { ok: false, error: 'The partial filter must be an object like { status: "A" }' }
    parts.push(`partialFilterExpression: ${partial}`)
  }
  if (form.sparse && partial)
    return { ok: false, error: 'An index cannot be both sparse and partial' }
  return { ok: true, text: parts.length ? `{ ${parts.join(', ')} }` : undefined }
}

export function buildCreateIndexRequest(
  base: { dataProjectId: string; database: string; collection: string },
  form: MongoIndexForm
): { ok: true; request: MongoCreateIndexRequest } | { ok: false; error: string } {
  const keys = form.keys.trim()
  if (!keys || isBlankObject(keys))
    return { ok: false, error: 'Add at least one key, e.g. { createdAt: -1 }' }
  if (!keys.startsWith('{')) return { ok: false, error: 'Keys must be an object like { field: 1 }' }
  const options = buildIndexOptionsText(form)
  if (!options.ok) return options
  return {
    ok: true,
    request: {
      dataProjectId: base.dataProjectId,
      database: base.database,
      collection: base.collection,
      keys,
      ...(options.text ? { options: options.text } : {})
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Collections and databases
// ---------------------------------------------------------------------------------------------

export type CollectionKind = 'standard' | 'capped' | 'timeseries' | 'clustered'

export interface CreateCollectionForm {
  database: string
  name: string
  kind: CollectionKind
  cappedSize: string
  cappedMax: string
  timeField: string
  metaField: string
  granularity: '' | 'seconds' | 'minutes' | 'hours'
  expireAfterSeconds: string
  collationLocale: string
  /** Raw options document; when set it replaces everything above. */
  advanced: string
}

export const EMPTY_COLLECTION_FORM: Readonly<CreateCollectionForm> = Object.freeze({
  database: '',
  name: '',
  kind: 'standard',
  cappedSize: '',
  cappedMax: '',
  timeField: '',
  metaField: '',
  granularity: '',
  expireAfterSeconds: '',
  collationLocale: '',
  advanced: ''
})

/** Server-side naming rules, checked before the round trip. null = valid. */
export function validateCollectionName(name: string): string | null {
  if (!name.trim()) return 'Enter a collection name'
  if (name !== name.trim()) return 'Collection names cannot start or end with spaces'
  if (name.includes('$')) return 'Collection names cannot contain $'
  if (name.includes('\0')) return 'Collection names cannot contain the null character'
  if (name.startsWith('system.')) return "Names starting with 'system.' are reserved"
  if (new TextEncoder().encode(name).length > 235) return 'Collection name is too long'
  return null
}

export function validateDatabaseName(name: string): string | null {
  if (!name.trim()) return 'Enter a database name'
  if (/[/\\. "$*<>:|?\0]/.test(name))
    return 'Database names cannot contain / \\ . " $ * < > : | ? or spaces'
  if (new TextEncoder().encode(name).length >= 64)
    return 'Database name must be shorter than 64 bytes'
  return null
}

/** createCollection options as shell text (undefined = defaults). */
export function buildCollectionOptionsText(
  form: CreateCollectionForm
): { ok: true; text: string | undefined } | { ok: false; error: string } {
  if (form.advanced.trim()) {
    const raw = form.advanced.trim()
    if (!raw.startsWith('{'))
      return { ok: false, error: 'Options must be an object like { capped: true }' }
    return { ok: true, text: raw }
  }
  const parts: string[] = []
  if (form.kind === 'capped') {
    const size = parseCount(form.cappedSize, 'Size')
    if (!size.ok) return size
    if (!size.value) return { ok: false, error: 'A capped collection needs a size in bytes' }
    parts.push('capped: true', `size: ${size.value}`)
    const max = parseCount(form.cappedMax, 'Max documents')
    if (!max.ok) return max
    if (max.value) parts.push(`max: ${max.value}`)
  } else if (form.kind === 'timeseries') {
    const timeField = form.timeField.trim()
    if (!timeField) return { ok: false, error: 'A time-series collection needs a time field' }
    const ts = [`timeField: ${quoteShellString(timeField)}`]
    if (form.metaField.trim()) ts.push(`metaField: ${quoteShellString(form.metaField.trim())}`)
    if (form.granularity) ts.push(`granularity: ${quoteShellString(form.granularity)}`)
    parts.push(`timeseries: { ${ts.join(', ')} }`)
    const expire = parseCount(form.expireAfterSeconds, 'Expire after')
    if (!expire.ok) return expire
    if (expire.value !== undefined) parts.push(`expireAfterSeconds: ${expire.value}`)
  } else if (form.kind === 'clustered') {
    parts.push('clusteredIndex: { key: { _id: 1 }, unique: true }')
    const expire = parseCount(form.expireAfterSeconds, 'Expire after')
    if (!expire.ok) return expire
    if (expire.value !== undefined) parts.push(`expireAfterSeconds: ${expire.value}`)
  }
  const locale = form.collationLocale.trim()
  if (locale) parts.push(`collation: { locale: ${quoteShellString(locale)} }`)
  return { ok: true, text: parts.length ? `{ ${parts.join(', ')} }` : undefined }
}

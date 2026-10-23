// The database assistant's tools: ONE zod registry, adapted per provider (the Claude runner
// turns each into an in-process MCP tool, the JSON-loop runner describes them in its prompt and
// dispatches `{"name","args"}` actions to the same toolbox).
//
// Every tool is read-only metadata over DataEngineService's introspection methods (which never
// pass through the safety gate and never run user text). Sample rows/documents are the one
// exception that sends DATA to the model provider, so those tools are not even offered unless
// the data project allows AI data access, and `infer_collection_schema` strips its sample values
// otherwise. Results are compact text capped at ~8 KB (with a note saying so) so a big schema
// never floods the context.
//
// Credentials never reach the provider (research/safety.md §D4): every result and error is
// masked for the engine (maskForAssistant) before the model reads it, and each server value that
// gets shortened (defaults, comments, engine clauses, sample cells) is masked before the cut, so
// a password cut in half is still found. A DDL can embed one (FEDERATED CONNECTION, dblink
// conninfo in a view, ClickHouse MySQL()/S3() engine arguments).
//
// `propose_query` is the only way a run delivers a query: the toolbox validates it (parser errors
// go back to the model, twice at most), records it and emits the `proposal` event. Nothing here
// ever executes the proposed text.

import { z } from 'zod'
import {
  DATA_ENGINE_INFO,
  dataEngineFamily,
  isBinaryCell,
  sqlDialectOf,
  type DataAssistantEvent,
  type DataCell,
  type DataEngine,
  type DataObjectInfo,
  type DataObjectKind,
  type DataObjectRef,
  type DataQueryProposal,
  type DataStatementOutput,
  type DataTableDetails,
  type MongoIndexInfo,
  type MongoSchemaResponse
} from '../../../../shared/data-projects/types'
import { maskForHistory } from '../query-runner'
import { redactUrlCredentials } from '../redact'
import { AssistantAbort, type AssistantEngine, type ProposalValidator } from './types'

/** Tool results longer than this are cut (with a note telling the model how to narrow down). */
export const TOOL_RESULT_MAX_CHARS = 8_000
/** One tool call may not take longer than this (the engine's own statement timeouts are shorter). */
export const TOOL_TIMEOUT_MS = 20_000
/** Sample rows / documents per call (they leave the machine: keep it tiny). */
export const SAMPLE_LIMIT_MAX = 5
/** Documents sampled by infer_collection_schema. */
export const SCHEMA_SAMPLE_MAX = 100
const SCHEMA_SAMPLE_DEFAULT = 50
const LIST_MAX_ITEMS = 300
const SEARCH_MAX_MATCHES = 150
const CELL_MAX_CHARS = 200
const ARG_DISPLAY_MAX_CHARS = 120
const QUERY_MAX_CHARS = 100_000
const EXPLANATION_MAX_CHARS = 2_000
/** Unparseable proposals are bounced back this many times, then delivered with a warning. */
const MAX_PROPOSAL_REJECTIONS = 2

export const PROPOSE_QUERY_TOOL = 'propose_query'
/** The in-process MCP server name; Claude sees the tools as `mcp__db__<name>`. */
export const ASSISTANT_MCP_SERVER = 'db'

/** Object kinds list_tables / list_collections report (routines, triggers... are only counted). */
const RELATION_KINDS: ReadonlySet<DataObjectKind> = new Set([
  'table',
  'view',
  'materialized_view',
  'foreign_table',
  'dictionary',
  'collection'
])

/**
 * Column / field names whose sample values are never shown to the model even when data access
 * is allowed: credentials and payment data have no business in a prompt.
 */
const SENSITIVE_NAME =
  /(pass(word|wd|phrase)?$|^pass|password|secret|token|api_?key|private_?key|salt|hash|ssn|credit_?card|card_?number|iban|cvv)/i

export interface AssistantToolContext {
  dataProjectId: string
  engine: DataEngine
  allowDataAccess: boolean
  /** Database the user is working in (the default for every tool). */
  database?: string
  /** PostgreSQL schema the user is working in. */
  schema?: string
  service: AssistantEngine
  signal: AbortSignal
  now: () => Date
  /** The user's IANA time zone. */
  timeZone: string
}

export interface AssistantToolOutput {
  /** What the model reads. */
  text: string
  /** What the tool chip says ("14 columns", "3 tables"). */
  summary: string
}

export interface AssistantTool {
  readonly name: string
  readonly description: string
  /** Compact argument signature for the JSON-loop prompt: `{ table: string, schema?: string }`. */
  readonly signature: string
  readonly shape: z.ZodRawShape
  /** Sends row/document values to the model (offered only with allowAiDataAccess). */
  readonly readsData?: boolean
  run(args: Record<string, unknown>, ctx: AssistantToolContext): Promise<AssistantToolOutput>
}

/** A tool call failure the model should read (bad input, nothing found). */
class ToolInputError extends Error {}

function defineTool<S extends z.ZodRawShape>(def: {
  name: string
  description: string
  signature: string
  shape: S
  readsData?: boolean
  run: (args: z.infer<z.ZodObject<S>>, ctx: AssistantToolContext) => Promise<AssistantToolOutput>
}): AssistantTool {
  return {
    name: def.name,
    description: def.description,
    signature: def.signature,
    shape: def.shape,
    ...(def.readsData ? { readsData: true } : {}),
    run: (args, ctx) => def.run(args as z.infer<z.ZodObject<S>>, ctx)
  }
}

// ---------------------------------------------------------------------------------------------
// Argument schemas (nullish: some models send null for "not given")
// ---------------------------------------------------------------------------------------------

const nameArg = (description: string): z.ZodString =>
  z.string().min(1).max(512).describe(description)
const optionalName = (description: string): z.ZodOptional<z.ZodNullable<z.ZodString>> =>
  z.string().max(512).nullish().describe(description)

const DATABASE_ARG = optionalName('Database name; defaults to the database the user is working in.')
const SCHEMA_ARG = optionalName('Schema (PostgreSQL); defaults to the current schema.')
const PATTERN_ARG = optionalName(
  'Case-insensitive name filter: a substring, or a glob with * (orders*, *_log).'
)

/** Trimmed text or undefined. */
const clean = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

// ---------------------------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------------------------

const formatCount = (value: number | null | undefined): string | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value).toLocaleString('en-US')
    : null

function formatBytes(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit++
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`
}

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`

/** Text the model reads, with credentials masked for the data project's engine. */
type Masker = (text: string) => string

/**
 * Masks credentials in text bound for the model provider, with the masker of the engine's query
 * history: IDENTIFIED BY / PASSWORD literals, conninfo `password=`, credential arguments of
 * ClickHouse table functions and engines, and URL userinfo for SQL; pwd/password values,
 * positional passwords and URLs for mongosh.
 */
export function maskForAssistant(engine: DataEngine, text: string): string {
  return text ? redactUrlCredentials(maskForHistory(engine, text)) : text
}

/** How far past a cut text is still masked, so a credential straddling the cut is found. */
const MASK_LOOKAHEAD_CHARS = 2_000

/** The part of `text` worth masking before it is cut to `max`: the rest is cut anyway. */
const maskWindow = (text: string, max: number): string =>
  text.length > max + MASK_LOOKAHEAD_CHARS ? text.slice(0, max + MASK_LOOKAHEAD_CHARS) : text

/**
 * Masks the part of `text` that a cut to `max` characters keeps, plus a look-ahead so a password
 * the cut would split is still recognised: mask first, cut after. `dropped` counts the characters
 * past the look-ahead, left out unmasked (the cut removes them anyway).
 */
export function maskForCut(
  engine: DataEngine,
  text: string,
  max: number
): { text: string; dropped: number } {
  const window = maskWindow(text, max)
  return { text: maskForAssistant(engine, window), dropped: text.length - window.length }
}

/** `truncate` for server values: masked before the cut. */
const clipper =
  (mask: Masker) =>
  (text: string, max: number): string =>
    truncate(mask(maskWindow(text, max)), max)

/**
 * Caps a tool result, cutting at a line break and saying how much was left out (`dropped`:
 * characters already removed from the end).
 */
export function capText(text: string, max = TOOL_RESULT_MAX_CHARS, dropped = 0): string {
  if (text.length <= max && !dropped) return text
  const budget = max - 160
  const cut = text.length <= budget ? -1 : text.lastIndexOf('\n', budget)
  const head = text.slice(0, cut > budget / 2 ? cut : budget)
  return `${head}\n… [truncated: ${(text.length - head.length + dropped).toLocaleString('en-US')} more characters not shown. Narrow the request (a pattern, one table, a smaller sample) to see the rest.]`
}

function matcher(pattern: string | undefined): (name: string) => boolean {
  if (!pattern) return () => true
  const lower = pattern.toLowerCase()
  if (/[*%?]/.test(lower)) {
    const source = lower
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/[*%]/g, '.*')
      .replace(/\?/g, '.')
    const regex = new RegExp(`^${source}$`, 'i')
    return (name) => regex.test(name)
  }
  return (name) => name.toLowerCase().includes(lower)
}

const KIND_LABEL: Record<DataObjectKind, string> = {
  table: 'table',
  view: 'view',
  materialized_view: 'materialized view',
  foreign_table: 'foreign table',
  function: 'function',
  procedure: 'procedure',
  trigger: 'trigger',
  sequence: 'sequence',
  type: 'type',
  event: 'event',
  dictionary: 'dictionary',
  collection: 'collection'
}

function cellText(cell: DataCell, mask: Masker): string {
  if (cell === null) return 'NULL'
  if (isBinaryCell(cell)) return `<binary ${cell.len} bytes>`
  if (typeof cell === 'string') return JSON.stringify(clipper(mask)(cell, CELL_MAX_CHARS))
  return String(cell)
}

/** Shrinks a document for the prompt: long strings cut, long arrays trimmed, deep nesting elided. */
function compactValue(value: unknown, mask: Masker, depth = 0): unknown {
  if (typeof value === 'string') return clipper(mask)(value, CELL_MAX_CHARS)
  if (value === null || typeof value !== 'object') return value
  if (depth >= 6) return Array.isArray(value) ? '[…]' : '{…}'
  if (Array.isArray(value)) {
    const head = value.slice(0, 5).map((item) => compactValue(item, mask, depth + 1))
    return value.length > 5 ? [...head, `… ${value.length - 5} more`] : head
  }
  const out: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_NAME.test(key) ? '[redacted]' : compactValue(inner, mask, depth + 1)
  }
  return out
}

/** Splits `schema.table` / `db.table` / `db.schema.table` when no explicit parts were given. */
function resolveRef(
  engine: DataEngine,
  table: string,
  explicit: { database?: string; schema?: string },
  ctx: AssistantToolContext,
  kind?: DataObjectKind
): DataObjectRef {
  let name = table.trim()
  let database = explicit.database
  let schema = explicit.schema
  if (!database && !schema && !name.startsWith('"') && !name.startsWith('`')) {
    const parts = name.split('.')
    if (engine === 'postgres' && parts.length === 2) [schema, name] = parts
    else if (engine === 'postgres' && parts.length === 3) [database, schema, name] = parts
    else if (engine !== 'postgres' && engine !== 'mongodb' && parts.length === 2) {
      ;[database, name] = parts
    }
  }
  name = name.replace(/^["`[](.*)["`\]]$/, '$1')
  const ref: DataObjectRef = { name }
  const db = database ?? ctx.database
  if (db) ref.database = db
  const sch = engine === 'postgres' ? (schema ?? ctx.schema) : schema
  if (sch) ref.schema = sch
  if (kind) ref.kind = kind
  return ref
}

const refLabel = (ref: DataObjectRef): string =>
  [ref.database, ref.schema, ref.name].filter(Boolean).join('.')

function formatTableDetails(details: DataTableDetails, mask: Masker): string {
  const clip = clipper(mask)
  const lines: string[] = []
  const facts = [
    KIND_LABEL[details.kind] ?? details.kind,
    formatCount(details.rowEstimate) ? `~${formatCount(details.rowEstimate)} rows` : null,
    formatBytes(details.sizeBytes),
    details.engine ?? null
  ].filter(Boolean)
  lines.push(
    `${refLabel(details.ref)} (${facts.join(', ')})${details.comment ? ` — ${mask(details.comment)}` : ''}`
  )
  lines.push('columns:')
  const pk = new Set(details.primaryKey)
  for (const column of [...details.columns].sort((a, b) => a.ordinal - b.ordinal)) {
    const parts = [`  ${column.name} ${column.type}`, column.nullable ? 'NULL' : 'NOT NULL']
    if (column.isPrimaryKey || pk.has(column.name)) parts.push('PK')
    if (column.autoIncrement) parts.push('auto-increment')
    if (column.defaultValue !== undefined && column.defaultValue !== null) {
      // A default of a credential-looking column is a credential (api_token DEFAULT '…').
      parts.push(
        `DEFAULT ${SENSITIVE_NAME.test(column.name) ? '[redacted]' : clip(column.defaultValue, 80)}`
      )
    }
    if (column.extra) parts.push(`[${clip(column.extra, 80)}]`)
    lines.push(parts.join(' ') + (column.comment ? `  -- ${clip(column.comment, 120)}` : ''))
  }
  if (details.primaryKey.length) lines.push(`primary key: (${details.primaryKey.join(', ')})`)
  const indexes = details.indexes.filter((index) => !index.primary)
  if (indexes.length) {
    lines.push('indexes:')
    for (const index of indexes) {
      lines.push(
        `  ${index.name} (${index.columns.join(', ')})${index.unique ? ' UNIQUE' : ''}${index.type ? ` ${index.type}` : ''}`
      )
    }
  }
  if (details.foreignKeys.length) {
    lines.push('foreign keys:')
    for (const fk of details.foreignKeys) {
      const target = [fk.refDatabase, fk.refSchema, fk.refTable].filter(Boolean).join('.')
      const actions = [
        fk.onDelete ? `ON DELETE ${fk.onDelete}` : null,
        fk.onUpdate ? `ON UPDATE ${fk.onUpdate}` : null
      ].filter(Boolean)
      lines.push(
        `  (${fk.columns.join(', ')}) → ${target}(${fk.refColumns.join(', ')})${actions.length ? ` ${actions.join(' ')}` : ''}`
      )
    }
  }
  if (details.triggers.length) {
    lines.push(`triggers: ${details.triggers.map((trigger) => trigger.name).join(', ')}`)
  }
  for (const property of details.properties ?? []) {
    lines.push(`${property.label}: ${clip(property.value, 300)}`)
  }
  return lines.join('\n')
}

/** Rows (SQL) or documents (Mongo) of a sample, sensitive columns redacted. */
function formatSample(
  output: DataStatementOutput,
  label: string,
  mask: Masker
): AssistantToolOutput {
  if (output.kind === 'rows') {
    if (!output.rows.length) return { text: `${label}: no rows.`, summary: 'no rows' }
    const sensitive = output.columns.map((column) => SENSITIVE_NAME.test(column.name))
    const lines = output.rows.map((row) => {
      const cells = output.columns.map((column, i) =>
        sensitive[i]
          ? `${column.name}: [redacted]`
          : `${column.name}: ${cellText(row[i] ?? null, mask)}`
      )
      return `{ ${cells.join(', ')} }`
    })
    const redacted = sensitive.filter(Boolean).length
    return {
      text: [
        `${label}: ${output.rows.length} sample row(s)`,
        ...lines,
        redacted ? `(${redacted} sensitive-looking column(s) redacted)` : ''
      ]
        .filter(Boolean)
        .join('\n'),
      summary: `${output.rows.length} rows`
    }
  }
  if (output.kind === 'documents') {
    if (!output.documents.length) {
      return { text: `${label}: no documents.`, summary: 'no documents' }
    }
    const lines = output.documents.map((document) => JSON.stringify(compactValue(document, mask)))
    return {
      text: [`${label}: ${output.documents.length} sample document(s)`, ...lines].join('\n'),
      summary: `${output.documents.length} documents`
    }
  }
  return { text: `${label}: no sample available.`, summary: 'no sample' }
}

function formatMongoSchema(
  response: MongoSchemaResponse,
  label: string,
  withValues: boolean,
  mask: Masker
): string {
  const clip = clipper(mask)
  const lines: string[] = []
  const count = formatCount(response.count)
  lines.push(
    `${label} — ${count ? `~${count} documents, ` : ''}sampled ${response.sampleSize} document(s)`
  )
  if (!response.fields.length) lines.push('(no fields found: the collection may be empty)')
  for (const field of response.fields) {
    const types = field.types
      .map((type) =>
        field.types.length > 1 ? `${type.type} ${Math.round(type.probability * 100)}%` : type.type
      )
      .join(' | ')
    const presence =
      field.probability < 0.999 ? ` [in ${Math.round(field.probability * 100)}% of documents]` : ''
    let line = `  ${field.path}: ${types}${presence}`
    if (withValues && field.sampleValues?.length && !SENSITIVE_NAME.test(field.path)) {
      line += `  e.g. ${field.sampleValues
        .slice(0, 3)
        .map((value) => clip(value, 60))
        .join(', ')}`
    }
    lines.push(line)
  }
  if (response.validator) {
    lines.push(`validator: ${clip(JSON.stringify(response.validator), 1_500)}`)
  }
  return lines.join('\n')
}

function formatMongoIndex(index: MongoIndexInfo, mask: Masker): string {
  const flags = [
    index.unique ? 'unique' : null,
    index.sparse ? 'sparse' : null,
    index.hidden ? 'hidden' : null,
    typeof index.ttlSeconds === 'number' ? `TTL ${index.ttlSeconds}s` : null,
    index.partialFilterExpression
      ? `partial ${clipper(mask)(JSON.stringify(index.partialFilterExpression), 200)}`
      : null
  ].filter(Boolean)
  return `  ${index.name} ${JSON.stringify(index.keys)}${flags.length ? ` (${flags.join(', ')})` : ''}`
}

// ---------------------------------------------------------------------------------------------
// Time (relative dates: "since yesterday" needs today's date in the user's zone)
// ---------------------------------------------------------------------------------------------

export function resolveTimeZone(timeZone: string | undefined): string {
  if (timeZone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone }).format(0)
      return timeZone
    } catch {
      // Unknown zone: fall through.
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  weekday: string
  offsetMinutes: number
}

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    weekday: 'long'
  }).formatToParts(date)
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '0'
  const year = Number(get('year'))
  const month = Number(get('month'))
  const day = Number(get('day'))
  const hour = Number(get('hour')) % 24
  const minute = Number(get('minute'))
  const second = Number(get('second'))
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second)
  const offsetMinutes = Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60_000)
  return { year, month, day, hour, minute, second, weekday: get('weekday'), offsetMinutes }
}

const pad = (value: number, width = 2): string => String(Math.abs(value)).padStart(width, '0')

function offsetText(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+'
  return `${sign}${pad(Math.floor(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`
}

/** `2026-10-23T14:05:00+03:00` for `date` in `timeZone`. */
export function formatZonedIso(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone)
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${offsetText(p.offsetMinutes)}`
}

/** Local midnight `daysBack` days before `date`'s local day, as ISO with that day's offset. */
function zonedDayStart(date: Date, timeZone: string, daysBack: number): string {
  const p = zonedParts(date, timeZone)
  const noon = new Date(Date.UTC(p.year, p.month - 1, p.day - daysBack, 12))
  const day = zonedParts(noon, timeZone)
  return `${day.year}-${pad(day.month)}-${pad(day.day)}T00:00:00${offsetText(day.offsetMinutes)}`
}

/** One line for the system prompt: `2026-10-23T14:05:00+03:00 (Asia/Jerusalem), Friday`. */
export function describeNow(now: Date, timeZone: string): string {
  return `${formatZonedIso(now, timeZone)} (${timeZone}), ${zonedParts(now, timeZone).weekday}`
}

// ---------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------

const listDatabases = defineTool({
  name: 'list_databases',
  description: 'List the databases on this server (the current one is marked).',
  signature: '{}',
  shape: {},
  run: async (_args, ctx) => {
    const databases = await ctx.service.databases(ctx.dataProjectId)
    if (!databases.length)
      return { text: 'No databases are visible to this user.', summary: 'none' }
    const shown = databases.slice(0, LIST_MAX_ITEMS)
    const lines = shown.map((db) => {
      const notes = [
        db.name === ctx.database ? 'current' : null,
        db.isSystem ? 'system' : null,
        formatBytes(db.sizeBytes)
      ].filter(Boolean)
      return `  ${db.name}${notes.length ? ` (${notes.join(', ')})` : ''}`
    })
    if (databases.length > shown.length) {
      lines.push(`  … ${databases.length - shown.length} more`)
    }
    return {
      text: [`Databases (${databases.length}):`, ...lines].join('\n'),
      summary: `${databases.length} databases`
    }
  }
})

function listRelations(
  objects: DataObjectInfo[],
  pattern: string | undefined,
  options: { qualify: boolean; mask: Masker }
): { lines: string[]; shown: number; total: number; others: string } {
  const matches = matcher(pattern)
  const relations = objects.filter((o) => RELATION_KINDS.has(o.kind) && matches(o.name))
  const otherCounts = new Map<string, number>()
  for (const object of objects) {
    if (RELATION_KINDS.has(object.kind)) continue
    const label = KIND_LABEL[object.kind] ?? object.kind
    otherCounts.set(label, (otherCounts.get(label) ?? 0) + 1)
  }
  const shown = relations.slice(0, LIST_MAX_ITEMS)
  const lines = shown.map((object) => {
    const name = options.qualify && object.schema ? `${object.schema}.${object.name}` : object.name
    const facts = [
      object.kind === 'table' || object.kind === 'collection'
        ? (object.engine ?? null)
        : KIND_LABEL[object.kind],
      formatCount(object.rowEstimate)
        ? `~${formatCount(object.rowEstimate)} ${object.kind === 'collection' ? 'docs' : 'rows'}`
        : null,
      formatBytes(object.sizeBytes)
    ].filter(Boolean)
    const comment = object.comment ? ` — ${clipper(options.mask)(object.comment, 120)}` : ''
    return `  ${name}${facts.length ? ` (${facts.join(', ')})` : ''}${comment}`
  })
  if (relations.length > shown.length) {
    lines.push(`  … ${relations.length - shown.length} more (narrow with a pattern)`)
  }
  const others = [...otherCounts.entries()].map(([label, n]) => `${n} ${label}(s)`).join(', ')
  return { lines, shown: shown.length, total: relations.length, others }
}

const listTables = defineTool({
  name: 'list_tables',
  description:
    'List the tables and views of a database (and schema), optionally filtered by a name pattern.',
  signature: '{ database?: string, schema?: string, pattern?: string }',
  shape: { database: DATABASE_ARG, schema: SCHEMA_ARG, pattern: PATTERN_ARG },
  run: async (args, ctx) => {
    const database = clean(args.database) ?? ctx.database
    const schema = ctx.engine === 'postgres' ? (clean(args.schema) ?? ctx.schema) : undefined
    const pattern = clean(args.pattern)
    const listing = await ctx.service.objects(ctx.dataProjectId, database, schema)
    const { lines, total, others } = listRelations(listing.objects, pattern, {
      qualify: ctx.engine === 'postgres',
      mask: (text) => maskForAssistant(ctx.engine, text)
    })
    const where = [database ? `database ${database}` : null, schema ? `schema ${schema}` : null]
      .filter(Boolean)
      .join(', ')
    const header = `Tables and views${where ? ` in ${where}` : ''}${pattern ? ` matching "${pattern}"` : ''}: ${total}`
    const footer = [
      others ? `Also in this ${schema ? 'schema' : 'database'}: ${others} (not listed).` : null,
      listing.schemas?.length ? `Schemas in this database: ${listing.schemas.join(', ')}.` : null
    ].filter(Boolean)
    return {
      text: [header, ...(total ? lines : ['  (none)']), ...footer].join('\n'),
      summary: `${total} tables`
    }
  }
})

const describeTable = defineTool({
  name: 'describe_table',
  description:
    'Columns (types, nullability, defaults, primary key), indexes, foreign keys and engine facts of one table or view.',
  signature: '{ table: string, schema?: string, database?: string }',
  shape: {
    table: nameArg('Table or view name (schema.table is accepted).'),
    schema: SCHEMA_ARG,
    database: DATABASE_ARG
  },
  run: async (args, ctx) => {
    const ref = resolveRef(
      ctx.engine,
      args.table,
      { database: clean(args.database), schema: clean(args.schema) },
      ctx
    )
    const details = await ctx.service.describe(ctx.dataProjectId, ref)
    return {
      text: formatTableDetails(details, (text) => maskForAssistant(ctx.engine, text)),
      summary: `${details.columns.length} columns`
    }
  }
})

const getTableDdl = defineTool({
  name: 'get_table_ddl',
  description: 'The CREATE statement of one table or view (as the server reports it).',
  signature: '{ table: string, schema?: string, database?: string }',
  shape: {
    table: nameArg('Table or view name (schema.table is accepted).'),
    schema: SCHEMA_ARG,
    database: DATABASE_ARG
  },
  run: async (args, ctx) => {
    const ref = resolveRef(
      ctx.engine,
      args.table,
      { database: clean(args.database), schema: clean(args.schema) },
      ctx
    )
    // Server DDL can embed credentials (FEDERATED CONNECTION='mysql://u:pw@…', dblink conninfo
    // in a view, ClickHouse engine arguments): masked here, and again by the toolbox.
    const ddl = (await ctx.service.ddl(ctx.dataProjectId, ref)).trim()
    if (!ddl) throw new ToolInputError(`No DDL is available for ${refLabel(ref)}.`)
    return { text: maskForAssistant(ctx.engine, ddl), summary: `${ddl.split('\n').length} lines` }
  }
})

const searchColumns = defineTool({
  name: 'search_columns',
  description:
    'Find columns by name across every table of a database (e.g. "email", "*_at", "created*"). Returns table.column and type.',
  signature: '{ pattern: string, database?: string }',
  shape: {
    pattern: nameArg('Column name substring or glob with * (case-insensitive).'),
    database: DATABASE_ARG
  },
  run: async (args, ctx) => {
    const database = clean(args.database) ?? ctx.database
    const pattern = args.pattern.trim()
    const matches = matcher(pattern)
    const schema = await ctx.service.completionSchema(ctx.dataProjectId, database)
    const found: string[] = []
    let total = 0
    for (const table of schema.tables) {
      const tableName = table.schema ? `${table.schema}.${table.name}` : table.name
      for (const column of table.columns) {
        if (!matches(column.name) && !matches(`${table.name}.${column.name}`)) continue
        total++
        if (found.length < SEARCH_MAX_MATCHES) {
          found.push(
            `  ${tableName}.${column.name} ${column.type}${table.kind === 'table' ? '' : ` (${KIND_LABEL[table.kind] ?? table.kind})`}`
          )
        }
      }
    }
    const lines = [
      `Columns matching "${pattern}"${database ? ` in ${database}` : ''}: ${total}`,
      ...(found.length ? found : ['  (none)'])
    ]
    if (total > found.length)
      lines.push(`  … ${total - found.length} more (use a narrower pattern)`)
    if (schema.truncated) {
      lines.push('(The schema snapshot is partial on this large database: also try list_tables.)')
    }
    return { text: lines.join('\n'), summary: `${total} matches` }
  }
})

const sampleRows = defineTool({
  name: 'sample_rows',
  description: `Up to ${SAMPLE_LIMIT_MAX} sample rows of a table, to see real value formats (status codes, date formats, JSON shapes). Use sparingly.`,
  signature: `{ table: string, schema?: string, database?: string, limit?: number (1-${SAMPLE_LIMIT_MAX}) }`,
  readsData: true,
  shape: {
    table: nameArg('Table or view name (schema.table is accepted).'),
    schema: SCHEMA_ARG,
    database: DATABASE_ARG,
    limit: z.number().int().min(1).max(1_000).nullish().describe(`Rows, 1-${SAMPLE_LIMIT_MAX}.`)
  },
  run: async (args, ctx) => {
    if (!ctx.allowDataAccess) {
      throw new ToolInputError('Sampling data is not allowed for this connection.')
    }
    const ref = resolveRef(
      ctx.engine,
      args.table,
      { database: clean(args.database), schema: clean(args.schema) },
      ctx
    )
    const limit = Math.min(Math.max(args.limit ?? 3, 1), SAMPLE_LIMIT_MAX)
    const output = await ctx.service.sampleRows(ctx.dataProjectId, ref, limit)
    return formatSample(output, refLabel(ref), (text) => maskForAssistant(ctx.engine, text))
  }
})

const getCurrentTime = defineTool({
  name: 'get_current_time',
  description:
    "The current date and time in the user's time zone, with today's and yesterday's start (for relative dates).",
  signature: '{}',
  shape: {},
  run: async (_args, ctx) => {
    const now = ctx.now()
    const text = [
      `now: ${describeNow(now, ctx.timeZone)}`,
      `now (UTC): ${now.toISOString()}`,
      `today starts: ${zonedDayStart(now, ctx.timeZone, 0)}`,
      `yesterday starts: ${zonedDayStart(now, ctx.timeZone, 1)}`,
      `7 days ago starts: ${zonedDayStart(now, ctx.timeZone, 7)}`
    ].join('\n')
    return { text, summary: formatZonedIso(now, ctx.timeZone).slice(0, 16).replace('T', ' ') }
  }
})

function requireMongoDatabase(
  args: { database?: string | null },
  ctx: AssistantToolContext
): string {
  const database = clean(args.database) ?? ctx.database
  if (!database) {
    throw new ToolInputError(
      'No database is selected. Call list_databases and pass `database` explicitly.'
    )
  }
  return database
}

const listCollections = defineTool({
  name: 'list_collections',
  description: 'List the collections (and views) of a database, optionally filtered by a pattern.',
  signature: '{ database?: string, pattern?: string }',
  shape: { database: DATABASE_ARG, pattern: PATTERN_ARG },
  run: async (args, ctx) => {
    const database = requireMongoDatabase(args, ctx)
    const pattern = clean(args.pattern)
    const listing = await ctx.service.objects(ctx.dataProjectId, database)
    const { lines, total } = listRelations(listing.objects, pattern, {
      qualify: false,
      mask: (text) => maskForAssistant(ctx.engine, text)
    })
    return {
      text: [
        `Collections in ${database}${pattern ? ` matching "${pattern}"` : ''}: ${total}`,
        ...(total ? lines : ['  (none)'])
      ].join('\n'),
      summary: `${total} collections`
    }
  }
})

const COLLECTION_ARG = (): z.ZodString => nameArg('Collection name.')

const inferCollectionSchema = defineTool({
  name: 'infer_collection_schema',
  description:
    'Field paths (dotted, e.g. items.productId) and BSON types of a collection, inferred from a sample of its documents, with how often each field is present.',
  signature: `{ collection: string, database?: string, sampleSize?: number (1-${SCHEMA_SAMPLE_MAX}) }`,
  shape: {
    collection: COLLECTION_ARG(),
    database: DATABASE_ARG,
    sampleSize: z
      .number()
      .int()
      .min(1)
      .max(10_000)
      .nullish()
      .describe(
        `Documents to sample, up to ${SCHEMA_SAMPLE_MAX} (default ${SCHEMA_SAMPLE_DEFAULT}).`
      )
  },
  run: async (args, ctx) => {
    const database = requireMongoDatabase(args, ctx)
    const collection = args.collection.trim()
    const sampleSize = Math.min(
      Math.max(args.sampleSize ?? SCHEMA_SAMPLE_DEFAULT, 1),
      SCHEMA_SAMPLE_MAX
    )
    const response = await ctx.service.mongo.schema({
      dataProjectId: ctx.dataProjectId,
      database,
      collection,
      sampleSize
    })
    return {
      text: formatMongoSchema(response, `${database}.${collection}`, ctx.allowDataAccess, (text) =>
        maskForAssistant(ctx.engine, text)
      ),
      summary: `${response.fields.length} fields`
    }
  }
})

const listIndexes = defineTool({
  name: 'list_indexes',
  description: 'The indexes of a collection (key spec, unique/sparse/TTL/partial).',
  signature: '{ collection: string, database?: string }',
  shape: { collection: COLLECTION_ARG(), database: DATABASE_ARG },
  run: async (args, ctx) => {
    const database = requireMongoDatabase(args, ctx)
    const collection = args.collection.trim()
    const indexes = await ctx.service.mongo.indexes(ctx.dataProjectId, database, collection)
    return {
      text: [
        `Indexes of ${database}.${collection}: ${indexes.length}`,
        ...indexes.map((index) =>
          formatMongoIndex(index, (text) => maskForAssistant(ctx.engine, text))
        )
      ].join('\n'),
      summary: `${indexes.length} indexes`
    }
  }
})

const sampleDocuments = defineTool({
  name: 'sample_documents',
  description: `Up to ${SAMPLE_LIMIT_MAX} sample documents of a collection (long strings and arrays shortened), to see real value formats. Use sparingly.`,
  signature: `{ collection: string, database?: string, limit?: number (1-${SAMPLE_LIMIT_MAX}) }`,
  readsData: true,
  shape: {
    collection: COLLECTION_ARG(),
    database: DATABASE_ARG,
    limit: z
      .number()
      .int()
      .min(1)
      .max(1_000)
      .nullish()
      .describe(`Documents, 1-${SAMPLE_LIMIT_MAX}.`)
  },
  run: async (args, ctx) => {
    if (!ctx.allowDataAccess) {
      throw new ToolInputError('Sampling data is not allowed for this connection.')
    }
    const database = requireMongoDatabase(args, ctx)
    const collection = args.collection.trim()
    const limit = Math.min(Math.max(args.limit ?? 3, 1), SAMPLE_LIMIT_MAX)
    const output = await ctx.service.sampleRows(
      ctx.dataProjectId,
      { database, name: collection, kind: 'collection' },
      limit
    )
    return formatSample(output, `${database}.${collection}`, (text) =>
      maskForAssistant(ctx.engine, text)
    )
  }
})

function proposeQueryTool(engine: DataEngine): AssistantTool {
  const mongo = dataEngineFamily(engine) === 'document'
  const label = DATA_ENGINE_INFO[engine].label
  return defineTool({
    name: PROPOSE_QUERY_TOOL,
    description: mongo
      ? 'Deliver the final query: it is placed into the user\'s editor and is NOT executed. `query` is mongosh syntax, e.g. db.orders.find({ status: "paid" }).sort({ createdAt: -1 }) or db.orders.aggregate([...]). Call it exactly once, then stop.'
      : `Deliver the final query: it is placed into the user's editor and is NOT executed. \`query\` is ${label} SQL (several statements may be separated by semicolons). Call it exactly once, then stop.`,
    signature: '{ query: string, explanation: string, is_write: boolean, database?: string }',
    shape: {
      query: z
        .string()
        .min(1)
        .max(QUERY_MAX_CHARS)
        .describe('The complete query text, no code fences.'),
      explanation: z
        .string()
        .max(EXPLANATION_MAX_CHARS * 2)
        .describe(
          '1-3 sentences: what it does and any assumption (e.g. calendar day vs last 24 h).'
        ),
      is_write: z
        .boolean()
        .describe('True when it changes data or schema (INSERT/UPDATE/DELETE/DDL, Mongo writes).'),
      database: DATABASE_ARG
    },
    run: async () => {
      // The toolbox handles propose_query itself (validation + the proposal event).
      throw new Error('propose_query is handled by the toolbox')
    }
  })
}

/** The tools offered for a data project (data-reading tools only with allowAiDataAccess). */
export function buildAssistantTools(input: {
  engine: DataEngine
  allowDataAccess: boolean
}): AssistantTool[] {
  const tools =
    dataEngineFamily(input.engine) === 'document'
      ? [
          listDatabases,
          listCollections,
          inferCollectionSchema,
          listIndexes,
          sampleDocuments,
          getCurrentTime
        ]
      : [
          listDatabases,
          listTables,
          describeTable,
          getTableDdl,
          searchColumns,
          sampleRows,
          getCurrentTime
        ]
  return [
    ...tools.filter((tool) => input.allowDataAccess || !tool.readsData),
    proposeQueryTool(input.engine)
  ]
}

// ---------------------------------------------------------------------------------------------
// Toolbox: one per run; emits tool_start/tool_end/proposal, enforces caps and timeouts
// ---------------------------------------------------------------------------------------------

export interface ToolCallResult {
  ok: boolean
  /** What the model reads back. */
  text: string
  /** A query was delivered: the runner should stop. */
  final?: boolean
}

export interface AssistantToolboxOptions {
  ctx: AssistantToolContext
  emit: (event: DataAssistantEvent) => void
  validateProposal?: ProposalValidator
}

function abortErrorOf(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new AssistantAbort('cancelled')
}

function withTimeout<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new ToolInputError(`The database did not answer within ${Math.round(ms / 1000)} s.`)
        ),
      ms
    )
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortErrorOf(signal))
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Drops null-valued keys so `.nullish()` and `.optional()` agree for every provider. */
function stripNulls(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== null))
}

/** What the tool chip shows: short args, never a whole query. */
function displayArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name === PROPOSE_QUERY_TOOL) {
    return Object.fromEntries(
      Object.entries(args).filter(([key]) => key === 'is_write' || key === 'database')
    )
  }
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [
      key,
      typeof value === 'string' ? truncate(value, ARG_DISPLAY_MAX_CHARS) : value
    ])
  )
}

/** First line of an error, masked (a server error can echo the statement or a definition). */
function errorText(error: unknown, engine: DataEngine): string {
  const message = error instanceof Error ? error.message : String(error)
  const masked = maskForAssistant(engine, maskWindow(message, 500))
  return truncate(masked.split('\n')[0]?.trim() || 'Unknown error', 500)
}

/** Models sometimes wrap the query in a Markdown fence despite being told not to. */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  const fenced = /^```[\w-]*\s*\n([\s\S]*?)\n?```$/.exec(trimmed)
  return (fenced ? fenced[1] : trimmed).trim()
}

function zodIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`)
    .join('; ')
}

export class AssistantToolbox {
  readonly tools: AssistantTool[]
  /** The delivered query, once propose_query succeeded. */
  proposal: DataQueryProposal | null = null
  /** Tool calls made so far (including rejected ones). */
  calls = 0
  private readonly byName: Map<string, AssistantTool>
  private callSeq = 0
  private rejections = 0

  constructor(private readonly options: AssistantToolboxOptions) {
    this.tools = buildAssistantTools({
      engine: options.ctx.engine,
      allowDataAccess: options.ctx.allowDataAccess
    })
    this.byName = new Map(this.tools.map((tool) => [tool.name, tool]))
  }

  get toolNames(): string[] {
    return this.tools.map((tool) => tool.name)
  }

  get language(): 'sql' | 'mongo' {
    return dataEngineFamily(this.options.ctx.engine) === 'document' ? 'mongo' : 'sql'
  }

  /**
   * Runs one tool call. Never throws for tool failures (the model reads the error and adapts);
   * throws only when the run was aborted.
   */
  async call(rawName: string, rawArgs: unknown): Promise<ToolCallResult> {
    const { ctx, emit } = this.options
    if (ctx.signal.aborted) throw abortErrorOf(ctx.signal)
    const name = rawName.replace(new RegExp(`^mcp__${ASSISTANT_MCP_SERVER}__`), '').trim()
    const tool = this.byName.get(name)
    if (!tool) {
      return {
        ok: false,
        text: `Unknown tool "${rawName}". Available tools: ${this.toolNames.join(', ')}.`
      }
    }
    if (this.proposal) {
      return {
        ok: true,
        final: true,
        text: 'A query was already delivered to the editor. Stop now.'
      }
    }

    const args = stripNulls(isPlainObject(rawArgs) ? rawArgs : {})
    const callId = `call-${++this.callSeq}`
    const startedAt = Date.now()
    this.calls++
    emit({ type: 'tool_start', callId, name: tool.name, args: displayArgs(tool.name, args) })
    const end = (ok: boolean, summary: string): void =>
      emit({ type: 'tool_end', callId, ok, summary, ms: Date.now() - startedAt })

    const parsed = z.object(tool.shape).safeParse(args)
    if (!parsed.success) {
      end(false, 'invalid arguments')
      return {
        ok: false,
        text: `Invalid arguments for ${tool.name}: ${zodIssues(parsed.error)}. Expected ${tool.signature}.`
      }
    }

    if (tool.name === PROPOSE_QUERY_TOOL) {
      return this.propose(parsed.data as Record<string, unknown>, end)
    }

    try {
      const output = await withTimeout(
        tool.run(parsed.data as Record<string, unknown>, ctx),
        TOOL_TIMEOUT_MS,
        ctx.signal
      )
      end(true, output.summary)
      // The last line of defence: whatever a tool formatted, the model reads it masked.
      const masked = maskForCut(ctx.engine, output.text, TOOL_RESULT_MAX_CHARS)
      return { ok: true, text: capText(masked.text, TOOL_RESULT_MAX_CHARS, masked.dropped) }
    } catch (error) {
      if (ctx.signal.aborted) throw abortErrorOf(ctx.signal)
      const message = errorText(error, ctx.engine)
      end(false, truncate(message, 80))
      return { ok: false, text: `Error: ${message}` }
    }
  }

  private async propose(
    args: Record<string, unknown>,
    end: (ok: boolean, summary: string) => void
  ): Promise<ToolCallResult> {
    const { ctx, emit, validateProposal } = this.options
    const query = stripCodeFence(String(args.query ?? ''))
    let explanation = truncate(String(args.explanation ?? '').trim(), EXPLANATION_MAX_CHARS)
    const database = clean(args.database) ?? ctx.database
    let isWrite = args.is_write === true
    if (!query) {
      end(false, 'empty query')
      return { ok: false, text: 'The query is empty. Call propose_query with the full query text.' }
    }

    const language = this.language
    let verdict: Awaited<ReturnType<ProposalValidator>> = { ok: true, isWrite: null }
    if (validateProposal) {
      try {
        verdict = await validateProposal({
          language,
          dialect: sqlDialectOf(ctx.engine),
          engine: ctx.engine,
          query
        })
      } catch {
        // A validator that cannot run must not block the delivery.
        verdict = { ok: true, isWrite: null }
      }
    }
    if (ctx.signal.aborted) throw abortErrorOf(ctx.signal)

    if (!verdict.ok) {
      this.rejections++
      if (this.rejections <= MAX_PROPOSAL_REJECTIONS) {
        end(false, 'query did not parse')
        return {
          ok: false,
          text: `The query was NOT delivered: ${verdict.error}. Fix it and call propose_query again.`
        }
      }
      explanation =
        `${explanation}\n\nNote: the app could not parse this query (${verdict.error}). Review it before running.`.trim()
    } else if (verdict.isWrite === true) {
      // The classifier is the authority on writes; the model's own claim can only add caution.
      isWrite = true
    }

    this.proposal = {
      language,
      query,
      explanation,
      isWrite,
      ...(database ? { database } : {})
    }
    end(true, isWrite ? 'write query' : 'query ready')
    emit({ type: 'proposal', proposal: this.proposal })
    return {
      ok: true,
      final: true,
      text: "Delivered to the user's editor (it was not executed). You are done: stop now without calling more tools."
    }
  }
}

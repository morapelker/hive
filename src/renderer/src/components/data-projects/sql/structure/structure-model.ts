// The structure editor's model: what the user staged (column edits, added / dropped columns,
// created / dropped indexes), what each engine allows, and the exact DDL that applies it.
//
// Staging is relative to the described table and stores only what the user changed:
//
//   changes      original column name → the edited fields (name, type, nullable, default,
//                comment; PostgreSQL also `using` for a type change). A field set back to the
//                described value is removed, so "no change" is never staged.
//   drops        original names of dropped columns
//   adds         new columns (draft + position: end / first / after a column — MySQL, ClickHouse)
//   dropIndexes  names of described indexes to drop
//   addIndexes   new indexes; their columns are column keys (`b:<original name>` / `n:<new id>`)
//                resolved to the final names when the DDL is built, so renaming a column after
//                staging an index on it keeps the index right
//
// Statement order: drop indexes → drop columns → column changes (in column order: rename first,
// then type, nullability, default, comment) → add columns → create indexes. PostgreSQL, SQLite
// and ClickHouse get one statement per action; MySQL / MariaDB get ONE `ALTER TABLE` holding every
// action (one table rebuild, and MySQL DDL is atomic per statement, so a failure changes nothing).
// Every statement is checked to split as exactly one statement with the shared splitter, so a
// typed type or default can never smuggle in a second statement (the server re-splits the text).
//
// Each statement carries the staged operations it applies. When a run stops at a failing
// statement, `rebaseAfterApply` removes what the statements before it applied (a rename moves the
// rest of that column's edits to the new name), and the diff against the refreshed table yields
// only what is left.
//
// MySQL / MariaDB string literals follow the session's NO_BACKSLASH_ESCAPES mode
// (`model.backslashEscapes`): comments are quoted for it, typed defaults are checked with it, and
// the literals kept from SHOW CREATE TABLE (always backslash-escaped) are rewritten into it.

import type {
  DataColumnInfo,
  DataIndexInfo,
  DataObjectKind,
  DataSafeMode,
  DataTableDetails,
  SqlDialect
} from '@shared/data-projects/types'
import {
  lexSql,
  qualifiedSqlName,
  quoteSqlIdentifier,
  quoteSqlString,
  splitSqlStatements,
  unquoteSqlIdentifier,
  type SqlLexOptions
} from '@shared/sql'
import type { ParsedTableDdl } from './ddl-parse'
import {
  buildMysqlColumnDefinition,
  isMysqlGenerated,
  mysqlDefaultExpression,
  mysqlTypeOf,
  parseMysqlColumnDefinition,
  restateMysqlLiterals,
  type MysqlColumnDefinition
} from './mysql-column'
import { defaultNewColumnType, isClickhouseNullable } from './type-catalog'

// ---------------------------------------------------------------------------------------------
// Staged state
// ---------------------------------------------------------------------------------------------

export interface ColumnDraft {
  name: string
  type: string
  nullable: boolean
  /** Raw SQL after DEFAULT ('' = no default). */
  defaultExpr: string
  /** '' = no comment. */
  comment: string
}

export type ColumnField = keyof ColumnDraft

/** `b:<original name>` for a described column, `n:<id>` for a new one. */
export type ColumnKey = string
export const baseKey = (name: string): ColumnKey => `b:${name}`
export const newKey = (id: string): ColumnKey => `n:${id}`

export type ColumnPosition =
  { kind: 'end' } | { kind: 'first' } | { kind: 'after'; column: ColumnKey }

export interface NewColumn {
  id: string
  draft: ColumnDraft
  position: ColumnPosition
}

export type ColumnChange = Partial<ColumnDraft> & {
  /** PostgreSQL: USING expression of a type change. */
  using?: string
}

export interface IndexColumnRef {
  key: ColumnKey
  /** MySQL / MariaDB prefix length (`col(10)`). */
  length?: number
}

export interface IndexDraft {
  id: string
  name: string
  columns: IndexColumnRef[]
  unique: boolean
  /** PostgreSQL access method (btree when unset). */
  method?: string
  /** ClickHouse: the indexed expression (defaults to the columns). */
  expression?: string
  /** ClickHouse data-skipping index type (minmax, set(100), bloom_filter, ...). */
  skipType?: string
  /** ClickHouse GRANULARITY. */
  granularity?: number
}

export interface StagedStructure {
  changes: Record<string, ColumnChange>
  drops: string[]
  adds: NewColumn[]
  dropIndexes: string[]
  addIndexes: IndexDraft[]
}

export const emptyStructure = (): StagedStructure => ({
  changes: {},
  drops: [],
  adds: [],
  dropIndexes: [],
  addIndexes: []
})

// ---------------------------------------------------------------------------------------------
// Model: the described table with per-dialect capabilities and locks
// ---------------------------------------------------------------------------------------------

export interface ServerInfo {
  mariadb: boolean
  /** [major, minor, patch] when the connection reported a version. */
  version: number[] | null
}

/** Reads `8.4.13`, `11.4.13-MariaDB-ubu2404`, `PostgreSQL 17.11`, `SQLite 3.51.0`, ... */
export function parseServerVersion(text: string | undefined, dialect: SqlDialect): ServerInfo {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text ?? '')
  return {
    mariadb: dialect === 'mariadb' || /mariadb/i.test(text ?? ''),
    version: match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null
  }
}

const atLeast = (version: number[], min: readonly number[]): boolean => {
  for (let i = 0; i < min.length; i++) {
    if ((version[i] ?? 0) !== min[i]) return (version[i] ?? 0) > min[i]
  }
  return true
}

/** Locks of one column: the reason each edit is unavailable (absent = allowed). */
export interface ColumnLocks {
  rename?: string
  type?: string
  nullable?: string
  default?: string
  comment?: string
  drop?: string
}

export interface BaseColumn {
  key: ColumnKey
  info: DataColumnInfo
  draft: ColumnDraft
  /** MySQL / MariaDB: the parsed definition from SHOW CREATE TABLE (null when unavailable). */
  mysql: MysqlColumnDefinition | null
  locks: ColumnLocks
}

export interface BaseIndex {
  info: DataIndexInfo
  /** PostgreSQL: the index of a named UNIQUE / EXCLUDE constraint (dropped with DROP CONSTRAINT). */
  constraint: boolean
  dropLock?: string
}

export interface StructureCaps {
  /** The whole structure is read-only (safe mode, views, engines that cannot be altered). */
  readOnly: string | null
  /** Column edits (add / change / drop) are off. */
  columns: string | null
  /** New columns are off (on top of `columns`). */
  addColumns: string | null
  /** Column comments exist (not SQLite). */
  comments: boolean
  /** ADD COLUMN … FIRST / AFTER (MySQL, MariaDB, ClickHouse). */
  positions: boolean
  /** ALTER COLUMN … TYPE … USING (PostgreSQL). */
  using: boolean
  /** Index edits are off. */
  indexes: string | null
  uniqueIndexes: boolean
  /** PostgreSQL access methods. */
  indexMethods: readonly string[] | null
  /** ClickHouse data-skipping indexes (expression + type + granularity). */
  skippingIndexes: boolean
  /** MySQL / MariaDB index prefix lengths. */
  prefixLengths: boolean
}

export interface StructureModel {
  dialect: SqlDialect
  /** The table as ALTER TABLE names it (PG: schema.name; others: database.name). */
  table: { database?: string; schema?: string; name: string }
  columns: BaseColumn[]
  indexes: BaseIndex[]
  caps: StructureCaps
  server: ServerInfo
  /**
   * MySQL / MariaDB: whether the session reads backslash escapes in string literals (false
   * under NO_BACKSLASH_ESCAPES). Always true for the other engines.
   */
  backslashEscapes: boolean
  /** Rows of the table as describe reported them (exact or estimated; null = unknown). */
  rows: number | null
}

export interface StructureModelInput {
  dialect: SqlDialect
  details: DataTableDetails
  /** The tab's ref (its database when describe omitted it). */
  ref: { database?: string; schema?: string; name: string; kind?: DataObjectKind }
  safeMode: DataSafeMode
  server: ServerInfo
  /** Parsed CREATE TABLE (null while loading, when it failed, or when it could not be read). */
  parsed: ParsedTableDdl | null
  ddlState: 'loading' | 'ready' | 'failed'
  /** MySQL / MariaDB: the session's backslash mode (false = NO_BACKSLASH_ESCAPES; default true). */
  backslashEscapes?: boolean
}

/** Lexer / quoting options for the model's literals (MySQL / MariaDB backslash mode). */
export const literalOptions = (model: {
  dialect: SqlDialect
  backslashEscapes: boolean
}): SqlLexOptions =>
  model.dialect === 'mysql' || model.dialect === 'mariadb'
    ? { backslashEscapes: model.backslashEscapes }
    : {}

export const PG_INDEX_METHODS: readonly string[] = [
  'btree',
  'hash',
  'gin',
  'gist',
  'brin',
  'spgist'
]

const KIND_READ_ONLY: Partial<Record<DataObjectKind, string>> = {
  view: 'A view’s columns come from its query: change the view definition in a query tab.',
  materialized_view:
    'A materialized view’s columns come from its query: recreate it in a query tab to change them.',
  foreign_table: 'Foreign tables are read-only here: alter them in a query tab.',
  dictionary: 'Dictionaries are read-only here: recreate the dictionary in a query tab.'
}

/** Why the whole structure is read-only, or null when it can be edited. */
export function structureReadOnlyReason(
  dialect: SqlDialect,
  details: DataTableDetails,
  safeMode: DataSafeMode
): string | null {
  if (safeMode === 'read-only') return 'Read-only mode: structure changes are off.'
  const kindReason = KIND_READ_ONLY[details.kind]
  if (kindReason) return kindReason
  if (details.kind !== 'table') return `A ${details.kind.replace('_', ' ')} cannot be altered here.`
  const engine = details.engine ?? ''
  if (dialect === 'sqlite' && /^(virtual|shadow)/i.test(engine))
    return `SQLite ${engine.split(':')[0]} tables cannot be altered.`
  if (dialect === 'clickhouse' && !/MergeTree$/.test(engine))
    return `Only MergeTree-family tables are altered here (this one uses the ${engine || 'unknown'} engine).`
  return null
}

const stripIndexColumn = (label: string): string => label.replace(/\s+(ASC|DESC)$/i, '')

const CH_KEY_EXTRAS = /\b(sorting key|partition key|sampling key)\b/

export function buildStructureModel(input: StructureModelInput): StructureModel {
  const { dialect, details, server, parsed } = input
  const mysqlFamily = dialect === 'mysql' || dialect === 'mariadb'
  const table = {
    ...(dialect === 'postgres'
      ? { schema: details.ref.schema ?? input.ref.schema }
      : { database: details.ref.database ?? input.ref.database }),
    name: details.ref.name || input.ref.name
  }
  const readOnly = structureReadOnlyReason(dialect, details, input.safeMode)
  const partitionOf = details.properties?.find((p) => p.label === 'Partition of')
  const version = server.version
  const sqliteRename = !version || atLeast(version, [3, 25, 0])
  const sqliteDrop = !version || atLeast(version, [3, 35, 0])
  const mysqlRenameColumn =
    !!version && (server.mariadb ? atLeast(version, [10, 5, 2]) : atLeast(version, [8, 0, 0]))
  const backslashEscapes = !mysqlFamily || input.backslashEscapes !== false
  const uniqueColumns = new Set<string>()
  for (const ix of details.indexes) {
    if (
      ix.unique &&
      !ix.primary &&
      dialect === 'sqlite' &&
      ix.type?.startsWith('unique constraint')
    )
      for (const c of ix.columns) uniqueColumns.add(stripIndexColumn(c))
  }

  const columns: BaseColumn[] = details.columns.map((info) => {
    const locks: ColumnLocks = {}
    let mysql: MysqlColumnDefinition | null = null
    const draft: ColumnDraft = {
      name: info.name,
      type: info.type,
      nullable: info.nullable,
      defaultExpr: info.defaultValue ?? '',
      comment: info.comment ?? ''
    }
    const extra = info.extra ?? ''
    switch (dialect) {
      case 'postgres': {
        const identity = /AS IDENTITY/.test(extra)
        const generated = /GENERATED ALWAYS AS \(/.test(extra)
        if (info.isPrimaryKey) locks.nullable = 'Primary key columns are always NOT NULL.'
        else if (identity) locks.nullable = 'Identity columns are always NOT NULL.'
        if (identity) locks.default = 'Identity column: its values come from its sequence.'
        else if (generated) locks.default = 'Generated column: its value comes from its expression.'
        break
      }
      case 'mysql':
      case 'mariadb': {
        const shown = parsed?.columns.get(info.name)
        // SHOW CREATE TABLE text is backslash-escaped whatever the session's mode.
        const text = shown && !backslashEscapes ? restateMysqlLiterals(shown, dialect) : shown
        mysql = text ? parseMysqlColumnDefinition(text, dialect, { backslashEscapes }) : null
        if (mysql) {
          draft.type = mysqlTypeOf(mysql) || info.type
          draft.defaultExpr = mysqlDefaultExpression(mysql)
        } else {
          draft.defaultExpr = info.defaultValue ?? ''
          const why =
            input.ddlState === 'loading'
              ? 'Reading the column definition (SHOW CREATE TABLE)…'
              : shown && text === null
                ? 'The column definition holds a NUL or Ctrl-Z character in a string, which cannot be restated while the session runs with NO_BACKSLASH_ESCAPES.'
                : 'The column definition could not be read (SHOW CREATE TABLE), and MODIFY COLUMN must restate all of it.'
          locks.type = why
          locks.nullable = why
          locks.default = why
          locks.comment = why
          if (!mysqlRenameColumn) locks.rename = why
        }
        if (info.isPrimaryKey) locks.nullable ??= 'Primary key columns are always NOT NULL.'
        if (mysql && isMysqlGenerated(mysql))
          locks.default ??= 'Generated column: its value comes from its expression.'
        if (info.autoIncrement) locks.default ??= 'AUTO_INCREMENT column: values are assigned.'
        break
      }
      case 'sqlite': {
        const why =
          'SQLite cannot change a column’s type, NOT NULL or default in place (ALTER TABLE only adds, renames and drops columns). Recreate the table to change it.'
        locks.type = why
        locks.nullable = why
        locks.default = why
        if (!sqliteRename) locks.rename = 'Renaming a column needs SQLite 3.25 or later.'
        if (!sqliteDrop) locks.drop = 'Dropping a column needs SQLite 3.35 or later.'
        else if (info.isPrimaryKey) locks.drop = 'SQLite cannot drop a primary key column.'
        else if (uniqueColumns.has(info.name))
          locks.drop = 'SQLite cannot drop a column with a UNIQUE constraint.'
        break
      }
      case 'clickhouse': {
        draft.nullable = isClickhouseNullable(info.type)
        const key = info.isPrimaryKey || CH_KEY_EXTRAS.test(extra)
        if (key) {
          const why = `Part of the ${CH_KEY_EXTRAS.exec(extra)?.[1] ?? 'primary key'}: ClickHouse cannot rename, retype or drop it.`
          locks.rename = why
          locks.type = why
          locks.nullable = why
          locks.drop = why
        }
        const kind = /\b(MATERIALIZED|ALIAS|EPHEMERAL)\b/.exec(extra)?.[1]
        if (kind) {
          locks.default = `${kind} column: change its expression in a query tab.`
          draft.defaultExpr = ''
        }
        break
      }
    }
    return { key: baseKey(info.name), info, draft, mysql, locks }
  })

  const constraintNames = parsed?.constraintNames ?? new Set<string>()
  const indexes: BaseIndex[] = details.indexes.map((info) => {
    let dropLock: string | undefined
    const constraint = dialect === 'postgres' && !info.primary && constraintNames.has(info.name)
    if (info.primary) {
      dropLock =
        dialect === 'clickhouse'
          ? 'The primary index follows the sorting key and cannot be dropped.'
          : 'Primary key: drop or change it in a query tab.'
    } else if (dialect === 'sqlite' && info.type?.startsWith('unique constraint')) {
      dropLock = 'Created by a UNIQUE constraint of the table: SQLite cannot drop it.'
    }
    return { info, constraint, ...(dropLock ? { dropLock } : {}) }
  })

  const caps: StructureCaps = {
    readOnly,
    columns:
      dialect === 'postgres' && partitionOf
        ? 'A partition takes its columns from the partitioned table: change them there.'
        : null,
    addColumns: null,
    comments: dialect !== 'sqlite',
    positions: mysqlFamily || dialect === 'clickhouse',
    using: dialect === 'postgres',
    indexes: null,
    uniqueIndexes: dialect !== 'clickhouse',
    indexMethods: dialect === 'postgres' ? PG_INDEX_METHODS : null,
    skippingIndexes: dialect === 'clickhouse',
    prefixLengths: mysqlFamily
  }
  return {
    dialect,
    table,
    columns,
    indexes,
    caps,
    server,
    backslashEscapes,
    rows: details.rowEstimate ?? null
  }
}

// ---------------------------------------------------------------------------------------------
// Staging operations (pure)
// ---------------------------------------------------------------------------------------------

const sameValue = (field: ColumnField, a: ColumnDraft[ColumnField], b: unknown): boolean =>
  field === 'nullable' ? a === b : String(a).trim() === String(b ?? '').trim()

/** Sets one field of a described column; the base value removes the edit. */
export function setColumnField<F extends ColumnField>(
  staged: StagedStructure,
  column: BaseColumn,
  field: F,
  value: ColumnDraft[F]
): StagedStructure {
  const name = column.info.name
  const change: ColumnChange = { ...staged.changes[name] }
  if (field === 'name' ? value === column.draft.name : sameValue(field, column.draft[field], value))
    delete change[field]
  else change[field] = value
  if (field === 'type' && change.type === undefined) delete change.using
  const changes = { ...staged.changes }
  if (Object.keys(change).length) changes[name] = change
  else delete changes[name]
  return { ...staged, changes }
}

/** PostgreSQL USING of a type change ('' removes it). */
export function setColumnUsing(
  staged: StagedStructure,
  name: string,
  using: string
): StagedStructure {
  const current = staged.changes[name]
  if (!current) return staged
  const change: ColumnChange = { ...current }
  if (using.trim()) change.using = using
  else delete change.using
  return { ...staged, changes: { ...staged.changes, [name]: change } }
}

export function toggleDropColumn(staged: StagedStructure, name: string): StagedStructure {
  const drops = staged.drops.includes(name)
    ? staged.drops.filter((d) => d !== name)
    : [...staged.drops, name]
  return { ...staged, drops }
}

/** Undoes every staged edit of a described column (changes and drop). */
export function revertColumn(staged: StagedStructure, name: string): StagedStructure {
  const changes = { ...staged.changes }
  delete changes[name]
  return { ...staged, changes, drops: staged.drops.filter((d) => d !== name) }
}

let idCounter = 0
export const nextStructureId = (prefix: string): string => `${prefix}${++idCounter}`

/** A free `new_column`, `new_column_2`, ... name among the final column names. */
function freeName(taken: Set<string>, base: string): string {
  if (!taken.has(base.toLowerCase())) return base
  for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`.toLowerCase())) return `${base}_${i}`
}

export function addNewColumn(
  staged: StagedStructure,
  model: StructureModel
): { staged: StagedStructure; id: string } {
  const taken = new Set(finalColumnNames(staged, model).map((n) => n.toLowerCase()))
  const id = nextStructureId('c')
  const column: NewColumn = {
    id,
    draft: {
      name: freeName(taken, 'new_column'),
      type: defaultNewColumnType(model.dialect),
      nullable: model.dialect === 'clickhouse' ? false : true,
      defaultExpr: '',
      comment: ''
    },
    position: { kind: 'end' }
  }
  return { staged: { ...staged, adds: [...staged.adds, column] }, id }
}

export function updateNewColumn(
  staged: StagedStructure,
  id: string,
  patch: Partial<ColumnDraft>,
  position?: ColumnPosition
): StagedStructure {
  return {
    ...staged,
    adds: staged.adds.map((c) =>
      c.id === id ? { ...c, draft: { ...c.draft, ...patch }, ...(position ? { position } : {}) } : c
    )
  }
}

/** Removes a staged new column (and the references of staged indexes / positions to it). */
export function removeNewColumn(staged: StagedStructure, id: string): StagedStructure {
  const key = newKey(id)
  return {
    ...staged,
    adds: staged.adds
      .filter((c) => c.id !== id)
      .map((c) =>
        c.position.kind === 'after' && c.position.column === key
          ? { ...c, position: { kind: 'end' } }
          : c
      ),
    addIndexes: staged.addIndexes.map((ix) => ({
      ...ix,
      columns: ix.columns.filter((c) => c.key !== key)
    }))
  }
}

export function toggleDropIndex(staged: StagedStructure, name: string): StagedStructure {
  const dropIndexes = staged.dropIndexes.includes(name)
    ? staged.dropIndexes.filter((d) => d !== name)
    : [...staged.dropIndexes, name]
  return { ...staged, dropIndexes }
}

export function upsertIndex(staged: StagedStructure, draft: IndexDraft): StagedStructure {
  const exists = staged.addIndexes.some((ix) => ix.id === draft.id)
  return {
    ...staged,
    addIndexes: exists
      ? staged.addIndexes.map((ix) => (ix.id === draft.id ? draft : ix))
      : [...staged.addIndexes, draft]
  }
}

export const removeIndex = (staged: StagedStructure, id: string): StagedStructure => ({
  ...staged,
  addIndexes: staged.addIndexes.filter((ix) => ix.id !== id)
})

/** The edited fields of a column that really differ from the described value. */
export function effectiveChange(
  column: BaseColumn,
  change: ColumnChange | undefined
): ColumnChange {
  const out: ColumnChange = {}
  if (!change) return out
  for (const field of ['name', 'type', 'nullable', 'defaultExpr', 'comment'] as const) {
    const value = change[field]
    if (value === undefined) continue
    const same =
      field === 'name' ? value === column.draft.name : sameValue(field, column.draft[field], value)
    if (!same) (out as Record<string, unknown>)[field] = value
  }
  if (out.type !== undefined && change.using?.trim()) out.using = change.using
  return out
}

/** The draft a described column has after its staged edits. */
export const editedDraft = (column: BaseColumn, staged: StagedStructure): ColumnDraft => {
  const change = staged.changes[column.info.name]
  if (!change) return column.draft
  const fields: ColumnChange = { ...change }
  delete fields.using
  return { ...column.draft, ...fields }
}

/** Column names after the staged edits (dropped columns excluded), in table order. */
export function finalColumnNames(staged: StagedStructure, model: StructureModel): string[] {
  const names: string[] = []
  for (const c of model.columns) {
    if (staged.drops.includes(c.info.name)) continue
    names.push(editedDraft(c, staged).name)
  }
  for (const a of staged.adds) names.push(a.draft.name)
  return names
}

/** Every column (described + new) the user can pick, with its key and final name. */
export function columnChoices(
  staged: StagedStructure,
  model: StructureModel
): Array<{ key: ColumnKey; name: string; dropped: boolean; isNew: boolean }> {
  return [
    ...model.columns.map((c) => ({
      key: c.key,
      name: editedDraft(c, staged).name,
      dropped: staged.drops.includes(c.info.name),
      isNew: false
    })),
    ...staged.adds.map((a) => ({
      key: newKey(a.id),
      name: a.draft.name,
      dropped: false,
      isNew: true
    }))
  ]
}

/** Number of staged operations (what the pending bar counts). */
export function pendingStructureCount(staged: StagedStructure, model: StructureModel): number {
  let n = staged.adds.length + staged.addIndexes.length + staged.dropIndexes.length
  const byName = new Map(model.columns.map((c) => [c.info.name, c]))
  n += staged.drops.length
  for (const [name, change] of Object.entries(staged.changes)) {
    if (staged.drops.includes(name)) continue
    const column = byName.get(name)
    // A column the describe does not know (yet): renamed by a run that stopped part way, until
    // the table is read again (pruneStaged settles it then).
    if (!column || Object.keys(effectiveChange(column, change)).length) n++
  }
  return n
}

/**
 * Drops staged edits that no longer match the table (a column or index renamed or removed
 * elsewhere): returns the cleaned staging and how many edits went.
 */
export function pruneStaged(
  staged: StagedStructure,
  model: StructureModel
): { staged: StagedStructure; removed: number } {
  const columnNames = new Set(model.columns.map((c) => c.info.name))
  const indexNames = new Set(model.indexes.map((i) => i.info.name))
  const validKeys = new Set([
    ...model.columns.map((c) => c.key),
    ...staged.adds.map((a) => newKey(a.id))
  ])
  let removed = 0
  const changes: Record<string, ColumnChange> = {}
  for (const [name, change] of Object.entries(staged.changes)) {
    if (columnNames.has(name)) changes[name] = change
    else removed++
  }
  const drops = staged.drops.filter((d) => columnNames.has(d))
  const dropIndexes = staged.dropIndexes.filter((d) => indexNames.has(d))
  removed += staged.drops.length - drops.length + staged.dropIndexes.length - dropIndexes.length
  const adds = staged.adds.map((a) =>
    a.position.kind === 'after' && !validKeys.has(a.position.column)
      ? { ...a, position: { kind: 'end' } as ColumnPosition }
      : a
  )
  const addIndexes = staged.addIndexes.map((ix) => ({
    ...ix,
    columns: ix.columns.filter((c) => validKeys.has(c.key))
  }))
  return { staged: { changes, drops, adds, dropIndexes, addIndexes }, removed }
}

// ---------------------------------------------------------------------------------------------
// DDL plan
// ---------------------------------------------------------------------------------------------

export type StructureOp =
  | { kind: 'drop-index'; name: string }
  | { kind: 'drop-column'; name: string }
  | {
      kind: 'column'
      /** Original name. */
      name: string
      fields: Array<keyof ColumnChange>
      /** Set when the statement renames the column. */
      renameTo?: string
      /**
       * ClickHouse type change (MODIFY COLUMN): the column as the statement names it, the type
       * before and after, and the statement that changes it back. ClickHouse commits the new type
       * before it converts the data, so a failed conversion can leave the new type in effect.
       */
      retype?: { column: string; from: string; to: string; revert: string }
    }
  | {
      kind: 'add-column'
      id: string
      part: 'add' | 'comment'
      name: string
      /** PostgreSQL: the comment set by a separate COMMENT ON statement after the ADD. */
      comment?: string
    }
  | { kind: 'add-index'; id: string }

export interface PlannedStatement {
  sql: string
  ops: StructureOp[]
  /** Each operation's piece of SQL (MySQL: the items of the one ALTER TABLE). */
  parts: Array<{ sql: string; op: StructureOp }>
}

export interface StructureIssue {
  level: 'error' | 'warning'
  /** A warning to read before applying: Apply opens the review (which lists it) first. */
  confirm?: boolean
  message: string
  column?: ColumnKey
  field?: ColumnField | 'position' | 'using'
  /** Index draft id or described index name. */
  index?: string
}

export interface StructurePlan {
  statements: PlannedStatement[]
  issues: StructureIssue[]
}

/** Words a bare default may be without being a typo for a quoted string. */
const DEFAULT_WORDS: ReadonlySet<string> = new Set([
  'NULL',
  'TRUE',
  'FALSE',
  'CURRENT_TIMESTAMP',
  'CURRENT_DATE',
  'CURRENT_TIME',
  'LOCALTIME',
  'LOCALTIMESTAMP',
  'CURRENT_USER',
  'SESSION_USER',
  'USER',
  'CURRENT_SCHEMA',
  'CURRENT_CATALOG'
])

/** Why `text` cannot be pasted into a statement as an SQL fragment, or null when it can. */
export function fragmentProblem(
  text: string,
  dialect: SqlDialect,
  options: SqlLexOptions = {}
): string | null {
  const lexed = lexSql(text, dialect, options)
  if (lexed.error) return lexed.error.message
  let depth = 0
  for (const t of lexed.tokens) {
    if (t.type === 'delimiter' || (t.type === 'punctuation' && t.text === ';'))
      return 'must not contain ";"'
    if (t.type === 'comment') return 'must not contain a comment'
    if (t.type === 'punctuation' && t.text === '(') depth++
    if (t.type === 'punctuation' && t.text === ')' && --depth < 0) return 'has an unmatched ")"'
  }
  return depth === 0 ? null : 'has an unclosed "("'
}

/** A bare word (or words) where a quoted string was probably meant: `hello` → `'hello'`. */
export function looksLikeUnquotedText(
  expr: string,
  dialect: SqlDialect,
  options: SqlLexOptions = {}
): boolean {
  const sig = lexSql(expr, dialect, options).tokens.filter(
    (t) => t.type !== 'whitespace' && t.type !== 'comment'
  )
  if (sig.length === 0) return false
  if (!sig.every((t) => t.type === 'identifier' || t.type === 'keyword')) return false
  return !(sig.length === 1 && DEFAULT_WORDS.has(sig[0].upper ?? ''))
}

const ident = (name: string, dialect: SqlDialect): string => quoteSqlIdentifier(name, dialect)

/**
 * Whether `expr` names the column `name` (PostgreSQL: a bare word folds to lower case, a quoted
 * one is exact); function names do not count.
 */
export function referencesColumn(expr: string, name: string, dialect: SqlDialect): boolean {
  const tokens = lexSql(expr, dialect).tokens.filter(
    (t) => t.type !== 'whitespace' && t.type !== 'comment'
  )
  return tokens.some((t, i) => {
    if (tokens[i + 1]?.text === '(') return false
    if (t.type === 'quoted_identifier') return unquoteSqlIdentifier(t.text) === name
    if (t.type !== 'identifier' && t.type !== 'keyword') return false
    return dialect === 'postgres' ? t.text.toLowerCase() === name : t.text === name
  })
}

/** SQLite: a default ADD COLUMN cannot use once the table has rows (CURRENT_TIMESTAMP, a call). */
function sqliteNonConstantDefault(expr: string): boolean {
  const tokens = lexSql(expr, 'sqlite').tokens.filter(
    (t) => t.type !== 'whitespace' && t.type !== 'comment'
  )
  return tokens.some(
    (t, i) =>
      ['CURRENT_TIME', 'CURRENT_DATE', 'CURRENT_TIMESTAMP'].includes(t.upper ?? '') ||
      ((t.type === 'identifier' || t.type === 'keyword') && tokens[i + 1]?.text === '(')
  )
}

/** Builds the statements for `staged` and everything that blocks or deserves a warning. */
export function planStructureChanges(
  model: StructureModel,
  staged: StagedStructure
): StructurePlan {
  const { dialect, caps } = model
  const issues: StructureIssue[] = []
  const statements: PlannedStatement[] = []
  const mysqlFamily = dialect === 'mysql' || dialect === 'mariadb'
  const table = qualifiedSqlName(model.table, dialect)
  const alter = `ALTER TABLE ${table}`
  const caseInsensitive = dialect !== 'postgres' && dialect !== 'clickhouse'
  const norm = (n: string): string => (caseInsensitive ? n.toLowerCase() : n)
  const lexOptions = literalOptions(model)
  const lit = (text: string): string => quoteSqlString(text, dialect, lexOptions)
  /** MySQL: the items of the single ALTER TABLE. */
  const mysqlItems: string[] = []
  const mysqlOps: StructureOp[] = []
  const emit = (sql: string, op: StructureOp): void => {
    if (mysqlFamily) {
      mysqlItems.push(sql)
      mysqlOps.push(op)
    } else statements.push({ sql, ops: [op], parts: [{ sql, op }] })
  }

  const dropped = new Set(staged.drops)
  const choices = columnChoices(staged, model)
  const byKey = new Map(choices.map((c) => [c.key, c]))
  const nameOf = (key: ColumnKey): string | null => {
    const c = byKey.get(key)
    return c && !c.dropped ? c.name : null
  }

  // ---- Validation of names, types and defaults ----------------------------------------------
  const finalNames = new Map<string, number>()
  for (const n of finalColumnNames(staged, model))
    finalNames.set(norm(n), (finalNames.get(norm(n)) ?? 0) + 1)
  const checkDraft = (
    key: ColumnKey,
    draft: Partial<ColumnDraft> & { using?: string },
    isNew: boolean
  ): void => {
    if (draft.name !== undefined) {
      if (!draft.name.trim())
        issues.push({ level: 'error', message: 'Column name is empty', column: key, field: 'name' })
      else if ((finalNames.get(norm(draft.name)) ?? 0) > 1)
        issues.push({
          level: 'error',
          message: `Two columns are named "${draft.name}"`,
          column: key,
          field: 'name'
        })
    }
    if (draft.type !== undefined) {
      const problem = draft.type.trim()
        ? fragmentProblem(draft.type, dialect, lexOptions)
        : 'is empty'
      if (problem)
        issues.push({ level: 'error', message: `Type ${problem}`, column: key, field: 'type' })
    }
    if (draft.defaultExpr !== undefined && draft.defaultExpr.trim()) {
      const problem = fragmentProblem(draft.defaultExpr, dialect, lexOptions)
      if (problem)
        issues.push({
          level: 'error',
          message: `Default ${problem}`,
          column: key,
          field: 'defaultExpr'
        })
      else if (looksLikeUnquotedText(draft.defaultExpr, dialect, lexOptions))
        issues.push({
          level: 'warning',
          message: `Default ${draft.defaultExpr.trim()} is read as SQL, not text: quote it ('${draft.defaultExpr.trim()}') for a string`,
          column: key,
          field: 'defaultExpr'
        })
      else if (
        isNew &&
        dialect === 'sqlite' &&
        model.rows !== 0 &&
        sqliteNonConstantDefault(draft.defaultExpr)
      )
        issues.push({
          level: 'warning',
          confirm: true,
          message: `SQLite cannot add a column whose default is not a constant (${draft.defaultExpr.trim()}) to a table that has rows${model.rows ? ` (this one has ${model.rows.toLocaleString('en-US')})` : ''}: use a constant default, or add the column without one and fill it with UPDATE`,
          column: key,
          field: 'defaultExpr'
        })
    }
    if (draft.using !== undefined && draft.using.trim()) {
      const problem = fragmentProblem(draft.using, dialect, lexOptions)
      if (problem)
        issues.push({ level: 'error', message: `USING ${problem}`, column: key, field: 'using' })
    }
    if (isNew && draft.nullable === false) {
      const def = (draft.defaultExpr ?? '').trim()
      if (dialect === 'sqlite' && (!def || def.toUpperCase() === 'NULL'))
        issues.push({
          level: 'error',
          message: 'SQLite needs a non-NULL default to add a NOT NULL column',
          column: key,
          field: 'defaultExpr'
        })
      else if (dialect === 'postgres' && !def)
        issues.push({
          level: 'warning',
          message: 'Adding a NOT NULL column without a default fails when the table has rows',
          column: key,
          field: 'nullable'
        })
    }
  }

  // ---- 1. Drop indexes ------------------------------------------------------------------------
  for (const ix of model.indexes) {
    const name = ix.info.name
    if (!staged.dropIndexes.includes(name)) continue
    if (ix.dropLock) {
      issues.push({ level: 'error', message: ix.dropLock, index: name })
      continue
    }
    const op: StructureOp = { kind: 'drop-index', name }
    switch (dialect) {
      case 'postgres':
        emit(
          ix.constraint
            ? `${alter} DROP CONSTRAINT ${ident(name, dialect)}`
            : `DROP INDEX ${qualifiedSqlName({ schema: model.table.schema, name }, dialect)}`,
          op
        )
        break
      case 'sqlite':
        emit(
          `DROP INDEX ${qualifiedSqlName({ database: model.table.database, name }, dialect)}`,
          op
        )
        break
      default:
        emit(
          mysqlFamily
            ? `DROP INDEX ${ident(name, dialect)}`
            : `${alter} DROP INDEX ${ident(name, dialect)}`,
          op
        )
    }
  }

  // ---- 2. Drop columns ------------------------------------------------------------------------
  const keptIndexes = model.indexes.filter((ix) => !staged.dropIndexes.includes(ix.info.name))
  for (const c of model.columns) {
    const name = c.info.name
    if (!dropped.has(name)) continue
    const lock = caps.columns ?? c.locks.drop
    if (lock) {
      issues.push({ level: 'error', message: lock, column: c.key })
      continue
    }
    if (dialect === 'sqlite') {
      const using = keptIndexes.find(
        (ix) => !ix.info.primary && ix.info.columns.some((col) => stripIndexColumn(col) === name)
      )
      if (using)
        issues.push({
          level: 'error',
          message: `SQLite cannot drop "${name}" while index "${using.info.name}" uses it: drop the index too`,
          column: c.key
        })
    }
    const op: StructureOp = { kind: 'drop-column', name }
    emit(
      mysqlFamily
        ? `DROP COLUMN ${ident(name, dialect)}`
        : `${alter} DROP COLUMN ${ident(name, dialect)}`,
      op
    )
  }

  // ---- 3. Column changes ----------------------------------------------------------------------
  for (const c of model.columns) {
    const name = c.info.name
    if (dropped.has(name)) continue
    const change = effectiveChange(c, staged.changes[name])
    const fields = Object.keys(change) as Array<keyof ColumnChange>
    if (fields.length === 0) continue
    checkDraft(c.key, change, false)
    const lockOf = (field: ColumnField): string | undefined =>
      caps.columns ??
      (field === 'name'
        ? c.locks.rename
        : field === 'defaultExpr'
          ? c.locks.default
          : c.locks[field as keyof ColumnLocks])
    const locked = fields.filter((f) => f !== 'using' && lockOf(f as ColumnField))
    if (locked.length) {
      issues.push({ level: 'error', message: lockOf(locked[0] as ColumnField)!, column: c.key })
      continue
    }
    const newName = change.name ?? name
    const col = (n: string): string => ident(n, dialect)
    if (mysqlFamily) {
      const onlyRename = fields.length === 1 && change.name !== undefined
      const renameColumn =
        !!model.server.version &&
        (model.server.mariadb
          ? atLeast(model.server.version, [10, 5, 2])
          : atLeast(model.server.version, [8, 0, 0]))
      const op: StructureOp = {
        kind: 'column',
        name,
        fields,
        ...(change.name !== undefined ? { renameTo: change.name } : {})
      }
      if (onlyRename && (renameColumn || !c.mysql)) {
        emit(`RENAME COLUMN ${col(name)} TO ${col(newName)}`, op)
        continue
      }
      if (!c.mysql) {
        issues.push({
          level: 'error',
          message:
            'The column definition could not be read (SHOW CREATE TABLE): reload the structure',
          column: c.key
        })
        continue
      }
      const definition = buildMysqlColumnDefinition(
        c.mysql,
        {
          ...(change.type !== undefined ? { type: change.type } : {}),
          ...(change.nullable !== undefined ? { nullable: change.nullable } : {}),
          ...(change.defaultExpr !== undefined ? { defaultExpr: change.defaultExpr } : {}),
          ...(change.comment !== undefined
            ? { commentLiteral: change.comment ? lit(change.comment) : '' }
            : {}),
          ...(change.name !== undefined ? { rename: { from: name, to: newName } } : {})
        },
        { mariadb: model.server.mariadb, dialect, lex: lexOptions }
      )
      emit(
        change.name !== undefined
          ? `CHANGE COLUMN ${col(name)} ${col(newName)} ${definition}`
          : `MODIFY COLUMN ${col(name)} ${definition}`,
        op
      )
      continue
    }
    if (change.name !== undefined)
      emit(`${alter} RENAME COLUMN ${col(name)} TO ${col(newName)}`, {
        kind: 'column',
        name,
        fields: ['name'],
        renameTo: newName
      })
    const target = col(newName)
    if (dialect === 'postgres') {
      if (change.type !== undefined) {
        const using = change.using?.trim()
        // The rename statement runs first: USING sees the column under its new name.
        if (
          using &&
          change.name !== undefined &&
          !finalNames.has(norm(name)) &&
          referencesColumn(using, name, dialect)
        )
          issues.push({
            level: 'error',
            message: `USING runs after the rename: refer to the column as ${target}, not ${col(name)}`,
            column: c.key,
            field: 'using'
          })
        emit(
          `${alter} ALTER COLUMN ${target} TYPE ${change.type.trim()}${using ? ` USING ${using}` : ''}`,
          { kind: 'column', name, fields: using ? ['type', 'using'] : ['type'] }
        )
      }
      if (change.nullable !== undefined)
        emit(`${alter} ALTER COLUMN ${target} ${change.nullable ? 'DROP' : 'SET'} NOT NULL`, {
          kind: 'column',
          name,
          fields: ['nullable']
        })
      if (change.defaultExpr !== undefined)
        emit(
          change.defaultExpr.trim()
            ? `${alter} ALTER COLUMN ${target} SET DEFAULT ${change.defaultExpr.trim()}`
            : `${alter} ALTER COLUMN ${target} DROP DEFAULT`,
          { kind: 'column', name, fields: ['defaultExpr'] }
        )
      if (change.comment !== undefined)
        emit(
          `COMMENT ON COLUMN ${table}.${target} IS ${change.comment ? lit(change.comment) : 'NULL'}`,
          { kind: 'column', name, fields: ['comment'] }
        )
    } else if (dialect === 'clickhouse') {
      if (change.type !== undefined) {
        const to = change.type.trim()
        const nullsOut = isClickhouseNullable(c.draft.type) && !isClickhouseNullable(to)
        issues.push({
          level: 'warning',
          confirm: true,
          message: `${nullsOut ? `Removing Nullable from "${newName}"` : `Changing the type of "${newName}"`} converts its stored values in a background mutation. ClickHouse commits the new type first and does not roll it back: if a value cannot convert${nullsOut ? ' (any NULL)' : ''}, the ALTER fails with the new type in place and reads of the table fail until the type is changed back. Narrower numeric types wrap values silently.`,
          column: c.key,
          field: 'type'
        })
        emit(`${alter} MODIFY COLUMN ${target} ${to}`, {
          kind: 'column',
          name,
          fields: change.nullable !== undefined ? ['type', 'nullable'] : ['type'],
          retype: {
            column: newName,
            from: c.draft.type,
            to,
            revert: `${alter} MODIFY COLUMN ${target} ${c.draft.type}`
          }
        })
      }
      if (change.defaultExpr !== undefined)
        emit(
          change.defaultExpr.trim()
            ? `${alter} MODIFY COLUMN ${target} DEFAULT ${change.defaultExpr.trim()}`
            : `${alter} MODIFY COLUMN ${target} REMOVE DEFAULT`,
          { kind: 'column', name, fields: ['defaultExpr'] }
        )
      if (change.comment !== undefined)
        emit(`${alter} COMMENT COLUMN ${target} ${lit(change.comment)}`, {
          kind: 'column',
          name,
          fields: ['comment']
        })
    }
  }

  // ---- 4. Add columns -------------------------------------------------------------------------
  if (staged.adds.length && (caps.columns || caps.addColumns)) {
    issues.push({ level: 'error', message: (caps.columns ?? caps.addColumns)! })
  } else {
    for (const a of staged.adds) {
      const key = newKey(a.id)
      const d = a.draft
      checkDraft(key, d, true)
      const name = ident(d.name.trim() || d.name, dialect)
      const def = d.defaultExpr.trim()
      let sql = ''
      switch (dialect) {
        case 'clickhouse':
          sql = `${d.type.trim()}${def ? ` DEFAULT ${def}` : ''}${d.comment ? ` COMMENT ${lit(d.comment)}` : ''}`
          break
        case 'mysql':
        case 'mariadb':
          sql = `${d.type.trim()} ${d.nullable ? 'NULL' : 'NOT NULL'}${def ? ` DEFAULT ${def}` : ''}${d.comment ? ` COMMENT ${lit(d.comment)}` : ''}`
          break
        default:
          sql = `${d.type.trim()}${def ? ` DEFAULT ${def}` : ''}${d.nullable ? '' : ' NOT NULL'}`
      }
      if (caps.positions && a.position.kind !== 'end') {
        if (a.position.kind === 'first') sql += ' FIRST'
        else {
          const after = nameOf(a.position.column)
          if (after === null)
            issues.push({
              level: 'error',
              message: 'The column it should follow is dropped',
              column: key,
              field: 'position'
            })
          else sql += ` AFTER ${ident(after, dialect)}`
        }
      }
      const separateComment = dialect === 'postgres' && !!d.comment
      emit(mysqlFamily ? `ADD COLUMN ${name} ${sql}` : `${alter} ADD COLUMN ${name} ${sql}`, {
        kind: 'add-column',
        id: a.id,
        part: 'add',
        name: d.name,
        ...(separateComment ? { comment: d.comment } : {})
      })
      if (separateComment)
        emit(`COMMENT ON COLUMN ${table}.${name} IS ${lit(d.comment)}`, {
          kind: 'add-column',
          id: a.id,
          part: 'comment',
          name: d.name
        })
    }
  }

  // ---- 5. Create indexes ----------------------------------------------------------------------
  const indexNames = new Map<string, number>()
  for (const ix of keptIndexes) indexNames.set(norm(ix.info.name), 1)
  for (const ix of staged.addIndexes)
    indexNames.set(norm(ix.name.trim()), (indexNames.get(norm(ix.name.trim())) ?? 0) + 1)
  for (const ix of staged.addIndexes) {
    if (caps.indexes) {
      issues.push({ level: 'error', message: caps.indexes, index: ix.id })
      continue
    }
    const name = ix.name.trim()
    const before = issues.length
    if (!name) issues.push({ level: 'error', message: 'Index name is empty', index: ix.id })
    else if ((indexNames.get(norm(name)) ?? 0) > 1)
      issues.push({ level: 'error', message: `Index name "${name}" is taken`, index: ix.id })
    const cols: string[] = []
    for (const ref of ix.columns) {
      const colName = nameOf(ref.key)
      if (colName === null) {
        issues.push({
          level: 'error',
          message: `Index "${name || '(unnamed)'}" uses a dropped column`,
          index: ix.id
        })
        continue
      }
      const length =
        caps.prefixLengths && ref.length && ref.length > 0 ? `(${Math.trunc(ref.length)})` : ''
      cols.push(`${ident(colName, dialect)}${length}`)
    }
    const op: StructureOp = { kind: 'add-index', id: ix.id }
    if (dialect === 'clickhouse') {
      const expression =
        ix.expression?.trim() ||
        (cols.length === 1 ? cols[0] : cols.length ? `(${cols.join(', ')})` : '')
      const skipType = ix.skipType?.trim() || 'minmax'
      const granularity = Math.trunc(ix.granularity ?? 1)
      if (!expression)
        issues.push({
          level: 'error',
          message: 'Pick a column or type an expression',
          index: ix.id
        })
      else {
        const problem = fragmentProblem(expression, dialect) ?? fragmentProblem(skipType, dialect)
        if (problem) issues.push({ level: 'error', message: `Index ${problem}`, index: ix.id })
      }
      if (!(granularity >= 1))
        issues.push({ level: 'error', message: 'Granularity must be 1 or more', index: ix.id })
      if (issues.length === before)
        emit(
          `${alter} ADD INDEX ${ident(name, dialect)} ${expression} TYPE ${skipType} GRANULARITY ${granularity}`,
          op
        )
      continue
    }
    if (ix.columns.length === 0)
      issues.push({ level: 'error', message: 'Pick at least one column', index: ix.id })
    if (issues.length > before) continue
    const unique = ix.unique ? 'UNIQUE ' : ''
    const list = `(${cols.join(', ')})`
    switch (dialect) {
      case 'postgres': {
        const method = ix.method && ix.method !== 'btree' ? ` USING ${ix.method}` : ''
        emit(`CREATE ${unique}INDEX ${ident(name, dialect)} ON ${table}${method} ${list}`, op)
        break
      }
      case 'sqlite':
        emit(
          `CREATE ${unique}INDEX ${qualifiedSqlName({ database: model.table.database, name }, dialect)} ON ${ident(model.table.name, dialect)} ${list}`,
          op
        )
        break
      default:
        emit(`ADD ${unique}INDEX ${ident(name, dialect)} ${list}`, op)
    }
  }

  if (mysqlFamily && mysqlItems.length) {
    statements.push({
      sql: `${alter}\n  ${mysqlItems.join(',\n  ')}`,
      ops: mysqlOps,
      parts: mysqlItems.map((sql, i) => ({ sql, op: mysqlOps[i] }))
    })
  }

  // Never hand the server text that splits differently from what we planned.
  for (const s of statements) {
    if (splitSqlStatements(s.sql, dialect, lexOptions).length !== 1) {
      issues.push({
        level: 'error',
        message:
          'A generated statement does not read as one statement: check the types and defaults'
      })
      break
    }
  }
  return { statements, issues }
}

/**
 * The statement that creates `draft` (MySQL: an ALTER TABLE with just that item) as it would be
 * planned with everything else staged, and its problems: the index dialog's preview.
 */
export function indexPreview(
  model: StructureModel,
  staged: StagedStructure,
  draft: IndexDraft
): { sql: string | null; issues: StructureIssue[] } {
  const plan = planStructureChanges(model, upsertIndex(staged, draft))
  const issues = plan.issues.filter((i) => i.index === draft.id)
  const mysqlFamily = model.dialect === 'mysql' || model.dialect === 'mariadb'
  for (const statement of plan.statements) {
    for (const part of statement.parts) {
      if (part.op.kind !== 'add-index' || part.op.id !== draft.id) continue
      return {
        sql: mysqlFamily
          ? `ALTER TABLE ${qualifiedSqlName(model.table, model.dialect)}\n  ${part.sql}`
          : part.sql,
        issues
      }
    }
  }
  return { sql: null, issues }
}

const MAX_INDEX_NAME: Record<string, number> = { postgres: 63, mysql: 64, mariadb: 64 }

/** idx name from the table and column names (each engine's usual convention). */
export function suggestIndexName(
  model: StructureModel,
  columns: string[],
  unique: boolean
): string {
  const part = (s: string): string => s.replace(/[^\p{L}\p{N}_]+/gu, '_').replace(/^_+|_+$/g, '')
  const cols = columns.map(part).filter(Boolean).join('_') || 'col'
  const table = part(model.table.name) || 'table'
  let name: string
  switch (model.dialect) {
    case 'postgres':
      name = `${table}_${cols}_${unique ? 'key' : 'idx'}`
      break
    case 'sqlite':
      name = `${unique ? 'uq' : 'idx'}_${table}_${cols}`
      break
    default:
      name = `${unique ? 'uq' : 'idx'}_${cols}`
  }
  return name.slice(0, MAX_INDEX_NAME[model.dialect] ?? 128)
}

/** The plan's statements as one script (what Review shows and Apply sends). */
export const planText = (plan: StructurePlan): string =>
  plan.statements.map((s) => `${s.sql};`).join('\n')

// ---------------------------------------------------------------------------------------------
// After a partial apply
// ---------------------------------------------------------------------------------------------

/**
 * Removes what `applied` (the operations of the statements that succeeded, in order) changed
 * from the staging. A rename moves the rest of that column's edits — and the references of
 * staged indexes and positions — to the new name; a new column that was added becomes a
 * described one (a PostgreSQL comment whose statement did not run stays staged as an edit).
 */
export function rebaseAfterApply(staged: StagedStructure, applied: StructureOp[]): StagedStructure {
  let next: StagedStructure = {
    changes: { ...staged.changes },
    drops: [...staged.drops],
    adds: [...staged.adds],
    dropIndexes: [...staged.dropIndexes],
    addIndexes: [...staged.addIndexes]
  }
  const rekey = (from: ColumnKey, to: ColumnKey): void => {
    next = {
      ...next,
      adds: next.adds.map((a) =>
        a.position.kind === 'after' && a.position.column === from
          ? { ...a, position: { kind: 'after', column: to } }
          : a
      ),
      addIndexes: next.addIndexes.map((ix) => ({
        ...ix,
        columns: ix.columns.map((c) => (c.key === from ? { ...c, key: to } : c))
      }))
    }
  }
  // Original name → current name, for the statements after a rename of the same column.
  const renamed = new Map<string, string>()
  for (const op of applied) {
    switch (op.kind) {
      case 'drop-index':
        next.dropIndexes = next.dropIndexes.filter((n) => n !== op.name)
        break
      case 'drop-column':
        next.drops = next.drops.filter((n) => n !== op.name)
        delete next.changes[op.name]
        break
      case 'add-index':
        next.addIndexes = next.addIndexes.filter((ix) => ix.id !== op.id)
        break
      case 'add-column': {
        if (op.part === 'add') {
          next.adds = next.adds.filter((a) => a.id !== op.id)
          rekey(newKey(op.id), baseKey(op.name))
          if (op.comment) next.changes[op.name] = { comment: op.comment }
        } else {
          const rest = { ...next.changes[op.name] }
          delete rest.comment
          if (Object.keys(rest).length) next.changes[op.name] = rest
          else delete next.changes[op.name]
        }
        break
      }
      case 'column': {
        const current = renamed.get(op.name) ?? op.name
        const change = next.changes[current]
        if (!change) break
        const rest: ColumnChange = { ...change }
        for (const f of op.fields) delete rest[f]
        if (op.fields.includes('type')) delete rest.using
        delete next.changes[current]
        const target = op.renameTo ?? current
        if (Object.keys(rest).length) next.changes[target] = rest
        if (op.renameTo !== undefined) {
          renamed.set(op.name, op.renameTo)
          rekey(baseKey(current), baseKey(op.renameTo))
        }
        break
      }
    }
  }
  return next
}

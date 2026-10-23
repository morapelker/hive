// Statements the schema tree generates (SELECT, TRUNCATE, DROP) and the object-kind vocabulary
// of the explorer. Destructive statements are never run from the tree: they are written into a
// new query tab for the user to review and run through the normal safety gate.

import type {
  DataObjectInfo,
  DataObjectKind,
  DataObjectRef,
  SqlDialect
} from '@shared/data-projects/types'
import { qualifiedSqlName, quoteSqlIdentifier } from '@shared/sql'

export const OBJECT_KIND_LABELS: Readonly<Record<DataObjectKind, { one: string; many: string }>> = {
  table: { one: 'table', many: 'Tables' },
  view: { one: 'view', many: 'Views' },
  materialized_view: { one: 'materialized view', many: 'Materialized views' },
  foreign_table: { one: 'foreign table', many: 'Foreign tables' },
  dictionary: { one: 'dictionary', many: 'Dictionaries' },
  function: { one: 'function', many: 'Functions' },
  procedure: { one: 'procedure', many: 'Procedures' },
  trigger: { one: 'trigger', many: 'Triggers' },
  sequence: { one: 'sequence', many: 'Sequences' },
  type: { one: 'type', many: 'Types' },
  event: { one: 'event', many: 'Events' },
  collection: { one: 'collection', many: 'Collections' }
}

/** Group order of the explorer tree. */
export const OBJECT_GROUP_ORDER: readonly DataObjectKind[] = [
  'table',
  'view',
  'materialized_view',
  'foreign_table',
  'dictionary',
  'function',
  'procedure',
  'trigger',
  'sequence',
  'type',
  'event'
]

const TABLE_LIKE: ReadonlySet<DataObjectKind> = new Set([
  'table',
  'view',
  'materialized_view',
  'foreign_table',
  'dictionary'
])

/** Objects that hold rows (Data / Structure tabs, SELECT, export). */
export const isTableLike = (kind: DataObjectKind | undefined): boolean =>
  !kind || TABLE_LIKE.has(kind)

/** A ref for an explorer object (PG keeps the schema; other engines the database). */
export function refForObject(
  object: DataObjectInfo,
  context: { dialect: SqlDialect; database?: string; schema?: string }
): DataObjectRef {
  return {
    ...(context.database ? { database: context.database } : {}),
    ...(context.dialect === 'postgres' ? { schema: object.schema ?? context.schema } : {}),
    name: object.name,
    kind: object.kind
  }
}

/**
 * The object's name as SQL: qualified only when it lives outside the tab's current database (or,
 * for PostgreSQL, outside `public`/the current schema), so generated SQL stays short and runs as-is.
 */
export function objectSqlName(
  ref: DataObjectRef,
  dialect: SqlDialect,
  current: { database?: string; schema?: string } = {}
): string {
  if (dialect === 'postgres') {
    const schema = ref.schema
    const implicit = !schema || schema === (current.schema ?? 'public')
    return implicit
      ? quoteSqlIdentifier(ref.name, dialect)
      : qualifiedSqlName({ schema, name: ref.name }, dialect)
  }
  const database = ref.database
  const implicit =
    !database || database === current.database || (dialect === 'sqlite' && database === 'main')
  return implicit
    ? quoteSqlIdentifier(ref.name, dialect)
    : qualifiedSqlName({ database, name: ref.name }, dialect)
}

/** Unquoted dotted name for "Copy name". */
export const plainObjectName = (ref: DataObjectRef, dialect: SqlDialect): string =>
  [dialect === 'postgres' ? ref.schema : ref.database, ref.name].filter(Boolean).join('.')

export function generateSelect(
  ref: DataObjectRef,
  dialect: SqlDialect,
  options: {
    columns?: string[]
    limit?: number
    current?: { database?: string; schema?: string }
  } = {}
): string {
  const name = objectSqlName(ref, dialect, options.current)
  const cols =
    options.columns && options.columns.length
      ? `\n  ${options.columns.map((c) => quoteSqlIdentifier(c, dialect)).join(',\n  ')}`
      : ' *'
  const limit = options.limit ?? 100
  return `SELECT${cols}\nFROM ${name}${limit > 0 ? `\nLIMIT ${limit}` : ''};`
}

const REVIEW = '-- Review before running: this cannot be undone.'

export function generateTruncate(
  ref: DataObjectRef,
  dialect: SqlDialect,
  current?: { database?: string; schema?: string }
): string {
  const name = objectSqlName(ref, dialect, current)
  // SQLite has no TRUNCATE: an unqualified DELETE takes the truncate optimisation.
  return dialect === 'sqlite'
    ? `${REVIEW}\nDELETE FROM ${name};`
    : `${REVIEW}\nTRUNCATE TABLE ${name};`
}

export function generateDrop(
  object: Pick<DataObjectInfo, 'kind' | 'detail'>,
  ref: DataObjectRef,
  dialect: SqlDialect,
  current?: { database?: string; schema?: string }
): string {
  const name = objectSqlName(ref, dialect, current)
  const keyword: Record<DataObjectKind, string> = {
    table: 'TABLE',
    view: 'VIEW',
    materialized_view: dialect === 'postgres' ? 'MATERIALIZED VIEW' : 'VIEW',
    foreign_table: 'FOREIGN TABLE',
    dictionary: 'DICTIONARY',
    function: 'FUNCTION',
    procedure: 'PROCEDURE',
    trigger: 'TRIGGER',
    sequence: 'SEQUENCE',
    type: 'TYPE',
    event: 'EVENT',
    collection: 'TABLE'
  }
  let statement = `DROP ${keyword[object.kind]} ${name}`
  if (dialect === 'postgres') {
    // PG needs the identity arguments of a function/procedure and the table of a trigger.
    if (
      (object.kind === 'function' || object.kind === 'procedure') &&
      object.detail !== undefined
    ) {
      statement += `(${object.detail})`
    }
    if (object.kind === 'trigger' && object.detail) {
      statement += ` ON ${objectSqlName({ ...ref, name: object.detail }, dialect, current)}`
    }
  }
  return `${REVIEW}\n${statement};`
}

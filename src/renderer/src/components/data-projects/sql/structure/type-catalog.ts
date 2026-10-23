// Column types offered by the structure editor's type picker, per dialect, grouped the way the
// engines document them. The picker only fills the type field: any other type can be typed in
// (the field is free text and goes into the DDL as written, after a single-statement check).
//
// ClickHouse nullability is part of the type (`Nullable(T)`, `LowCardinality(Nullable(T))`), so
// its "Nullable" checkbox rewrites the type through `setClickhouseNullable`.

import type { SqlDialect } from '@shared/data-projects/types'

export interface TypeGroup {
  label: string
  types: readonly string[]
}

const POSTGRES: readonly TypeGroup[] = [
  {
    label: 'Numeric',
    types: [
      'integer',
      'bigint',
      'smallint',
      'numeric(10,2)',
      'real',
      'double precision',
      'serial',
      'bigserial'
    ]
  },
  { label: 'Text', types: ['text', 'varchar(255)', 'char(1)'] },
  {
    label: 'Date & time',
    types: ['timestamptz', 'timestamp', 'date', 'time', 'interval']
  },
  {
    label: 'Other',
    types: ['boolean', 'uuid', 'jsonb', 'json', 'bytea', 'inet', 'text[]', 'integer[]']
  }
]

const MYSQL_BASE: readonly TypeGroup[] = [
  {
    label: 'Numeric',
    types: [
      'int',
      'bigint',
      'smallint',
      'tinyint',
      'int unsigned',
      'bigint unsigned',
      'tinyint(1)',
      'decimal(10,2)',
      'float',
      'double',
      'bit(1)'
    ]
  },
  {
    label: 'Text',
    types: [
      'varchar(255)',
      'char(36)',
      'text',
      'mediumtext',
      'longtext',
      "enum('a','b')",
      "set('a','b')"
    ]
  },
  { label: 'Date & time', types: ['datetime', 'timestamp', 'date', 'time', 'year'] },
  { label: 'Binary', types: ['blob', 'mediumblob', 'longblob', 'varbinary(255)', 'binary(16)'] }
]

const MYSQL: readonly TypeGroup[] = [...MYSQL_BASE, { label: 'Other', types: ['json'] }]
const MARIADB: readonly TypeGroup[] = [
  ...MYSQL_BASE,
  { label: 'Other', types: ['json', 'uuid', 'inet6'] }
]

const SQLITE: readonly TypeGroup[] = [
  { label: 'Storage classes', types: ['INTEGER', 'TEXT', 'REAL', 'BLOB', 'NUMERIC'] },
  {
    label: 'Declared names',
    types: ['VARCHAR(255)', 'BOOLEAN', 'DATETIME', 'DATE', 'DECIMAL(10,2)', 'JSON']
  }
]

const CLICKHOUSE: readonly TypeGroup[] = [
  {
    label: 'Integers',
    types: ['UInt8', 'UInt16', 'UInt32', 'UInt64', 'Int8', 'Int16', 'Int32', 'Int64']
  },
  { label: 'Floats & decimals', types: ['Float32', 'Float64', 'Decimal(18, 2)'] },
  { label: 'Text', types: ['String', 'LowCardinality(String)', 'FixedString(16)'] },
  { label: 'Date & time', types: ['Date', 'Date32', 'DateTime', 'DateTime64(3)'] },
  {
    label: 'Other',
    types: ['Bool', 'UUID', 'IPv4', 'IPv6', 'Array(String)', 'Map(String, String)']
  }
]

/** The picker's groups for `dialect` (MariaDB adds its own types to MySQL's). */
export function typeCatalog(dialect: SqlDialect): readonly TypeGroup[] {
  switch (dialect) {
    case 'postgres':
      return POSTGRES
    case 'mysql':
      return MYSQL
    case 'mariadb':
      return MARIADB
    case 'sqlite':
      return SQLITE
    case 'clickhouse':
      return CLICKHOUSE
  }
}

/** Type of a freshly added column. */
export function defaultNewColumnType(dialect: SqlDialect): string {
  switch (dialect) {
    case 'postgres':
      return 'text'
    case 'mysql':
    case 'mariadb':
      return 'varchar(255)'
    case 'sqlite':
      return 'TEXT'
    case 'clickhouse':
      return 'String'
  }
}

/**
 * MySQL types that take CHARACTER SET / COLLATE. A MODIFY to any other type drops those clauses
 * (MySQL refuses COLLATE on an INT). MariaDB's JSON is an alias of LONGTEXT and keeps them.
 */
export function isTextualMysqlType(type: string, mariadb: boolean): boolean {
  const t = type.trim().toLowerCase()
  if (
    /^(national\s+)?(char|varchar|nchar|nvarchar|character|tinytext|text|mediumtext|longtext|enum|set|long(\s+varchar)?)\b/.test(
      t
    )
  )
    return true
  return mariadb && /^json\b/.test(t)
}

// ---------------------------------------------------------------------------------------------
// ClickHouse nullability (part of the type)
// ---------------------------------------------------------------------------------------------

/** `Wrapper(inner)` → inner when `type` is exactly that wrapper around a balanced argument. */
function unwrap(type: string, wrapper: string): string | null {
  const t = type.trim()
  if (!t.startsWith(`${wrapper}(`) || !t.endsWith(')')) return null
  const inner = t.slice(wrapper.length + 1, -1)
  let depth = 0
  for (const ch of inner) {
    if (ch === '(') depth++
    else if (ch === ')' && --depth < 0) return null
  }
  return depth === 0 ? inner.trim() : null
}

export const isClickhouseNullable = (type: string): boolean => {
  const low = unwrap(type, 'LowCardinality')
  return unwrap(low ?? type, 'Nullable') !== null
}

/** Composite types ClickHouse cannot wrap in Nullable(...). */
const NOT_NULLABLE =
  /^(Array|Map|Tuple|Nested|Object|JSON|Variant|Dynamic|AggregateFunction|SimpleAggregateFunction)\b/

/**
 * `type` with Nullable added or removed (LowCardinality stays outside: LowCardinality(Nullable(T))).
 * Null when ClickHouse cannot make that type Nullable (arrays, maps, tuples, ...).
 */
export function setClickhouseNullable(type: string, nullable: boolean): string | null {
  const t = type.trim()
  const low = unwrap(t, 'LowCardinality')
  const base = low ?? t
  const inner = unwrap(base, 'Nullable')
  if (nullable) {
    if (inner !== null) return t
    if (!base || NOT_NULLABLE.test(base)) return null
    return low !== null ? `LowCardinality(Nullable(${base}))` : `Nullable(${base})`
  }
  if (inner === null) return t
  return low !== null ? `LowCardinality(${inner})` : inner
}

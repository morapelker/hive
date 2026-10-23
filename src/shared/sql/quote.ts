// Identifier and literal quoting for SQL the app generates (table browsing, grid edits, export,
// schema actions). Generated SQL never interpolates unquoted user values.
//
// Identifiers are ALWAYS quoted: introspected names are exact, and an unquoted name could be
// case-folded (PG lowercases `Users`) or collide with a reserved word (`user`, `order`).
//
// String literals are written so they mean the same thing whatever the session settings:
// - PostgreSQL: a value containing a backslash becomes `E'…'` with doubled backslashes, which
//   reads identically with standard_conforming_strings on or off;
// - MySQL/MariaDB: backslashes are escaped unless the caller says the session runs with
//   NO_BACKSLASH_ESCAPES (`options.backslashEscapes: false`), in which case they are literal;
// - ClickHouse always reads backslash escapes; SQLite never does.
// Binary cells become X'…' (MySQL/MariaDB/SQLite), decode('…', 'hex') (PG) or unhex('…')
// (ClickHouse). A binary cell whose hex is only a preview (len > shown bytes) cannot be written
// back faithfully: quoting it throws instead of silently truncating data.

import { isBinaryCell, type DataCell, type SqlDialect } from '../data-projects/types'

export interface SqlQuoteOptions {
  /** MySQL/MariaDB: false when the session has NO_BACKSLASH_ESCAPES (default true). */
  backslashEscapes?: boolean
}

export function quoteSqlIdentifier(name: string, dialect: SqlDialect): string {
  switch (dialect) {
    case 'mysql':
    case 'mariadb':
      return `\`${name.replace(/`/g, '``')}\``
    case 'clickhouse':
      return `\`${name.replace(/\\/g, '\\\\').replace(/`/g, '\\`')}\``
    default:
      return `"${name.replace(/"/g, '""')}"`
  }
}

/** `schema.name` (PG), `database.name` (MySQL/MariaDB/ClickHouse/SQLite attached db), quoted. */
export function qualifiedSqlName(
  ref: { database?: string; schema?: string; name: string },
  dialect: SqlDialect
): string {
  const qualifier = dialect === 'postgres' ? ref.schema : (ref.database ?? ref.schema)
  const name = quoteSqlIdentifier(ref.name, dialect)
  return qualifier ? `${quoteSqlIdentifier(qualifier, dialect)}.${name}` : name
}

/** A string literal for `dialect` (see the file header for the escaping rules). */
export function quoteSqlString(
  value: string,
  dialect: SqlDialect,
  options: SqlQuoteOptions = {}
): string {
  switch (dialect) {
    case 'postgres': {
      const body = value.replace(/'/g, "''")
      return value.includes('\\') ? `E'${body.replace(/\\/g, '\\\\')}'` : `'${body}'`
    }
    case 'mysql':
    case 'mariadb': {
      if (options.backslashEscapes === false) return `'${value.replace(/'/g, "''")}'`
      const body = value
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "''")
        .replaceAll('\u0000', '\\0')
        .replaceAll('\u001a', '\\Z')
      return `'${body}'`
    }
    case 'clickhouse':
      return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\0/g, '\\0')}'`
    default:
      return `'${value.replace(/'/g, "''")}'`
  }
}

const HEX = /^[0-9a-fA-F]*$/

/** A literal for a grid cell (`undefined` and null → NULL). */
export function quoteSqlLiteral(
  value: DataCell | undefined,
  dialect: SqlDialect,
  options: SqlQuoteOptions = {}
): string {
  if (value === undefined || value === null) return 'NULL'
  if (typeof value === 'boolean') {
    if (dialect === 'sqlite') return value ? '1' : '0'
    if (dialect === 'clickhouse') return value ? 'true' : 'false'
    return value ? 'TRUE' : 'FALSE'
  }
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return Object.is(value, -0) ? '0' : String(value)
    return quoteSqlString(String(value), dialect, options)
  }
  if (isBinaryCell(value)) {
    const hex = value.hex
    if (!HEX.test(hex) || hex.length % 2 !== 0) throw new Error('Invalid binary value (not hex)')
    if (value.len > hex.length / 2) {
      throw new Error(
        `Binary value is truncated (${hex.length / 2} of ${value.len} bytes shown); it cannot be used as a literal`
      )
    }
    const upper = hex.toUpperCase()
    if (dialect === 'postgres') return `decode('${upper}', 'hex')`
    if (dialect === 'clickhouse') return `unhex('${upper}')`
    return `X'${upper}'`
  }
  return quoteSqlString(value, dialect, options)
}

// Reads the parts of a table's CREATE TABLE text (the DDL tab's source: SHOW CREATE TABLE on
// MySQL / MariaDB / ClickHouse, sqlite_schema.sql on SQLite, the catalog rebuild on PostgreSQL)
// that the describe result does not carry:
//
//   columns          MySQL / MariaDB: the full definition of each column (the text after its
//                    name), restated by CHANGE / MODIFY COLUMN (see mysql-column.ts)
//   checks           CHECK constraints, named or not, table- or column-level
//   uniques          UNIQUE constraints declared as constraints (PostgreSQL `CONSTRAINT x UNIQUE`)
//   constraintNames  named PRIMARY KEY / UNIQUE / EXCLUDE constraints: on PostgreSQL their index
//                    cannot be dropped with DROP INDEX, only with ALTER TABLE … DROP CONSTRAINT
//
// The statement is lexed with the shared lexer and split into its top-level items (commas at
// depth one), so strings, quoted names and nested parentheses never confuse it. Anything it
// cannot read yields null: the editor then falls back to what describe knows.

import type { DataTableDetails, SqlDialect } from '@shared/data-projects/types'
import { lexSql, splitSqlStatements, unquoteSqlIdentifier, type SqlToken } from '@shared/sql'

export interface ParsedCheck {
  name: string | null
  expression: string
  /** Column-level CHECK: the column it is declared on. */
  column?: string
}

export interface ParsedUnique {
  name: string | null
  columns: string
}

export interface ParsedTableDdl {
  columns: Map<string, string>
  checks: ParsedCheck[]
  uniques: ParsedUnique[]
  constraintNames: Set<string>
}

const isTrivia = (t: SqlToken): boolean => t.type === 'whitespace' || t.type === 'comment'
const isOpen = (t: SqlToken): boolean => t.type === 'punctuation' && t.text === '('
const isClose = (t: SqlToken): boolean => t.type === 'punctuation' && t.text === ')'

/** Index of the `)` matching the `(` at `open` (token indexes), or -1. */
function matchParen(tokens: SqlToken[], open: number): number {
  let depth = 0
  for (let i = open; i < tokens.length; i++) {
    if (isOpen(tokens[i])) depth++
    else if (isClose(tokens[i]) && --depth === 0) return i
  }
  return -1
}

/** `((x))` → `x`: parentheses that wrap the whole text, any number of them. */
function stripOuterParens(text: string, dialect: SqlDialect): string {
  let t = text.trim()
  while (t.startsWith('(')) {
    const tokens = lexSql(t, dialect).tokens
    if (matchParen(tokens, 0) !== tokens.length - 1) break
    t = t.slice(1, -1).trim()
  }
  return t
}

const identName = (t: SqlToken | undefined): string | null =>
  !t
    ? null
    : t.type === 'quoted_identifier'
      ? unquoteSqlIdentifier(t.text)
      : t.type === 'identifier' || t.type === 'keyword'
        ? t.text
        : null

/** Words that start a table-level item (not a column definition). */
const TABLE_ITEM_WORDS: ReadonlySet<string> = new Set([
  'CONSTRAINT',
  'PRIMARY',
  'UNIQUE',
  'KEY',
  'INDEX',
  'FULLTEXT',
  'SPATIAL',
  'FOREIGN',
  'CHECK',
  'EXCLUDE',
  'LIKE',
  'PERIOD',
  'PROJECTION'
])

// Text of the tokens `from..to` (inclusive) without trailing trivia; `stripExec` also drops a
// trailing executable comment (MySQL's `/*!80016 NOT ENFORCED */` after a CHECK is not part of
// its expression, while a column's `/*!80023 INVISIBLE */` is part of its definition).
function itemText(
  source: string,
  tokens: SqlToken[],
  from: number,
  to: number,
  stripExec = false
): string {
  let end = to
  while (end >= from && isTrivia(tokens[end])) end--
  if (
    stripExec &&
    end >= from &&
    tokens[end].type === 'executable_comment' &&
    tokens[end].text === '*/'
  ) {
    let k = end - 1
    while (k >= from && tokens[k].type !== 'executable_comment') k--
    if (k >= from) end = k - 1
    while (end >= from && isTrivia(tokens[end])) end--
  }
  return end < from ? '' : source.slice(tokens[from].start, tokens[end].end).trim()
}

/** The CREATE TABLE statement of `ddl` parsed into columns and constraints; null if none. */
export function parseCreateTable(ddl: string, dialect: SqlDialect): ParsedTableDdl | null {
  const statement = splitSqlStatements(ddl, dialect).find((s) => {
    const words = lexSql(s.text, dialect)
      .tokens.filter((t) => !isTrivia(t))
      .slice(0, 6)
      .map((t) => t.upper)
    return words[0] === 'CREATE' && words.includes('TABLE')
  })
  if (!statement) return null
  const source = statement.text
  const lexed = lexSql(source, dialect)
  if (lexed.error) return null
  const tokens = lexed.tokens
  const open = tokens.findIndex(isOpen)
  if (open < 0) return null
  const close = matchParen(tokens, open)
  if (close < 0) return null

  // Top-level items of the body: token index ranges between commas at depth one.
  const items: Array<[number, number]> = []
  let depth = 0
  let start = open + 1
  for (let i = open + 1; i < close; i++) {
    const t = tokens[i]
    if (isOpen(t)) depth++
    else if (isClose(t)) depth--
    else if (depth === 0 && t.type === 'punctuation' && t.text === ',') {
      items.push([start, i - 1])
      start = i + 1
    }
  }
  items.push([start, close - 1])

  const result: ParsedTableDdl = {
    columns: new Map(),
    checks: [],
    uniques: [],
    constraintNames: new Set()
  }
  for (const [from, to] of items) {
    const sig: number[] = []
    for (let i = from; i <= to; i++) if (!isTrivia(tokens[i])) sig.push(i)
    if (sig.length === 0) continue
    const first = tokens[sig[0]]
    const firstWord = first.type === 'keyword' || first.type === 'identifier' ? first.upper : null

    if (firstWord && TABLE_ITEM_WORDS.has(firstWord)) {
      let k = 0
      let name: string | null = null
      if (firstWord === 'CONSTRAINT') {
        name = identName(tokens[sig[1]])
        k = 2
      }
      const kind = tokens[sig[k]]?.upper
      if (kind === 'CHECK' && sig[k + 1] !== undefined) {
        const expression = stripOuterParens(itemText(source, tokens, sig[k + 1], to, true), dialect)
        if (expression) result.checks.push({ name, expression })
      } else if (kind === 'UNIQUE') {
        if (name) result.constraintNames.add(name)
        if (firstWord === 'CONSTRAINT') {
          // `UNIQUE [KEY|INDEX] [NULLS NOT DISTINCT] (cols)`: show the column list.
          const paren = sig.slice(k + 1).find((i) => isOpen(tokens[i]))
          if (paren !== undefined) {
            const end = matchParen(tokens, paren)
            if (end > 0)
              result.uniques.push({
                name,
                columns: stripOuterParens(
                  source.slice(tokens[paren].start, tokens[end].end),
                  dialect
                )
              })
          }
        }
      } else if ((kind === 'PRIMARY' || kind === 'EXCLUDE') && name) {
        result.constraintNames.add(name)
      }
      continue
    }

    // A column definition: name, then its definition.
    const column = identName(first)
    if (!column) continue
    if (sig.length > 1) result.columns.set(column, itemText(source, tokens, sig[1], to))
    // Column-level CHECK (SQLite, PostgreSQL inline, MariaDB's JSON CHECK (json_valid(...))).
    let colDepth = 0
    for (let s = 1; s < sig.length; s++) {
      const t = tokens[sig[s]]
      if (isOpen(t)) colDepth++
      else if (isClose(t)) colDepth--
      if (colDepth !== 0 || t.upper !== 'CHECK') continue
      const paren = sig[s + 1]
      if (paren === undefined || !isOpen(tokens[paren])) continue
      const end = matchParen(tokens, paren)
      if (end < 0) continue
      const named =
        s >= 3 && tokens[sig[s - 2]].upper === 'CONSTRAINT' ? identName(tokens[sig[s - 1]]) : null
      result.checks.push({
        name: named,
        column,
        expression: stripOuterParens(source.slice(tokens[paren].start, tokens[end].end), dialect)
      })
    }
  }
  return result
}

export interface ConstraintRow {
  kind: 'CHECK' | 'UNIQUE'
  name: string | null
  definition: string
  column?: string
}

/**
 * CHECK constraints come from the CREATE TABLE text (describe has none); UNIQUE ones from the
 * text on PostgreSQL (declared constraints, not unique indexes), and from describe's indexes
 * where the constraint is the index (MySQL / MariaDB UNIQUE KEY, SQLite UNIQUE).
 */
export function constraintRows(
  dialect: SqlDialect,
  details: DataTableDetails,
  parsed: ParsedTableDdl | null
): ConstraintRow[] {
  const rows: ConstraintRow[] = []
  if (dialect === 'postgres') {
    for (const u of parsed?.uniques ?? [])
      rows.push({ kind: 'UNIQUE', name: u.name, definition: u.columns })
  } else if (dialect !== 'clickhouse') {
    for (const ix of details.indexes) {
      if (!ix.unique || ix.primary) continue
      if (dialect === 'sqlite' && !ix.type?.startsWith('unique constraint')) continue
      rows.push({ kind: 'UNIQUE', name: ix.name, definition: ix.columns.join(', ') })
    }
  }
  for (const c of parsed?.checks ?? [])
    rows.push({
      kind: 'CHECK',
      name: c.name,
      definition: c.expression,
      ...(c.column ? { column: c.column } : {})
    })
  return rows
}

/** Words that end the data type of a ClickHouse column definition. */
const CLICKHOUSE_COLUMN_CLAUSES: ReadonlySet<string> = new Set([
  'NULL',
  'NOT',
  'DEFAULT',
  'MATERIALIZED',
  'ALIAS',
  'EPHEMERAL',
  'COMMENT',
  'CODEC',
  'TTL',
  'STATISTICS',
  'SETTINGS',
  'PRIMARY'
])

/** ClickHouse: the data type of a column definition (`Nullable(String) DEFAULT 'x'` → `Nullable(String)`). */
export function clickhouseColumnType(definition: string): string {
  const tokens = lexSql(definition, 'clickhouse').tokens
  let depth = 0
  for (const t of tokens) {
    if (isOpen(t)) depth++
    else if (isClose(t)) depth--
    else if (depth === 0 && t.start > 0 && t.upper && CLICKHOUSE_COLUMN_CLAUSES.has(t.upper))
      return definition.slice(0, t.start).trim()
  }
  return definition.trim()
}

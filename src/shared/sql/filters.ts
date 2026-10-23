// The table browser's filter bar → a SQL condition. Values come from text inputs, so every value
// is a quoted string literal; each engine coerces it to the column type in comparisons
// (`int_col = '5'` works on PG, MySQL, SQLite and ClickHouse).
//
// - contains / not contains: case-insensitive where it is cheap — PG `ILIKE` and ClickHouse
//   `ILIKE`; MySQL/MariaDB `LIKE` is already case-insensitive under the default collations and
//   SQLite `LIKE` is for ASCII. PG and ClickHouse need a text cast for non-text columns.
// - %, _ in the user's value are escaped: with `ESCAPE '!'` (no backslash, so the result is the
//   same with or without NO_BACKSLASH_ESCAPES / standard_conforming_strings) everywhere except
//   ClickHouse, which has no ESCAPE clause and always uses backslash.
// - `like` passes the user's own pattern through unescaped.
// - in / not in: comma-separated values, trimmed; "quoted, values" keep their commas. An empty
//   list contributes no condition (the user has not typed values yet).
// - join: the filters combine with AND (default) or OR (TablePlus' "any of"). An OR group is
//   parenthesised wherever something else is ANDed to it (the raw WHERE here, table-ops' clause)
//   so `a OR b AND raw` can never bind as `a OR (b AND raw)`.

import type { DataFilter, DataFilterJoin, SqlDialect } from '../data-projects/types'
import { quoteSqlIdentifier, quoteSqlString, type SqlQuoteOptions } from './quote'

/** Literal quoting (SqlQuoteOptions) plus how the filters combine. */
export interface SqlWhereOptions extends SqlQuoteOptions {
  /** 'and' (default): every filter must match; 'or': any filter may match. */
  join?: DataFilterJoin
}

/** The connective for a join value; anything but 'or' is AND (older callers send none). */
const connective = (join: DataFilterJoin | undefined): ' AND ' | ' OR ' =>
  join === 'or' ? ' OR ' : ' AND '

/** Splits an 'in' value: `a, b ,"c,d", 'e'` → ['a', 'b', 'c,d', 'e']; empty entries dropped. */
export function splitFilterList(value: string): string[] {
  const out: string[] = []
  let i = 0
  const n = value.length
  while (i < n) {
    while (i < n && /\s/.test(value[i] as string)) i++
    if (i >= n) break
    const q = value[i]
    if (q === '"' || q === "'") {
      let j = i + 1
      let item = ''
      for (; j < n; j++) {
        if (value[j] === q) {
          if (value[j + 1] === q) {
            item += q
            j++
            continue
          }
          break
        }
        item += value[j]
      }
      if (j >= n) {
        // Unbalanced quote: treat the rest literally.
        const rest = value.slice(i).trim()
        if (rest) out.push(rest)
        break
      }
      out.push(item)
      i = j + 1
      while (i < n && value[i] !== ',') i++
      i++
      continue
    }
    const comma = value.indexOf(',', i)
    const end = comma < 0 ? n : comma
    const item = value.slice(i, end).trim()
    if (item) out.push(item)
    i = end + 1
  }
  return out
}

const escapeLike = (value: string, escape: string): string =>
  value.replace(new RegExp(`[${escape === '\\' ? '\\\\' : escape}%_]`, 'g'), (m) => escape + m)

function likePredicate(
  column: string,
  pattern: string,
  dialect: SqlDialect,
  options: { caseInsensitive: boolean; negate: boolean; userPattern: boolean },
  quote: SqlQuoteOptions
): string {
  const not = options.negate ? 'NOT ' : ''
  if (dialect === 'clickhouse') {
    const op = options.caseInsensitive ? 'ILIKE' : 'LIKE'
    return `toString(${column}) ${not}${op} ${quoteSqlString(pattern, dialect)}`
  }
  const escapeClause = options.userPattern ? '' : " ESCAPE '!'"
  if (dialect === 'postgres') {
    const op = options.caseInsensitive ? 'ILIKE' : 'LIKE'
    return `CAST(${column} AS TEXT) ${not}${op} ${quoteSqlString(pattern, dialect)}${escapeClause}`
  }
  return `${column} ${not}LIKE ${quoteSqlString(pattern, dialect, quote)}${escapeClause}`
}

const COMPARISON: Readonly<Record<string, string>> = {
  '=': '=',
  '!=': '<>',
  '<': '<',
  '<=': '<=',
  '>': '>',
  '>=': '>='
}

/**
 * The condition for `filters`, joined with AND (or OR with `options.join`), WITHOUT the `WHERE`
 * keyword and without outer parentheses ('' when there is nothing to filter). Parenthesise an
 * OR result before ANDing anything to it; buildSqlWhereClause does, and returns a
 * ready-to-append ` WHERE …`.
 */
export function buildSqlWhere(
  filters: DataFilter[],
  dialect: SqlDialect,
  options: SqlWhereOptions = {}
): string {
  return filterConditions(filters, dialect, options).join(connective(options.join))
}

/**
 * One condition per filter that contributes one (an empty 'in' list does not). `options` only
 * matters for literal quoting (the quote helpers ignore `join`).
 */
function filterConditions(
  filters: DataFilter[],
  dialect: SqlDialect,
  options: SqlQuoteOptions
): string[] {
  const parts: string[] = []
  for (const filter of filters) {
    const column = quoteSqlIdentifier(filter.column, dialect)
    const value = filter.value ?? ''
    const ch = dialect === 'clickhouse' ? '\\' : '!'
    switch (filter.operator) {
      case '=':
      case '!=':
      case '<':
      case '<=':
      case '>':
      case '>=':
        parts.push(
          `${column} ${COMPARISON[filter.operator]} ${quoteSqlString(value, dialect, options)}`
        )
        break
      case 'contains':
      case 'not contains':
        parts.push(
          likePredicate(
            column,
            `%${escapeLike(value, ch)}%`,
            dialect,
            {
              caseInsensitive: true,
              negate: filter.operator === 'not contains',
              userPattern: false
            },
            options
          )
        )
        break
      case 'starts with':
        parts.push(
          likePredicate(
            column,
            `${escapeLike(value, ch)}%`,
            dialect,
            { caseInsensitive: false, negate: false, userPattern: false },
            options
          )
        )
        break
      case 'like':
        parts.push(
          likePredicate(
            column,
            value,
            dialect,
            { caseInsensitive: false, negate: false, userPattern: true },
            options
          )
        )
        break
      case 'in':
      case 'not in': {
        const items = splitFilterList(value)
        if (items.length === 0) break
        const list = items.map((v) => quoteSqlString(v, dialect, options)).join(', ')
        parts.push(`${column} ${filter.operator === 'in' ? 'IN' : 'NOT IN'} (${list})`)
        break
      }
      case 'is null':
        parts.push(`${column} IS NULL`)
        break
      case 'is not null':
        parts.push(`${column} IS NOT NULL`)
        break
      default:
        throw new Error(`Unsupported filter operator: ${String((filter as DataFilter).operator)}`)
    }
  }
  return parts
}

/**
 * ` WHERE <filters> AND (<raw where>)`, or '' when both are empty. With `options.join: 'or'`
 * the filters form one parenthesised group: ` WHERE (a OR b) AND (<raw where>)`. `rawWhere` is
 * the user's own WHERE text (a leading `WHERE` and trailing `;` are dropped; classify it before
 * running it); it is always parenthesised so its ORs stay contained.
 */
export function buildSqlWhereClause(
  filters: DataFilter[],
  dialect: SqlDialect,
  rawWhere?: string | null,
  options: SqlWhereOptions = {}
): string {
  const parts: string[] = []
  const conditions = filterConditions(filters, dialect, options)
  const raw = (rawWhere ?? '')
    .trim()
    .replace(/^where\s+/i, '')
    .replace(/;\s*$/, '')
  if (conditions.length > 0) {
    const built = conditions.join(connective(options.join))
    // `a OR b` next to the raw condition stays one group (OR binds looser than AND).
    parts.push(options.join === 'or' && raw && conditions.length > 1 ? `(${built})` : built)
  }
  // A trailing line comment in the raw text must not swallow what the caller appends after
  // the clause (ORDER BY, LIMIT): close the parenthesis on a new line then.
  if (raw) parts.push(/--|#/.test(raw) ? `(${raw}\n)` : `(${raw})`)
  if (parts.length === 0) return ''
  return ` WHERE ${parts.join(' AND ')}`
}

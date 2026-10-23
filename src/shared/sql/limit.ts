// Auto-limit rewrite for PostgreSQL and SQLite (research/safety.md §C2). Drivers always cap rows
// while streaming; this rewrite only exists so the planner can stop early (top-N sorts, no full
// scan for `SELECT * FROM big`). MySQL/MariaDB use `sql_select_limit` and ClickHouse uses
// settings instead (ClickHouse's `LIMIT n BY`, trailing SETTINGS/FORMAT and UNION binding make a
// textual rewrite hazardous), so for them this returns the statement unchanged.
//
// Rewritten only when ALL of these hold: the statement classifies as a plain read led by SELECT
// or WITH … SELECT (a fully parenthesised SELECT is fine); it lexes cleanly and is a single
// statement; and its top level has no LIMIT, FETCH, OFFSET, INTO, FOR (UPDATE/SHARE/…), LOCK or
// PROCEDURE. ` LIMIT n` is inserted right after the last code token, before any trailing
// whitespace, comment or `;` (a trailing `-- note` would otherwise comment it out). The query is
// never wrapped in `SELECT * FROM (…)`. Pass the N+1 you want to fetch (truncation detection is
// the caller's business).

import type { SqlDialect } from '../data-projects/types'
import { analyzeSqlStatement, classifySqlStatement, type SqlClassifyOptions } from './classify'

const BLOCKING_TOP_LEVEL_WORDS: ReadonlySet<string> = new Set([
  'LIMIT',
  'FETCH',
  'OFFSET',
  'INTO',
  'FOR',
  'LOCK',
  'PROCEDURE'
])

export function applyAutoLimit(
  statement: string,
  dialect: SqlDialect,
  limit: number,
  options?: SqlClassifyOptions
): { text: string; applied: boolean } {
  const unchanged = { text: statement, applied: false }
  if (dialect !== 'postgres' && dialect !== 'sqlite') return unchanged
  if (!Number.isSafeInteger(limit) || limit <= 0) return unchanged

  const analysis = analyzeSqlStatement(statement, dialect, options)
  const c = analysis.classification
  if (analysis.lexError || analysis.multipleStatements || analysis.codeEnd < 0) return unchanged
  if (c.classification !== 'read' || c.hasLimitClause) return unchanged
  if (c.leadingKeyword !== 'SELECT' && c.leadingKeyword !== 'WITH') return unchanged
  if (analysis.mainKeyword !== 'SELECT') return unchanged
  if (analysis.topLevelWords.some((w) => BLOCKING_TOP_LEVEL_WORDS.has(w))) return unchanged

  const at = analysis.codeEnd
  return {
    text: `${statement.slice(0, at)} LIMIT ${limit}${statement.slice(at)}`,
    applied: true
  }
}

/**
 * True when the statement has its own top-level LIMIT / FETCH (ClickHouse `LIMIT n BY` does not
 * count). Drivers then skip the auto-limit and keep only the hard cap: a LIMIT the user wrote
 * always wins, like MySQL's `sql_select_limit`.
 */
export function hasUserLimit(
  statement: string,
  dialect: SqlDialect,
  options?: SqlClassifyOptions
): boolean {
  try {
    return classifySqlStatement(statement, dialect, options).hasLimitClause
  } catch {
    return false
  }
}

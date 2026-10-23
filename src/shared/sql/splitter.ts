// Statement splitter on top of the shared lexer: "run all", "run statement under the cursor",
// the server's one-statement-per-driver-call execution and the per-statement safety
// classification all cut the text in exactly the same places.
//
// Spans are trimmed to code: a span starts at its first code token (an executable comment
// counts as code) and ends at its last one, so leading/trailing comments and the terminating
// `;`/custom delimiter are excluded. Leaving a trailing `-- note` out matters: drivers append
// text to statements (ClickHouse's `FORMAT …`, the PG/SQLite auto-limit) and a trailing line
// comment would swallow it. Comments INSIDE a statement stay. `text === source.slice(start, end)`.
//
// Delimiters do not split while inside:
// - a `BEGIN … END` body of CREATE TRIGGER/PROCEDURE/FUNCTION/EVENT (MySQL, MariaDB, SQLite),
//   MariaDB `BEGIN NOT ATOMIC … END`, PostgreSQL `BEGIN ATOMIC … END` (SQL-standard function
//   bodies). Counting only applies with the default `;` delimiter: with `DELIMITER $$` the user
//   already told us where statements end. `END IF/LOOP/WHILE/REPEAT/FOR` close constructs that
//   never opened a block; `CASE` (statement or expression) opens one closed by its `END`.
// - a MySQL executable comment: `SELECT 1 /*! ; DROP TABLE t */` stays ONE statement, which the
//   classifier refuses to call a read and the server (multi-statements off) rejects.
// PostgreSQL dollar-quoted bodies and every string/comment are single tokens, so a `;` inside
// them never reaches this code.

import type { SqlDialect } from '../data-projects/types'
import { isSqlTrivia, isSqlWord, lexSql, type SqlLexOptions, type SqlToken } from './lexer'

export interface SqlStatementSpan {
  /** `source.slice(start, end)`: trimmed, without the terminating `;`/delimiter. */
  text: string
  start: number
  end: number
}

/** A span plus the end of its terminator (= `end` when the statement has none). */
export interface SqlStatementSpanWithTerminator extends SqlStatementSpan {
  terminatorEnd: number
}

const ROUTINE_KINDS: ReadonlySet<string> = new Set([
  'TRIGGER',
  'PROCEDURE',
  'FUNCTION',
  'EVENT',
  'PACKAGE'
])
// Words that may sit between CREATE and the routine kind.
const ROUTINE_MODIFIERS: ReadonlySet<string> = new Set([
  'OR',
  'REPLACE',
  'TEMP',
  'TEMPORARY',
  'AGGREGATE',
  'CONSTRAINT',
  'DEFINER',
  'NONEDITIONABLE',
  'EDITIONABLE',
  'BODY',
  'IF',
  'NOT',
  'EXISTS'
])
const NON_BLOCK_ENDS: ReadonlySet<string> = new Set(['IF', 'LOOP', 'WHILE', 'REPEAT', 'FOR'])

/**
 * Decides whether the statement whose code tokens start at `code[0]` is a routine definition
 * whose BEGIN … END body may contain the delimiter.
 */
function isRoutineHead(code: SqlToken[], dialect: SqlDialect): boolean {
  const first = code[0]
  if (!first || !isSqlWord(first)) return false
  const head = first.upper
  if (head === 'BEGIN') {
    // MariaDB anonymous compound statement.
    return (
      (dialect === 'mariadb' || dialect === 'mysql') &&
      code[1]?.upper === 'NOT' &&
      code[2]?.upper === 'ATOMIC'
    )
  }
  if (head !== 'CREATE' && head !== 'ALTER') return false
  let k = 1
  while (k < code.length && k < 24) {
    const t = code[k] as SqlToken
    if (isSqlWord(t)) {
      const w = t.upper as string
      if (ROUTINE_KINDS.has(w)) return head === 'CREATE' || w === 'EVENT'
      if (w === 'DEFINER') {
        // DEFINER = user | 'user'@'host' | `user`@`host` | CURRENT_USER[()]
        k++
        if (code[k]?.text === '=') k++
        const user = code[k]
        if (!user) return false
        k++
        if (user.upper === 'CURRENT_USER' && code[k]?.text === '(' && code[k + 1]?.text === ')')
          k += 2
        while (k < code.length && (code[k]?.type === 'variable' || code[k]?.text === '@')) {
          if (code[k]?.text === '@') k++
          k++
        }
        continue
      }
      if (w === 'SQL' && code[k + 1]?.upper === 'SECURITY') {
        k += 3
        continue
      }
      if (w === 'ALGORITHM' && code[k + 1]?.text === '=') {
        k += 3
        continue
      }
      if (!ROUTINE_MODIFIERS.has(w)) return false
      k++
      continue
    }
    return false
  }
  return false
}

/**
 * Splits `text` into statements. Empty statements (only whitespace/comments between two
 * delimiters) are skipped; MySQL/MariaDB `DELIMITER` directive lines are never part of a span.
 */
export function splitSqlStatementsWithTerminators(
  text: string,
  dialect: SqlDialect,
  options?: SqlLexOptions
): SqlStatementSpanWithTerminator[] {
  return splitLexedSqlStatements(text, lexSql(text, dialect, options).tokens, dialect)
}

/**
 * The splitting itself, over tokens already produced by lexSql for `text` (the classifier
 * reuses it so "one statement" means the same thing everywhere).
 */
export function splitLexedSqlStatements(
  text: string,
  tokens: readonly SqlToken[],
  dialect: SqlDialect
): SqlStatementSpanWithTerminator[] {
  const out: SqlStatementSpanWithTerminator[] = []
  const blockBodies = dialect !== 'clickhouse'

  let code: SqlToken[] = []
  let routine: boolean | null = null
  let blockDepth = 0
  let execDepth = 0
  let prevWord = ''
  let delimiter = ';'

  const flush = (terminatorEnd: number): void => {
    const first = code[0]
    const last = code[code.length - 1]
    if (first && last) {
      out.push({
        text: text.slice(first.start, last.end),
        start: first.start,
        end: last.end,
        terminatorEnd: Math.max(terminatorEnd, last.end)
      })
    }
    code = []
    routine = null
    blockDepth = 0
    execDepth = 0
    prevWord = ''
  }

  // Lookahead to the next code token, for `BEGIN ATOMIC` and `END IF`.
  const nextCode = (from: number): SqlToken | undefined => {
    for (let k = from + 1; k < tokens.length; k++) {
      const t = tokens[k] as SqlToken
      if (!isSqlTrivia(t)) return t
    }
    return undefined
  }

  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k] as SqlToken
    if (isSqlTrivia(tok)) continue
    if (tok.type === 'delimiter') {
      if (tok.upper === 'DELIMITER') {
        flush(tok.start)
        const arg = tok.text.slice(9).trim().split(/[ \t]/)[0] ?? ';'
        delimiter = /^(['"`]).*\1$/.test(arg) && arg.length >= 2 ? arg.slice(1, -1) : arg
        continue
      }
      if (blockDepth > 0 || execDepth > 0) {
        code.push(tok)
        continue
      }
      flush(tok.end)
      continue
    }

    code.push(tok)
    if (tok.type === 'executable_comment') {
      execDepth += tok.text.startsWith('/*') ? 1 : -1
      if (execDepth < 0) execDepth = 0
      continue
    }
    if (!blockBodies || delimiter !== ';' || !isSqlWord(tok)) continue

    // Decide routine-ness once enough of the head is known (the first words settle it).
    const word = tok.upper as string
    if (!routine && code.length <= 24) {
      routine = isRoutineHead(
        code.filter((t) => t.type !== 'executable_comment'),
        dialect
      )
      // `BEGIN NOT ATOMIC` is only recognised at ATOMIC: count the BEGIN already passed.
      if (routine && code[0]?.upper === 'BEGIN') {
        blockDepth = 1
        prevWord = word
        continue
      }
    }
    if (routine) {
      if (word === 'BEGIN') {
        if (dialect !== 'postgres' || nextCode(k)?.upper === 'ATOMIC') blockDepth++
      } else if (word === 'CASE' && prevWord !== 'END') {
        blockDepth++
      } else if (word === 'END' && blockDepth > 0) {
        const after = nextCode(k)
        if (!(after && isSqlWord(after) && NON_BLOCK_ENDS.has(after.upper as string))) blockDepth--
      }
    }
    prevWord = word
  }
  const last = code[code.length - 1]
  flush(last ? last.end : text.length)
  return out
}

/** The statements of `text` (see splitSqlStatementsWithTerminators). */
export function splitSqlStatements(
  text: string,
  dialect: SqlDialect,
  options?: SqlLexOptions
): SqlStatementSpan[] {
  return splitSqlStatementsWithTerminators(text, dialect, options).map(
    ({ text: t, start, end }) => ({
      text: t,
      start,
      end
    })
  )
}

const lineOf = (text: string, offset: number): string => {
  const from = text.lastIndexOf('\n', offset - 1) + 1
  const to = text.indexOf('\n', offset)
  return text.slice(from, to < 0 ? text.length : to)
}

/**
 * The statement Cmd+Enter runs for a cursor at `offset`:
 * - inside a statement, or between its end and its terminator → that statement;
 * - on the same line after a statement's `;` (whitespace or comments) → that statement;
 * - on a blank line between statements, or on a comment block separated from the next statement
 *   by a blank line → the nearest previous statement;
 * - in the indentation or on comment lines directly above a statement → that statement;
 * - before the first statement → the first; after the last → the last.
 * Null only when the text holds no statement at all.
 */
export function statementAtOffset(
  text: string,
  offset: number,
  dialect: SqlDialect,
  options?: SqlLexOptions
): SqlStatementSpan | null {
  const spans = splitSqlStatementsWithTerminators(text, dialect, options)
  if (spans.length === 0) return null
  const pos = Math.max(0, Math.min(Number.isFinite(offset) ? Math.floor(offset) : 0, text.length))
  const strip = (s: SqlStatementSpanWithTerminator): SqlStatementSpan => ({
    text: s.text,
    start: s.start,
    end: s.end
  })

  let prev: SqlStatementSpanWithTerminator | null = null
  let next: SqlStatementSpanWithTerminator | null = null
  for (const span of spans) {
    if (pos >= span.start && pos <= span.terminatorEnd) return strip(span)
    if (span.terminatorEnd < pos) prev = span
    else if (span.start > pos) {
      next = span
      break
    }
  }
  if (!prev) return next ? strip(next) : null
  if (!next) return strip(prev)
  if (!text.slice(prev.terminatorEnd, pos).includes('\n')) return strip(prev)
  const between = text.slice(pos, next.start)
  if (lineOf(text, pos).trim() !== '' && !/\n[ \t\r]*\n/.test(between)) return strip(next)
  return strip(prev)
}

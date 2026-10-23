// "Format SQL" (sql-formatter, MIT) for the query editor.
//
// Formatting is done statement by statement, using the shared splitter: sql-formatter does not
// understand MySQL's `DELIMITER` client command, and formatting each span in place keeps the
// user's own separators, comments between statements and blank lines. A statement the formatter
// cannot parse (vendor syntax it lacks) is left untouched rather than failing the whole command.

import type { EditorView } from '@codemirror/view'
import { Transaction } from '@codemirror/state'
import {
  clickhouse,
  formatDialect,
  mariadb,
  mysql,
  postgresql,
  sqlite,
  type DialectOptions
} from 'sql-formatter'
import type { SqlDialect } from '@shared/data-projects/types'
import { splitSqlStatements } from '@shared/sql'

const FORMATTER_DIALECTS: Readonly<Record<SqlDialect, DialectOptions>> = {
  mysql,
  mariadb,
  postgres: postgresql,
  sqlite,
  clickhouse
}

// SQLite accepts every placeholder style; tell the formatter so `:name`/`@x`/`$x` survive.
const PARAM_TYPES: Partial<Record<SqlDialect, Parameters<typeof formatDialect>[1]['paramTypes']>> =
  {
    sqlite: { positional: true, numbered: ['?'], named: [':', '@', '$'] }
  }

export type FormatKeywordCase = 'upper' | 'lower' | 'preserve'

/** Formats one statement. Throws when sql-formatter cannot parse it. */
export function formatSql(
  text: string,
  dialect: SqlDialect,
  keywordCase: FormatKeywordCase = 'upper'
): string {
  return formatDialect(text, {
    dialect: FORMATTER_DIALECTS[dialect],
    keywordCase,
    tabWidth: 2,
    linesBetweenQueries: 1,
    ...(PARAM_TYPES[dialect] ? { paramTypes: PARAM_TYPES[dialect] } : {})
  })
}

export interface FormatChange {
  from: number
  to: number
  insert: string
}

/**
 * The edits that format every statement of `text` (or only [from, to) when a range is given).
 * `failed` counts statements that could not be parsed and were left as they were.
 */
export function formatSqlChanges(
  text: string,
  dialect: SqlDialect,
  range?: { from: number; to: number } | null,
  keywordCase: FormatKeywordCase = 'upper'
): { changes: FormatChange[]; failed: number } {
  const changes: FormatChange[] = []
  let failed = 0
  if (range && range.to > range.from) {
    const slice = text.slice(range.from, range.to)
    const spans = splitSqlStatements(slice, dialect)
    for (const span of spans) {
      try {
        const formatted = formatSql(span.text, dialect, keywordCase)
        if (formatted !== span.text) {
          changes.push({
            from: range.from + span.start,
            to: range.from + span.end,
            insert: formatted
          })
        }
      } catch {
        failed++
      }
    }
    return { changes, failed }
  }
  for (const span of splitSqlStatements(text, dialect)) {
    try {
      const formatted = formatSql(span.text, dialect, keywordCase)
      if (formatted !== span.text)
        changes.push({ from: span.start, to: span.end, insert: formatted })
    } catch {
      failed++
    }
  }
  return { changes, failed }
}

/**
 * Formats the selection (or the whole document) of a SQL editor as one undo step.
 * Returns how many statements could not be formatted.
 */
export function formatEditorSql(
  view: EditorView,
  dialect: SqlDialect,
  keywordCase: FormatKeywordCase = 'upper'
): { changed: boolean; failed: number } {
  const sel = view.state.selection.main
  const { changes, failed } = formatSqlChanges(
    view.state.doc.toString(),
    dialect,
    sel.empty ? null : { from: sel.from, to: sel.to },
    keywordCase
  )
  if (changes.length) {
    view.dispatch({
      changes,
      userEvent: 'format',
      annotations: Transaction.addToHistory.of(true),
      scrollIntoView: true
    })
  }
  return { changed: changes.length > 0, failed }
}

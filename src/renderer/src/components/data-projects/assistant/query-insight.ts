// Read-only views of a proposed query for the proposal card: syntax tokens (SQL through the
// shared lexer, mongosh through a small scanner) and a READ/WRITE verdict from the shared
// classifiers — the model's own `isWrite` claim can only add caution, never remove it.
// Everything here is pure and tolerant: a lexer/classifier failure degrades to plain text and
// the model's claim instead of breaking the panel.

import { classifyMongoShellStatement, splitMongoShell } from '@shared/data-projects/mongo-shell'
import { classifySqlStatement, lexSql, splitSqlStatements } from '@shared/sql'
import type { DataStatementClass, SqlDialect } from '@shared/data-projects/types'

export type QueryTokenKind =
  | 'keyword'
  | 'string'
  | 'number'
  | 'comment'
  | 'function'
  | 'operator'
  | 'punctuation'
  | 'variable'
  | 'identifier'
  | 'plain'

export interface QueryToken {
  kind: QueryTokenKind
  text: string
}

/** Token colours (light + dark), the same roles as the editor theme's. */
export const QUERY_TOKEN_CLASS: Record<QueryTokenKind, string> = {
  keyword: 'text-violet-700 dark:text-violet-300',
  string: 'text-emerald-700 dark:text-emerald-300',
  number: 'text-orange-700 dark:text-orange-300',
  comment: 'text-muted-foreground italic',
  function: 'text-sky-700 dark:text-sky-300',
  operator: 'text-muted-foreground',
  punctuation: 'text-muted-foreground',
  variable: 'text-pink-700 dark:text-pink-300',
  identifier: '',
  plain: ''
}

function sqlTokens(text: string, dialect: SqlDialect): QueryToken[] {
  const { tokens } = lexSql(text, dialect)
  const out: QueryToken[] = []
  let cursor = 0
  tokens.forEach((token, i) => {
    // Anything the lexer skipped (it should not) stays visible as plain text.
    if (token.start > cursor) out.push({ kind: 'plain', text: text.slice(cursor, token.start) })
    let kind: QueryTokenKind
    switch (token.type) {
      case 'keyword':
        kind = 'keyword'
        break
      case 'string':
        kind = 'string'
        break
      case 'number':
        kind = 'number'
        break
      case 'comment':
        kind = 'comment'
        break
      case 'operator':
        kind = 'operator'
        break
      case 'punctuation':
      case 'delimiter':
        kind = 'punctuation'
        break
      case 'parameter':
      case 'variable':
        kind = 'variable'
        break
      case 'executable_comment':
        kind = 'keyword'
        break
      case 'identifier': {
        let j = i + 1
        while (
          j < tokens.length &&
          (tokens[j].type === 'whitespace' || tokens[j].type === 'comment')
        )
          j++
        kind = tokens[j]?.text === '(' ? 'function' : 'identifier'
        break
      }
      case 'quoted_identifier':
        kind = 'identifier'
        break
      default:
        kind = 'plain'
    }
    out.push({ kind, text: text.slice(token.start, token.end) })
    cursor = Math.max(cursor, token.end)
  })
  if (cursor < text.length) out.push({ kind: 'plain', text: text.slice(cursor) })
  return out
}

const MONGO_KEYWORDS = new Set(['true', 'false', 'null', 'undefined', 'new', 'db', 'use', 'show'])
const MONGO_PATTERN =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_$][\w$]*)|([{}()[\],.:;])|(\s+)|([^\s])/g

function mongoTokens(text: string): QueryToken[] {
  const out: QueryToken[] = []
  const matches = [...text.matchAll(MONGO_PATTERN)]
  matches.forEach((match, i) => {
    const [whole, comment, string, number, word, punctuation, space] = match
    let kind: QueryTokenKind = 'plain'
    if (comment) kind = 'comment'
    else if (string) kind = 'string'
    else if (number) kind = 'number'
    else if (word) {
      if (MONGO_KEYWORDS.has(word)) kind = 'keyword'
      else if (word.startsWith('$')) kind = 'variable'
      else {
        let j = i + 1
        while (j < matches.length && matches[j][6]) j++
        kind = matches[j]?.[0] === '(' ? 'function' : 'identifier'
      }
    } else if (punctuation) kind = 'punctuation'
    else if (space) kind = 'plain'
    else kind = 'operator'
    out.push({ kind, text: whole })
  })
  return out
}

/** Tokens covering `text` exactly (concatenated they give the text back). */
export function tokenizeQuery(
  text: string,
  language: 'sql' | 'mongo',
  dialect: SqlDialect | null
): QueryToken[] {
  try {
    if (language === 'mongo') return mongoTokens(text)
    if (dialect) return sqlTokens(text, dialect)
  } catch {
    // Fall back to plain text below.
  }
  return [{ kind: 'plain', text }]
}

export interface QueryVerdict {
  /** 'write' when any statement is not a plain read (or the model said so). */
  kind: 'read' | 'write'
  /** The classes the shared classifier found (empty when it could not run). */
  classes: DataStatementClass[]
  /** Red warnings: "DELETE without WHERE", "DROP TABLE"... */
  dangerous: string[]
}

const isReadClass = (cls: DataStatementClass): boolean => cls === 'read' || cls === 'session'

export function classifyQuery(
  text: string,
  language: 'sql' | 'mongo',
  dialect: SqlDialect | null,
  claimedWrite: boolean
): QueryVerdict {
  const classes: DataStatementClass[] = []
  const dangerous: string[] = []
  try {
    if (language === 'mongo') {
      for (const statement of splitMongoShell(text)) {
        const verdict = classifyMongoShellStatement(statement.text)
        classes.push(verdict.classification)
        dangerous.push(...verdict.dangerous)
      }
    } else if (dialect) {
      for (const statement of splitSqlStatements(text, dialect)) {
        const verdict = classifySqlStatement(statement.text, dialect)
        classes.push(verdict.classification)
        dangerous.push(...verdict.dangerous)
      }
    }
  } catch {
    // Unclassifiable: the model's claim decides below.
  }
  const write = claimedWrite || classes.some((cls) => !isReadClass(cls))
  return { kind: write ? 'write' : 'read', classes, dangerous: [...new Set(dangerous)] }
}

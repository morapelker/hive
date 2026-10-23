// MySQL / MariaDB column definitions as SHOW CREATE TABLE prints them, split into clauses so a
// CHANGE / MODIFY COLUMN can restate the column with only the edited parts replaced. MySQL has no
// "ALTER COLUMN TYPE": MODIFY rewrites the whole definition, and anything left out (collation,
// ON UPDATE, AUTO_INCREMENT, COMMENT, INVISIBLE, an inline CHECK, a generated expression) is
// silently dropped. Keeping every clause we do not edit verbatim is what makes the edit safe.
//
//   `ts` timestamp(3) NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'x'
//        └ type ──────┘└ nullability┘└ default ──────────┘└ onUpdate ─────────────────┘└ comment ┘
//
// Clauses we do not model (INVISIBLE, CHECK (...), /*!80023 INVISIBLE */, SRID, COLUMN_FORMAT,
// STORAGE, ...) are kept as 'other' and written back in place. Parsing uses the shared lexer, so
// strings ('it''s'), introducers (_utf8mb4'x'), b'..' literals and executable comments are read
// exactly like the server and the safety classifier read them.
//
// SHOW CREATE TABLE always writes string literals with backslash escapes ('C:\\tmp'), even in a
// session running with NO_BACKSLASH_ESCAPES, where that text would mean two backslashes: for such
// a session `restateMysqlLiterals` rewrites every literal of the definition into the session's
// form first, so what is kept, shown and sent means what SHOW CREATE TABLE meant.
//
// MariaDB prints a column-level CHECK inline (`CHECK (json_valid(`j`))`, every JSON column has
// one). CHANGE COLUMN restates it, and the restated CHECK must name the column by its new name.

import type { SqlDialect } from '@shared/data-projects/types'
import {
  lexSql,
  quoteSqlIdentifier,
  unquoteSqlIdentifier,
  type SqlLexOptions,
  type SqlToken
} from '@shared/sql'
import { isTextualMysqlType } from './type-catalog'

export type MysqlClauseKind =
  | 'type'
  | 'charset'
  | 'collate'
  | 'generated'
  | 'nullability'
  | 'default'
  | 'onUpdate'
  | 'autoIncrement'
  | 'comment'
  | 'other'

export interface MysqlClause {
  kind: MysqlClauseKind
  text: string
}

export interface MysqlColumnDefinition {
  clauses: MysqlClause[]
}

/** Words that end the data type and start a column attribute. */
const CLAUSE_WORDS: ReadonlySet<string> = new Set([
  'CHARACTER',
  'CHARSET',
  'COLLATE',
  'GENERATED',
  'AS',
  'NOT',
  'NULL',
  'DEFAULT',
  'ON',
  'AUTO_INCREMENT',
  'COMMENT',
  'COLUMN_FORMAT',
  'STORAGE',
  'SRID',
  'VISIBLE',
  'INVISIBLE',
  'PRIMARY',
  'UNIQUE',
  'KEY',
  'CHECK',
  'REFERENCES',
  'CONSTRAINT',
  'ENGINE_ATTRIBUTE',
  'SECONDARY_ENGINE_ATTRIBUTE',
  'PERSISTENT',
  'VIRTUAL',
  'STORED',
  'COMPRESSED',
  'WITH',
  'WITHOUT'
])

const GENERATED_STORAGE: ReadonlySet<string> = new Set(['VIRTUAL', 'STORED', 'PERSISTENT'])

interface Unit {
  kind: 'word' | 'group' | 'string' | 'number' | 'operator' | 'exec' | 'other'
  start: number
  end: number
  upper?: string
}

/** Tokens → units: words, literals, a whole (...) group, a whole executable comment. */
function toUnits(tokens: SqlToken[]): Unit[] | null {
  const sig = tokens.filter((t) => t.type !== 'whitespace' && t.type !== 'comment')
  const units: Unit[] = []
  for (let i = 0; i < sig.length; i++) {
    const t = sig[i]
    if (t.type === 'punctuation' && t.text === '(') {
      let depth = 0
      let j = i
      for (; j < sig.length; j++) {
        const p = sig[j]
        if (p.type !== 'punctuation') continue
        if (p.text === '(') depth++
        else if (p.text === ')' && --depth === 0) break
      }
      if (j >= sig.length) return null
      units.push({ kind: 'group', start: t.start, end: sig[j].end })
      i = j
    } else if (t.type === 'executable_comment' && t.text !== '*/') {
      let j = i + 1
      while (j < sig.length && !(sig[j].type === 'executable_comment' && sig[j].text === '*/')) j++
      if (j >= sig.length) return null
      units.push({ kind: 'exec', start: t.start, end: sig[j].end })
      i = j
    } else if (t.type === 'keyword' || t.type === 'identifier') {
      units.push({ kind: 'word', start: t.start, end: t.end, upper: t.upper })
    } else if (t.type === 'quoted_identifier') {
      units.push({ kind: 'word', start: t.start, end: t.end })
    } else if (t.type === 'string') {
      units.push({ kind: 'string', start: t.start, end: t.end })
    } else if (t.type === 'number') {
      units.push({ kind: 'number', start: t.start, end: t.end })
    } else if (t.type === 'operator') {
      units.push({ kind: 'operator', start: t.start, end: t.end, upper: t.text })
    } else if (t.type === 'punctuation' && (t.text === ')' || t.text === ',' || t.text === ';')) {
      // A stray `)` or a `,`/`;` at the top level: not a single column definition.
      return null
    } else {
      units.push({ kind: 'other', start: t.start, end: t.end })
    }
  }
  return units
}

/**
 * Index of the last unit of the value after DEFAULT / ON UPDATE starting at `i`: an optional
 * sign, then a (...) group, a literal, or a word with an adjacent literal (`_utf8mb4'x'`) or call
 * parentheses (`current_timestamp(3)`, `uuid()`).
 */
function valueEnd(units: Unit[], i: number): number {
  let j = i
  if (units[j]?.kind === 'operator' && (units[j].upper === '-' || units[j].upper === '+')) j++
  const u = units[j]
  if (!u) return -1
  if (u.kind === 'word') {
    const next = units[j + 1]
    if (next && next.start === u.end && (next.kind === 'string' || next.kind === 'group'))
      return j + 1
    return j
  }
  if (u.kind === 'group' || u.kind === 'string' || u.kind === 'number') return j
  return -1
}

/**
 * Splits the text after the column name (`varchar(50) NOT NULL DEFAULT 'x' COMMENT 'y'`) into
 * clauses. Null when it does not lex cleanly or has no data type.
 */
export function parseMysqlColumnDefinition(
  text: string,
  dialect: SqlDialect,
  options: SqlLexOptions = {}
): MysqlColumnDefinition | null {
  const lexed = lexSql(text, dialect, options)
  if (lexed.error) return null
  const units = toUnits(lexed.tokens)
  if (!units || units.length === 0) return null
  const slice = (from: number, to: number): string =>
    text.slice(units[from].start, units[to].end).trim()
  const clauses: MysqlClause[] = []

  let i = 0
  while (
    i < units.length &&
    units[i].kind !== 'exec' &&
    !(units[i].kind === 'word' && units[i].upper && CLAUSE_WORDS.has(units[i].upper!))
  )
    i++
  if (i === 0) return null
  clauses.push({ kind: 'type', text: slice(0, i - 1) })

  const word = (k: number): string | undefined =>
    units[k]?.kind === 'word' ? units[k].upper : undefined
  while (i < units.length) {
    const u = units[i]
    const w = word(i)
    let end = i
    let kind: MysqlClauseKind = 'other'
    if (w === 'CHARACTER' && word(i + 1) === 'SET' && units[i + 2]) {
      kind = 'charset'
      end = i + 2
    } else if (w === 'CHARSET' && units[i + 1]) {
      kind = 'charset'
      end = i + 1
    } else if (w === 'COLLATE' && units[i + 1]) {
      kind = 'collate'
      end = i + 1
    } else if (
      (w === 'GENERATED' && word(i + 1) === 'ALWAYS' && word(i + 2) === 'AS') ||
      w === 'AS'
    ) {
      const g = w === 'AS' ? i + 1 : i + 3
      if (units[g]?.kind !== 'group') return null
      kind = 'generated'
      end = GENERATED_STORAGE.has(word(g + 1) ?? '') ? g + 1 : g
    } else if (w === 'NOT' && word(i + 1) === 'NULL') {
      kind = 'nullability'
      end = i + 1
    } else if (w === 'NULL') {
      kind = 'nullability'
    } else if (w === 'DEFAULT') {
      end = valueEnd(units, i + 1)
      if (end < 0) return null
      kind = 'default'
    } else if (w === 'ON' && word(i + 1) === 'UPDATE') {
      end = valueEnd(units, i + 2)
      if (end < 0) return null
      kind = 'onUpdate'
    } else if (w === 'AUTO_INCREMENT') {
      kind = 'autoIncrement'
    } else if (w === 'COMMENT' && units[i + 1]?.kind === 'string') {
      kind = 'comment'
      end = i + 1
    } else if (u.kind === 'word' && units[i + 1]?.kind === 'group') {
      // CHECK (...), and any other word with an argument list.
      end = i + 1
    }
    clauses.push({ kind, text: slice(i, end) })
    i = end + 1
  }
  return { clauses }
}

/** The raw SQL after DEFAULT ('' when the column has no DEFAULT clause). */
export function mysqlDefaultExpression(def: MysqlColumnDefinition): string {
  const clause = def.clauses.find((c) => c.kind === 'default')
  return clause ? clause.text.replace(/^DEFAULT\s+/i, '') : ''
}

export const mysqlTypeOf = (def: MysqlColumnDefinition): string =>
  def.clauses.find((c) => c.kind === 'type')?.text ?? ''

export const isMysqlGenerated = (def: MysqlColumnDefinition): boolean =>
  def.clauses.some((c) => c.kind === 'generated')

export interface MysqlColumnPatch {
  type?: string
  nullable?: boolean
  /** Raw SQL after DEFAULT; '' removes the DEFAULT clause. */
  defaultExpr?: string
  /** Quoted comment literal; '' removes the COMMENT clause. */
  commentLiteral?: string
  /** CHANGE COLUMN renames the column: its inline CHECK clauses follow the new name. */
  rename?: { from: string; to: string }
}

const KIND_ORDER: readonly MysqlClauseKind[] = [
  'type',
  'charset',
  'collate',
  'generated',
  'nullability',
  'default',
  'onUpdate',
  'autoIncrement',
  'comment'
]

/** Inserts `clause` right after the last existing clause of one of the kinds before it. */
function insertAfter(clauses: MysqlClause[], clause: MysqlClause): void {
  const rank = KIND_ORDER.indexOf(clause.kind)
  let at = 0
  clauses.forEach((c, i) => {
    const r = KIND_ORDER.indexOf(c.kind)
    if (r >= 0 && r < rank) at = i + 1
  })
  clauses.splice(at, 0, clause)
}

function setClause(clauses: MysqlClause[], kind: MysqlClauseKind, text: string | null): void {
  const at = clauses.findIndex((c) => c.kind === kind)
  if (text === null) {
    if (at >= 0) clauses.splice(at, 1)
  } else if (at >= 0) {
    clauses[at] = { kind, text }
  } else {
    insertAfter(clauses, { kind, text })
  }
}

/**
 * The column definition with `patch` applied and every other clause kept as it was. A type
 * change to a non-text type drops CHARACTER SET / COLLATE; making the column NOT NULL drops a
 * `DEFAULT NULL` the patch does not replace (MySQL would refuse it).
 */
export function buildMysqlColumnDefinition(
  def: MysqlColumnDefinition,
  patch: MysqlColumnPatch,
  options: { mariadb: boolean; dialect?: SqlDialect; lex?: SqlLexOptions }
): string {
  const clauses = def.clauses.map((c) => ({ ...c }))
  if (patch.rename) {
    const dialect = options.dialect ?? (options.mariadb ? 'mariadb' : 'mysql')
    for (const c of clauses) {
      if (c.kind === 'other' && /^CHECK\b/i.test(c.text))
        c.text = renameColumnReferences(
          c.text,
          patch.rename.from,
          patch.rename.to,
          dialect,
          options.lex
        )
    }
  }
  if (patch.type !== undefined) {
    setClause(clauses, 'type', patch.type.trim())
    if (!isTextualMysqlType(patch.type, options.mariadb)) {
      setClause(clauses, 'charset', null)
      setClause(clauses, 'collate', null)
    }
  }
  if (patch.nullable !== undefined) {
    setClause(clauses, 'nullability', patch.nullable ? 'NULL' : 'NOT NULL')
    const current = clauses.find((c) => c.kind === 'default')
    if (!patch.nullable && patch.defaultExpr === undefined && current) {
      if (/^DEFAULT\s+NULL$/i.test(current.text)) setClause(clauses, 'default', null)
    }
  }
  if (patch.defaultExpr !== undefined) {
    const expr = patch.defaultExpr.trim()
    setClause(clauses, 'default', expr ? `DEFAULT ${expr}` : null)
  }
  if (patch.commentLiteral !== undefined) {
    setClause(clauses, 'comment', patch.commentLiteral ? `COMMENT ${patch.commentLiteral}` : null)
  }
  return clauses.map((c) => c.text).join(' ')
}

/**
 * `text` with every reference to the column `from` (quoted or bare, compared without case like
 * MySQL column names; not a function name, not a qualified part) written as `to`.
 */
export function renameColumnReferences(
  text: string,
  from: string,
  to: string,
  dialect: SqlDialect,
  options: SqlLexOptions = {}
): string {
  const tokens = lexSql(text, dialect, options).tokens
  const target = from.toLowerCase()
  const significant = (i: number, step: 1 | -1): SqlToken | undefined => {
    for (let j = i + step; j >= 0 && j < tokens.length; j += step) {
      const t = tokens[j]
      if (t.type !== 'whitespace' && t.type !== 'comment') return t
    }
    return undefined
  }
  let out = ''
  let last = 0
  tokens.forEach((t, i) => {
    const name =
      t.type === 'quoted_identifier'
        ? unquoteSqlIdentifier(t.text)
        : t.type === 'identifier'
          ? t.text
          : null
    if (name === null || name.toLowerCase() !== target) return
    if (significant(i, 1)?.text === '(' || significant(i, -1)?.text === '.') return
    out += text.slice(last, t.start) + quoteSqlIdentifier(to, dialect)
    last = t.end
  })
  return out + text.slice(last)
}

/** Decodes the body of a backslash-escaped MySQL string literal (quote char `q`). */
function decodeEscaped(body: string, q: string): string {
  let out = ''
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === '\\' && i + 1 < body.length) {
      const e = body[++i]
      switch (e) {
        case '0':
          out += '\0'
          break
        case 'b':
          out += '\b'
          break
        case 'n':
          out += '\n'
          break
        case 'r':
          out += '\r'
          break
        case 't':
          out += '\t'
          break
        case 'Z':
          out += '\x1a'
          break
        // LIKE wildcards keep their backslash (MySQL reads `\%` as two characters).
        case '%':
        case '_':
          out += `\\${e}`
          break
        default:
          out += e
      }
    } else if (ch === q && body[i + 1] === q) {
      out += q
      i++
    } else out += ch
  }
  return out
}

/**
 * Rewrites the string literals of SHOW CREATE TABLE text (always written with backslash escapes)
 * for a session running with NO_BACKSLASH_ESCAPES, where a backslash is an ordinary character:
 * `'C:\\tmp'` → `'C:\tmp'`, `'a\'b'` → `'a''b'`. Null when a literal holds a NUL or Ctrl-Z, which
 * that mode has no way to write.
 */
export function restateMysqlLiterals(text: string, dialect: SqlDialect): string | null {
  const lexed = lexSql(text, dialect, { backslashEscapes: true })
  if (lexed.error) return null
  let out = ''
  let last = 0
  for (const t of lexed.tokens) {
    if (t.type !== 'string' || !t.text.includes('\\')) continue
    const open = t.text.search(/['"]/)
    const prefix = t.text.slice(0, open)
    // X'..' / B'..' hold only hex / binary digits.
    if (/^[xb]$/i.test(prefix)) continue
    const value = decodeEscaped(t.text.slice(open + 1, -1), t.text[open])
    if (value.includes('\0') || value.includes('\x1a')) return null
    out += `${text.slice(last, t.start)}${prefix}'${value.replace(/'/g, "''")}'`
    last = t.end
  }
  return out + text.slice(last)
}

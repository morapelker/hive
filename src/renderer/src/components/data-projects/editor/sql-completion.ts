// Alias- and scope-aware SQL completion, built on the shared lexer (not on lang-sql's
// `sql({ schema })`, whose token-level tree misses unqualified columns, UPDATE/INSERT column
// lists, subqueries and CTEs; research/editor.md §2).
//
// Pipeline, all pure and unit-tested:
// 1. `completionStatement` cuts the statement around the cursor (between delimiters, so a half
//    typed statement after the last `;` still counts);
// 2. `analyzeSqlCompletion` lexes it once and works out
//    - the word being typed (an opening quote is remembered and masked so an unterminated
//      `"Us` does not swallow the rest of the statement),
//    - what is wanted there: a qualified member (`u.`, `public.`, `analytics.events.`), a table
//      (after FROM/JOIN/UPDATE/INTO/TABLE or a comma in a FROM list), a column (SELECT list,
//      WHERE/ON/BY/SET/HAVING/..., function arguments), an INSERT column list, or nothing
//      schema-related (alias position, statement start: keywords only),
//    - the tables in scope per query level, innermost first: FROM/JOIN lists, UPDATE/INSERT
//      targets, derived tables `(SELECT …) s` with their select-list names (and `*` expansion),
//      and CTEs `WITH x [(cols)] AS (…)` (best effort);
// 3. `buildSqlCompletionIndex` turns a DataCompletionSchema snapshot into lookup maps and
//    prebuilt Completion objects once per snapshot (never per keystroke);
// 4. `sqlSchemaCompletions` produces the options; `sqlSchemaCompletionSource` glues it all to
//    CodeMirror and `sqlKeywordCompletionSource` adds keywords in the configured case.

import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource
} from '@codemirror/autocomplete'
import { pickedCompletion } from '@codemirror/autocomplete'
import { keywordCompletionSource } from '@codemirror/lang-sql'
import { syntaxTree } from '@codemirror/language'
import type { EditorView } from '@codemirror/view'
import type {
  DataCompletionSchema,
  DataCompletionTable,
  DataObjectKind,
  SqlDialect
} from '@shared/data-projects/types'
import {
  lexSql,
  quoteSqlIdentifier,
  splitSqlStatementsWithTerminators,
  unquoteSqlIdentifier,
  type SqlToken
} from '@shared/sql'
import { dataEditorConfig } from './context'
import { cmSqlDialect, SQL_FUNCTIONS } from './dialects'

// ---------------------------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------------------------

/** A code token (no whitespace/comments) with its parenthesis depth. */
export interface CompletionToken {
  type: SqlToken['type']
  text: string
  start: number
  end: number
  /** Upper-cased text of bare words; '' otherwise. */
  upper: string
  /** `(` and `)` carry the OUTER depth; tokens between them depth + 1. */
  depth: number
}

const isWordToken = (t: CompletionToken | undefined): boolean =>
  !!t && (t.type === 'keyword' || t.type === 'identifier')
const isNameToken = (t: CompletionToken | undefined): boolean =>
  !!t && (t.type === 'identifier' || t.type === 'keyword' || t.type === 'quoted_identifier')
const isPunct = (t: CompletionToken | undefined, text: string): boolean =>
  !!t && t.type === 'punctuation' && t.text === text
const nameOf = (t: CompletionToken): string =>
  t.type === 'quoted_identifier' ? unquoteSqlIdentifier(t.text) : t.text

function codeTokens(text: string, dialect: SqlDialect): CompletionToken[] {
  const out: CompletionToken[] = []
  let depth = 0
  for (const t of lexSql(text, dialect).tokens) {
    if (t.type === 'whitespace' || t.type === 'comment') continue
    const upper =
      t.type === 'keyword' || t.type === 'identifier' ? (t.upper ?? t.text.toUpperCase()) : ''
    if (t.type === 'punctuation' && t.text === '(') {
      out.push({ type: t.type, text: t.text, start: t.start, end: t.end, upper, depth })
      depth++
    } else if (t.type === 'punctuation' && t.text === ')') {
      depth = Math.max(0, depth - 1)
      out.push({ type: t.type, text: t.text, start: t.start, end: t.end, upper, depth })
    } else {
      out.push({ type: t.type, text: t.text, start: t.start, end: t.end, upper, depth })
    }
  }
  return out
}

/** Index of the `)` closing the `(` at `open` (tokens.length when unclosed). */
function matchParen(tokens: CompletionToken[], open: number): number {
  const depth = tokens[open].depth
  for (let i = open + 1; i < tokens.length; i++) {
    if (tokens[i].depth === depth && isPunct(tokens[i], ')')) return i
  }
  return tokens.length
}

// ---------------------------------------------------------------------------------------------
// Statement under the cursor
// ---------------------------------------------------------------------------------------------

/**
 * The text between the delimiter before `pos` and the next one (or the end): the statement being
 * typed, even when it is incomplete or follows the last `;`.
 */
export function completionStatement(
  doc: string,
  pos: number,
  dialect: SqlDialect
): { from: number; to: number } {
  let from = 0
  let to = doc.length
  for (const span of splitSqlStatementsWithTerminators(doc, dialect)) {
    if (span.terminatorEnd <= span.end) continue // unterminated: belongs to the cursor's segment
    if (span.terminatorEnd <= pos) from = Math.max(from, span.terminatorEnd)
    else {
      to = Math.max(span.end, Math.min(pos, span.terminatorEnd))
      break
    }
  }
  return { from, to: Math.max(to, Math.min(pos, doc.length)) }
}

// ---------------------------------------------------------------------------------------------
// Scope analysis
// ---------------------------------------------------------------------------------------------

/** Column names of a derived table / CTE; `star` lists the inner refs a `*` expands to. */
export interface DerivedColumns {
  names: string[]
  star: ScopeRef[]
}

export interface ScopeRef {
  /** Unquoted name path as written: ['users'], ['public', 'users'], ['db', 'schema', 't']. */
  path: string[]
  alias: string | null
  /** Set for `(subquery) alias` and table functions (empty names). */
  derived?: DerivedColumns
  /** 0 = the innermost query level around the cursor; outer levels count up. */
  level: number
  /** Offset of the reference's first token (internal: lets the typed word be skipped). */
  at?: number
}

export interface CteDefinition {
  name: string
  columns: DerivedColumns
}

export type CompletionWant =
  | { kind: 'qualified'; path: string[] }
  | { kind: 'table' }
  | { kind: 'column' }
  | { kind: 'insertColumns'; table: string[] }
  | { kind: 'none' }

export interface SqlCompletionAnalysis {
  want: CompletionWant
  scope: ScopeRef[]
  ctes: CteDefinition[]
  /** Offset (in the analysed text) where the replaced word starts (after an opening quote). */
  wordFrom: number
  /** The typed prefix (without the opening quote). */
  word: string
  /** Opening quote the user typed (`"`, `` ` ``, `[`), if any. */
  quote: string | null
}

const TABLE_FUNCTION_OR_SUBQUERY_SKIP = new Set(['LATERAL', 'ONLY'])

// Words that end a FROM list item (so they are never read as an alias).
const ALIAS_STOP = new Set([
  'WHERE',
  'GROUP',
  'ORDER',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'UNION',
  'INTERSECT',
  'EXCEPT',
  'MINUS',
  'ON',
  'USING',
  'SET',
  'JOIN',
  'INNER',
  'LEFT',
  'RIGHT',
  'FULL',
  'CROSS',
  'NATURAL',
  'OUTER',
  'STRAIGHT_JOIN',
  'WINDOW',
  'QUALIFY',
  'PREWHERE',
  'SETTINGS',
  'FORMAT',
  'RETURNING',
  'FOR',
  'VALUES',
  'SELECT',
  'FINAL',
  'SAMPLE',
  'ARRAY',
  'GLOBAL',
  'ANY',
  'ALL',
  'ASOF',
  'SEMI',
  'ANTI',
  'PARTITION',
  'USE',
  'FORCE',
  'IGNORE',
  'LATERAL',
  'TABLESAMPLE',
  'DEFAULT',
  'WITH',
  'LOCK',
  'INTO',
  'FETCH',
  'AS',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'AND',
  'OR',
  'NOT',
  'BY',
  'FROM',
  'DO',
  'CONFLICT',
  'DUPLICATE',
  'KEY',
  'UPDATE',
  'DELETE',
  'INSERT',
  'MERGE',
  'MATCHED',
  'PREWHERE',
  'INDEXED',
  'NOWAIT',
  'SKIP',
  'OF',
  'TO',
  'CASCADE',
  'RESTRICT',
  'IF',
  'EXISTS'
])

// Words that end the FROM-list mode of a scope (JOIN re-enters it).
const FROM_END = new Set([
  'WHERE',
  'GROUP',
  'ORDER',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'UNION',
  'INTERSECT',
  'EXCEPT',
  'MINUS',
  'ON',
  'SET',
  'WINDOW',
  'QUALIFY',
  'PREWHERE',
  'SETTINGS',
  'FORMAT',
  'RETURNING',
  'FOR',
  'VALUES',
  'SELECT',
  'FETCH',
  'USING'
])

// After these (at the cursor's depth) a column / expression is wanted.
const COLUMN_KEYWORDS = new Set([
  'SELECT',
  'WHERE',
  'ON',
  'BY',
  'HAVING',
  'SET',
  'AND',
  'OR',
  'NOT',
  'WHEN',
  'THEN',
  'ELSE',
  'CASE',
  'DISTINCT',
  'RETURNING',
  'PREWHERE',
  'QUALIFY',
  'IN',
  'BETWEEN',
  'LIKE',
  'ILIKE',
  'IS',
  'AS',
  'LIMIT',
  'OFFSET',
  'VALUES',
  'END',
  'ALL',
  'ANY',
  'SOME',
  'EXISTS',
  'OVER',
  'PARTITION',
  'XOR',
  'DIV',
  'MOD',
  'REGEXP',
  'RLIKE',
  'INTERVAL',
  'UPDATE',
  'DO'
])

const JOIN_WORDS = new Set(['JOIN', 'STRAIGHT_JOIN'])

interface Group {
  open: number
  close: number
}

/** Paren groups around token index `at` (an insertion point between tokens), innermost first. */
function enclosingGroups(tokens: CompletionToken[], at: number): Group[] {
  const stack: number[] = []
  for (let i = 0; i < at; i++) {
    if (isPunct(tokens[i], '(')) stack.push(i)
    else if (isPunct(tokens[i], ')')) stack.pop()
  }
  return stack.reverse().map((open) => ({ open, close: matchParen(tokens, open) }))
}

const isQueryStart = (t: CompletionToken | undefined): boolean =>
  !!t && (t.upper === 'SELECT' || t.upper === 'WITH' || t.upper === 'VALUES' || t.upper === 'TABLE')

/** Reads `a[.b[.c]]` starting at i; returns the path and the index after it. */
function readPath(
  tokens: CompletionToken[],
  i: number,
  hi: number
): { path: string[]; next: number } | null {
  if (!isNameToken(tokens[i])) return null
  const path = [nameOf(tokens[i])]
  let j = i + 1
  while (j + 1 < hi && isPunct(tokens[j], '.') && isNameToken(tokens[j + 1])) {
    path.push(nameOf(tokens[j + 1]))
    j += 2
  }
  return { path, next: j }
}

/** Optional `[AS] alias` at i (same depth). */
function readAlias(
  tokens: CompletionToken[],
  i: number,
  hi: number,
  depth: number
): { alias: string | null; columns: string[] | null; next: number } {
  let j = i
  let explicit = false
  if (j < hi && tokens[j].depth === depth && tokens[j].upper === 'AS') {
    explicit = true
    j++
  }
  const t = tokens[j]
  if (
    j < hi &&
    t.depth === depth &&
    (t.type === 'identifier' ||
      t.type === 'quoted_identifier' ||
      (t.type === 'keyword' && (explicit || !ALIAS_STOP.has(t.upper))))
  ) {
    let next = j + 1
    let columns: string[] | null = null
    // `AS s(a, b)`: column aliases of a derived table.
    if (next < hi && isPunct(tokens[next], '(')) {
      const close = matchParen(tokens, next)
      columns = []
      for (let k = next + 1; k < close; k++) {
        if (tokens[k].depth === depth + 1 && isNameToken(tokens[k])) columns.push(nameOf(tokens[k]))
      }
      next = Math.min(close + 1, hi)
    }
    return { alias: nameOf(t), columns, next }
  }
  return { alias: null, columns: null, next: explicit ? j : i }
}

/** The names a SELECT list (inside group `open`) produces. */
function selectListColumns(
  tokens: CompletionToken[],
  lo: number,
  hi: number,
  depth: number,
  level: number
): DerivedColumns {
  const out: DerivedColumns = { names: [], star: [] }
  let i = lo
  // Skip CTE bodies: the main SELECT is the first one at this depth.
  while (i < hi && !(tokens[i].depth === depth && tokens[i].upper === 'SELECT')) i++
  if (i >= hi) return out
  i++
  while (
    i < hi &&
    tokens[i].depth === depth &&
    (tokens[i].upper === 'DISTINCT' ||
      tokens[i].upper === 'ALL' ||
      tokens[i].upper === 'DISTINCTROW')
  ) {
    i++
    // PG DISTINCT ON (expr)
    if (i < hi && tokens[i].upper === 'ON' && isPunct(tokens[i + 1], '(')) {
      i = matchParen(tokens, i + 1) + 1
    }
  }
  if (i < hi && tokens[i].upper === 'TOP') i += 2
  const items: CompletionToken[][] = []
  let current: CompletionToken[] = []
  for (; i < hi; i++) {
    const t = tokens[i]
    if (t.depth === depth && (t.upper === 'FROM' || t.upper === 'INTO' || FROM_END.has(t.upper)))
      break
    if (t.depth === depth && isPunct(t, ',')) {
      items.push(current)
      current = []
      continue
    }
    current.push(t)
  }
  if (current.length) items.push(current)

  let innerRefs: ScopeRef[] | null = null
  const refsOfThisSelect = (): ScopeRef[] =>
    (innerRefs ??= collectRefs(tokens, lo, hi, depth, level + 1))

  for (const item of items) {
    const top = item.filter((t) => t.depth === depth)
    const last = top[top.length - 1]
    if (!last) continue
    if (top.length === 1 && last.type === 'operator' && last.text === '*') {
      out.star.push(...refsOfThisSelect())
      continue
    }
    if (
      last.text === '*' &&
      isPunct(top[top.length - 2], '.') &&
      isNameToken(top[top.length - 3])
    ) {
      const owner = nameOf(top[top.length - 3]).toLowerCase()
      const ref = refsOfThisSelect().find(
        (r) => (r.alias ?? r.path[r.path.length - 1]).toLowerCase() === owner
      )
      if (ref) out.star.push(ref)
      continue
    }
    if (!isNameToken(last)) continue
    const beforeLast = top[top.length - 2]
    if (!beforeLast) {
      out.names.push(nameOf(last))
    } else if (beforeLast.upper === 'AS' || isPunct(beforeLast, '.')) {
      out.names.push(nameOf(last))
    } else if (
      beforeLast.type !== 'operator' &&
      !(beforeLast.type === 'punctuation' && beforeLast.text !== ')') &&
      !(beforeLast.type === 'keyword' && !isPunct(beforeLast, ')'))
    ) {
      // `expr alias` (implicit alias): `count(*) n`, `price * 2 doubled`
      out.names.push(nameOf(last))
    } else if (isPunct(beforeLast, ')')) {
      out.names.push(nameOf(last))
    }
  }
  return out
}

/**
 * Table references of one query level: tokens in [lo, hi) at exactly `depth`.
 * `level` is stored on each ref (0 = innermost).
 */
function collectRefs(
  tokens: CompletionToken[],
  lo: number,
  hi: number,
  depth: number,
  level: number
): ScopeRef[] {
  const refs: ScopeRef[] = []
  let inFrom = false
  let expectRef = false
  const head = tokens.slice(lo, hi).find((t) => t.depth === depth)?.upper ?? ''
  for (let i = lo; i < hi; i++) {
    const t = tokens[i]
    if (t.depth !== depth) continue
    const u = t.upper
    const prev = i > lo ? tokens[i - 1] : undefined
    const startsRefs =
      u === 'FROM' ||
      JOIN_WORDS.has(u) ||
      (u === 'UPDATE' && prev?.upper !== 'KEY' && prev?.upper !== 'FOR' && prev?.upper !== 'DO') ||
      (u === 'INTO' && head !== 'SELECT') ||
      (u === 'TABLE' && head !== 'CREATE') ||
      (u === 'USING' && head === 'DELETE' && !isPunct(tokens[i + 1], '('))
    if (startsRefs) {
      inFrom = true
      expectRef = true
      continue
    }
    if (inFrom && isPunct(t, ',')) {
      expectRef = true
      continue
    }
    if (FROM_END.has(u)) {
      inFrom = false
      expectRef = false
      continue
    }
    if (!expectRef) continue
    if (TABLE_FUNCTION_OR_SUBQUERY_SKIP.has(u)) continue
    expectRef = false
    if (isPunct(t, '(')) {
      const close = matchParen(tokens, i)
      const inner = tokens[i + 1]
      const derived = isQueryStart(inner)
        ? selectListColumns(tokens, i + 1, close, depth + 1, level)
        : { names: [], star: [] }
      const alias = readAlias(tokens, Math.min(close + 1, hi), hi, depth)
      if (alias.columns) derived.names = alias.columns
      if (isQueryStart(inner) || alias.alias) {
        refs.push({ path: [], alias: alias.alias, derived, level, at: t.start })
      }
      i = alias.next - 1
      continue
    }
    const path = readPath(tokens, i, hi)
    if (!path) continue
    let next = path.next
    let derived: DerivedColumns | undefined
    if (next < hi && isPunct(tokens[next], '(')) {
      // Table function: generate_series(...), numbers(...), s3(...)
      next = Math.min(matchParen(tokens, next) + 1, hi)
      derived = { names: [], star: [] }
    }
    const alias = readAlias(tokens, next, hi, depth)
    if (alias.columns && derived) derived.names = alias.columns
    refs.push({
      path: path.path,
      alias: alias.alias,
      ...(derived ? { derived } : {}),
      level,
      at: t.start
    })
    i = alias.next - 1
  }
  return refs
}

/** CTEs declared by a `WITH` at the start of [lo, hi). */
function collectCtes(
  tokens: CompletionToken[],
  lo: number,
  hi: number,
  depth: number,
  level: number
): CteDefinition[] {
  const out: CteDefinition[] = []
  let i = lo
  if (tokens[i]?.upper !== 'WITH') return out
  i++
  if (tokens[i]?.upper === 'RECURSIVE') i++
  while (i < hi) {
    if (!isNameToken(tokens[i]) || tokens[i].depth !== depth) break
    const name = nameOf(tokens[i])
    i++
    let explicitColumns: string[] | null = null
    if (isPunct(tokens[i], '(')) {
      const close = matchParen(tokens, i)
      explicitColumns = []
      for (let k = i + 1; k < close; k++) {
        if (tokens[k].depth === depth + 1 && isNameToken(tokens[k]))
          explicitColumns.push(nameOf(tokens[k]))
      }
      i = close + 1
    }
    if (tokens[i]?.upper !== 'AS') break
    i++
    while (tokens[i]?.upper === 'NOT' || tokens[i]?.upper === 'MATERIALIZED') i++
    if (!isPunct(tokens[i], '(')) break
    const close = matchParen(tokens, i)
    const columns = explicitColumns
      ? { names: explicitColumns, star: [] }
      : selectListColumns(tokens, i + 1, close, depth + 1, level)
    out.push({ name, columns })
    i = close + 1
    if (!isPunct(tokens[i], ',')) break
    i++
  }
  return out
}

/** `INSERT INTO t (` → ['t'] when the `(` at `open` is an INSERT column list. */
function insertTargetBefore(tokens: CompletionToken[], open: number): string[] | null {
  let j = open - 1
  const path: string[] = []
  while (j >= 0 && isNameToken(tokens[j])) {
    path.unshift(nameOf(tokens[j]))
    if (isPunct(tokens[j - 1], '.')) j -= 2
    else {
      j--
      break
    }
  }
  if (!path.length) return null
  return tokens[j]?.upper === 'INTO' ? path : null
}

function wantAt(tokens: CompletionToken[], k: number, groups: Group[]): CompletionWant {
  const prev = tokens[k - 1]
  if (isPunct(prev, '.')) {
    const path: string[] = []
    let j = k - 1
    while (isPunct(tokens[j], '.') && isNameToken(tokens[j - 1])) {
      path.unshift(nameOf(tokens[j - 1]))
      j -= 2
    }
    return path.length ? { kind: 'qualified', path } : { kind: 'none' }
  }
  if (k === 0) return { kind: 'none' }
  const depth = groups.length ? tokens[groups[0].open].depth + 1 : 0
  const head = tokens.find((t) => t.depth === 0)?.upper ?? ''
  for (let j = k - 1; j >= 0; j--) {
    const t = tokens[j]
    if (t.depth > depth) continue
    if (t.depth < depth) {
      if (isPunct(t, '(')) {
        const target = insertTargetBefore(tokens, j)
        if (target) return { kind: 'insertColumns', table: target }
      }
      return { kind: 'column' }
    }
    if (!isWordToken(t)) continue
    const u = t.upper
    const tableKeyword =
      u === 'FROM' ||
      JOIN_WORDS.has(u) ||
      u === 'TRUNCATE' ||
      (u === 'UPDATE' &&
        tokens[j - 1]?.upper !== 'KEY' &&
        tokens[j - 1]?.upper !== 'FOR' &&
        tokens[j - 1]?.upper !== 'DO') ||
      (u === 'INTO' && head !== 'SELECT') ||
      (u === 'TABLE' && head !== 'CREATE') ||
      (u === 'TABLES' && head === 'LOCK') ||
      ((u === 'DESCRIBE' || u === 'DESC' || u === 'EXPLAIN') &&
        j === 0 &&
        !isQueryStart(tokens[1])) ||
      (u === 'USING' && head === 'DELETE')
    if (tableKeyword) {
      if (j === k - 1) return { kind: 'table' }
      if (
        isPunct(prev, ',') &&
        (u === 'FROM' || JOIN_WORDS.has(u) || u === 'USING' || u === 'UPDATE')
      )
        return { kind: 'table' }
      // `FROM users |` (alias position) or after a table name: keywords only.
      return { kind: 'none' }
    }
    if (COLUMN_KEYWORDS.has(u)) {
      // `UPDATE t SET` handled above; `ON DUPLICATE KEY UPDATE |` → columns.
      return { kind: 'column' }
    }
  }
  return { kind: 'column' }
}

/**
 * Analyses `text` (one statement) for a completion at `offset` (both relative to the statement).
 * Returns null inside strings and comments.
 */
export function analyzeSqlCompletion(
  text: string,
  offset: number,
  dialect: SqlDialect
): SqlCompletionAnalysis | null {
  const cur = Math.max(0, Math.min(offset, text.length))
  const lexed = lexSql(text, dialect)
  const unterminated = (t: SqlToken): boolean =>
    !!lexed.error && lexed.error.offset >= t.start && lexed.error.offset < t.end
  let wordFrom = cur
  // Where the token holding the word starts (the opening quote for quoted identifiers).
  let wordTokenStart = cur
  let quote: string | null = null
  let masked = text
  for (const t of lexed.tokens) {
    if (t.end < cur) continue
    if (t.start >= cur) break
    // t.start < cur <= t.end: the token touching the cursor from the left.
    if (t.type === 'string' || t.type === 'comment') {
      // Right after a closed string or block comment the cursor is outside it; a line comment
      // runs to the end of its line, so the cursor at its end is still inside.
      const closedBlock = t.type === 'comment' && t.text.startsWith('/*') && !unterminated(t)
      const closedString = t.type === 'string' && !unterminated(t)
      if (t.end === cur && (closedBlock || closedString)) break
      return null
    }
    if (
      t.type === 'identifier' ||
      t.type === 'keyword' ||
      t.type === 'parameter' ||
      t.type === 'variable'
    ) {
      wordFrom = t.start
      wordTokenStart = t.start
    } else if (t.type === 'quoted_identifier') {
      const unicode = /^u&/i.test(t.text)
      const open = unicode ? t.text[2] : t.text[0]
      const openLen = unicode ? 3 : 1
      if (t.end === cur && !unterminated(t)) break // right after a complete `"Users"`
      quote = open
      wordFrom = t.start + openLen
      wordTokenStart = t.start
      // An unterminated quote would swallow the rest of the statement: mask it as a bare word
      // of the same length so every offset stays valid.
      if (unterminated(t))
        masked = text.slice(0, t.start) + 'x'.repeat(cur - t.start) + text.slice(cur)
    }
    break
  }
  const tokens = codeTokens(masked, dialect)
  let k = 0
  while (k < tokens.length && tokens[k].end <= wordTokenStart) k++
  const groups = enclosingGroups(tokens, k)
  const want = wantAt(tokens, k, groups)

  // Query levels around the cursor: enclosing groups that hold a query, then the root.
  const levels: Array<{ lo: number; hi: number; depth: number }> = []
  for (const g of groups) {
    if (isQueryStart(tokens[g.open + 1])) {
      levels.push({ lo: g.open + 1, hi: g.close, depth: tokens[g.open].depth + 1 })
    }
  }
  levels.push({ lo: 0, hi: tokens.length, depth: 0 })

  // The half-typed name is not a table reference yet (`FROM us|`, `FROM analytics.|`): skip the
  // ref that starts where the word (or the qualified path in front of it) starts.
  let typedStart = wordFrom < cur || quote !== null ? wordTokenStart : -1
  if (want.kind === 'qualified') {
    let j = k - 1
    while (isPunct(tokens[j], '.') && isNameToken(tokens[j - 1])) j -= 2
    typedStart = tokens[j + 1]?.start ?? typedStart
  }
  const scope: ScopeRef[] = []
  const ctes: CteDefinition[] = []
  levels.forEach((lvl, level) => {
    ctes.push(...collectCtes(tokens, lvl.lo, lvl.hi, lvl.depth, level))
    scope.push(
      ...collectRefs(tokens, lvl.lo, lvl.hi, lvl.depth, level).filter((r) => r.at !== typedStart)
    )
  })
  return { want, scope, ctes, wordFrom, word: text.slice(wordFrom, cur), quote }
}

// ---------------------------------------------------------------------------------------------
// Schema index
// ---------------------------------------------------------------------------------------------

export interface SqlCompletionIndex {
  dialect: SqlDialect
  schema: DataCompletionSchema
  /** lower(name) → tables of that name (several schemas may share one). */
  byName: Map<string, DataCompletionTable[]>
  /** lower(schema) → lower(name) → table. */
  bySchema: Map<string, Map<string, DataCompletionTable>>
  defaultSchema: string | null
  tableOptions: Completion[]
  namespaceOptions: Completion[]
  functionOptions: Completion[]
}

const lower = (s: string): string => s.toLowerCase()

const RESERVED_FOR_QUOTING = new Set([
  'select',
  'from',
  'where',
  'order',
  'group',
  'by',
  'user',
  'table',
  'index',
  'key',
  'limit',
  'offset',
  'join',
  'left',
  'right',
  'inner',
  'outer',
  'on',
  'as',
  'and',
  'or',
  'not',
  'null',
  'default',
  'check',
  'column',
  'constraint',
  'create',
  'drop',
  'alter',
  'insert',
  'update',
  'delete',
  'into',
  'values',
  'set',
  'case',
  'when',
  'then',
  'else',
  'end',
  'having',
  'union',
  'all',
  'distinct',
  'primary',
  'foreign',
  'references',
  'grant',
  'to',
  'with',
  'desc',
  'asc',
  'in',
  'is',
  'like',
  'between',
  'exists',
  'unique',
  'range',
  'rows',
  'window',
  'partition',
  'interval',
  'match',
  'natural',
  'cross',
  'full',
  'using',
  'current_user',
  'current_date',
  'true',
  'false',
  'returning',
  'lock',
  'option',
  'schema',
  'database',
  'trigger',
  'view'
])

/** The identifier as it must be typed: bare when safe, quoted for the dialect otherwise. */
export function identifierText(name: string, dialect: SqlDialect): string {
  const bare = /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)
  const caseSafe = dialect !== 'postgres' || name === name.toLowerCase()
  if (bare && caseSafe && !RESERVED_FOR_QUOTING.has(lower(name))) return name
  return quoteSqlIdentifier(name, dialect)
}

const KIND_TYPE: Partial<Record<DataObjectKind, string>> = {
  table: 'class',
  view: 'interface',
  materialized_view: 'interface',
  foreign_table: 'class',
  dictionary: 'enum',
  collection: 'class'
}
const KIND_LABEL: Partial<Record<DataObjectKind, string>> = {
  table: 'table',
  view: 'view',
  materialized_view: 'mat. view',
  foreign_table: 'foreign table',
  dictionary: 'dictionary'
}

// CodeMirror lists options without a section above every sectioned group, so keywords and
// functions get sections ranked after the per-table column groups: `u.co` must offer `country`
// before COPY/CORR, and Tab must accept the column.
const FUNCTION_SECTION = { name: 'Functions', rank: 900 }
const KEYWORD_SECTION = { name: 'Keywords', rank: 1000 }

function functionCompletion(name: string, boost: number, detail?: string): Completion {
  return {
    label: name,
    type: 'function',
    section: FUNCTION_SECTION,
    boost,
    detail,
    apply: (view: EditorView, completion: Completion, from: number, to: number) => {
      const next = view.state.sliceDoc(to, to + 1)
      const insert = next === '(' ? name : `${name}()`
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + name.length + 1 },
        userEvent: 'input.complete',
        annotations: pickedCompletion.of(completion)
      })
    }
  }
}

/** Builds lookup maps and prebuilt options for one schema snapshot. */
export function buildSqlCompletionIndex(
  schema: DataCompletionSchema,
  dialect: SqlDialect
): SqlCompletionIndex {
  const byName = new Map<string, DataCompletionTable[]>()
  const bySchema = new Map<string, Map<string, DataCompletionTable>>()
  const defaultSchema =
    schema.defaultSchema ?? (dialect === 'postgres' ? 'public' : (schema.database ?? null))
  for (const table of schema.tables) {
    const key = lower(table.name)
    const list = byName.get(key)
    if (list) list.push(table)
    else byName.set(key, [table])
    const owner = lower(table.schema ?? schema.database ?? '')
    let inner = bySchema.get(owner)
    if (!inner) bySchema.set(owner, (inner = new Map()))
    inner.set(key, table)
  }
  const isDefault = (t: DataCompletionTable): boolean =>
    !t.schema || !defaultSchema || lower(t.schema) === lower(defaultSchema)

  const tableOptions: Completion[] = schema.tables.map((t) => {
    const qualified = !isDefault(t) && t.schema
    const label = qualified ? `${t.schema}.${t.name}` : t.name
    return {
      label,
      type: KIND_TYPE[t.kind] ?? 'class',
      detail: `${KIND_LABEL[t.kind] ?? t.kind}${t.columns.length ? ` · ${t.columns.length} cols` : ''}`,
      boost: qualified ? 0 : 2,
      apply: qualified
        ? `${identifierText(t.schema as string, dialect)}.${identifierText(t.name, dialect)}`
        : identifierText(t.name, dialect)
    }
  })
  const namespaceOptions: Completion[] = []
  const seen = new Set<string>()
  for (const s of schema.schemas ?? []) {
    if (seen.has(`s:${s}`)) continue
    seen.add(`s:${s}`)
    namespaceOptions.push({
      label: s,
      type: 'namespace',
      detail: 'schema',
      boost: -1,
      apply: identifierText(s, dialect)
    })
  }
  for (const d of schema.databases) {
    if (seen.has(`s:${d}`) || seen.has(`d:${d}`)) continue
    seen.add(`d:${d}`)
    namespaceOptions.push({
      label: d,
      type: 'namespace',
      detail: 'database',
      boost: -2,
      apply: identifierText(d, dialect)
    })
  }
  const fnNames = new Map<string, string>()
  for (const f of schema.functions ?? []) fnNames.set(lower(f), f)
  for (const f of SQL_FUNCTIONS[dialect]) if (!fnNames.has(lower(f))) fnNames.set(lower(f), f)
  const userFunctions = new Set((schema.functions ?? []).map(lower))
  const functionOptions = [...fnNames.values()].map((f) =>
    functionCompletion(
      f,
      userFunctions.has(lower(f)) ? 0 : -1,
      userFunctions.has(lower(f)) ? 'function' : undefined
    )
  )
  return {
    dialect,
    schema,
    byName,
    bySchema,
    defaultSchema,
    tableOptions,
    namespaceOptions,
    functionOptions
  }
}

/** Resolves a written table path against the snapshot. */
export function resolveTable(
  index: SqlCompletionIndex,
  path: string[]
): DataCompletionTable | null {
  if (!path.length) return null
  const name = lower(path[path.length - 1])
  if (path.length === 1) {
    const list = index.byName.get(name)
    if (!list?.length) return null
    const def = index.defaultSchema ? lower(index.defaultSchema) : null
    return list.find((t) => !t.schema || (def !== null && lower(t.schema) === def)) ?? list[0]
  }
  const owner = lower(path[path.length - 2])
  const inSchema = index.bySchema.get(owner)?.get(name)
  if (inSchema) return inSchema
  // MySQL/ClickHouse `db.table` of the current database (tables carry no schema there).
  if (index.schema.database && lower(index.schema.database) === owner) {
    return index.byName.get(name)?.[0] ?? null
  }
  return null
}

interface ResolvedColumn {
  name: string
  type: string
}

function columnsOfRef(
  ref: ScopeRef,
  index: SqlCompletionIndex,
  ctes: CteDefinition[],
  guard = 0
): ResolvedColumn[] {
  if (guard > 6) return []
  const fromDerived = (d: DerivedColumns): ResolvedColumn[] => {
    const cols: ResolvedColumn[] = d.names.map((name) => ({ name, type: 'derived' }))
    for (const inner of d.star) cols.push(...columnsOfRef(inner, index, ctes, guard + 1))
    return cols
  }
  if (ref.derived) return fromDerived(ref.derived)
  if (ref.path.length === 1) {
    const cte = ctes.find((c) => lower(c.name) === lower(ref.path[0]))
    if (cte) return fromDerived(cte.columns)
  }
  const table = resolveTable(index, ref.path)
  return table ? table.columns.map((c) => ({ name: c.name, type: c.type })) : []
}

const refLabel = (ref: ScopeRef): string => ref.alias ?? ref.path[ref.path.length - 1] ?? 'subquery'

function columnOptions(
  ref: ScopeRef,
  columns: ResolvedColumn[],
  dialect: SqlDialect,
  options: { qualifyAmbiguous?: Set<string>; boost: number; rank: number }
): Completion[] {
  const owner = refLabel(ref)
  const tableName = ref.path[ref.path.length - 1]
  const sectionName =
    ref.alias && tableName && lower(ref.alias) !== lower(tableName)
      ? `${tableName} (${ref.alias})`
      : owner
  const section = { name: sectionName, rank: options.rank }
  return columns.map((c) => {
    const ident = identifierText(c.name, dialect)
    const qualify = options.qualifyAmbiguous?.has(lower(c.name))
    return {
      label: c.name,
      type: 'property',
      detail: c.type,
      section,
      boost: options.boost,
      apply: qualify ? `${identifierText(owner, dialect)}.${ident}` : ident
    }
  })
}

/** Completion options for an analysis (no keywords: see sqlKeywordCompletionSource). */
export function sqlSchemaCompletions(
  analysis: SqlCompletionAnalysis,
  index: SqlCompletionIndex
): Completion[] {
  const { want, scope, ctes } = analysis
  const dialect = index.dialect
  switch (want.kind) {
    case 'none':
      return []
    case 'qualified': {
      const path = want.path
      const head = lower(path[0])
      if (path.length === 1) {
        const ref =
          scope.find((r) => r.alias !== null && lower(r.alias) === head) ??
          scope.find(
            (r) => r.alias === null && r.path.length && lower(r.path[r.path.length - 1]) === head
          )
        if (ref)
          return columnOptions(ref, columnsOfRef(ref, index, ctes), dialect, { boost: 3, rank: 0 })
        const cte = ctes.find((c) => lower(c.name) === head)
        if (cte) {
          const ref2: ScopeRef = { path: [cte.name], alias: null, level: 0 }
          return columnOptions(ref2, columnsOfRef(ref2, index, ctes), dialect, {
            boost: 3,
            rank: 0
          })
        }
      }
      // schema.<table> (PG / SQLite attached db), database.<table> (current database)
      const namespaceTables = (owner: string): Completion[] => {
        const inner = index.bySchema.get(owner)
        const tables = inner
          ? [...inner.values()]
          : index.schema.database && lower(index.schema.database) === owner
            ? index.schema.tables
            : []
        return tables.map((t) => ({
          label: t.name,
          type: KIND_TYPE[t.kind] ?? 'class',
          detail: KIND_LABEL[t.kind] ?? t.kind,
          boost: 2,
          apply: identifierText(t.name, dialect)
        }))
      }
      const asNamespace = namespaceTables(lower(path[path.length - 1]))
      if (asNamespace.length) return asNamespace
      // table.<column> (with or without a schema/database qualifier)
      const table = resolveTable(index, path)
      if (table) {
        const ref: ScopeRef = { path, alias: null, level: 0 }
        return columnOptions(
          ref,
          table.columns.map((c) => ({ name: c.name, type: c.type })),
          dialect,
          { boost: 2, rank: 0 }
        )
      }
      return []
    }
    case 'table': {
      const cteOptions: Completion[] = ctes.map((c) => ({
        label: c.name,
        type: 'variable',
        detail: 'CTE',
        boost: 4,
        apply: identifierText(c.name, dialect)
      }))
      return [...cteOptions, ...index.tableOptions, ...index.namespaceOptions]
    }
    case 'insertColumns': {
      const table = resolveTable(index, want.table)
      if (!table) return []
      const ref: ScopeRef = { path: want.table, alias: null, level: 0 }
      const cols = columnOptions(
        ref,
        table.columns.map((c) => ({ name: c.name, type: c.type })),
        dialect,
        { boost: 3, rank: 0 }
      )
      if (table.columns.length > 1) {
        cols.unshift({
          label: table.columns.map((c) => c.name).join(', '),
          type: 'text',
          detail: 'all columns',
          boost: 4,
          apply: table.columns.map((c) => identifierText(c.name, dialect)).join(', ')
        })
      }
      return cols
    }
    case 'column': {
      const options: Completion[] = []
      // Columns present in more than one table of the innermost level get qualified on apply.
      const counts = new Map<string, number>()
      const perRef = scope.map((ref) => {
        const cols = columnsOfRef(ref, index, ctes)
        if (ref.level === 0) {
          for (const c of new Set(cols.map((col) => lower(col.name)))) {
            counts.set(c, (counts.get(c) ?? 0) + 1)
          }
        }
        return cols
      })
      const ambiguous = new Set([...counts].filter(([, n]) => n > 1).map(([name]) => name))
      scope.forEach((ref, i) => {
        options.push(
          ...columnOptions(ref, perRef[i], dialect, {
            qualifyAmbiguous: ref.level === 0 && scope.length > 1 ? ambiguous : undefined,
            boost: ref.level === 0 ? 3 : 1,
            rank: i
          })
        )
      })
      for (const ref of scope) {
        if (ref.alias) {
          options.push({
            label: ref.alias,
            type: 'variable',
            detail: ref.path.length ? ref.path.join('.') : 'subquery',
            boost: 2
          })
        }
      }
      options.push(...index.functionOptions)
      return options
    }
  }
}

// ---------------------------------------------------------------------------------------------
// CodeMirror sources
// ---------------------------------------------------------------------------------------------

const VALID_FOR = /^[\w$]*$/

function insideStringOrComment(context: CompletionContext): boolean {
  const node = syntaxTree(context.state).resolveInner(context.pos, -1)
  return /String|Comment/.test(node.name) && node.name !== 'QuotedIdentifier'
}

/** Schema-aware SQL completion (tables, columns, aliases, CTEs, functions). */
export const sqlSchemaCompletionSource: CompletionSource = (
  context: CompletionContext
): CompletionResult | null => {
  const config = context.state.facet(dataEditorConfig)
  if (config.language !== 'sql' || !config.dialect) return null
  if (insideStringOrComment(context)) return null
  const doc = context.state.doc
  if (doc.length > 2_000_000) return null
  const text = doc.toString()
  const { from, to } = completionStatement(text, context.pos, config.dialect)
  const statement = text.slice(from, to)
  const analysis = analyzeSqlCompletion(statement, context.pos - from, config.dialect)
  if (!analysis) return null
  const wordEmpty = analysis.word.length === 0
  if (analysis.want.kind === 'none') return null
  if (wordEmpty && !context.explicit && analysis.want.kind === 'column') return null
  const index = config.completionIndex
  const functionsOnly = !index
  const options = index
    ? sqlSchemaCompletions(analysis, index)
    : analysis.want.kind === 'column'
      ? SQL_FUNCTIONS[config.dialect].map((f) => functionCompletion(f, -1))
      : []
  if (functionsOnly && !options.length) return null
  if (!options.length) return null
  const quoted = analysis.quote
  return {
    from: from + analysis.wordFrom,
    options: quoted ? options.map((o) => quoteOption(o, quoted)) : options,
    validFor: VALID_FOR
  }
}

/** When the user typed an opening quote, insert the bare name and close the quote. */
function quoteOption(option: Completion, quote: string): Completion {
  if (option.type === 'function') return option
  const close = quote === '[' ? ']' : quote
  const name = option.label
  return {
    ...option,
    apply: (view: EditorView, completion: Completion, from: number, to: number) => {
      const escaped = close === ']' ? name : name.split(close).join(close + close)
      const hasClose = view.state.sliceDoc(to, to + 1) === close
      const insert = hasClose ? escaped : `${escaped}${close}`
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + escaped.length + 1 },
        userEvent: 'input.complete',
        annotations: pickedCompletion.of(completion)
      })
    }
  }
}

const keywordSources = new Map<string, CompletionSource>()

// Everyday keywords outrank the long SQL-standard tail (`sel` → SELECT before SELF).
const COMMON_KEYWORDS = new Set(
  (
    'SELECT FROM WHERE AND OR NOT NULL IS IN AS ON JOIN LEFT RIGHT INNER OUTER FULL CROSS ' +
    'GROUP ORDER BY HAVING LIMIT OFFSET DISTINCT UNION ALL INSERT INTO VALUES UPDATE SET ' +
    'DELETE CREATE TABLE VIEW INDEX ALTER DROP TRUNCATE ADD COLUMN PRIMARY KEY FOREIGN ' +
    'REFERENCES DEFAULT WITH CASE WHEN THEN ELSE END LIKE ILIKE BETWEEN EXISTS ASC DESC ' +
    'RETURNING SHOW DESCRIBE EXPLAIN ANALYZE BEGIN COMMIT ROLLBACK USING TRUE FALSE COUNT ' +
    'DATABASE SCHEMA FINAL FORMAT SETTINGS PREWHERE'
  ).split(' ')
)

/** True when the word at the cursor follows a `.` (`u.co`, `"public".us`): members only. */
function afterMemberDot(context: CompletionContext): boolean {
  const before = context.state.sliceDoc(Math.max(0, context.pos - 256), context.pos)
  return /\.\s*["`[]?[\w$]*$/.test(before)
}

/** lang-sql keyword completion for the active dialect, in the configured case. */
export const sqlKeywordCompletionSource: CompletionSource = (context) => {
  const config = context.state.facet(dataEditorConfig)
  if (config.language !== 'sql' || !config.dialect) return null
  if (afterMemberDot(context)) return null
  const upper = config.keywordCase !== 'lower'
  const key = `${config.dialect}:${upper}`
  let source = keywordSources.get(key)
  if (!source) {
    source = keywordCompletionSource(cmSqlDialect(config.dialect), upper, (label, type) => ({
      label,
      type,
      section: KEYWORD_SECTION,
      boost: type !== 'keyword' ? -4 : COMMON_KEYWORDS.has(label.toUpperCase()) ? 1 : -1
    }))
    keywordSources.set(key, source)
  }
  return source(context)
}

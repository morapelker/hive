// Shared SQL lexer: one hand-written, dialect-aware tokenizer used by the editor (statement under
// the cursor, parameter detection), the statement splitter, the safety classifier and the
// auto-limit rewrite, in both the renderer and the server. It is pure TS with no dependencies.
//
// Guarantees callers rely on:
// - Tokens cover the input contiguously (whitespace and comments included), so every
//   `token.start/end` maps exactly back to the source and `tokens.map(t => t.text).join('')`
//   is the input.
// - It never throws. An unterminated string, quoted identifier, comment, dollar quote or
//   executable comment extends to the end of the input and is reported once in `error` (with the
//   offset of its opening character); the safety classifier turns any error into 'unknown',
//   because a statement we could not lex must never be guessed to be a read.
//
// Dialect differences that matter for safety (research/safety.md §A3):
// - MySQL/MariaDB: `-- ` needs whitespace (or a control char / end of input) after the dashes
//   (`1--1` is arithmetic), `#` starts a comment, strings take backslash escapes unless the
//   session runs with NO_BACKSLASH_ESCAPES (`options.backslashEscapes`), `"…"` is a string, and
//   executable comments `/*! … */`, `/*!50700 … */`, MariaDB `/*M! … */` are RUN by the server:
//   the opener and the closing `*/` are `executable_comment` tokens and everything between is
//   lexed as ordinary code, so the classifier sees a `DROP` hidden in there.
// - PostgreSQL: nested `/* */`, `E'…'` backslash strings, `U&'…'`, `$tag$…$tag$` dollar quoting
//   (while `$1` is a parameter and `a$b$` an identifier), `?` is a jsonb operator.
// - SQLite: `[bracket]` and backtick identifiers, `? ?NNN :name @name $name` parameters.
// - ClickHouse: `#`/`#!` comments, backslash escapes in strings and quoted identifiers, nested
//   comments, `$heredoc$` strings and `{name:Type}` query parameters.
// - The MySQL client's `DELIMITER xx` command (recognised only at the start of a statement, as
//   the mysql CLI does) becomes ONE `delimiter` token with `upper: 'DELIMITER'` covering the
//   rest of its line; afterwards every occurrence of the active delimiter outside strings and
//   comments is a `delimiter` token (`END$$` lexes as `END` + `$$`) and `;` is plain punctuation.

import type { SqlDialect } from '../data-projects/types'

export type SqlTokenType =
  | 'keyword'
  | 'identifier'
  | 'quoted_identifier'
  | 'string'
  | 'number'
  | 'operator'
  | 'punctuation'
  | 'comment'
  | 'whitespace'
  | 'parameter'
  | 'variable'
  | 'executable_comment'
  | 'delimiter'
  | 'unknown'

export interface SqlToken {
  type: SqlTokenType
  text: string
  start: number
  end: number
  /**
   * Upper-cased text of bare words (`keyword` and `identifier` tokens), and 'DELIMITER' on a
   * MySQL `DELIMITER xx` directive token (an occurrence of the active delimiter has none).
   */
  upper?: string
}

export interface SqlLexError {
  message: string
  /** Offset of the construct that could not be finished (its opening character). */
  offset: number
}

export interface SqlLexResult {
  tokens: SqlToken[]
  error?: SqlLexError
}

export interface SqlLexOptions {
  /**
   * Whether plain '…' strings take backslash escapes. Defaults per dialect: MySQL/MariaDB and
   * ClickHouse true, PostgreSQL/SQLite false. Pass the session's real setting when known
   * (MySQL `NO_BACKSLASH_ESCAPES` in @@sql_mode → false; PG standard_conforming_strings=off → true).
   */
  backslashEscapes?: boolean
}

interface DialectRules {
  backslashEscapes: boolean
  /** 'always' = MySQL; 'clickhouse' = only `# ` / `#!` (ClickHouse rejects `#x`). */
  hashComments: 'always' | 'clickhouse' | false
  dashNeedsSpace: boolean
  nestedComments: boolean
  executableComments: boolean
  dollarQuotes: boolean
  /** Upper-case letters allowed as a one-letter prefix of a '…' literal (X'ff', B'01', N'x'). */
  stringPrefixes: string
  /** PostgreSQL U&'…' and U&"…". */
  unicodeEscapes: boolean
  /** PostgreSQL E'…' (always backslash-escaped). */
  eStrings: boolean
  doubleQuotedStrings: boolean
  backtickIdentifiers: boolean
  bracketIdentifiers: boolean
  /** ClickHouse: backslash escapes inside `…` / "…" identifiers too. */
  quotedIdentifierBackslash: boolean
  delimiterCommand: boolean
  questionParams: boolean
  dollarParams: 'positional' | 'named' | false
  colonParams: boolean
  atParams: boolean
  atVariables: boolean
  braceParams: boolean
  dollarInIdentifiers: boolean
  /** MySQL: `1abc` is an identifier, not a number followed by a word. */
  digitLeadingIdentifiers: boolean
  digitSeparators: boolean
  /** PostgreSQL operator munching (`@>`, `?|`, `#>>`, user-defined operators). */
  pgOperators: boolean
  /** Multi-character operators, longest first (non-PG dialects; PG only uses it for `::`). */
  operators: readonly string[]
  /** Single characters lexed as operators. */
  operatorChars: string
}

const MYSQL_RULES: DialectRules = {
  backslashEscapes: true,
  hashComments: 'always',
  dashNeedsSpace: true,
  nestedComments: false,
  executableComments: true,
  dollarQuotes: false,
  stringPrefixes: 'XBN',
  unicodeEscapes: false,
  eStrings: false,
  doubleQuotedStrings: true,
  backtickIdentifiers: true,
  bracketIdentifiers: false,
  quotedIdentifierBackslash: false,
  delimiterCommand: true,
  questionParams: true,
  dollarParams: false,
  colonParams: false,
  atParams: false,
  atVariables: true,
  braceParams: false,
  dollarInIdentifiers: true,
  digitLeadingIdentifiers: true,
  digitSeparators: false,
  pgOperators: false,
  operators: ['<=>', '->>', '->', '<<', '>>', '<=', '>=', '<>', '!=', '||', '&&', ':='],
  operatorChars: '+-*/%=<>!|&^~:'
}

const RULES: Readonly<Record<SqlDialect, DialectRules>> = {
  mysql: MYSQL_RULES,
  mariadb: MYSQL_RULES,
  postgres: {
    backslashEscapes: false,
    hashComments: false,
    dashNeedsSpace: false,
    nestedComments: true,
    executableComments: false,
    dollarQuotes: true,
    stringPrefixes: 'BXN',
    unicodeEscapes: true,
    eStrings: true,
    doubleQuotedStrings: false,
    backtickIdentifiers: false,
    bracketIdentifiers: false,
    quotedIdentifierBackslash: false,
    delimiterCommand: false,
    questionParams: false,
    dollarParams: 'positional',
    colonParams: false,
    atParams: false,
    atVariables: false,
    braceParams: false,
    dollarInIdentifiers: true,
    digitLeadingIdentifiers: false,
    digitSeparators: true,
    pgOperators: true,
    operators: ['::'],
    operatorChars: ':'
  },
  sqlite: {
    backslashEscapes: false,
    hashComments: false,
    dashNeedsSpace: false,
    nestedComments: false,
    executableComments: false,
    dollarQuotes: false,
    stringPrefixes: 'X',
    unicodeEscapes: false,
    eStrings: false,
    doubleQuotedStrings: false,
    backtickIdentifiers: true,
    bracketIdentifiers: true,
    quotedIdentifierBackslash: false,
    delimiterCommand: false,
    questionParams: true,
    dollarParams: 'named',
    colonParams: true,
    atParams: true,
    atVariables: false,
    braceParams: false,
    dollarInIdentifiers: true,
    digitLeadingIdentifiers: false,
    digitSeparators: false,
    pgOperators: false,
    operators: ['->>', '->', '||', '<<', '>>', '<=', '>=', '==', '!=', '<>'],
    operatorChars: '+-*/%=<>!|&~'
  },
  clickhouse: {
    backslashEscapes: true,
    hashComments: 'clickhouse',
    dashNeedsSpace: false,
    nestedComments: true,
    executableComments: false,
    dollarQuotes: true,
    stringPrefixes: 'XB',
    unicodeEscapes: false,
    eStrings: false,
    doubleQuotedStrings: false,
    backtickIdentifiers: true,
    bracketIdentifiers: false,
    quotedIdentifierBackslash: true,
    delimiterCommand: false,
    questionParams: false,
    dollarParams: false,
    colonParams: false,
    atParams: false,
    atVariables: false,
    braceParams: true,
    dollarInIdentifiers: false,
    digitLeadingIdentifiers: false,
    digitSeparators: false,
    pgOperators: false,
    operators: ['<=>', '->', '::', '<=', '>=', '!=', '<>', '==', '||'],
    operatorChars: '+-*/%=<>!|&^~?:'
  }
}

// Words reported as `keyword` (the rest are `identifier`). Purely cosmetic for consumers that
// highlight or complete: the classifier works on `upper` of every bare word, so a non-reserved
// keyword missing here (PRAGMA, VACUUM, ...) is still recognised.
const KEYWORDS: ReadonlySet<string> = new Set(
  (
    'ABORT ACTION ADD AFTER AGAINST AGGREGATE ALGORITHM ALL ALTER ALWAYS ANALYSE ANALYZE AND ANTI ANY ' +
    'ARRAY AS ASC ASOF ATOMIC ATTACH AUTHORIZATION AUTO_INCREMENT AUTOINCREMENT BACKUP BEFORE BEGIN ' +
    'BETWEEN BIGINT BINARY BLOB BOOLEAN BOTH BY CACHE CALL CASCADE CASE CAST CHANGE CHAR CHARACTER ' +
    'CHARSET CHECK CHECKPOINT CLOSE CLUSTER COLLATE COLUMN COLUMNS COMMENT COMMIT COMMITTED ' +
    'CONCURRENTLY CONFLICT CONSTRAINT CONSTRAINTS COPY CREATE CROSS CUBE CURRENT CURRENT_DATE ' +
    'CURRENT_ROLE CURRENT_TIME CURRENT_TIMESTAMP CURRENT_USER CURSOR CYCLE DATABASE DATABASES DATE ' +
    'DATETIME DEALLOCATE DECIMAL DECLARE DEDUPLICATE DEFAULT DEFERRABLE DEFERRED DEFINER DELAYED ' +
    'DELETE DELIMITER DESC DESCRIBE DETACH DETERMINISTIC DICTIONARY DISTINCT DISTINCTROW DIV DO ' +
    'DOUBLE DROP DUAL DUPLICATE EACH ELSE ELSEIF END ENGINE ENUM ESCAPE EVENT EXCEPT EXCHANGE ' +
    'EXCLUSIVE EXECUTE EXISTS EXPLAIN EXTENSION FALSE FETCH FILTER FINAL FIRST FLOAT FLUSH FOLLOWING ' +
    'FOR FORCE FOREIGN FORMAT FROM FULL FULLTEXT FUNCTION GENERATED GLOBAL GRANT GROUP GROUPS ' +
    'HANDLER HAVING IF IGNORE ILIKE IMMEDIATE IN INDEX INFILE INNER INOUT INSERT INSTEAD INT INTEGER ' +
    'INTERSECT INTERVAL INTO INVOKER IS ISNULL ISOLATION JOIN JSON KEY KEYS KILL LANGUAGE LAST ' +
    'LATERAL LEADING LEAVE LEFT LEVEL LIKE LIMIT LINES LISTEN LOAD LOCAL LOCK LOOP LOW_PRIORITY ' +
    'MATCH MATCHED MATERIALIZED MERGE MODE MODIFY NATURAL NEXT NO NOT NOTIFY NOTNULL NOWAIT NULL ' +
    'NULLS NUMERIC OF OFFSET ON ONLY OPTIMIZE OPTION OR ORDER OUT OUTER OUTFILE OVER OVERWRITE ' +
    'PARTITION PERSIST PERSIST_ONLY PRAGMA PRECEDING PREPARE PREWHERE PRIMARY PRIVILEGES PROCEDURE ' +
    'PURGE QUERY QUICK RANGE READ RECURSIVE REFERENCES REGEXP REINDEX RELEASE RENAME REPEAT ' +
    'REPEATABLE REPLACE RESET RESTRICT RETURN RETURNING RETURNS REVOKE RIGHT RLIKE ROLE ROLLBACK ' +
    'ROLLUP ROW ROWS SAMPLE SAVEPOINT SCHEMA SCHEMAS SECURITY SELECT SEMI SEPARATOR SEQUENCE ' +
    'SERIALIZABLE SESSION SET SETTINGS SHARE SHOW SIMILAR SMALLINT SOME SQL START STATEMENT SYSTEM ' +
    'TABLE TABLES TABLESAMPLE TEMP TEMPORARY TEXT THEN TIES TIME TIMESTAMP TO TOP TOTALS TRAILING ' +
    'TRANSACTION TRIGGER TRUE TRUNCATE TTL UNBOUNDED UNCOMMITTED UNDROP UNION UNIQUE UNLISTEN ' +
    'UNLOCK UNSIGNED UNTIL UPDATE UPSERT USE USER USING VACUUM VALUES VARCHAR VIEW VIRTUAL WHEN ' +
    'WHERE WHILE WINDOW WITH WITHIN WITHOUT WORK XOR'
  ).split(' ')
)

/** True for tokens that carry no code (whitespace and ordinary comments). */
export const isSqlTrivia = (token: SqlToken): boolean =>
  token.type === 'whitespace' || token.type === 'comment'

/** True for bare words (keywords and unquoted identifiers). */
export const isSqlWord = (token: SqlToken): boolean =>
  token.type === 'keyword' || token.type === 'identifier'

const isDigit = (c: number): boolean => c >= 48 && c <= 57
const isHexDigit = (c: number): boolean =>
  isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)
// Every engine treats non-ASCII characters as identifier characters (no Unicode whitespace).
const isIdentStart = (c: number): boolean =>
  (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c >= 128
const isIdentPart = (c: number, dollar: boolean): boolean =>
  isIdentStart(c) || isDigit(c) || (dollar && c === 36)
const isSpace = (c: number): boolean => c === 32 || (c >= 9 && c <= 13)

const PG_OPERATOR_CHARS = '+-*/<>=~!@#%^&|`?'

/** True when text[from, to) holds only '+' and '-' characters. */
function isPlusMinusRun(text: string, from: number, to: number): boolean {
  for (let p = from; p < to; p++) {
    const ch = text.charCodeAt(p)
    if (ch !== 43 && ch !== 45) return false
  }
  return true
}

/** A `$tag$` opener at `i`, or null (`$1`, a lone `$`). */
function dollarTagAt(text: string, i: number): string | null {
  let j = i + 1
  if (text.charCodeAt(j) === 36) return '$$'
  const first = text.charCodeAt(j)
  if (!isIdentStart(first)) return null
  j++
  while (j < text.length && isIdentPart(text.charCodeAt(j), false)) j++
  return text.charCodeAt(j) === 36 ? text.slice(i, j + 1) : null
}

/** End (exclusive) of a quoted run opened at `open`, or -1 when unterminated. */
function quotedEnd(
  text: string,
  open: number,
  close: number,
  backslash: boolean,
  doubling: boolean
): number {
  const n = text.length
  let j = open + 1
  while (j < n) {
    const ch = text.charCodeAt(j)
    if (backslash && ch === 92) {
      j += 2
      continue
    }
    if (ch === close) {
      if (doubling && text.charCodeAt(j + 1) === close) {
        j += 2
        continue
      }
      return j + 1
    }
    j++
  }
  return -1
}

/** End of a `/* … *\/` comment opened at `i`, or -1 when unterminated. */
function blockCommentEnd(text: string, i: number, nested: boolean): number {
  const n = text.length
  let depth = 1
  let j = i + 2
  while (j < n) {
    const ch = text.charCodeAt(j)
    if (ch === 42 && text.charCodeAt(j + 1) === 47) {
      j += 2
      depth--
      if (depth === 0 || !nested) return j
      continue
    }
    if (nested && ch === 47 && text.charCodeAt(j + 1) === 42) {
      depth++
      j += 2
      continue
    }
    j++
  }
  return -1
}

const lineEnd = (text: string, i: number): number => {
  const k = text.indexOf('\n', i)
  return k < 0 ? text.length : k
}

/** `DELIMITER xx` at `i` (start of a statement): the directive's end and the new delimiter. */
function delimiterDirectiveAt(text: string, i: number): { end: number; delimiter: string } | null {
  if (text.slice(i, i + 9).toUpperCase() !== 'DELIMITER') return null
  const after = text.charCodeAt(i + 9)
  if (after !== 32 && after !== 9) return null
  const end = lineEnd(text, i)
  // The mysql client takes the first whitespace-separated word as the new delimiter (quotes
  // allowed) and ignores the rest of the line.
  const arg =
    text
      .slice(i + 10, end)
      .trim()
      .split(/[ \t]/)[0] ?? ''
  let delimiter = arg
  if (delimiter.length >= 2 && /^(['"`]).*\1$/.test(delimiter)) delimiter = delimiter.slice(1, -1)
  if (!delimiter) return null
  // `\r` of a CRLF line ending belongs to the whitespace that follows, not to the directive.
  const directiveEnd = text.charCodeAt(end - 1) === 13 ? end - 1 : end
  return { end: directiveEnd, delimiter }
}

/**
 * Tokenizes `text` for `dialect`. See the file header for the guarantees; `options` only
 * changes how backslashes inside plain '…' strings are read.
 */
export function lexSql(
  text: string,
  dialect: SqlDialect,
  options: SqlLexOptions = {}
): SqlLexResult {
  const rules = RULES[dialect]
  const backslash = options.backslashEscapes ?? rules.backslashEscapes
  const n = text.length
  const tokens: SqlToken[] = []
  let error: SqlLexError | undefined
  let delimiter = ';'
  // A custom delimiter made of non-word characters (`$$`, `//`) may follow a word directly
  // (`END$$`); a word-like one (`GO`) must stand alone.
  let delimiterBreaksWords = false
  let atStatementStart = true
  // Offsets of the executable-comment openers not closed yet (MySQL nests them leniently).
  const execOpeners: number[] = []
  let lastCode: SqlToken | null = null
  let i = 0

  const fail = (message: string, offset: number): void => {
    if (!error) error = { message, offset }
  }
  const push = (type: SqlTokenType, start: number, end: number, upper?: string): void => {
    const token: SqlToken = { type, text: text.slice(start, end), start, end }
    if (upper !== undefined) token.upper = upper
    tokens.push(token)
    if (type !== 'whitespace' && type !== 'comment') {
      atStatementStart = type === 'delimiter'
      lastCode = token
    }
  }
  const delimiterAt = (k: number): boolean => {
    if (delimiter === ';') return text.charCodeAt(k) === 59
    if (text.slice(k, k + delimiter.length).toUpperCase() !== delimiter.toUpperCase()) return false
    if (delimiterBreaksWords) return true
    const before = k > 0 ? text.charCodeAt(k - 1) : 32
    const after = k + delimiter.length < n ? text.charCodeAt(k + delimiter.length) : 32
    return !isIdentPart(before, true) && !isIdentPart(after, true)
  }
  const wordEnd = (from: number, dollar: boolean): number => {
    let j = from
    while (j < n && isIdentPart(text.charCodeAt(j), dollar)) {
      if (delimiterBreaksWords && delimiter !== ';' && delimiterAt(j)) break
      j++
    }
    return j
  }
  const pushWord = (start: number, end: number): void => {
    const upper = text.slice(start, end).toUpperCase()
    push(KEYWORDS.has(upper) ? 'keyword' : 'identifier', start, end, upper)
  }
  const pushQuoted = (
    type: SqlTokenType,
    start: number,
    open: number,
    close: number,
    escapes: boolean,
    doubling: boolean,
    what: string
  ): void => {
    const end = quotedEnd(text, open, close, escapes, doubling)
    if (end < 0) {
      fail(`Unterminated ${what}`, start)
      push(type, start, n)
      i = n
    } else {
      push(type, start, end)
      i = end
    }
  }

  while (i < n) {
    const c = text.charCodeAt(i)
    const next = i + 1 < n ? text.charCodeAt(i + 1) : -1

    if (isSpace(c)) {
      let j = i + 1
      while (j < n && isSpace(text.charCodeAt(j))) j++
      push('whitespace', i, j)
      i = j
      continue
    }

    if (
      rules.delimiterCommand &&
      atStatementStart &&
      execOpeners.length === 0 &&
      (c === 68 || c === 100)
    ) {
      const directive = delimiterDirectiveAt(text, i)
      if (directive) {
        push('delimiter', i, directive.end, 'DELIMITER')
        delimiter = directive.delimiter
        delimiterBreaksWords = !isIdentPart(delimiter.charCodeAt(0), false)
        i = directive.end
        continue
      }
    }

    if (delimiterAt(i)) {
      push('delimiter', i, i + delimiter.length)
      i += delimiter.length
      continue
    }

    if (execOpeners.length > 0 && c === 42 && next === 47) {
      push('executable_comment', i, i + 2)
      execOpeners.pop()
      i += 2
      continue
    }

    // Comments.
    if (c === 45 && next === 45) {
      const third = i + 2 < n ? text.charCodeAt(i + 2) : -1
      if (!rules.dashNeedsSpace || third === -1 || third <= 32) {
        const end = lineEnd(text, i)
        push('comment', i, end)
        i = end
        continue
      }
    }
    if (
      c === 35 &&
      rules.hashComments &&
      (rules.hashComments === 'always' || next === -1 || next === 33 || isSpace(next))
    ) {
      const end = lineEnd(text, i)
      push('comment', i, end)
      i = end
      continue
    }
    if (c === 47 && next === 42) {
      if (rules.executableComments) {
        let k = -1
        if (text.charCodeAt(i + 2) === 33) k = i + 3
        else if (text.charCodeAt(i + 2) === 77 && text.charCodeAt(i + 3) === 33) k = i + 4
        if (k > 0) {
          const versionEnd = Math.min(n, k + 6)
          while (k < versionEnd && isDigit(text.charCodeAt(k))) k++
          push('executable_comment', i, k)
          execOpeners.push(i)
          i = k
          continue
        }
      }
      const end = blockCommentEnd(text, i, rules.nestedComments)
      if (end < 0) {
        fail('Unterminated comment', i)
        push('comment', i, n)
        i = n
      } else {
        push('comment', i, end)
        i = end
      }
      continue
    }

    // Strings and quoted identifiers.
    if (c === 39) {
      pushQuoted('string', i, i, 39, backslash, true, 'string literal')
      continue
    }
    if (c === 34) {
      if (rules.doubleQuotedStrings)
        pushQuoted('string', i, i, 34, backslash, true, 'string literal')
      else
        pushQuoted(
          'quoted_identifier',
          i,
          i,
          34,
          rules.quotedIdentifierBackslash,
          true,
          'quoted identifier'
        )
      continue
    }
    if (c === 96 && rules.backtickIdentifiers) {
      pushQuoted(
        'quoted_identifier',
        i,
        i,
        96,
        rules.quotedIdentifierBackslash,
        true,
        'quoted identifier'
      )
      continue
    }
    if (c === 91 && rules.bracketIdentifiers) {
      pushQuoted('quoted_identifier', i, i, 93, false, false, 'quoted identifier')
      continue
    }

    // Prefixed literals: E'…', U&'…', U&"…", X'…', B'…', N'…' (the prefix is a whole word).
    if (isIdentStart(c)) {
      const upperC = c >= 97 && c <= 122 ? c - 32 : c
      if (rules.unicodeEscapes && upperC === 85 && next === 38) {
        const q = text.charCodeAt(i + 2)
        if (q === 39) {
          pushQuoted('string', i, i + 2, 39, false, true, 'string literal')
          continue
        }
        if (q === 34) {
          pushQuoted('quoted_identifier', i, i + 2, 34, false, true, 'quoted identifier')
          continue
        }
      }
      if (next === 39) {
        if (rules.eStrings && upperC === 69) {
          pushQuoted('string', i, i + 1, 39, true, true, 'string literal')
          continue
        }
        if (upperC < 128 && rules.stringPrefixes.includes(String.fromCharCode(upperC))) {
          pushQuoted('string', i, i + 1, 39, backslash, true, 'string literal')
          continue
        }
      }
      const end = wordEnd(i + 1, rules.dollarInIdentifiers)
      pushWord(i, end)
      i = end
      continue
    }

    // Numbers (a `.5` right after a name or `)` is a qualifier dot, not a number).
    const prev = lastCode as SqlToken | null
    const dotNumber =
      c === 46 &&
      isDigit(next) &&
      !(
        prev &&
        prev.end === i &&
        (isSqlWord(prev) || prev.type === 'quoted_identifier' || prev.text === ')')
      )
    if (isDigit(c) || dotNumber) {
      let j = i
      if (c === 48 && (next === 120 || next === 88) && isHexDigit(text.charCodeAt(i + 2))) {
        j = i + 2
        while (j < n && isHexDigit(text.charCodeAt(j))) j++
      } else if (
        c === 48 &&
        (next === 98 || next === 66) &&
        (text.charCodeAt(i + 2) === 48 || text.charCodeAt(i + 2) === 49)
      ) {
        j = i + 2
        while (j < n && (text.charCodeAt(j) === 48 || text.charCodeAt(j) === 49)) j++
      } else {
        const digits = (): void => {
          while (
            j < n &&
            (isDigit(text.charCodeAt(j)) ||
              (rules.digitSeparators &&
                text.charCodeAt(j) === 95 &&
                isDigit(text.charCodeAt(j + 1)) &&
                j > i))
          )
            j++
        }
        digits()
        if (text.charCodeAt(j) === 46 && text.charCodeAt(j + 1) !== 46) {
          j++
          digits()
        }
        const e = text.charCodeAt(j)
        if (e === 101 || e === 69) {
          const s = text.charCodeAt(j + 1)
          if (isDigit(s)) {
            j += 1
            digits()
          } else if ((s === 43 || s === 45) && isDigit(text.charCodeAt(j + 2))) {
            j += 2
            digits()
          }
        }
      }
      const wordTail = rules.digitLeadingIdentifiers ? wordEnd(j, true) : j
      if (wordTail > j) {
        pushWord(i, wordTail)
        i = wordTail
      } else {
        push('number', i, j)
        i = j
      }
      continue
    }

    // Parameters and variables.
    if (c === 63 && rules.questionParams) {
      let j = i + 1
      if (dialect === 'sqlite') while (j < n && isDigit(text.charCodeAt(j))) j++
      push('parameter', i, j)
      i = j
      continue
    }
    if (c === 58 && rules.colonParams && isIdentStart(next)) {
      const end = wordEnd(i + 2, true)
      push('parameter', i, end)
      i = end
      continue
    }
    if (c === 64) {
      if (rules.atVariables) {
        if (next === 64) {
          let j = i + 2
          while (j < n && (isIdentPart(text.charCodeAt(j), true) || text.charCodeAt(j) === 46)) j++
          push('variable', i, j)
          i = j
          continue
        }
        if (next === 39 || next === 34 || next === 96) {
          pushQuoted('variable', i, i + 1, next, next !== 96 && backslash, true, 'quoted variable')
          continue
        }
        if (isIdentPart(next, true) || next === 46) {
          let j = i + 1
          while (j < n && (isIdentPart(text.charCodeAt(j), true) || text.charCodeAt(j) === 46)) j++
          push('variable', i, j)
          i = j
          continue
        }
      } else if (rules.atParams && isIdentStart(next)) {
        const end = wordEnd(i + 2, true)
        push('parameter', i, end)
        i = end
        continue
      }
    }
    if (c === 36) {
      if (rules.dollarQuotes) {
        const tag = dollarTagAt(text, i)
        if (tag) {
          const close = text.indexOf(tag, i + tag.length)
          if (close < 0) {
            fail('Unterminated dollar-quoted string', i)
            push('string', i, n)
            i = n
          } else {
            push('string', i, close + tag.length)
            i = close + tag.length
          }
          continue
        }
      }
      if (rules.dollarParams === 'positional' && isDigit(next)) {
        let j = i + 1
        while (j < n && isDigit(text.charCodeAt(j))) j++
        push('parameter', i, j)
        i = j
        continue
      }
      if (rules.dollarParams === 'named' && isIdentPart(next, false)) {
        const end = wordEnd(i + 1, true)
        push('parameter', i, end)
        i = end
        continue
      }
      if (rules.dollarInIdentifiers && isIdentPart(next, true)) {
        const end = wordEnd(i + 1, true)
        pushWord(i, end)
        i = end
        continue
      }
    }
    if (c === 123 && rules.braceParams) {
      // Only look 512 characters ahead: an unmatched '{' must not rescan the rest of the text.
      const near = text.slice(i + 1, i + 513).indexOf('}')
      const close = near < 0 ? -1 : i + 1 + near
      if (close > 0) {
        const inner = text.slice(i + 1, close)
        if (/^\s*[A-Za-z_][A-Za-z0-9_]*\s*:\s*[^\s{}][^{}]*$/.test(inner)) {
          push('parameter', i, close + 1)
          i = close + 1
          continue
        }
      }
    }

    // Operators.
    if (rules.pgOperators && PG_OPERATOR_CHARS.includes(text[i] as string)) {
      let j = i + 1
      while (j < n && PG_OPERATOR_CHARS.includes(text[j] as string)) {
        const ch = text.charCodeAt(j)
        const after = text.charCodeAt(j + 1)
        if ((ch === 45 && after === 45) || (ch === 47 && after === 42)) break
        j++
      }
      // PostgreSQL: a multi-character operator cannot end in + or - unless it also contains
      // one of ~ ! @ # % ^ & | ` ? (so `=-1` is `=` then `-1`).
      if (!/[~!@#%^&|`?]/.test(text.slice(i, j))) {
        let k = j
        while (k - i > 1 && (text.charCodeAt(k - 1) === 43 || text.charCodeAt(k - 1) === 45)) k--
        if (k - i === 1 && isPlusMinusRun(text, i, j)) {
          // Only + and -: each is its own operator. Emit them in one pass instead of rescanning
          // the rest of the run once per character (quadratic on a long run).
          for (let p = i; p < j; p++) push('operator', p, p + 1)
          i = j
          continue
        }
        j = k
      }
      push('operator', i, j)
      i = j
      continue
    }
    const multi = rules.operators.find((op) => text.startsWith(op, i))
    if (multi) {
      push('operator', i, i + multi.length)
      i += multi.length
      continue
    }
    if (rules.operatorChars.includes(text[i] as string)) {
      push('operator', i, i + 1)
      i++
      continue
    }

    if (c === 40 || c === 41 || c === 44 || c === 46 || c === 59 || c === 91 || c === 93) {
      push('punctuation', i, i + 1)
      i++
      continue
    }
    if (c === 123 || c === 125) {
      push('punctuation', i, i + 1)
      i++
      continue
    }

    // Anything else is a single unknown character (a lone surrogate pair stays together).
    const width = c >= 0xd800 && c <= 0xdbff && i + 1 < n ? 2 : 1
    push('unknown', i, i + width)
    i += width
  }

  if (execOpeners.length > 0) fail('Unterminated executable comment', execOpeners[0] as number)
  return error ? { tokens, error } : { tokens }
}

// Masks credentials inside SQL text before it is stored in query history, persisted as a draft,
// or handed to the AI assistant (research/safety.md §D4). Covered:
//   CREATE/ALTER USER … IDENTIFIED [WITH plugin] BY [PASSWORD] '…' [REPLACE '…']
//   IDENTIFIED VIA|WITH plugin USING [PASSWORD('…') | '…']        (MariaDB)
//   [ENCRYPTED] PASSWORD '…' | PASSWORD = '…' | PASSWORD('…') | MASTER_PASSWORD = '…'   (PG, MySQL)
//   password = crypt('…', …) / md5('…') / SHA2('…', 256): the literal arguments of the call
//   SET PASSWORD [FOR user] = '…'
//   secret_access_key = '…', account_key = '…', session_token = '…' (ClickHouse named arguments)
//   ClickHouse positional secrets of table functions and table / database engines: mysql(),
//   postgresql(), mongodb(), redis(), remote()/remoteSecure(), s3()/s3Cluster() and the
//   S3-compatible ones, azureBlobStorage(), ExternalDistributed, MaterializedMySQL/PostgreSQL
//   inside string literals: libpq conninfo password=… (also a quoted 'value with spaces'),
//   PWD= / AccountKey= / SharedAccessSignature= of ODBC / Azure connection strings
//   anywhere: user:pass@ in URLs, signature / token URL parameters
// A literal is any spelling of a string: '…', "…", E'…', N'…', U&'…', _charset'…' and
// $tag$…$tag$ / $$…$$; a masked one becomes '***' ("***" for a double-quoted one), and so does
// each literal concatenated to it with ||.
//
// Token based (the shared SQL lexer): a keyword only counts where it is code, so a string that
// merely ends in "password" ('smtp_password', a COMMENT about the password) is data, and NULL,
// columns, binds and user variables after `password =` are left alone. The contents of strings,
// quoted identifiers, comments and dollar-quoted bodies (DO $$ … $$, EXECUTE '…', a
// commented-out statement) are masked as SQL too, a few levels deep. `password=value` written
// without spaces counts as a connection string even outside a literal (sample cells, prose,
// error messages), unless the value is NULL, a bind or a call. A MySQL syntax error echoes the
// statement inside unescaped quotes (near '…' at line N); that echo is masked as SQL first.
//
// No rule rescans text it has passed (the URL rule cannot restart inside a long `a-b-c…` run,
// call arguments are collected once over matched brackets), so masking is as linear as lexing.

import type { SqlDialect } from '../data-projects/types'
import { maskUrlCredentials } from '../data-projects/url-credentials'
import { isSqlTrivia, isSqlWord, lexSql, type SqlToken } from './lexer'

const MASK_SINGLE = "'***'"
const MASK_DOUBLE = '"***"'

const isPunct = (t: SqlToken | undefined, text: string): boolean =>
  t !== undefined && (t.type === 'punctuation' || t.type === 'operator') && t.text === text
const isWord = (t: SqlToken | undefined, upper: string): boolean =>
  t !== undefined && isSqlWord(t) && t.upper === upper
const isOpenBracket = (t: SqlToken): boolean =>
  t.type === 'punctuation' && (t.text === '(' || t.text === '[' || t.text === '{')
const isCloseBracket = (t: SqlToken): boolean =>
  t.type === 'punctuation' && (t.text === ')' || t.text === ']' || t.text === '}')
/** `=`, `:=` (MySQL assignment) or `=>` (PostgreSQL named argument). */
const isAssign = (t: SqlToken | undefined): boolean =>
  isPunct(t, '=') || isPunct(t, ':=') || isPunct(t, '=>')

/** '***', or "***" when the literal is double-quoted. */
function literalMask(token: SqlToken): string {
  if (token.text.startsWith('$')) return MASK_SINGLE
  const single = token.text.indexOf("'")
  const double = token.text.indexOf('"')
  return double >= 0 && (single < 0 || double < single) ? MASK_DOUBLE : MASK_SINGLE
}

/** For each opening bracket, its closing bracket (a `;` or the end closes what is still open). */
function matchBrackets(code: SqlToken[]): Int32Array {
  const match = new Int32Array(code.length).fill(-1)
  const stack: number[] = []
  for (let k = 0; k < code.length; k++) {
    const t = code[k]
    if (isOpenBracket(t)) stack.push(k)
    else if (isCloseBracket(t)) {
      if (stack.length > 0) match[stack.pop() as number] = k
    } else if (t.type === 'delimiter') {
      for (const open of stack) match[open] = k
      stack.length = 0
    }
  }
  for (const open of stack) match[open] = code.length
  return match
}

// ---------------------------------------------------------------------------------------------
// ClickHouse positional secrets (mirrors ClickHouse's own FunctionSecretArgumentsFinder)
// ---------------------------------------------------------------------------------------------

/**
 * One argument of a call: its top-level code tokens (no whitespace or comments). A nested group
 * is represented by its opening bracket only (`numbers(10)` → `numbers`, `(`).
 */
type CallArg = SqlToken[]

interface CallContext {
  /** `CREATE|ATTACH DATABASE … ENGINE = Name(…)`: the database-engine signature applies. */
  databaseEngine: boolean
}

const isStringArg = (arg: CallArg | undefined): boolean =>
  arg !== undefined && arg.length === 1 && arg[0].type === 'string'

/** A bare name (`named_collection`, `NOSIGN`): ClickHouse reads it as an identifier. */
const isNameArg = (arg: CallArg | undefined): boolean =>
  arg !== undefined &&
  arg.length === 1 &&
  (isSqlWord(arg[0]) || arg[0].type === 'quoted_identifier')

/** The text of a string or bare-name argument, without its quotes; undefined otherwise. */
function argText(arg: CallArg | undefined): string | undefined {
  if (!arg || arg.length !== 1) return undefined
  const token = arg[0]
  if (isSqlWord(token)) return token.text
  if (token.type !== 'string' && token.type !== 'quoted_identifier') return undefined
  const dollar = /^(\$[^$]*\$)([\s\S]*)\1$/.exec(token.text)
  return dollar ? dollar[2] : token.text.slice(1, -1)
}

// Format names that may follow the URL (s3) or the blob path (azureBlobStorage) instead of
// credentials. Exact names only: a prefix test would take an account name like "csvstore" for a
// format and leave the key next to it unmasked.
const FORMAT_NAMES: ReadonlySet<string> = new Set(
  [
    'CSV',
    'TSV',
    'TSVRaw',
    'TabSeparated',
    'TabSeparatedRaw',
    'Raw',
    'CustomSeparated',
    'CustomSeparatedIgnoreSpaces',
    'RowBinary',
    'JSONCompactEachRow',
    'JSONCompactStringsEachRow',
    'LineAsString'
  ]
    .flatMap((name) => [name, `${name}WithNames`, `${name}WithNamesAndTypes`])
    .concat([
      'auto',
      'JSON',
      'JSONEachRow',
      'JSONStringsEachRow',
      'JSONLines',
      'NDJSON',
      'JSONCompact',
      'JSONCompactStrings',
      'JSONColumns',
      'JSONColumnsWithMetadata',
      'JSONAsString',
      'JSONAsObject',
      'JSONObjectEachRow',
      'JSONStrings',
      'BSONEachRow',
      'Parquet',
      'ORC',
      'Arrow',
      'ArrowStream',
      'Avro',
      'AvroConfluent',
      'Native',
      'Values',
      'Template',
      'TemplateIgnoreSpaces',
      'Regexp',
      'Protobuf',
      'ProtobufSingle',
      'ProtobufList',
      'CapnProto',
      'MsgPack',
      'Npy',
      'RawBLOB',
      'MySQLDump',
      'SQLInsert',
      'TSKV',
      'XML',
      'Markdown',
      'One',
      'Form',
      'DWARF',
      'Null'
    ])
    .map((name) => name.toLowerCase())
)
const isFormatName = (text: string | undefined): boolean =>
  text !== undefined && FORMAT_NAMES.has(text.toLowerCase())

/** mysql('host:port', 'db', 'table', 'user', 'password', …) and the database-engine form. */
const mysqlLike =
  (databaseIndex: number | null, tableIndex: number | null) =>
  (args: CallArg[], context: CallContext): number[] => {
    if (isNameArg(args[0])) return [] // named collection: `password = '…'` is a named argument
    // The database engine takes ('host:port', 'db', 'user', 'password'); a 4-argument call can
    // only be that form.
    const useDatabase = databaseIndex !== null && (context.databaseEngine || args.length === 4)
    const index = useDatabase ? databaseIndex : tableIndex
    return index === null ? [] : [index]
  }

/**
 * s3('url', ['access_key_id', 'secret_access_key', ['session_token',]] ['format', …]);
 * s3Cluster('cluster', 'url', …) has the URL second. Nothing is masked for the forms without
 * credentials: s3('url', NOSIGN, …) and s3('url', 'format', 'structure'[, 'compression']).
 */
const s3Like =
  (urlIndex: number) =>
  (args: CallArg[]): number[] => {
    if (isNameArg(args[urlIndex])) return []
    // headers(…) / extra_credentials(…) do not count as positional arguments.
    const count = args.filter((arg) => {
      const name = arg[0]?.upper
      return !(arg[1]?.text === '(' && (name === 'HEADERS' || name === 'EXTRA_CREDENTIALS'))
    }).length
    if (count >= urlIndex + 3 && count <= urlIndex + 4) {
      const second = argText(args[urlIndex + 1])
      if (second !== undefined && (second.toUpperCase() === 'NOSIGN' || isFormatName(second)))
        return []
    }
    const indexes: number[] = []
    if (urlIndex + 2 < count) indexes.push(urlIndex + 2)
    // A string after the secret that is not a format is the session token.
    const fourth = args[urlIndex + 3]
    if (urlIndex + 3 < count && isStringArg(fourth) && !isFormatName(argText(fourth)))
      indexes.push(urlIndex + 3)
    return indexes
  }

/**
 * azureBlobStorage(connection_string | storage_account_url, container, blobpath[, account_name,
 * account_key][, format, compression, structure]); the …Cluster form has the cluster first.
 * AccountKey= inside a connection string is masked by the connection-string rule.
 */
const azureLike =
  (urlIndex: number) =>
  (args: CallArg[]): number[] => {
    if (isNameArg(args[urlIndex])) return []
    const count = args.length
    if (count >= urlIndex + 4 && count <= urlIndex + 7 && isFormatName(argText(args[urlIndex + 3])))
      return []
    return urlIndex + 4 < count ? [urlIndex + 4] : []
  }

/**
 * remote('addresses', db.table | 'db.table' | db, table | table_function(…), 'user'[, 'password']
 * [, sharding_key]). The password is the literal after the user; when the second argument is an
 * expression it is unclear whether one or two arguments name the table, so both candidates are
 * masked when they are literals (a sharding key is never a string literal).
 */
function remoteSecrets(args: CallArg[]): number[] {
  if (args.length < 3 || isNameArg(args[0])) return []
  const target = args[1]
  let qualified: boolean | undefined
  if (isStringArg(target)) qualified = (argText(target) ?? '').includes('.')
  else if (
    target.length > 0 &&
    target.every((token, i) =>
      i % 2 === 1 ? token.text === '.' : isSqlWord(token) || token.type === 'quoted_identifier'
    ) &&
    target.length % 2 === 1
  )
    qualified = target.length > 1
  const candidates = qualified === undefined ? [3, 4] : [qualified ? 3 : 4]
  return candidates.filter((index) => isStringArg(args[index]))
}

type SecretArgsRule = (args: CallArg[], context: CallContext) => number[]

// Keys are lower-case: ClickHouse table functions are case-insensitive, and engines (MySQL,
// S3, …) share the function's signature.
const SECRET_ARGS: ReadonlyMap<string, SecretArgsRule> = new Map<string, SecretArgsRule>([
  ['mysql', mysqlLike(3, 4)],
  ['postgresql', mysqlLike(3, 4)],
  ['materializedpostgresql', mysqlLike(3, 4)],
  ['materializedmysql', mysqlLike(3, null)],
  ['materializemysql', mysqlLike(3, null)],
  ['mongodb', mysqlLike(null, 4)],
  // redis('host:port', 'key', 'structure'[, db_index[, 'password'[, pool_size]]])
  ['redis', mysqlLike(null, 4)],
  // ExternalDistributed('engine', 'host:port', 'db', 'table', 'user', 'password')
  ['externaldistributed', mysqlLike(null, 5)],
  ['remote', remoteSecrets],
  ['remotesecure', remoteSecrets],
  ...['s3', 'cosn', 'oss', 'gcs', 'deltalake', 'deltalakes3', 'hudi', 'iceberg', 'icebergs3'].map(
    (name): [string, SecretArgsRule] => [name, s3Like(0)]
  ),
  ['s3queue', s3Like(0)],
  ...['s3cluster', 'deltalakecluster', 'hudicluster', 'icebergcluster', 'icebergs3cluster'].map(
    (name): [string, SecretArgsRule] => [name, s3Like(1)]
  ),
  ...['azureblobstorage', 'azurequeue', 'icebergazure', 'deltalakeazure'].map(
    (name): [string, SecretArgsRule] => [name, azureLike(0)]
  ),
  ...['azureblobstoragecluster', 'icebergazurecluster', 'deltalakeazurecluster'].map(
    (name): [string, SecretArgsRule] => [name, azureLike(1)]
  )
])

const SECRET_CALL = new RegExp(String.raw`\b(?:${[...SECRET_ARGS.keys()].join('|')})\s*\(`, 'i')

/** The top-level arguments of the call whose `(` is code[open], with their code-index ranges. */
function callArgs(
  code: SqlToken[],
  open: number,
  match: Int32Array
): { args: CallArg[]; ranges: Array<[number, number]> } {
  const close = Math.min(match[open], code.length)
  const args: CallArg[] = []
  const ranges: Array<[number, number]> = []
  let current: CallArg = []
  let from = open + 1
  for (let k = open + 1; k < close; k++) {
    const token = code[k]
    if (isPunct(token, ',')) {
      args.push(current)
      ranges.push([from, k])
      current = []
      from = k + 1
      continue
    }
    current.push(token)
    // A nested group counts once: its tokens belong to the innermost call around them.
    if (isOpenBracket(token)) k = match[k]
  }
  if (current.length > 0 || args.length > 0) {
    args.push(current)
    ranges.push([from, close])
  }
  return { args, ranges }
}

// ---------------------------------------------------------------------------------------------
// Connection strings
// ---------------------------------------------------------------------------------------------

const CONNECTION_KEY_HINT = /password|pwd|accountkey|sharedaccesssignature/i
/** A connection-string key (libpq, ODBC, Azure) and its `=`, inside a literal or a comment. */
const CONNECTION_KEY = /(?<![\w.$])((?:ssl)?password|pwd|AccountKey|SharedAccessSignature)\s*=\s*/gi
const GLUED_KEYS: ReadonlySet<string> = new Set([
  'PASSWORD',
  'SSLPASSWORD',
  'PWD',
  'ACCOUNTKEY',
  'SHAREDACCESSSIGNATURE'
])
const isOdbcKey = (key: string): boolean => !/password$/i.test(key)
/** Tokens a glued `password=value` outside a literal never runs into. */
const GLUED_VALUE_STOP: ReadonlySet<string> = new Set([
  'string',
  'quoted_identifier',
  'delimiter',
  'executable_comment'
])
const isSpaceChar = (ch: string): boolean => ch === ' ' || (ch >= '\t' && ch <= '\r')

/**
 * End of the connection-string value that starts at text[i] (inside a literal): a quoted libpq
 * value ('…' with backslash escapes, or doubled quotes of SQL text inside a literal), a braced
 * ODBC value ({…}), else a run up to whitespace or a quote (or a `;` for ODBC keys).
 */
function valueEnd(text: string, i: number, odbc: boolean): number {
  const n = text.length
  const first = text[i]
  if (first === "'") {
    let j = i + 1
    while (j < n) {
      const ch = text[j]
      if (ch === '\\') j += 2
      else if (ch === "'") {
        if (text[j + 1] !== "'") return j + 1
        j += 2
      } else j++
    }
    return n
  }
  if (odbc && first === '{') {
    let j = i + 1
    while (j < n) {
      if (text[j] === '}') {
        if (text[j + 1] !== '}') return j + 1
        j += 2
      } else j++
    }
    return n
  }
  let j = i
  while (j < n) {
    const ch = text[j]
    if (isSpaceChar(ch) || ch === "'" || ch === '"' || ch === '`') break
    if (odbc && ch === ';') break
    j++
  }
  return j
}

/** Values that are SQL, not a password: NULL / DEFAULT / booleans, binds, variables, calls. */
function isSqlValue(value: string, next: string | undefined): boolean {
  return (
    /^(?:NULL|DEFAULT|TRUE|FALSE)$/i.test(value) ||
    /^(?:\$\d+|\?\d*|[:@]{1,2}[A-Za-z_][\w$.]*)$/.test(value) ||
    /^[A-Za-z_][\w$.]*\(/.test(value) ||
    (next === '(' && /^[A-Za-z_][\w$.]*$/.test(value)) ||
    value === '***'
  )
}

const maskedValue = (value: string): string =>
  value[0] === "'" ? MASK_SINGLE : value[0] === '{' ? '{***}' : '***'

/**
 * Masks `password=…` / `PWD=…` / `AccountKey=…` values in the text of a literal or comment.
 * Connection strings write `key=value`; with spaces around the `=` only a quoted value counts,
 * so SQL inside the literal (`EXECUTE 'UPDATE users SET password = new_pw'`, a function body)
 * keeps its columns and parameters.
 */
function maskConnectionStrings(text: string): string {
  if (!CONNECTION_KEY_HINT.test(text)) return text
  const re = new RegExp(CONNECTION_KEY.source, 'gi')
  let out = ''
  let at = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const start = m.index + m[0].length
    const end = valueEnd(text, start, isOdbcKey(m[1]))
    const value = text.slice(start, end)
    if (end === start || value === MASK_SINGLE || isSqlValue(value, text[end])) continue
    if (m[0].length > m[1].length + 1 && value[0] !== "'" && value[0] !== '{') continue
    out += text.slice(at, start) + maskedValue(value)
    at = end
    re.lastIndex = end
  }
  return at === 0 ? text : out + text.slice(at)
}

// ---------------------------------------------------------------------------------------------
// Token pass
// ---------------------------------------------------------------------------------------------

interface Replacement {
  start: number
  end: number
  text: string
}

/**
 * The apostrophe of an English contraction or possessive (what's, don't, I'm, you're, it'll):
 * after two letters (or a lone I) and before s / t / m / d / re / ve / ll ending a word. SQL
 * never glues a closing quote between such letters, nor an opening one (a string prefix is one
 * letter: E's…' stays a string).
 */
const CONTRACTION = /(?<=[A-Za-z]{2}|\bI)'(?=(?:s|t|m|d|re|ve|ll)\b)/gi

/** Keywords that make a literal's content worth masking as SQL. */
const CODE_HINT = /passw|identified|secret_access_key|account_key|session_token/i
const NAMED_SECRET = /^(?:AWS_)?(?:SECRET_ACCESS_KEY|ACCOUNT_KEY|SESSION_TOKEN)$/
const CHARSET_INTRODUCER = /^_[A-Za-z][A-Za-z0-9]*$/
const STRING_PREFIX = /^[EeNnXxBb]$/
/** Literal contents are masked as SQL this many levels deep (DO $$ … EXECUTE '…' …). */
const MAX_DEPTH = 2

interface MaskContext {
  dialect: SqlDialect
  /** No dialect given: "…" may be a MySQL string. */
  generic: boolean
}

const unquotedName = (t: SqlToken): string => t.text.slice(1, -1)

/** A literal's body with its quote escapes undone: '' → ', and \' → ' where backslashes escape. */
function unescapeQuoted(body: string, quote: string, backslash: boolean): string {
  if (!body.includes(quote) && !(backslash && body.includes('\\'))) return body
  let out = ''
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (backslash && ch === '\\' && i + 1 < body.length) {
      out += body[i + 1] === quote ? quote : ch + body[i + 1]
      i++
    } else if (ch === quote && body[i + 1] === quote) {
      out += quote
      i++
    } else out += ch
  }
  return out
}

/** Masks a literal's or comment's content: connection strings, then the content as SQL. */
function maskContent(content: string, context: MaskContext, depth: number): string {
  let next = maskConnectionStrings(content)
  if (depth <= MAX_DEPTH && (CODE_HINT.test(next) || SECRET_CALL.test(next)))
    next = maskCode(next, context, depth)
  return next
}

/**
 * The token rewritten with its content masked (strings, quoted identifiers, comments), or null
 * when nothing in it changed.
 */
function maskTokenContent(
  token: SqlToken,
  closed: boolean,
  context: MaskContext,
  depth: number
): string | null {
  const text = token.text
  let open: string
  let close: string
  let quote: string | null = null
  let backslash = false
  if (token.type === 'comment') {
    if (text.startsWith('/*')) {
      open = '/*'
      close = closed && text.length >= 4 && text.endsWith('*/') ? '*/' : ''
    } else {
      open = text.startsWith('--') ? '--' : '#'
      close = ''
    }
  } else if (text.startsWith('$')) {
    const tag = /^\$[^$]*\$/.exec(text)?.[0] ?? '$'
    open = tag
    close = closed && text.length >= tag.length * 2 && text.endsWith(tag) ? tag : ''
  } else {
    const q = text.search(/['"`[]/)
    if (q < 0) return null
    quote = text[q] === '[' ? null : text[q]
    if (quote === null) return null // [bracket] identifiers have no escapes to rebuild
    open = text.slice(0, q + 1)
    close = closed && text.length > q + 1 ? quote : ''
    const prefix = text.slice(0, q).toUpperCase()
    backslash =
      prefix === 'E' ||
      (token.type === 'string'
        ? context.dialect === 'mysql' ||
          context.dialect === 'mariadb' ||
          context.dialect === 'clickhouse'
        : context.dialect === 'clickhouse')
  }
  const raw = text.slice(open.length, text.length - close.length)
  const body = quote === null ? raw : unescapeQuoted(raw, quote, backslash)
  const masked = maskContent(body, context, depth + 1)
  if (masked === body) return null
  return open + (quote === null ? masked : masked.split(quote).join(quote + quote)) + close
}

function applyReplacements(text: string, replacements: Replacement[]): string {
  if (replacements.length === 0) return text
  replacements.sort((a, b) => a.start - b.start || b.end - a.end)
  let out = ''
  let at = 0
  for (const r of replacements) {
    if (r.start < at) continue // the same text reached through two rules: the first wins
    out += text.slice(at, r.start) + r.text
    at = r.end
  }
  return out + text.slice(at)
}

/** One masking pass over `text` lexed as SQL; literal contents recurse up to MAX_DEPTH. */
function maskCode(text: string, context: MaskContext, depth: number): string {
  // Prose around SQL (an assistant question, a history turn, an error) has apostrophes that
  // would pair with the quotes of the SQL in it: they are not quotes for the lexer.
  const lexText = text.includes("'") ? text.replace(CONTRACTION, '_') : text
  const lexed = lexSql(lexText, context.dialect)
  const tokens = lexed.tokens
  const unterminatedAt = lexed.error ? lexed.error.offset : -1
  const code = tokens.filter((t) => !isSqlTrivia(t))
  const match = matchBrackets(code)
  const taken = new Uint8Array(code.length)
  const values: Replacement[] = []

  const isLiteral = (t: SqlToken | undefined): boolean =>
    t !== undefined &&
    (t.type === 'string' ||
      (context.generic && t.type === 'quoted_identifier' && t.text.startsWith('"')))

  /** Index of the last token of the literal that starts at code[ci], or -1. */
  const literalAt = (ci: number): number => {
    const t = code[ci]
    if (t === undefined) return -1
    if (isLiteral(t)) return ci
    if (!isSqlWord(t)) return -1
    const next = code[ci + 1]
    if (next?.type === 'string') {
      // _utf8mb4'…' / _latin1 '…' (MySQL charset introducer); E'…' / N'…' where the dialect
      // lexes the prefix as a word.
      if (CHARSET_INTRODUCER.test(t.text)) return ci + 1
      if (STRING_PREFIX.test(t.text) && next.start === t.end) return ci + 1
    }
    // U&'…'
    const after = code[ci + 2]
    if (
      (t.text === 'U' || t.text === 'u') &&
      isPunct(next, '&') &&
      next?.start === t.end &&
      after?.type === 'string' &&
      after.start === next.end
    )
      return ci + 2
    return -1
  }

  const maskLiteral = (from: number, to: number): void => {
    if (taken[to]) return
    for (let k = from; k <= to; k++) taken[k] = 1
    values.push({ start: code[from].start, end: code[to].end, text: literalMask(code[to]) })
  }

  /** The literal arguments of the call whose `(` is code[open] (not those of nested calls). */
  const maskCallLiterals = (open: number): void => {
    const close = Math.min(match[open], code.length)
    for (let k = open + 1; k < close; k++) {
      if (isOpenBracket(code[k])) {
        k = match[k]
        continue
      }
      const end = literalAt(k)
      if (end >= 0 && end < close) {
        maskLiteral(k, end)
        k = end
      }
    }
  }

  /**
   * Masks the value at code[ci]: a literal (with the literals concatenated to it, and the
   * `REPLACE 'old'` after it), or with `allowCall` the literal arguments of a call.
   */
  const maskValue = (ci: number, allowCall: boolean): void => {
    const end = literalAt(ci)
    if (end >= 0) {
      maskLiteral(ci, end)
      let k = end + 1
      while (isPunct(code[k], '||')) {
        const next = literalAt(k + 1)
        if (next < 0) break
        maskLiteral(k + 1, next)
        k = next + 1
      }
      if (isWord(code[k], 'REPLACE')) {
        const old = literalAt(k + 1)
        if (old >= 0) maskLiteral(k + 1, old)
      }
      return
    }
    if (allowCall && code[ci] && isSqlWord(code[ci]) && isPunct(code[ci + 1], '('))
      maskCallLiterals(ci + 1)
  }

  // CREATE/ALTER USER … IDENTIFIED [WITH|VIA plugin] BY|AS|USING [PASSWORD[(]] '…'
  const identified = (ci: number): void => {
    let j = ci + 1
    if (isWord(code[j], 'WITH') || isWord(code[j], 'VIA')) {
      j++
      const plugin = code[j]
      if (
        plugin &&
        (isSqlWord(plugin) || plugin.type === 'string' || plugin.type === 'quoted_identifier')
      )
        j++
    }
    if (!(isWord(code[j], 'BY') || isWord(code[j], 'AS') || isWord(code[j], 'USING'))) return
    j++
    if (isWord(code[j], 'PASSWORD')) {
      j++
      if (isPunct(code[j], '(')) j++
    }
    maskValue(j, false)
  }

  // PASSWORD '…', [ENCRYPTED] PASSWORD = '…', MASTER_PASSWORD = '…', PASSWORD('…'),
  // password = crypt('…', …), SET PASSWORD [FOR user] = '…'.
  const passwordKey = (ci: number): void => {
    const j = ci + 1
    if (isWord(code[ci], 'PASSWORD') && isWord(code[ci - 1], 'SET') && isWord(code[j], 'FOR')) {
      let k = j + 1
      while (
        k < code.length &&
        k < j + 64 &&
        code[k].type !== 'delimiter' &&
        !isPunct(code[k], '=')
      )
        k++
      if (isPunct(code[k], '=')) maskValue(k + 1, true)
    } else if (isPunct(code[j], '(')) maskCallLiterals(j)
    else if (isAssign(code[j])) maskValue(j + 1, true)
    else maskValue(j, false)
  }

  // password=secret written without spaces: a connection string outside a literal (a sample
  // cell, prose, an error message), unless the value is SQL (NULL, a bind, a call…).
  // The value is the run of code tokens touching the `=` and each other, up to a `;`, `,` or
  // bracket (never into a comment or a literal).
  let gluedReach = -1
  const glued = (ci: number): void => {
    const key = code[ci]
    const eq = code[ci + 1]
    if (key.start < gluedReach) return // inside the value masked before: `password=pwd=x`
    if (!isPunct(eq, '=') || eq.start !== key.end || isPunct(code[ci - 1], '.')) return
    let last = ci + 1
    while (
      code[last + 1] !== undefined &&
      code[last + 1].start === code[last].end &&
      !GLUED_VALUE_STOP.has(code[last + 1].type) &&
      !/^[;,()]$/.test(code[last + 1].text)
    )
      last++
    if (last === ci + 1) return
    const end = code[last].end
    const value = text.slice(eq.end, end)
    if (isSqlValue(value, text[end])) return
    values.push({ start: eq.end, end, text: maskedValue(value) })
    gluedReach = end
  }

  for (let ci = 0; ci < code.length; ci++) {
    const t = code[ci]
    if (t.type === 'quoted_identifier' && /password$/i.test(unquotedName(t))) {
      passwordKey(ci)
      continue
    }
    if (!isSqlWord(t)) continue
    const word = t.upper as string
    if (word === 'IDENTIFIED') identified(ci)
    else if (word.endsWith('PASSWORD')) passwordKey(ci)
    else if (NAMED_SECRET.test(word) && isAssign(code[ci + 1])) maskValue(ci + 2, false)
    if (GLUED_KEYS.has(word)) glued(ci)
  }

  // ClickHouse table functions and engines: the positional password / secret arguments.
  if (SECRET_CALL.test(text)) {
    const ranges: Array<[number, number]> = []
    // `CREATE|ATTACH [OR REPLACE] DATABASE …` per statement (its first two other words).
    let first: string | null = null
    let databaseStatement = false
    let wordsSeen = 0
    for (let ci = 0; ci < code.length; ci++) {
      const t = code[ci]
      if (t.type === 'delimiter') {
        first = null
        databaseStatement = false
        wordsSeen = 0
        continue
      }
      if (isSqlWord(t) && wordsSeen < 2 && t.upper !== 'OR' && t.upper !== 'REPLACE') {
        if (wordsSeen === 0) first = t.upper as string
        else
          databaseStatement = (first === 'CREATE' || first === 'ATTACH') && t.upper === 'DATABASE'
        wordsSeen++
      }
      if (!isSqlWord(t) || !isPunct(code[ci + 1], '(')) continue
      const rule = SECRET_ARGS.get(t.text.toLowerCase())
      if (!rule) continue
      const engineClause =
        isWord(code[ci - 1], 'ENGINE') ||
        (isPunct(code[ci - 1], '=') && isWord(code[ci - 2], 'ENGINE'))
      const call = callArgs(code, ci + 1, match)
      for (const index of rule(call.args, { databaseEngine: databaseStatement && engineClause })) {
        const range = call.ranges[index]
        if (range) ranges.push(range)
      }
    }
    ranges.sort((a, b) => a[0] - b[0])
    let reach = 0
    for (const [from, to] of ranges) {
      for (let k = Math.max(from, reach); k < to; k++)
        if (code[k].type === 'string') maskLiteral(k, k)
      reach = Math.max(reach, to)
    }
  }

  // Contents of the strings, quoted identifiers and comments no rule masked as a whole.
  values.sort((a, b) => a.start - b.start)
  const replacements = [...values]
  let v = 0
  for (const token of tokens) {
    if (token.type !== 'string' && token.type !== 'quoted_identifier' && token.type !== 'comment')
      continue
    while (v < values.length && values[v].end <= token.start) v++
    if (v < values.length && values[v].start < token.end) continue
    const closed = !(token.start === unterminatedAt && token.end === text.length)
    const original =
      lexText === text ? token : { ...token, text: text.slice(token.start, token.end) }
    const rewritten = maskTokenContent(original, closed, context, depth)
    if (rewritten !== null)
      replacements.push({ start: token.start, end: token.end, text: rewritten })
  }
  return applyReplacements(text, replacements)
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

/** Text without any of these (or a ClickHouse secret call) needs no token pass. */
const TOKEN_PASS_HINT =
  /passw|identified|secret_access_key|account_?key|session_token|pwd|sharedaccesssignature/i

// Presigned S3 / GCS URLs, Azure SAS.
const SIGNED_URL_PARAM =
  /([?&](?:sig|signature|token|access_token|X-Amz-Signature|X-Amz-Security-Token|X-Goog-Signature)=)[^&\s'"#();,]+/gi

/**
 * MySQL / MariaDB syntax errors echo the rest of the statement inside quotes that are not
 * escaped (`… near 'IDENTIFIED BY 'x'' at line 1`), which no lexer reads as the statement: the
 * echo is masked as SQL on its own.
 */
function maskErrorEcho(text: string, context: MaskContext): string {
  const open = text.indexOf("near '")
  if (open < 0) return text
  const from = open + "near '".length
  const to = text.lastIndexOf("' at line ")
  if (to < from) return text
  const echo = text.slice(from, to)
  const masked = maskCode(echo, context, 1)
  return masked === echo ? text : text.slice(0, from) + masked + text.slice(to)
}

/**
 * The lexer for text of unknown dialect. ClickHouse's rules are the widest net: backslash and
 * doubled-quote escapes, `--` comments, nested comments and dollar quotes. Its `{name:Type}`
 * parameter check looks ahead for a `}`, so text with very many `{` uses MySQL's rules instead.
 */
function genericDialect(text: string): SqlDialect {
  let braces = 0
  for (let i = text.indexOf('{'); i >= 0; i = text.indexOf('{', i + 1))
    if (++braces > 256) return 'mysql'
  return 'clickhouse'
}

// The renderer re-masks every SQL draft (text and baseline of each tab) on each persist, and
// most of them have not changed: the latest results for large texts are kept (least recently
// used first out), per dialect.
const MEMO_MIN_LENGTH = 4_096
const MEMO_MAX_LENGTH = 1_000_000
const MEMO_SIZE = 32
const memo = new Map<string, string>()
const memoKey = (text: string, dialect: SqlDialect | undefined): string =>
  `${dialect ?? 'generic'}\u0000${text}`

/**
 * Replaces credential literals in `text` with '***'. `dialect` is the engine's SQL dialect when
 * known (history, the assistant); without it (persisted drafts) the text is read with the
 * widest rules. Never throws; linear in the input.
 */
export function maskSqlSecrets(text: string, dialect?: SqlDialect): string {
  if (!text) return text
  if (!(TOKEN_PASS_HINT.test(text) || SECRET_CALL.test(text)))
    return maskUrlCredentials(text).replace(SIGNED_URL_PARAM, '$1***')
  const memoized = text.length >= MEMO_MIN_LENGTH && text.length <= MEMO_MAX_LENGTH
  const key = memoized ? memoKey(text, dialect) : ''
  const known = memoized ? memo.get(key) : undefined
  if (known !== undefined) {
    memo.delete(key)
    memo.set(key, known)
    return known
  }
  const context: MaskContext = {
    dialect: dialect ?? genericDialect(text),
    generic: dialect === undefined
  }
  const out = maskUrlCredentials(maskCode(maskErrorEcho(text, context), context, 0)).replace(
    SIGNED_URL_PARAM,
    '$1***'
  )
  if (memoized) {
    if (memo.size >= MEMO_SIZE) memo.delete(memo.keys().next().value as string)
    memo.set(key, out)
  }
  return out
}

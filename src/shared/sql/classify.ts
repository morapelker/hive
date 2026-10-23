// Read/write classification of ONE SQL statement for the safety gate (server, authoritative) and
// the editor's READ/WRITE badge (renderer, advisory). Rules: research/safety.md §A3–A7.
//
// The classifier is deliberately conservative: anything it cannot be sure about is 'unknown',
// which the gate treats like a write (confirmation / refusal), never like a read:
// - lexer errors (unterminated string/comment/dollar quote), unbalanced parentheses, a second
//   statement inside the text (including `;` inside a MySQL executable comment), an unknown
//   leading keyword, and MySQL text whose meaning depends on NO_BACKSLASH_ESCAPES;
// - a "read" is only a statement led by SELECT/VALUES/TABLE/SHOW/DESCRIBE/EXPLAIN/... that also
//   passes: (2) a deny-scan at ANY depth for INSERT/UPDATE/DELETE/MERGE/REPLACE/TRUNCATE/DROP/
//   CREATE/ALTER/GRANT/REVOKE and INTO OUTFILE/DUMPFILE (catches PG data-modifying CTEs);
//   (3) no INTO at the top level (PG SELECT INTO creates a table) and no FOR UPDATE/SHARE /
//   LOCK IN SHARE MODE (→ 'lock'); (4) no call to a side-effect function of the dialect's
//   denylist (pg_terminate_backend, SLEEP, ClickHouse url()/executable(), load_extension, ...).
//   User-defined functions cannot be judged here; the DB-level read-only sandbox catches them.
// - MySQL `/*! … */` executable comments are code (the lexer exposes their contents), so
//   `SELECT 1 /*! , (DROP TABLE t) */` is not a read.
//
// `dangerous` lists red warnings shown in every safe mode (DROP, TRUNCATE, DELETE/UPDATE without
// WHERE or with an always-true WHERE, ALTER … DROP/RENAME, ClickHouse mutations, KILL, SYSTEM,
// GRANT/REVOKE ALL, COPY … PROGRAM, SET GLOBAL, FLUSH/RESET/PURGE, dangerous functions).
// `destructiveTarget` names the object a production run must type to confirm (DROP/TRUNCATE/
// DELETE|UPDATE without WHERE); `targetTables` is a best-effort list for the confirm dialog.

import type { DataStatementClass, SqlDialect } from '../data-projects/types'
import {
  isSqlTrivia,
  isSqlWord,
  lexSql,
  type SqlLexError,
  type SqlLexOptions,
  type SqlToken,
  type SqlTokenType
} from './lexer'
import { splitLexedSqlStatements } from './splitter'

export interface SqlClassification {
  classification: DataStatementClass
  /** First keyword of the statement as written (WITH, EXPLAIN, SELECT, ...), upper-case. */
  leadingKeyword: string | null
  /** Red warnings, human-readable ("DELETE without WHERE removes every row of orders"). */
  dangerous: string[]
  /** Why the statement is not a plain read, most specific first. Empty for plain reads. */
  reasons: string[]
  /** Hint: the statement produces a result set (drivers should still trust protocol metadata). */
  returnsRows: boolean
  /** A LIMIT / FETCH FIRST (or ClickHouse TOP) bounds the top-level result. */
  hasLimitClause: boolean
  /** Best-effort names of the tables/objects the statement changes (unquoted, dot-qualified). */
  targetTables: string[]
  /**
   * The object the user must type to confirm on production: set for DROP, TRUNCATE and
   * DELETE/UPDATE without (or with an always-true) WHERE; null otherwise.
   */
  destructiveTarget: string | null
}

/** Options: `backslashEscapes` as in SqlLexOptions (pass the MySQL session's real mode). */
export type SqlClassifyOptions = SqlLexOptions

export interface SqlStatementAnalysis {
  classification: SqlClassification
  /** The keyword the class comes from: SELECT for `WITH … SELECT` and `EXPLAIN ANALYZE SELECT`. */
  mainKeyword: string | null
  /** Upper-cased words at the top level of the (unwrapped) statement. */
  topLevelWords: string[]
  /** End offset of the last code token (before trailing comments/delimiters); -1 when none. */
  codeEnd: number
  lexError: SqlLexError | null
  multipleStatements: boolean
}

// ---------------------------------------------------------------------------------------------
// Significant tokens
// ---------------------------------------------------------------------------------------------

interface Sig {
  type: SqlTokenType
  text: string
  start: number
  end: number
  /** Upper-cased bare word, null for anything else. */
  word: string | null
  /** Parenthesis depth: '(' and ')' carry the depth OUTSIDE them. */
  depth: number
}

const SEVERITY: Readonly<Record<DataStatementClass, number>> = {
  read: 0,
  session: 1,
  tx: 2,
  lock: 3,
  write: 4,
  ddl: 5,
  admin: 6,
  unknown: 7
}
const worse = (a: DataStatementClass, b: DataStatementClass): DataStatementClass =>
  SEVERITY[b] > SEVERITY[a] ? b : a

const CLASS_REASON: Readonly<Record<DataStatementClass, string>> = {
  read: '',
  session: 'changes session state',
  tx: 'transaction control',
  lock: 'takes locks',
  write: 'modifies data',
  ddl: 'changes the schema',
  admin: 'administrative command',
  unknown: 'unrecognised statement'
}

function toSigs(tokens: SqlToken[]): {
  sigs: Sig[]
  unbalanced: boolean
  /** A delimiter inside a MySQL executable comment (`SELECT 1 /*! ; DROP TABLE t *\/`). */
  hiddenDelimiter: boolean
} {
  const sigs: Sig[] = []
  let depth = 0
  let unbalanced = false
  let execDepth = 0
  let hiddenDelimiter = false
  for (const t of tokens) {
    if (t.type === 'executable_comment') {
      execDepth = Math.max(0, execDepth + (t.text.startsWith('/*') ? 1 : -1))
      continue
    }
    if (isSqlTrivia(t)) continue
    if (t.type === 'delimiter' && t.upper === 'DELIMITER') continue
    if (t.type === 'delimiter' && execDepth > 0) hiddenDelimiter = true
    const word = isSqlWord(t) ? (t.upper as string) : null
    const base = { type: t.type, text: t.text, start: t.start, end: t.end, word }
    if (t.type === 'punctuation' && t.text === '(') {
      sigs.push({ ...base, depth })
      depth++
    } else if (t.type === 'punctuation' && t.text === ')') {
      depth--
      if (depth < 0) {
        unbalanced = true
        depth = 0
      }
      sigs.push({ ...base, depth })
    } else sigs.push({ ...base, depth })
  }
  if (depth !== 0) unbalanced = true
  return { sigs, unbalanced, hiddenDelimiter }
}

/** Keywords upper-cased, names as typed (for human-readable warnings). */
const display = (s: Sig): string => (s.type === 'keyword' && s.word ? s.word : s.text)

const isPunct = (s: Sig | undefined, ch: string): boolean =>
  !!s && s.type === 'punctuation' && s.text === ch

/** Index of the ')' closing the '(' at `k` (same depth), or -1. */
function matchParen(sigs: Sig[], k: number): number {
  const d = sigs[k]?.depth ?? 0
  for (let j = k + 1; j < sigs.length; j++) {
    const s = sigs[j] as Sig
    if (isPunct(s, ')') && s.depth === d) return j
  }
  return -1
}

/** `(SELECT …)` → `SELECT …` (repeatedly), keeping original offsets. */
function unwrap(sigs: Sig[]): Sig[] {
  let out = sigs
  while (out.length >= 2 && isPunct(out[0], '(') && matchParen(out, 0) === out.length - 1) {
    out = out.slice(1, -1).map((s) => ({ ...s, depth: s.depth - 1 }))
  }
  return out
}

/** Strips the quotes of a quoted identifier (`a``b` → a`b, "x""y" → x"y, [n] → n). */
export function unquoteSqlIdentifier(text: string): string {
  if (text.length < 2) return text
  let body = text
  if (/^U&"/i.test(body)) body = body.slice(2)
  const open = body[0]
  const close = open === '[' ? ']' : open
  if ((open === '`' || open === '"' || open === '[') && body.endsWith(close as string)) {
    const inner = body.slice(1, -1)
    return open === '[' ? inner : inner.split(`${open}${open}`).join(open)
  }
  return text
}

const NAME_STOP_WORDS: ReadonlySet<string> = new Set([
  'WHERE',
  'SET',
  'VALUES',
  'SELECT',
  'FROM',
  'USING',
  'JOIN',
  'ON',
  'AS',
  'DEFAULT',
  'TO',
  'WITH',
  'CASCADE',
  'RESTRICT',
  'RETURNING',
  'ORDER',
  'LIMIT',
  'PARTITION',
  'SYNC',
  'PERMANENTLY',
  'FORMAT',
  'SETTINGS'
])

/** A dotted name starting at `k`: `db`.`t`, public.orders, "Weird""Name". */
function readName(sigs: Sig[], k: number): { name: string; next: number } | null {
  const parts: string[] = []
  let j = k
  while (j < sigs.length) {
    const s = sigs[j] as Sig
    if (s.word !== null && (parts.length > 0 || !NAME_STOP_WORDS.has(s.word))) parts.push(s.text)
    else if (s.type === 'quoted_identifier') parts.push(unquoteSqlIdentifier(s.text))
    else break
    j++
    if (
      isPunct(sigs[j], '.') &&
      sigs[j + 1] &&
      (sigs[j + 1]?.word !== null || sigs[j + 1]?.type === 'quoted_identifier')
    ) {
      j++
      continue
    }
    break
  }
  return parts.length > 0 ? { name: parts.join('.'), next: j } : null
}

/** Names separated by commas starting at `k` (skips a trailing `*` of PG `ONLY t *`). */
function readNameList(sigs: Sig[], k: number): { names: string[]; next: number } {
  const names: string[] = []
  let j = k
  for (;;) {
    const r = readName(sigs, j)
    if (!r) break
    names.push(r.name)
    j = r.next
    if (sigs[j]?.text === '*') j++
    if (isPunct(sigs[j], ',')) {
      j++
      continue
    }
    break
  }
  return { names, next: j }
}

// ---------------------------------------------------------------------------------------------
// Dialect tables
// ---------------------------------------------------------------------------------------------

const DENY_WORDS: Readonly<Record<string, DataStatementClass>> = {
  INSERT: 'write',
  UPDATE: 'write',
  DELETE: 'write',
  MERGE: 'write',
  REPLACE: 'write',
  UPSERT: 'write',
  TRUNCATE: 'ddl',
  DROP: 'ddl',
  CREATE: 'ddl',
  ALTER: 'ddl',
  GRANT: 'admin',
  REVOKE: 'admin'
}

interface DeniedFunction {
  test: RegExp
  cls: 'write' | 'admin'
  dangerous?: boolean
}

const DENIED_FUNCTIONS: Readonly<Record<SqlDialect, readonly DeniedFunction[]>> = {
  postgres: [
    { test: /^pg_(terminate|cancel)_backend$/, cls: 'admin', dangerous: true },
    { test: /^pg_reload_conf$/, cls: 'admin', dangerous: true },
    { test: /^pg_rotate_logfile/, cls: 'admin' },
    { test: /^pg_switch_(wal|xlog)$/, cls: 'admin', dangerous: true },
    { test: /^pg_promote$/, cls: 'admin', dangerous: true },
    { test: /^pg_create_restore_point$/, cls: 'admin' },
    { test: /^pg_(try_)?advisory_/, cls: 'write' },
    { test: /^set_config$/, cls: 'write' },
    { test: /^(nextval|setval)$/, cls: 'write' },
    { test: /^lo_/, cls: 'write' },
    { test: /^dblink/, cls: 'write' },
    { test: /^pg_file_/, cls: 'admin', dangerous: true },
    { test: /^pg_logical_slot_get_(binary_)?changes$/, cls: 'admin', dangerous: true },
    { test: /^pg_.*replication_slot/, cls: 'admin', dangerous: true },
    { test: /^pg_replication_origin_/, cls: 'admin' },
    { test: /^pg_stat_reset/, cls: 'admin', dangerous: true },
    { test: /^pg_notify$/, cls: 'write' },
    { test: /^pg_sleep/, cls: 'write' },
    {
      test: /^(query_to_xml|query_to_xml_and_xmlschema|query_to_xmlschema|cursor_to_xml|cursor_to_xmlschema)$/,
      cls: 'write'
    },
    { test: /^(pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file)$/, cls: 'admin' },
    { test: /^pg_ls_/, cls: 'admin' }
  ],
  mysql: [
    { test: /^(sleep|benchmark)$/, cls: 'write' },
    { test: /^(get_lock|release_lock|release_all_locks)$/, cls: 'write' },
    { test: /^load_file$/, cls: 'admin' },
    {
      test: /^(master_pos_wait|source_pos_wait|wait_for_executed_gtid_set|wait_until_sql_thread_after_gtids)$/,
      cls: 'write'
    }
  ],
  mariadb: [
    { test: /^(sleep|benchmark)$/, cls: 'write' },
    { test: /^(get_lock|release_lock|release_all_locks)$/, cls: 'write' },
    { test: /^load_file$/, cls: 'admin' },
    { test: /^(master_pos_wait|master_gtid_wait|source_pos_wait)$/, cls: 'write' }
  ],
  clickhouse: [
    { test: /^(sleep|sleepeachrow)$/, cls: 'write' },
    { test: /^executable(pool)?$/, cls: 'admin', dangerous: true },
    {
      test: /^(url|urlcluster|s3|s3cluster|s3queue|gcs|file|filecluster|remote|remotesecure|cluster|clusterallreplicas|mysql|postgresql|jdbc|odbc|hdfs|hdfscluster|azureblobstorage|azureblobstoragecluster|input|mongodb|redis|sqlite|deltalake|iceberg|hudi)$/,
      cls: 'admin'
    }
  ],
  sqlite: [
    { test: /^load_extension$/, cls: 'admin', dangerous: true },
    { test: /^fts3_tokenizer$/, cls: 'admin' },
    { test: /^(writefile|edit)$/, cls: 'write' },
    { test: /^readfile$/, cls: 'admin' }
  ]
}

const PRAGMA_READ: ReadonlySet<string> = new Set([
  'table_info',
  'table_xinfo',
  'index_list',
  'index_info',
  'index_xinfo',
  'foreign_key_list',
  'database_list',
  'table_list',
  'collation_list',
  'function_list',
  'pragma_list',
  'compile_options',
  'module_list',
  'foreign_key_check',
  'integrity_check',
  'quick_check',
  'user_version',
  'schema_version',
  'data_version',
  'application_id',
  'freelist_count',
  'page_count',
  'page_size',
  'encoding',
  'foreign_keys'
])

const SET_SESSION_ALLOW: ReadonlySet<string> = new Set([
  'search_path',
  'timezone',
  'time_zone',
  'session_timezone',
  'names',
  'client_encoding',
  'statement_timeout',
  'lock_timeout',
  'idle_in_transaction_session_timeout',
  'application_name',
  'datestyle',
  'intervalstyle',
  'extra_float_digits',
  'client_min_messages',
  'bytea_output',
  'max_execution_time',
  'max_statement_time',
  'group_concat_max_len',
  'sql_select_limit',
  'innodb_lock_wait_timeout',
  'lock_wait_timeout',
  'net_read_timeout',
  'net_write_timeout',
  'wait_timeout',
  'interactive_timeout',
  'collation_connection',
  'character_set_client',
  'character_set_connection',
  'character_set_results',
  'lc_time_names',
  'lc_messages',
  'div_precision_increment',
  'cte_max_recursion_depth',
  'work_mem',
  'max_threads',
  'max_result_rows',
  'result_overflow_mode',
  'max_block_size',
  'send_logs_level',
  'join_use_nulls',
  'max_memory_usage',
  'output_format_json_quote_64bit_integers'
])
const SET_TX: ReadonlySet<string> = new Set([
  'autocommit',
  'transaction_isolation',
  'tx_isolation',
  'default_transaction_isolation'
])
// Settings that weaken checks or change how SQL is parsed: always confirm, as admin.
const SET_SENSITIVE =
  /read_?only|^session_replication_role$|^foreign_key_checks$|^unique_checks$|^sql_safe_updates$|^sql_log_bin$|^sql_mode$|^role$|^session_authorization$|^allow_|^check_function_bodies$|^row_security$/

const EXPLAINABLE: ReadonlySet<string> = new Set([
  'SELECT',
  'WITH',
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'REPLACE',
  'UPSERT',
  'VALUES',
  'TABLE',
  'CREATE',
  'EXECUTE',
  'DECLARE'
])
const WITH_MAIN: ReadonlySet<string> = new Set([
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'REPLACE',
  'VALUES',
  'TABLE'
])
const DML_WORDS: ReadonlySet<string> = new Set([
  'INSERT',
  'REPLACE',
  'UPSERT',
  'MERGE',
  'UPDATE',
  'DELETE'
])
// A DML word after one of these is part of another construct (FOR UPDATE, ON DUPLICATE KEY
// UPDATE, ON CONFLICT DO UPDATE, ON DELETE CASCADE, AFTER INSERT, MERGE … THEN DELETE,
// CREATE OR REPLACE, INSTEAD OF, an alias).
const DML_NOT_AFTER: ReadonlySet<string> = new Set([
  'FOR',
  'KEY',
  'DO',
  'ON',
  'AFTER',
  'BEFORE',
  'OF',
  'THEN',
  'AS',
  'OR',
  'INSTEAD',
  'GRANT',
  'REVOKE'
])
const ALTER_ACTIONS: ReadonlySet<string> = new Set(
  (
    'ADD DROP MODIFY ALTER RENAME CHANGE CLEAR MATERIALIZE ATTACH DETACH FREEZE UNFREEZE MOVE ' +
    'REPLACE FETCH COMMENT REMOVE RESET CONVERT OWNER ENABLE DISABLE VALIDATE INHERIT'
  ).split(' ')
)
const DROP_KIND_WORDS: ReadonlySet<string> = new Set(
  (
    'TABLE TABLES VIEW MATERIALIZED DATABASE SCHEMA INDEX SEQUENCE FUNCTION PROCEDURE TRIGGER USER ROLE ' +
    'TYPE EVENT DICTIONARY TEMPORARY TEMP FOREIGN EXTENSION DOMAIN POLICY RULE SERVER PUBLICATION ' +
    'SUBSCRIPTION AGGREGATE OPERATOR COLLATION CONVERSION LANGUAGE ACCESS METHOD STATISTICS TABLESPACE ' +
    'ROUTINE CAST SPATIAL FULLTEXT UNIQUE ONLINE OFFLINE NAMED COLLECTION QUOTA PROFILE SETTINGS ROW ' +
    'MASKING PARTITION PART DETACHED LIVE WINDOW DATA WRAPPER TEXT SEARCH CONFIGURATION PARSER TEMPLATE ' +
    'OWNED BY CONCURRENTLY LOGFILE GROUP RESOURCE SYNONYM PACKAGE BODY'
  ).split(' ')
)

// ---------------------------------------------------------------------------------------------
// Base classification by leading keyword
// ---------------------------------------------------------------------------------------------

interface Base {
  cls: DataStatementClass
  reasons: string[]
  dangerous: string[]
  returnsRows: boolean
  /** Index of the main statement keyword in `sigs`. */
  main: number
  /** 'full' = deny-scan + function denylist; 'functions' = denylist only; 'none' = not executed. */
  scan: 'full' | 'functions' | 'none'
  targets: string[]
  destructiveTarget: string | null
}

interface Ctx {
  dialect: SqlDialect
  sigs: Sig[]
}

const isMy = (d: SqlDialect): boolean => d === 'mysql' || d === 'mariadb'

function base(ctx: Ctx, k: number): Base {
  const { sigs, dialect } = ctx
  const word = (j: number): string | null => sigs[j]?.word ?? null
  const make = (
    cls: DataStatementClass,
    reasons: string[] = [],
    extra: Partial<Base> = {}
  ): Base => ({
    cls,
    reasons: reasons.length === 0 && CLASS_REASON[cls] ? [CLASS_REASON[cls]] : reasons,
    dangerous: [],
    returnsRows: false,
    main: k,
    scan: 'full',
    targets: [],
    destructiveTarget: null,
    ...extra
  })
  const w = word(k)
  if (!w) return make('unknown', ['does not start with a SQL keyword'])

  switch (w) {
    case 'SELECT':
    case 'VALUES':
    case 'TABLE':
      return make('read', [], { returnsRows: true })

    case 'WITH': {
      const d0 = sigs[k]?.depth ?? 0
      for (let j = k + 1; j < sigs.length; j++) {
        const s = sigs[j] as Sig
        if (s.depth !== d0 || !s.word || !WITH_MAIN.has(s.word)) continue
        if (isPunct(sigs[j + 1], '(') || isPunct(sigs[j - 1], '.')) continue
        return base(ctx, j)
      }
      return make('unknown', ['no statement follows the WITH clause'])
    }

    case 'SHOW':
      return make('read', [], { returnsRows: true, scan: 'functions' })
    case 'HELP':
      return isMy(dialect) ? make('read', [], { returnsRows: true, scan: 'none' }) : make('unknown')
    case 'CHECKSUM':
      return isMy(dialect) ? make('read', [], { returnsRows: true, scan: 'none' }) : make('unknown')
    case 'CHECK':
      return dialect === 'clickhouse'
        ? make('read', [], { returnsRows: true, scan: 'none' })
        : make('admin', ['checks tables (may mark them for repair)'], {
            returnsRows: isMy(dialect)
          })
    case 'EXISTS':
      return dialect === 'clickhouse'
        ? make('read', [], { returnsRows: true, scan: 'none' })
        : make('unknown')

    case 'EXPLAIN':
    case 'DESCRIBE':
    case 'DESC': {
      const d0 = sigs[k]?.depth ?? 0
      let analyze = false
      let j = k + 1
      for (; j < sigs.length; j++) {
        const s = sigs[j] as Sig
        if (s.depth === d0 && s.word && EXPLAINABLE.has(s.word)) break
        // PG option names may be quoted ("analyze") or U&-escaped and still switch ANALYZE on.
        const quotedOption =
          s.type === 'quoted_identifier' &&
          s.depth === d0 + 1 &&
          (isPunct(sigs[j - 1], '(') || isPunct(sigs[j - 1], ',')) &&
          (/^u&/i.test(s.text) || /^analy[sz]e$/i.test(unquoteSqlIdentifier(s.text)))
        if (s.word === 'ANALYZE' || s.word === 'ANALYSE' || quotedOption) {
          if (s.depth === d0) analyze = true
          else if (s.depth === d0 + 1) {
            // PG option list: (ANALYZE [boolean], …) — only an explicit false keeps it a plan.
            const v = sigs[j + 1]
            const off =
              !!v &&
              v.depth === d0 + 1 &&
              ((v.word !== null && ['FALSE', 'OFF', 'NO'].includes(v.word)) ||
                v.text === '0' ||
                (v.type === 'string' && /^'(false|off|no|0)'$/i.test(v.text)))
            if (!off) analyze = true
          }
        }
      }
      if (j >= sigs.length || !analyze) {
        // A plan is not executed, but scan for side-effect calls anyway: an option spelling the
        // loop above missed must never hide pg_terminate_backend() and friends.
        return make('read', [], {
          returnsRows: true,
          scan: 'functions',
          main: j < sigs.length ? j : k
        })
      }
      const inner = base(ctx, j)
      return {
        ...inner,
        reasons:
          inner.cls === 'read'
            ? inner.reasons
            : [`${w} ANALYZE runs the statement`, ...inner.reasons],
        returnsRows: true
      }
    }

    case 'ANALYZE':
    case 'ANALYSE': {
      if (dialect === 'mariadb' || dialect === 'mysql') {
        let j = k + 1
        if (word(j) === 'FORMAT') j += sigs[j + 1]?.text === '=' ? 3 : 2
        const inner = word(j)
        if (inner && ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'WITH'].includes(inner)) {
          const b = base(ctx, j)
          return {
            ...b,
            reasons: b.cls === 'read' ? b.reasons : ['ANALYZE runs the statement', ...b.reasons],
            returnsRows: true
          }
        }
      }
      return make('admin', ['updates table statistics'], { returnsRows: isMy(dialect) })
    }

    case 'PRAGMA': {
      if (dialect !== 'sqlite') return make('unknown')
      let j = k + 1
      if (isPunct(sigs[j + 1], '.')) j += 2
      const name = (sigs[j]?.word ?? sigs[j]?.text ?? '').toLowerCase()
      const assigns = sigs.slice(k).some((s) => s.type === 'operator' && s.text === '=')
      if (!assigns && PRAGMA_READ.has(name))
        return make('read', [], { returnsRows: true, scan: 'none' })
      return make(
        'write',
        [
          assigns
            ? `PRAGMA ${name} = … changes a database setting`
            : `PRAGMA ${name || '?'} is not on the read-only allowlist`
        ],
        { returnsRows: !assigns, scan: 'none' }
      )
    }

    case 'USE':
      return make('session', [], { scan: 'none' })
    case 'SET':
      return setStatement(ctx, k, make)
    case 'RESET': {
      if (isMy(dialect)) {
        const what = sigs
          .slice(k + 1)
          .map((s) => s.text)
          .join(' ')
        return make('admin', [], {
          dangerous: [`RESET ${what} has a server-wide effect`.replace(/\s+has/, ' has')],
          scan: 'none'
        })
      }
      if (dialect === 'postgres') {
        const name = (word(k + 1) ?? '').toLowerCase()
        if (name === 'all' || SET_SESSION_ALLOW.has(name) || name === 'time')
          return make('session', [], { scan: 'none' })
        if (name === 'role' || name === 'session')
          return make('admin', ['changes the active role'], { scan: 'none' })
      }
      return make('unknown')
    }

    case 'BEGIN': {
      if (isMy(dialect) && word(k + 1) === 'NOT' && word(k + 2) === 'ATOMIC')
        return make('write', ['runs an anonymous compound statement'])
      if (dialect === 'sqlite' && (word(k + 1) === 'IMMEDIATE' || word(k + 1) === 'EXCLUSIVE'))
        return make('lock', [`BEGIN ${word(k + 1)} takes a write lock on the database`])
      return make('tx', [], { scan: 'none' })
    }
    case 'START':
      return word(k + 1) === 'TRANSACTION'
        ? make('tx', [], { scan: 'none' })
        : make('admin', [`START ${word(k + 1) ?? ''}`.trim() + ' controls replication'], {
            scan: 'none'
          })
    case 'COMMIT':
    case 'ROLLBACK':
      if (dialect === 'postgres' && word(k + 1) === 'PREPARED')
        return make('admin', [`${w} PREPARED finishes another session's prepared transaction`])
      return make('tx', [], { scan: 'none' })
    case 'SAVEPOINT':
    case 'RELEASE':
    case 'END':
    case 'ABORT':
      return make('tx', [], { scan: 'none' })
    case 'PREPARE':
      if (dialect === 'postgres' && word(k + 1) === 'TRANSACTION')
        return make('tx', [], { scan: 'none' })
      return make('session', ['only prepares a statement; running it asks again'], { scan: 'none' })
    case 'DISCARD':
      // DISCARD PLANS only drops cached plans; ALL/TEMP/SEQUENCES drop session state (temporary
      // tables, prepared statements, settings), which safety.md files under writes.
      if (word(k + 1) === 'PLANS') return make('session', [], { scan: 'none' })
      return make('write', [`DISCARD ${word(k + 1) ?? ''}`.trim() + ' drops session state'], {
        scan: 'none'
      })
    case 'DEALLOCATE':
    case 'CLOSE':
    case 'LISTEN':
    case 'UNLISTEN':
      return make('session', [], { scan: 'none' })
    case 'NOTIFY':
      return make('write', ['sends a notification to other sessions'])
    case 'EXECUTE':
      return make('write', ['executes a prepared statement or dynamic SQL'])
    case 'CALL':
      return make('write', ['calls a stored procedure'])
    case 'DO':
      return make('write', ['runs code on the server for its side effects'])
    case 'DECLARE': {
      if (dialect !== 'postgres') return make('unknown')
      const forIdx = sigs.findIndex(
        (s, j) => j > k && s.word === 'FOR' && s.depth === sigs[k]?.depth
      )
      if (forIdx < 0) return make('unknown')
      const inner = base(ctx, forIdx + 1)
      return inner.cls === 'read'
        ? make('read', [], { main: forIdx + 1 })
        : { ...inner, reasons: ['declares a cursor over a non-read statement', ...inner.reasons] }
    }
    case 'FETCH':
    case 'MOVE':
      if (dialect === 'postgres')
        return make('read', [], { returnsRows: w === 'FETCH', scan: 'none' })
      return make(dialect === 'clickhouse' ? 'admin' : 'unknown')

    case 'INSERT':
    case 'REPLACE':
    case 'UPSERT':
    case 'MERGE':
    case 'UPDATE':
    case 'DELETE':
      return make('write', [`modifies data (${w})`])
    case 'LOAD':
      return word(k + 1) === 'DATA' || word(k + 1) === 'XML'
        ? make('write', ['loads rows from a file'], { targets: loadTargets(sigs, k) })
        : make('admin', [`LOAD ${word(k + 1) ?? ''}`.trim()])
    case 'COPY':
      return copyStatement(ctx, k, make)

    case 'TRUNCATE': {
      let j = k + 1
      let kind = 'TABLE'
      if (word(j) === 'TABLE') j++
      else if (word(j) === 'DATABASE') {
        kind = 'DATABASE'
        j++
      }
      if (word(j) === 'IF' && word(j + 1) === 'EXISTS') j += 2
      if (word(j) === 'ONLY') j++
      const { names } = readNameList(sigs, j)
      const label = names.length > 0 ? names.join(', ') : kind.toLowerCase()
      return make('ddl', ['removes every row'], {
        dangerous: [
          kind === 'DATABASE'
            ? `TRUNCATE DATABASE ${label} removes every table's rows`
            : `TRUNCATE removes every row of ${label}`
        ],
        targets: names,
        destructiveTarget: names[0] ?? null
      })
    }
    case 'DROP':
      return dropStatement(ctx, k, make)
    case 'ALTER':
      return alterStatement(ctx, k, make)
    case 'CREATE': {
      let j = k + 1
      while (
        ['OR', 'REPLACE', 'TEMP', 'TEMPORARY', 'UNIQUE', 'GLOBAL', 'LOCAL', 'UNLOGGED'].includes(
          word(j) ?? ''
        )
      )
        j++
      const kind = word(j)
      if (kind === 'USER' || kind === 'ROLE' || kind === 'LOGIN')
        return make('admin', [`CREATE ${kind} manages accounts`], { scan: 'none' })
      let n = j + 1
      if (kind === 'MATERIALIZED' || kind === 'FOREIGN') n++
      if (word(n) === 'IF' && word(n + 1) === 'NOT' && word(n + 2) === 'EXISTS') n += 3
      const name =
        kind &&
        ['TABLE', 'VIEW', 'MATERIALIZED', 'DATABASE', 'SCHEMA', 'FOREIGN', 'DICTIONARY'].includes(
          kind
        )
          ? readName(sigs, n)
          : null
      return make('ddl', [], { scan: 'none', targets: name ? [name.name] : [] })
    }
    case 'RENAME': {
      const kind = word(k + 1) ?? ''
      const isAccount = kind === 'USER' || kind === 'ROLE'
      // RENAME TABLE a TO b, c TO d (the kind word is optional in some dialects).
      const kindWord = ['TABLE', 'TABLES', 'DATABASE', 'DICTIONARY', 'USER', 'ROLE'].includes(kind)
      let j = kindWord ? k + 2 : k + 1
      const names: string[] = []
      for (;;) {
        const r = readName(sigs, j)
        if (!r) break
        names.push(r.name)
        j = r.next
        if (word(j) !== 'TO') break
        const to = readName(sigs, j + 1)
        if (!to) break
        j = to.next
        if (!isPunct(sigs[j], ',')) break
        j++
      }
      return make(isAccount ? 'admin' : 'ddl', [], {
        dangerous: [
          `RENAME ${kind ? `${kind} ` : ''}${names.join(', ')} breaks everything that uses the old name`.replace(
            /\s+breaks/,
            ' breaks'
          )
        ],
        targets: names,
        scan: 'none'
      })
    }
    case 'COMMENT':
    case 'SECURITY':
    case 'IMPORT':
    case 'UNDROP':
    case 'EXCHANGE':
      return make('ddl', [], { scan: 'none' })
    case 'ATTACH':
    case 'DETACH':
      return make('ddl', [`${w} changes the attached databases or tables`], { scan: 'none' })

    case 'GRANT':
    case 'REVOKE': {
      const all =
        word(k + 1) === 'ALL' ||
        (word(k + 1) === 'GRANT' && word(k + 2) === 'OPTION' && word(k + 4) === 'ALL')
      return make('admin', ['changes privileges'], {
        dangerous: all ? [`${w} ALL PRIVILEGES`] : [],
        scan: 'none'
      })
    }
    case 'KILL': {
      const what = word(k + 1)
      const label =
        what === 'QUERY'
          ? 'KILL QUERY stops a running query'
          : what === 'MUTATION'
            ? 'KILL MUTATION stops a running mutation'
            : 'KILL terminates a server connection'
      return make('admin', ['terminates server work'], { dangerous: [label], scan: 'none' })
    }
    case 'SYSTEM': {
      const what = sigs
        .slice(k + 1, k + 4)
        .map(display)
        .join(' ')
      return make('admin', ['server-level command'], {
        dangerous: [`SYSTEM ${what} is a server-level command`.replace(/\s+is a/, ' is a')],
        scan: 'none'
      })
    }
    case 'FLUSH':
    case 'PURGE':
    case 'SHUTDOWN':
    case 'RESTART': {
      const what = sigs
        .slice(k + 1, k + 3)
        .map(display)
        .join(' ')
      return make('admin', [], {
        dangerous: [`${w}${what ? ` ${what}` : ''} has a server-wide effect`],
        scan: 'none'
      })
    }
    case 'OPTIMIZE': {
      const dedupe = sigs.some((s) => s.word === 'DEDUPLICATE')
      const t = word(k + 1) === 'TABLE' ? readName(sigs, k + 2) : null
      return make('admin', ['rebuilds or merges table data'], {
        returnsRows: isMy(dialect),
        dangerous:
          dialect === 'clickhouse' && dedupe
            ? [`OPTIMIZE … DEDUPLICATE removes duplicate rows${t ? ` of ${t.name}` : ''}`]
            : [],
        targets: t ? [t.name] : [],
        scan: 'none'
      })
    }
    case 'REFRESH':
      return make('write', ['recomputes a materialized view'], { scan: 'none' })
    case 'REPAIR':
    case 'VACUUM':
    case 'REINDEX':
    case 'CLUSTER':
    case 'CHECKPOINT':
    case 'INSTALL':
    case 'UNINSTALL':
    case 'CLONE':
    case 'BACKUP':
    case 'RESTORE':
    case 'XA':
    case 'CHANGE':
    case 'STOP':
    case 'CACHE':
    case 'HANDLER':
    case 'BINLOG':
      return make('admin', [], { returnsRows: w === 'REPAIR' && isMy(dialect), scan: 'none' })
    case 'LOCK':
    case 'UNLOCK':
      return make('lock', [], { scan: 'none' })
    default:
      return make('unknown', [`unrecognised statement ${w}`])
  }
}

type Make = (cls: DataStatementClass, reasons?: string[], extra?: Partial<Base>) => Base

/** Words in a MySQL/MariaDB SET value that read data or advance a sequence without a `(`. */
const SET_EVALUATING_WORDS: ReadonlySet<string> = new Set([
  'SELECT',
  'TABLE',
  'VALUES',
  'WITH',
  'NEXT',
  'PREVIOUS',
  'NEXTVAL',
  'LASTVAL',
  'SETVAL',
  'CURRVAL'
])
/** Words that are plain values or operators in a SET value. */
const SET_LITERAL_WORDS: ReadonlySet<string> = new Set([
  'NULL',
  'TRUE',
  'FALSE',
  'UNKNOWN',
  'DEFAULT',
  'ON',
  'OFF',
  'AND',
  'OR',
  'XOR',
  'NOT',
  'IS',
  'DIV',
  'MOD'
])

/**
 * Whether the value of one MySQL/MariaDB SET assignment (sigs[a, b)) may run anything: any
 * parenthesis (a call, a subquery, `(TABLE v)`, `(VALUES ROW(f()))`), a word that reads or
 * advances a sequence (`NEXT VALUE FOR s`, `s.nextval`), any dotted name, or, for a user
 * variable, any bare word that is not a literal (in Oracle mode a function runs without
 * parentheses). A system variable takes one bare word as a setting name (`time_zone = SYSTEM`).
 */
function setValueEvaluates(sigs: Sig[], a: number, b: number): boolean {
  let eq = a
  while (eq < b && !(sigs[eq].text === '=' || sigs[eq].text === ':=')) eq++
  if (eq >= b) return false
  const target = sigs[a].type === 'variable' ? sigs[a] : null
  const userVariable = target !== null && !target.text.startsWith('@@')
  let words = 0
  for (let q = eq + 1; q < b; q++) {
    const t = sigs[q]
    if (isPunct(t, '(')) return true
    if (t.word === null) continue
    if (SET_EVALUATING_WORDS.has(t.word) || isPunct(sigs[q - 1], '.')) return true
    if (SET_LITERAL_WORDS.has(t.word)) continue
    if (userVariable || ++words > 1) return true
  }
  return false
}

function setStatement(ctx: Ctx, k: number, make: Make): Base {
  const { sigs, dialect } = ctx
  const word = (j: number): string | null => sigs[j]?.word ?? null
  const w1 = word(k + 1)
  const w2 = word(k + 2)
  if (w1 === 'TRANSACTION' || w1 === 'CONSTRAINTS') return make('tx', [], { scan: 'none' })
  if (w1 === 'SESSION' && (w2 === 'CHARACTERISTICS' || w2 === 'TRANSACTION'))
    return make('tx', [], { scan: 'none' })
  if ((w1 === 'SESSION' || w1 === 'LOCAL') && w2 === 'AUTHORIZATION')
    return make('admin', ['changes the session user'], { scan: 'none' })
  if (w1 === 'GLOBAL' && w2 === 'TRANSACTION')
    return make('admin', [], {
      dangerous: ['SET GLOBAL TRANSACTION changes a server-wide default'],
      scan: 'none'
    })
  if (
    w1 === 'ROLE' ||
    (w1 === 'DEFAULT' && w2 === 'ROLE') ||
    ((w1 === 'SESSION' || w1 === 'LOCAL') && w2 === 'ROLE')
  )
    return make('admin', ['changes the active role'], { scan: 'none' })
  if (w1 === 'PASSWORD') return make('admin', ['changes a password'], { scan: 'none' })
  if (w1 === 'RESOURCE') return make('admin', ['changes the resource group'], { scan: 'none' })
  // MySQL/MariaDB accept more assignments after these (`SET NAMES utf8mb4, @x = f()`): the
  // list below checks every one.
  if (
    (w1 === 'NAMES' || w1 === 'CHARSET' || (w1 === 'CHARACTER' && w2 === 'SET') || w1 === 'XML') &&
    !isMy(dialect)
  )
    return make('session')
  if (w1 === 'TIME' && w2 === 'ZONE') return make('session')
  if ((w1 === 'SESSION' || w1 === 'LOCAL') && w2 === 'TIME' && word(k + 3) === 'ZONE')
    return make('session')
  if (w1 === 'SCHEMA' && dialect === 'postgres') return make('session')

  const d0 = sigs[k]?.depth ?? 0
  let end = sigs.length
  let inner: Base | null = null
  if (w1 === 'STATEMENT') {
    // MariaDB: SET STATEMENT var = value [, …] FOR <statement>
    const forIdx = sigs.findIndex((s, j) => j > k && s.depth === d0 && s.word === 'FOR')
    if (forIdx < 0) return make('unknown', ['SET STATEMENT without FOR'])
    inner = base(ctx, forIdx + 1)
    end = forIdx
  }

  // Assignment list: MySQL/MariaDB/ClickHouse separate assignments with top-level commas; in
  // PostgreSQL a comma separates the values of the one setting (`SET search_path TO a, b`).
  const segments: Array<[number, number]> = []
  let from = w1 === 'STATEMENT' ? k + 2 : k + 1
  for (let j = from; j < end && dialect !== 'postgres'; j++) {
    if (isPunct(sigs[j], ',') && (sigs[j] as Sig).depth === d0) {
      segments.push([from, j])
      from = j + 1
    }
  }
  segments.push([from, end])

  let cls: DataStatementClass = 'session'
  const reasons: string[] = []
  const dangerous: string[] = []
  // MySQL/MariaDB values are expressions: `SET @id = next_id()` runs a stored function that may
  // write, `SET @x = NEXT VALUE FOR s` advances a sequence, `SET @x = (TABLE v)` reads a view
  // whose function may write. Such a SET is reported as a read so it runs inside the read-only
  // sandbox, which turns a hidden write into a confirmation (session and user variables survive
  // the sandbox's ROLLBACK). (PostgreSQL and ClickHouse SET values are literals.)
  let evaluates = false
  for (const [a, b] of segments) {
    if (a >= b) {
      cls = worse(cls, 'unknown')
      continue
    }
    if (isMy(dialect)) {
      // SET NAMES / CHARSET / CHARACTER SET inside a list: a character set name, never evaluated.
      if (
        word(a) === 'NAMES' ||
        word(a) === 'CHARSET' ||
        (word(a) === 'CHARACTER' && word(a + 1) === 'SET')
      )
        continue
      if (setValueEvaluates(sigs, a, b)) evaluates = true
    }
    let j = a
    let global = false
    while (
      j < b &&
      ['GLOBAL', 'PERSIST', 'PERSIST_ONLY', 'SESSION', 'LOCAL'].includes(word(j) ?? '')
    ) {
      if (word(j) !== 'SESSION' && word(j) !== 'LOCAL') global = true
      j++
    }
    const s = sigs[j]
    let name = ''
    if (s?.type === 'variable') {
      if (!s.text.startsWith('@@')) continue // user variable: session-local
      const m = /^@@(?:(global|session|local|persist|persist_only)\.)?(.+)$/i.exec(s.text)
      if (m?.[1] && !['session', 'local'].includes(m[1].toLowerCase())) global = true
      name = (m?.[2] ?? '').toLowerCase()
    } else if (s?.word) {
      const parts: string[] = [s.text]
      let q = j + 1
      while (isPunct(sigs[q], '.') && sigs[q + 1]?.word) {
        parts.push((sigs[q + 1] as Sig).text)
        q += 2
      }
      name = parts.join('.').toLowerCase()
    } else {
      cls = worse(cls, 'unknown')
      reasons.push('could not read the SET target')
      continue
    }
    if (global) {
      cls = worse(cls, 'admin')
      dangerous.push(`SET GLOBAL ${name} changes a server-wide setting`)
    } else if (SET_TX.has(name)) cls = worse(cls, 'tx')
    else if (SET_SENSITIVE.test(name)) {
      cls = worse(cls, 'admin')
      reasons.push(`SET ${name} weakens a safety check or changes how SQL is parsed`)
    } else if (!SET_SESSION_ALLOW.has(name)) {
      cls = worse(cls, 'unknown')
      reasons.push(`SET ${name} is not a known harmless session setting`)
    }
  }
  if (evaluates && cls === 'session') {
    cls = 'read'
    reasons.push('evaluates an expression that may call a stored function')
  }
  if (inner) {
    // Harmless settings scoped to one statement leave that statement's own class.
    const combined = cls === 'session' ? inner.cls : worse(cls, inner.cls)
    return {
      ...inner,
      cls: combined,
      reasons: [...reasons, ...inner.reasons],
      dangerous: [...dangerous, ...inner.dangerous]
    }
  }
  return make(cls, reasons, { dangerous })
}

function copyStatement(ctx: Ctx, k: number, make: Make): Base {
  const { sigs, dialect } = ctx
  if (dialect !== 'postgres') return make('unknown')
  const d0 = sigs[k]?.depth ?? 0
  const target =
    sigs[k + 1]?.word || sigs[k + 1]?.type === 'quoted_identifier' ? readName(sigs, k + 1) : null
  const dirIdx = sigs.findIndex(
    (s, j) => j > k && s.depth === d0 && (s.word === 'TO' || s.word === 'FROM')
  )
  if (dirIdx < 0) return make('unknown', ['COPY without TO/FROM'])
  const dir = sigs[dirIdx]?.word
  const what = sigs[dirIdx + 1]
  const targets = target ? [target.name] : []
  if (what?.word === 'PROGRAM')
    return make('admin', ['runs a shell command on the database server'], {
      dangerous: ['COPY … PROGRAM runs a shell command on the database server'],
      targets
    })
  if (dir === 'TO') {
    if (what?.word === 'STDOUT') return make('read')
    return make('write', ['COPY … TO writes a file on the database server'], { targets })
  }
  return make('write', ['COPY … FROM loads rows into a table'], { targets })
}

function loadTargets(sigs: Sig[], k: number): string[] {
  const j = sigs.findIndex((s, i) => i > k && s.word === 'TABLE' && sigs[i - 1]?.word === 'INTO')
  const r = j >= 0 ? readName(sigs, j + 1) : null
  return r ? [r.name] : []
}

function dropStatement(ctx: Ctx, k: number, make: Make): Base {
  const { sigs } = ctx
  const word = (j: number): string | null => sigs[j]?.word ?? null
  if (word(k + 1) === 'PREPARE') return make('session', [], { scan: 'none' })
  let j = k + 1
  const kind: string[] = []
  while (j < sigs.length && DROP_KIND_WORDS.has(word(j) ?? '')) {
    kind.push(word(j) as string)
    j++
  }
  if (word(j) === 'IF' && word(j + 1) === 'EXISTS') j += 2
  const { names } = readNameList(sigs, j)
  const label = kind.filter((w) => w !== 'CONCURRENTLY').join(' ') || 'object'
  const isAccount = kind.includes('USER') || kind.includes('ROLE') || kind.includes('OWNED')
  return make(isAccount ? 'admin' : 'ddl', [`drops a ${label.toLowerCase()}`], {
    dangerous: [`DROP ${label}${names.length > 0 ? ` ${names.join(', ')}` : ''}`],
    targets: names,
    destructiveTarget: names[0] ?? null,
    scan: 'none'
  })
}

function alterStatement(ctx: Ctx, k: number, make: Make): Base {
  const { sigs, dialect } = ctx
  const word = (j: number): string | null => sigs[j]?.word ?? null
  let j = k + 1
  while (['ONLINE', 'IGNORE', 'OFFLINE'].includes(word(j) ?? '')) j++
  const kind = word(j) ?? ''
  if (kind === 'USER' || kind === 'ROLE' || kind === 'LOGIN')
    return make('admin', ['changes an account'], {
      dangerous: [`ALTER ${kind} changes credentials or privileges`],
      scan: 'none'
    })
  if (kind === 'SYSTEM')
    return make('admin', ['changes the server configuration'], {
      dangerous: ['ALTER SYSTEM changes the server configuration'],
      scan: 'none'
    })
  j++
  if (kind === 'MATERIALIZED' || kind === 'FOREIGN') j++
  if (word(j) === 'IF' && word(j + 1) === 'EXISTS') j += 2
  if (word(j) === 'ONLY') j++
  const nameRead = readName(sigs, j)
  const name = nameRead?.name ?? ''
  j = nameRead ? nameRead.next : j
  if (sigs[j]?.text === '*') j++
  const d0 = sigs[k]?.depth ?? 0
  if (word(j) === 'ON' && word(j + 1) === 'CLUSTER') {
    const c = readName(sigs, j + 2)
    j = c ? c.next : j + 2
  }
  // Action starts: the first token after the name and every token after a top-level comma.
  const starts = [j]
  for (let q = j; q < sigs.length; q++) {
    if (isPunct(sigs[q], ',') && (sigs[q] as Sig).depth === d0) starts.push(q + 1)
  }
  const dangerous: string[] = []
  let mutations = 0
  const subject = `ALTER ${kind}${name ? ` ${name}` : ''}`
  for (const a of starts) {
    const act = word(a)
    if (act === 'DROP') {
      const what = word(a + 1)
      if (what && ['DEFAULT', 'NOT', 'EXPRESSION', 'IDENTITY'].includes(what)) continue
      const objectWords = sigs
        .slice(a + 1, a + 4)
        .filter((s) => s.depth === d0 && !isPunct(s, ','))
        .map((s) => (s.type === 'quoted_identifier' ? unquoteSqlIdentifier(s.text) : s.text))
      dangerous.push(`${subject} drops ${objectWords.join(' ')}`.trim())
    } else if (act === 'RENAME') {
      dangerous.push(
        `${subject} renames ${word(a + 1) === 'TO' || word(a + 1) === 'AS' ? 'it' : (sigs[a + 1]?.text ?? '')}`.trim()
      )
    } else if (act === 'CHANGE' && (dialect === 'mysql' || dialect === 'mariadb')) {
      // `CHANGE [COLUMN] [IF EXISTS] old new <definition>` renames when the names differ, just
      // like RENAME COLUMN (column names compare without case).
      let b = a + 1
      if (word(b) === 'COLUMN') b++
      if (word(b) === 'IF' && word(b + 1) === 'EXISTS') b += 2
      const nameAt = (q: number): string | null => {
        const s = sigs[q]
        if (!s || s.depth !== d0) return null
        if (s.type === 'quoted_identifier') return unquoteSqlIdentifier(s.text)
        return s.word !== null ? s.text : null
      }
      const from = nameAt(b)
      const to = nameAt(b + 1)
      if (from !== null && to !== null && from.toLowerCase() !== to.toLowerCase())
        dangerous.push(`${subject} renames column ${from} to ${to}`)
    } else if (dialect === 'clickhouse' && (act === 'DELETE' || act === 'UPDATE')) {
      mutations++
      dangerous.push(
        `ClickHouse mutation ${subject} ${act} rewrites data asynchronously and cannot be undone`
      )
    } else if (dialect === 'clickhouse' && act === 'CLEAR') {
      dangerous.push(`${subject} clears ${(sigs[a + 1]?.text ?? '').toLowerCase()} data`.trim())
    }
  }
  // Only real action verbs count against "mutation only" (ClickHouse `UPDATE a = 1, b = 2`
  // has top-level commas inside one action).
  const otherActions = starts.filter((a) => ALTER_ACTIONS.has(word(a) ?? '')).length
  const mutationOnly = mutations > 0 && otherActions === 0
  return make(
    mutationOnly ? 'write' : 'ddl',
    mutationOnly ? ['ClickHouse mutation (rewrites data)'] : [],
    {
      dangerous,
      targets: name ? [name] : [],
      scan: 'none'
    }
  )
}

// ---------------------------------------------------------------------------------------------
// Constant-WHERE evaluation (DELETE … WHERE 1=1)
// ---------------------------------------------------------------------------------------------

type Lit = number | string | boolean | null
const CONSTANT_WORDS: ReadonlySet<string> = new Set([
  'TRUE',
  'FALSE',
  'NULL',
  'AND',
  'OR',
  'NOT',
  'IS'
])

/** 'always' (true), 'never' (false/NULL), 'constant' (no column but unevaluable), 'column'. */
function constantWhere(cond: Sig[]): 'always' | 'never' | 'constant' | 'column' {
  if (cond.length === 0) return 'column'
  for (const s of cond) {
    if (
      s.type === 'identifier' ||
      s.type === 'quoted_identifier' ||
      s.type === 'parameter' ||
      s.type === 'variable'
    )
      return 'column'
    if (s.word && !CONSTANT_WORDS.has(s.word)) return 'column'
  }
  let i = 0
  const peek = (): Sig | undefined => cond[i]
  const truthy = (v: Lit): boolean | null =>
    v === null ? null : typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : null
  const fail = Symbol('fail')
  type R = Lit | typeof fail
  const primary = (): R => {
    const s = peek()
    if (!s) return fail
    if (isPunct(s, '(')) {
      i++
      const v = or()
      if (!isPunct(peek(), ')')) return fail
      i++
      return v
    }
    if (s.type === 'operator' && (s.text === '-' || s.text === '+')) {
      i++
      const v = primary()
      return typeof v === 'number' ? (s.text === '-' ? -v : v) : fail
    }
    i++
    if (s.type === 'number') {
      const v = Number(s.text)
      return Number.isNaN(v) ? fail : v
    }
    if (s.type === 'string' && /^'.*'$/s.test(s.text))
      return s.text.slice(1, -1).replace(/''/g, "'")
    if (s.word === 'TRUE') return true
    if (s.word === 'FALSE') return false
    if (s.word === 'NULL') return null
    return fail
  }
  const cmp = (): R => {
    const left = primary()
    if (left === fail) return fail
    const op = peek()
    if (
      op?.type === 'operator' &&
      ['=', '==', '<>', '!=', '<', '<=', '>', '>='].includes(op.text)
    ) {
      i++
      const right = primary()
      if (right === fail) return fail
      if (left === null || right === null) return null
      if (typeof left !== typeof right) return fail
      switch (op.text) {
        case '=':
        case '==':
          return left === right
        case '<>':
        case '!=':
          return left !== right
        case '<':
          return left < right
        case '<=':
          return left <= right
        case '>':
          return left > right
        default:
          return left >= right
      }
    }
    if (op?.word === 'IS') {
      i++
      let negate = false
      if (peek()?.word === 'NOT') {
        negate = true
        i++
      }
      const what = peek()?.word
      i++
      let r: boolean
      if (what === 'NULL') r = left === null
      else if (what === 'TRUE') r = truthy(left) === true
      else if (what === 'FALSE') r = truthy(left) === false
      else return fail
      return negate ? !r : r
    }
    return left
  }
  const not = (): R => {
    if (peek()?.word === 'NOT') {
      i++
      const v = not()
      if (v === fail) return fail
      const t = truthy(v)
      return t === null ? (v === null ? null : fail) : !t
    }
    return cmp()
  }
  const and = (): R => {
    let left = not()
    while (left !== fail && peek()?.word === 'AND') {
      i++
      const right = not()
      if (right === fail) return fail
      const a = truthy(left)
      const b = truthy(right)
      left = a === false || b === false ? false : a === null || b === null ? null : true
    }
    return left
  }
  const or = (): R => {
    let left = and()
    while (left !== fail && peek()?.word === 'OR') {
      i++
      const right = and()
      if (right === fail) return fail
      const a = truthy(left)
      const b = truthy(right)
      left = a === true || b === true ? true : a === null || b === null ? null : false
    }
    return left
  }
  const v = or()
  if (v === fail || i !== cond.length) return 'constant'
  const t = truthy(v)
  if (t === true) return 'always'
  if (t === false || v === null) return 'never'
  return 'constant'
}

// ---------------------------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------------------------

interface DmlFinding {
  targets: string[]
  dangerous: string[]
  destructiveTarget: string | null
}

/** INSERT/UPDATE/DELETE/MERGE heads at any depth: targets, and UPDATE/DELETE without WHERE. */
function scanDml(ctx: Ctx): DmlFinding {
  const { sigs } = ctx
  const word = (j: number): string | null => sigs[j]?.word ?? null
  const out: DmlFinding = { targets: [], dangerous: [], destructiveTarget: null }
  for (let k = 0; k < sigs.length; k++) {
    const w = sigs[k]?.word
    if (!w || !DML_WORDS.has(w)) continue
    if (isPunct(sigs[k - 1], '.') || isPunct(sigs[k + 1], '.') || isPunct(sigs[k + 1], '('))
      continue
    if (DML_NOT_AFTER.has(word(k - 1) ?? '') || isPunct(sigs[k - 1], ',')) continue

    let j = k + 1
    let target: string | null = null
    if (w === 'UPDATE') {
      while (
        ['LOW_PRIORITY', 'IGNORE', 'ONLY', 'OR', 'ROLLBACK', 'ABORT', 'REPLACE', 'FAIL'].includes(
          word(j) ?? ''
        )
      )
        j++
      target = readName(sigs, j)?.name ?? null
    } else if (w === 'DELETE') {
      while (['LOW_PRIORITY', 'QUICK', 'IGNORE'].includes(word(j) ?? '')) j++
      if (word(j) === 'FROM') {
        j++
        if (word(j) === 'ONLY') j++
        target = readName(sigs, j)?.name ?? null
      } else {
        const list = readNameList(sigs, j)
        target = list.names[0] ?? null
        if (target) out.targets.push(target)
        out.targets.push(...list.names.slice(1))
      }
    } else {
      while (
        [
          'LOW_PRIORITY',
          'DELAYED',
          'HIGH_PRIORITY',
          'IGNORE',
          'OR',
          'REPLACE',
          'ROLLBACK',
          'ABORT',
          'FAIL',
          'INTO',
          'TABLE',
          'OVERWRITE'
        ].includes(word(j) ?? '')
      )
        j++
      if (word(j) !== 'FUNCTION') target = readName(sigs, j)?.name ?? null
    }
    if (target && !out.targets.includes(target)) out.targets.push(target)
    if (w !== 'UPDATE' && w !== 'DELETE') continue

    // WHERE at the head's own depth, before the scope closes.
    const d = sigs[k]?.depth ?? 0
    let where = -1
    let joined = false
    let end = sigs.length
    for (let m = k + 1; m < sigs.length; m++) {
      const s = sigs[m] as Sig
      if (s.depth < d || s.type === 'delimiter') {
        end = m
        break
      }
      if (s.depth !== d) continue
      if (s.word === 'JOIN') joined = true
      if (s.word === 'WHERE' && where < 0) where = m
    }
    const of = target ? ` of ${target}` : ''
    if (where < 0) {
      out.dangerous.push(
        joined
          ? `${w} … JOIN without WHERE ${w === 'DELETE' ? 'removes' : 'changes'} every joined row${of}`
          : `${w} without WHERE ${w === 'DELETE' ? 'removes' : 'changes'} every row${of}`
      )
      out.destructiveTarget ??= target
      continue
    }
    const cond: Sig[] = []
    for (let m = where + 1; m < end; m++) {
      const s = sigs[m] as Sig
      if (s.depth === d && s.word && ['ORDER', 'LIMIT', 'RETURNING', 'OUTPUT'].includes(s.word))
        break
      cond.push(s)
    }
    const verdict = constantWhere(cond)
    if (verdict === 'always') {
      out.dangerous.push(
        `${w} with an always-true WHERE ${w === 'DELETE' ? 'removes' : 'changes'} every row${of}`
      )
      out.destructiveTarget ??= target
    } else if (verdict === 'constant') {
      out.dangerous.push(`${w} with a WHERE that references no column may affect every row${of}`)
      out.destructiveTarget ??= target
    }
  }
  return out
}

const uniq = (items: string[]): string[] => [...new Set(items.filter((s) => s.length > 0))]

function analyzeTokens(
  text: string,
  tokens: SqlToken[],
  dialect: SqlDialect
): Omit<SqlStatementAnalysis, 'lexError'> {
  const { sigs: rawSigs, unbalanced, hiddenDelimiter } = toSigs(tokens)
  // Trailing terminators are fine (`SELECT 1;`).
  let last = rawSigs.length
  while (last > 0 && rawSigs[last - 1]?.type === 'delimiter') last--
  const trimmed = rawSigs.slice(0, last)
  // "One statement" is whatever the splitter calls one: a `;` inside a routine body (CREATE
  // TRIGGER … BEGIN …; END) does not count, a `;` hidden in an executable comment does.
  const multipleStatements =
    hiddenDelimiter || splitLexedSqlStatements(text, tokens, dialect).length > 1
  const codeEnd = trimmed.length > 0 ? (trimmed[trimmed.length - 1] as Sig).end : -1
  const sigs = unwrap(trimmed)

  const empty: SqlClassification = {
    classification: 'unknown',
    leadingKeyword: null,
    dangerous: [],
    reasons: ['empty statement'],
    returnsRows: false,
    hasLimitClause: false,
    targetTables: [],
    destructiveTarget: null
  }
  if (sigs.length === 0)
    return {
      classification: empty,
      mainKeyword: null,
      topLevelWords: [],
      codeEnd,
      multipleStatements
    }

  const ctx: Ctx = { dialect, sigs }
  let lead = 0
  while (lead < sigs.length && isPunct(sigs[lead], '(')) lead++
  const leadingKeyword = sigs[lead]?.word ?? null
  const b = base(ctx, lead)
  let cls = b.cls
  const reasons = [...b.reasons]
  const dangerous = [...b.dangerous]
  const targets = [...b.targets]
  let destructiveTarget = b.destructiveTarget
  const mainKeyword = sigs[b.main]?.word ?? null
  const mainDepth = sigs[b.main]?.depth ?? 0
  const mainStart = sigs[b.main]?.start ?? 0
  const atTop = (s: Sig): boolean => s.depth === 0 || (s.depth <= mainDepth && s.start >= mainStart)
  const topLevelWords = sigs.filter((s) => s.word !== null && atTop(s)).map((s) => s.word as string)

  const readish = cls === 'read' || cls === 'session' || cls === 'tx' || cls === 'lock'

  // (2) deny-scan at any depth.
  if (b.scan === 'full' && readish) {
    for (let j = 0; j < sigs.length; j++) {
      const s = sigs[j] as Sig
      const w = s.word
      if (!w) continue
      if (w === 'INTO' && (sigs[j + 1]?.word === 'OUTFILE' || sigs[j + 1]?.word === 'DUMPFILE')) {
        cls = worse(cls, 'write')
        reasons.unshift(`INTO ${sigs[j + 1]?.word} writes a file on the database server`)
        continue
      }
      const denied = DENY_WORDS[w]
      if (!denied) continue
      if (isPunct(sigs[j - 1], '.') || isPunct(sigs[j + 1], '.') || isPunct(sigs[j + 1], '('))
        continue
      const prev = sigs[j - 1]?.word
      if (prev === 'AS') continue
      if (w === 'UPDATE' && (prev === 'FOR' || prev === 'KEY')) continue
      cls = worse(cls, denied)
      reasons.unshift(`contains a nested ${w}`)
    }
  }

  // (3) INTO at the top level of a SELECT; row locks anywhere.
  if (cls === 'read' && mainKeyword === 'SELECT' && b.scan === 'full') {
    if (sigs.some((s) => s.word === 'INTO' && atTop(s))) {
      cls = 'write'
      reasons.unshift('SELECT … INTO writes its result into a table, file or variable')
    }
  }
  if ((cls === 'read' || cls === 'session' || cls === 'tx') && b.scan === 'full') {
    for (let j = 0; j < sigs.length; j++) {
      const w = sigs[j]?.word
      const n1 = sigs[j + 1]?.word
      const n2 = sigs[j + 2]?.word
      const forLock =
        w === 'FOR' &&
        (n1 === 'UPDATE' ||
          n1 === 'SHARE' ||
          (n1 === 'NO' && n2 === 'KEY') ||
          (n1 === 'KEY' && n2 === 'SHARE'))
      const inShareMode = w === 'LOCK' && n1 === 'IN' && n2 === 'SHARE'
      if (forLock || inShareMode) {
        cls = worse(cls, 'lock')
        reasons.unshift(
          forLock
            ? `FOR ${n1 === 'NO' ? 'NO KEY UPDATE' : n1 === 'KEY' ? 'KEY SHARE' : n1} locks the selected rows`
            : 'LOCK IN SHARE MODE locks the selected rows'
        )
        break
      }
    }
  }

  // (4) side-effect functions.
  if (b.scan !== 'none') {
    const seen = new Set<string>()
    for (let j = 0; j + 1 < sigs.length; j++) {
      const s = sigs[j] as Sig
      if (!isPunct(sigs[j + 1], '(')) continue
      const name =
        s.word !== null
          ? s.text.toLowerCase()
          : s.type === 'quoted_identifier'
            ? unquoteSqlIdentifier(s.text).toLowerCase()
            : null
      if (!name || seen.has(name)) continue
      const hit = DENIED_FUNCTIONS[dialect].find((f) => f.test.test(name))
      if (!hit) continue
      seen.add(name)
      if (SEVERITY[cls] <= SEVERITY.lock) cls = worse(cls, hit.cls)
      reasons.unshift(`calls ${name}(), which has side effects`)
      if (hit.dangerous) dangerous.push(`calls ${name}()`)
    }
  }

  // DML heads (targets, DELETE/UPDATE without WHERE) for statements that execute DML.
  const dmlMain =
    mainKeyword !== null &&
    [
      'INSERT',
      'REPLACE',
      'UPSERT',
      'MERGE',
      'UPDATE',
      'DELETE',
      'SELECT',
      'VALUES',
      'TABLE',
      'COPY'
    ].includes(mainKeyword)
  if (dmlMain && b.scan === 'full') {
    const dml = scanDml(ctx)
    targets.push(...dml.targets)
    dangerous.push(...dml.dangerous)
    destructiveTarget ??= dml.destructiveTarget
  }

  // RETURNING makes a write return rows.
  let returnsRows = b.returnsRows
  if (!returnsRows && sigs.some((s) => s.word === 'RETURNING' && atTop(s))) returnsRows = true
  if (cls === 'write' && mainKeyword === 'SELECT' && !sigs.some((s) => s.word === 'RETURNING')) {
    // SELECT … INTO produces no result set.
    if (sigs.some((s) => s.word === 'INTO' && atTop(s))) returnsRows = false
  }

  // LIMIT / FETCH FIRST / ClickHouse TOP that bounds the whole result (not ClickHouse
  // `LIMIT n BY`, not MariaDB `LIMIT ROWS EXAMINED n`, and not a LIMIT inside one parenthesised
  // branch of a UNION / EXCEPT / INTERSECT, which only bounds that branch).
  const SET_OPERATORS = ['UNION', 'EXCEPT', 'INTERSECT', 'MINUS']
  const boundsOneBranch = (s: Sig): boolean =>
    s.depth > 0 && sigs.some((t) => t.depth < s.depth && SET_OPERATORS.includes(t.word ?? ''))
  let hasLimitClause = false
  for (let j = 0; j < sigs.length && !hasLimitClause; j++) {
    const s = sigs[j] as Sig
    if (!atTop(s) || !s.word || boundsOneBranch(s)) continue
    if (s.word === 'LIMIT') {
      if (sigs[j + 1]?.word === 'ROWS' && sigs[j + 2]?.word === 'EXAMINED') continue
      if (dialect === 'clickhouse') {
        let limitBy = false
        for (let m = j + 1; m < sigs.length; m++) {
          const t = sigs[m] as Sig
          if (t.depth !== s.depth || !t.word) continue
          if (t.word === 'BY') {
            limitBy = true
            break
          }
          if (
            ['LIMIT', 'SETTINGS', 'FORMAT', 'UNION', 'INTO', 'EXCEPT', 'INTERSECT'].includes(t.word)
          )
            break
        }
        if (limitBy) continue
      }
      hasLimitClause = true
    } else if (s.word === 'FETCH' && ['FIRST', 'NEXT'].includes(sigs[j + 1]?.word ?? '')) {
      hasLimitClause = true
    } else if (
      dialect === 'clickhouse' &&
      s.word === 'TOP' &&
      (sigs[j - 1]?.word === 'SELECT' || sigs[j - 1]?.word === 'DISTINCT')
    ) {
      hasLimitClause = true
    }
  }

  if (unbalanced) {
    cls = 'unknown'
    reasons.unshift('unbalanced parentheses')
  }
  if (multipleStatements) {
    cls = 'unknown'
    reasons.unshift('contains more than one statement')
  }

  const classification: SqlClassification = {
    classification: cls,
    leadingKeyword,
    dangerous: uniq(dangerous),
    reasons: cls === 'read' ? [] : uniq(reasons.filter((r) => r !== '')),
    returnsRows,
    hasLimitClause,
    targetTables: uniq(targets),
    destructiveTarget
  }
  if (classification.reasons.length === 0 && cls !== 'read' && CLASS_REASON[cls])
    classification.reasons.push(CLASS_REASON[cls])
  return { classification, mainKeyword, topLevelWords, codeEnd, multipleStatements }
}

/** Code-token boundaries, to compare two lexes of the same text. */
const codeShape = (tokens: SqlToken[]): string =>
  tokens
    .filter((t) => !isSqlTrivia(t))
    .map((t) => `${t.type}:${t.start}:${t.end}`)
    .join(',')

/**
 * Full analysis (classification plus what the auto-limit rewrite needs). The text should be ONE
 * statement as produced by splitSqlStatements; a trailing `;` is tolerated.
 */
export function analyzeSqlStatement(
  text: string,
  dialect: SqlDialect,
  options: SqlClassifyOptions = {}
): SqlStatementAnalysis {
  const lex = lexSql(text, dialect, options)
  const analysis = analyzeTokens(text, lex.tokens, dialect)
  const c = analysis.classification
  if (lex.error) {
    c.classification = 'unknown'
    c.reasons = [
      `could not parse the statement: ${lex.error.message.toLowerCase()}`,
      ...c.reasons.filter((r) => r !== CLASS_REASON.unknown)
    ]
  } else if (
    (dialect === 'mysql' || dialect === 'mariadb') &&
    options.backslashEscapes === undefined &&
    text.includes('\\')
  ) {
    // The session's NO_BACKSLASH_ESCAPES is unknown: if reading the text the other way is ALSO
    // valid but cuts it differently, we cannot know what the server will run. (If the other
    // reading does not even lex, the server would reject it, so it cannot hide anything.)
    const alt = lexSql(text, dialect, { backslashEscapes: false })
    if (!alt.error && codeShape(alt.tokens) !== codeShape(lex.tokens)) {
      c.classification = 'unknown'
      c.reasons = [
        'its meaning depends on the server’s NO_BACKSLASH_ESCAPES mode',
        ...c.reasons.filter((r) => r !== CLASS_REASON.unknown)
      ]
    }
  }
  return { ...analysis, lexError: lex.error ?? null }
}

/** Classifies ONE statement (see the file header). Unsure ⇒ 'unknown'. */
export function classifySqlStatement(
  text: string,
  dialect: SqlDialect,
  options?: SqlClassifyOptions
): SqlClassification {
  return analyzeSqlStatement(text, dialect, options).classification
}

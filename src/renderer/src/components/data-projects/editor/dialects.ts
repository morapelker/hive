// CodeMirror SQL dialects for the five SQL engines, plus the per-dialect facts the editor and the
// query toolbar need (EXPLAIN prefix, sql-formatter language, curated function names).
//
// Why not lang-sql's stock dialects as-is:
// - MySQL/MariaSQL do not enable backslash escapes, so `'it\'s'` would colour the rest of the line
//   as a string; both engines read backslash escapes by default.
// - SQLite also accepts backtick and [bracket] identifiers.
// - lang-sql has no ClickHouse dialect: it is defined here. lang-sql looks words up with
//   `word.toLowerCase()` but stores the lists as given, so every list MUST be lowercase
//   (`UInt32` in `types` would never match).

import { MariaSQL, MySQL, PostgreSQL, SQLDialect, SQLite } from '@codemirror/lang-sql'
import type { SqlDialect } from '@shared/data-projects/types'

// Reserved and common ClickHouse keywords (lowercase), from the documented SQL reference and
// `system.keywords` of 24.x. Left out on purpose: words that are also functions (`if`, `any`,
// `min`) and words that are common column names (`id`, `type`, `user`, `query`, `source`), which
// would otherwise render as keywords all over ordinary SELECTs.
const CLICKHOUSE_KEYWORDS = [
  'add after all alter and anti array as asc ascending asof async attach between both by case',
  'cast check cluster codec collate column columns comment constraint create cross cube current',
  'database databases deduplicate default delete desc descending describe detach dictionary',
  'distinct distributed div drop else end engine except exchange exists explain fetch fill',
  'final flush following for format from full function global grant group grouping having',
  'identified ilike in index inner insert interpolate intersect interval into is join key kill',
  'lazy leading left like limit live local materialize materialized modify move mutation',
  'natural no not null nulls offset on only optimize option or order outer outfile over',
  'partition populate preceding prewhere primary projection qualify range recompress regexp',
  'rename replace replicated restrict revoke right rollup row rows sample select set settings',
  'show step next',
  'subpartition syntax system table tables temporary then ties to top totals trailing truncate',
  'ttl unbounded union update use using values view watch when where window with'
].join(' ')

// Data type families (lowercase), including the parametric wrappers.
const CLICKHOUSE_TYPES = [
  'int8 int16 int32 int64 int128 int256 uint8 uint16 uint32 uint64 uint128 uint256',
  'float32 float64 bfloat16 decimal decimal32 decimal64 decimal128 decimal256 bool boolean',
  'string fixedstring uuid date date32 datetime datetime64 time time64 enum enum8 enum16',
  'array tuple map nested nullable lowcardinality ipv4 ipv6 json object variant dynamic',
  'aggregatefunction simpleaggregatefunction point ring linestring multilinestring polygon',
  'multipolygon nothing intervalsecond intervalminute intervalhour intervalday intervalweek',
  'intervalmonth intervalquarter intervalyear'
].join(' ')

// Kept short on purpose: every builtin also appears in lang-sql's keyword completion.
const CLICKHOUSE_BUILTINS =
  'count sum avg min max uniq uniqexact any anylast argmax argmin grouparray quantile quantiles ' +
  'multiif arrayjoin now today yesterday todate todatetime tostring touint64 toint64 if'

/** ClickHouse: `#`/`#!` comments, backslash strings, heredocs, backtick/double-quote identifiers. */
export const ClickHouseDialect = SQLDialect.define({
  keywords: CLICKHOUSE_KEYWORDS,
  types: CLICKHOUSE_TYPES,
  builtin: CLICKHOUSE_BUILTINS,
  backslashEscapes: true,
  hashComments: true,
  doubleDollarQuotedStrings: true,
  identifierQuotes: '`"',
  // `?:` ternary, `::` cast, `->` lambda.
  operatorChars: '*+-/%<>!=&|^?:',
  // `{name:Type}` query parameters are braces + identifiers; nothing starts a special variable.
  specialVar: '',
  caseInsensitiveIdentifiers: false
})

const MySqlDialect = SQLDialect.define({ ...MySQL.spec, backslashEscapes: true })
const MariaDbDialect = SQLDialect.define({ ...MariaSQL.spec, backslashEscapes: true })
const SqliteDialect = SQLDialect.define({ ...SQLite.spec, identifierQuotes: '"`[' })

export const CM_SQL_DIALECTS: Readonly<Record<SqlDialect, SQLDialect>> = {
  mysql: MySqlDialect,
  mariadb: MariaDbDialect,
  postgres: PostgreSQL,
  sqlite: SqliteDialect,
  clickhouse: ClickHouseDialect
}

export const cmSqlDialect = (dialect: SqlDialect): SQLDialect => CM_SQL_DIALECTS[dialect]

/**
 * Prefix the Explain button puts in front of the current statement. Plain EXPLAIN (never
 * ANALYZE: that executes the statement) so the classifier keeps it a read.
 */
export const explainPrefix = (dialect: SqlDialect): string =>
  dialect === 'sqlite' ? 'EXPLAIN QUERY PLAN ' : 'EXPLAIN '

/** True when the statement already is an EXPLAIN / DESCRIBE (Explain then runs it as-is). */
export const isExplainStatement = (text: string): boolean =>
  /^\s*(?:explain|describe|desc)\b/i.test(text)

/**
 * Notable built-in functions offered by completion when the server's completion schema does not
 * list any (it usually lists user-defined ones). Lowercase is what users type most; the apply
 * text keeps the case shown here.
 */
const COMMON_FUNCTIONS = [
  'count',
  'sum',
  'avg',
  'min',
  'max',
  'coalesce',
  'nullif',
  'cast',
  'lower',
  'upper',
  'length',
  'substring',
  'trim',
  'replace',
  'concat',
  'round',
  'abs',
  'now'
]

export const SQL_FUNCTIONS: Readonly<Record<SqlDialect, readonly string[]>> = {
  mysql: [
    ...COMMON_FUNCTIONS,
    'ifnull',
    'if',
    'concat_ws',
    'group_concat',
    'date_format',
    'date_add',
    'date_sub',
    'datediff',
    'curdate',
    'current_timestamp',
    'unix_timestamp',
    'from_unixtime',
    'json_extract',
    'json_unquote',
    'json_object',
    'json_arrayagg',
    'json_objectagg',
    'json_contains',
    'char_length',
    'left',
    'right',
    'lpad',
    'rpad',
    'floor',
    'ceil',
    'rand',
    'uuid',
    'last_insert_id',
    'found_rows',
    'row_number',
    'rank',
    'dense_rank',
    'lag',
    'lead'
  ],
  mariadb: [
    ...COMMON_FUNCTIONS,
    'ifnull',
    'if',
    'concat_ws',
    'group_concat',
    'date_format',
    'date_add',
    'date_sub',
    'datediff',
    'curdate',
    'current_timestamp',
    'unix_timestamp',
    'from_unixtime',
    'json_extract',
    'json_value',
    'json_query',
    'json_object',
    'json_arrayagg',
    'char_length',
    'left',
    'right',
    'lpad',
    'rpad',
    'floor',
    'ceil',
    'rand',
    'uuid',
    'last_insert_id',
    'row_number',
    'rank',
    'dense_rank',
    'lag',
    'lead'
  ],
  postgres: [
    ...COMMON_FUNCTIONS,
    'string_agg',
    'array_agg',
    'json_agg',
    'jsonb_agg',
    'json_build_object',
    'jsonb_build_object',
    'jsonb_set',
    'to_jsonb',
    'to_char',
    'to_date',
    'to_timestamp',
    'date_trunc',
    'date_part',
    'extract',
    'age',
    'current_date',
    'current_timestamp',
    'generate_series',
    'unnest',
    'array_length',
    'regexp_replace',
    'regexp_matches',
    'split_part',
    'left',
    'right',
    'lpad',
    'rpad',
    'floor',
    'ceil',
    'random',
    'gen_random_uuid',
    'greatest',
    'least',
    'row_number',
    'rank',
    'dense_rank',
    'lag',
    'lead',
    'first_value',
    'last_value',
    'pg_size_pretty',
    'pg_total_relation_size'
  ],
  sqlite: [
    ...COMMON_FUNCTIONS,
    'ifnull',
    'iif',
    'instr',
    'printf',
    'group_concat',
    'date',
    'time',
    'datetime',
    'julianday',
    'strftime',
    'unixepoch',
    'json',
    'json_extract',
    'json_object',
    'json_array',
    'json_group_array',
    'json_group_object',
    'typeof',
    'random',
    'randomblob',
    'hex',
    'quote',
    'total',
    'changes',
    'last_insert_rowid',
    'row_number',
    'rank',
    'dense_rank',
    'lag',
    'lead'
  ],
  clickhouse: [
    'count',
    'sum',
    'avg',
    'min',
    'max',
    'uniq',
    'uniqExact',
    'any',
    'anyLast',
    'argMax',
    'argMin',
    'groupArray',
    'groupUniqArray',
    'quantile',
    'quantiles',
    'median',
    'countIf',
    'sumIf',
    'avgIf',
    'if',
    'multiIf',
    'coalesce',
    'ifNull',
    'nullIf',
    'toString',
    'toDate',
    'toDateTime',
    'toDateTime64',
    'toStartOfDay',
    'toStartOfHour',
    'toStartOfMonth',
    'toStartOfWeek',
    'toYYYYMM',
    'toUInt32',
    'toUInt64',
    'toInt64',
    'toFloat64',
    'toDecimal64',
    'now',
    'today',
    'yesterday',
    'dateDiff',
    'formatDateTime',
    'parseDateTimeBestEffort',
    'arrayJoin',
    'arrayMap',
    'arrayFilter',
    'has',
    'length',
    'lower',
    'upper',
    'concat',
    'substring',
    'replaceAll',
    'splitByChar',
    'match',
    'extract',
    'JSONExtractString',
    'JSONExtractInt',
    'JSONExtract',
    'round',
    'floor',
    'formatReadableSize',
    'formatReadableQuantity',
    'generateUUIDv4',
    'cityHash64',
    'sipHash64'
  ]
}

// Canonical EJSON (what the server sends for every Mongo document) → what the user reads and
// edits. The server serialises with `EJSON.serialize(doc, { relaxed: false })`, so an ObjectId
// arrives as { $oid }, a date as { $date: { $numberLong } }, an int32 as { $numberInt } and so
// on; relaxed forms ({ $date: 'ISO' }, plain JSON numbers) are accepted too because documents
// can also come from exports, the assistant or a `value` result.
//
// Two shell renderings:
// - 'display': the mongosh look — ObjectId('…'), ISODate('…'), NumberLong('…'),
//   NumberDecimal('…'), UUID('…'), /re/i, Timestamp({ t, i }) — for the List view, cards, the
//   shell's value output.
// - 'edit': text the server's parser (@mongodb-js/shell-bson-parser, loose mode, plus its
//   canonical-wrapper revival) turns back into exactly the same BSON. Differences from display:
//   integral doubles become Double(1) (a bare 1 would be stored as an int32), -0 becomes
//   Double(-0), and values without a lossless shell spelling (regexes the ES6 grammar rejects or
//   with x/l/s/u options, dates outside the JS range) use their canonical EJSON wrapper, which
//   the server revives. The edit dialog, copy and the `_id` filters of replaceOne/deleteOne
//   rely on this, so a save never silently changes a field's type.
//
// Also here: relaxed EJSON (JSON view, exports of visible results), grid cells for the Table
// view, and the per-value type used for badges and colours.

import type { DataBinaryCell, DataCell } from '@shared/data-projects/types'

export type MongoValueType =
  | 'objectId'
  | 'date'
  | 'int32'
  | 'int64'
  | 'double'
  | 'decimal'
  | 'string'
  | 'boolean'
  | 'null'
  | 'undefined'
  | 'binary'
  | 'uuid'
  | 'regex'
  | 'timestamp'
  | 'minKey'
  | 'maxKey'
  | 'symbol'
  | 'code'
  | 'dbRef'
  | 'object'
  | 'array'

/** Human label per type (List view badges, Table column types, schema-like hints). */
export const MONGO_TYPE_LABEL: Readonly<Record<MongoValueType, string>> = {
  objectId: 'ObjectId',
  date: 'Date',
  int32: 'Int32',
  int64: 'Int64',
  double: 'Double',
  decimal: 'Decimal128',
  string: 'String',
  boolean: 'Boolean',
  null: 'Null',
  undefined: 'Undefined',
  binary: 'Binary',
  uuid: 'UUID',
  regex: 'RegExp',
  timestamp: 'Timestamp',
  minKey: 'MinKey',
  maxKey: 'MaxKey',
  symbol: 'Symbol',
  code: 'Code',
  dbRef: 'DBRef',
  object: 'Object',
  array: 'Array'
}

/** Tailwind colour per value type (List view values, highlighted shell/JSON text). */
export const MONGO_TYPE_CLASS: Readonly<Record<MongoValueType, string>> = {
  objectId: 'text-amber-700 dark:text-amber-300',
  date: 'text-cyan-700 dark:text-cyan-300',
  int32: 'text-sky-700 dark:text-sky-300',
  int64: 'text-sky-700 dark:text-sky-300',
  double: 'text-sky-700 dark:text-sky-300',
  decimal: 'text-sky-700 dark:text-sky-300',
  string: 'text-emerald-700 dark:text-emerald-400',
  boolean: 'text-violet-700 dark:text-violet-300',
  null: 'text-muted-foreground italic',
  undefined: 'text-muted-foreground italic',
  binary: 'text-orange-700 dark:text-orange-300',
  uuid: 'text-amber-700 dark:text-amber-300',
  regex: 'text-orange-700 dark:text-orange-300',
  timestamp: 'text-cyan-700 dark:text-cyan-300',
  minKey: 'text-violet-700 dark:text-violet-300',
  maxKey: 'text-violet-700 dark:text-violet-300',
  symbol: 'text-emerald-700 dark:text-emerald-400',
  code: 'text-rose-700 dark:text-rose-300',
  dbRef: 'text-amber-700 dark:text-amber-300',
  object: 'text-foreground',
  array: 'text-foreground'
}

type Obj = Record<string, unknown>

const isObj = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasExactKeys = (value: Obj, keys: readonly string[]): boolean => {
  const own = Object.keys(value)
  return own.length === keys.length && keys.every((k) => own.includes(k))
}

const isStr = (value: unknown): value is string => typeof value === 'string'

const INT32_MIN = -2147483648
const INT32_MAX = 2147483647
/** new Date(ms) range in JS. */
const JS_DATE_LIMIT = 8.64e15
/** ISODate('0000-01-01…') … ISODate('9999-12-31…'): what the shell parser's ISODate accepts. */
const ISO_DATE_MIN = -62167219200000
const ISO_DATE_MAX = 253402300799999

// ---------------------------------------------------------------------------------------------
// Type detection
// ---------------------------------------------------------------------------------------------

function binaryParts(value: Obj): { base64: string; subType: number } | null {
  const bin = value.$binary
  if (
    isObj(bin) &&
    hasExactKeys(bin, ['base64', 'subType']) &&
    isStr(bin.base64) &&
    isStr(bin.subType)
  ) {
    const subType = parseInt(bin.subType, 16)
    return Number.isFinite(subType) ? { base64: bin.base64, subType } : null
  }
  // Legacy v1 form { $binary: 'base64', $type: '04' }.
  if (isStr(bin) && isStr(value.$type) && hasExactKeys(value, ['$binary', '$type'])) {
    const subType = parseInt(value.$type, 16)
    return Number.isFinite(subType) ? { base64: bin, subType } : null
  }
  return null
}

/** Milliseconds of a { $date } wrapper (canonical, relaxed ISO or legacy number); null if invalid. */
function dateMillis(value: unknown): number | null {
  if (isObj(value) && hasExactKeys(value, ['$numberLong']) && isStr(value.$numberLong)) {
    const ms = Number(value.$numberLong)
    return Number.isFinite(ms) ? ms : null
  }
  if (isStr(value)) {
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? ms : null
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return null
}

function base64ToBytes(base64: string): Uint8Array | null {
  try {
    const raw = atob(base64)
    const bytes = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

function uuidFromBase64(base64: string): string | null {
  const bytes = base64ToBytes(base64)
  if (!bytes || bytes.length !== 16) return null
  const hex = toHex(bytes)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function isDbRef(value: Obj): boolean {
  return isStr(value.$ref) && '$id' in value && (value.$db === undefined || isStr(value.$db))
}

/** The BSON type of a canonical/relaxed EJSON value. */
export function mongoValueType(value: unknown): MongoValueType {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return 'string'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number')
    return Number.isInteger(value) &&
      value >= INT32_MIN &&
      value <= INT32_MAX &&
      !Object.is(value, -0)
      ? 'int32'
      : 'double'
  if (Array.isArray(value)) return 'array'
  if (!isObj(value)) return 'object'
  const keys = Object.keys(value)
  if (keys.length === 1) {
    const inner = value[keys[0]]
    switch (keys[0]) {
      case '$oid':
        if (isStr(inner)) return 'objectId'
        break
      case '$date':
        if (dateMillis(inner) !== null) return 'date'
        break
      case '$numberInt':
        if (isStr(inner)) return 'int32'
        break
      case '$numberLong':
        if (isStr(inner)) return 'int64'
        break
      case '$numberDouble':
        if (isStr(inner)) return 'double'
        break
      case '$numberDecimal':
        if (isStr(inner)) return 'decimal'
        break
      case '$binary': {
        const parts = binaryParts(value)
        if (parts) return parts.subType === 4 && uuidFromBase64(parts.base64) ? 'uuid' : 'binary'
        break
      }
      case '$uuid':
        if (isStr(inner)) return 'uuid'
        break
      case '$regularExpression':
        if (isObj(inner) && isStr(inner.pattern) && isStr(inner.options)) return 'regex'
        break
      case '$timestamp':
        if (isObj(inner) && typeof inner.t === 'number' && typeof inner.i === 'number')
          return 'timestamp'
        break
      case '$minKey':
        return 'minKey'
      case '$maxKey':
        return 'maxKey'
      case '$symbol':
        if (isStr(inner)) return 'symbol'
        break
      case '$code':
        if (isStr(inner)) return 'code'
        break
      case '$undefined':
        return 'undefined'
    }
  }
  if (keys.length === 2) {
    if (binaryParts(value)) {
      const parts = binaryParts(value)!
      return parts.subType === 4 && uuidFromBase64(parts.base64) ? 'uuid' : 'binary'
    }
    if (isStr(value.$code) && isObj(value.$scope)) return 'code'
  }
  if (isDbRef(value)) return 'dbRef'
  return 'object'
}

// ---------------------------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------------------------

/** JS single-quoted string literal (mongosh style). */
export function quoteShellString(text: string): string {
  let out = "'"
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    if (ch === '\\') out += '\\\\'
    else if (ch === "'") out += "\\'"
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (code === 0x2028) out += '\\u2028'
    else if (code === 0x2029) out += '\\u2029'
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, '0')}`
    else out += ch
  }
  return out + "'"
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** Object key as written in shell syntax: bare when it is an identifier, quoted otherwise. */
export function shellKey(key: string): string {
  return IDENTIFIER.test(key) ? key : quoteShellString(key)
}

function doubleText(raw: string, mode: 'display' | 'edit'): string {
  if (raw === 'Infinity' || raw === '-Infinity' || raw === 'NaN') return raw
  const n = Number(raw)
  if (!Number.isFinite(n))
    return mode === 'edit' ? `{ $numberDouble: ${quoteShellString(raw)} }` : raw
  if (Object.is(n, -0)) return mode === 'edit' ? 'Double(-0)' : '-0'
  if (Number.isInteger(n)) return mode === 'edit' ? `Double(${numberLiteral(n)})` : numberLiteral(n)
  return numberLiteral(n)
}

/** Shortest JS literal that reads back as the same number. */
function numberLiteral(n: number): string {
  return String(n)
}

function dateText(raw: unknown, mode: 'display' | 'edit'): string {
  const ms = dateMillis(raw) as number
  if (ms >= ISO_DATE_MIN && ms <= ISO_DATE_MAX) return `ISODate('${new Date(ms).toISOString()}')`
  if (Math.abs(ms) <= JS_DATE_LIMIT) return `new Date(${ms})`
  // Beyond what a JS Date holds: keep the exact int64 milliseconds (Number() would round them).
  const exact = isObj(raw) && isStr(raw.$numberLong) ? raw.$numberLong : String(ms)
  return mode === 'edit'
    ? `{ $date: { $numberLong: ${quoteShellString(exact)} } }`
    : `Date(${exact})`
}

const JS_SAFE_REGEX_OPTIONS = /^[im]*$/

/** True when /pattern/options parses (ES6 grammar) back to exactly this pattern and options. */
function regexLiteralIsLossless(pattern: string, options: string): boolean {
  if (!JS_SAFE_REGEX_OPTIONS.test(options)) return false
  // `/` would come back escaped (a\/b), line terminators cannot appear in a literal, and the
  // server's acorn runs with ecmaVersion 6 (no named groups, lookbehind, \p{…}).
  if (/[/\n\r\u2028\u2029]/.test(pattern) || pattern === '' || /\(\?<|\\[pPk]\{|\\k</.test(pattern))
    return false
  try {
    new RegExp(pattern, options)
    return true
  } catch {
    return false
  }
}

function regexText(pattern: string, options: string, mode: 'display' | 'edit'): string {
  if (mode === 'edit' && !regexLiteralIsLossless(pattern, options)) {
    return `{ $regularExpression: { pattern: ${quoteShellString(pattern)}, options: ${quoteShellString(options)} } }`
  }
  const body = pattern === '' ? '(?:)' : pattern.replace(/\\?\//g, (m) => (m === '/' ? '\\/' : m))
  return `/${body.replace(/\n/g, '\\n').replace(/\r/g, '\\r')}/${options}`
}

// ---------------------------------------------------------------------------------------------
// Shell rendering
// ---------------------------------------------------------------------------------------------

export interface ShellFormatOptions {
  /** 'display' (mongosh look) or 'edit' (lossless round trip through the server's parser). */
  mode?: 'display' | 'edit'
  /** Indent width; 0 = everything on one line. */
  indent?: number
  /** Objects/arrays whose one-line form fits in this many columns stay on one line. */
  width?: number
  /** Display only: shorten binary payloads longer than this many base64 characters. */
  maxBinaryChars?: number
}

interface FormatState {
  mode: 'display' | 'edit'
  indent: number
  width: number
  maxBinaryChars: number
}

function formatScalar(value: unknown, type: MongoValueType, st: FormatState): string | null {
  const v = value as Obj
  switch (type) {
    case 'null':
      return 'null'
    case 'undefined':
      return 'undefined'
    case 'string':
      return quoteShellString(value as string)
    case 'boolean':
      return String(value)
    case 'int32':
      return typeof value === 'number' ? numberLiteral(value) : String(Number(v.$numberInt))
    case 'double':
      if (typeof value === 'number') {
        if (Number.isNaN(value)) return 'NaN'
        if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity'
        return doubleText(String(value), st.mode)
      }
      return doubleText(v.$numberDouble as string, st.mode)
    case 'int64':
      return `NumberLong(${quoteShellString(v.$numberLong as string)})`
    case 'decimal':
      return `NumberDecimal(${quoteShellString(v.$numberDecimal as string)})`
    case 'objectId':
      return `ObjectId(${quoteShellString(v.$oid as string)})`
    case 'date':
      return dateText(v.$date, st.mode)
    case 'uuid': {
      if (isStr(v.$uuid)) return `UUID(${quoteShellString(v.$uuid)})`
      const parts = binaryParts(v)!
      return `UUID('${uuidFromBase64(parts.base64)}')`
    }
    case 'binary': {
      const parts = binaryParts(v)!
      let base64 = parts.base64
      if (st.mode === 'display' && base64.length > st.maxBinaryChars)
        base64 = `${base64.slice(0, st.maxBinaryChars)}…`
      return `BinData(${parts.subType}, ${quoteShellString(base64)})`
    }
    case 'regex': {
      const re = v.$regularExpression as { pattern: string; options: string }
      return regexText(re.pattern, re.options, st.mode)
    }
    case 'timestamp': {
      const ts = v.$timestamp as { t: number; i: number }
      return `Timestamp({ t: ${ts.t}, i: ${ts.i} })`
    }
    case 'minKey':
      return 'MinKey()'
    case 'maxKey':
      return 'MaxKey()'
    case 'symbol':
      return `Symbol(${quoteShellString(v.$symbol as string)})`
    default:
      return null
  }
}

function formatValue(value: unknown, st: FormatState, depth: number, column: number): string {
  const type = mongoValueType(value)
  const scalar = formatScalar(value, type, st)
  if (scalar !== null) return scalar
  if (type === 'code') {
    const v = value as Obj
    const code = quoteShellString(v.$code as string)
    if (!isObj(v.$scope)) return `Code(${code})`
    return `Code(${code}, ${formatValue(v.$scope, st, depth, column + code.length + 7)})`
  }
  if (type === 'dbRef') {
    const v = value as Obj
    const extra = Object.keys(v).filter((k) => k !== '$ref' && k !== '$id' && k !== '$db')
    const args = [quoteShellString(v.$ref as string), formatValue(v.$id, st, depth, column)]
    if (isStr(v.$db) || extra.length)
      args.push(isStr(v.$db) ? quoteShellString(v.$db) : 'undefined')
    if (extra.length) {
      const fields: Obj = {}
      for (const k of extra) fields[k] = v[k]
      args.push(formatValue(fields, st, depth, column))
    }
    return `DBRef(${args.join(', ')})`
  }
  if (type === 'array') return formatContainer(value as unknown[], true, st, depth, column)
  return formatContainer(value as Obj, false, st, depth, column)
}

function formatContainer(
  value: unknown[] | Obj,
  isArray: boolean,
  st: FormatState,
  depth: number,
  column: number
): string {
  const entries: Array<[string | null, unknown]> = isArray
    ? (value as unknown[]).map((item) => [null, item])
    : Object.keys(value).map((k) => [k, (value as Obj)[k]])
  const [open, close] = isArray ? ['[', ']'] : ['{', '}']
  if (entries.length === 0) return `${open}${close}`
  const inlineParts = entries.map(
    ([k, v]) =>
      `${k === null ? '' : `${shellKey(k)}: `}${formatValue(v, { ...st, indent: 0 }, 0, 0)}`
  )
  const inline = `${open} ${inlineParts.join(', ')} ${close}`
  if (st.indent === 0 || (column + inline.length <= st.width && !inline.includes('\n')))
    return inline
  const pad = ' '.repeat(st.indent * (depth + 1))
  const lines = entries.map(([k, v]) => {
    const prefix = k === null ? '' : `${shellKey(k)}: `
    return `${pad}${prefix}${formatValue(v, st, depth + 1, pad.length + prefix.length)}`
  })
  return `${open}\n${lines.join(',\n')}\n${' '.repeat(st.indent * depth)}${close}`
}

/** Canonical/relaxed EJSON value → shell text. */
export function formatShellValue(value: unknown, options: ShellFormatOptions = {}): string {
  const st: FormatState = {
    mode: options.mode ?? 'display',
    indent: options.indent ?? 0,
    width: options.width ?? 80,
    maxBinaryChars: options.maxBinaryChars ?? 64
  }
  return formatValue(value, st, 0, 0)
}

/** A whole document as multi-line shell text (List copy, JSON-ish blocks, the edit dialog). */
export function formatShellDocument(
  doc: Record<string, unknown>,
  mode: 'display' | 'edit' = 'edit'
): string {
  return formatShellValue(doc, { mode, indent: 2, width: 72 })
}

/** One-line preview, cut to `max` characters (cards, table cells, summaries). */
export function formatShellInline(value: unknown, max = 120): string {
  const text = formatShellValue(value, { mode: 'display', indent: 0 })
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

// ---------------------------------------------------------------------------------------------
// Relaxed EJSON / JSON
// ---------------------------------------------------------------------------------------------

/**
 * Canonical → relaxed EJSON (the format mongoexport writes by default): numbers become JSON
 * numbers when that is exact, dates in 1970–9999 become { $date: 'ISO' }; everything else keeps
 * its wrapper so nothing is lost.
 */
export function toRelaxedEjson(value: unknown, depth = 0): unknown {
  if (depth > 200) return value
  if (Array.isArray(value)) return value.map((item) => toRelaxedEjson(item, depth + 1))
  if (!isObj(value)) return value
  const type = mongoValueType(value)
  switch (type) {
    case 'int32':
      return Number(value.$numberInt)
    case 'double': {
      const n = Number(value.$numberDouble)
      return Number.isFinite(n) && !Object.is(n, -0) ? n : value
    }
    case 'int64': {
      const n = Number(value.$numberLong)
      return Number.isSafeInteger(n) ? n : value
    }
    case 'date': {
      const ms = dateMillis(value.$date)
      if (ms !== null && ms >= 0 && ms <= ISO_DATE_MAX) return { $date: new Date(ms).toISOString() }
      return value
    }
    case 'object': {
      const out: Obj = {}
      for (const key of Object.keys(value)) out[key] = toRelaxedEjson(value[key], depth + 1)
      return out
    }
    case 'dbRef': {
      const out: Obj = {}
      for (const key of Object.keys(value)) out[key] = toRelaxedEjson(value[key], depth + 1)
      return out
    }
    case 'code':
      return isObj(value.$scope)
        ? { $code: value.$code, $scope: toRelaxedEjson(value.$scope, depth + 1) }
        : value
    default:
      return value
  }
}

/** Pretty relaxed-EJSON JSON text (JSON view, "Export results" of visible documents). */
export function toRelaxedJsonText(value: unknown, indent = 2): string {
  return JSON.stringify(toRelaxedEjson(value), null, indent) ?? 'null'
}

// ---------------------------------------------------------------------------------------------
// Grid cells (Table view)
// ---------------------------------------------------------------------------------------------

function binaryCell(base64: string): DataBinaryCell {
  const bytes = base64ToBytes(base64) ?? new Uint8Array()
  return { $t: 'bin', hex: toHex(bytes.subarray(0, 64)), len: bytes.length }
}

/**
 * A value as a JSON-safe grid cell: numbers stay numbers when exact, int64/decimal are exact
 * strings, dates are ISO strings, ObjectId/UUID/regex/timestamps use their shell spelling,
 * binary is the shared { $t: 'bin' } cell, nested objects/arrays are relaxed JSON text.
 */
export function toGridCell(value: unknown): DataCell {
  const type = mongoValueType(value)
  const v = value as Obj
  switch (type) {
    case 'null':
    case 'undefined':
      return null
    case 'string':
    case 'boolean':
      return value as string | boolean
    case 'int32':
      return typeof value === 'number' ? value : Number(v.$numberInt)
    case 'double': {
      const n = typeof value === 'number' ? value : Number(v.$numberDouble)
      return Number.isFinite(n) ? n : String(n)
    }
    case 'int64':
      return v.$numberLong as string
    case 'decimal':
      return v.$numberDecimal as string
    case 'date': {
      const ms = dateMillis(v.$date) as number
      return Math.abs(ms) <= JS_DATE_LIMIT ? new Date(ms).toISOString() : String(ms)
    }
    case 'binary':
      return binaryCell(binaryParts(v)!.base64)
    case 'symbol':
      return v.$symbol as string
    case 'code':
      return v.$code as string
    case 'object':
    case 'array':
    case 'dbRef':
      return JSON.stringify(toRelaxedEjson(value))
    default:
      return formatShellValue(value, { mode: 'display' })
  }
}

/** Short type label of a value (List view badges, Table column types). */
export function mongoTypeLabel(value: unknown): string {
  return MONGO_TYPE_LABEL[mongoValueType(value)]
}

/** True for values the List view renders as an expandable node. */
export function isMongoContainer(value: unknown): value is Obj | unknown[] {
  const type = mongoValueType(value)
  return type === 'object' || type === 'array'
}

// Lazy loading of the MongoDB runtime (driver, BSON, shell value parser) plus the BSON value
// helpers every other module in this directory uses.
//
// The driver is loaded with a dynamic import the first time a Mongo data project connects, so
// the server process does not pay for it at startup. BSON comes from `mongodb.BSON` (the
// driver's own instance), and @mongodb-js/shell-bson-parser requires the same CJS `bson`, so
// ObjectIds built by the parser are the classes the driver serialises — no cross-instance
// surprises. We still never rely on `instanceof` for BSON values (`_bsontype` checks instead).
//
// Shell values ("{ _id: ObjectId('…'), at: ISODate('…') }") are converted by the parser's
// allowlist evaluator (no eval). Its quirks handled here:
// - a rejected expression returns '' instead of throwing (but '' is also a legit empty string);
// - syntax errors throw with offsets into "(\n<input>\n)";
// - canonical EJSON wrappers ({ "$oid": "…" }) are NOT converted; a post-pass revives objects
//   whose only key is a known wrapper. EJSON.deserialize on the whole value would be wrong: it
//   also turns the $regex query operator into a BSONRegExp and loses ObjectId types.

import type * as Bson from 'bson'
import type * as MongoDb from 'mongodb'
import { DATA_ERROR_CODES } from '../../../../shared/data-projects/types'
import { DataDriverError } from '../contracts'

interface ShellBsonParser {
  parse(
    input: string,
    options?: {
      mode?: 'strict' | 'extended' | 'loose'
      allowMethods?: boolean
      allowComments?: boolean
    }
  ): unknown
  toJSString(value: unknown, indent?: number | string): string | undefined
}

export interface MongoRuntime {
  mongodb: typeof MongoDb
  bson: typeof Bson
  shell: ShellBsonParser
}

let runtime: MongoRuntime | null = null
let loading: Promise<MongoRuntime> | null = null

/** CJS modules imported dynamically: named exports, or everything under `default`. */
function interop<T>(mod: unknown, probe: string): T {
  const m = mod as Record<string, unknown>
  if (m && typeof m[probe] !== 'undefined') return m as T
  return (m?.default ?? m) as T
}

export function loadMongoRuntime(): Promise<MongoRuntime> {
  if (runtime) return Promise.resolve(runtime)
  if (!loading) {
    loading = (async () => {
      const [driverModule, parserModule] = await Promise.all([
        import('mongodb'),
        import('@mongodb-js/shell-bson-parser')
      ])
      const mongodb = interop<typeof MongoDb>(driverModule, 'MongoClient')
      const shell = interop<ShellBsonParser>(parserModule, 'parse')
      const bson = mongodb.BSON as unknown as typeof Bson
      runtime = { mongodb, bson, shell }
      return runtime
    })().catch((error) => {
      loading = null
      throw error
    })
  }
  return loading
}

/** The loaded runtime; callers run after `loadMongoRuntime()` (every driver op connects first). */
export function mongoRuntime(): MongoRuntime {
  if (!runtime) throw new Error('MongoDB runtime is not loaded yet')
  return runtime
}

// ---------------------------------------------------------------------------------------------
// BSON value inspection
// ---------------------------------------------------------------------------------------------

export const bsonTypeOf = (value: unknown): string | undefined =>
  typeof value === 'object' && value !== null && '_bsontype' in value
    ? String((value as { _bsontype: unknown })._bsontype)
    : undefined

/** Plain JS object (documents, sub-documents) as opposed to BSON values, dates, arrays... */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (bsonTypeOf(value) !== undefined) return false
  if (value instanceof Date || value instanceof RegExp || ArrayBuffer.isView(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** BSON type name as Compass shows it (String, Int32, Double, ObjectId, Document, Array...). */
export function bsonTypeName(value: unknown): string {
  if (value === null) return 'Null'
  if (value === undefined) return 'Undefined'
  switch (typeof value) {
    case 'string':
      return 'String'
    case 'boolean':
      return 'Boolean'
    case 'number':
      return Number.isInteger(value) && value >= -2147483648 && value <= 2147483647
        ? 'Int32'
        : 'Double'
    case 'bigint':
      return 'Long'
    default:
      break
  }
  if (Array.isArray(value)) return 'Array'
  if (value instanceof Date) return 'Date'
  if (value instanceof RegExp) return 'RegExp'
  const bsonType = bsonTypeOf(value)
  switch (bsonType) {
    case undefined:
      return ArrayBuffer.isView(value) ? 'Binary' : 'Document'
    case 'Binary':
      return (value as { sub_type?: number }).sub_type === 4 ? 'UUID' : 'Binary'
    case 'BSONRegExp':
      return 'RegExp'
    case 'BSONSymbol':
      return 'Symbol'
    case 'Code':
      return (value as { scope?: unknown }).scope ? 'CodeWScope' : 'Code'
    default:
      return bsonType
  }
}

/** Serialized BSON size of a document read from the server (result byte budgets). */
export function bsonSize(doc: Record<string, unknown>): number {
  return mongoRuntime().bson.calculateObjectSize(doc)
}

/** A JS number from a number or numeric BSON value; null otherwise. */
export function toNumberValue(value: unknown): number | null {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  const bsonType = bsonTypeOf(value)
  if (bsonType === 'Int32' || bsonType === 'Double')
    return Number((value as { valueOf(): number }).valueOf())
  if (bsonType === 'Long') return (value as { toNumber(): number }).toNumber()
  if (bsonType === 'Decimal128') {
    const parsed = Number((value as { toString(): string }).toString())
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// Shell text → BSON values
// ---------------------------------------------------------------------------------------------

const EJSON_WRAPPER_KEYS = new Set([
  '$oid',
  '$date',
  '$numberLong',
  '$numberInt',
  '$numberDouble',
  '$numberDecimal',
  '$binary',
  '$uuid',
  '$timestamp',
  '$regularExpression',
  '$minKey',
  '$maxKey',
  '$symbol',
  '$code'
])

/** Converts canonical/relaxed EJSON wrapper objects ({ "$oid": "…" }) into BSON values. */
export function reviveEjsonWrappers(value: unknown, depth = 0): unknown {
  if (depth > 200) return value
  if (Array.isArray(value)) return value.map((item) => reviveEjsonWrappers(item, depth + 1))
  if (!isPlainObject(value)) return value
  const keys = Object.keys(value)
  const isWrapper =
    (keys.length === 1 && EJSON_WRAPPER_KEYS.has(keys[0])) ||
    // legacy { $binary: '…', $type: '00' } and { $code, $scope }
    (keys.length === 2 && keys.includes('$binary') && keys.includes('$type')) ||
    (keys.length === 2 && keys.includes('$code') && keys.includes('$scope'))
  if (isWrapper) {
    try {
      const revived = mongoRuntime().bson.EJSON.deserialize(value as Bson.Document, {
        relaxed: false
      })
      // `$date` / `$numberDouble` ... become Date / Double: anything not plain was a real wrapper.
      if (!isPlainObject(revived)) return revived
    } catch {
      // Not valid EJSON (e.g. { $oid: 'zz' }): leave the object as typed.
    }
    return value
  }
  const out: Record<string, unknown> = {}
  for (const key of keys) out[key] = reviveEjsonWrappers(value[key], depth + 1)
  return out
}

function invalidInput(message: string, position?: number): DataDriverError {
  return new DataDriverError(message, { code: DATA_ERROR_CODES.invalidInput, position })
}

/**
 * Parses shell/EJSON text into a BSON value. `label` names the field in errors ("Filter");
 * `offset` is where the text starts inside the statement (error positions).
 * Empty text → undefined.
 */
export function parseShellValue(text: string, label: string, offset = 0): unknown {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  const { shell } = mongoRuntime()
  let value: unknown
  try {
    value = shell.parse(text, { mode: 'loose' })
  } catch (error) {
    const pos = (error as { pos?: number }).pos
    const message =
      error instanceof Error
        ? error.message.split('\n')[0].replace(/\s*\(\d+:\d+\)\s*$/, '')
        : String(error)
    // The parser wraps the input as "(\n<input>\n)": shift the position back by 2.
    const position =
      typeof pos === 'number' ? offset + Math.max(0, Math.min(text.length, pos - 2)) : offset
    throw invalidInput(`${label}: ${message.replace(/ in \($/, '')}`, position)
  }
  if (value === '' && !/^(['"])\1$/.test(trimmed)) {
    throw invalidInput(
      `${label}: unsupported or unsafe expression. Use literals, objects, arrays, /regex/ and BSON helpers such as ObjectId('…'), ISODate('…'), NumberLong('…'), NumberDecimal('…'), UUID('…')`,
      offset
    )
  }
  return reviveEjsonWrappers(value)
}

/** Parses an optional object argument (filter, projection, options...). */
export function parseShellObject(
  text: string | undefined,
  label: string
): Record<string, unknown> | undefined {
  if (text === undefined) return undefined
  const value = parseShellValue(text, label)
  if (value === undefined || value === null) return undefined
  if (!isPlainObject(value)) throw invalidInput(`${label} must be an object like { field: value }`)
  return value
}

/** Index hint: a key document, or an index name (quoted or bare). */
export function parseShellHint(
  text: string | undefined
): string | Record<string, unknown> | undefined {
  const trimmed = text?.trim()
  if (!trimmed) return undefined
  if (/^[\w.$-]+$/.test(trimmed) && !/^\d/.test(trimmed)) return trimmed
  const value = parseShellValue(trimmed, 'Hint')
  if (typeof value === 'string' && value) return value
  if (isPlainObject(value)) return value
  throw invalidInput('Hint must be an index name or a key document like { createdAt: -1 }')
}

// ---------------------------------------------------------------------------------------------
// BSON values → JSON-safe output
// ---------------------------------------------------------------------------------------------

/** Canonical EJSON (lossless: { $oid }, { $numberLong }, { $date: { $numberLong } }...). */
export function toCanonical<T = Record<string, unknown>>(value: unknown): T {
  if (value === undefined) return null as T
  return mongoRuntime().bson.EJSON.serialize(value as Bson.Document, { relaxed: false }) as T
}

/** Relaxed EJSON object (numbers as numbers, dates as { $date: ISO }), for JSON exports. */
export function toRelaxed<T = Record<string, unknown>>(value: unknown): T {
  if (value === undefined) return null as T
  return mongoRuntime().bson.EJSON.serialize(value as Bson.Document, { relaxed: true }) as T
}

/** Relaxed EJSON text, cut to `max` characters. */
export function relaxedText(value: unknown, max = 200): string {
  let text: string
  try {
    text =
      typeof value === 'string'
        ? value
        : mongoRuntime().bson.EJSON.stringify(value as Bson.Document, { relaxed: true })
  } catch {
    text = String(value)
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** mongosh-style source text (ObjectId('…'), ISODate('…')), for DDL scripts and history. */
export function toShellText(value: unknown, indent = 2): string {
  try {
    const text = mongoRuntime().shell.toJSString(value, indent)
    if (typeof text === 'string') return text
  } catch {
    // fall through
  }
  return relaxedText(value, Number.MAX_SAFE_INTEGER)
}

/** mongosh-style source text on one line: { email: 1 }, { name: 'email_1', unique: true }. */
export function toShellInline(value: unknown): string {
  // Strings are escaped by the stringifier, so real newlines only come from the indentation.
  return toShellText(value, 2).replace(/\n\s*/g, ' ')
}

/** A short single-line rendering of a scalar for CSV cells / process lists. */
export function scalarText(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (value instanceof RegExp) return value.toString()
  switch (bsonTypeOf(value)) {
    case 'ObjectId':
      return (value as { toHexString(): string }).toHexString()
    case 'Int32':
    case 'Double':
      return toNumberValue(value)
    case 'Long':
    case 'Decimal128':
      return (value as { toString(): string }).toString()
    case 'Binary': {
      const binary = value as {
        sub_type: number
        toUUID?: () => { toString(): string }
        toString(enc: string): string
      }
      if (binary.sub_type === 4 && binary.toUUID) {
        try {
          return binary.toUUID().toString()
        } catch {
          // not a 16-byte UUID: base64 below
        }
      }
      return binary.toString('base64')
    }
    case 'Timestamp': {
      const ts = value as { t?: number; i?: number; high?: number; low?: number }
      return `Timestamp(${ts.t ?? ts.high}, ${ts.i ?? ts.low})`
    }
    case 'BSONRegExp': {
      const re = value as { pattern: string; options: string }
      return `/${re.pattern}/${re.options}`
    }
    case 'MinKey':
      return 'MinKey'
    case 'MaxKey':
      return 'MaxKey'
    case 'Code':
      return (value as { code: string }).code
    case 'BSONSymbol':
      return (value as { value: string }).value
    default:
      return relaxedText(value, 100_000)
  }
}

// Canonical EJSON → shell text for every BSON type the server can send, in both renderings:
// 'display' (the mongosh look) and 'edit' (must parse back to the same BSON). The round-trip
// block runs the edit text through the real server-side parser (@mongodb-js/shell-bson-parser
// in loose mode + the canonical-wrapper revival the server applies) and compares canonical
// EJSON before and after, so a document edit can never silently change a field's type.
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import {
  formatShellDocument,
  formatShellInline,
  formatShellValue,
  mongoValueType,
  quoteShellString,
  shellKey,
  toGridCell,
  toRelaxedEjson,
  toRelaxedJsonText
} from './ejson'

const display = (value: unknown): string => formatShellValue(value, { mode: 'display' })
const edit = (value: unknown): string => formatShellValue(value, { mode: 'edit' })

const UUID_B64 = 'ASNFZ4mrze8BI0VniavN7w==' // 01234567-89ab-cdef-0123-456789abcdef

describe('mongoValueType', () => {
  it.each<[unknown, string]>([
    [{ $oid: '5f0c4a5b8e4b3b0b8c8e4b3b' }, 'objectId'],
    [{ $date: { $numberLong: '1704067200000' } }, 'date'],
    [{ $date: '2024-01-01T00:00:00Z' }, 'date'],
    [{ $numberInt: '5' }, 'int32'],
    [{ $numberLong: '9007199254740993' }, 'int64'],
    [{ $numberDouble: '1.5' }, 'double'],
    [{ $numberDecimal: '1.10' }, 'decimal'],
    [{ $binary: { base64: 'AAEC', subType: '00' } }, 'binary'],
    [{ $binary: { base64: UUID_B64, subType: '04' } }, 'uuid'],
    [{ $binary: 'AAEC', $type: '00' }, 'binary'],
    [{ $regularExpression: { pattern: 'a', options: 'i' } }, 'regex'],
    [{ $timestamp: { t: 1, i: 2 } }, 'timestamp'],
    [{ $minKey: 1 }, 'minKey'],
    [{ $maxKey: 1 }, 'maxKey'],
    [{ $symbol: 's' }, 'symbol'],
    [{ $code: 'f()' }, 'code'],
    [{ $code: 'f()', $scope: { a: 1 } }, 'code'],
    [{ $ref: 'users', $id: { $oid: '5f0c4a5b8e4b3b0b8c8e4b3b' } }, 'dbRef'],
    [{ $undefined: true }, 'undefined'],
    ['x', 'string'],
    [true, 'boolean'],
    [null, 'null'],
    [3, 'int32'],
    [3.5, 'double'],
    [[1], 'array'],
    [{ a: 1 }, 'object'],
    // Wrapper look-alikes with the wrong shape are plain objects.
    [{ $oid: 5 }, 'object'],
    [{ $oid: 'x', other: 1 }, 'object']
  ])('%# → %s', (value, type) => {
    expect(mongoValueType(value)).toBe(type)
  })
})

describe('formatShellValue (display)', () => {
  it('renders every BSON type the mongosh way', () => {
    expect(display({ $oid: '5f0c4a5b8e4b3b0b8c8e4b3b' })).toBe(
      "ObjectId('5f0c4a5b8e4b3b0b8c8e4b3b')"
    )
    expect(display({ $date: { $numberLong: '1704067200000' } })).toBe(
      "ISODate('2024-01-01T00:00:00.000Z')"
    )
    expect(display({ $date: '2024-01-01T00:00:00Z' })).toBe("ISODate('2024-01-01T00:00:00.000Z')")
    expect(display({ $numberLong: '9007199254740993' })).toBe("NumberLong('9007199254740993')")
    expect(display({ $numberInt: '-7' })).toBe('-7')
    expect(display({ $numberDouble: '1.5' })).toBe('1.5')
    expect(display({ $numberDouble: '1.0' })).toBe('1')
    expect(display({ $numberDouble: 'Infinity' })).toBe('Infinity')
    expect(display({ $numberDouble: '-Infinity' })).toBe('-Infinity')
    expect(display({ $numberDouble: 'NaN' })).toBe('NaN')
    expect(display({ $numberDecimal: '1.10' })).toBe("NumberDecimal('1.10')")
    expect(display({ $binary: { base64: 'AAEC', subType: '00' } })).toBe("BinData(0, 'AAEC')")
    expect(display({ $binary: { base64: UUID_B64, subType: '04' } })).toBe(
      "UUID('01234567-89ab-cdef-0123-456789abcdef')"
    )
    expect(display({ $uuid: '01234567-89ab-cdef-0123-456789abcdef' })).toBe(
      "UUID('01234567-89ab-cdef-0123-456789abcdef')"
    )
    expect(display({ $regularExpression: { pattern: '^jo', options: 'i' } })).toBe('/^jo/i')
    expect(display({ $regularExpression: { pattern: 'a/b', options: '' } })).toBe('/a\\/b/')
    expect(display({ $timestamp: { t: 1700000000, i: 3 } })).toBe(
      'Timestamp({ t: 1700000000, i: 3 })'
    )
    expect(display({ $minKey: 1 })).toBe('MinKey()')
    expect(display({ $maxKey: 1 })).toBe('MaxKey()')
    expect(display({ $symbol: 'sym' })).toBe("Symbol('sym')")
    expect(display({ $code: 'function () { return 1 }' })).toBe("Code('function () { return 1 }')")
    expect(display({ $code: 'f()', $scope: { a: { $numberInt: '1' } } })).toBe(
      "Code('f()', { a: 1 })"
    )
    expect(display({ $ref: 'users', $id: { $oid: '5f0c4a5b8e4b3b0b8c8e4b3b' }, $db: 'shop' })).toBe(
      "DBRef('users', ObjectId('5f0c4a5b8e4b3b0b8c8e4b3b'), 'shop')"
    )
    expect(display({ $undefined: true })).toBe('undefined')
    expect(display("it's\n")).toBe("'it\\'s\\n'")
    expect(display(null)).toBe('null')
    expect(display(false)).toBe('false')
  })

  it('shortens long binary payloads only for display', () => {
    const base64 = 'A'.repeat(200)
    expect(formatShellValue({ $binary: { base64, subType: '00' } }, { maxBinaryChars: 8 })).toBe(
      "BinData(0, 'AAAAAAAA…')"
    )
    expect(edit({ $binary: { base64, subType: '00' } })).toBe(`BinData(0, '${base64}')`)
  })

  it('keeps short containers on one line and breaks long ones (mongosh layout)', () => {
    const doc = {
      _id: { $oid: '5f0c4a5b8e4b3b0b8c8e4b3b' },
      tags: ['a', 'b'],
      address: { city: 'Tel Aviv', zip: { $numberInt: '61000' } },
      'odd key': true,
      empty: {},
      none: []
    }
    expect(formatShellDocument(doc, 'display')).toBe(
      [
        '{',
        "  _id: ObjectId('5f0c4a5b8e4b3b0b8c8e4b3b'),",
        "  tags: [ 'a', 'b' ],",
        "  address: { city: 'Tel Aviv', zip: 61000 },",
        "  'odd key': true,",
        '  empty: {},',
        '  none: []',
        '}'
      ].join('\n')
    )
    expect(formatShellInline(doc, 40)).toHaveLength(40)
    expect(formatShellInline({ a: 1 })).toBe('{ a: 1 }')
  })
})

describe('formatShellValue (edit)', () => {
  it('spells types that a bare literal would change', () => {
    expect(edit({ $numberDouble: '1.0' })).toBe('Double(1)')
    expect(edit({ $numberDouble: '-0.0' })).toBe('Double(-0)')
    expect(edit({ $numberDouble: '2.25' })).toBe('2.25')
    expect(edit({ $numberInt: '1' })).toBe('1')
    expect(edit({ $date: { $numberLong: '253402300800000' } })).toBe('new Date(253402300800000)')
    expect(edit({ $date: { $numberLong: '9223372036854775807' } })).toBe(
      "{ $date: { $numberLong: '9223372036854775807' } }"
    )
    expect(edit({ $regularExpression: { pattern: 'a b', options: 'x' } })).toBe(
      "{ $regularExpression: { pattern: 'a b', options: 'x' } }"
    )
    expect(edit({ $regularExpression: { pattern: 'a/b', options: 'i' } })).toBe(
      "{ $regularExpression: { pattern: 'a/b', options: 'i' } }"
    )
    expect(edit({ $regularExpression: { pattern: '(?<y>\\d+)', options: '' } })).toContain(
      '$regularExpression'
    )
    expect(edit({ $regularExpression: { pattern: '^ab+', options: 'im' } })).toBe('/^ab+/im')
  })
})

describe('keys and strings', () => {
  it('quotes keys that are not identifiers', () => {
    expect(shellKey('name')).toBe('name')
    expect(shellKey('$set')).toBe('$set')
    expect(shellKey('a.b')).toBe("'a.b'")
    expect(shellKey('1st')).toBe("'1st'")
    expect(quoteShellString(' \u0001')).toBe("'\\u2028\\x01'")
  })
})

describe('relaxed EJSON and grid cells', () => {
  it('converts canonical to relaxed without losing precision', () => {
    expect(
      toRelaxedEjson({
        i: { $numberInt: '5' },
        d: { $numberDouble: '1.5' },
        inf: { $numberDouble: 'Infinity' },
        small: { $numberLong: '42' },
        big: { $numberLong: '9007199254740993' },
        at: { $date: { $numberLong: '0' } },
        old: { $date: { $numberLong: '-1000' } },
        nested: [{ n: { $numberInt: '1' } }]
      })
    ).toEqual({
      i: 5,
      d: 1.5,
      inf: { $numberDouble: 'Infinity' },
      small: 42,
      big: { $numberLong: '9007199254740993' },
      at: { $date: '1970-01-01T00:00:00.000Z' },
      old: { $date: { $numberLong: '-1000' } },
      nested: [{ n: 1 }]
    })
    expect(toRelaxedJsonText({ a: { $numberInt: '1' } }, 0)).toBe('{"a":1}')
  })

  it('maps values to JSON-safe grid cells', () => {
    expect(toGridCell({ $oid: 'abc' })).toBe("ObjectId('abc')")
    expect(toGridCell({ $numberInt: '7' })).toBe(7)
    expect(toGridCell({ $numberLong: '9007199254740993' })).toBe('9007199254740993')
    expect(toGridCell({ $numberDecimal: '0.1' })).toBe('0.1')
    expect(toGridCell({ $numberDouble: 'NaN' })).toBe('NaN')
    expect(toGridCell({ $date: { $numberLong: '0' } })).toBe('1970-01-01T00:00:00.000Z')
    expect(toGridCell({ $binary: { base64: 'AAEC', subType: '00' } })).toEqual({
      $t: 'bin',
      hex: '000102',
      len: 3
    })
    expect(toGridCell({ a: { $numberInt: '1' } })).toBe('{"a":1}')
    expect(toGridCell([1, 'x'])).toBe('[1,"x"]')
    expect(toGridCell(null)).toBe(null)
    expect(toGridCell(true)).toBe(true)
  })
})

// ---- Round trip through the server's parser -------------------------------------------------

interface ShellParser {
  parse(input: string, options: { mode: 'loose' }): unknown
}
interface BsonModule {
  EJSON: {
    serialize(value: unknown, options: { relaxed: boolean }): unknown
    deserialize(value: unknown, options: { relaxed: boolean }): unknown
  }
}

const requireNode = createRequire(import.meta.url)
let shell: ShellParser | null = null
let bson: BsonModule | null = null
try {
  shell = requireNode('@mongodb-js/shell-bson-parser') as ShellParser
  bson = requireNode('bson') as BsonModule
} catch {
  shell = null
}

/** The server's post-pass: objects whose only key is a canonical wrapper become BSON values. */
function revive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(revive)
  if (typeof value !== 'object' || value === null) return value
  const proto = Object.getPrototypeOf(value)
  if (proto !== null && proto !== Object.prototype) return value
  const keys = Object.keys(value)
  if (keys.length === 1 && keys[0].startsWith('$')) {
    try {
      return bson!.EJSON.deserialize(value, { relaxed: false })
    } catch {
      return value
    }
  }
  const out: Record<string, unknown> = {}
  for (const key of keys) out[key] = revive((value as Record<string, unknown>)[key])
  return out
}

const roundTrip = shell && bson ? it : it.skip

describe('edit text round trip (server parser)', () => {
  roundTrip('parses back to identical canonical EJSON for every type', () => {
    const doc = {
      _id: { $oid: '5f0c4a5b8e4b3b0b8c8e4b3b' },
      date: { $date: { $numberLong: '1704067200123' } },
      farDate: { $date: { $numberLong: '253402300800000' } },
      oldDate: { $date: { $numberLong: '-62167219200001' } },
      i32: { $numberInt: '-42' },
      i64: { $numberLong: '9007199254740993' },
      dbl: { $numberDouble: '1.0' },
      frac: { $numberDouble: '0.1' },
      negZero: { $numberDouble: '-0.0' },
      inf: { $numberDouble: 'Infinity' },
      ninf: { $numberDouble: '-Infinity' },
      nan: { $numberDouble: 'NaN' },
      dec: { $numberDecimal: '1.10' },
      bin: { $binary: { base64: 'AAECAwQ=', subType: '00' } },
      legacyUuid: { $binary: { base64: UUID_B64, subType: '03' } },
      uuid: { $binary: { base64: UUID_B64, subType: '04' } },
      custom: { $binary: { base64: 'AQ==', subType: '80' } },
      re: { $regularExpression: { pattern: '^jo', options: 'i' } },
      reSlash: { $regularExpression: { pattern: 'a/b', options: '' } },
      reX: { $regularExpression: { pattern: 'a # c', options: 'x' } },
      ts: { $timestamp: { t: 1700000000, i: 7 } },
      min: { $minKey: 1 },
      max: { $maxKey: 1 },
      sym: { $symbol: 'sym' },
      code: { $code: 'function () { return 1 }' },
      codeScope: { $code: 'f()', $scope: { a: { $numberInt: '1' } } },
      ref: { $ref: 'users', $id: { $oid: '5f0c4a5b8e4b3b0b8c8e4b3b' }, $db: 'shop' },
      str: 'it\'s "quoted"\n\ttab  ',
      bool: true,
      nil: null,
      arr: [{ $numberInt: '1' }, { $numberDouble: '2.0' }, 'three', [], {}],
      nested: { 'a.b': { deep: { $numberLong: '1' } }, $weird: 1 === 1 }
    }
    const text = formatShellDocument(doc, 'edit')
    const parsed = revive(shell!.parse(text, { mode: 'loose' }))
    expect(bson!.EJSON.serialize(parsed, { relaxed: false })).toEqual(doc)
  })
})

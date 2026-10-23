// Import (import.ts) hardening: Mongo field paths that would reach a prototype, linear-time
// number detection, exact JSON integers beyond 2^53, invalid bytes far past the detection
// window, NULL rows of one-column CSV files, non-transactional MySQL tables, sessions with
// autocommit off, and dates of the years 0–99. Pure functions plus the start flow over the
// engine with a scriptable fake driver; no database, no Electron.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BSON } from 'bson'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type {
  DataImportResponse,
  DataImportStartRequest
} from '../../../../shared/data-projects/import-types'
import type { DataTableDetails } from '../../../../shared/data-projects/types'
import { DataDriverError, type DataProjectRecord, type DriverConnectInput } from '../contracts'
import { noopLogger } from '../connection-manager'
import { createDataEngineService, type DataEngineServiceInternals } from '../engine-service'
import {
  buildMongoDocument,
  clearImportScanCache,
  convertMongoValue,
  CsvParser,
  detectHeader,
  inferMongoType,
  parseImportDate,
  parseJsonDocument,
  transactionSupport,
  validateMongoFieldPaths,
  type CsvRecord,
  type MongoFieldSpec
} from '../import'
import { createSafetyGate } from '../safety-gate'
import {
  FakeDriver,
  MemoryRepository,
  MemorySecrets,
  makeRecord,
  rowsOutput
} from './engine-fixtures'

const bson = BSON as unknown as typeof import('bson')

type Polluted = Record<string, unknown>
const probe = (): Polluted => ({}) as Polluted

const spec = (path: string[], type: MongoFieldSpec['type'] = 'string', source = 0) => ({
  source,
  name: path.join('.'),
  path,
  type
})

// ---------------------------------------------------------------------------------------------
// Prototype pollution
// ---------------------------------------------------------------------------------------------

describe('Mongo field paths never reach a prototype', () => {
  const names = ['vimpPolluted', 'vimpPolluted2', 'vimpPolluted3', 'toString']
  afterEach(() => {
    // Only reached when a test failed: leave the process clean for the others.
    for (const name of names.slice(0, 3)) delete (Object.prototype as Polluted)[name]
  })

  it('builds __proto__ / constructor.prototype paths as plain own fields', () => {
    const doc = buildMongoDocument(
      ['yes', 'yes2', 'bob'],
      [
        spec(['__proto__', 'vimpPolluted'], 'string', 0),
        spec(['constructor', 'prototype', 'vimpPolluted2'], 'string', 1),
        spec(['name'], 'string', 2)
      ],
      'null',
      bson
    )
    expect(probe().vimpPolluted).toBeUndefined()
    expect(probe().vimpPolluted2).toBeUndefined()
    expect(Object.getPrototypeOf(doc)).toBe(Object.prototype)
    expect(Object.keys(doc)).toEqual(['__proto__', 'constructor', 'name'])
    expect(Object.getOwnPropertyDescriptor(doc, '__proto__')?.value).toEqual({
      vimpPolluted: 'yes'
    })
    expect(Object.getOwnPropertyDescriptor(doc, 'constructor')?.value).toEqual({
      prototype: { vimpPolluted2: 'yes2' }
    })
    // BSON keeps them as ordinary fields.
    const back = bson.deserialize(bson.serialize(doc))
    expect(Object.getOwnPropertyDescriptor(back, '__proto__')?.value).toEqual({
      vimpPolluted: 'yes'
    })
    expect(back.name).toBe('bob')
    expect(probe().vimpPolluted).toBeUndefined()
  })

  it('a field named __proto__ does not replace the document prototype', () => {
    const doc = buildMongoDocument(['x'], [spec(['__proto__'])], 'null', bson)
    expect(Object.getPrototypeOf(doc)).toBe(Object.prototype)
    expect(Object.getOwnPropertyDescriptor(doc, '__proto__')?.value).toBe('x')
  })

  it('`__proto__.toString` cannot break String() of every object', () => {
    buildMongoDocument(['boom'], [spec(['__proto__', 'toString'])], 'null', bson)
    expect(String({})).toBe('[object Object]')
    expect(`${{}}`).toBe('[object Object]')
  })

  it('refuses a path through a value it did not create', () => {
    expect(() =>
      buildMongoDocument(
        ['1', '2'],
        [spec(['a'], 'string', 0), spec(['a', 'b'], 'string', 1)],
        'null',
        bson
      )
    ).toThrow(/"a" already holds a value/)
  })

  it('validateMongoFieldPaths refuses __proto__, constructor and prototype parts', () => {
    for (const name of ['__proto__.vimp', 'constructor.prototype.vimp', 'a.prototype', '__proto__'])
      expect(() => validateMongoFieldPaths([name, 'name'])).toThrow(/cannot be a field name/)
    expect(validateMongoFieldPaths(['proto', 'a.constructors', '_proto_'])).toEqual([
      ['proto'],
      ['a', 'constructors'],
      ['_proto_']
    ])
  })
})

// ---------------------------------------------------------------------------------------------
// Numbers: linear time, long values are text
// ---------------------------------------------------------------------------------------------

describe('number detection runs in linear time', () => {
  it('a long run of digits followed by a non-digit costs nothing', () => {
    const long = `${'1'.repeat(200_000)}x`
    const t0 = performance.now()
    expect(detectHeader([[long]])).toBe(true) // text, so a header
    expect(inferMongoType([long, long])).toBe('string')
    expect(convertMongoValue(long, 'auto', bson)).toBe(long)
    expect(() => convertMongoValue(long, 'number', bson)).toThrow(/is not a number/)
    expect(() => convertMongoValue(long, 'double', bson)).toThrow(/is not a number/)
    expect(() => convertMongoValue(long, 'decimal', bson)).toThrow(/is not a decimal/)
    const digits = '9'.repeat(1_000_000)
    expect(() => convertMongoValue(digits, 'int64', bson)).toThrow(/Int64 range/)
    expect((convertMongoValue(digits, 'number', bson) as { _bsontype: string })._bsontype).toBe(
      'Double'
    )
    expect(convertMongoValue(digits, 'auto', bson)).toBe(digits) // too long to be a number
    expect(performance.now() - t0).toBeLessThan(1000)
  })

  it('accepts and refuses the same values as before', () => {
    const yes = ['1', '1.', '.5', '1.e5', '+.5e-3', '-12.25E+2', '00', '0.0', '7e0']
    const no = ['.e5', '1..2', 'e5', '1e', '.', '+', '1e+', '--1', '1.2.3', '0x10', '1 2']
    for (const t of yes) expect(() => convertMongoValue(t, 'double', bson), t).not.toThrow()
    for (const t of no)
      expect(() => convertMongoValue(t, 'double', bson), t).toThrow(/is not a number/)
    expect(detectHeader([['id', '12.5']])).toBe(false)
    expect(inferMongoType(['1', '2.5', '-3e2'])).toBe('number')
  })

  it('keeps integers exact up to Int64 and with leading zeros', () => {
    const long = convertMongoValue('000000000000000000000000009223372036854775807', 'int64', bson)
    expect(String(long)).toBe('9223372036854775807')
    expect(() => convertMongoValue('9223372036854775808', 'int64', bson)).toThrow(/Int64 range/)
    expect(String(convertMongoValue('-9223372036854775808', 'number', bson))).toBe(
      '-9223372036854775808'
    )
  })
})

// ---------------------------------------------------------------------------------------------
// JSON: exact integers beyond 2^53
// ---------------------------------------------------------------------------------------------

describe('JSON documents keep big integers exact', () => {
  const typeOf = (v: unknown): string => (v as { _bsontype?: string })._bsontype ?? typeof v

  it('reads integers beyond ±2^53 as exact Longs, the rest as before', () => {
    const parsed = parseJsonDocument(
      '{"n": 9007199254740993, "m": -1234567890123456789, "max": 9223372036854775807, "i": 5, "l": 5000000000, "d": 1.5, "z": -0, "e": 1e20, "h": 123456789012345678901234, "a": [9007199254740995, {"x": 18014398509481985}], "s": "9007199254740993", "at": {"$date": {"$numberLong": "1704067200000"}}}',
      bson
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const doc = parsed.doc as Record<string, unknown>
    expect(typeOf(doc.n)).toBe('Long')
    expect(String(doc.n)).toBe('9007199254740993')
    expect(String(doc.m)).toBe('-1234567890123456789')
    expect(String(doc.max)).toBe('9223372036854775807')
    expect(typeOf(doc.i)).toBe('Int32')
    expect(typeOf(doc.l)).toBe('Long')
    expect(typeOf(doc.d)).toBe('Double')
    expect(typeOf(doc.z)).toBe('Double')
    expect(Object.is((doc.z as { value: number }).value, -0)).toBe(true)
    expect(typeOf(doc.e)).toBe('Double')
    expect(typeOf(doc.h)).toBe('Double') // beyond Int64: a Double, like mongoimport
    expect(parsed.outOfRange).toBe(true)
    const a = doc.a as unknown[]
    expect(String(a[0])).toBe('9007199254740995')
    expect(String((a[1] as Record<string, unknown>).x)).toBe('18014398509481985')
    expect(doc.s).toBe('9007199254740993')
    expect(doc.at).toBeInstanceOf(Date)
    // The BSON written is exact too.
    const back = bson.deserialize(bson.serialize(doc), { useBigInt64: true })
    expect(back.n).toBe(9007199254740993n)
    expect(back.m).toBe(-1234567890123456789n)
  })

  it('is the plain EJSON reading without long digit runs', () => {
    const parsed = parseJsonDocument('{"a": 1, "b": 2.0, "c": -0, "d": 12345678901}', bson)
    expect(parsed.ok && parsed.outOfRange).toBeFalsy()
    if (!parsed.ok) return
    expect(typeOf(parsed.doc.a)).toBe('Int32')
    expect(typeOf(parsed.doc.c)).toBe('Double')
    expect(typeOf(parsed.doc.d)).toBe('Long')
  })

  it('refuses scalars, arrays and top-level Extended JSON values, and broken JSON', () => {
    expect(parseJsonDocument('9007199254740993', bson)).toMatchObject({ ok: false })
    expect(parseJsonDocument('[1]', bson)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/not a JSON object/)
    })
    expect(parseJsonDocument('{"$oid": "507f1f77bcf86cd799439011"}', bson)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/Extended JSON value/)
    })
    expect(parseJsonDocument('{"n": 90071992547409930,}', bson)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/^Invalid JSON/)
    })
  })

  it('a __proto__ key stays an ordinary field', () => {
    const parsed = parseJsonDocument('{"__proto__": {"vimpJson": 1}, "n": 9007199254740993}', bson)
    expect(parsed.ok).toBe(true)
    expect(probe().vimpJson).toBeUndefined()
    if (parsed.ok) expect(Object.getPrototypeOf(parsed.doc)).toBe(Object.prototype)
  })
})

// ---------------------------------------------------------------------------------------------
// Dates of the years 0–99
// ---------------------------------------------------------------------------------------------

describe('dates of the years 0000–0099', () => {
  it('are not moved to 1900–1999', () => {
    expect(parseImportDate('0001-01-01T00:00:00', false)?.toISOString()).toBe(
      '0001-01-01T00:00:00.000Z'
    )
    expect(parseImportDate('0099-12-31', false)?.toISOString()).toBe('0099-12-31T00:00:00.000Z')
    expect(parseImportDate('0000-02-29', false)?.toISOString()).toBe('0000-02-29T00:00:00.000Z')
    expect(parseImportDate('0001-02-29', false)).toBeNull()
    expect(parseImportDate('0100-01-01', false)?.toISOString()).toBe('0100-01-01T00:00:00.000Z')
    expect(parseImportDate('0001-01-01T00:30:00+01:00', false)?.toISOString()).toBe(
      '0000-12-31T23:30:00.000Z'
    )
    expect(parseImportDate('2024-02-30', false)).toBeNull()
    expect(parseImportDate('2024-05-01 10:00:00.123456Z', false)?.toISOString()).toBe(
      '2024-05-01T10:00:00.123Z'
    )
    expect((convertMongoValue('0001-01-01', 'date', bson) as Date).getUTCFullYear()).toBe(1)
    expect((convertMongoValue('0042-06-01', 'auto', bson) as Date).getUTCFullYear()).toBe(42)
    expect(inferMongoType(['0001-01-01', '2024-01-01'])).toBe('date')
  })
})

// ---------------------------------------------------------------------------------------------
// CSV blank lines
// ---------------------------------------------------------------------------------------------

describe('CsvParser blank lines', () => {
  const parse = (text: string, keepBlankLines: boolean, chunk = 0): CsvRecord[] => {
    const parser = new CsvParser({ delimiter: ',', quote: '"', keepBlankLines })
    const out: CsvRecord[] = []
    if (chunk > 0)
      for (let i = 0; i < text.length; i += chunk) parser.push(text.slice(i, i + chunk), out)
    else parser.push(text, out)
    parser.end(out)
    return out
  }

  it('skips them by default and keeps them (as [null]) when asked, for every chunking', () => {
    const text = 'v\r\n\r\nx\r\n\r\n""\r\n'
    expect(parse(text, false).map((r) => r.fields)).toEqual([['v'], ['x'], ['']])
    for (const chunk of [0, 1, 2, 3])
      expect(parse(text, true, chunk)).toEqual([
        { fields: ['v'], line: 1 },
        { fields: [null], line: 2, blank: true },
        { fields: ['x'], line: 3 },
        { fields: [null], line: 4, blank: true },
        { fields: [''], line: 5 }
      ])
    // The last line break makes no blank record.
    expect(parse('v\nx\n', true)).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------------------------
// Engine flow (fake driver)
// ---------------------------------------------------------------------------------------------

describe('import hardening through the engine (fake driver)', () => {
  let dir = ''
  let engines: DataEngineServiceInternals[] = []
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tedooo-import-hardening-'))
  })
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })
  afterEach(async () => {
    for (const e of engines) await e.shutdown()
    engines = []
    clearImportScanCache()
  })

  const twoColumns: DataTableDetails = {
    ref: { name: 'items', schema: 'public', database: 'shop' },
    kind: 'table',
    columns: [
      { name: 'id', type: 'integer', nullable: false, isPrimaryKey: true, ordinal: 1 },
      { name: 'name', type: 'text', nullable: true, isPrimaryKey: false, ordinal: 2 }
    ],
    indexes: [],
    foreignKeys: [],
    triggers: [],
    primaryKey: ['id']
  }

  const setup = (
    record: Partial<DataProjectRecord> = {},
    details: DataTableDetails = twoColumns
  ) => {
    const repo = new MemoryRepository([makeRecord({ safeMode: 'off', ...record })])
    const drivers: FakeDriver[] = []
    let configure: (d: FakeDriver) => void = () => {}
    const engine = createDataEngineService({
      repository: repo,
      secrets: new MemorySecrets(),
      publish: () => {},
      createDriver: (input: DriverConnectInput) => {
        const d = new FakeDriver(input)
        d.details = details
        configure(d)
        drivers.push(d)
        return d
      },
      gate: createSafetyGate(),
      logger: noopLogger
    })
    engines.push(engine)
    return {
      engine,
      drivers,
      configure: (fn: (d: FakeDriver) => void) => {
        configure = fn
        drivers.forEach(fn)
      }
    }
  }

  const file = async (name: string, content: string | Uint8Array): Promise<string> => {
    const path = join(dir, name)
    await writeFile(path, content)
    return path
  }

  const request = (
    filePath: string,
    extra: Partial<DataImportStartRequest> = {}
  ): DataImportStartRequest => ({
    dataProjectId: 'dp-1',
    importId: `imp-${Math.random().toString(36).slice(2)}`,
    filePath,
    target: { kind: 'table', ref: { name: 'items', schema: 'public', database: 'shop' } },
    format: 'csv',
    encoding: 'utf-8',
    csv: { delimiter: ',', quote: '"', header: true },
    columns: [
      { source: 0, target: 'id' },
      { source: 1, target: 'name' }
    ],
    empty: 'null',
    onError: 'rollback',
    ...extra
  })

  const statements = (d: FakeDriver): string[] => d.calls.map((c) => c.statement)
  const inserts = (d: FakeDriver): string[] => statements(d).filter((s) => s.startsWith('INSERT'))

  // -- prototype pollution -----------------------------------------------------------------

  it('refuses a Mongo mapping through __proto__ before reading the file (read-only too)', async () => {
    const h = setup({ engine: 'mongodb', safeMode: 'read-only' })
    const path = await file('proto.csv', '__proto__.vimpEngine,name\nyes,bob\n')
    for (const target of ['__proto__.vimpEngine', 'constructor.prototype.vimpEngine']) {
      await expect(
        h.engine.importStart(
          request(path, {
            target: { kind: 'collection', database: 'shop', collection: 'c' },
            columns: [
              { source: 0, target, type: 'string' },
              { source: 1, target: 'name', type: 'string' }
            ],
            empty: 'omit',
            onError: 'stop'
          }),
          { clientId: null }
        )
      ).rejects.toThrow(/cannot be a field name/)
    }
    expect(probe().vimpEngine).toBeUndefined()
  })

  // -- invalid bytes -------------------------------------------------------------------------

  it('refuses invalid UTF-8 far past the detection window, with its line, before writing', async () => {
    const h = setup()
    const rows = Array.from({ length: 30_000 }, (_, i) => `${i + 1},name${i + 1}`).join('\n')
    const bytes = Buffer.concat([
      Buffer.from(`id,name\n${rows}\n`),
      Buffer.from([0x33, 0x30, 0x30, 0x30, 0x31, 0x2c, 0x63, 0x61, 0x66, 0xe9, 0x0a]) // 30001,caf\xE9
    ])
    expect(bytes.length).toBeGreaterThan(256 * 1024)
    const path = await file('late-latin1.csv', bytes)
    const res = (await h.engine.importStart(request(path, { onError: 'stop' }), {
      clientId: null
    })) as Extract<DataImportResponse, { status: 'failed' }>
    expect(res.status).toBe('failed')
    expect(res.message).toMatch(
      /^Nothing was imported: Row 30,001 \(line 30,002\): The file is not valid UTF-8 at byte/
    )
    expect(res.message).toContain('Windows-1252')
    expect(res.errors[0]).toMatchObject({ row: 30_001, line: 30_002 })
    expect(res.errors[0].message).toContain(`at byte ${(bytes.length - 1).toLocaleString('en-US')}`)
    expect(h.drivers.flatMap(inserts)).toEqual([])

    // Read as Windows-1252 it imports, é included.
    const ok = await h.engine.importStart(
      request(path, { onError: 'stop', encoding: 'windows-1252' }),
      { clientId: null }
    )
    expect(ok).toMatchObject({ status: 'ok', rowsImported: 30_001 })
    expect(inserts(h.drivers[0]).join('\n')).toContain("('30001', 'café')")
  })

  it('pins the byte down and keeps multi-byte characters split across chunks', async () => {
    const h = setup()
    // é exactly across the 256 KB chunk boundary, then an emoji across the next one.
    const head = 'id,name\n'
    const fill = (n: number): string => `1,${'a'.repeat(n)}`
    const chunk = 256 * 1024
    const first = fill(chunk - 1 - Buffer.byteLength(head) - 2) // ends one byte before the boundary
    const text = `${head}${first}é\n2,${'b'.repeat(chunk - 6)}😀\n3,x\n`
    const buffer = Buffer.from(text)
    expect(buffer[chunk - 1]).toBe(0xc3) // é starts on the last byte of chunk 1
    const path = await file('split.csv', buffer)
    const res = await h.engine.importStart(request(path, { onError: 'stop' }), { clientId: null })
    expect(res).toMatchObject({ status: 'ok', rowsImported: 3 })
    const sql = inserts(h.drivers[0]).join('\n')
    expect(sql).toContain("aé')")
    expect(sql).toContain("b😀')")

    // A lead byte that never gets its continuation: the exact byte and line.
    const bad = await file(
      'bad-lead.csv',
      Buffer.from([...Buffer.from('id,name\n1,caf'), 0xe9, 0x0a])
    )
    const failed = (await h.engine.importStart(request(bad, { onError: 'stop' }), {
      clientId: null
    })) as Extract<DataImportResponse, { status: 'failed' }>
    expect(failed.errors[0]).toMatchObject({ row: 1, line: 2 })
    expect(failed.errors[0].message).toContain('not valid UTF-8 at byte 14.')

    // The file ends inside a character.
    const cut = await file('cut.csv', Buffer.from([...Buffer.from('id,name\n1,caf'), 0xc3]))
    const ended = (await h.engine.importStart(request(cut, { onError: 'stop' }), {
      clientId: null
    })) as Extract<DataImportResponse, { status: 'failed' }>
    expect(ended.errors[0].message).toContain('ends inside a UTF-8 character (byte 14)')

    // A stray continuation byte after a complete é: that byte, not the é.
    const stray = await file(
      'stray.csv',
      Buffer.concat([Buffer.from('id,name\n1,café'), Buffer.from([0x80, 0x0a])])
    )
    const strayRes = (await h.engine.importStart(request(stray, { onError: 'stop' }), {
      clientId: null
    })) as Extract<DataImportResponse, { status: 'failed' }>
    expect(strayRes.errors[0].message).toContain('not valid UTF-8 at byte 16.')

    // A lead byte that ends chunk 1, broken by the first byte of chunk 2: the lead's byte and
    // line.
    const lines = 'id,name\n1,a\n2,b\n'
    const pad = `3,${'c'.repeat(chunk - Buffer.byteLength(lines) - 3)}`
    const across = Buffer.concat([
      Buffer.from(lines + pad),
      Buffer.from([0xe2]),
      Buffer.from('Z\n')
    ])
    expect(across[chunk - 1]).toBe(0xe2)
    const acrossRes = (await h.engine.importStart(
      request(await file('across.csv', across), { onError: 'stop' }),
      { clientId: null }
    )) as Extract<DataImportResponse, { status: 'failed' }>
    expect(acrossRes.errors[0]).toMatchObject({ row: 3, line: 4 })
    expect(acrossRes.errors[0].message).toContain(
      `not valid UTF-8 at byte ${chunk.toLocaleString('en-US')}.`
    )
  })

  it('refuses an unpaired UTF-16 surrogate', async () => {
    const h = setup()
    const body = Buffer.from('id,name\n1,a\n2,', 'utf16le')
    const lone = Buffer.from([0x00, 0xd8]) // U+D800 alone (LE)
    const path = await file(
      'u16.csv',
      Buffer.concat([Buffer.from([0xff, 0xfe]), body, lone, Buffer.from('x\n', 'utf16le')])
    )
    const res = (await h.engine.importStart(
      request(path, { onError: 'stop', encoding: 'utf-16le' }),
      { clientId: null }
    )) as Extract<DataImportResponse, { status: 'failed' }>
    expect(res.status).toBe('failed')
    expect(res.message).toContain('not valid UTF-16 LE')
    expect(res.errors[0]).toMatchObject({ row: 2, line: 3 })
  })

  it('the preview still shows the rows and warns about invalid bytes', async () => {
    const h = setup()
    const path = await file(
      'latin1-head.csv',
      Buffer.from([...Buffer.from('id,name\n1,caf'), 0xe9, 0x0a, ...Buffer.from('2,b\n')])
    )
    const preview = await h.engine.importPreview({
      dataProjectId: 'dp-1',
      filePath: path,
      encoding: 'utf-8',
      target: { kind: 'table', ref: { name: 'items', schema: 'public', database: 'shop' } }
    })
    expect(preview.rows).toEqual([
      ['1', 'caf�'],
      ['2', 'b']
    ])
    expect(preview.warnings.join('\n')).toMatch(/^Line 2: The file is not valid UTF-8 at byte 14/m)
  })

  // -- one-column NULL rows -------------------------------------------------------------------

  it('one-column files: blank lines are NULL rows (our export round-trips); elsewhere skipped', async () => {
    const oneColumn: DataTableDetails = {
      ...twoColumns,
      columns: [{ name: 'v', type: 'text', nullable: true, isPrimaryKey: false, ordinal: 1 }],
      primaryKey: []
    }
    const h = setup({}, oneColumn)
    const path = await file('one.csv', '\r\nv\r\n\r\nx\r\n\r\n""\r\n\r\n')
    const req = request(path, { columns: [{ source: 0, target: 'v' }], onError: 'stop' })
    const res = await h.engine.importStart(req, { clientId: null })
    expect(res).toMatchObject({ status: 'ok', rowsRead: 5, rowsImported: 5 })
    expect(inserts(h.drivers[0])).toEqual([
      `INSERT INTO "public"."items" ("v") VALUES (NULL), ('x'), (NULL), (''), (NULL)`
    ])
    const preview = await h.engine.importPreview({
      dataProjectId: 'dp-1',
      filePath: path,
      target: { kind: 'table', ref: { name: 'items', schema: 'public', database: 'shop' } }
    })
    expect(preview.columns).toEqual(['v'])
    expect(preview.rows).toEqual([[null], ['x'], [null], [''], [null]])
    expect(preview.warnings.join(' ')).toContain('each blank line is a row with an empty value')

    // Without a header the first record sets the width the same way.
    const noHeader = await file('one-nh.csv', 'x\n\ny\n')
    const res2 = await h.engine.importStart(
      request(noHeader, {
        csv: { delimiter: ',', quote: '"', header: false },
        columns: [{ source: 0, target: 'v' }],
        onError: 'stop'
      }),
      { clientId: null }
    )
    expect(res2).toMatchObject({ status: 'ok', rowsImported: 3 })

    // Two columns: a blank line is nothing.
    const h2 = setup()
    const two = await file('two.csv', 'id,name\r\n\r\n1,a\r\n\r\n2,\r\n')
    const res3 = await h2.engine.importStart(request(two, { onError: 'stop' }), { clientId: null })
    expect(res3).toMatchObject({ status: 'ok', rowsRead: 2, rowsImported: 2 })
  })

  it('collections skip blank lines of a one-column file (no empty documents)', async () => {
    const h = setup({ engine: 'mongodb', safeMode: 'read-only' })
    const path = await file('names.csv', 'name\r\nann\r\n\r\nbob\r\n\r\n')
    // Read-only: the scan runs, the gate refuses, and its reason carries the count.
    const res = await h.engine.importStart(
      request(path, {
        target: { kind: 'collection', database: 'shop', collection: 'c' },
        columns: [{ source: 0, target: 'name', type: 'string' }],
        empty: 'null',
        onError: 'stop'
      }),
      { clientId: null }
    )
    expect(res.status).toBe('blocked')
    if (res.status === 'blocked')
      expect(res.plan.statements[0].reasons[0]).toContain('Import 2 documents from names.csv')
  })

  // -- non-transactional MySQL tables -------------------------------------------------------

  const mysqlDetails = (engine: string): DataTableDetails => ({
    ...twoColumns,
    ref: { name: 'items', database: 'shop' },
    engine
  })
  const mysqlRequest = (path: string, extra: Partial<DataImportStartRequest> = {}) =>
    request(path, { target: { kind: 'table', ref: { name: 'items', database: 'shop' } }, ...extra })
  /** Row 6 repeats id 1 (a duplicate key). */
  const failDuplicate = (d: FakeDriver): void => {
    d.handler = (statement) => {
      if (statement.startsWith('INSERT') && statement.includes("('1', 'dup')"))
        throw new DataDriverError("Duplicate entry '1' for key 'PRIMARY'", { code: '1062' })
      return { output: { kind: 'command', affectedRows: 1 } }
    }
  }
  const tenRows = `id,name\n${Array.from({ length: 10 }, (_, i) => (i === 5 ? '1,dup' : `${i + 1},n${i + 1}`)).join('\n')}\n`

  for (const engineName of ['MyISAM', 'MEMORY', 'Aria']) {
    it(`${engineName} tables: one row per INSERT, so stop / skip blame the right row`, async () => {
      expect(transactionSupport('mysql', { engine: engineName })).toMatchObject({
        supported: false,
        note: expect.stringContaining('one at a time')
      })
      const h = setup({ engine: 'mysql' }, mysqlDetails(engineName))
      h.configure(failDuplicate)
      const path = await file(`${engineName}.csv`, tenRows)
      const stop = (await h.engine.importStart(
        mysqlRequest(path, { onError: 'stop', batchSize: 10 }),
        { clientId: null }
      )) as Extract<DataImportResponse, { status: 'failed' }>
      expect(stop).toMatchObject({ status: 'failed', rowsImported: 5 })
      expect(stop.errors).toEqual([expect.objectContaining({ row: 6, line: 7 })])
      expect(stop.message).toMatch(
        /^Stopped at Row 6 \(line 7\).*5 rows were imported before it\.$/
      )
      expect(inserts(h.drivers[0])).toHaveLength(6)
      expect(inserts(h.drivers[0]).every((s) => !s.includes('), ('))).toBe(true)

      const skip = await h.engine.importStart(
        mysqlRequest(path, { onError: 'skip', batchSize: 10 }),
        { clientId: null }
      )
      expect(skip).toMatchObject({ status: 'ok', rowsImported: 9, rowsSkipped: 1, errorCount: 1 })
    })
  }

  it('InnoDB tables keep multi-row INSERTs', async () => {
    const h = setup({ engine: 'mysql' }, mysqlDetails('InnoDB'))
    h.configure(failDuplicate)
    const path = await file('innodb.csv', tenRows)
    const res = await h.engine.importStart(mysqlRequest(path, { onError: 'stop', batchSize: 10 }), {
      clientId: null
    })
    expect(res).toMatchObject({ status: 'failed', rowsImported: 5 })
    expect(inserts(h.drivers[0])[0]).toContain("('1', 'n1'), ('2', 'n2')")
  })

  // -- autocommit = 0 -------------------------------------------------------------------------

  const autocommitOff = (value: unknown) => (d: FakeDriver) => {
    d.handler = (statement) => {
      if (statement === 'SELECT @@SESSION.autocommit') return rowsOutput(['autocommit'], [[value]])
      if (statement.startsWith('INSERT') && statement.includes("'BAD'"))
        throw new DataDriverError('Data too long for column', { code: '1406' })
      return { output: { kind: 'command', affectedRows: 1 } }
    }
  }

  it('autocommit = 0: stop / skip run with autocommit and switch it back off after', async () => {
    const h = setup({ engine: 'mysql' }, mysqlDetails('InnoDB'))
    h.configure(autocommitOff(0))
    const path = await file('ac.csv', 'id,name\n1,a\n2,BAD\n3,c\n')
    const res = await h.engine.importStart(mysqlRequest(path, { onError: 'stop' }), {
      clientId: null
    })
    expect(res).toMatchObject({ status: 'failed', rowsImported: 1 })
    const list = statements(h.drivers[0])
    expect(list[0]).toBe('SELECT @@SESSION.autocommit')
    expect(list[1]).toBe('SET SESSION autocommit = 1')
    expect(list[list.length - 1]).toBe('SET SESSION autocommit = 0')
    expect(list.filter((s) => s.startsWith('INSERT')).length).toBeGreaterThan(0)

    // Already on: nothing changes. Rollback mode (BEGIN … COMMIT) does not ask.
    for (const [value, onError] of [
      [1, 'skip'],
      ['1', 'stop'],
      [0, 'rollback']
    ] as const) {
      const h2 = setup({ engine: 'mysql' }, mysqlDetails('InnoDB'))
      h2.configure(autocommitOff(value))
      const ok = await h2.engine.importStart(
        mysqlRequest(await file('ac2.csv', 'id,name\n1,a\n'), { onError }),
        { clientId: null }
      )
      expect(ok).toMatchObject({ status: 'ok', rowsImported: 1 })
      expect(statements(h2.drivers[0]).some((s) => s.startsWith('SET SESSION autocommit'))).toBe(
        false
      )
      if (onError === 'rollback')
        expect(statements(h2.drivers[0])).not.toContain('SELECT @@SESSION.autocommit')
    }
  })

  it('other SQL engines never look at autocommit', async () => {
    const h = setup()
    const path = await file('pg.csv', 'id,name\n1,a\n')
    await h.engine.importStart(request(path, { onError: 'stop' }), { clientId: null })
    expect(statements(h.drivers[0]).some((s) => /autocommit/i.test(s))).toBe(false)
  })
})

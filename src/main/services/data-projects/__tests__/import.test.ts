// Import (import.ts): the streaming CSV / JSON parsers, detection, value conversion, error
// classification, and the whole start flow (scan → gate → batches → history) over the engine
// with a scriptable fake driver. No database, no Electron.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BSON } from 'bson'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type {
  DataImportProgressEvent,
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
  detectDelimiter,
  detectEncoding,
  detectQuote,
  detectFormat,
  detectHeader,
  importErrorText,
  ImportSyntaxError,
  inferMongoType,
  isStatementLevelError,
  JsonDocumentSplitter,
  parseImportDate,
  sqlColumnKind,
  sqlLiteral,
  transactionSupport,
  validateMongoFieldPaths,
  type CsvRecord,
  type JsonDocumentText
} from '../import'
import { createSafetyGate } from '../safety-gate'
import { FakeDriver, MemoryRepository, MemorySecrets, makeRecord } from './engine-fixtures'

const bson = BSON as unknown as typeof import('bson')

const parseCsv = (
  text: string,
  options: { delimiter?: string; quote?: '"' | "'" | '' } = {},
  chunk = 0
): CsvRecord[] => {
  const parser = new CsvParser({ delimiter: options.delimiter ?? ',', quote: options.quote ?? '"' })
  const out: CsvRecord[] = []
  if (chunk > 0)
    for (let i = 0; i < text.length; i += chunk) parser.push(text.slice(i, i + chunk), out)
  else parser.push(text, out)
  parser.end(out)
  return out
}

const splitJson = (text: string, mode: 'array' | 'sequence', chunk = 0): JsonDocumentText[] => {
  const splitter = new JsonDocumentSplitter(mode)
  const out: JsonDocumentText[] = []
  if (chunk > 0)
    for (let i = 0; i < text.length; i += chunk) splitter.push(text.slice(i, i + chunk), out)
  else splitter.push(text, out)
  splitter.end(out)
  return out
}

// ---------------------------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------------------------

describe('CsvParser', () => {
  it('reads quoted fields with delimiters, doubled quotes and line breaks', () => {
    const text = 'id,name,note\r\n1,"Smith, J","said ""hi""\nthen left"\r\n2,Bob,\r\n'
    expect(parseCsv(text)).toEqual([
      { fields: ['id', 'name', 'note'], line: 1 },
      { fields: ['1', 'Smith, J', 'said "hi"\nthen left'], line: 2 },
      { fields: ['2', 'Bob', null], line: 4 }
    ])
  })

  it('keeps NULL (empty unquoted) apart from the empty string (quoted)', () => {
    expect(parseCsv('a,"",,x\n')[0].fields).toEqual(['a', '', null, 'x'])
  })

  it('gives the same records for every chunking (CRLF and quotes split across chunks)', () => {
    const text = 'a;b;c\r\n"x\r\ny";"q""q";\r\n\r\n3;;"end"\rlast;"";z'
    const whole = parseCsv(text, { delimiter: ';' })
    expect(whole).toEqual([
      { fields: ['a', 'b', 'c'], line: 1 },
      { fields: ['x\r\ny', 'q"q', null], line: 2 },
      { fields: ['3', null, 'end'], line: 5 },
      { fields: ['last', '', 'z'], line: 6 }
    ])
    for (let chunk = 1; chunk <= text.length; chunk++)
      expect(parseCsv(text, { delimiter: ';' }, chunk), `chunk ${chunk}`).toEqual(whole)
  })

  it('skips blank lines and needs no final line break', () => {
    expect(parseCsv('\n\na,b\n\nc,d').map((r) => r.fields)).toEqual([
      ['a', 'b'],
      ['c', 'd']
    ])
    expect(parseCsv('')).toEqual([])
  })

  it('is lenient with stray quotes, and reads every quote literally without quoting', () => {
    expect(parseCsv('a"b,"c"d,e\n')[0].fields).toEqual(['a"b', 'cd', 'e'])
    expect(parseCsv('"a",b\n', { quote: '' })[0].fields).toEqual(['"a"', 'b'])
    expect(parseCsv("'x,y',z\n", { quote: "'" })[0].fields).toEqual(['x,y', 'z'])
  })

  it('refuses an unterminated quoted field with its line', () => {
    expect(() => parseCsv('a,b\n1,"open\n2,3\n')).toThrow(ImportSyntaxError)
    try {
      parseCsv('a,b\n1,"open\n2,3\n')
    } catch (error) {
      expect((error as ImportSyntaxError).line).toBe(2)
    }
  })

  it('validates its options', () => {
    expect(() => new CsvParser({ delimiter: ',,', quote: '"' })).toThrow(/single character/)
    expect(() => new CsvParser({ delimiter: '"', quote: '"' })).toThrow(/differ/)
    expect(() => new CsvParser({ delimiter: '\n', quote: '"' })).toThrow(/line break/)
  })
})

// ---------------------------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------------------------

describe('JsonDocumentSplitter', () => {
  const array = '[\n  {"a": "}{\\"]", "b": [1, {"c": 2}]},\n  {"d": null}\n]\n'

  it('splits an array into its documents (brackets inside strings are text)', () => {
    const docs = splitJson(array, 'array')
    expect(docs.map((d) => JSON.parse(d.text))).toEqual([
      { a: '}{"]', b: [1, { c: 2 }] },
      { d: null }
    ])
    expect(docs.map((d) => d.line)).toEqual([2, 3])
    for (let chunk = 1; chunk <= array.length; chunk++)
      expect(splitJson(array, 'array', chunk), `chunk ${chunk}`).toEqual(docs)
  })

  it('splits NDJSON and pretty-printed concatenated documents', () => {
    const text = '{"a":1}\n{"b":\n  2}\n\n{"c":"x\\ny"}'
    expect(splitJson(text, 'sequence').map((d) => [JSON.parse(d.text), d.line])).toEqual([
      [{ a: 1 }, 1],
      [{ b: 2 }, 2],
      [{ c: 'x\ny' }, 5]
    ])
  })

  it('emits scalars too (the caller refuses them) and handles an empty array', () => {
    expect(splitJson('[1, "two", true]', 'array').map((d) => d.text)).toEqual([
      '1',
      '"two"',
      'true'
    ])
    expect(splitJson('  [ ]  ', 'array')).toEqual([])
  })

  it('refuses a broken structure with the line', () => {
    expect(() => splitJson('{"a":1}', 'array')).toThrow(/must start with "\["/)
    expect(() => splitJson('[{"a":1} {"b":2}]', 'array')).toThrow(/expected "," or "\]"/)
    expect(() => splitJson('[{"a":1}', 'array')).toThrow(/not closed/)
    expect(() => splitJson('[{"a":1}] x', 'array')).toThrow(/after the closing/)
    expect(() => splitJson('{"a":1}\n{"b":', 'sequence')).toThrow(/Document 2 \(line 2\)/)
  })
})

// ---------------------------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------------------------

describe('detection', () => {
  it('detects the encoding from the BOM, the UTF-16 NUL pattern and UTF-8 validity', () => {
    expect(detectEncoding(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe('utf-8')
    expect(detectEncoding(new Uint8Array([0xff, 0xfe, 0x61, 0]))).toBe('utf-16le')
    expect(detectEncoding(new Uint8Array([0xfe, 0xff, 0, 0x61]))).toBe('utf-16be')
    expect(detectEncoding(Buffer.from('id,name\n1,x\n', 'utf16le'))).toBe('utf-16le')
    expect(detectEncoding(Buffer.from('caf\u00e9,na\u00efve\n', 'utf8'))).toBe('utf-8')
    expect(detectEncoding(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x2c, 0x78]))).toBe('windows-1252')
    // A multi-byte character cut by the end of the head is not "invalid".
    expect(detectEncoding(Buffer.from('ab\u00e9', 'utf8').subarray(0, 3))).toBe('utf-8')
  })

  it('detects the format (SQL is always CSV)', () => {
    expect(detectFormat('x.json', '[{}]', 'sql')).toBe('csv')
    expect(detectFormat('x.json', '  [{"a":1}]', 'document')).toBe('json')
    expect(detectFormat('x.json', '{"a":1}\n', 'document')).toBe('ndjson')
    expect(detectFormat('x.jsonl', '[1]', 'document')).toBe('ndjson')
    expect(detectFormat('x.csv', '[a,b', 'document')).toBe('csv')
    expect(detectFormat('x.txt', 'a,b\n', 'document')).toBe('csv')
  })

  it('detects the delimiter by consistency', () => {
    expect(detectDelimiter('a,b,c\n1,2,3\n4,5,6\n', 'x.csv', '"')).toBe(',')
    expect(detectDelimiter('a;b;c\n"1,5";2;3\n"4,1";5;6\n', 'x.csv', '"')).toBe(';')
    expect(detectDelimiter('a\tb\n1\t2\n', 'x.txt', '"')).toBe('\t')
    expect(detectDelimiter('a|b|c\n1|2|3\n', 'x.txt', '"')).toBe('|')
    expect(detectDelimiter('single\nvalues\n', 'x.csv', '"')).toBe(',')
    // .tsv prefers tab even when commas split as consistently.
    expect(detectDelimiter('a,b\tc\n1,2\t3\n', 'x.tsv', '"')).toBe('\t')
  })

  it('detects the quote character', () => {
    expect(detectQuote('a,b\n"x, y",2\n"z",3\n', ',')).toBe('"')
    expect(detectQuote("a;b\n'x; y';2\n'z';3\n", ';')).toBe("'")
    // An apostrophe inside text is not quoting.
    expect(detectQuote("name\nO'Brien\nD'Arcy\n", ',')).toBe('"')
    expect(detectQuote('a|b\n1|2\n', '|')).toBe('"')
  })

  it('detects the header', () => {
    expect(
      detectHeader([
        ['id', 'name'],
        ['1', 'x']
      ])
    ).toBe(true)
    expect(
      detectHeader([
        ['1', 'x'],
        ['2', 'y']
      ])
    ).toBe(false)
    expect(detectHeader([['2024-01-01', 'x']])).toBe(false)
    expect(
      detectHeader([
        ['a', 'a'],
        ['b', 'c']
      ])
    ).toBe(false)
    // Matches the table's columns even with a numeric-looking name.
    expect(
      detectHeader(
        [
          ['id', '2fa', 'Email'],
          ['1', 'x', 'y']
        ],
        ['id', '2fa', 'email']
      )
    ).toBe(true)
    // A pandas index column: an empty first cell.
    expect(
      detectHeader([
        [null, 'a', 'b'],
        ['0', '1', '2']
      ])
    ).toBe(true)
  })

  it('suggests Mongo types from samples', () => {
    expect(inferMongoType(['1', '2', null, '-3'])).toBe('number')
    expect(inferMongoType(['1.5', '2'])).toBe('number')
    expect(inferMongoType(['007', '2'])).toBe('string')
    expect(inferMongoType(['true', 'False'])).toBe('boolean')
    expect(inferMongoType(['2024-01-02', '2024-01-03T10:00:00Z'])).toBe('date')
    expect(inferMongoType(['507f1f77bcf86cd799439011'])).toBe('objectId')
    expect(inferMongoType(['1', 'x'])).toBe('string')
    expect(inferMongoType([null, ''])).toBe('string')
  })
})

// ---------------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------------

describe('values', () => {
  it('parses ISO dates as UTC unless they carry a zone', () => {
    expect(parseImportDate('2024-03-01', false)?.toISOString()).toBe('2024-03-01T00:00:00.000Z')
    expect(parseImportDate('2024-03-01 10:20:30.5', false)?.toISOString()).toBe(
      '2024-03-01T10:20:30.500Z'
    )
    expect(parseImportDate('2024-03-01T10:00:00+02:00', false)?.toISOString()).toBe(
      '2024-03-01T08:00:00.000Z'
    )
    expect(parseImportDate('2024-02-30', false)).toBeNull()
    expect(parseImportDate('1700000000000', false)).toBeNull()
    expect(parseImportDate('1700000000000', true)?.getTime()).toBe(1700000000000)
  })

  it('converts Mongo values per type', () => {
    const t = (text: string, type: Parameters<typeof convertMongoValue>[1]): string => {
      const v = convertMongoValue(text, type, bson) as { _bsontype?: string }
      return v && typeof v === 'object' && v._bsontype
        ? `${v._bsontype}:${String(v)}`
        : v instanceof Date
          ? `Date:${v.toISOString()}`
          : `${typeof v}:${String(v)}`
    }
    expect(t('42', 'number')).toBe('Int32:42')
    expect(t('5000000000', 'number')).toBe('Long:5000000000')
    expect(t('2.0', 'number')).toBe('Double:2')
    expect(t('42', 'int64')).toBe('Long:42')
    expect(t('1.25', 'decimal')).toBe('Decimal128:1.25')
    expect(t('yes', 'boolean')).toBe('boolean:true')
    expect(t('2024-01-01', 'date')).toBe('Date:2024-01-01T00:00:00.000Z')
    expect(t('507f1f77bcf86cd799439011', 'objectId')).toBe('ObjectId:507f1f77bcf86cd799439011')
    expect(t(' 007 ', 'string')).toBe('string: 007 ')
    expect(t('007', 'auto')).toBe('string:007')
    expect(t('7', 'auto')).toBe('Int32:7')
    expect(t('TRUE', 'auto')).toBe('boolean:true')
    expect(t('hello', 'auto')).toBe('string:hello')
    expect(() => convertMongoValue('abc', 'int32', bson)).toThrow(/"abc" is not an integer/)
    expect(() => convertMongoValue('3000000000', 'int32', bson)).toThrow(/Int32 range/)
    expect(() => convertMongoValue('maybe', 'boolean', bson)).toThrow(/boolean/)
    expect(() => convertMongoValue('xyz', 'objectId', bson)).toThrow(/ObjectId/)
  })

  it('builds nested documents and applies the empty-value mode', () => {
    const specs = [
      { source: 0, name: 'name', path: ['name'], type: 'string' as const },
      { source: 1, name: 'address.city', path: ['address', 'city'], type: 'string' as const },
      { source: 2, name: 'age', path: ['age'], type: 'int32' as const }
    ]
    const doc = buildMongoDocument(['Ann', 'Paris', null], specs, 'omit', bson)
    expect(doc).toEqual({ name: 'Ann', address: { city: 'Paris' } })
    expect(buildMongoDocument(['', null, ''], specs, 'null', bson)).toEqual({
      name: '',
      address: { city: null },
      age: null
    })
    expect(() => buildMongoDocument(['A', 'B', 'x'], specs, 'omit', bson)).toThrow(
      /field "age": "x" is not an integer/
    )
  })

  it('validates Mongo field paths', () => {
    expect(validateMongoFieldPaths(['a', 'b.c'])).toEqual([['a'], ['b', 'c']])
    expect(() => validateMongoFieldPaths(['a', 'a.b'])).toThrow(/cannot hold a value/)
    expect(() => validateMongoFieldPaths(['a', 'a'])).toThrow(/Two columns/)
    expect(() => validateMongoFieldPaths(['$x'])).toThrow(/\$/)
    expect(() => validateMongoFieldPaths(['a..b'])).toThrow(/empty part/)
  })

  it('writes SQL literals: quoted text, NULL handling, MySQL BIT and booleans', () => {
    expect(sqlLiteral(null, 'other', 'postgres', {}, 'null')).toBe('NULL')
    expect(sqlLiteral(null, 'other', 'postgres', {}, 'empty')).toBe("''")
    expect(sqlLiteral('', 'other', 'postgres', {}, 'null')).toBe("''")
    expect(sqlLiteral("O'Brien", 'other', 'postgres', {}, 'null')).toBe("'O''Brien'")
    expect(sqlLiteral('C:\\x', 'other', 'mysql', { backslashEscapes: true }, 'null')).toBe(
      "'C:\\\\x'"
    )
    expect(sqlLiteral('C:\\x', 'other', 'mysql', { backslashEscapes: false }, 'null')).toBe(
      "'C:\\x'"
    )
    expect(sqlLiteral('5', 'bit', 'mysql', {}, 'null')).toBe('5')
    expect(sqlLiteral("b'101'", 'bit', 'mysql', {}, 'null')).toBe("b'101'")
    expect(sqlLiteral('TRUE', 'bool', 'mysql', {}, 'null')).toBe('1')
    expect(sqlLiteral('42', 'other', 'clickhouse', {}, 'null')).toBe("'42'")
    expect(sqlColumnKind('mysql', 'bit(8)')).toBe('bit')
    expect(sqlColumnKind('mysql', 'tinyint(1)')).toBe('bool')
    expect(sqlColumnKind('sqlite', 'BOOLEAN')).toBe('bool')
    expect(sqlColumnKind('clickhouse', 'Nullable(Bool)')).toBe('other')
    expect(sqlColumnKind('postgres', 'boolean')).toBe('other')
  })
})

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

describe('errors', () => {
  const live = { isConnected: () => true }
  it('tells row failures from statement-level failures', () => {
    const e = (code: string, message = 'x'): DataDriverError =>
      new DataDriverError(message, { code })
    expect(isStatementLevelError(e('23505'), 'postgres', live)).toBe(false)
    expect(isStatementLevelError(e('22P02'), 'postgres', live)).toBe(false)
    expect(isStatementLevelError(e('42P01'), 'postgres', live)).toBe(true)
    expect(isStatementLevelError(e('40P01'), 'postgres', live)).toBe(true)
    expect(isStatementLevelError(e('1062'), 'mysql', live)).toBe(false)
    expect(isStatementLevelError(e('1146'), 'mariadb', live)).toBe(true)
    expect(isStatementLevelError(e('6'), 'clickhouse', live)).toBe(false)
    expect(isStatementLevelError(e('60'), 'clickhouse', live)).toBe(true)
    expect(isStatementLevelError(e('SQLITE_CONSTRAINT_UNIQUE'), 'sqlite', live)).toBe(false)
    expect(isStatementLevelError(e('SQLITE_READONLY'), 'sqlite', live)).toBe(true)
    expect(isStatementLevelError(e('SQLITE_ERROR', 'no such table: t'), 'sqlite', live)).toBe(true)
    expect(
      isStatementLevelError(new DataDriverError('x', { cancelled: true }), 'mysql', live)
    ).toBe(true)
    expect(isStatementLevelError(e('23505'), 'postgres', { isConnected: () => false })).toBe(true)
  })

  it('keeps error texts short and readable', () => {
    const ch = new DataDriverError(
      "Code: 6. DB::Exception: Cannot parse string 'abc' as UInt32: syntax error at begin of string. Note: there are toUInt32OrZero and toUInt32OrNull functions, which returns zero/NULL instead of throwing exception.: while executing 'FUNCTION if(isNull(-dummy-0) : 3, _CAST(-dummy-0, 'UInt32') :: 4) UInt32 : 1': While executing ValuesBlockInputFormat. (CANNOT_PARSE_TEXT) (version 24.8.14.39 (official build))",
      { code: '6' }
    )
    expect(importErrorText(ch, 'clickhouse')).toBe(
      "Code: 6. DB::Exception: Cannot parse string 'abc' as UInt32: syntax error at begin of string. While executing ValuesBlockInputFormat. (CANNOT_PARSE_TEXT)"
    )
    const pg = new DataDriverError('duplicate key value violates unique constraint "t_pkey"', {
      code: '23505',
      detail: 'Key (id)=(1) already exists.'
    })
    expect(importErrorText(pg, 'postgres')).toBe(
      'duplicate key value violates unique constraint "t_pkey" — Key (id)=(1) already exists.'
    )
    expect(importErrorText(new Error('x'.repeat(2000)), 'mysql').length).toBeLessThan(700)
  })

  it('knows where transactions are available', () => {
    expect(transactionSupport('postgres').supported).toBe(true)
    expect(transactionSupport('mysql', { engine: 'InnoDB' }).supported).toBe(true)
    expect(transactionSupport('mysql', { engine: 'MyISAM' }).supported).toBe(false)
    expect(transactionSupport('clickhouse').supported).toBe(false)
    expect(transactionSupport('mongodb').supported).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------
// Engine flow (fake driver)
// ---------------------------------------------------------------------------------------------

describe('import through the engine (fake driver)', () => {
  let dir = ''
  let engines: DataEngineServiceInternals[] = []
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tedooo-import-unit-'))
  })
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })
  afterEach(async () => {
    for (const e of engines) await e.shutdown()
    engines = []
    clearImportScanCache()
  })

  const details: DataTableDetails = {
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

  const setup = (record: Partial<DataProjectRecord> = {}) => {
    const repo = new MemoryRepository([makeRecord({ safeMode: 'off', ...record })])
    const drivers: FakeDriver[] = []
    const events: DataImportProgressEvent[] = []
    let configure: (d: FakeDriver) => void = () => {}
    const engine = createDataEngineService({
      repository: repo,
      secrets: new MemorySecrets(),
      publish: (channel, payload) => {
        if (channel === 'dataProjects:import') events.push(payload as DataImportProgressEvent)
      },
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
      repo,
      drivers,
      events,
      configure: (fn: (d: FakeDriver) => void) => {
        configure = fn
        drivers.forEach(fn)
      }
    }
  }

  const file = async (name: string, text: string): Promise<string> => {
    const path = join(dir, name)
    await writeFile(path, text)
    return path
  }

  const csvRows = (n: number, bad: Set<number> = new Set()): string =>
    `id,name\n${Array.from({ length: n }, (_, i) => `${i + 1},${bad.has(i + 1) ? 'BAD' : `n${i + 1}`}`).join('\n')}\n`

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

  const inserts = (d: FakeDriver): string[] =>
    d.calls.map((c) => c.statement).filter((s) => s.startsWith('INSERT'))

  /** INSERTs containing 'BAD' fail like a CHECK constraint (PG SQLSTATE 23514). */
  const failBad = (d: FakeDriver): void => {
    d.handler = (statement) => {
      if (statement.startsWith('INSERT') && statement.includes("'BAD'"))
        throw new DataDriverError('new row violates check constraint "name_ok"', { code: '23514' })
      return { output: { kind: 'command', affectedRows: 1 } }
    }
  }

  it('previews: detection, rows, the table columns', async () => {
    const h = setup()
    const path = await file('p.csv', 'id;name\n1;"a;b"\n2;\n')
    const preview = await h.engine.importPreview({
      dataProjectId: 'dp-1',
      filePath: path,
      target: { kind: 'table', ref: { name: 'items', schema: 'public', database: 'shop' } }
    })
    expect(preview).toMatchObject({
      fileName: 'p.csv',
      format: 'csv',
      encoding: 'utf-8',
      csv: { delimiter: ';', quote: '"', header: true },
      columns: ['id', 'name'],
      rows: [
        ['1', 'a;b'],
        ['2', null]
      ],
      lines: [2, 3],
      more: false,
      supportsTransaction: true
    })
    expect(preview.tableColumns?.map((c) => c.name)).toEqual(['id', 'name'])
  })

  it('runs in one transaction in batches, after the gate, and records one history row', async () => {
    const h = setup({ safeMode: 'half-safe' })
    const path = await file('ok.csv', csvRows(1203))
    const req = request(path, { batchSize: 500 })
    const first = await h.engine.importStart(req, { clientId: 'c1' })
    expect(first.status).toBe('confirmation_required')
    if (first.status !== 'confirmation_required') return
    const statement = first.plan.statements[0]
    expect(statement.classification).toBe('write')
    expect(statement.reasons.join(' ')).toContain('Import 1,203 rows from ok.csv into public.items')
    expect(statement.text).toContain('INSERT INTO "public"."items" ("id", "name") VALUES (…)')
    expect(h.drivers.flatMap(inserts)).toEqual([]) // nothing ran yet

    const done = await h.engine.importStart(
      { ...req, importId: 'imp-2', confirmToken: first.confirmToken },
      { clientId: 'c1' }
    )
    expect(done).toMatchObject({ status: 'ok', rowsRead: 1203, rowsImported: 1203, errorCount: 0 })
    const statements = h.drivers[0].calls.map((c) => c.statement)
    expect(statements[0]).toBe('BEGIN')
    expect(statements[statements.length - 1]).toBe('COMMIT')
    expect(inserts(h.drivers[0])).toHaveLength(3)
    expect(inserts(h.drivers[0])[0]).toMatch(
      /^INSERT INTO "public"\."items" \("id", "name"\) VALUES \('1', 'n1'\), \('2', 'n2'\)/
    )
    expect(h.drivers[0].calls.every((c) => !c.options.readOnlySandbox)).toBe(true)
    expect(h.repo.history).toHaveLength(1)
    expect(h.repo.history[0]).toMatchObject({ status: 'ok', rowCount: 1203 })
    expect(h.repo.history[0].text).toContain('Imported 1,203 of 1,203 rows from ok.csv')
    const last = h.events[h.events.length - 1]
    expect(last).toMatchObject({
      importId: 'imp-2',
      done: true,
      rowsImported: 1203,
      totalRows: 1203
    })
  })

  it('is refused in read-only mode (and records it)', async () => {
    const h = setup({ safeMode: 'read-only' })
    const path = await file('ro.csv', csvRows(3))
    const res = await h.engine.importStart(request(path), { clientId: null })
    expect(res.status).toBe('blocked')
    expect(h.drivers.flatMap(inserts)).toEqual([])
    expect(h.repo.history[0]).toMatchObject({ status: 'blocked' })
  })

  it('rollback mode: rolls everything back and finds the failing row by probing', async () => {
    const h = setup()
    h.configure(failBad)
    const path = await file('rb.csv', csvRows(1200, new Set([777])))
    const res = (await h.engine.importStart(request(path, { batchSize: 500 }), {
      clientId: null
    })) as Extract<DataImportResponse, { status: 'failed' }>
    expect(res.status).toBe('failed')
    expect(res.rolledBack).toBe(true)
    expect(res.rowsImported).toBe(0)
    expect(res.errors[0]).toMatchObject({ row: 777, line: 778 })
    expect(res.errors[0].message).toContain('check constraint')
    expect(res.message).toContain('Row 777 (line 778)')
    expect(res.message).toContain('Nothing was imported')
    const statements = h.drivers[0].calls.map((c) => c.statement)
    expect(statements).not.toContain('COMMIT')
    // Every probe is its own BEGIN … ROLLBACK.
    const begins = statements.filter((s) => s === 'BEGIN').length
    expect(statements.filter((s) => s === 'ROLLBACK').length).toBe(begins)
    expect(h.repo.history[0]).toMatchObject({ status: 'error', rowCount: 0 })
  })

  it('stop mode: everything before the failing row is in, nothing after it', async () => {
    const h = setup()
    h.configure(failBad)
    const path = await file('stop.csv', csvRows(1000, new Set([600, 900])))
    const res = (await h.engine.importStart(request(path, { onError: 'stop', batchSize: 500 }), {
      clientId: null
    })) as Extract<DataImportResponse, { status: 'failed' }>
    expect(res).toMatchObject({ status: 'failed', rowsImported: 599, rolledBack: false })
    expect(res.errors).toHaveLength(1)
    expect(res.errors[0].row).toBe(600)
    const values = inserts(h.drivers[0])
      .filter((s) => !s.includes("'BAD'"))
      .join('\n')
    expect(values).toContain("('599', 'n599')")
    expect(values).not.toContain("('601', 'n601')")
    expect(h.drivers[0].calls.map((c) => c.statement)).not.toContain('BEGIN')
  })

  it('skip mode: failing rows are reported, the rest is imported', async () => {
    const h = setup()
    h.configure(failBad)
    const path = await file('skip.csv', csvRows(1000, new Set([3, 600, 999])))
    const res = await h.engine.importStart(request(path, { onError: 'skip', batchSize: 250 }), {
      clientId: null
    })
    expect(res).toMatchObject({ status: 'ok', rowsImported: 997, rowsSkipped: 3, errorCount: 3 })
    if (res.status !== 'ok') return
    expect(res.errors.map((e) => e.row)).toEqual([3, 600, 999])
  })

  it('refuses a malformed file before writing anything (rollback / stop), skips it in skip mode', async () => {
    const h = setup()
    const path = await file('bad.csv', 'id,name\n1,a\n2,b,EXTRA\n3,c\n')
    const res = (await h.engine.importStart(request(path), { clientId: null })) as Extract<
      DataImportResponse,
      { status: 'failed' }
    >
    expect(res.status).toBe('failed')
    expect(res.message).toMatch(
      /^Nothing was imported: Row 2 \(line 3\): has 3 fields; the header has 2/
    )
    expect(h.drivers.flatMap(inserts)).toEqual([])

    const skipped = await h.engine.importStart(request(path, { onError: 'skip' }), {
      clientId: null
    })
    expect(skipped).toMatchObject({ status: 'ok', rowsImported: 2, rowsSkipped: 1 })
  })

  it('stops at once on a statement-level failure', async () => {
    const h = setup()
    h.configure((d) => {
      d.handler = (statement) => {
        if (statement.startsWith('INSERT'))
          throw new DataDriverError('permission denied for table items', { code: '42501' })
        return { output: { kind: 'command', affectedRows: 0 } }
      }
    })
    const path = await file('perm.csv', csvRows(50))
    const res = (await h.engine.importStart(request(path, { onError: 'skip' }), {
      clientId: null
    })) as Extract<DataImportResponse, { status: 'failed' }>
    expect(res.status).toBe('failed')
    expect(res.message).toContain('permission denied')
    expect(inserts(h.drivers[0])).toHaveLength(1)
  })

  it('refuses while the session has an open transaction', async () => {
    const h = setup()
    h.configure((d) => {
      d.inTransaction = true
    })
    const path = await file('tx.csv', csvRows(2))
    await expect(h.engine.importStart(request(path), { clientId: null })).rejects.toThrow(
      /open transaction/
    )
  })

  it('validates the mapping and the options', async () => {
    const h = setup()
    const path = await file('v.csv', csvRows(2))
    await expect(
      h.engine.importStart(request(path, { columns: [{ source: 0, target: 'nope' }] }), {
        clientId: null
      })
    ).rejects.toThrow(/no column "nope"/)
    await expect(
      h.engine.importStart(
        request(path, {
          columns: [
            { source: 0, target: 'id' },
            { source: 1, target: 'id' }
          ]
        }),
        { clientId: null }
      )
    ).rejects.toThrow(/Two file columns/)
    await expect(
      h.engine.importStart(request(path, { columns: [{ source: 5, target: 'id' }] }), {
        clientId: null
      })
    ).rejects.toThrow(/uses column 6, but the file has 2 columns/)
    await expect(
      h.engine.importStart(request(path, { empty: 'omit' }), { clientId: null })
    ).rejects.toThrow(/NULL or as empty strings/)
    await expect(
      h.engine.importStart(request(join(dir, 'missing.csv')), { clientId: null })
    ).rejects.toThrow(/does not exist/)
  })

  it('cancels between batches and rolls back', async () => {
    const h = setup()
    let n = 0
    let importId = ''
    h.configure((d) => {
      d.handler = async (statement) => {
        if (statement.startsWith('INSERT') && ++n === 2) await h.engine.importCancel(importId)
        return { output: { kind: 'command', affectedRows: 1 } }
      }
    })
    const path = await file('cancel.csv', csvRows(2000))
    const req = request(path, { batchSize: 100 })
    importId = req.importId
    const res = await h.engine.importStart(req, { clientId: null })
    expect(res).toMatchObject({ status: 'cancelled', rolledBack: true, rowsImported: 0 })
    expect(h.drivers[0].calls.map((c) => c.statement)).toContain('ROLLBACK')
    expect(h.drivers[0].calls.map((c) => c.statement)).not.toContain('COMMIT')
    expect(h.repo.history[0]).toMatchObject({ status: 'cancelled' })
    expect(h.engine.imports.size).toBe(0)
  })

  it('a renderer disconnect cancels its import (the batch in flight is interrupted)', async () => {
    const h = setup()
    let n = 0
    h.configure((d) => {
      d.handler = async (statement) => {
        if (statement.startsWith('INSERT') && ++n === 2) h.engine.releaseClient('c9')
        return { output: { kind: 'command', affectedRows: 1 } }
      }
    })
    const path = await file('rel.csv', csvRows(500))
    const res = await h.engine.importStart(request(path, { batchSize: 50, onError: 'stop' }), {
      clientId: 'c9'
    })
    expect(res.status).toBe('cancelled')
    if (res.status === 'cancelled') expect(res.rowsImported).toBe(50)
    expect(h.drivers[0].cancelRequests).toBe(1)
  })
})

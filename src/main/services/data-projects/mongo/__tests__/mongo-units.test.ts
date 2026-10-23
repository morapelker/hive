import { beforeAll, describe, expect, it } from 'vitest'
import { DATA_ERROR_CODES } from '../../../../../shared/data-projects/types'
import { DataDriverError, type DataProjectRecord } from '../../contracts'
import type { AbstractCursor, Document } from 'mongodb'
import { buildMongoClientConfig } from '../connection'
import { toMongoDriverError } from '../errors'
import { collectDocuments } from '../executor'
import { summarizeExplain } from '../explain'
import {
  CsvColumnCollector,
  MONGO_EJSON_COLUMN,
  csvRow,
  mongoExportStatement,
  parseMongoExportSpec
} from '../export'
import {
  bsonSize,
  bsonTypeName,
  loadMongoRuntime,
  mongoRuntime,
  parseShellHint,
  parseShellValue,
  scalarText,
  toCanonical
} from '../runtime'
import { analyzeMongoDocuments, schemaFieldsToColumns } from '../schema'

const record = (config: DataProjectRecord['config']): DataProjectRecord => ({
  id: 'p1',
  name: 'mongo',
  engine: 'mongodb',
  config,
  icon: null,
  iconColor: null,
  environment: 'local',
  color: null,
  safeMode: 'off',
  defaultLimit: 1000,
  allowAiDataAccess: false,
  pinned: false,
  secretCiphertext: null,
  secretState: 'stored',
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastAccessedAt: '2026-01-01T00:00:00.000Z'
})

beforeAll(async () => {
  await loadMongoRuntime()
})

describe('buildMongoClientConfig', () => {
  it('never puts credentials in the URI', () => {
    const cfg = buildMongoClientConfig(
      record({
        host: '127.0.0.1',
        port: 27018,
        user: 'root',
        database: 'shop',
        mongo: { srv: false, hosts: [], authSource: 'admin' }
      }),
      { password: 's3cr3t@pw' }
    )
    expect(cfg.uri).toBe('mongodb://127.0.0.1:27018/shop')
    expect(cfg.uri).not.toContain('s3cr3t')
    expect(cfg.options.auth).toEqual({ username: 'root', password: 's3cr3t@pw' })
    expect(cfg.options.authSource).toBe('admin')
    expect(cfg.options.appName).toBe('Hive')
    expect(cfg.options.serverSelectionTimeoutMS).toBe(10_000)
    // Stored regexes must stay BSON values (JS RegExp rejects s/x and PCRE-only syntax).
    expect(cfg.options.bsonRegExp).toBe(true)
    expect(cfg.describe).not.toContain('root')
  })

  it('builds replica set and SRV URIs with options', () => {
    const rs = buildMongoClientConfig(
      record({
        mongo: {
          srv: false,
          hosts: ['a.example.com:27017', 'b.example.com:27018', '::1'],
          replicaSet: 'rs0',
          readPreference: 'secondaryPreferred',
          directConnection: false
        },
        options: { retryWrites: 'false', proxyPassword: 'nope', w: 'majority' }
      }),
      {}
    )
    expect(rs.uri).toBe(
      'mongodb://a.example.com:27017,b.example.com:27018,[::1]/?retryWrites=false&w=majority'
    )
    expect(rs.options.replicaSet).toBe('rs0')
    expect(rs.options.readPreference).toBe('secondaryPreferred')
    expect(rs.options.auth).toBeUndefined()
    const srv = buildMongoClientConfig(
      record({ user: 'u', mongo: { srv: true, hosts: ['cluster0.abc.mongodb.net:27017'] } }),
      { password: 'p' }
    )
    expect(srv.uri).toBe('mongodb+srv://cluster0.abc.mongodb.net/')
    expect(srv.options.directConnection).toBeUndefined()
  })

  it('maps SSL modes and explicit TLS flags', () => {
    const require = buildMongoClientConfig(record({ host: 'h', ssl: { mode: 'require' } }), {})
    expect(require.options).toMatchObject({ tls: true, tlsAllowInvalidCertificates: true })
    const full = buildMongoClientConfig(
      record({
        host: 'h',
        ssl: {
          mode: 'verify-full',
          caPath: '/tmp/ca.pem',
          certPath: '/tmp/c.pem',
          keyPath: '/tmp/k.pem'
        }
      }),
      {}
    )
    expect(full.options).toMatchObject({ tls: true, tlsCAFile: '/tmp/ca.pem' })
    expect(full.options.tlsAllowInvalidCertificates).toBeUndefined()
    expect(full.tlsFiles).toEqual({ certPath: '/tmp/c.pem', keyPath: '/tmp/k.pem' })
    const off = buildMongoClientConfig(
      record({
        host: 'h',
        ssl: { mode: 'disable', caPath: '/x' },
        mongo: { srv: false, hosts: [], tls: false }
      }),
      {}
    )
    expect(off.options.tls).toBe(false)
    expect(off.options.tlsCAFile).toBeUndefined()
    const x509 = buildMongoClientConfig(
      record({
        host: 'h',
        user: 'CN=me',
        mongo: { srv: false, hosts: [], authMechanism: 'MONGODB-X509' }
      }),
      {}
    )
    expect(x509.options.auth).toEqual({ username: 'CN=me' })
  })
})

describe('shell values', () => {
  it('parses shell syntax into BSON values', () => {
    const value = parseShellValue(
      `{ _id: ObjectId("58c33a794d08b991e3648fd2"), at: ISODate("2024-01-01"), n: NumberLong("9007199254740993"), d: NumberDecimal("1.10"), r: /^a/i, i: NumberInt(5) }`,
      'Filter'
    ) as Record<string, unknown>
    expect(bsonTypeName(value._id)).toBe('ObjectId')
    expect(value.at).toBeInstanceOf(Date)
    expect(bsonTypeName(value.n)).toBe('Long')
    expect(bsonTypeName(value.d)).toBe('Decimal128')
    expect(value.r).toBeInstanceOf(RegExp)
    expect(bsonTypeName(value.i)).toBe('Int32')
    expect(toCanonical(value)).toMatchObject({
      _id: { $oid: '58c33a794d08b991e3648fd2' },
      n: { $numberLong: '9007199254740993' },
      d: { $numberDecimal: '1.10' }
    })
  })

  it('revives canonical EJSON wrappers but leaves query operators alone', () => {
    const value = parseShellValue(
      `{ "_id": { "$oid": "58c33a794d08b991e3648fd2" }, "at": { "$date": { "$numberLong": "0" } }, "n": { "$numberLong": "5" }, "name": { "$regex": "^a", "$options": "i" }, "x": { "$gt": 1 } }`,
      'Filter'
    ) as Record<string, unknown>
    expect(bsonTypeName(value._id)).toBe('ObjectId')
    expect((value.at as Date).getTime()).toBe(0)
    expect(bsonTypeName(value.n)).toBe('Long')
    expect(value.name).toEqual({ $regex: '^a', $options: 'i' })
    expect(value.x).toEqual({ $gt: 1 })
  })

  it('round-trips canonical EJSON produced by toCanonical', () => {
    const { bson } = mongoRuntime()
    const original = {
      _id: new bson.ObjectId(),
      d: new bson.Double(5),
      i: new bson.Int32(5),
      l: bson.Long.fromString('12'),
      when: new Date(1000)
    }
    const text = JSON.stringify(toCanonical(original))
    const back = parseShellValue(text, 'Document') as Record<string, unknown>
    expect(bsonTypeName(back.d)).toBe('Double')
    expect(bsonTypeName(back.i)).toBe('Int32')
    expect(bsonTypeName(back.l)).toBe('Long')
    expect(JSON.stringify(toCanonical(back))).toBe(text)
  })

  it('distinguishes an empty string from a rejected expression', () => {
    expect(parseShellValue('""', 'Field')).toBe('')
    expect(parseShellValue('   ', 'Field')).toBeUndefined()
    expect(() => parseShellValue('{ a: require("fs") }', 'Filter')).toThrowError(
      /unsupported or unsafe/
    )
    try {
      parseShellValue('{ a: process.exit(1) }', 'Filter')
    } catch (error) {
      expect(error).toBeInstanceOf(DataDriverError)
      expect((error as DataDriverError).code).toBe(DATA_ERROR_CODES.invalidInput)
    }
  })

  it('reports syntax error positions relative to the text', () => {
    try {
      parseShellValue('{ a: 1, b: }', 'Filter', 10)
      throw new Error('expected a syntax error')
    } catch (error) {
      expect(error).toBeInstanceOf(DataDriverError)
      expect((error as DataDriverError).message).toMatch(/^Filter: /)
      expect((error as DataDriverError).position).toBe(10 + 11)
    }
  })

  it('parses index hints as names or key documents', () => {
    expect(parseShellHint(undefined)).toBeUndefined()
    expect(parseShellHint(' createdAt_-1 ')).toBe('createdAt_-1')
    expect(parseShellHint('"by name"')).toBe('by name')
    expect(parseShellHint('{ createdAt: -1 }')).toEqual({ createdAt: -1 })
    expect(() => parseShellHint('[1]')).toThrowError(/index name or a key document/)
  })

  it('renders scalars for CSV cells', () => {
    const { bson } = mongoRuntime()
    expect(scalarText(new bson.ObjectId('58c33a794d08b991e3648fd2'))).toBe(
      '58c33a794d08b991e3648fd2'
    )
    expect(scalarText(new Date(0))).toBe('1970-01-01T00:00:00.000Z')
    expect(scalarText(bson.Decimal128.fromString('1.10'))).toBe('1.10')
    expect(scalarText(new bson.Int32(7))).toBe(7)
    expect(scalarText(new bson.UUID('3b241101-e2bb-4255-8caf-4136c566a962'))).toBe(
      '3b241101-e2bb-4255-8caf-4136c566a962'
    )
  })
})

describe('collectDocuments', () => {
  /** A cursor over `docs` that records whether it was closed. */
  const cursorOf = (docs: Document[]): AbstractCursor<Document> & { closed: boolean } => {
    const cursor = {
      closed: false,
      async *[Symbol.asyncIterator]() {
        yield* docs
      },
      async close() {
        cursor.closed = true
      }
    }
    return cursor as unknown as AbstractCursor<Document> & { closed: boolean }
  }
  const doc = (i: number, size: number): Document => ({ _id: i, s: 'x'.repeat(size) })

  it('stops before the document that would cross the byte budget', async () => {
    const docs = [doc(1, 100), doc(2, 100), doc(3, 100)]
    const budget = bsonSize(docs[0]) + bsonSize(docs[1])
    const cursor = cursorOf(docs)
    const out = await collectDocuments(cursor, 10, budget)
    expect(out.docs.map((d) => d._id)).toEqual([1, 2])
    expect(out.byteLimited).toBe(true)
    expect(cursor.closed).toBe(true)
  })

  it('keeps one oversized document and stops at the fetch count first', async () => {
    const big = await collectDocuments(cursorOf([doc(1, 500), doc(2, 10)]), 10, 100)
    expect(big.docs.map((d) => d._id)).toEqual([1])
    expect(big.byteLimited).toBe(true)
    const counted = await collectDocuments(cursorOf([doc(1, 10), doc(2, 10), doc(3, 10)]), 2)
    expect(counted.docs).toHaveLength(2)
    expect(counted.byteLimited).toBe(false)
  })
})

describe('schema analysis', () => {
  it('computes presence, type mix, nested paths, samples and uniqueness', () => {
    const { bson } = mongoRuntime()
    const docs = [
      {
        _id: 1,
        name: 'a',
        tags: ['x', 'y'],
        address: { city: 'Paris' },
        items: [{ sku: 'A', qty: new bson.Int32(1) }]
      },
      {
        _id: 2,
        name: 'b',
        tags: [],
        address: { city: 'Rome', zip: '1' },
        items: [{ sku: 'B', qty: new bson.Int32(2) }, { sku: 'A' }]
      },
      { _id: 3, name: null, price: new bson.Double(1.5) },
      { _id: 4, name: 'a', price: bson.Decimal128.fromString('2.5') }
    ]
    const fields = analyzeMongoDocuments(docs)
    const by = Object.fromEntries(fields.map((f) => [f.path, f]))
    expect(fields[0].path).toBe('_id')
    expect(by._id.probability).toBe(1)
    expect(by._id.uniqueness).toBe(1)
    expect(by.name.types.map((t) => t.type).sort()).toEqual(['Null', 'String'])
    expect(by.name.sampleValues).toEqual(['"a"', '"b"'])
    expect(by['address.city'].probability).toBe(0.5)
    expect(by['address.zip'].probability).toBe(0.25)
    expect(by['items.sku'].probability).toBe(0.5)
    expect(by['items.qty'].types).toEqual([{ type: 'Int32', probability: 1 }])
    expect(by.tags.types).toEqual([{ type: 'Array', probability: 1 }])
    expect(by.tags.sampleValues).toEqual(['"x"', '"y"'])
    expect(by.price.types.map((t) => t.type).sort()).toEqual(['Decimal128', 'Double'])
    const columns = schemaFieldsToColumns(fields)
    expect(columns[0]).toMatchObject({
      name: '_id',
      isPrimaryKey: true,
      nullable: false,
      ordinal: 1
    })
    expect(columns.find((c) => c.name === 'name')).toMatchObject({
      nullable: true,
      type: 'String | Null'
    })
  })

  it('caps the number of fields', () => {
    const doc: Record<string, number> = {}
    for (let i = 0; i < 50; i++) doc[`k${i}`] = i
    expect(analyzeMongoDocuments([doc], { maxFields: 10 })).toHaveLength(10)
  })
})

describe('summarizeExplain', () => {
  it('summarizes a classic find plan', () => {
    const summary = summarizeExplain({
      queryPlanner: {
        winningPlan: {
          stage: 'SORT',
          inputStage: { stage: 'FETCH', inputStage: { stage: 'IXSCAN', indexName: 'userId_1' } }
        }
      },
      executionStats: {
        nReturned: 3,
        executionTimeMillis: 1,
        totalKeysExamined: 8,
        totalDocsExamined: 8
      }
    })
    expect(summary).toEqual({
      stages: ['SORT', 'FETCH', 'IXSCAN'],
      indexName: 'userId_1',
      docsExamined: 8,
      keysExamined: 8,
      nReturned: 3,
      executionTimeMs: 1
    })
  })

  it('summarizes an SBE aggregate with pipeline stages', () => {
    const summary = summarizeExplain({
      explainVersion: '2',
      stages: [
        {
          $cursor: {
            queryPlanner: {
              winningPlan: { queryPlan: { stage: 'GROUP', inputStage: { stage: 'COLLSCAN' } } }
            },
            executionStats: {
              nReturned: 179,
              executionTimeMillis: 3,
              totalKeysExamined: 0,
              totalDocsExamined: 2000
            }
          }
        },
        { $sort: { sortKey: { n: -1 } }, nReturned: 179, executionTimeMillisEstimate: 4 }
      ]
    })
    expect(summary.stages).toEqual(['$sort', 'GROUP', 'COLLSCAN'])
    expect(summary.indexName).toBeNull()
    expect(summary.docsExamined).toBe(2000)
    expect(summary.nReturned).toBe(179)
    expect(summary.executionTimeMs).toBe(4)
  })

  it('handles sharded and count plans', () => {
    const sharded = summarizeExplain({
      queryPlanner: {
        winningPlan: {
          stage: 'SHARD_MERGE',
          shards: [
            {
              winningPlan: { stage: 'COUNT', inputStage: { stage: 'COUNT_SCAN', indexName: 'a_1' } }
            }
          ]
        }
      }
    })
    expect(sharded.stages).toEqual(['SHARD_MERGE', 'COUNT', 'COUNT_SCAN'])
    expect(sharded.indexName).toBe('a_1')
    expect(sharded.nReturned).toBeNull()
  })
})

describe('export helpers', () => {
  it('round-trips the export spec', () => {
    const statement = mongoExportStatement(
      {
        kind: 'mongo',
        database: 'shop',
        collection: 'orders',
        filter: '{ status: "A" }',
        sort: '{ _id: 1 }',
        // The query bar's collation and hint (DataExportSource 'mongo').
        collation: "{ locale: 'en', strength: 2 }",
        hint: 'status_1'
      } as Parameters<typeof mongoExportStatement>[0],
      'csv'
    )
    expect(parseMongoExportSpec(statement)).toMatchObject({
      format: 'csv',
      database: 'shop',
      collection: 'orders',
      filter: '{ status: "A" }',
      sort: '{ _id: 1 }',
      collation: "{ locale: 'en', strength: 2 }",
      hint: 'status_1'
    })
    expect(parseMongoExportSpec('db.orders.find({})')).toBeNull()
    expect(
      parseMongoExportSpec(
        mongoExportStatement({ kind: 'query', text: 'db.x.find()', database: 'd' }, 'json')
      )
    ).toMatchObject({
      shell: 'db.x.find()',
      database: 'd',
      format: 'json'
    })
    expect(MONGO_EJSON_COLUMN).toBe('__ejson__')
  })

  it('flattens documents into CSV columns', () => {
    const { bson } = mongoRuntime()
    const collector = new CsvColumnCollector()
    const a = {
      name: 'x',
      _id: new bson.ObjectId('58c33a794d08b991e3648fd2'),
      address: { city: 'Paris' },
      tags: ['a', 'b']
    }
    const b = { _id: 2, extra: {}, address: { zip: '1' } }
    collector.add(a)
    collector.add(b)
    const columns = collector.columns()
    expect(columns).toEqual(['_id', 'name', 'address.city', 'tags', 'extra', 'address.zip'])
    const index = new Map(columns.map((c, i) => [c, i]))
    expect(csvRow(a, columns, index)).toEqual([
      '58c33a794d08b991e3648fd2',
      'x',
      'Paris',
      '["a","b"]',
      null,
      null
    ])
    expect(csvRow(b, columns, index)).toEqual([2, null, null, null, '{}', '1'])
  })
})

describe('toMongoDriverError', () => {
  const redact = (text: string): string => text.replaceAll('hunter2', '***')

  it('maps server errors with codeName, hint, detail and redaction', () => {
    const error = Object.assign(new Error('Authentication failed for hunter2'), {
      name: 'MongoServerError',
      code: 18,
      codeName: 'AuthenticationFailed'
    })
    const mapped = toMongoDriverError(error, redact)
    expect(mapped.code).toBe('AuthenticationFailed')
    expect(mapped.message).toBe('Authentication failed for ***')
    expect(mapped.hint).toMatch(/authSource/)
    const validation = Object.assign(new Error('Document failed validation'), {
      code: 121,
      codeName: 'DocumentValidationFailure',
      errInfo: { details: { reason: 'x' } }
    })
    expect(toMongoDriverError(validation, redact).detail).toContain('reason')
    const timeout = Object.assign(new Error('operation exceeded time limit'), {
      code: 50,
      codeName: 'MaxTimeMSExpired'
    })
    expect(toMongoDriverError(timeout, redact, { timeoutMs: 1000 }).hint).toMatch(/1000 ms/)
  })

  it('marks cancelled operations', () => {
    const interrupted = Object.assign(new Error('operation was interrupted'), {
      code: 11601,
      codeName: 'Interrupted'
    })
    expect(toMongoDriverError(interrupted, redact, { cancelled: true }).cancelled).toBe(true)
    expect(toMongoDriverError(interrupted, redact).cancelled).toBe(false)
    const passthrough = new DataDriverError('x hunter2', { sandboxRejected: true })
    const mapped = toMongoDriverError(passthrough, redact)
    expect(mapped.sandboxRejected).toBe(true)
    expect(mapped.message).toBe('x ***')
  })
})

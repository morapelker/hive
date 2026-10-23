// Live regression tests for result integrity against the dp-mongo container (127.0.0.1:27018,
// db "shop"): the per-request session database, collation on matching writes, the full-document
// filter of an edited document's save, lossless BSON regexes and the result byte budget.
// Gated: TEDOOO_DP_IT=1 (see mongo-live.test.ts). Scratch objects are tmp_fix_c1_* and dropped
// afterwards; seeded data is only read.

import type { Collection, Document } from 'mongodb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {
  DataDocumentsResult,
  DataExecutionPlan,
  DataValueResult
} from '../../../../../shared/data-projects/types'
import {
  DataDriverError,
  type DataProjectRecord,
  type DriverExecuteOptions,
  type DriverStatementResult,
  type EvaluateSafety,
  type SafetyEvaluationInput
} from '../../contracts'
import {
  MONGO_EJSON_COLUMN,
  createMongoDriver,
  createMongoEngineService,
  loadMongoRuntime,
  mongoExportStatement,
  type MongoDriver
} from '../index'

const live = !!process.env.TEDOOO_DP_IT
const describeLive = live ? describe : describe.skip

const PASSWORD = 'mongopw'
const run = Date.now().toString(36)
const scratchDb = `tmp_fix_c1_${run}_db`
const sessionColl = `tmp_fix_c1_${run}_session`
const collationColl = `tmp_fix_c1_${run}_coll`
const editColl = `tmp_fix_c1_${run}_edit`
const regexColl = `tmp_fix_c1_${run}_regex`
const bigColl = `tmp_fix_c1_${run}_big`

const record: DataProjectRecord = {
  id: 'mongo-integrity-live',
  name: 'Mongo integrity live',
  engine: 'mongodb',
  config: {
    host: '127.0.0.1',
    port: 27018,
    user: 'root',
    database: 'shop',
    mongo: { srv: false, hosts: ['127.0.0.1:27018'], authSource: 'admin' }
  },
  icon: null,
  iconColor: null,
  environment: 'production',
  color: null,
  safeMode: 'half-safe',
  defaultLimit: 1000,
  allowAiDataAccess: false,
  pinned: false,
  secretCiphertext: null,
  secretState: 'stored',
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastAccessedAt: '2026-01-01T00:00:00.000Z'
}

const redact = (text: string): string => text.split(PASSWORD).join('***')
const exec = (overrides: Partial<DriverExecuteOptions> = {}): DriverExecuteOptions => ({
  limit: 1000,
  hardCap: 100_000,
  readOnlySandbox: false,
  database: 'shop',
  ...overrides
})
const docs = (output: unknown): Array<Record<string, unknown>> =>
  (output as DataDocumentsResult).documents
const value = (output: unknown): unknown => (output as DataValueResult).value

let gateAction: 'run' | 'confirm' = 'run'
const gateCalls: SafetyEvaluationInput[] = []
const evaluateSafety: EvaluateSafety = (input) => {
  gateCalls.push(input)
  const plan: DataExecutionPlan = {
    dataProjectId: input.project.id,
    projectName: input.project.name,
    engine: 'mongodb',
    environment: input.project.environment,
    safeMode: input.project.safeMode,
    database: input.database,
    statements: input.statements.map((s) => ({
      index: s.index,
      text: s.text,
      start: s.start,
      end: s.end,
      classification: s.classification,
      dangerous: s.dangerous,
      reasons: [],
      needsConfirmation: true
    }))
  }
  const token = `tok:${input.fingerprintText}`
  if (input.confirmToken === token) return { action: 'run', sandboxReads: [false] }
  if (gateAction === 'confirm') return { action: 'confirm', plan, confirmToken: token }
  return { action: 'run', sandboxReads: [false] }
}

describeLive('MongoDB result integrity (live)', () => {
  let driver: MongoDriver
  const service = createMongoEngineService({
    getRecord: (id) => {
      if (id !== record.id) throw new DataDriverError('not found', { code: 'DATA_NOT_FOUND' })
      return record
    },
    getDriver: async () => driver,
    evaluateSafety,
    registerQuery: () => () => undefined,
    recordHistory: () => undefined
  })
  const ctx = { clientId: 'test-client' }
  const base = { dataProjectId: record.id, database: 'shop' }

  /** A scratch collection in shop whose documents have numeric _ids. */
  const scratchIn = async (name: string): Promise<Collection<{ _id: number } & Document>> =>
    (await driver.getClient()).db('shop').collection<{ _id: number } & Document>(name)

  /**
   * One Shell request the way the query runner runs it: every statement gets the database the
   * session ended the previous statement in, starting from the request's (the tab's) database.
   */
  async function runRequest(
    statements: string[],
    database: string | undefined
  ): Promise<{ results: DriverStatementResult[]; database: string | undefined }> {
    let db = database
    const results: DriverStatementResult[] = []
    for (const statement of statements) {
      results.push(await driver.execute(statement, exec({ database: db })))
      db = driver.sessionState().currentDatabase ?? db
    }
    return { results, database: driver.sessionState().currentDatabase ?? database }
  }

  beforeAll(async () => {
    driver = createMongoDriver({ project: record, secrets: { password: PASSWORD }, redact })
    await driver.connect()
  })

  afterAll(async () => {
    if (!driver) return
    const client = await driver.getClient()
    for (const name of [sessionColl, collationColl, editColl, regexColl, bigColl]) {
      await client
        .db('shop')
        .collection(name)
        .drop()
        .catch(() => undefined)
    }
    await client
      .db(scratchDb)
      .dropDatabase()
      .catch(() => undefined)
    await driver.close()
  })

  describe('session database', () => {
    it("keeps a tab's `use` inside its own request", async () => {
      // Tab A switches database; the rest of ITS request follows the switch.
      const a = await runRequest([`use ${scratchDb}`, 'db.getName()'], 'shop')
      expect(a.results[0].output).toEqual({
        kind: 'command',
        message: `switched to db ${scratchDb}`
      })
      expect(value(a.results[1].output)).toBe(scratchDb)
      expect(a.database).toBe(scratchDb)

      // Tab B is still on shop: its write lands in shop, not in tab A's database.
      const b = await runRequest(
        ['db.getName()', `db.getCollection('${sessionColl}').insertOne({ _id: 'from-b' })`],
        'shop'
      )
      expect(value(b.results[0].output)).toBe('shop')
      expect(b.database).toBe('shop')
      const client = await driver.getClient()
      expect(await client.db('shop').collection(sessionColl).countDocuments()).toBe(1)
      expect(await client.db(scratchDb).collection(sessionColl).countDocuments()).toBe(0)
    })

    it('runs a tab whose selector went back to the old database in that database', async () => {
      await runRequest([`use ${scratchDb}`], 'shop')
      // Same database as the request before the `use` (the old lastRequestedDb heuristic).
      const again = await runRequest([`db.getCollection('${sessionColl}').find({})`], 'shop')
      expect(docs(again.results[0].output)).toEqual([{ _id: 'from-b' }])
      expect(again.database).toBe('shop')
    })

    it('runs a request without a database in the connection database', async () => {
      await runRequest(['use admin'], 'shop')
      const connectionDefault = await runRequest(['db.getName()'], undefined)
      expect(value(connectionDefault.results[0].output)).toBe('shop')
      // Introspection without a database never follows a shell `use` either.
      await runRequest(['use admin'], 'shop')
      const listing = await driver.listObjects()
      expect(listing.objects.map((o) => o.name)).toEqual(
        expect.arrayContaining(['orders', 'users'])
      )
      expect((await driver.completionSchema()).database).toBe('shop')
    })

    it('reports the database a request ended in', async () => {
      const ended = await runRequest(['db.getName()', 'use admin', 'db.getName()'], 'shop')
      expect(ended.results.map((r) => value(r.output) ?? null)).toEqual(['shop', null, 'admin'])
      expect(ended.database).toBe('admin')
      expect(driver.sessionState().currentDatabase).toBe('admin')
      // A request that fails at once still reports its own database, not the last `use`.
      await expect(driver.execute('db.orders.find({', exec())).rejects.toMatchObject({
        code: 'SyntaxError'
      })
      expect(driver.sessionState().currentDatabase).toBe('shop')
    })
  })

  describe('collation on matching writes', () => {
    const numeric = "{ locale: 'en', numericOrdering: true }"
    const filter = "{ v: { $gt: '10' } }"

    beforeAll(async () => {
      const coll = await scratchIn(collationColl)
      await coll.insertMany([
        { _id: 1, v: '9' },
        { _id: 2, v: '10' },
        { _id: 3, v: '11' },
        { _id: 4, v: '100' },
        { _id: 5, name: 'alice' },
        { _id: 6, name: 'Bob' }
      ])
    })

    const remaining = async (): Promise<unknown[]> => {
      const coll = await scratchIn(collationColl)
      const list = await coll.find({ v: { $exists: true } }, { sort: { _id: 1 } }).toArray()
      return list.map((d) => d.v)
    }

    it('counts and deletes exactly what the collated query showed', async () => {
      const preview = await service.find(
        {
          ...base,
          queryId: 'q-coll',
          collection: collationColl,
          filter,
          collation: numeric,
          limit: 1,
          withCount: true
        },
        ctx
      )
      expect(preview.count).toBe(2)

      gateAction = 'confirm'
      const request = {
        ...base,
        collection: collationColl,
        op: 'deleteMany' as const,
        filter,
        collation: numeric
      }
      const asked = await service.write(request, ctx)
      if (asked.status !== 'confirmation_required') throw new Error('expected a confirmation')
      // The confirm dialog shows the collation, and the token is bound to it.
      expect(gateCalls[gateCalls.length - 1].statements[0].text).toBe(
        `db.getCollection("${collationColl}").deleteMany(${filter}, { collation: ${numeric} })`
      )
      const withoutCollation = await service.write(
        { ...request, collation: undefined, confirmToken: asked.confirmToken },
        ctx
      )
      expect(withoutCollation.status).toBe('confirmation_required')
      expect(await remaining()).toEqual(['9', '10', '11', '100'])

      const deleted = await service.write({ ...request, confirmToken: asked.confirmToken }, ctx)
      gateAction = 'run'
      expect(deleted).toMatchObject({ status: 'ok', deletedCount: 2 })
      // Binary string order would also have deleted '9'.
      expect(await remaining()).toEqual(['9', '10'])
    })

    it('applies the collation to update, replace and single-document deletes', async () => {
      const caseInsensitive = "{ locale: 'en', strength: 2 }"
      const coll = { ...base, collection: collationColl, collation: caseInsensitive }
      const updated = await service.write(
        {
          ...coll,
          op: 'updateMany',
          filter: "{ name: { $in: ['ALICE', 'bob'] } }",
          update: '{ $set: { seen: true } }'
        },
        ctx
      )
      expect(updated).toMatchObject({ status: 'ok', matchedCount: 2, modifiedCount: 2 })
      const one = await service.write(
        { ...coll, op: 'updateOne', filter: "{ name: 'BOB' }", update: '{ $set: { n: 1 } }' },
        ctx
      )
      expect(one).toMatchObject({ status: 'ok', matchedCount: 1 })
      const replaced = await service.write(
        { ...coll, op: 'replaceOne', filter: "{ name: 'ALICE' }", document: "{ name: 'alice' }" },
        ctx
      )
      expect(replaced).toMatchObject({ status: 'ok', matchedCount: 1, modifiedCount: 1 })
      const deleted = await service.write(
        { ...coll, op: 'deleteOne', filter: "{ name: 'bOB' }" },
        ctx
      )
      expect(deleted).toMatchObject({ status: 'ok', deletedCount: 1 })
      // Without the collation the same filter matches nothing.
      const binary = await service.write(
        { ...base, collection: collationColl, op: 'deleteOne', filter: "{ name: 'ALICE' }" },
        ctx
      )
      expect(binary).toMatchObject({ status: 'ok', deletedCount: 0 })
    })

    it('rejects a collation without a locale before asking for confirmation', async () => {
      const before = gateCalls.length
      await expect(
        service.write(
          {
            ...base,
            collection: collationColl,
            op: 'deleteMany',
            filter,
            collation: '{ strength: 2 }'
          },
          ctx
        )
      ).rejects.toMatchObject({ code: 'DATA_INVALID_INPUT' })
      expect(gateCalls.length).toBe(before)
    })

    it('exports with the query bar collation', async () => {
      const rows: unknown[][] = []
      await driver.streamRows(
        mongoExportStatement(
          {
            kind: 'mongo',
            database: 'shop',
            collection: collationColl,
            filter: "{ v: { $gte: '9' } }",
            sort: '{ _id: 1 }',
            collation: numeric,
            hint: '_id_'
          } as Parameters<typeof mongoExportStatement>[0],
          'json'
        ),
        { readOnlySandbox: true, signal: new AbortController().signal },
        async (_columns, batch) => {
          rows.push(...batch)
        }
      )
      // Numeric ordering: '10' >= '9' (binary order would leave it out).
      expect(rows.map((r) => (r[0] as { v: string }).v)).toEqual(['9', '10'])
    })
  })

  describe('saving an edited document', () => {
    const original = async (): Promise<Record<string, unknown>> => {
      const page = await service.find(
        { ...base, queryId: 'q-edit', collection: editColl, filter: '{ _id: 1 }', limit: 1 },
        ctx
      )
      return page.documents[0]
    }

    beforeAll(async () => {
      const { bson } = await loadMongoRuntime()
      const coll = await scratchIn(editColl)
      await coll.insertOne({
        _id: 1,
        notes: 'first',
        status: 'pending',
        at: new Date('2026-01-02T03:04:05.006Z'),
        qty: new bson.Int32(3),
        price: new bson.Double(2),
        big: bson.Long.fromString('9007199254740993'),
        amount: bson.Decimal128.fromString('10.50'),
        ref: new bson.ObjectId('5f0c4a5b8e4b3b0b8c8e4b3b'),
        tags: ['a', 'b'],
        nested: { x: 1, y: [{ z: true }] },
        re: new bson.BSONRegExp('a b', 'x'),
        nil: null
      })
    })

    it('replaces only when the whole original document still matches', async () => {
      const loaded = await original()
      const edited = { ...loaded, notes: 'edited' }
      const saved = await service.write(
        {
          ...base,
          collection: editColl,
          op: 'replaceOne',
          filter: JSON.stringify(loaded),
          document: JSON.stringify(edited)
        },
        ctx
      )
      expect(saved).toMatchObject({ status: 'ok', matchedCount: 1, modifiedCount: 1 })
      // Every value round-trips exactly (types included).
      expect(await original()).toEqual(edited)

      // A worker changes the status while the user edits the notes again.
      const stale = await original()
      await (await scratchIn(editColl)).updateOne({ _id: 1 }, { $set: { status: 'shipped' } })
      const conflict = await service.write(
        {
          ...base,
          collection: editColl,
          op: 'replaceOne',
          filter: JSON.stringify(stale),
          document: JSON.stringify({ ...stale, notes: 'stale edit' })
        },
        ctx
      )
      expect(conflict).toMatchObject({ status: 'ok', matchedCount: 0, modifiedCount: 0 })
      const after = await original()
      expect(after.status).toBe('shipped')
      expect(after.notes).toBe('edited')
    })

    it('detects added fields with an exact $$ROOT filter', async () => {
      const loaded = await original()
      const exact = (doc: Record<string, unknown>): string =>
        `{ _id: 1, $expr: { $eq: ['$$ROOT', { $literal: ${JSON.stringify(doc)} }] } }`
      await (await scratchIn(editColl)).updateOne({ _id: 1 }, { $set: { shippedAt: new Date() } })
      const conflict = await service.write(
        {
          ...base,
          collection: editColl,
          op: 'replaceOne',
          filter: exact(loaded),
          document: JSON.stringify({ ...loaded, notes: 'lost' })
        },
        ctx
      )
      expect(conflict).toMatchObject({ status: 'ok', matchedCount: 0 })
      const current = await original()
      const saved = await service.write(
        {
          ...base,
          collection: editColl,
          op: 'replaceOne',
          filter: exact(current),
          document: JSON.stringify({ ...current, notes: 'kept' })
        },
        ctx
      )
      expect(saved).toMatchObject({ status: 'ok', matchedCount: 1, modifiedCount: 1 })
      expect((await original()).shippedAt).toBeDefined()
    })
  })

  describe('BSON regex values', () => {
    const stored = [
      { _id: 1, pattern: 'a.b', options: 's' },
      { _id: 2, pattern: '(?i)abc', options: '' },
      { _id: 3, pattern: '(?P<year>\\d{4})', options: '' },
      { _id: 4, pattern: 'a b', options: 'x' }
    ]
    const expected = stored.map(({ _id, pattern, options }) => ({
      _id: { $numberInt: String(_id) },
      re: { $regularExpression: { pattern, options } }
    }))

    beforeAll(async () => {
      const { bson } = await loadMongoRuntime()
      const coll = await scratchIn(regexColl)
      await coll.insertMany(
        stored.map(({ _id, pattern, options }) => ({
          _id,
          re: new bson.BSONRegExp(pattern, options)
        }))
      )
    })

    it('reads s/x options and PCRE-only patterns losslessly everywhere', async () => {
      const page = await service.find(
        { ...base, queryId: 'q-re', collection: regexColl, sort: '{ _id: 1 }', limit: 10 },
        ctx
      )
      expect(page.documents).toEqual(expected)
      const shell = await driver.execute(
        `db.getCollection('${regexColl}').find({}).sort({ _id: 1 })`,
        exec()
      )
      expect(docs(shell.output)).toEqual(expected)
      const aggregated = await service.aggregate(
        {
          ...base,
          queryId: 'q-re-agg',
          collection: regexColl,
          pipeline: '[{ $sort: { _id: 1 } }]',
          limit: 10
        },
        ctx
      )
      expect(aggregated).toMatchObject({ status: 'ok', documents: expected })
      const schema = await service.schema({ ...base, collection: regexColl })
      expect(schema.fields.find((f) => f.path === 're')?.types).toEqual([
        { type: 'RegExp', probability: 1 }
      ])
      const exported: unknown[][] = []
      await driver.streamRows(
        mongoExportStatement({ kind: 'mongo', database: 'shop', collection: regexColl }, 'json'),
        { readOnlySandbox: true, signal: new AbortController().signal },
        async (columns, batch) => {
          expect(columns).toEqual([MONGO_EJSON_COLUMN])
          exported.push(...batch)
        }
      )
      expect(exported).toHaveLength(4)
    })

    it('writes an edited document back with its regex options', async () => {
      const page = await service.find(
        { ...base, queryId: 'q-re-1', collection: regexColl, filter: '{ _id: 4 }', limit: 1 },
        ctx
      )
      const loaded = page.documents[0]
      const saved = await service.write(
        {
          ...base,
          collection: regexColl,
          op: 'replaceOne',
          filter: JSON.stringify(loaded),
          document: JSON.stringify({ ...loaded, note: 'edited' })
        },
        ctx
      )
      expect(saved).toMatchObject({ status: 'ok', matchedCount: 1 })
      const raw = await (await scratchIn(regexColl)).findOne({ _id: 4 })
      const re = raw?.re as { pattern: string; options: string }
      expect({ pattern: re.pattern, options: re.options }).toEqual({ pattern: 'a b', options: 'x' })
    })
  })

  describe('result byte budget', () => {
    const DOCS = 70
    const MB = 1024 * 1024

    beforeAll(async () => {
      const payload = 'x'.repeat(MB)
      const coll = await scratchIn(bigColl)
      for (let start = 0; start < DOCS; start += 10) {
        await coll.insertMany(Array.from({ length: 10 }, (_, i) => ({ _id: start + i, payload })))
      }
    }, 60_000)

    it('stops a shell result at the budget and says so', async () => {
      const result = await driver.execute(`db.getCollection('${bigColl}').find({})`, exec())
      const output = result.output as DataDocumentsResult
      expect(output.documents.length).toBeGreaterThan(50)
      expect(output.documents.length).toBeLessThan(DOCS)
      expect(output.truncated).toBe(true)
      expect(output.limit).toBe(output.documents.length)
      expect(result.notices?.[0]).toMatch(/over 64 MB/)
      // Within the budget nothing changes.
      const small = await driver.execute(
        `db.getCollection('${bigColl}').find({}).limit(10)`,
        exec()
      )
      expect(docs(small.output)).toHaveLength(10)
      expect((small.output as DataDocumentsResult).truncated).toBe(false)
      expect(small.notices).toBeUndefined()
    })

    it('refuses an oversized Documents page instead of showing it short', async () => {
      await expect(
        service.find({ ...base, queryId: 'q-big', collection: bigColl, limit: 100 }, ctx)
      ).rejects.toMatchObject({ code: 'ResultTooLarge' })
      const page = await service.find(
        { ...base, queryId: 'q-big-20', collection: bigColl, limit: 20 },
        ctx
      )
      expect(page.documents).toHaveLength(20)
      expect(page.truncated).toBe(true)
    })

    it('bounds aggregations, schema samples and export batches', async () => {
      const aggregated = await service.aggregate(
        { ...base, queryId: 'q-big-agg', collection: bigColl, pipeline: '[]', limit: 100 },
        ctx
      )
      if (aggregated.status !== 'ok') throw new Error('expected documents')
      expect(aggregated.truncated).toBe(true)
      expect(aggregated.documents.length).toBeLessThan(DOCS)
      const schema = await service.schema({ ...base, collection: bigColl, sampleSize: 1000 })
      expect(schema.sampleSize).toBeLessThan(DOCS)
      const batches: number[] = []
      const exported = await driver.streamRows(
        mongoExportStatement({ kind: 'mongo', database: 'shop', collection: bigColl }, 'json'),
        { readOnlySandbox: true, signal: new AbortController().signal },
        async (_columns, rows) => {
          batches.push(rows.length)
        }
      )
      expect(exported.rows).toBe(DOCS)
      expect(Math.max(...batches)).toBeLessThanOrEqual(16)
    })
  })
})

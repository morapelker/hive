// Live tests against the dp-mongo container (MongoDB 8.0 on 127.0.0.1:27018, db "shop").
// Gated: TEDOOO_DP_IT=1 ./node_modules/.bin/vitest run --project main <this file>
// Scratch collections are named tmp_mongo_* and dropped afterwards; seeded data is only read.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {
  DataDocumentsResult,
  DataExecutionPlan,
  DataHistoryEntry,
  DataValueResult
} from '../../../../../shared/data-projects/types'
import {
  DataDriverError,
  type DataProjectRecord,
  type DriverExecuteOptions,
  type EvaluateSafety,
  type SafetyEvaluationInput
} from '../../contracts'
import {
  MONGO_EJSON_COLUMN,
  createMongoDriver,
  createMongoEngineService,
  mongoExportStatement,
  type MongoDriver
} from '../index'

const live = !!process.env.TEDOOO_DP_IT
const describeLive = live ? describe : describe.skip

const PASSWORD = 'mongopw'
const run = Date.now().toString(36)
const scratch = `tmp_mongo_${run}`
const scratch2 = `tmp_mongo_${run}_b`
const scratchOut = `tmp_mongo_${run}_out`
const scratchRenamed = `tmp_mongo_${run}_renamed`
const scratch3 = `tmp_mongo_${run}_c`

const record: DataProjectRecord = {
  id: 'mongo-live',
  name: 'Mongo live',
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
/** Canonical EJSON number → JS number. */
const num = (v: unknown): number => {
  if (typeof v === 'number') return v
  const o = v as Record<string, string>
  return Number(o.$numberInt ?? o.$numberDouble ?? o.$numberLong ?? o.$numberDecimal)
}
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// ---- fake service dependencies ------------------------------------------------------------------

let gateAction: 'run' | 'confirm' | 'block' = 'run'
const gateCalls: SafetyEvaluationInput[] = []
const history: Array<Omit<DataHistoryEntry, 'id'>> = []
const cancels = new Map<string, () => Promise<void>>()
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
  if (gateAction === 'block') return { action: 'block', plan, reason: 'read-only mode' }
  return { action: 'run', sandboxReads: [false] }
}

describeLive('MongoDB driver (live)', () => {
  let driver: MongoDriver
  const service = createMongoEngineService({
    getRecord: (id) => {
      if (id !== record.id) throw new DataDriverError('not found', { code: 'DATA_NOT_FOUND' })
      return record
    },
    getDriver: async () => driver,
    evaluateSafety,
    registerQuery: (queryId, _clientId, cancel) => {
      cancels.set(queryId, cancel)
      return () => cancels.delete(queryId)
    },
    recordHistory: (entry) => history.push(entry)
  })
  const ctx = { clientId: 'test-client' }

  beforeAll(async () => {
    driver = createMongoDriver({ project: record, secrets: { password: PASSWORD }, redact })
    const info = await driver.connect()
    expect(info.serverVersion).toMatch(/^\d+\.\d+/)
    expect(info.currentDatabase).toBe('shop')
  })

  afterAll(async () => {
    if (!driver) return
    const client = await driver.getClient()
    for (const name of [scratch, scratch2, scratch3, scratchOut, scratchRenamed]) {
      await client
        .db('shop')
        .collection(name)
        .drop()
        .catch(() => undefined)
    }
    await driver.close()
    expect(driver.isConnected()).toBe(false)
  })

  it('reports a bad password without leaking it', async () => {
    const bad = createMongoDriver({
      project: record,
      secrets: { password: 'wrong-password' },
      redact
    })
    await expect(bad.connect()).rejects.toMatchObject({ code: 'AuthenticationFailed' })
    await bad.close()
  })

  it('runs find with filter, sort and auto-limit truncation', async () => {
    const result = await driver.execute(
      "db.orders.find({ status: 'shipped' }, { orderNo: 1, total: 1 }).sort({ total: -1 })",
      exec({ limit: 5 })
    )
    const output = result.output as DataDocumentsResult
    expect(output.kind).toBe('documents')
    expect(output.documents).toHaveLength(5)
    expect(output.truncated).toBe(true)
    expect(output.limit).toBe(5)
    const totals = output.documents.map((d) => num(d.total))
    expect([...totals].sort((a, b) => b - a)).toEqual(totals)
    expect(Object.keys(output.documents[0]).sort()).toEqual(['_id', 'orderNo', 'total'])
    expect(output.documents[0]._id).toHaveProperty('$oid')
  })

  it('lets an explicit limit win and reports no truncation', async () => {
    const result = await driver.execute(
      'db.orders.find({}).sort({ orderNo: 1 }).skip(2).limit(3)',
      exec({ limit: 5 })
    )
    const output = result.output as DataDocumentsResult
    expect(output.documents.map((d) => num(d.orderNo))).toEqual([3, 4, 5])
    expect(output.truncated).toBe(false)
    expect(output.limit).toBeNull()
  })

  it('applies the hard cap', async () => {
    const output = (await driver.execute('db.orders.find()', exec({ limit: null, hardCap: 7 })))
      .output as DataDocumentsResult
    expect(output.documents).toHaveLength(7)
    expect(output.truncated).toBe(true)
    expect(output.limit).toBe(7)
  })

  it('runs aggregate with $group', async () => {
    const result = await driver.execute(
      "db.orders.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }, { $sort: { n: -1 } }])",
      exec()
    )
    const groups = docs(result.output)
    expect(groups.length).toBeGreaterThan(1)
    expect(groups.reduce((sum, g) => sum + num(g.n), 0)).toBe(2000)
  })

  it('returns counts, distinct and explain as values', async () => {
    expect(num(value((await driver.execute('db.orders.countDocuments({})', exec())).output))).toBe(
      2000
    )
    expect(num(value((await driver.execute('db.orders.find({}).count()', exec())).output))).toBe(
      2000
    )
    expect(
      num(value((await driver.execute('db.orders.find({ userId: 5 }).size()', exec())).output))
    ).toBeGreaterThan(0)
    expect(
      num(value((await driver.execute('db.orders.estimatedDocumentCount()', exec())).output))
    ).toBe(2000)
    const statuses = value(
      (await driver.execute("db.orders.distinct('status')", exec())).output
    ) as string[]
    expect(statuses.length).toBeGreaterThan(1)
    const plan = value(
      (await driver.execute("db.orders.find({ userId: 5 }).explain('executionStats')", exec()))
        .output
    ) as Record<string, unknown>
    expect(plan).toHaveProperty('queryPlanner')
    const prefix = value(
      (await driver.execute('db.orders.explain().count({ userId: 5 })', exec())).output
    ) as Record<string, unknown>
    expect(prefix).toHaveProperty('queryPlanner')
    expect(
      num(
        value(
          (
            await driver.execute(
              "db.orders.aggregate([{ $match: { status: 'shipped' } }]).itcount()",
              exec()
            )
          ).output
        )
      )
    ).toBeGreaterThan(0)
  })

  it('supports use, show and database methods', async () => {
    const use = await driver.execute('use admin', exec())
    expect(use.output).toEqual({ kind: 'command', message: 'switched to db admin' })
    expect(driver.sessionState().currentDatabase).toBe('admin')
    // Later statements of the same request get the session database from the query runner.
    const names = value((await driver.execute('db.getName()', exec({ database: 'admin' }))).output)
    expect(names).toBe('admin')
    // The next request names its own database: the `use` is gone.
    expect(value((await driver.execute('db.getName()', exec())).output)).toBe('shop')
    const collections = docs((await driver.execute('show collections', exec())).output).map(
      (d) => d.name
    )
    expect(collections).toEqual(expect.arrayContaining(['orders', 'products', 'users']))
    const dbs = docs((await driver.execute('show dbs', exec())).output).map((d) => d.name)
    expect(dbs).toContain('shop')
    const ping = value(
      (await driver.execute('db.runCommand({ ping: 1 })', exec())).output
    ) as Record<string, unknown>
    expect(num(ping.ok)).toBe(1)
    const sibling = value(
      (await driver.execute("db.getSiblingDB('admin').getName()", exec())).output
    )
    expect(sibling).toBe('admin')
    const infos = docs(
      (await driver.execute("db.getCollectionInfos({ name: 'orders' })", exec())).output
    )
    expect(infos[0]).toMatchObject({ name: 'orders', type: 'collection' })
  })

  it('refuses writes inside the read-only sandbox and rejects bad syntax with a position', async () => {
    await expect(
      driver.execute('db.orders.insertOne({ a: 1 })', exec({ readOnlySandbox: true }))
    ).rejects.toMatchObject({
      sandboxRejected: true
    })
    await expect(
      driver.execute("db.orders.aggregate([{ $out: 'x' }])", exec({ readOnlySandbox: true }))
    ).rejects.toMatchObject({
      sandboxRejected: true
    })
    const reads = await driver.execute('db.orders.find().limit(1)', exec({ readOnlySandbox: true }))
    expect(docs(reads.output)).toHaveLength(1)
    const text = 'db.orders.find({ a: require("fs") })'
    await expect(driver.execute(text, exec())).rejects.toMatchObject({
      position: text.indexOf('require')
    })
    await expect(driver.execute('db.orders.find({ a: 1 } ', exec())).rejects.toBeInstanceOf(
      DataDriverError
    )
  })

  it('inserts, updates and deletes on a scratch collection via the shell', async () => {
    const insert = value(
      (
        await driver.execute(
          `db.${scratch}.insertMany([{ n: 1, t: 'a' }, { n: 2, t: 'b' }, { n: 3, t: 'b' }])`,
          exec()
        )
      ).output
    ) as Record<string, unknown>
    expect(num(insert.insertedCount)).toBe(3)
    const one = value(
      (
        await driver.execute(
          `db.${scratch}.insertOne({ _id: 'fixed', at: ISODate('2024-01-01'), big: NumberLong('9007199254740993') })`,
          exec()
        )
      ).output
    ) as Record<string, unknown>
    expect(one.insertedId).toBe('fixed')
    const update = value(
      (await driver.execute(`db.${scratch}.updateMany({ t: 'b' }, { $inc: { n: 10 } })`, exec()))
        .output
    ) as Record<string, unknown>
    expect(num(update.modifiedCount)).toBe(2)
    const found = docs(
      (await driver.execute(`db.${scratch}.findOne({ _id: 'fixed' })`, exec())).output
    )
    expect(found[0].big).toEqual({ $numberLong: '9007199254740993' })
    expect(found[0].at).toEqual({ $date: { $numberLong: String(Date.UTC(2024, 0, 1)) } })
    const fam = value(
      (
        await driver.execute(
          `db.${scratch}.findOneAndUpdate({ n: 1 }, { $set: { t: 'z' } }, { returnNewDocument: true })`,
          exec()
        )
      ).output
    ) as Record<string, unknown>
    expect(fam.t).toBe('z')
    const bulk = value(
      (
        await driver.execute(
          `db.${scratch}.bulkWrite([{ insertOne: { document: { n: 99 } } }, { deleteOne: { filter: { n: 99 } } }])`,
          exec()
        )
      ).output
    ) as Record<string, unknown>
    expect(num(bulk.insertedCount)).toBe(1)
    expect(num(bulk.deletedCount)).toBe(1)
    const del = value(
      (await driver.execute(`db.${scratch}.deleteMany({ t: 'b' })`, exec())).output
    ) as Record<string, unknown>
    expect(num(del.deletedCount)).toBe(2)
    const idx = value(
      (await driver.execute(`db.${scratch}.createIndex({ n: -1 }, { name: 'n_desc' })`, exec()))
        .output
    )
    expect(idx).toBe('n_desc')
    expect(
      docs((await driver.execute(`db.${scratch}.getIndexes()`, exec())).output).map((i) => i.name)
    ).toContain('n_desc')
    await driver.execute(`db.${scratch}.dropIndex({ n: -1 })`, exec())
    expect(
      docs((await driver.execute(`db.${scratch}.getIndexes()`, exec())).output).map((i) => i.name)
    ).not.toContain('n_desc')
    const out = await driver.execute(
      `db.${scratch}.aggregate([{ $match: {} }, { $out: '${scratchOut}' }])`,
      exec()
    )
    expect(out.output.kind).toBe('command')
    expect(
      num(value((await driver.execute(`db.${scratchOut}.countDocuments()`, exec())).output))
    ).toBe(2)
    const drop = await driver.execute(`db.${scratchOut}.drop()`, exec())
    expect(drop.output).toMatchObject({ kind: 'command' })
  })

  it('accepts common mongosh idioms', async () => {
    const statements = [
      `db.orders.find({ // only recent ones\n  createdAt: { $gte: new Date(Date.now() - 3650 * 86400000) } }).limit(2)`,
      "db.orders.find({ status: { $in: ['shipped', 'paid'] }, total: { $gt: -Infinity } }).readPref('primary').limit(1)",
      'db.orders.find({ $expr: { $gt: ["$total", 100] } }, { _id: 0, total: 1 }).hint({ _id: 1 }).limit(1)',
      'db.orders.find({}).sort({ createdAt: -1 }).collation({ locale: "en" }).maxTimeMS(5000).limit(1);',
      "await db.getCollection('orders').findOne({ orderNo: 1 })",
      'db.orders.stats()',
      'db.stats()',
      'db.version()',
      'db.serverStatus()',
      'db.currentOp()',
      "db.orders.aggregate([{ $match: { status: 'shipped' } }], { allowDiskUse: true }).toArray()",
      "db.getSiblingDB('admin').aggregate([{ $currentOp: {} }, { $limit: 1 }])"
    ]
    for (const statement of statements) {
      const result = await driver.execute(statement, exec())
      expect(result.output, statement).toBeTruthy()
    }
    await driver.execute(`db.${scratch}.insertOne({ n: 1, tags: ['a'] })`, exec())
    const pipelineUpdate = value(
      (
        await driver.execute(
          `db.${scratch}.updateOne({ n: 1 }, [{ $set: { m: { $add: ['$n', 1] } } }])`,
          exec()
        )
      ).output
    ) as Record<string, unknown>
    expect(num(pipelineUpdate.modifiedCount)).toBe(1)
    await driver.execute(`db.${scratch}.createIndex({ m: 1 })`, exec())
    const hidden = value(
      (await driver.execute(`db.${scratch}.hideIndex('m_1')`, exec())).output
    ) as Record<string, unknown>
    expect(hidden).toHaveProperty('hidden_new')
    await driver.execute(`db.${scratch}.unhideIndex({ m: 1 })`, exec())
    await driver.execute(`db.${scratch}.dropIndexes()`, exec())
    const count = await driver.execute(`db.${scratch}.find({ m: 2 }).count()`, exec())
    expect(num(value(count.output))).toBe(1)
  })

  it('cancels a slow operation and kills it on the server', async () => {
    const statement = "db.orders.find({ $where: 'sleep(100) || false' })"
    const started = Date.now()
    const pending = driver.execute(statement, exec())
    // Attach the handler now: the rejection arrives while we are still awaiting cancelCurrent().
    const outcome = pending.then(
      () => new Error('expected the statement to be cancelled'),
      (error: unknown) => error
    )
    await sleep(700)
    const processes = await driver.listProcesses()
    const mine = processes.find((p) => (p.query ?? '').includes('sleep(100)'))
    expect(mine).toBeDefined()
    expect(mine?.isOwn).toBe(true)
    await driver.cancelCurrent()
    expect(await outcome).toMatchObject({ cancelled: true })
    expect(Date.now() - started).toBeLessThan(10_000)
    await sleep(500)
    const after = await driver.listProcesses()
    expect(after.find((p) => (p.query ?? '').includes('sleep(100)'))).toBeUndefined()
  })

  it('kills a process from the process list', async () => {
    const other = createMongoDriver({ project: record, secrets: { password: PASSWORD }, redact })
    await other.connect()
    try {
      const pending = other.execute("db.orders.find({ $where: 'sleep(101) || false' })", exec())
      const outcome = pending.then(
        () => new Error('expected the statement to be killed'),
        (error: unknown) => error
      )
      await sleep(700)
      const target = (await driver.listProcesses()).find((p) =>
        (p.query ?? '').includes('sleep(101)')
      )
      expect(target).toBeDefined()
      await driver.killProcess(target!.id, 'query')
      const killed = await outcome
      expect(killed).toBeInstanceOf(DataDriverError)
      expect((killed as DataDriverError).cancelled).toBe(false)
      expect((killed as DataDriverError).code).toBe('Interrupted')
    } finally {
      await other.close()
    }
  })

  it('introspects databases, collections, structure, DDL and completion schema', async () => {
    const dbs = await driver.listDatabases()
    expect(dbs.find((d) => d.name === 'shop')).toMatchObject({ isSystem: false })
    expect(dbs.find((d) => d.name === 'admin')).toMatchObject({ isSystem: true })
    const { objects } = await driver.listObjects('shop')
    const orders = objects.find((o) => o.name === 'orders')
    expect(orders).toMatchObject({ kind: 'collection', engine: 'collection', rowEstimate: 2000 })
    expect(orders?.sizeBytes).toBeGreaterThan(0)
    const details = await driver.describe({ database: 'shop', name: 'orders' })
    expect(details.columns.map((c) => c.name)).toEqual(
      expect.arrayContaining(['_id', 'orderNo', 'items.productId'])
    )
    expect(details.indexes.map((i) => i.name)).toEqual(
      expect.arrayContaining(['_id_', 'createdAt_-1', 'userId_1'])
    )
    expect(details.primaryKey).toEqual(['_id'])
    const ddl = await driver.ddl({ database: 'shop', name: 'users' })
    expect(ddl).toContain('db.createCollection("users")')
    expect(ddl).toContain(
      `db.getCollection("users").createIndex({ email: 1 }, { name: 'email_1', unique: true })`
    )
    const completion = await driver.completionSchema('shop', { refresh: true })
    const ordersTable = completion.tables.find((t) => t.name === 'orders')
    expect(ordersTable?.columns.map((c) => c.name)).toEqual(
      expect.arrayContaining(['status', 'items.unitPrice'])
    )
    expect(completion.databases).toContain('shop')
  })

  it('streams exports as EJSON and as flattened CSV', async () => {
    const jsonRows: unknown[][] = []
    let jsonColumns: string[] = []
    const json = await driver.streamRows(
      mongoExportStatement(
        { kind: 'mongo', database: 'shop', collection: 'orders', filter: '{ userId: 5 }' },
        'json'
      ),
      { readOnlySandbox: true, signal: new AbortController().signal },
      async (columns, rows) => {
        jsonColumns = columns
        jsonRows.push(...rows)
      }
    )
    expect(jsonColumns).toEqual([MONGO_EJSON_COLUMN])
    expect(json.rows).toBe(jsonRows.length)
    expect(json.rows).toBeGreaterThan(0)
    expect((jsonRows[0][0] as Record<string, unknown>).userId).toBe(5)
    const csvRows: unknown[][] = []
    let csvColumns: string[] = []
    const csv = await driver.streamRows(
      mongoExportStatement(
        { kind: 'mongo', database: 'shop', collection: 'users', sort: '{ _id: 1 }' },
        'csv'
      ),
      { readOnlySandbox: true, signal: new AbortController().signal },
      async (columns, rows) => {
        csvColumns = columns
        csvRows.push(...rows)
      }
    )
    expect(csv.rows).toBe(200)
    expect(csvColumns[0]).toBe('_id')
    expect(csvColumns).toEqual(expect.arrayContaining(['address.city', 'email']))
    expect(csvRows[0][0]).toBe(1)
    const shellRows: unknown[][] = []
    await driver.streamRows(
      'db.orders.aggregate([{ $match: { userId: 5 } }, { $project: { orderNo: 1 } }])',
      { database: 'shop', readOnlySandbox: true, signal: new AbortController().signal },
      async (_c, rows) => {
        shellRows.push(...rows)
      }
    )
    expect(shellRows.length).toBe(json.rows)
    await expect(
      driver.streamRows(
        "db.orders.aggregate([{ $out: 'nope' }])",
        { database: 'shop', readOnlySandbox: true, signal: new AbortController().signal },
        async () => undefined
      )
    ).rejects.toBeInstanceOf(DataDriverError)
    const controller = new AbortController()
    controller.abort()
    await expect(
      driver.streamRows(
        mongoExportStatement({ kind: 'mongo', database: 'shop', collection: 'orders' }, 'json'),
        { readOnlySandbox: true, signal: controller.signal },
        async () => undefined
      )
    ).rejects.toMatchObject({ cancelled: true })
  })

  // ---- engine service ---------------------------------------------------------------------------

  it('service.find: filter/projection/sort/limit with count', async () => {
    const response = await service.find(
      {
        dataProjectId: record.id,
        queryId: 'q-find',
        database: 'shop',
        collection: 'orders',
        filter: "{ status: 'shipped' }",
        projection: '{ orderNo: 1, total: 1 }',
        sort: '{ orderNo: 1 }',
        limit: 10,
        withCount: true
      },
      ctx
    )
    expect(response.documents).toHaveLength(10)
    expect(response.truncated).toBe(true)
    expect(response.count).toBeGreaterThan(10)
    const orderNos = response.documents.map((d) => num(d.orderNo))
    expect([...orderNos].sort((a, b) => a - b)).toEqual(orderNos)
    const page2 = await service.find(
      {
        dataProjectId: record.id,
        queryId: 'q-find2',
        database: 'shop',
        collection: 'orders',
        sort: '{ orderNo: 1 }',
        skip: 1995,
        limit: 10,
        withCount: true
      },
      ctx
    )
    expect(page2.documents).toHaveLength(5)
    expect(page2.truncated).toBe(false)
    expect(page2.count).toBe(2000)
    await expect(
      service.find(
        {
          dataProjectId: record.id,
          queryId: 'q-bad',
          database: 'shop',
          collection: 'orders',
          filter: '{ a: process.env }',
          limit: 5
        },
        ctx
      )
    ).rejects.toMatchObject({ code: 'DATA_INVALID_INPUT' })
  })

  it('service.find can be cancelled through registerQuery', async () => {
    const pending = service.find(
      {
        dataProjectId: record.id,
        queryId: 'q-slow',
        database: 'shop',
        collection: 'orders',
        filter: "{ $where: 'sleep(100) || false' }",
        limit: 5
      },
      ctx
    )
    const outcome = pending.then(
      () => new Error('expected the find to be cancelled'),
      (error: unknown) => error
    )
    await sleep(500)
    const cancel = cancels.get('q-slow')
    expect(cancel).toBeDefined()
    await cancel!()
    expect(await outcome).toMatchObject({ cancelled: true })
    expect(cancels.has('q-slow')).toBe(false)
  })

  it('service.aggregate: stage preview never writes; $out is gated', async () => {
    const pipeline = `[{ $match: { status: 'shipped' } }, { $group: { _id: '$userId', n: { $sum: 1 } } }, { $out: '${scratchOut}' }]`
    const preview = await service.aggregate(
      {
        dataProjectId: record.id,
        queryId: 'q-agg',
        database: 'shop',
        collection: 'orders',
        pipeline,
        stageIndex: 2,
        limit: 5
      },
      ctx
    )
    expect(preview.status).toBe('ok')
    if (preview.status === 'ok') {
      expect(preview.documents).toHaveLength(5)
      expect(preview.truncated).toBe(true)
    }
    const client = await driver.getClient()
    expect(await client.db('shop').listCollections({ name: scratchOut }).toArray()).toHaveLength(0)

    gateAction = 'confirm'
    const before = gateCalls.length
    const confirm = await service.aggregate(
      {
        dataProjectId: record.id,
        queryId: 'q-agg2',
        database: 'shop',
        collection: 'orders',
        pipeline,
        limit: 5
      },
      ctx
    )
    expect(confirm.status).toBe('confirmation_required')
    expect(gateCalls.length).toBe(before + 1)
    expect(gateCalls[before]).toMatchObject({ source: 'mongo', database: 'shop' })
    expect(gateCalls[before].statements[0]).toMatchObject({
      classification: 'write',
      targets: [scratchOut]
    })
    expect(gateCalls[before].statements[0].dangerous[0]).toMatch(/\$out replaces collection/)
    expect(await client.db('shop').listCollections({ name: scratchOut }).toArray()).toHaveLength(0)
    if (confirm.status !== 'confirmation_required') throw new Error('expected confirmation')
    const ran = await service.aggregate(
      {
        dataProjectId: record.id,
        queryId: 'q-agg3',
        database: 'shop',
        collection: 'orders',
        pipeline,
        limit: 5,
        confirmToken: confirm.confirmToken
      },
      ctx
    )
    expect(ran.status).toBe('ok')
    expect(await client.db('shop').collection(scratchOut).estimatedDocumentCount()).toBeGreaterThan(
      0
    )
    gateAction = 'run'
  })

  it('service.write: gated writes on a scratch collection', async () => {
    gateAction = 'run'
    const insert = await service.write(
      {
        dataProjectId: record.id,
        database: 'shop',
        collection: scratch2,
        op: 'insertMany',
        document: "[{ _id: 1, s: 'a' }, { _id: 2, s: 'b' }, { _id: 3, s: 'b' }]"
      },
      ctx
    )
    expect(insert).toMatchObject({ status: 'ok', insertedCount: 3 })
    const update = await service.write(
      {
        dataProjectId: record.id,
        database: 'shop',
        collection: scratch2,
        op: 'updateMany',
        filter: "{ s: 'b' }",
        update: '{ $set: { flag: true } }'
      },
      ctx
    )
    expect(update).toMatchObject({ status: 'ok', matchedCount: 2, modifiedCount: 2 })
    const upsert = await service.write(
      {
        dataProjectId: record.id,
        database: 'shop',
        collection: scratch2,
        op: 'updateOne',
        filter: '{ _id: 9 }',
        update: '{ $set: { s: "new" } }',
        upsert: true
      },
      ctx
    )
    expect(upsert).toMatchObject({ status: 'ok', upsertedId: { $numberInt: '9' } })
    const replace = await service.write(
      {
        dataProjectId: record.id,
        database: 'shop',
        collection: scratch2,
        op: 'replaceOne',
        filter: '{ _id: 1 }',
        document: "{ s: 'replaced' }"
      },
      ctx
    )
    expect(replace).toMatchObject({ status: 'ok', modifiedCount: 1 })
    await expect(
      service.write(
        {
          dataProjectId: record.id,
          database: 'shop',
          collection: scratch2,
          op: 'updateOne',
          filter: '{}',
          update: '{ s: 1 }'
        },
        ctx
      )
    ).rejects.toMatchObject({ code: 'DATA_INVALID_INPUT' })

    gateAction = 'confirm'
    const before = gateCalls.length
    const confirm = await service.write(
      {
        dataProjectId: record.id,
        database: 'shop',
        collection: scratch2,
        op: 'deleteMany',
        filter: '{}'
      },
      ctx
    )
    expect(confirm.status).toBe('confirmation_required')
    const statement = gateCalls[before].statements[0]
    expect(statement.dangerous[0]).toMatch(/deleteMany with an empty filter deletes every document/)
    expect(statement.targets).toEqual([scratch2])
    expect(statement.text).toBe(`db.getCollection("${scratch2}").deleteMany({})`)
    const client = await driver.getClient()
    expect(await client.db('shop').collection(scratch2).countDocuments()).toBe(4)

    gateAction = 'block'
    const blocked = await service.write(
      {
        dataProjectId: record.id,
        database: 'shop',
        collection: scratch2,
        op: 'deleteOne',
        filter: '{ _id: 2 }'
      },
      ctx
    )
    expect(blocked.status).toBe('blocked')
    expect(history[history.length - 1]).toMatchObject({ status: 'blocked', database: 'shop' })

    gateAction = 'run'
    if (confirm.status !== 'confirmation_required') throw new Error('expected confirmation')
    const deleted = await service.write(
      {
        dataProjectId: record.id,
        database: 'shop',
        collection: scratch2,
        op: 'deleteMany',
        filter: '{}',
        confirmToken: confirm.confirmToken
      },
      ctx
    )
    expect(deleted).toMatchObject({ status: 'ok', deletedCount: 4 })
    expect(history[history.length - 1]).toMatchObject({ status: 'ok', rowCount: 4 })
  })

  it('service indexes: list with sizes, create and drop (gated)', async () => {
    const client = await driver.getClient()
    await client
      .db('shop')
      .collection(scratch2)
      .insertMany([
        { a: 1, b: 'x' },
        { a: 2, b: 'y' }
      ])
    gateAction = 'run'
    const created = await service.createIndex({
      dataProjectId: record.id,
      database: 'shop',
      collection: scratch2,
      keys: '{ a: 1, b: -1 }',
      options: "{ name: 'a_b', unique: true, partialFilterExpression: { a: { $gt: 0 } } }"
    })
    expect(created).toMatchObject({ status: 'ok', name: 'a_b' })
    const list = await service.indexes(record.id, 'shop', scratch2)
    const index = list.find((i) => i.name === 'a_b')
    expect(index).toMatchObject({
      unique: true,
      sparse: false,
      hidden: false,
      keys: { a: { $numberInt: '1' }, b: { $numberInt: '-1' } }
    })
    expect(index?.partialFilterExpression).toEqual({ a: { $gt: { $numberInt: '0' } } })
    expect(index?.sizeBytes).toBeGreaterThan(0)
    expect(list.find((i) => i.name === '_id_')?.accesses).not.toBeUndefined()
    gateAction = 'confirm'
    const before = gateCalls.length
    const confirm = await service.dropIndex({
      dataProjectId: record.id,
      database: 'shop',
      collection: scratch2,
      name: 'a_b'
    })
    expect(confirm.status).toBe('confirmation_required')
    expect(gateCalls[before].statements[0]).toMatchObject({
      classification: 'ddl',
      targets: ['a_b']
    })
    if (confirm.status !== 'confirmation_required') throw new Error('expected confirmation')
    const dropped = await service.dropIndex({
      dataProjectId: record.id,
      database: 'shop',
      collection: scratch2,
      name: 'a_b',
      confirmToken: confirm.confirmToken
    })
    expect(dropped.status).toBe('ok')
    expect((await service.indexes(record.id, 'shop', scratch2)).map((i) => i.name)).toEqual([
      '_id_'
    ])
    gateAction = 'run'
  })

  it('service.schema analyses orders', async () => {
    const schema = await service.schema({
      dataProjectId: record.id,
      database: 'shop',
      collection: 'orders',
      sampleSize: 500
    })
    expect(schema.sampleSize).toBe(500)
    expect(schema.count).toBe(2000)
    expect(schema.validator).toBeNull()
    const by = Object.fromEntries(schema.fields.map((f) => [f.path, f]))
    expect(by.orderNo.probability).toBe(1)
    expect(by.orderNo.uniqueness).toBe(1)
    expect(by.status.uniqueness).toBeLessThan(0.1)
    expect(by.status.sampleValues?.length).toBeGreaterThan(1)
    expect(by['items.productId']).toBeDefined()
    expect(by.createdAt.types[0].type).toBe('Date')
    expect(by.items.types[0].type).toBe('Array')
  })

  it('service.explain summarizes find and aggregate plans', async () => {
    const find = await service.explain({
      dataProjectId: record.id,
      database: 'shop',
      collection: 'orders',
      find: { filter: '{ userId: 5 }', sort: '{ createdAt: -1 }', limit: 3 }
    })
    expect(find.summary.stages).toContain('IXSCAN')
    expect(find.summary.indexName).toBe('userId_1')
    expect(find.summary.nReturned).toBe(3)
    expect(find.summary.keysExamined).toBeGreaterThan(0)
    expect(find.raw).toHaveProperty('queryPlanner')
    const agg = await service.explain({
      dataProjectId: record.id,
      database: 'shop',
      collection: 'orders',
      pipeline:
        "[{ $match: { status: 'shipped' } }, { $group: { _id: '$userId' } }, { $out: 'never_created' }]"
    })
    expect(agg.summary.stages.length).toBeGreaterThan(0)
    const client = await driver.getClient()
    expect(
      await client.db('shop').listCollections({ name: 'never_created' }).toArray()
    ).toHaveLength(0)
  })

  it('service.collection: create, rename and drop (gated, dangerous drop)', async () => {
    gateAction = 'run'
    const created = await service.collection({
      dataProjectId: record.id,
      database: 'shop',
      action: {
        kind: 'create',
        collection: scratch3,
        options: '{ validator: { $jsonSchema: { required: ["n"] } } }'
      }
    })
    expect(created.status).toBe('ok')
    const schema = await service.schema({
      dataProjectId: record.id,
      database: 'shop',
      collection: scratch3
    })
    expect(schema.validator).toMatchObject({ $jsonSchema: { required: ['n'] } })
    const renamed = await service.collection({
      dataProjectId: record.id,
      database: 'shop',
      action: { kind: 'rename', collection: scratch3, to: scratchRenamed }
    })
    expect(renamed.status).toBe('ok')
    gateAction = 'confirm'
    const before = gateCalls.length
    const confirm = await service.collection({
      dataProjectId: record.id,
      database: 'shop',
      action: { kind: 'drop', collection: scratchRenamed }
    })
    expect(confirm.status).toBe('confirmation_required')
    expect(gateCalls[before].statements[0].dangerous[0]).toMatch(/drop\(\) deletes collection/)
    if (confirm.status !== 'confirmation_required') throw new Error('expected confirmation')
    const dropped = await service.collection({
      dataProjectId: record.id,
      database: 'shop',
      action: { kind: 'drop', collection: scratchRenamed },
      confirmToken: confirm.confirmToken
    })
    expect(dropped.status).toBe('ok')
    const client = await driver.getClient()
    expect(
      await client.db('shop').listCollections({ name: scratchRenamed }).toArray()
    ).toHaveLength(0)
    gateAction = 'run'
  })
})

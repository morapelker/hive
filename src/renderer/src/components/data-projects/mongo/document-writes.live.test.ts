// @vitest-environment node
// Live: the Documents tab's write requests as the real Mongo engine service runs them, against the
// dp-mongo container (MongoDB on 127.0.0.1:27018, db "shop"). Gated:
//   TEDOOO_DP_IT=1 ./node_modules/.bin/vitest run --project renderer <this file>
// - An edit's optimistic-concurrency filter (concurrencyFilterText of the document as Find
//   returned it) matches the unchanged document — every BSON type the editor round-trips,
//   regexes, embedded documents, arrays, dotted / integer-like keys — and matches nothing once
//   another writer changed, added or removed a field.
// - The filter is matched with CONCURRENCY_COLLATION (binary), so on a collection whose default
//   collation is case-insensitive a case-only change made meanwhile is a conflict too.
// - Delete matching… with the query bar's collation deletes exactly what Find counted.
// Scratch collections are named tmp_fix2_* and dropped afterwards; seeded data is not touched.
//
// The engine is loaded by a computed path so the renderer's typecheck does not pull the main
// process sources in; the few members used are typed locally.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {
  MongoFindRequest,
  MongoFindResponse,
  MongoWriteRequest,
  MongoWriteResponse
} from '@shared/data-projects/types'
import { formatShellDocument } from './ejson'
import { CONCURRENCY_COLLATION, concurrencyFilterText } from './requests'

const live = !!process.env.TEDOOO_DP_IT
const describeLive = live ? describe : describe.skip

interface RawCollection {
  updateOne(filter: object, update: object | object[]): Promise<unknown>
  insertOne(doc: object): Promise<unknown>
  insertMany(docs: object[]): Promise<unknown>
  find(filter: object): { toArray(): Promise<Array<Record<string, unknown>>> }
  drop(): Promise<unknown>
}
interface LiveDriver {
  connect(): Promise<unknown>
  close(): Promise<void>
  getClient(): Promise<{
    db(name: string): {
      collection(name: string): RawCollection
      createCollection(name: string, options: object): Promise<unknown>
    }
  }>
}
interface LiveService {
  find(req: MongoFindRequest, ctx: { clientId: string }): Promise<MongoFindResponse>
  write(req: MongoWriteRequest, ctx: { clientId: string }): Promise<MongoWriteResponse>
}
interface SafetyInput {
  statements: unknown[]
}
interface MongoEngineModule {
  createMongoDriver(options: {
    project: unknown
    secrets: { password: string }
    redact: (text: string) => string
  }): LiveDriver
  createMongoEngineService(deps: {
    getRecord: (id: string) => unknown
    getDriver: () => Promise<LiveDriver>
    evaluateSafety: (input: SafetyInput) => unknown
    registerQuery: () => () => void
    recordHistory: () => void
  }): LiveService
}

const ENGINE = '../../../../../main/services/data-projects/mongo/index.ts'

const PASSWORD = 'mongopw'
const run = Date.now().toString(36)
const docsColl = `tmp_fix2_${run}_docs`
const collColl = `tmp_fix2_${run}_coll`
const ciColl = `tmp_fix2_${run}_ci`

const record = {
  id: 'mongo-c2-live',
  name: 'Mongo C2 live',
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
}

// Safe mode off: every write runs (the gate itself has its own tests).
const evaluateSafety = (input: SafetyInput) => ({
  action: 'run',
  sandboxReads: input.statements.map(() => false)
})

describeLive('Documents writes (live MongoDB)', () => {
  let driver: LiveDriver
  let service: LiveService
  const ctx = { clientId: 'c2-live' }
  const raw = async () => (await driver.getClient()).db('shop')

  /** The document as the Documents tab gets it (canonical EJSON through service.find). */
  const load = async (id: number, collection = docsColl): Promise<Record<string, unknown>> => {
    const res = await service.find(
      {
        dataProjectId: record.id,
        queryId: `q-${id}-${Math.random()}`,
        database: 'shop',
        collection,
        filter: `{ _id: ${id} }`,
        limit: 1
      },
      ctx
    )
    expect(res.documents).toHaveLength(1)
    return res.documents[0]
  }

  /** Saves `doc` (edited) the way DocumentsView does: replaceOne of the loaded version. */
  const save = async (
    loaded: Record<string, unknown>,
    edited: Record<string, unknown>,
    collection = docsColl
  ) => {
    const request: MongoWriteRequest = {
      dataProjectId: record.id,
      database: 'shop',
      collection,
      op: 'replaceOne',
      filter: concurrencyFilterText(loaded)!,
      collation: CONCURRENCY_COLLATION,
      document: formatShellDocument(edited, 'edit')
    }
    const res = await service.write(request, ctx)
    if (res.status !== 'ok') throw new Error(`unexpected ${res.status}`)
    return res.matchedCount
  }

  beforeAll(async () => {
    const engine = (await import(/* @vite-ignore */ ENGINE)) as MongoEngineModule
    service = engine.createMongoEngineService({
      getRecord: (id) => {
        if (id !== record.id) throw new Error(`unknown data project ${id}`)
        return record
      },
      getDriver: async () => driver,
      evaluateSafety,
      registerQuery: () => () => undefined,
      recordHistory: () => undefined
    })
    driver = engine.createMongoDriver({
      project: record,
      secrets: { password: PASSWORD },
      redact: (t) => t.split(PASSWORD).join('***')
    })
    await driver.connect()
    const db = await raw()
    // Every value kind the edit dialog round-trips, created through the shell parser.
    const inserted = await service.write(
      {
        dataProjectId: record.id,
        database: 'shop',
        collection: docsColl,
        op: 'insertMany',
        document: `[
          {
            _id: 1,
            status: 'A',
            total: Double(10),
            n: 7,
            big: NumberLong('9007199254740993'),
            price: NumberDecimal('19.90'),
            at: ISODate('2026-10-01T12:00:00.123Z'),
            oid: ObjectId('66f0a0a0a0a0a0a0a0a0a0a1'),
            uuid: UUID('3b241101-e2bb-4255-8caf-4136c566a962'),
            bin: BinData(0, 'AQID'),
            ts: Timestamp({ t: 1700000000, i: 3 }),
            pattern: /^a.c$/i,
            tags: ['x', 'y'],
            address: { city: 'TLV', zip: '61000', geo: [34.78, 32.08] },
            items: [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 1 }],
            none: null,
            flag: false
          },
          { _id: 2, status: 'A', tags: [] },
          { _id: 3, status: 'A' }
        ]`
      },
      ctx
    )
    expect(inserted).toMatchObject({ status: 'ok', insertedCount: 3 })
    // Field names a filter cannot address exactly (dotted, integer-like inside an object).
    await db
      .collection(docsColl)
      .updateOne({ _id: 3 }, [
        { $replaceWith: { $setField: { field: 'a.b', input: '$$ROOT', value: 1 } } }
      ])
    await db
      .collection(docsColl)
      .updateOne({ _id: 3 }, { $set: { byIndex: { '10': 'x', '2': 'y' } } })
  })

  afterAll(async () => {
    if (!driver) return
    const db = await raw()
    for (const name of [docsColl, collColl, ciColl])
      await db
        .collection(name)
        .drop()
        .catch(() => undefined)
    await driver.close()
  })

  it('saves an unchanged document of every kind, and then the saved version again', async () => {
    const loaded = await load(1)
    expect(await save(loaded, { ...loaded, status: 'B' })).toBe(1)
    const reloaded = await load(1)
    expect(reloaded.status).toBe('B')
    // Types survived the round trip, so the new version matches its own filter too.
    expect(await save(reloaded, { ...reloaded, status: 'C' })).toBe(1)
    expect((await load(1)).status).toBe('C')
  })

  it('matches nothing after another writer changed, added or removed a field', async () => {
    const db = (await raw()).collection(docsColl)
    const concurrent: Array<Record<string, unknown>> = [
      { $set: { status: 'shipped' } },
      { $set: { 'address.city': 'Haifa' } },
      { $push: { tags: 'z' } },
      { $set: { 'items.0.qty': 3 } },
      { $set: { extra: 1 } },
      { $unset: { flag: '' } }
    ]
    for (const update of concurrent) {
      const loaded = await load(1)
      await db.updateOne({ _id: 1 }, update)
      const now = await load(1)
      expect(await save(loaded, { ...loaded, status: 'MINE' })).toBe(0)
      // Nothing was overwritten.
      expect(await load(1)).toEqual(now)
    }
  })

  it('handles an empty array and fields only the field count can guard', async () => {
    const two = await load(2)
    expect(await save(two, { ...two, status: 'B' })).toBe(1)
    const three = await load(3)
    expect(concurrencyFilterText(three)).not.toContain('a.b')
    expect(await save(three, { ...three, status: 'B' })).toBe(1)
    const again = await load(3)
    await (await raw()).collection(docsColl).updateOne({ _id: 3 }, { $set: { more: 1 } })
    expect(await save(again, { ...again, status: 'C' })).toBe(0)
  })

  it('sees a case-only change on a collection with a case-insensitive default collation', async () => {
    const db = await raw()
    await db.createCollection(ciColl, { collation: { locale: 'en', strength: 2 } })
    const coll = db.collection(ciColl)
    await coll.insertOne({ _id: 1, name: 'alice', tags: { city: 'tlv' } })
    const loaded = await load(1, ciColl)
    await coll.updateOne({ _id: 1 }, { $set: { name: 'ALICE', 'tags.city': 'TLV' } })
    expect(await save(loaded, { ...loaded, touched: true }, ciColl)).toBe(0)
    const after = await load(1, ciColl)
    expect(after).toMatchObject({ name: 'ALICE', tags: { city: 'TLV' } })
    expect(after.touched).toBeUndefined()
    // The current version still saves (and the _id lookup is unaffected by the collation).
    const current = await load(1, ciColl)
    expect(await save(current, { ...current, touched: true }, ciColl)).toBe(1)
    expect((await load(1, ciColl)).touched).toBe(true)
  })

  it('Delete matching… with the collation deletes what Find counted (server applies it)', async () => {
    const db = (await raw()).collection(collColl)
    await db.insertMany(['9', '10', '11', '100'].map((v) => ({ v })))
    const filter = "{ v: { $gt: '10' } }"
    const collation = "{ locale: 'en', numericOrdering: true }"
    const found = await service.find(
      {
        dataProjectId: record.id,
        queryId: `q-coll-${run}`,
        database: 'shop',
        collection: collColl,
        filter,
        collation,
        limit: 1,
        withCount: true
      },
      ctx
    )
    expect(found.count).toBe(2)
    const deleted = await service.write(
      {
        dataProjectId: record.id,
        database: 'shop',
        collection: collColl,
        op: 'deleteMany',
        filter,
        collation
      },
      ctx
    )
    expect(deleted).toMatchObject({ status: 'ok', deletedCount: 2 })
    const left = (await db.find({}).toArray()).map((d) => d.v).sort()
    expect(left).toEqual(['10', '9'])
  })
})

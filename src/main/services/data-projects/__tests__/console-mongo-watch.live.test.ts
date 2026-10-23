// Mongo command monitoring only while a console follows the project, against the real server and
// the real driver (mongo/connection.ts creates the client with monitoring on): unwatched, the
// pool's connections are checked out with their event flag off — no command events, so the
// driver does not decode every reply a second time — and the Documents view's finds are not
// logged; after a console lists the project, the same finds are logged as wire commands, and
// when the lease runs out the connections go quiet again. Also times a 150k-document find
// unwatched, watched, and on a client without monitoring at all (printed). Gated:
// TEDOOO_DP_IT=1. Only tmp_fix3_* collections are written (and dropped).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoClient } from 'mongodb'
import type { DataDriver, DriverConnectInput } from '../contracts'
import { DataConsoleLog, instrumentDriver } from '../console-log'
import { createDriver } from '../drivers'
import { buildMongoClientConfig } from '../mongo/connection'
import { makeRecord } from './engine-fixtures'

const LIVE = !!process.env.TEDOOO_DP_IT
const itLive = LIVE ? it : it.skip
const ID = 'console-mongo-watch'
const SCRATCH = 'tmp_fix3_monwatch'
const DOCS = 150_000

let now = 1_000_000
let log: DataConsoleLog
let driver: DataDriver & { getClient(): Promise<MongoClient> }
let client: MongoClient

const input: DriverConnectInput = {
  project: makeRecord({
    id: ID,
    engine: 'mongodb',
    environment: 'local',
    safeMode: 'off',
    config: {
      host: '127.0.0.1',
      port: 27018,
      user: 'root',
      database: 'shop',
      mongo: { srv: false, hosts: ['127.0.0.1:27018'], authSource: 'admin', directConnection: true }
    }
  }),
  secrets: { password: 'mongopw' },
  redact: (t) => t
}

/** Counts the client's command events while `fn` runs. */
async function eventsDuring(fn: () => Promise<unknown>): Promise<number> {
  let events = 0
  const count = (): void => {
    events++
  }
  client.on('commandSucceeded', count)
  try {
    await fn()
  } finally {
    client.off('commandSucceeded', count)
  }
  return events
}

const readAll = async (from: MongoClient = client): Promise<number> => {
  let n = 0
  const cursor = from.db('shop').collection(SCRATCH).find({}, { batchSize: 20_000 })
  while ((await cursor.next()) !== null) n++
  return n
}

beforeAll(async () => {
  if (!LIVE) return
  log = new DataConsoleLog({ now: () => now, watchLeaseMs: 60_000 })
  driver = instrumentDriver(createDriver(input), input, log) as typeof driver
  await driver.connect()
  client = await driver.getClient()
  const coll = client.db('shop').collection(SCRATCH)
  await coll.drop().catch(() => undefined)
  for (let i = 0; i < DOCS; i += 10_000) {
    await coll.insertMany(
      Array.from({ length: 10_000 }, (_, j) => ({
        n: i + j,
        name: `user ${i + j}`,
        tags: ['a', 'b', 'c'],
        nested: { x: j, y: 'z'.repeat(20) }
      }))
    )
  }
}, 120_000)

afterAll(async () => {
  if (!LIVE) return
  await client
    ?.db('shop')
    .collection(SCRATCH)
    .drop()
    .catch(() => undefined)
  await driver?.close().catch(() => undefined)
}, 30_000)

describe('Mongo command monitoring follows the console (live)', () => {
  itLive(
    'emits and logs commands only while a console follows the project',
    async () => {
      const find = () => client.db('shop').collection('users').find({}).limit(2).toArray()
      // Nobody follows the project: no events, nothing logged for the view's find.
      expect(await eventsDuring(find)).toBe(0)
      expect(log.list(ID).entries.some((e) => e.text.includes('find: "users"'))).toBe(false)
      // log.list() above is a console following the project now.
      expect(await eventsDuring(find)).toBeGreaterThan(0)
      const logged = log
        .list(ID)
        .entries.filter((e) => e.text.startsWith('db.runCommand({ find: "users"'))
      expect(logged).toHaveLength(1)
      expect(logged[0]).toMatchObject({ source: 'mongo', rows: 2, status: 'ok' })
      // The Shell's statement is logged once, as the wire command.
      await driver.execute('db.users.find().limit(1)', {
        limit: 20,
        hardCap: 20,
        readOnlySandbox: true,
        database: 'shop'
      })
      expect(log.list(ID).entries.filter((e) => e.text.includes('db.users.find()'))).toHaveLength(0)
      // The lease runs out (the tab was closed): quiet again, the Shell logs as typed.
      now += 61_000
      expect(await eventsDuring(find)).toBe(0)
      await driver.execute('db.users.find().limit(1)', {
        limit: 20,
        hardCap: 20,
        readOnlySandbox: true,
        database: 'shop'
      })
      now += 61_000 // the list below renews the lease; read the entries without it counting
      const last = log.list(ID).entries.at(-1)
      expect(last?.text).toBe('db.users.find().limit(1)')
    },
    60_000
  )

  itLive(
    'a big find pays for monitoring only while watched',
    async () => {
      now += 1_000_000 // unwatched
      const config = buildMongoClientConfig(input.project, input.secrets)
      const plain = new MongoClient(config.uri, { ...config.options, monitorCommands: false })
      await plain.connect()
      const time = async (from?: MongoClient): Promise<number> => {
        const started = performance.now()
        expect(await readAll(from)).toBe(DOCS)
        return performance.now() - started
      }
      try {
        await time() // warm up
        await time(plain)
        const runs = { none: [] as number[], unwatched: [] as number[], watched: [] as number[] }
        for (let i = 0; i < 3; i++) {
          runs.none.push(await time(plain))
          now += 1_000_000
          runs.unwatched.push(await time())
          log.watch(ID)
          runs.watched.push(await time())
        }
        const median = (xs: number[]): number => Math.round([...xs].sort((a, b) => a - b)[1])
        const show = (xs: number[]): string => `${xs.map(Math.round).join('/')} ms`
        console.info(
          `find of ${DOCS} docs — no monitoring: ${show(runs.none)} (median ${median(runs.none)}); ` +
            `unwatched: ${show(runs.unwatched)} (median ${median(runs.unwatched)}); ` +
            `watched: ${show(runs.watched)} (median ${median(runs.watched)})`
        )
      } finally {
        await plain.close()
      }
      now += 1_000_000
      expect(await eventsDuring(() => readAll())).toBe(0)
    },
    120_000
  )
})

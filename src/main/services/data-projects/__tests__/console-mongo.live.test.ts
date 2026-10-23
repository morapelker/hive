// The console log of a MongoDB project against the real server (design §8): with command
// monitoring on the client (mongo/connection.ts turns it on; mocked here so the test does not
// depend on that switch), the Shell's statements, the Documents view's finds, inserts on a
// scratch collection and the explorer's catalog commands are each logged as the commands sent,
// as runnable `db.runCommand({...})` lines, under their source. Gated: TEDOOO_DP_IT=1. Only
// tmp_par_* collections are written (and dropped).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DriverConnectInput } from '../contracts'
import { noopLogger } from '../connection-manager'
import { DataConsoleLog, instrumentDriver } from '../console-log'
import { createDriver } from '../drivers'
import { createDataEngineService, type DataEngineServiceInternals } from '../engine-service'
import { createSafetyGate } from '../safety-gate'
import { MemoryRepository, MemorySecrets, makeRecord } from './engine-fixtures'

vi.mock('../mongo/connection', async (importActual) => {
  const actual = await importActual<typeof import('../mongo/connection')>()
  return {
    ...actual,
    buildMongoClientConfig: (...args: Parameters<typeof actual.buildMongoClientConfig>) => {
      const config = actual.buildMongoClientConfig(...args)
      return { ...config, options: { ...config.options, monitorCommands: true } }
    }
  }
})

const LIVE = !!process.env.TEDOOO_DP_IT
const itLive = LIVE ? it : it.skip
const ID = 'console-mongo'
const SCRATCH = 'tmp_par_console'

let engine: DataEngineServiceInternals
let log: DataConsoleLog

const shell = async (text: string, queryId: string) => {
  const res = await engine.execute(
    { dataProjectId: ID, queryId, text, limit: 20, source: 'editor', database: 'shop' },
    { clientId: null }
  )
  if (res.status !== 'ok') throw new Error(`${text}: ${res.status}`)
  const failed = res.statements.find((s) => s.error)
  if (failed) throw new Error(`${text}: ${failed.error!.message}`)
  return res
}

beforeAll(async () => {
  if (!LIVE) return
  log = new DataConsoleLog()
  // A Console tab follows the project, so Mongo command monitoring is on.
  log.watch(ID)
  engine = createDataEngineService({
    repository: new MemoryRepository([
      makeRecord({
        id: ID,
        engine: 'mongodb',
        environment: 'local',
        safeMode: 'off',
        config: {
          host: '127.0.0.1',
          port: 27018,
          user: 'root',
          database: 'shop',
          mongo: {
            srv: false,
            hosts: ['127.0.0.1:27018'],
            authSource: 'admin',
            directConnection: true
          }
        }
      })
    ]),
    secrets: new MemorySecrets({ [ID]: { password: 'mongopw' } }),
    createDriver: (input: DriverConnectInput) => instrumentDriver(createDriver(input), input, log),
    gate: createSafetyGate(),
    logger: noopLogger
  })
})

afterAll(async () => {
  if (!LIVE) return
  await shell(`db.getCollection("${SCRATCH}").drop()`, 'drop').catch(() => undefined)
  await engine?.shutdown()
}, 30_000)

describe('MongoDB console log (live)', () => {
  itLive(
    'logs the wire commands of the Shell, the views and the explorer',
    async () => {
      await shell(`db.getCollection("${SCRATCH}").drop()`, 'pre').catch(() => undefined)
      await shell('db.orders.find({ status: "shipped" }).limit(3)', 'find')
      await shell(
        `db.getCollection("${SCRATCH}").insertOne({ a: 1, at: ISODate("2026-01-01T00:00:00Z") })`,
        'insert'
      )
      const found = await engine.mongo.find(
        {
          dataProjectId: ID,
          queryId: 'docs',
          database: 'shop',
          collection: 'users',
          filter: '{}',
          limit: 5,
          skip: 0
        },
        { clientId: null }
      )
      expect(found).toBeTruthy()
      await engine.objects(ID, 'shop')
      // The Shell asked for the user's password-bearing command: masked like history.
      await shell(
        `db.getSiblingDB("admin").runCommand({ usersInfo: "nobody", pwd: "hunter2-secret" })`,
        'mask'
      ).catch(() => undefined)

      const entries = log.list(ID).entries
      const query = entries.filter((e) => e.source === 'query')
      const find = query.find((e) => e.text.startsWith('db.runCommand({ find: "orders"'))!
      expect(find).toMatchObject({ language: 'mongo', database: 'shop', status: 'ok' })
      expect(find.text).toContain('filter: { status: "shipped" }')
      expect(find.text).not.toContain('lsid')
      expect(find.rows).toBe(3)
      const insert = query.find((e) => e.text.startsWith(`db.runCommand({ insert: "${SCRATCH}"`))!
      expect(insert).toMatchObject({ affected: 1, status: 'ok' })
      expect(insert.text).toContain('ISODate("2026-01-01T00:00:00.000Z")')
      // The Documents view's own find, outside any scope: a 'mongo' entry.
      expect(
        entries.some(
          (e) => e.source === 'mongo' && e.text.startsWith('db.runCommand({ find: "users"')
        )
      ).toBe(true)
      // The explorer's catalog commands are metadata, not summaries.
      const metadata = entries.filter((e) => e.source === 'metadata')
      expect(metadata.some((e) => e.text.includes('listCollections'))).toBe(true)
      expect(metadata.some((e) => e.text === '// list objects of shop')).toBe(false)
      expect(JSON.stringify(entries)).not.toContain('hunter2-secret')
    },
    60_000
  )
})

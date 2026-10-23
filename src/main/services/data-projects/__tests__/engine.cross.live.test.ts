// Smoke test of the engine wiring for the engines whose drivers live elsewhere (ClickHouse,
// SQLite: drivers-ch-sqlite; MongoDB: mongo-server): the factory in drivers/index.ts, the query
// runner's per-engine split/classify, the gate and the Mongo service proxy. Gated: TEDOOO_DP_IT=1.
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { noopLogger } from '../connection-manager'
import { createDataEngineService, type DataEngineServiceInternals } from '../engine-service'
import { createSafetyGate } from '../safety-gate'
import { MemoryRepository, MemorySecrets, makeRecord } from './engine-fixtures'

const LIVE = !!process.env.TEDOOO_DP_IT
const itLive = LIVE ? it : it.skip
// Seeded by scripts/data-projects-test-dbs/up.sh (TEDOOO_DP_SQLITE_SEED overrides).
const SEED_SQLITE =
  process.env.TEDOOO_DP_SQLITE_SEED ?? join(__dirname, '../../../../..', '.test-dbs', 'shop.sqlite')

let engine: DataEngineServiceInternals
let dir = ''

beforeAll(async () => {
  if (!LIVE) return
  dir = await mkdtemp(join(tmpdir(), 'tedooo-cross-'))
  const sqlitePath = join(dir, 'shop.sqlite')
  await copyFile(SEED_SQLITE, sqlitePath)
  engine = createDataEngineService({
    repository: new MemoryRepository([
      makeRecord({
        id: 'ch',
        engine: 'clickhouse',
        config: {
          host: '127.0.0.1',
          port: 18123,
          user: 'default',
          database: 'shop',
          clickhouseProtocol: 'http'
        }
      }),
      makeRecord({
        id: 'lite',
        engine: 'sqlite',
        config: { filePath: sqlitePath, database: 'main' }
      }),
      makeRecord({
        id: 'mongo',
        engine: 'mongodb',
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
    secrets: new MemorySecrets({ ch: { password: 'chpw' }, mongo: { password: 'mongopw' } }),
    gate: createSafetyGate(),
    logger: noopLogger
  })
})

afterAll(async () => {
  if (!LIVE) return
  await engine?.shutdown()
  if (dir) await rm(dir, { recursive: true, force: true })
})

const rowsOf = (
  res: Awaited<ReturnType<DataEngineServiceInternals['execute']>>,
  i = 0
): unknown[][] => {
  if (res.status !== 'ok') throw new Error(`expected ok, got ${res.status}`)
  const out = res.statements[i]?.output
  if (res.statements[i]?.error) throw new Error(res.statements[i].error!.message)
  if (out?.kind !== 'rows') throw new Error(`expected rows, got ${out?.kind}`)
  return out.rows
}

describe('cross-engine smoke (live)', () => {
  for (const id of ['ch', 'lite']) {
    itLive(
      `${id}: query with auto-limit, write confirmation, describe, table rows, export`,
      async () => {
        const res = await engine.execute(
          {
            dataProjectId: id,
            queryId: `${id}-1`,
            text: 'SELECT * FROM users ORDER BY id; SELECT COUNT(*) FROM orders',
            limit: 5,
            source: 'editor',
            database: id === 'ch' ? 'shop' : undefined
          },
          { clientId: null }
        )
        expect(rowsOf(res)).toHaveLength(5)
        expect(rowsOf(res, 1)).toHaveLength(1)
        const write = await engine.execute(
          {
            dataProjectId: id,
            queryId: `${id}-2`,
            text: 'DROP TABLE users',
            limit: 5,
            source: 'editor'
          },
          { clientId: null }
        )
        expect(write.status).toBe('confirmation_required')
        const ref = { database: id === 'ch' ? 'shop' : 'main', name: 'users' }
        const details = await engine.describe(id, ref)
        expect(details.columns.map((c) => c.name)).toContain('email')
        const page = await engine.tableRows(
          {
            dataProjectId: id,
            queryId: `${id}-3`,
            ref,
            filters: [{ column: 'country', operator: '=', value: 'IL' }],
            orderBy: [{ column: 'id', direction: 'asc' }],
            limit: 3,
            offset: 0
          },
          { clientId: null }
        )
        expect(page.result.rows).toHaveLength(3)
        const filePath = join(dir, `${id}-users.csv`)
        const exported = await engine.exportStart(
          {
            dataProjectId: id,
            exportId: `${id}-exp`,
            source: { kind: 'table', ref },
            format: 'csv',
            filePath
          },
          { clientId: null }
        )
        expect(exported.status).toBe('ok')
        expect((await readFile(filePath, 'utf8')).split('\r\n')[0]).toMatch(/^id,name,email/)
      }
    )
  }

  itLive('mongo: shell statements through the runner and the Mongo service proxy', async () => {
    const res = await engine.execute(
      {
        dataProjectId: 'mongo',
        queryId: 'm-1',
        text: 'db.users.find({}).limit(3)',
        database: 'shop',
        limit: 50,
        source: 'editor'
      },
      { clientId: null }
    )
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    expect(res.statements[0].error).toBeUndefined()
    const out = res.statements[0].output
    expect(out?.kind === 'documents' ? out.documents.length : -1).toBe(3)
    const write = await engine.execute(
      {
        dataProjectId: 'mongo',
        queryId: 'm-2',
        text: 'db.users.deleteMany({})',
        database: 'shop',
        limit: 50,
        source: 'editor'
      },
      { clientId: null }
    )
    expect(write.status).toBe('confirmation_required')
    const found = await engine.mongo.find(
      {
        dataProjectId: 'mongo',
        queryId: 'm-3',
        database: 'shop',
        collection: 'orders',
        filter: '{ status: "paid" }',
        limit: 5,
        withCount: true
      },
      { clientId: null }
    )
    expect(found.documents.length).toBeGreaterThan(0)
    const filePath = join(dir, 'orders.json')
    const exported = await engine.exportStart(
      {
        dataProjectId: 'mongo',
        exportId: 'm-exp',
        source: {
          kind: 'mongo',
          database: 'shop',
          collection: 'orders',
          filter: '{ status: "paid" }'
        },
        format: 'json',
        filePath
      },
      { clientId: null }
    )
    expect(exported.status).toBe('ok')
    const docs = JSON.parse(await readFile(filePath, 'utf8')) as Array<Record<string, unknown>>
    expect(docs.length).toBe(exported.status === 'ok' ? exported.rows : -1)
    expect(docs[0]).toHaveProperty('_id')
  })
})

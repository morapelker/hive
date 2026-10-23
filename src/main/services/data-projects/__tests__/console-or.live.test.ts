// OR filters and the console log against the real servers (design §8), per SQL engine: a
// scratch table tmp_par_or_items is created, browsed with OR filters + a raw WHERE (page and
// count), exported with the same view, edited from the grid, then dropped; the console log of
// the instrumented drivers must list each statement under its source, masked, with the
// introspection behind it as metadata. Gated: TEDOOO_DP_IT=1. Only tmp_par_* objects are touched.
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DataEngine, DataObjectRef } from '../../../../shared/data-projects/types'
import type { DriverConnectInput } from '../contracts'
import { noopLogger } from '../connection-manager'
import { DataConsoleLog, instrumentDriver } from '../console-log'
import { createDriver } from '../drivers'
import { createDataEngineService, type DataEngineServiceInternals } from '../engine-service'
import { createSafetyGate } from '../safety-gate'
import { MemoryRepository, MemorySecrets, makeRecord } from './engine-fixtures'

const LIVE = !!process.env.TEDOOO_DP_IT
const itLive = LIVE ? it : it.skip
const SEED_SQLITE =
  process.env.TEDOOO_DP_SQLITE_SEED ?? join(__dirname, '../../../../..', '.test-dbs', 'shop.sqlite')

const T = 'tmp_par_or_items'

interface Target {
  id: string
  engine: DataEngine
  config: Record<string, unknown>
  password?: string
  ref: DataObjectRef
  create: string
}

const ROWS = [
  [1, 'IL', 10],
  [2, 'US', 500],
  [3, 'FR', 20],
  [4, 'IL', 700],
  [5, 'DE', 5],
  [6, 'IL', 1]
]
const insert = `INSERT INTO ${T} (id, country, total) VALUES ${ROWS.map(
  ([id, c, t]) => `(${id}, '${c}', ${t})`
).join(', ')}`

const sqlTargets = (sqlitePath: string): Target[] => [
  {
    id: 'or-mysql',
    engine: 'mysql',
    config: { host: '127.0.0.1', port: 13306, user: 'root', database: 'shop' },
    password: 'rootpw',
    ref: { database: 'shop', name: T },
    create: `CREATE TABLE ${T} (id INT PRIMARY KEY, country VARCHAR(8), total INT)`
  },
  {
    id: 'or-mariadb',
    engine: 'mariadb',
    config: { host: '127.0.0.1', port: 13307, user: 'root', database: 'shop' },
    password: 'rootpw',
    ref: { database: 'shop', name: T },
    create: `CREATE TABLE ${T} (id INT PRIMARY KEY, country VARCHAR(8), total INT)`
  },
  {
    id: 'or-postgres',
    engine: 'postgres',
    config: { host: '127.0.0.1', port: 15432, user: 'postgres', database: 'shop' },
    password: 'pgpw',
    ref: { database: 'shop', schema: 'public', name: T },
    create: `CREATE TABLE ${T} (id int PRIMARY KEY, country text, total int)`
  },
  {
    id: 'or-clickhouse',
    engine: 'clickhouse',
    config: {
      host: '127.0.0.1',
      port: 18123,
      user: 'default',
      database: 'shop',
      clickhouseProtocol: 'http'
    },
    password: 'chpw',
    ref: { database: 'shop', name: T },
    create: `CREATE TABLE ${T} (id UInt32, country String, total Int32) ENGINE = MergeTree ORDER BY id`
  },
  {
    id: 'or-sqlite',
    engine: 'sqlite',
    config: { filePath: sqlitePath, database: 'main' },
    ref: { database: 'main', schema: 'main', name: T },
    create: `CREATE TABLE ${T} (id INTEGER PRIMARY KEY, country TEXT, total INTEGER)`
  }
]

let engine: DataEngineServiceInternals
let log: DataConsoleLog
let dir = ''
let targets: Target[] = []

const run = async (target: Target, text: string, queryId: string): Promise<void> => {
  const res = await engine.execute(
    {
      dataProjectId: target.id,
      queryId,
      text,
      limit: 100,
      source: 'editor',
      database: target.engine === 'sqlite' ? undefined : 'shop'
    },
    { clientId: null }
  )
  if (res.status !== 'ok') throw new Error(`${text}: ${res.status}`)
  const failed = res.statements.find((s) => s.error)
  if (failed) throw new Error(`${text}: ${failed.error!.message}`)
}

beforeAll(async () => {
  if (!LIVE) return
  dir = await mkdtemp(join(tmpdir(), 'tedooo-console-or-'))
  const sqlitePath = join(dir, 'shop.sqlite')
  await copyFile(SEED_SQLITE, sqlitePath)
  targets = sqlTargets(sqlitePath)
  log = new DataConsoleLog()
  engine = createDataEngineService({
    repository: new MemoryRepository(
      targets.map((t) =>
        makeRecord({
          id: t.id,
          engine: t.engine,
          config: t.config as never,
          environment: 'local',
          safeMode: 'off'
        })
      )
    ),
    secrets: new MemorySecrets(
      Object.fromEntries(
        targets.filter((t) => t.password).map((t) => [t.id, { password: t.password }])
      )
    ),
    createDriver: (input: DriverConnectInput) => instrumentDriver(createDriver(input), input, log),
    gate: createSafetyGate(),
    logger: noopLogger
  })
  for (const target of targets) {
    await run(target, `DROP TABLE IF EXISTS ${T}`, `${target.id}-pre`)
    await run(target, target.create, `${target.id}-create`)
    await run(target, insert, `${target.id}-insert`)
  }
}, 60_000)

afterAll(async () => {
  if (!LIVE) return
  for (const target of targets) {
    await run(target, `DROP TABLE IF EXISTS ${T}`, `${target.id}-drop`).catch(() => undefined)
  }
  await engine?.shutdown()
  if (dir) await rm(dir, { recursive: true, force: true })
}, 60_000)

describe('OR filters and the console log (live)', () => {
  for (const id of ['or-mysql', 'or-mariadb', 'or-postgres', 'or-clickhouse', 'or-sqlite']) {
    itLive(
      `${id}: OR page + count + export, grid edit, console sources`,
      async () => {
        const target = targets.find((t) => t.id === id)!
        const filters = [
          { column: 'country', operator: '=' as const, value: 'IL' },
          { column: 'total', operator: '>' as const, value: '100' }
        ]
        // (country = IL OR total > 100) AND (id < 6) → 1, 2, 4. Page of 2: the count runs.
        const page = await engine.tableRows(
          {
            dataProjectId: id,
            queryId: `${id}-page`,
            ref: target.ref,
            filters,
            filterJoin: 'or',
            where: 'id < 6',
            orderBy: [{ column: 'id', direction: 'asc' }],
            limit: 2,
            offset: 0
          },
          { clientId: null }
        )
        expect(page.result.rows.map((r) => Number(r[0]))).toEqual([1, 2])
        expect(page.totalRows).toBe(3)
        expect(page.sql).toMatch(/WHERE \(.+ OR .+\) AND \(id < 6\n\)/)
        // AND (the default) narrows instead: IL with total > 100 → 4.
        const and = await engine.tableRows(
          {
            dataProjectId: id,
            queryId: `${id}-and`,
            ref: target.ref,
            filters,
            limit: 50,
            offset: 0
          },
          { clientId: null }
        )
        expect(and.result.rows.map((r) => Number(r[0]))).toEqual([4])

        const filePath = join(dir, `${id}.csv`)
        const exported = await engine.exportStart(
          {
            dataProjectId: id,
            exportId: `${id}-export`,
            source: {
              kind: 'table',
              ref: target.ref,
              filters,
              filterJoin: 'or',
              where: 'id < 6',
              orderBy: [{ column: 'id', direction: 'asc' }]
            },
            format: 'csv',
            filePath
          },
          { clientId: null }
        )
        expect(exported).toMatchObject({ status: 'ok', rows: 3 })
        const csv = (await readFile(filePath, 'utf8')).trim().split(/\r\n/)
        expect(csv.slice(1).map((line) => Number(line.split(',')[0]))).toEqual([1, 2, 4])

        // ClickHouse tables are not grid-editable (keys are not unique; edits would be mutations).
        if (target.engine !== 'clickhouse') {
          const edited = await engine.applyEdits(
            {
              dataProjectId: id,
              ref: target.ref,
              edits: [{ kind: 'update', key: { id: 6 }, changes: { country: 'GB' } }]
            },
            { clientId: null }
          )
          expect(edited.status).toBe('ok')
        }

        const entries = log.list(id).entries
        const of = (source: string) => entries.filter((e) => e.source === source)
        const tableTexts = of('table').map((e) => e.text)
        expect(tableTexts.some((t) => t.startsWith('SELECT * FROM') && t.includes(' OR '))).toBe(
          true
        )
        expect(tableTexts.some((t) => t.startsWith('SELECT COUNT(*)') && t.includes(' OR '))).toBe(
          true
        )
        expect(of('table').every((e) => e.status === 'ok' && e.durationMs !== null)).toBe(true)
        expect(of('export')).toHaveLength(1)
        expect(of('export')[0]).toMatchObject({ rows: 3, status: 'ok' })
        if (target.engine !== 'clickhouse') {
          const editTexts = of('edit').map((e) => e.text)
          expect(editTexts).toHaveLength(3)
          expect(editTexts[0]).toMatch(/^(BEGIN|START TRANSACTION)$/)
          expect(editTexts[1]).toMatch(/^UPDATE .*'GB'/)
          expect(of('edit')[1].affected).toBe(1)
          expect(editTexts[2]).toBe('COMMIT')
        }
        expect(of('query').some((e) => e.text.startsWith('CREATE TABLE'))).toBe(true)
        // The table view's describe (and the connection) are metadata.
        expect(of('metadata').length).toBeGreaterThan(0)
        expect(entries.every((e) => e.dataProjectId === id)).toBe(true)
      },
      60_000
    )
  }

  itLive('masks secrets and logs failures with their error', async () => {
    const target = targets.find((t) => t.id === 'or-postgres')!
    const res = await engine.execute(
      {
        dataProjectId: target.id,
        queryId: 'pg-fail',
        text: `SELECT * FROM tmp_par_or_missing; ALTER ROLE nobody_here PASSWORD 'sup3r-secret'`,
        limit: 10,
        source: 'editor',
        stopOnError: false
      },
      { clientId: null }
    )
    expect(res.status).toBe('ok')
    const entries = log.list(target.id).entries.filter((e) => e.source === 'query')
    const missing = entries.find((e) => e.text.includes('tmp_par_or_missing'))!
    expect(missing.status).toBe('error')
    expect(missing.error).toMatch(/tmp_par_or_missing/)
    const role = entries.find((e) => e.text.startsWith('ALTER ROLE'))!
    expect(role.text).not.toContain('sup3r-secret')
    expect(JSON.stringify(log.list(target.id))).not.toContain('sup3r-secret')
  })
})

// Imports against the docker databases (design §8) through the engine with the real drivers:
// MySQL, MariaDB, PostgreSQL, SQLite (a copy of the seed file), ClickHouse and MongoDB. Every
// test works on its own tmp_par_import_* table / collection (TEDOOO_DP_IMPORT_PREFIX renames
// them) and drops it afterwards; the seeded data is never touched. Gated: TEDOOO_DP_IT=1.
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {
  DataImportProgressEvent,
  DataImportResponse,
  DataImportStartRequest
} from '../../../../shared/data-projects/import-types'
import type {
  DataConnectionConfig,
  DataEngine,
  DataQueryResponse
} from '../../../../shared/data-projects/types'
import { noopLogger } from '../connection-manager'
import { createDataEngineService, type DataEngineServiceInternals } from '../engine-service'
import { clearImportScanCache } from '../import'
import { createSafetyGate } from '../safety-gate'
import { MemoryRepository, MemorySecrets, makeRecord } from './engine-fixtures'

const LIVE = !!process.env.TEDOOO_DP_IT
const itLive = LIVE ? it : it.skip
const SEED_SQLITE =
  process.env.TEDOOO_DP_SQLITE_SEED ?? join(__dirname, '../../../../..', '.test-dbs', 'shop.sqlite')

/** Prefix of the scratch table / collection (another run can use its own). */
const PREFIX = process.env.TEDOOO_DP_IMPORT_PREFIX ?? 'tmp_par_import'
const T = `${PREFIX}_items`
const ROWS = 2500

interface SqlTarget {
  engine: Exclude<DataEngine, 'mongodb'>
  config: (dir: string) => DataConnectionConfig
  password?: string
  database: string
  schema?: string
  create: string
  drop: string
  transactions: boolean
}

const SQL_TARGETS: SqlTarget[] = [
  ...(['mysql', 'mariadb'] as const).map((engine): SqlTarget => ({
    engine,
    config: () => ({
      host: '127.0.0.1',
      port: engine === 'mysql' ? 13306 : 13307,
      user: 'root',
      database: 'shop'
    }),
    password: 'rootpw',
    database: 'shop',
    create: `CREATE TABLE ${T} (id INT PRIMARY KEY, name VARCHAR(200) NOT NULL, price DECIMAL(10,2), flag TINYINT(1), created DATETIME, note VARCHAR(50) NULL)`,
    drop: `DROP TABLE IF EXISTS ${T}`,
    transactions: true
  })),
  {
    engine: 'postgres',
    config: () => ({ host: '127.0.0.1', port: 15432, user: 'postgres', database: 'shop' }),
    password: 'pgpw',
    database: 'shop',
    schema: 'public',
    create: `CREATE TABLE public.${T} (id int PRIMARY KEY, name text NOT NULL, price numeric(10,2), flag boolean, created timestamp, note text)`,
    drop: `DROP TABLE IF EXISTS public.${T}`,
    transactions: true
  },
  {
    engine: 'sqlite',
    config: (dir) => ({ filePath: join(dir, 'shop.sqlite'), database: 'main' }),
    database: 'main',
    create: `CREATE TABLE ${T} (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price NUMERIC, flag BOOLEAN, created TEXT, note TEXT)`,
    drop: `DROP TABLE IF EXISTS ${T}`,
    transactions: true
  },
  {
    engine: 'clickhouse',
    config: () => ({
      host: '127.0.0.1',
      port: 18123,
      user: 'default',
      database: 'shop',
      clickhouseProtocol: 'http'
    }),
    password: 'chpw',
    database: 'shop',
    create: `CREATE TABLE shop.${T} (id UInt32, name String, price Decimal(10,2), flag Bool, created DateTime, note Nullable(String)) ENGINE = MergeTree ORDER BY id`,
    drop: `DROP TABLE IF EXISTS shop.${T}`,
    transactions: false
  }
]

/** Row i: quotes, commas and a line break every 10th name; NULL / '' / text notes in turn. */
const csvLine = (id: number, overrides: { id?: string; name?: string } = {}): string => {
  const name =
    overrides.name ?? (id % 10 === 0 ? `"Comma, ""quote"" and\nnewline ${id}"` : `name ${id} ü✓`)
  const note = id % 3 === 0 ? '' : id % 3 === 1 ? '""' : 'x'
  return `${overrides.id ?? id},${name},${(id * 1.25).toFixed(2)},${id % 2 ? 'true' : 'false'},2024-01-02 03:04:05,${note}`
}
const HEADER = 'id,name,price,flag,created,note'
const csvFile = (ids: number[], bad: Record<number, { id?: string; name?: string }> = {}): string =>
  `${HEADER}\r\n${ids.map((id, i) => csvLine(id, bad[i + 1])).join('\r\n')}\r\n`
const range = (from: number, count: number): number[] =>
  Array.from({ length: count }, (_, i) => from + i)
/** Line of data row r: the header, plus one extra line per earlier name with a line break. */
const lineOf = (row: number): number => row + 1 + Math.floor((row - 1) / 10)

let dir = ''
let engine: DataEngineServiceInternals
const events: DataImportProgressEvent[] = []
/** importId → cancel the import once a progress event matches. */
const cancelWhen = new Map<string, (event: DataImportProgressEvent) => boolean>()

const records = (): ReturnType<typeof makeRecord>[] => {
  const out: ReturnType<typeof makeRecord>[] = []
  for (const t of SQL_TARGETS) {
    const config = t.config(dir)
    out.push(
      makeRecord({ id: `${t.engine}-hs`, engine: t.engine, config, safeMode: 'half-safe' }),
      makeRecord({
        id: `${t.engine}-off`,
        engine: t.engine,
        config,
        safeMode: 'off',
        environment: 'local'
      }),
      makeRecord({ id: `${t.engine}-ro`, engine: t.engine, config, safeMode: 'read-only' })
    )
  }
  const mongo: DataConnectionConfig = {
    host: '127.0.0.1',
    port: 27018,
    user: 'root',
    database: 'shop',
    mongo: { srv: false, hosts: ['127.0.0.1:27018'], authSource: 'admin', directConnection: true }
  }
  out.push(
    makeRecord({ id: 'mongo-hs', engine: 'mongodb', config: mongo, safeMode: 'half-safe' }),
    makeRecord({
      id: 'mongo-off',
      engine: 'mongodb',
      config: mongo,
      safeMode: 'off',
      environment: 'local'
    })
  )
  return out
}

beforeAll(async () => {
  if (!LIVE) return
  dir = await mkdtemp(join(tmpdir(), 'tedooo-import-live-'))
  await copyFile(SEED_SQLITE, join(dir, 'shop.sqlite'))
  const secrets: Record<string, { password: string }> = {}
  for (const t of SQL_TARGETS)
    if (t.password)
      for (const s of ['hs', 'off', 'ro']) secrets[`${t.engine}-${s}`] = { password: t.password }
  secrets['mongo-hs'] = { password: 'mongopw' }
  secrets['mongo-off'] = { password: 'mongopw' }
  engine = createDataEngineService({
    repository: new MemoryRepository(records()),
    secrets: new MemorySecrets(secrets),
    gate: createSafetyGate(),
    publish: (channel, payload) => {
      if (channel !== 'dataProjects:import') return
      const event = payload as DataImportProgressEvent
      events.push(event)
      const when = cancelWhen.get(event.importId)
      if (when?.(event)) {
        cancelWhen.delete(event.importId)
        void engine.importCancel(event.importId)
      }
    },
    logger: noopLogger
  })
})

afterAll(async () => {
  if (!LIVE) return
  await engine?.shutdown()
  if (dir) await rm(dir, { recursive: true, force: true })
})

const exec = async (id: string, text: string, database?: string): Promise<DataQueryResponse> => {
  const res = await engine.execute(
    {
      dataProjectId: id,
      queryId: `q-${Math.random().toString(36).slice(2)}`,
      text,
      database,
      limit: 1000,
      source: 'editor'
    },
    { clientId: null }
  )
  if (res.status !== 'ok') throw new Error(`expected ok, got ${res.status}`)
  const failed = res.statements.find((s) => s.error)
  if (failed) throw new Error(failed.error!.message)
  return res
}

const scalar = async (id: string, sql: string, database?: string): Promise<string> => {
  const res = await exec(id, sql, database)
  if (res.status !== 'ok') throw new Error('not ok')
  const out = res.statements[0].output
  if (out?.kind !== 'rows') throw new Error('no rows')
  return String(out.rows[0][0])
}

const fileOf = async (name: string, text: string): Promise<string> => {
  const path = join(dir, name)
  await writeFile(path, text)
  return path
}

for (const t of SQL_TARGETS) {
  describe(`import (live ${t.engine})`, () => {
    const off = `${t.engine}-off`
    const db = t.engine === 'sqlite' ? undefined : t.database
    const ref = { name: T, database: t.database, ...(t.schema ? { schema: t.schema } : {}) }
    const count = (where = ''): Promise<number> =>
      scalar(off, `SELECT COUNT(*) FROM ${T}${where ? ` WHERE ${where}` : ''}`, db).then(Number)
    const req = (
      id: string,
      filePath: string,
      extra: Partial<DataImportStartRequest> = {}
    ): DataImportStartRequest => ({
      dataProjectId: id,
      importId: `imp-${t.engine}-${Math.random().toString(36).slice(2)}`,
      filePath,
      target: { kind: 'table', ref },
      format: 'csv',
      encoding: 'utf-8',
      csv: { delimiter: ',', quote: '"', header: true },
      columns: ['id', 'name', 'price', 'flag', 'created', 'note'].map((target, source) => ({
        source,
        target
      })),
      empty: 'null',
      onError: t.transactions ? 'rollback' : 'stop',
      ...extra
    })

    beforeAll(async () => {
      if (!LIVE) return
      await exec(off, t.drop, db)
      await exec(off, t.create, db)
    })
    afterAll(async () => {
      if (!LIVE) return
      await exec(off, t.drop, db).catch(() => undefined)
    })

    itLive('previews and detects the file', async () => {
      const path = await fileOf(`${t.engine}-preview.csv`, csvFile(range(1, 30)))
      const preview = await engine.importPreview({
        dataProjectId: `${t.engine}-hs`,
        filePath: path,
        target: { kind: 'table', ref }
      })
      expect(preview.csv).toEqual({ delimiter: ',', quote: '"', header: true })
      expect(preview.columns).toEqual(['id', 'name', 'price', 'flag', 'created', 'note'])
      expect(preview.rows[9][1]).toBe('Comma, "quote" and\nnewline 10')
      expect(preview.rows[2][5]).toBeNull()
      expect(preview.rows[0][5]).toBe('')
      expect(preview.tableColumns?.map((c) => c.name)).toContain('price')
      expect(preview.supportsTransaction).toBe(t.transactions)
    })

    itLive(
      `imports ${ROWS} rows after the half-safe confirmation (NULL vs '', quotes, line breaks)`,
      async () => {
        const path = await fileOf(`${t.engine}-main.csv`, csvFile(range(1, ROWS)))
        const request = req(`${t.engine}-hs`, path)
        const first = await engine.importStart(request, { clientId: null })
        expect(first.status).toBe('confirmation_required')
        if (first.status !== 'confirmation_required') return
        expect(first.plan.statements[0].reasons[0]).toContain(
          `Import 2,500 rows from ${t.engine}-main.csv`
        )
        expect(await count()).toBe(0)
        const done = await engine.importStart(
          { ...request, importId: `${request.importId}-2`, confirmToken: first.confirmToken },
          { clientId: null }
        )
        expect(done).toMatchObject({
          status: 'ok',
          rowsImported: ROWS,
          rowsRead: ROWS,
          errorCount: 0
        })
        expect(await count()).toBe(ROWS)
        expect(await count('note IS NULL')).toBe(833)
        expect(await count(`note = ''`)).toBe(834)
        expect(await scalar(off, `SELECT name FROM ${T} WHERE id = 10`, db)).toBe(
          'Comma, "quote" and\nnewline 10'
        )
        expect(await scalar(off, `SELECT name FROM ${T} WHERE id = 7`, db)).toBe('name 7 ü✓')
        expect(Number(await scalar(off, `SELECT price FROM ${T} WHERE id = 7`, db))).toBe(8.75)
        const flag = await scalar(off, `SELECT flag FROM ${T} WHERE id = 3`, db)
        expect(['1', 'true', 't']).toContain(flag)
        const ours = events.filter((e) => e.importId === `${request.importId}-2`)
        expect(ours.some((e) => e.phase === 'importing')).toBe(true)
        expect(ours[ours.length - 1]).toMatchObject({ done: true, rowsImported: ROWS })
      }
    )

    if (t.engine === 'mysql' || t.engine === 'mariadb') {
      itLive('writes backslashes for the session’s NO_BACKSLASH_ESCAPES mode', async () => {
        const name = 'C:\\temp\\x'
        const path = await fileOf(
          `${t.engine}-bs.csv`,
          `${HEADER}\n8001,${name},1.00,true,2024-01-02 03:04:05,\n`
        )
        const path2 = await fileOf(
          `${t.engine}-bs2.csv`,
          `${HEADER}\n8002,${name},1.00,true,2024-01-02 03:04:05,\n`
        )
        await exec(
          off,
          `SET SESSION sql_mode = CONCAT(@@SESSION.sql_mode, ',NO_BACKSLASH_ESCAPES')`,
          db
        )
        try {
          const res = await engine.importStart(req(off, path), { clientId: null })
          expect(res).toMatchObject({ status: 'ok', rowsImported: 1 })
        } finally {
          await exec(
            off,
            `SET SESSION sql_mode = REPLACE(@@SESSION.sql_mode, 'NO_BACKSLASH_ESCAPES', '')`,
            db
          )
        }
        const res2 = await engine.importStart(req(off, path2), { clientId: null })
        expect(res2).toMatchObject({ status: 'ok', rowsImported: 1 })
        expect(await scalar(off, `SELECT LENGTH(name) FROM ${T} WHERE id = 8001`, db)).toBe('9')
        expect(await scalar(off, `SELECT LENGTH(name) FROM ${T} WHERE id = 8002`, db)).toBe('9')
      })
    }

    itLive('is refused in read-only mode', async () => {
      const path = await fileOf(`${t.engine}-ro.csv`, csvFile(range(9001, 5)))
      const res = await engine.importStart(req(`${t.engine}-ro`, path), { clientId: null })
      expect(res.status).toBe('blocked')
      expect(await count('id >= 9001')).toBe(0)
    })

    if (t.transactions) {
      itLive(
        'all or nothing: a duplicate key rolls everything back and names the row',
        async () => {
          clearImportScanCache()
          const before = await count()
          // Row 1,150 (third batch) repeats id 1, which the table already has.
          const path = await fileOf(
            `${t.engine}-rb.csv`,
            csvFile(range(5001, 1200), { 1150: { id: '1' } })
          )
          const res = (await engine.importStart(req(off, path, { batchSize: 500 }), {
            clientId: null
          })) as Extract<DataImportResponse, { status: 'failed' }>
          expect(res.status).toBe('failed')
          expect(res.rolledBack).toBe(true)
          expect(res.rowsImported).toBe(0)
          expect(res.errors[0]).toMatchObject({ row: 1150, line: lineOf(1150) })
          expect(res.errors[0].message.toLowerCase()).toMatch(/duplicate|unique|primary/)
          expect(await count()).toBe(before)
        }
      )
    }

    itLive('stop at the first error: earlier rows stay, later rows do not', async () => {
      const before = await count()
      const bad = t.engine === 'clickhouse' ? { id: 'abc' } : { id: '2' }
      const path = await fileOf(`${t.engine}-stop.csv`, csvFile(range(6001, 100), { 50: bad }))
      const res = (await engine.importStart(req(off, path, { onError: 'stop', batchSize: 40 }), {
        clientId: null
      })) as Extract<DataImportResponse, { status: 'failed' }>
      expect(res).toMatchObject({ status: 'failed', rowsImported: 49, rolledBack: false })
      expect(res.errors[0].row).toBe(50)
      expect(res.message).toMatch(new RegExp(`^Stopped at Row 50 \\(line ${lineOf(50)}\\)`))
      expect(await count()).toBe(before + 49)
      expect(await count('id >= 6051 AND id < 7000')).toBe(0)
    })

    itLive('skip failing rows: the rest is imported and the failures reported', async () => {
      const before = await count()
      const bad = t.engine === 'clickhouse' ? { id: 'nope' } : { id: '3' }
      const path = await fileOf(
        `${t.engine}-skip.csv`,
        csvFile(range(7001, 100), { 20: bad, 77: bad })
      )
      const res = await engine.importStart(req(off, path, { onError: 'skip', batchSize: 30 }), {
        clientId: null
      })
      expect(res).toMatchObject({ status: 'ok', rowsImported: 98, rowsSkipped: 2, errorCount: 2 })
      if (res.status === 'ok') expect(res.errors.map((e) => e.row)).toEqual([20, 77])
      expect(await count()).toBe(before + 98)
    })

    itLive(
      'cancel stops the import (and rolls back where it can)',
      async () => {
        const before = await count()
        const total = 50_000
        const path = await fileOf(`${t.engine}-cancel.csv`, csvFile(range(100_001, total)))
        const request = req(off, path, { batchSize: 1 })
        cancelWhen.set(request.importId, (e) => e.phase === 'importing' && e.rowsImported > 0)
        const res = await engine.importStart(request, { clientId: null })
        expect(res.status).toBe('cancelled')
        if (res.status !== 'cancelled') return
        if (t.transactions) {
          expect(res.rolledBack).toBe(true)
          expect(res.rowsImported).toBe(0)
          expect(await count()).toBe(before)
        } else {
          expect(res.rowsImported).toBeGreaterThan(0)
          expect(res.rowsImported).toBeLessThan(total)
          expect(await count()).toBe(before + res.rowsImported)
        }
        // The session is usable afterwards.
        expect(await count('id = 1')).toBe(1)
      },
      60_000
    )
  })
}

describe('import (live mongodb)', () => {
  const C = `${PREFIX}_docs`
  const off = 'mongo-off'
  const find = async (filter = '{}', limit = 5): Promise<Array<Record<string, unknown>>> =>
    (
      await engine.mongo.find(
        {
          dataProjectId: off,
          queryId: `f-${Math.random().toString(36).slice(2)}`,
          database: 'shop',
          collection: C,
          filter,
          sort: '{ n: 1 }',
          limit
        },
        { clientId: null }
      )
    ).documents
  const total = async (filter = '{}'): Promise<number> =>
    (
      await engine.mongo.find(
        {
          dataProjectId: off,
          queryId: `c-${Math.random().toString(36).slice(2)}`,
          database: 'shop',
          collection: C,
          filter,
          limit: 1,
          withCount: true
        },
        { clientId: null }
      )
    ).count ?? -1
  const req = (
    filePath: string,
    extra: Partial<DataImportStartRequest>
  ): DataImportStartRequest => ({
    dataProjectId: off,
    importId: `imp-mongo-${Math.random().toString(36).slice(2)}`,
    filePath,
    target: { kind: 'collection', database: 'shop', collection: C },
    format: 'json',
    encoding: 'utf-8',
    empty: 'omit',
    onError: 'stop',
    ...extra
  })
  const drop = async (): Promise<void> => {
    await engine.mongo
      .collection({ dataProjectId: off, database: 'shop', action: { kind: 'drop', collection: C } })
      .catch(() => undefined)
  }

  beforeAll(async () => {
    if (!LIVE) return
    await drop()
    await engine.mongo.collection({
      dataProjectId: off,
      database: 'shop',
      action: { kind: 'create', collection: C }
    })
  })
  afterAll(async () => {
    if (!LIVE) return
    await drop()
  })

  itLive('imports a JSON array of Extended JSON documents after confirmation', async () => {
    const docs = Array.from({ length: 1500 }, (_, i) => ({
      _id: { $oid: (i + 1).toString(16).padStart(24, '0') },
      n: i + 1,
      big: 5_000_000_000 + i,
      at: { $date: '2024-01-01T00:00:00Z' },
      tags: ['a', { deep: i % 2 === 0 }],
      text: 'braces } { and "quotes"'
    }))
    const path = await fileOf('docs.json', JSON.stringify(docs, null, 2))
    const preview = await engine.importPreview({
      dataProjectId: 'mongo-hs',
      filePath: path,
      target: { kind: 'collection', database: 'shop', collection: C }
    })
    expect(preview.format).toBe('json')
    expect(preview.columns).toEqual(['_id', 'n', 'big', 'at', 'tags', 'text'])
    expect(preview.supportsTransaction).toBe(false)

    const request = { ...req(path, {}), dataProjectId: 'mongo-hs' }
    const first = await engine.importStart(request, { clientId: null })
    expect(first.status).toBe('confirmation_required')
    if (first.status !== 'confirmation_required') return
    expect(first.plan.statements[0].text).toContain('insertMany')
    expect(first.plan.statements[0].reasons[0]).toContain('Import 1,500 documents from docs.json')
    const done = await engine.importStart(
      { ...request, importId: `${request.importId}-2`, confirmToken: first.confirmToken },
      { clientId: null }
    )
    expect(done).toMatchObject({ status: 'ok', rowsImported: 1500 })
    expect(await total()).toBe(1500)
    const [doc] = await find('{ n: 1 }', 1)
    expect(doc).toMatchObject({
      _id: { $oid: '000000000000000000000001' },
      n: { $numberInt: '1' },
      big: { $numberLong: '5000000000' },
      at: { $date: { $numberLong: '1704067200000' } }
    })
  })

  itLive('imports NDJSON and stops at a duplicate _id (ordered)', async () => {
    const lines = Array.from({ length: 40 }, (_, i) =>
      JSON.stringify({
        _id: i === 29 ? { $oid: '000000000000000000000001' } : `nd-${i}`,
        n: 10_000 + i
      })
    )
    const path = await fileOf('docs.ndjson', `${lines.join('\n')}\n`)
    const res = (await engine.importStart(req(path, { format: 'ndjson', batchSize: 25 }), {
      clientId: null
    })) as Extract<DataImportResponse, { status: 'failed' }>
    expect(res).toMatchObject({ status: 'failed', rowsImported: 29 })
    expect(res.errors[0]).toMatchObject({ row: 30, line: 30 })
    expect(res.errors[0].message).toContain('E11000')
    expect(await total('{ n: { $gte: 10000, $lt: 20000 } }')).toBe(29)
  })

  itLive('skips duplicates when asked (unordered) and imports the rest', async () => {
    const lines = Array.from({ length: 30 }, (_, i) =>
      JSON.stringify({ _id: i % 10 === 5 ? 'nd-1' : `sk-${i}`, n: 20_000 + i })
    )
    const path = await fileOf('skip.ndjson', lines.join('\n'))
    const res = await engine.importStart(
      req(path, { format: 'ndjson', onError: 'skip', batchSize: 12 }),
      { clientId: null }
    )
    expect(res).toMatchObject({ status: 'ok', rowsImported: 27, rowsSkipped: 3, errorCount: 3 })
    if (res.status === 'ok') expect(res.errors.map((e) => e.row)).toEqual([6, 16, 26])
  })

  itLive('imports CSV with types and nested fields', async () => {
    const csv = [
      'name,age,address.city,active,joined,ref,code',
      'Ann,31,Paris,true,2024-05-01T10:00:00Z,507f1f77bcf86cd799439011,007',
      'Bob,,Rome,false,2024-05-02,507f1f77bcf86cd799439012,""',
      '"Lee, Jr.",45,,yes,2024-05-03 08:00,507f1f77bcf86cd799439013,9'
    ].join('\n')
    const path = await fileOf('people.csv', csv)
    const preview = await engine.importPreview({
      dataProjectId: off,
      filePath: path,
      target: { kind: 'collection', database: 'shop', collection: C }
    })
    expect(preview.format).toBe('csv')
    expect(preview.inferredTypes).toEqual([
      'string',
      'number',
      'string',
      'string',
      'date',
      'objectId',
      'string'
    ])
    const res = await engine.importStart(
      req(path, {
        format: 'csv',
        csv: { delimiter: ',', quote: '"', header: true },
        empty: 'omit',
        columns: [
          { source: 0, target: 'name', type: 'string' },
          { source: 1, target: 'age', type: 'int32' },
          { source: 2, target: 'address.city', type: 'string' },
          { source: 3, target: 'active', type: 'boolean' },
          { source: 4, target: 'joined', type: 'date' },
          { source: 5, target: 'ref', type: 'objectId' },
          { source: 6, target: 'code', type: 'string' }
        ]
      }),
      { clientId: null }
    )
    expect(res).toMatchObject({ status: 'ok', rowsImported: 3 })
    const docs = (
      await engine.mongo.find(
        {
          dataProjectId: off,
          queryId: 'people',
          database: 'shop',
          collection: C,
          filter: '{ name: { $exists: true } }',
          sort: '{ name: 1 }',
          projection: '{ _id: 0 }',
          limit: 10
        },
        { clientId: null }
      )
    ).documents
    expect(docs[0]).toEqual({
      name: 'Ann',
      age: { $numberInt: '31' },
      address: { city: 'Paris' },
      active: true,
      joined: { $date: { $numberLong: '1714557600000' } },
      ref: { $oid: '507f1f77bcf86cd799439011' },
      code: '007'
    })
    expect(docs[1]).toMatchObject({ name: 'Bob', active: false, code: '' })
    expect(docs[1]).not.toHaveProperty('age')
    expect(docs[2]).toMatchObject({ name: 'Lee, Jr.', active: true })
    expect(docs[2]).not.toHaveProperty('address')
  })

  itLive('refuses a CSV value the column type cannot hold before writing anything', async () => {
    const path = await fileOf('bad-types.csv', 'name,age\nA,1\nB,old\nC,3\n')
    const res = (await engine.importStart(
      req(path, {
        format: 'csv',
        csv: { delimiter: ',', quote: '"', header: true },
        columns: [
          { source: 0, target: 'badtype', type: 'string' },
          { source: 1, target: 'age', type: 'int32' }
        ]
      }),
      { clientId: null }
    )) as Extract<DataImportResponse, { status: 'failed' }>
    expect(res.status).toBe('failed')
    expect(res.message).toContain('Row 2 (line 3): field "age": "old" is not an integer')
    expect(await total('{ badtype: { $exists: true } }')).toBe(0)
  })
})

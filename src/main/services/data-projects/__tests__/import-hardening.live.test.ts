// Import hardening against the docker databases through the engine with the real drivers:
// MySQL / MariaDB tables without transactions (MyISAM, MEMORY, Aria) and sessions with
// autocommit off, PostgreSQL invalid UTF-8 far past the detection window and one-column NULL
// rows (export → import round trip), MongoDB exact big integers, prototype-path refusal on a
// read-only project, years 0001 and the document count of a cancelled import. Every test works
// on its own tmp_fix3_* table / collection and drops it afterwards; the seeded data is never
// touched. Gated: TEDOOO_DP_IT=1.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  DataQueryResponse
} from '../../../../shared/data-projects/types'
import { noopLogger } from '../connection-manager'
import { createDataEngineService, type DataEngineServiceInternals } from '../engine-service'
import { clearImportScanCache } from '../import'
import { createSafetyGate } from '../safety-gate'
import { MemoryRepository, MemorySecrets, makeRecord } from './engine-fixtures'

const LIVE = !!process.env.TEDOOO_DP_IT
const itLive = LIVE ? it : it.skip

let dir = ''
let engine: DataEngineServiceInternals
const events: DataImportProgressEvent[] = []
/** importId → called on each of its progress events. */
const onEvent = new Map<string, (event: DataImportProgressEvent) => void>()

const MYSQL = (port: number): DataConnectionConfig => ({
  host: '127.0.0.1',
  port,
  user: 'root',
  database: 'shop'
})
const PG: DataConnectionConfig = {
  host: '127.0.0.1',
  port: 15432,
  user: 'postgres',
  database: 'shop'
}
const MONGO: DataConnectionConfig = {
  host: '127.0.0.1',
  port: 27018,
  user: 'root',
  database: 'shop',
  mongo: { srv: false, hosts: ['127.0.0.1:27018'], authSource: 'admin', directConnection: true }
}

beforeAll(async () => {
  if (!LIVE) return
  dir = await mkdtemp(join(tmpdir(), 'tedooo-import-fix3-'))
  const off = { safeMode: 'off' as const, environment: 'local' as const }
  const records = [
    makeRecord({ id: 'mysql-a', engine: 'mysql', config: MYSQL(13306), ...off }),
    makeRecord({ id: 'mysql-b', engine: 'mysql', config: MYSQL(13306), ...off }),
    makeRecord({ id: 'mariadb-a', engine: 'mariadb', config: MYSQL(13307), ...off }),
    makeRecord({ id: 'mariadb-b', engine: 'mariadb', config: MYSQL(13307), ...off }),
    makeRecord({ id: 'pg', engine: 'postgres', config: PG, ...off }),
    makeRecord({ id: 'mongo', engine: 'mongodb', config: MONGO, ...off }),
    makeRecord({ id: 'mongo-ro', engine: 'mongodb', config: MONGO, safeMode: 'read-only' })
  ]
  engine = createDataEngineService({
    repository: new MemoryRepository(records),
    secrets: new MemorySecrets({
      'mysql-a': { password: 'rootpw' },
      'mysql-b': { password: 'rootpw' },
      'mariadb-a': { password: 'rootpw' },
      'mariadb-b': { password: 'rootpw' },
      pg: { password: 'pgpw' },
      mongo: { password: 'mongopw' },
      'mongo-ro': { password: 'mongopw' }
    }),
    gate: createSafetyGate(),
    publish: (channel, payload) => {
      if (channel !== 'dataProjects:import') return
      const event = payload as DataImportProgressEvent
      events.push(event)
      onEvent.get(event.importId)?.(event)
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

const scalar = async (id: string, sql: string, database?: string): Promise<string | null> => {
  const res = await exec(id, sql, database)
  if (res.status !== 'ok') throw new Error('not ok')
  const out = res.statements[0].output
  if (out?.kind !== 'rows') throw new Error('no rows')
  const v = out.rows[0][0]
  return v === null ? null : String(v)
}

const fileOf = async (name: string, content: string | Uint8Array): Promise<string> => {
  const path = join(dir, name)
  await writeFile(path, content)
  return path
}

const sqlRequest = (
  id: string,
  table: string,
  filePath: string,
  extra: Partial<DataImportStartRequest> = {}
): DataImportStartRequest => ({
  dataProjectId: id,
  importId: `imp-${id}-${Math.random().toString(36).slice(2)}`,
  filePath,
  target: { kind: 'table', ref: { name: table, database: 'shop' } },
  format: 'csv',
  encoding: 'utf-8',
  csv: { delimiter: ',', quote: '"', header: true },
  columns: [
    { source: 0, target: 'id' },
    { source: 1, target: 'v' }
  ],
  empty: 'null',
  onError: 'stop',
  ...extra
})

/** Ten rows; row 6 repeats id 1 (or carries `bad` as its value). */
const tenRows = (bad?: string): string =>
  `id,v\n${Array.from({ length: 10 }, (_, i) =>
    i === 5 ? (bad ? `6,${bad}` : '1,dup') : `${i + 1},v${i + 1}`
  ).join('\n')}\n`

for (const flavour of ['mysql', 'mariadb'] as const) {
  describe(`import hardening (live ${flavour})`, () => {
    const a = `${flavour}-a`
    const b = `${flavour}-b`
    const T = 'tmp_fix3_import_nontx'
    const AC = 'tmp_fix3_import_ac'
    const count = async (table = T, id = a): Promise<number> =>
      Number(await scalar(id, `SELECT COUNT(*) FROM ${table}`, 'shop'))
    const engines = flavour === 'mysql' ? ['MyISAM', 'MEMORY'] : ['MyISAM', 'Aria']

    afterAll(async () => {
      if (!LIVE) return
      await exec(a, `DROP TABLE IF EXISTS ${T}`, 'shop').catch(() => undefined)
      await exec(a, `DROP TABLE IF EXISTS ${AC}`, 'shop').catch(() => undefined)
    })

    for (const storage of engines) {
      itLive(`${storage}: stop / skip blame the right row and count what is in`, async () => {
        clearImportScanCache()
        await exec(a, `DROP TABLE IF EXISTS ${T}`, 'shop')
        await exec(
          a,
          `CREATE TABLE ${T} (id INT PRIMARY KEY, v VARCHAR(30)) ENGINE=${storage}`,
          'shop'
        )
        const dup = await fileOf(`${flavour}-${storage}-dup.csv`, tenRows())
        const stop = (await engine.importStart(sqlRequest(a, T, dup, { batchSize: 10 }), {
          clientId: null
        })) as Extract<DataImportResponse, { status: 'failed' }>
        expect(stop).toMatchObject({ status: 'failed', rowsImported: 5 })
        expect(stop.errors[0]).toMatchObject({ row: 6, line: 7 })
        expect(stop.message).toMatch(/^Stopped at Row 6 \(line 7\): Duplicate entry/)
        expect(await count()).toBe(5)

        await exec(a, `TRUNCATE TABLE ${T}`, 'shop')
        const skip = await engine.importStart(
          sqlRequest(a, T, dup, { onError: 'skip', batchSize: 10 }),
          { clientId: null }
        )
        expect(skip).toMatchObject({ status: 'ok', rowsImported: 9, rowsSkipped: 1 })
        expect(await count()).toBe(9)

        // A value too long for the column on row 6: an error there (strict mode), not a clip.
        await exec(a, `DROP TABLE ${T}`, 'shop')
        await exec(
          a,
          `CREATE TABLE ${T} (id INT PRIMARY KEY, v VARCHAR(3)) ENGINE=${storage}`,
          'shop'
        )
        const long = await fileOf(
          `${flavour}-${storage}-long.csv`,
          `id,v\n${Array.from({ length: 10 }, (_, i) => `${i + 1},${i === 5 ? 'toolong' : 'ok'}`).join('\n')}\n`
        )
        const clipped = (await engine.importStart(sqlRequest(a, T, long, { batchSize: 10 }), {
          clientId: null
        })) as Extract<DataImportResponse, { status: 'failed' }>
        expect(clipped).toMatchObject({ status: 'failed', rowsImported: 5 })
        expect(clipped.errors[0]).toMatchObject({ row: 6 })
        expect(clipped.errors[0].message).toMatch(/too long/i)
        expect(await count()).toBe(5)
        expect(await scalar(a, `SELECT COUNT(*) FROM ${T} WHERE v = 'too'`, 'shop')).toBe('0')
      })
    }

    itLive('autocommit = 0 in the query tab: the reported rows are committed', async () => {
      await exec(a, `DROP TABLE IF EXISTS ${AC}`, 'shop')
      await exec(a, `CREATE TABLE ${AC} (id INT PRIMARY KEY, v VARCHAR(30)) ENGINE=InnoDB`, 'shop')
      await exec(a, 'SET autocommit = 0', 'shop')
      try {
        expect(await scalar(a, 'SELECT @@SESSION.autocommit', 'shop')).toBe('0')
        const path = await fileOf(`${flavour}-ac.csv`, 'id,v\n1,a\n2,b\n3,c\n')
        const res = await engine.importStart(sqlRequest(a, AC, path), { clientId: null })
        expect(res).toMatchObject({ status: 'ok', rowsImported: 3 })
        // Another connection sees them, and a ROLLBACK here does not take them away.
        expect(await count(AC, b)).toBe(3)
        await exec(a, 'ROLLBACK', 'shop')
        expect(await count(AC, b)).toBe(3)
        // The session's setting is back.
        expect(await scalar(a, 'SELECT @@SESSION.autocommit', 'shop')).toBe('0')
        expect(engine.status(a).inTransaction).toBe(false)

        // Skip mode with a failing row: also committed.
        const skip = await fileOf(`${flavour}-ac-skip.csv`, 'id,v\n4,d\n1,dup\n5,e\n')
        const res2 = await engine.importStart(sqlRequest(a, AC, skip, { onError: 'skip' }), {
          clientId: null
        })
        expect(res2).toMatchObject({ status: 'ok', rowsImported: 2, rowsSkipped: 1 })
        expect(await count(AC, b)).toBe(5)
      } finally {
        await exec(a, 'ROLLBACK', 'shop').catch(() => undefined)
        await exec(a, 'SET autocommit = 1', 'shop').catch(() => undefined)
      }
    })
  })
}

describe('import hardening (live postgres)', () => {
  const ENC = 'tmp_fix3_import_enc'
  const SRC = 'tmp_fix3_import_one_src'
  const DST = 'tmp_fix3_import_one_dst'

  afterAll(async () => {
    if (!LIVE) return
    for (const t of [ENC, SRC, DST])
      await exec('pg', `DROP TABLE IF EXISTS public.${t}`, 'shop').catch(() => undefined)
  })

  itLive('refuses invalid UTF-8 after the detection window instead of storing U+FFFD', async () => {
    await exec('pg', `DROP TABLE IF EXISTS public.${ENC}`, 'shop')
    await exec('pg', `CREATE TABLE public.${ENC} (id int PRIMARY KEY, v text)`, 'shop')
    const rows = Array.from({ length: 30_000 }, (_, i) => `${i + 1},row${i + 1}`).join('\n')
    const bytes = Buffer.concat([
      Buffer.from(`id,v\n${rows}\n30001,caf`),
      Buffer.from([0xe9]),
      Buffer.from('\n')
    ])
    const path = await fileOf('pg-late-latin1.csv', bytes)
    const preview = await engine.importPreview({
      dataProjectId: 'pg',
      filePath: path,
      target: { kind: 'table', ref: { name: ENC, schema: 'public', database: 'shop' } }
    })
    expect(preview.encoding).toBe('utf-8') // the head is ASCII
    const req = sqlRequest('pg', ENC, path, {
      target: { kind: 'table', ref: { name: ENC, schema: 'public', database: 'shop' } }
    })
    const res = (await engine.importStart(req, { clientId: null })) as Extract<
      DataImportResponse,
      { status: 'failed' }
    >
    expect(res.status).toBe('failed')
    expect(res.message).toMatch(
      /^Nothing was imported: Row 30,001 \(line 30,002\): The file is not valid UTF-8 at byte/
    )
    expect(Number(await scalar('pg', `SELECT COUNT(*) FROM public.${ENC}`, 'shop'))).toBe(0)

    const ok = await engine.importStart(
      { ...req, importId: `${req.importId}-1252`, encoding: 'windows-1252' },
      { clientId: null }
    )
    expect(ok).toMatchObject({ status: 'ok', rowsImported: 30_001 })
    expect(await scalar('pg', `SELECT v FROM public.${ENC} WHERE id = 30001`, 'shop')).toBe('café')
  })

  itLive('one-column NULL rows round-trip through our CSV export', async () => {
    await exec('pg', `DROP TABLE IF EXISTS public.${SRC}`, 'shop')
    await exec('pg', `DROP TABLE IF EXISTS public.${DST}`, 'shop')
    await exec('pg', `CREATE TABLE public.${SRC} (v text)`, 'shop')
    await exec('pg', `CREATE TABLE public.${DST} (v text)`, 'shop')
    await exec(
      'pg',
      `INSERT INTO public.${SRC} (v) VALUES (NULL), ('x'), (NULL), (''), ('y'), (NULL)`,
      'shop'
    )
    const filePath = join(dir, 'one-column-export.csv')
    const exported = await engine.exportStart(
      {
        dataProjectId: 'pg',
        exportId: 'fix3-one-column',
        source: { kind: 'table', ref: { database: 'shop', schema: 'public', name: SRC } },
        format: 'csv',
        filePath
      },
      { clientId: null }
    )
    expect(exported).toMatchObject({ status: 'ok', rows: 6 })
    const res = await engine.importStart(
      sqlRequest('pg', DST, filePath, {
        target: { kind: 'table', ref: { name: DST, schema: 'public', database: 'shop' } },
        columns: [{ source: 0, target: 'v' }]
      }),
      { clientId: null }
    )
    expect(res).toMatchObject({ status: 'ok', rowsRead: 6, rowsImported: 6 })
    const tally = async (table: string): Promise<string | null> =>
      scalar(
        'pg',
        `SELECT string_agg(coalesce(v, '<null>'), '|' ORDER BY coalesce(v, '<null>')) FROM public.${table}`,
        'shop'
      )
    expect(await tally(DST)).toBe(await tally(SRC))
    expect(await tally(DST)).toBe('|<null>|<null>|<null>|x|y')
  })
})

describe('import hardening (live mongodb)', () => {
  const C = 'tmp_fix3_import_docs'
  const total = async (filter = '{}'): Promise<number> =>
    (
      await engine.mongo.find(
        {
          dataProjectId: 'mongo',
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
  const findOne = async (filter: string): Promise<Record<string, unknown> | undefined> =>
    (
      await engine.mongo.find(
        {
          dataProjectId: 'mongo',
          queryId: `f-${Math.random().toString(36).slice(2)}`,
          database: 'shop',
          collection: C,
          filter,
          limit: 1
        },
        { clientId: null }
      )
    ).documents[0]
  const req = (
    filePath: string,
    extra: Partial<DataImportStartRequest> = {}
  ): DataImportStartRequest => ({
    dataProjectId: 'mongo',
    importId: `imp-mongo-${Math.random().toString(36).slice(2)}`,
    filePath,
    target: { kind: 'collection', database: 'shop', collection: C },
    format: 'ndjson',
    encoding: 'utf-8',
    empty: 'omit',
    onError: 'stop',
    ...extra
  })
  const drop = async (): Promise<void> => {
    await engine.mongo
      .collection({
        dataProjectId: 'mongo',
        database: 'shop',
        action: { kind: 'drop', collection: C }
      })
      .catch(() => undefined)
  }

  beforeAll(async () => {
    if (!LIVE) return
    await drop()
    await engine.mongo.collection({
      dataProjectId: 'mongo',
      database: 'shop',
      action: { kind: 'create', collection: C }
    })
  })
  afterAll(async () => {
    if (!LIVE) return
    await drop()
  })

  itLive('keeps integers beyond 2^53 exact (NDJSON and JSON)', async () => {
    const path = await fileOf(
      'big.ndjson',
      '{"_id":"fix3_big","n":9007199254740993,"m":-1234567890123456789,"i":7,"arr":[18014398509481985]}\n'
    )
    const res = await engine.importStart(req(path), { clientId: null })
    expect(res).toMatchObject({ status: 'ok', rowsImported: 1 })
    expect(await findOne('{ _id: "fix3_big" }')).toMatchObject({
      n: { $numberLong: '9007199254740993' },
      m: { $numberLong: '-1234567890123456789' },
      i: { $numberInt: '7' },
      arr: [{ $numberLong: '18014398509481985' }]
    })
    expect(await total('{ n: NumberLong("9007199254740993") }')).toBe(1)
    expect(await total('{ n: NumberLong("9007199254740992") }')).toBe(0)
  })

  itLive(
    'refuses __proto__ / constructor paths on a read-only project without polluting',
    async () => {
      const path = await fileOf(
        'proto.csv',
        '__proto__.vimpLive,constructor.prototype.vimpLive2,name\nyes,yes2,bob\n'
      )
      const preview = await engine.importPreview({
        dataProjectId: 'mongo-ro',
        filePath: path,
        target: { kind: 'collection', database: 'shop', collection: C }
      })
      expect(preview.columns).toEqual([
        '__proto__.vimpLive',
        'constructor.prototype.vimpLive2',
        'name'
      ])
      await expect(
        engine.importStart(
          {
            ...req(path, {
              format: 'csv',
              csv: { delimiter: ',', quote: '"', header: true },
              columns: preview.columns.map((target, source) => ({ source, target, type: 'string' }))
            }),
            dataProjectId: 'mongo-ro'
          },
          { clientId: null }
        )
      ).rejects.toThrow(/cannot be a field name/)
      const probe = {} as Record<string, unknown>
      expect(probe.vimpLive).toBeUndefined()
      expect(probe.vimpLive2).toBeUndefined()

      // A JSON document's own "__proto__" key is an ordinary field.
      const json = await fileOf(
        'proto.ndjson',
        '{"_id":"fix3_proto","__proto__":{"vimpJson":1},"a":1}\n'
      )
      const res = await engine.importStart(req(json), { clientId: null })
      expect(res).toMatchObject({ status: 'ok', rowsImported: 1 })
      expect(probe.vimpJson).toBeUndefined()
      expect(await total('{ _id: "fix3_proto", "__proto__.vimpJson": 1 }')).toBe(1)
    }
  )

  itLive('stores the years 0001–0099 as written', async () => {
    const path = await fileOf('old.csv', 'k,d\nfix3_y1,0001-01-01T00:00:00\nfix3_y99,0099-12-31\n')
    const res = await engine.importStart(
      req(path, {
        format: 'csv',
        csv: { delimiter: ',', quote: '"', header: true },
        columns: [
          { source: 0, target: 'k', type: 'string' },
          { source: 1, target: 'd', type: 'date' }
        ]
      }),
      { clientId: null }
    )
    expect(res).toMatchObject({ status: 'ok', rowsImported: 2 })
    const y1 = (await findOne('{ k: "fix3_y1" }')) as { d: { $date: { $numberLong: string } } }
    expect(new Date(Number(y1.d.$date.$numberLong)).toISOString()).toBe('0001-01-01T00:00:00.000Z')
    const y99 = (await findOne('{ k: "fix3_y99" }')) as { d: { $date: { $numberLong: string } } }
    expect(new Date(Number(y99.d.$date.$numberLong)).toISOString()).toBe('0099-12-31T00:00:00.000Z')
  })

  // Inserts into a collection with several indexes are slow enough for a cancel to land while
  // an insertMany runs.
  const SLOW = 'tmp_fix3_import_slow'
  const FIELDS = ['a', 'b', 'c', 'd', 'e', 'f']
  const slowFile = async (name: string, tag: string, n: number, withIds = false): Promise<string> =>
    fileOf(
      name,
      `${Array.from({ length: n }, (_, i) =>
        JSON.stringify({
          ...(withIds ? { _id: `${tag}-${i}` } : {}),
          t: tag,
          i,
          ...Object.fromEntries(
            FIELDS.map((f, k) => [f, `${f}${(i * 7919 + k * 104729) % 1_000_003}`])
          )
        })
      ).join('\n')}\n`
    )
  const slowTotal = async (tag: string): Promise<number> =>
    (
      await engine.mongo.find(
        {
          dataProjectId: 'mongo',
          queryId: `s-${Math.random().toString(36).slice(2)}`,
          database: 'shop',
          collection: SLOW,
          filter: `{ t: "${tag}" }`,
          limit: 1,
          withCount: true
        },
        { clientId: null }
      )
    ).count ?? -1

  const cancelAfter = (request: DataImportStartRequest, ms: number, times: number): void => {
    let armed = false
    onEvent.set(request.importId, (event) => {
      if (armed || event.phase !== 'importing') return
      armed = true
      setTimeout(() => {
        for (let k = 0; k < times; k++) void engine.importCancel(request.importId)
      }, ms)
    })
  }

  describe('cancel', () => {
    beforeAll(async () => {
      if (!LIVE) return
      const action = (kind: 'drop' | 'create') =>
        engine.mongo.collection({
          dataProjectId: 'mongo',
          database: 'shop',
          action: { kind, collection: SLOW }
        })
      await action('drop').catch(() => undefined)
      await action('create')
      for (const f of FIELDS)
        await exec('mongo', `db.getCollection("${SLOW}").createIndex({ ${f}: 1, i: -1 })`, 'shop')
    })
    afterAll(async () => {
      if (!LIVE) return
      await engine.mongo
        .collection({
          dataProjectId: 'mongo',
          database: 'shop',
          action: { kind: 'drop', collection: SLOW }
        })
        .catch(() => undefined)
    })

    for (const [label, times, withIds] of [
      ['a cancel lets the batch in flight finish: the count is exact', 1, false],
      ['a second cancel kills the batch: the documents it wrote are still counted', 2, false],
      ['a killed batch of documents with their own _id is reported as a range', 2, true]
    ] as const) {
      itLive(
        label,
        async () => {
          const partial: number[] = []
          for (const ms of [40, 120, 250, 400]) {
            const tag = `fix3-cancel-${times}-${withIds}-${ms}`
            const path = await slowFile(`${tag}.ndjson`, tag, 40_000, withIds)
            const request = {
              ...req(path, { batchSize: 10_000 }),
              target: { kind: 'collection' as const, database: 'shop', collection: SLOW }
            }
            cancelAfter(request, ms, times)
            const res = await engine.importStart(request, { clientId: null })
            onEvent.delete(request.importId)
            const actual = await slowTotal(tag)
            if (res.status === 'ok') {
              expect(actual).toBe(40_000) // all in before the cancel landed
              continue
            }
            expect(res.status).toBe('cancelled')
            if (res.status !== 'cancelled') continue
            if (actual % 10_000 !== 0) partial.push(actual)
            if (!withIds) {
              // Exact (our own _ids): no range, and the reported count is what is there.
              expect(res.rowsUncertain).toBeUndefined()
              expect(res.rowsImported).toBe(actual)
            } else {
              // The file's _ids could have existed before: a range that holds the truth.
              expect(res.rowsImported).toBeLessThanOrEqual(actual)
              expect(res.rowsImported + (res.rowsUncertain ?? 0)).toBeGreaterThanOrEqual(actual)
              if (actual % 10_000 !== 0) expect(res.rowsUncertain).toBe(10_000)
            }
          }
          // The graceful cancel never stops mid-batch. Whether a forced one lands mid-batch
          // depends on timing (under load every cancel can hit a batch boundary); when it does,
          // the count checks above already proved the reported numbers.
          if (times === 1) expect(partial).toEqual([])
          else if (partial.length === 0)
            console.warn('forced cancels all landed on batch boundaries this run')
        },
        180_000
      )
    }
  })
})

// End-to-end engine tests against the docker containers (design §8): the real drivers behind
// createDataEngineService with in-memory repository/secrets. Gated: TEDOOO_DP_IT=1.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {
  DataEngine,
  DataQueryRequest,
  DataQueryResponse
} from '../../../../shared/data-projects/types'
import type { DataDriver } from '../contracts'
import { noopLogger } from '../connection-manager'
import { createDataEngineService, type DataEngineServiceInternals } from '../engine-service'
import { createMysqlDriver } from '../drivers/mysql'
import { createPostgresDriver } from '../drivers/postgres'
import { createSafetyGate } from '../safety-gate'
import { MemoryRepository, MemorySecrets, makeRecord } from './engine-fixtures'

const LIVE = !!process.env.TEDOOO_DP_IT
const itLive = LIVE ? it : it.skip

interface Target {
  engine: DataEngine
  port: number
  user: string
  password: string
  sleep: string
  createFn: string
  dropFn: string
  createTables: string[]
  dropTables: string[]
}

const T = 'tmp_engine_core'

const TARGETS: Target[] = [
  ...(['mysql', 'mariadb'] as const).map((engine): Target => ({
    engine,
    port: engine === 'mysql' ? 13306 : 13307,
    user: 'root',
    password: 'rootpw',
    sleep: 'SELECT SLEEP(5)',
    createFn: `CREATE FUNCTION ${T}_fn() RETURNS INT DETERMINISTIC MODIFIES SQL DATA BEGIN INSERT INTO ${T}_log VALUES (1); RETURN 1; END`,
    dropFn: `DROP FUNCTION IF EXISTS ${T}_fn`,
    createTables: [
      `CREATE TABLE ${T}_items (id INT PRIMARY KEY, name VARCHAR(50), qty INT NOT NULL DEFAULT 0)`,
      `CREATE TABLE ${T}_log (v INT)`,
      `INSERT INTO ${T}_items VALUES (1, 'a', 1), (2, 'b', 2)`
    ],
    dropTables: [`DROP TABLE IF EXISTS ${T}_items`, `DROP TABLE IF EXISTS ${T}_log`]
  })),
  {
    engine: 'postgres',
    port: 15432,
    user: 'postgres',
    password: 'pgpw',
    sleep: 'SELECT pg_sleep(5)',
    createFn: `CREATE FUNCTION ${T}_fn() RETURNS int LANGUAGE plpgsql AS $$ BEGIN INSERT INTO ${T}_log VALUES (1); RETURN 1; END $$`,
    dropFn: `DROP FUNCTION IF EXISTS ${T}_fn()`,
    createTables: [
      `CREATE TABLE ${T}_items (id int PRIMARY KEY, name text, qty int NOT NULL DEFAULT 0)`,
      `CREATE TABLE ${T}_log (v int)`,
      `INSERT INTO ${T}_items VALUES (1, 'a', 1), (2, 'b', 2)`
    ],
    dropTables: [`DROP TABLE IF EXISTS ${T}_items`, `DROP TABLE IF EXISTS ${T}_log`]
  }
]

for (const target of TARGETS) {
  describe(`engine (live ${target.engine})`, () => {
    const id = `live-${target.engine}`
    const adminId = `${id}-admin`
    const schema = target.engine === 'postgres' ? 'public' : undefined
    const config = { host: '127.0.0.1', port: target.port, user: target.user, database: 'shop' }
    let engine: DataEngineServiceInternals
    let admin: DataDriver
    let dir = ''

    const q = (text: string, extra: Partial<DataQueryRequest> = {}): DataQueryRequest => ({
      dataProjectId: id,
      queryId: `${target.engine}-${Math.random().toString(36).slice(2)}`,
      text,
      database: 'shop',
      schema,
      limit: 100,
      source: 'editor',
      ...extra
    })
    const run = async (
      text: string,
      extra: Partial<DataQueryRequest> = {}
    ): Promise<DataQueryResponse> => engine.execute(q(text, extra), { clientId: 'live-client' })
    const adminRun = async (sql: string): Promise<void> => {
      await admin.execute(sql, { limit: null, hardCap: 10, readOnlySandbox: false })
    }

    beforeAll(async () => {
      if (!LIVE) return
      dir = await mkdtemp(join(tmpdir(), `tedooo-live-${target.engine}-`))
      const repo = new MemoryRepository([
        makeRecord({
          id,
          engine: target.engine,
          config,
          safeMode: 'half-safe',
          environment: 'development'
        }),
        makeRecord({
          id: adminId,
          engine: target.engine,
          config,
          safeMode: 'off',
          environment: 'local'
        })
      ])
      engine = createDataEngineService({
        repository: repo,
        secrets: new MemorySecrets({
          [id]: { password: target.password },
          [adminId]: { password: target.password }
        }),
        gate: createSafetyGate(),
        logger: noopLogger
      })
      const input = {
        project: makeRecord({ id: 'setup', engine: target.engine, config }),
        secrets: { password: target.password },
        redact: (t: string) => t
      }
      admin = target.engine === 'postgres' ? createPostgresDriver(input) : createMysqlDriver(input)
      await admin.connect()
      await adminRun(target.dropFn)
      for (const sql of target.dropTables) await adminRun(sql)
      for (const sql of target.createTables) await adminRun(sql)
      if (target.engine === 'mysql')
        await adminRun('SET GLOBAL log_bin_trust_function_creators = 1').catch(() => undefined)
      await adminRun(target.createFn)
    })

    afterAll(async () => {
      if (!LIVE) return
      await engine?.shutdown()
      if (admin) {
        await adminRun(target.dropFn).catch(() => undefined)
        for (const sql of target.dropTables) await adminRun(sql).catch(() => undefined)
        await admin.close()
      }
      if (dir) await rm(dir, { recursive: true, force: true })
    })

    itLive('runs a SELECT with auto-limit truncation', async () => {
      const res = await run('SELECT * FROM orders ORDER BY id', { limit: 10 })
      expect(res.status).toBe('ok')
      if (res.status !== 'ok') return
      const out = res.statements[0].output
      expect(out?.kind).toBe('rows')
      if (out?.kind !== 'rows') return
      expect(out.rows).toHaveLength(10)
      expect(out).toMatchObject({ truncated: true, autoLimited: true, limit: 10 })
      expect(engine.status(id)).toMatchObject({ state: 'connected', inTransaction: false })
    })

    itLive('runs several statements with per-statement results and offsets', async () => {
      const text = 'SELECT 1 AS a;\nSELECT COUNT(*) AS n FROM users'
      const res = await run(text)
      expect(res.status).toBe('ok')
      if (res.status !== 'ok') return
      expect(res.statements).toHaveLength(2)
      expect(text.slice(res.statements[1].start, res.statements[1].end)).toBe(
        'SELECT COUNT(*) AS n FROM users'
      )
      expect(res.statements.every((s) => s.durationMs >= 0 && !s.error)).toBe(true)
    })

    itLive('reports an error position inside the failing statement', async () => {
      const res = await run('SELECT 1;\nSELECT id FROM users WHERE')
      expect(res.status).toBe('ok')
      if (res.status !== 'ok') return
      const failed = res.statements[1]
      expect(failed.error?.message).toBeTruthy()
      expect(failed.error?.position).toBeTypeOf('number')
      expect(failed.error!.position!).toBeLessThanOrEqual(failed.text.length)
    })

    itLive('half-safe: a write needs confirmation, then the token runs it', async () => {
      const text = `UPDATE ${T}_items SET qty = qty + 1 WHERE id = 1`
      const first = await run(text)
      expect(first.status).toBe('confirmation_required')
      if (first.status !== 'confirmation_required') return
      const second = await engine.execute(
        { ...q(text), confirmToken: first.confirmToken },
        { clientId: null }
      )
      expect(second.status).toBe('ok')
      if (second.status !== 'ok') return
      expect(second.statements[0].output).toMatchObject({ kind: 'command', affectedRows: 1 })
    })

    itLive('a "read" that writes through a function is caught by the sandbox', async () => {
      const res = await run(`SELECT ${T}_fn() AS v`)
      expect(res.status).toBe('confirmation_required')
      if (res.status !== 'confirmation_required') return
      expect(res.plan.statements[0].reasons.join(' ')).toMatch(/tried to write/)
      const confirmed = await engine.execute(
        { ...q(`SELECT ${T}_fn() AS v`), confirmToken: res.confirmToken },
        { clientId: null }
      )
      expect(confirmed.status).toBe('ok')
      const fnDdl = await engine.ddl(id, {
        database: 'shop',
        schema,
        name: `${T}_fn`,
        kind: 'function'
      })
      expect(fnDdl).toMatch(
        target.engine === 'postgres'
          ? /CREATE OR REPLACE FUNCTION public\.tmp_engine_core_fn\(\)/
          : /DELIMITER ;;\nCREATE DEFINER=/
      )
      const log = await run(`SELECT COUNT(*) AS n FROM ${T}_log`)
      expect(
        log.status === 'ok' &&
          String((log.statements[0].output as { rows: unknown[][] }).rows[0][0])
      ).toBe('1')
    })

    itLive('cancels a running sleep by queryId', async () => {
      const queryId = `${target.engine}-sleep`
      const started = Date.now()
      const running = engine.execute(
        { ...q(target.sleep), dataProjectId: adminId, queryId },
        { clientId: 'live-client' }
      )
      await new Promise((r) => setTimeout(r, 500))
      expect(await engine.cancel(queryId)).toEqual({ cancelled: true })
      const res = await running
      expect(res.status).toBe('cancelled')
      expect(Date.now() - started).toBeLessThan(4000)
      const after = await engine.execute(
        { ...q('SELECT 1 AS ok'), dataProjectId: adminId },
        { clientId: null }
      )
      expect(after.status).toBe('ok')
    })

    itLive('lists processes including its own session', async () => {
      await run('SELECT 1')
      const list = await engine.processes(id)
      expect(list.some((p) => p.isOwn)).toBe(true)
    })

    itLive('describes, shows DDL and builds the completion schema', async () => {
      const ref = { database: 'shop', schema, name: 'orders' }
      const details = await engine.describe(id, ref)
      expect(details.primaryKey).toEqual(['id'])
      expect(details.foreignKeys[0]?.refTable).toBe('users')
      const ddl = await engine.ddl(id, { ...ref, kind: 'table' })
      expect(ddl).toMatch(/CREATE TABLE/i)
      expect(ddl).toMatch(/user_id/)
      const completion = await engine.completionSchema(id, 'shop', true)
      expect(
        completion.tables.find((t) => t.name === 'order_items')?.columns.map((c) => c.name)
      ).toContain('unit_price')
      const objects = await engine.objects(id, 'shop', schema)
      expect(objects.objects.some((o) => o.name === 'users' && o.kind === 'table')).toBe(true)
      const dbs = await engine.databases(id)
      expect(dbs.some((d) => d.name === 'shop')).toBe(true)
    })

    itLive('browses a table with filters, sort and pagination', async () => {
      const ref = { database: 'shop', schema, name: 'users' }
      const res = await engine.tableRows(
        {
          dataProjectId: id,
          queryId: `${target.engine}-rows`,
          ref,
          filters: [{ column: 'country', operator: '=', value: 'IL' }],
          orderBy: [{ column: 'id', direction: 'desc' }],
          limit: 5,
          offset: 5
        },
        { clientId: null }
      )
      expect(res.primaryKey).toEqual(['id'])
      expect(res.result.rows).toHaveLength(5)
      const idIndex = res.result.columns.findIndex((c) => c.name === 'id')
      const countryIndex = res.result.columns.findIndex((c) => c.name === 'country')
      const ids = res.result.rows.map((r) => Number(r[idIndex]))
      expect([...ids].sort((a, b) => b - a)).toEqual(ids)
      expect(res.result.rows.every((r) => r[countryIndex] === 'IL')).toBe(true)
      const count = await run("SELECT COUNT(*) AS n FROM users WHERE country = 'IL'")
      const exact = Number(
        (count.status === 'ok' &&
          (count.statements[0].output as { rows: unknown[][] }).rows[0][0]) ||
          -1
      )
      expect(res.totalRows).toBe(exact)
      expect(res.totalIsEstimate).toBe(false)
      const raw = await engine.tableRows(
        {
          dataProjectId: id,
          queryId: `${target.engine}-raw`,
          ref,
          where: "email LIKE 'shira%' -- only Shira",
          limit: 50,
          offset: 0
        },
        { clientId: null }
      )
      expect(raw.result.rows.length).toBeGreaterThan(0)
    })

    itLive('applies staged edits (update + insert + delete) in one transaction', async () => {
      const ref = { database: 'shop', schema, name: `${T}_items` }
      const edits = [
        { kind: 'update' as const, key: { id: 1 }, changes: { name: "it's A" } },
        { kind: 'insert' as const, values: { id: 3, name: 'c', qty: 3 } },
        { kind: 'delete' as const, key: { id: 2 } }
      ]
      const preview = await engine.previewEdits(id, ref, edits)
      expect(preview).toHaveLength(3)
      const first = await engine.applyEdits({ dataProjectId: id, ref, edits }, { clientId: null })
      expect(first.status).toBe('confirmation_required')
      if (first.status !== 'confirmation_required') return
      const done = await engine.applyEdits(
        { dataProjectId: id, ref, edits, confirmToken: first.confirmToken },
        { clientId: null }
      )
      expect(done).toMatchObject({ status: 'ok', affectedRows: 3 })
      const rows = await run(`SELECT id, name FROM ${T}_items ORDER BY id`)
      expect(
        rows.status === 'ok' &&
          (rows.statements[0].output as { rows: unknown[][] }).rows.map((r) => [Number(r[0]), r[1]])
      ).toEqual([
        [1, "it's A"],
        [3, 'c']
      ])
      // A stale key rolls the whole batch back.
      const stale = [
        { kind: 'insert' as const, values: { id: 4, name: 'd' } },
        { kind: 'update' as const, key: { id: 99 }, changes: { name: 'x' } }
      ]
      const confirm = await engine.applyEdits(
        { dataProjectId: id, ref, edits: stale },
        { clientId: null }
      )
      if (confirm.status !== 'confirmation_required') throw new Error('expected confirmation')
      await expect(
        engine.applyEdits(
          { dataProjectId: id, ref, edits: stale, confirmToken: confirm.confirmToken },
          { clientId: null }
        )
      ).rejects.toThrow(/matched no row/)
      const after = await run(`SELECT COUNT(*) FROM ${T}_items WHERE id = 4`)
      expect(
        after.status === 'ok' &&
          String((after.statements[0].output as { rows: unknown[][] }).rows[0][0])
      ).toBe('0')
      expect(engine.status(id).inTransaction).toBe(false)
    })

    itLive('exports a table to CSV', async () => {
      const filePath = join(dir, 'users.csv')
      const res = await engine.exportStart(
        {
          dataProjectId: id,
          exportId: `${target.engine}-export`,
          source: { kind: 'table', ref: { database: 'shop', schema, name: 'users' } },
          format: 'csv',
          filePath
        },
        { clientId: null }
      )
      expect(res.status).toBe('ok')
      const text = await readFile(filePath, 'utf8')
      const lines = text.trimEnd().split('\r\n')
      expect(lines[0]).toBe('id,name,email,country,created_at,is_banned')
      const count = await run('SELECT COUNT(*) FROM users')
      const n = Number(
        count.status === 'ok' && (count.statements[0].output as { rows: unknown[][] }).rows[0][0]
      )
      expect(lines.length - 1).toBe(n)
      expect(res.status === 'ok' && res.rows).toBe(n)
    })

    if (target.engine === 'mysql') {
      itLive('USE switches the session database and the status follows', async () => {
        const res = await run('USE mysql', { database: undefined })
        expect(res.status === 'ok' && res.database).toBe('mysql')
        expect(engine.status(id).currentDatabase).toBe('mysql')
        const back = await run('SELECT DATABASE()', { database: 'shop' })
        expect(
          back.status === 'ok' && (back.statements[0].output as { rows: unknown[][] }).rows[0][0]
        ).toBe('shop')
      })
    }

    if (target.engine === 'postgres') {
      itLive(
        'uses the request schema for unqualified names and one connection per database',
        async () => {
          const res = await run('SELECT * FROM daily_revenue ORDER BY day LIMIT 3', {
            schema: 'analytics'
          })
          expect(res.status === 'ok' && !res.statements[0].error).toBe(true)
          const other = await run('SELECT current_database()', {
            database: 'postgres',
            schema: undefined
          })
          expect(
            other.status === 'ok' &&
              (other.statements[0].output as { rows: unknown[][] }).rows[0][0]
          ).toBe('postgres')
        }
      )
    }
  })
}

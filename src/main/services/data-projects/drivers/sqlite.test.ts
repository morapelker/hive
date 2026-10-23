// SQLite DataDriver on copies of the seeded shop database, in both modes: in-process (what
// vitest and unbundled runs use) and child (forks __fixtures__/sqlite-worker-entry.cjs, which
// stands in for the server bundle) — the latter covers real cancel, timeouts, the
// restart-and-report path and a responsive control connection during a long statement.
// Needs better-sqlite3 for this runtime: run with the Electron runner.

import { copyFileSync, existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import type {
  DataConnectionConfig,
  DataRowsResult,
  DataTableDetails
} from '../../../../shared/data-projects/types'
import {
  DataDriverError,
  type DataDriver,
  type DataProjectRecord,
  type DriverExecuteOptions,
  type DriverStatementResult
} from '../contracts'
import {
  createSqliteDriver,
  defaultSqliteWorkerMode,
  resolveSqlitePath,
  type SqliteDriverOptions
} from './sqlite'

const nodeRequire = createRequire(import.meta.url)
const sqliteAvailable = (() => {
  try {
    const Database = nodeRequire('better-sqlite3')
    new Database(':memory:').close()
    return true
  } catch {
    return false
  }
})()

// Seeded by scripts/data-projects-test-dbs/up.sh (TEDOOO_DP_SQLITE_SEED overrides).
const SEED =
  process.env.TEDOOO_DP_SQLITE_SEED ?? join(__dirname, '../../../../..', '.test-dbs', 'shop.sqlite')
const describeSeed = sqliteAvailable && existsSync(SEED) ? describe : describe.skip

const ENTRY = join(__dirname, '__fixtures__', 'sqlite-worker-entry.cjs')
/** One long native step (no row callbacks): only killing the process stops it. */
const LONG_QUERY =
  'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 2000000000) SELECT count(*) FROM c'

const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'tedooo-sqlite-driver-')))
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }))

let copySeq = 0
const seedCopy = (): string => {
  const path = join(tmpRoot, `shop-${++copySeq}.sqlite`)
  copyFileSync(SEED, path)
  return path
}

const record = (config: DataConnectionConfig): DataProjectRecord => ({
  id: 'dp-sqlite',
  name: 'Shop (SQLite)',
  engine: 'sqlite',
  config,
  icon: null,
  iconColor: null,
  environment: 'local',
  color: null,
  safeMode: 'off',
  defaultLimit: 1000,
  allowAiDataAccess: false,
  pinned: false,
  secretCiphertext: null,
  secretState: 'none',
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastAccessedAt: '2026-01-01T00:00:00.000Z'
})

const drivers: DataDriver[] = []
afterEach(async () => {
  await Promise.all(drivers.splice(0).map((d) => d.close().catch(() => undefined)))
})

const makeDriver = (
  config: Partial<DataConnectionConfig> = {},
  options: SqliteDriverOptions = { mode: 'in-process' }
): DataDriver => {
  const driver = createSqliteDriver(
    { project: record({ filePath: seedCopy(), ...config }), secrets: {}, redact: (t) => t },
    options
  )
  drivers.push(driver)
  return driver
}

const childOptions: SqliteDriverOptions = {
  mode: 'child',
  workerEntry: ENTRY,
  startTimeoutMs: 20_000
}

const opts = (overrides: Partial<DriverExecuteOptions> = {}): DriverExecuteOptions => ({
  limit: 1000,
  hardCap: 100_000,
  readOnlySandbox: false,
  ...overrides
})

const rows = (result: DriverStatementResult): DataRowsResult => {
  if (result.output.kind !== 'rows') throw new Error(`expected rows, got ${result.output.kind}`)
  return result.output
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('sqlite driver helpers', () => {
  it('forks only from inside the server bundle', () => {
    expect(
      defaultSqliteWorkerMode({ HIVE_SERVER_MODE: 'desktop' }, [
        '/x/Electron',
        '/app/out/main/server.js'
      ])
    ).toBe('child')
    expect(
      defaultSqliteWorkerMode({ HIVE_SERVER_MODE: 'browser' }, [
        'node',
        '/srv/out/main/server.js'
      ])
    ).toBe('child')
    expect(defaultSqliteWorkerMode({}, ['node', '/app/out/main/server.js'])).toBe('in-process')
    expect(
      defaultSqliteWorkerMode({ HIVE_SERVER_MODE: 'desktop' }, [
        'node',
        '/repo/src/server/bin.ts'
      ])
    ).toBe('in-process')
    expect(
      defaultSqliteWorkerMode({ HIVE_SERVER_MODE: 'desktop' }, ['node', 'vitest.mjs'])
    ).toBe('in-process')
  })

  it('resolves file paths', () => {
    expect(resolveSqlitePath('~/x.db')).toBe(join(homedir(), 'x.db'))
    expect(resolveSqlitePath('/a/b/../c.db')).toBe('/a/c.db')
    expect(resolveSqlitePath(':memory:')).toBe(':memory:')
    expect(() => resolveSqlitePath('rel.db')).toThrow(/absolute/)
    expect(() => resolveSqlitePath('  ')).toThrow(DataDriverError)
  })
})

describeSeed('sqlite driver (in-process)', () => {
  it('connects and reports the version', async () => {
    const driver = makeDriver()
    const info = await driver.connect()
    expect(info.serverVersion).toMatch(/^SQLite 3\./)
    expect(info).toMatchObject({ currentDatabase: 'main', readOnlyUser: false })
    expect(driver.isConnected()).toBe(true)
    expect(driver.sessionState()).toEqual({ inTransaction: false, currentDatabase: 'main' })
    await driver.close()
    expect(driver.isConnected()).toBe(false)
  })

  it('fails to connect to a missing file with a clear error', async () => {
    const driver = createSqliteDriver(
      {
        project: record({ filePath: join(tmpRoot, 'nope.sqlite') }),
        secrets: {},
        redact: (t) => t
      },
      { mode: 'in-process' }
    )
    drivers.push(driver)
    await expect(driver.connect()).rejects.toMatchObject({
      code: 'SQLITE_CANTOPEN',
      message: expect.stringContaining('not found')
    })
  })

  it('creates a new database file when the project asks for it', async () => {
    const path = join(tmpRoot, `new-${Date.now()}.sqlite`)
    const driver = createSqliteDriver(
      {
        project: record({ filePath: path, options: { create: 'true' } }),
        secrets: {},
        redact: (t) => t
      },
      { mode: 'in-process' }
    )
    drivers.push(driver)
    await driver.connect()
    await driver.execute('CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT)', opts())
    expect(existsSync(path)).toBe(true)
    expect((await driver.listObjects()).objects.map((o) => o.name)).toEqual(['t'])
  })

  it('applies the auto-limit, lets a user LIMIT win, and always enforces the hard cap', async () => {
    const driver = makeDriver()
    await driver.connect()
    const limited = rows(await driver.execute('SELECT * FROM order_items', opts({ limit: 10 })))
    expect(limited.rows).toHaveLength(10)
    expect(limited).toMatchObject({ truncated: true, limit: 10, autoLimited: true })

    const own = rows(
      await driver.execute('SELECT * FROM order_items LIMIT 25', opts({ limit: 10 }))
    )
    expect(own.rows).toHaveLength(25)
    expect(own).toMatchObject({ truncated: false, limit: null, autoLimited: false })

    const capped = rows(
      await driver.execute('SELECT * FROM order_items', opts({ limit: null, hardCap: 7 }))
    )
    expect(capped.rows).toHaveLength(7)
    expect(capped).toMatchObject({ truncated: true, limit: 7, autoLimited: false })

    const small = rows(await driver.execute('SELECT * FROM users', opts({ limit: 1000 })))
    expect(small.rows).toHaveLength(200)
    expect(small).toMatchObject({ truncated: false, limit: 1000, autoLimited: false })
    expect(small.columns[0]).toMatchObject({ name: 'id', type: 'INTEGER', table: 'users' })
  })

  it('returns exact cells', async () => {
    const driver = makeDriver()
    await driver.connect()
    const r = rows(
      await driver.execute(
        "SELECT 9007199254740993 AS big, 12 AS small, x'0102' AS bin, 0.1 + 0.2 AS f, 'é' AS s",
        opts()
      )
    )
    expect(r.rows[0]).toEqual([
      '9007199254740993',
      12,
      { $t: 'bin', hex: '0102', len: 2 },
      0.30000000000000004,
      'é'
    ])
    expect(JSON.parse(JSON.stringify(r.rows))).toEqual(r.rows)
  })

  it('rejects writes in the read-only sandbox as sandboxRejected', async () => {
    const driver = makeDriver()
    await driver.connect()
    const error = await driver
      .execute('DELETE FROM users', opts({ readOnlySandbox: true }))
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DataDriverError)
    expect(error).toMatchObject({
      sandboxRejected: true,
      code: 'SQLITE_READONLY',
      cancelled: false
    })
    expect(
      rows(await driver.execute('SELECT count(*) AS n FROM users', opts({ readOnlySandbox: true })))
        .rows
    ).toEqual([[200]])
  })

  it('runs writes and reports affected rows; errors carry codes and positions', async () => {
    const driver = makeDriver()
    await driver.connect()
    const insert = await driver.execute(
      "INSERT INTO users (name, email, created_at) VALUES ('A', 'tmp_dpcs_a@example.com', '2026-01-01'), ('B', 'tmp_dpcs_b@example.com', '2026-01-01')",
      opts()
    )
    expect(insert.output).toEqual({
      kind: 'command',
      message: 'INSERT',
      affectedRows: 2,
      lastInsertId: '202'
    })
    expect(typeof insert.stats?.elapsedMs).toBe('number')
    const dup = await driver
      .execute(
        "INSERT INTO users (name, email, created_at) VALUES ('A', 'tmp_dpcs_a@example.com', 'x')",
        opts()
      )
      .catch((e: unknown) => e)
    expect(dup).toMatchObject({ code: 'SQLITE_CONSTRAINT_UNIQUE', sandboxRejected: false })
    const syntax = await driver.execute('SELECT * FRM users', opts()).catch((e: unknown) => e)
    expect(syntax).toMatchObject({ code: 'SQLITE_ERROR', position: 9 })
  })

  it('opens read-only files read-only', async () => {
    const driver = makeDriver({ readOnlyFile: true })
    const info = await driver.connect()
    expect(info.readOnlyUser).toBe(true)
    const error = await driver.execute('DELETE FROM users', opts()).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'SQLITE_READONLY', sandboxRejected: false })
  })

  it('introspects databases, objects, details, DDL and completion data', async () => {
    const driver = makeDriver()
    await driver.connect()
    const dbs = await driver.listDatabases()
    expect(dbs).toHaveLength(1)
    expect(dbs[0]).toMatchObject({ name: 'main' })
    expect(dbs[0].sizeBytes).toBeGreaterThan(100_000)

    const { objects } = await driver.listObjects('main')
    expect(objects.find((o) => o.name === 'order_items')).toMatchObject({
      kind: 'table',
      rowEstimate: 4997
    })
    expect(objects.find((o) => o.name === 'daily_revenue')).toMatchObject({ kind: 'view' })

    const details: DataTableDetails = await driver.describe({ name: 'order_items' })
    expect(details.primaryKey).toEqual(['id'])
    expect(details.foreignKeys.map((f) => f.name)).toEqual(['fk_items_order', 'fk_items_product'])
    expect(details.ref).toEqual({ database: 'main', name: 'order_items', kind: 'table' })

    expect(await driver.ddl({ name: 'products' })).toContain(
      'CREATE INDEX idx_category ON products(category);'
    )

    const completion = await driver.completionSchema()
    expect(completion.database).toBe('main')
    expect(completion.databases).toEqual(['main'])
    expect(completion.tables.map((t) => t.name).sort()).toEqual([
      'daily_revenue',
      'order_items',
      'orders',
      'products',
      'users'
    ])
    expect(completion.functions?.length).toBeGreaterThan(50)
    expect(driver.quoteIdentifier('we"ird')).toBe('"we""ird"')
  })

  it('shows temp objects and attached databases from the session', async () => {
    const driver = makeDriver()
    await driver.connect()
    await driver.execute('CREATE TEMP TABLE tmp_dpcs_scratch (a INTEGER)', opts())
    const other = seedCopy()
    await driver.execute(`ATTACH DATABASE '${other}' AS other`, opts())
    expect((await driver.listDatabases()).map((d) => d.name)).toEqual(['main', 'other', 'temp'])
    expect((await driver.listObjects('temp')).objects.map((o) => o.name)).toEqual([
      'tmp_dpcs_scratch'
    ])
    // The control connection mirrors the session's ATTACH.
    expect((await driver.listObjects('other')).objects.map((o) => o.name)).toContain('users')
    expect((await driver.describe({ database: 'other', name: 'users' })).columns).toHaveLength(6)
    expect((await driver.completionSchema()).databases).toEqual(['main', 'other', 'temp'])
  })

  it('tracks the transaction flag', async () => {
    const driver = makeDriver()
    await driver.connect()
    await driver.execute('BEGIN', opts())
    expect(driver.sessionState().inTransaction).toBe(true)
    await driver.execute('ROLLBACK', opts())
    expect(driver.sessionState().inTransaction).toBe(false)
  })

  it('streams every row on its own connection and stops on abort', async () => {
    const driver = makeDriver()
    await driver.connect()
    const seen: number[] = []
    const res = await driver.streamRows(
      'SELECT * FROM order_items',
      { readOnlySandbox: true, signal: new AbortController().signal },
      async (columns, batch) => {
        expect(columns).toEqual(['id', 'order_id', 'product_id', 'quantity', 'unit_price'])
        seen.push(batch.length)
      }
    )
    expect(res.rows).toBe(4997)
    expect(seen.reduce((a, b) => a + b, 0)).toBe(4997)

    const controller = new AbortController()
    let batches = 0
    const aborted = await driver
      .streamRows(
        'SELECT * FROM order_items',
        { readOnlySandbox: false, signal: controller.signal },
        async () => {
          batches++
          if (batches === 2) controller.abort()
        }
      )
      .catch((e: unknown) => e)
    expect(aborted).toMatchObject({ cancelled: true })
    expect(batches).toBe(2)

    const notRows = await driver
      .streamRows(
        'DELETE FROM users',
        { readOnlySandbox: false, signal: new AbortController().signal },
        async () => undefined
      )
      .catch((e: unknown) => e)
    expect(notRows).toMatchObject({
      message: expect.stringContaining('return rows'),
      sandboxRejected: false
    })
    // A writer that returns rows is refused by the sandbox before anything runs.
    const sandboxed = await driver
      .streamRows(
        'UPDATE users SET name = name RETURNING id',
        { readOnlySandbox: true, signal: new AbortController().signal },
        async () => undefined
      )
      .catch((e: unknown) => e)
    expect(sandboxed).toMatchObject({ sandboxRejected: true })
  })

  it('has no processes when idle and cannot kill unknown ones', async () => {
    const driver = makeDriver()
    await driver.connect()
    expect(await driver.listProcesses()).toEqual([])
    await expect(driver.killProcess('nope', 'query')).rejects.toMatchObject({
      code: 'SQLITE_NO_SUCH_PROCESS'
    })
    await driver.cancelCurrent() // nothing running: a no-op
  })
})

describeSeed('sqlite driver (child process)', () => {
  it('runs statements in a forked worker', async () => {
    const driver = makeDriver({}, childOptions)
    const info = await driver.connect()
    expect(info.serverVersion).toMatch(/^SQLite 3\./)
    const r = rows(
      await driver.execute('SELECT id, name FROM users ORDER BY id', opts({ limit: 2 }))
    )
    expect(r.rows).toEqual([
      [1, 'Shira Levi'],
      [2, 'Omer Mizrahi']
    ])
    expect(r).toMatchObject({ truncated: true, autoLimited: true })
    const rejected = await driver
      .execute('DROP TABLE users', opts({ readOnlySandbox: true }))
      .catch((e: unknown) => e)
    expect(rejected).toMatchObject({ sandboxRejected: true })
    const missing = await driver.execute('SELECT * FROM nope', opts()).catch((e: unknown) => e)
    expect(missing).toBeInstanceOf(DataDriverError)
    expect(missing).toMatchObject({ message: 'no such table: nope', code: 'SQLITE_ERROR' })
  }, 30_000)

  it('cancels a long statement by restarting the worker and reports what was lost', async () => {
    const driver = makeDriver({}, childOptions)
    await driver.connect()
    await driver.execute('CREATE TEMP TABLE tmp_dpcs_t (a)', opts())
    const other = seedCopy()
    // (ATTACH is not allowed inside a transaction.)
    await driver.execute(`ATTACH DATABASE '${other}' AS other`, opts())
    await driver.execute('BEGIN', opts())

    const started = Date.now()
    const pending = driver.execute(LONG_QUERY, opts()).catch((e: unknown) => e)
    await sleep(300)
    // While the session grinds, the process list and the control connection still answer.
    const processes = await driver.listProcesses()
    expect(processes).toHaveLength(1)
    expect(processes[0]).toMatchObject({ isOwn: true, state: 'running', query: LONG_QUERY })
    expect((await driver.describe({ name: 'users' })).columns).toHaveLength(6)

    await driver.cancelCurrent()
    const error = await pending
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(error).toBeInstanceOf(DataDriverError)
    expect(error).toMatchObject({ cancelled: true })
    expect((error as Error).message).toMatch(/transaction was rolled back/)

    // The next statement runs on a fresh worker; the notice says what is gone; ATTACH survived.
    const next = await driver.execute('SELECT count(*) FROM other.users', opts())
    expect(rows(next).rows).toEqual([[200]])
    expect(next.notices?.join('\n')).toMatch(
      /transaction was rolled back and 1 temporary object was dropped/
    )
    expect(driver.sessionState().inTransaction).toBe(false)
    const temp = await driver.execute('SELECT count(*) FROM temp.sqlite_schema', opts())
    expect(rows(temp).rows).toEqual([[0]])
    // Only one notice, once.
    expect((await driver.execute('SELECT 1', opts())).notices).toBeUndefined()
  }, 60_000)

  it('kills a running statement from the process list', async () => {
    const driver = makeDriver({}, childOptions)
    await driver.connect()
    const pending = driver.execute(LONG_QUERY, opts()).catch((e: unknown) => e)
    await sleep(300)
    const [proc] = await driver.listProcesses()
    await driver.killProcess(proc.id, 'connection')
    expect(await pending).toMatchObject({ cancelled: true })
    expect(rows(await driver.execute('SELECT 2', opts())).rows).toEqual([[2]])
  }, 60_000)

  it('stops a statement that runs past its timeout', async () => {
    const driver = makeDriver({}, childOptions)
    await driver.connect()
    const error = await driver
      .execute(LONG_QUERY, opts({ timeoutMs: 400 }))
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'SQLITE_TIMEOUT', cancelled: false })
    expect(rows(await driver.execute('SELECT 3', opts())).rows).toEqual([[3]])
  }, 60_000)

  it('streams in a worker of its own and kills it on abort', async () => {
    const driver = makeDriver({}, childOptions)
    await driver.connect()
    let total = 0
    const res = await driver.streamRows(
      'SELECT * FROM order_items',
      { readOnlySandbox: true, signal: new AbortController().signal },
      async (_columns, batch) => {
        total += batch.length
      }
    )
    expect(res.rows).toBe(4997)
    expect(total).toBe(4997)

    const controller = new AbortController()
    const pending = driver
      .streamRows(
        LONG_QUERY,
        { readOnlySandbox: true, signal: controller.signal },
        async () => undefined
      )
      .catch((e: unknown) => e)
    await sleep(300)
    controller.abort()
    expect(await pending).toMatchObject({ cancelled: true })
    // The session was not involved.
    expect(rows(await driver.execute('SELECT 4', opts())).rows).toEqual([[4]])
  }, 60_000)

  it('restarts after the worker dies unexpectedly', async () => {
    const driver = makeDriver({}, childOptions)
    await driver.connect()
    const [proc] = await (async () => {
      const pending = driver.execute(LONG_QUERY, opts()).catch((e: unknown) => e)
      await sleep(300)
      const list = await driver.listProcesses()
      process.kill(Number(list[0].extra?.pid), 'SIGKILL')
      const error = await pending
      expect(error).toMatchObject({ code: 'SQLITE_WORKER_EXIT', cancelled: false })
      return list
    })()
    expect(proc.extra?.mode).toBe('child')
    expect(rows(await driver.execute('SELECT 5', opts())).rows).toEqual([[5]])
  }, 60_000)

  it('fails cleanly when the worker cannot start', async () => {
    const driver = createSqliteDriver(
      { project: record({ filePath: seedCopy() }), secrets: {}, redact: (t) => t },
      { mode: 'child', workerEntry: join(tmpRoot, 'no-such-entry.cjs'), startTimeoutMs: 10_000 }
    )
    drivers.push(driver)
    const error = await driver.connect().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DataDriverError)
    expect((error as DataDriverError).code).toMatch(/^SQLITE_WORKER_(EXIT|START)$/)
  }, 30_000)
})

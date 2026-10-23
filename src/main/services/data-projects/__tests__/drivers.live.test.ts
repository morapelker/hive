// Live driver tests against the docker containers (design §8). Gated: TEDOOO_DP_IT=1.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DataEngine, DataRowsResult } from '../../../../shared/data-projects/types'
import { quoteSqlLiteral } from '../../../../shared/sql'
import { DataDriverError, type DataDriver, type DriverStatementResult } from '../contracts'
import { createMysqlDriver } from '../drivers/mysql'
import { createPostgresDriver } from '../drivers/postgres'
import { ExportFormatter } from '../export'
import { makeRecord } from './engine-fixtures'

const itLive = process.env.TEDOOO_DP_IT ? it : it.skip
// Real servers with sleeps and cancels, often next to other live suites: allow more than 5 s.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

interface Target {
  engine: DataEngine
  port: number
  user: string
  password: string
  database: string
  sleep: (s: number) => string
}

const TARGETS: Target[] = [
  {
    engine: 'mysql',
    port: 13306,
    user: 'root',
    password: 'rootpw',
    database: 'shop',
    sleep: (s) => `SELECT SLEEP(${s})`
  },
  {
    engine: 'mariadb',
    port: 13307,
    user: 'root',
    password: 'rootpw',
    database: 'shop',
    sleep: (s) => `SELECT SLEEP(${s})`
  },
  {
    engine: 'postgres',
    port: 15432,
    user: 'postgres',
    password: 'pgpw',
    database: 'shop',
    sleep: (s) => `SELECT pg_sleep(${s})`
  }
]

const make = (t: Target): DataDriver => {
  const input = {
    project: makeRecord({
      id: `live-${t.engine}`,
      engine: t.engine,
      config: { host: '127.0.0.1', port: t.port, user: t.user, database: t.database }
    }),
    secrets: { password: t.password },
    redact: (text: string) => text.split(t.password).join('***')
  }
  return t.engine === 'postgres' ? createPostgresDriver(input) : createMysqlDriver(input)
}

const base = { limit: null, hardCap: 100_000, readOnlySandbox: false }

const rowsOf = (r: DriverStatementResult): DataRowsResult => {
  if (r.output.kind !== 'rows') throw new Error(`rows expected, got ${r.output.kind}`)
  return r.output
}

const firstCell = async (d: DataDriver, sql: string, options = {}): Promise<unknown> =>
  rowsOf(await d.execute(sql, { ...base, ...options })).rows[0]?.[0]

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Every row an export of `sql` writes. */
const exportRows = async (d: DataDriver, sql: string): Promise<unknown[][]> => {
  const out: unknown[][] = []
  await d.streamRows(
    sql,
    { readOnlySandbox: true, signal: new AbortController().signal },
    async (_columns, rows) => {
      out.push(...rows)
    }
  )
  return out
}

/**
 * Records the server-side id (PG pid / MySQL thread id) of every connection the driver opens
 * from now on, through its private open method; `opening` resolves when the first open starts.
 */
const recordOpened = (
  d: DataDriver,
  engine: DataEngine
): { ids: number[]; opening: Promise<void> } => {
  const ids: number[] = []
  let started: () => void = () => undefined
  const opening = new Promise<void>((resolve) => {
    started = resolve
  })
  const method = engine === 'postgres' ? 'openClient' : 'openConnection'
  const internals = d as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
  const open = internals[method].bind(d)
  internals[method] = async (...args: unknown[]) => {
    started()
    const conn = (await open(...args)) as { processID?: number; threadId?: number | null }
    ids.push(Number(conn.processID ?? conn.threadId ?? 0))
    return conn
  }
  return { ids, opening }
}

/** close() while the control connection is still opening must not leak that connection. */
const expectNoLeakOnClose = async (target: Target): Promise<void> => {
  const d = make(target)
  await d.connect()
  const { ids, opening } = recordOpened(d, target.engine)
  const pending = d.listDatabases().then(
    () => null,
    (e: unknown) => e
  )
  await opening
  await d.close()
  expect(await pending).toMatchObject({ code: 'CONNECTION_LOST' })
  expect(ids).toHaveLength(1)
  await sleep(300)
  await withDriver(target, {}, async (checker) => {
    await checker.connect()
    const live = (await checker.listProcesses()).map((p) => p.id)
    expect(live).not.toContain(String(ids[0]))
  })
  // A closed driver does not open another one either.
  await expect(d.listDatabases()).rejects.toMatchObject({ code: 'CONNECTION_LOST' })
  expect(ids).toHaveLength(1)
}

for (const target of TARGETS) {
  describe(`${target.engine} driver (live)`, () => {
    let driver: DataDriver
    beforeAll(async () => {
      if (!process.env.TEDOOO_DP_IT) return
      driver = make(target)
      await driver.connect()
    })
    afterAll(async () => {
      await driver?.close()
    })

    itLive('connects and reports the server version and database', async () => {
      expect(driver.isConnected()).toBe(true)
      expect(driver.sessionState().currentDatabase).toBe('shop')
    })

    itLive('selects with auto-limit truncation and exact cells', async () => {
      const r = await driver.execute(
        'SELECT id, name, created_at, is_banned FROM users ORDER BY id',
        {
          ...base,
          limit: 5
        }
      )
      expect(r.output.kind).toBe('rows')
      if (r.output.kind !== 'rows') return
      expect(r.output.rows).toHaveLength(5)
      expect(r.output.truncated).toBe(true)
      expect(r.output.autoLimited).toBe(true)
      expect(r.output.limit).toBe(5)
      expect(r.output.columns.map((c) => c.name)).toEqual(['id', 'name', 'created_at', 'is_banned'])
      expect(r.output.rows[0][1]).toBe('Shira Levi')
      expect(typeof r.output.rows[0][2]).toBe('string')
      expect(JSON.stringify(r.output)).toBeTruthy()
    })

    itLive('lets a LIMIT the user wrote win over a smaller auto-limit', async () => {
      const r = await driver.execute('SELECT id FROM order_items ORDER BY id LIMIT 1500', {
        ...base,
        limit: 1000
      })
      expect(r.output.kind).toBe('rows')
      if (r.output.kind !== 'rows') return
      expect(r.output.rows).toHaveLength(1500)
      expect(r.output.truncated).toBe(false)
      expect(r.output.autoLimited).toBeFalsy()
    })

    itLive('reports an error position inside the statement', async () => {
      const err = await driver
        .execute('SELECT id,\n  FROM users WHERE', base)
        .then(() => null)
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(DataDriverError)
      expect((err as DataDriverError).position).toBeTypeOf('number')
    })

    itLive('rejects a write inside the read-only sandbox', async () => {
      const err = await driver
        .execute('UPDATE users SET name = name WHERE id = 1', { ...base, readOnlySandbox: true })
        .then(() => null)
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(DataDriverError)
      expect((err as DataDriverError).sandboxRejected).toBe(true)
      expect(driver.sessionState().inTransaction).toBe(false)
    })

    itLive('cancels a running sleep', async () => {
      const started = Date.now()
      const run = driver.execute(target.sleep(5), base).then(
        () => null,
        (e: unknown) => e
      )
      await new Promise((r) => setTimeout(r, 400))
      await driver.cancelCurrent()
      const err = await run
      expect(err).toBeInstanceOf(DataDriverError)
      expect((err as DataDriverError).cancelled).toBe(true)
      expect(Date.now() - started).toBeLessThan(4000)
      // The session is still usable.
      const r = await driver.execute('SELECT 1 AS one', base)
      expect(r.output.kind === 'rows' && r.output.rows[0][0]).toBeTruthy()
    })

    itLive('lists processes including its own session', async () => {
      const list = await driver.listProcesses()
      expect(list.some((p) => p.isOwn)).toBe(true)
    })

    itLive('introspects databases, objects, describe, ddl and completion', async () => {
      const dbs = await driver.listDatabases()
      expect(dbs.map((d) => d.name)).toContain('shop')
      const listing = await driver.listObjects(
        'shop',
        target.engine === 'postgres' ? undefined : undefined
      )
      expect(listing.objects.some((o) => o.name === 'orders' && o.kind === 'table')).toBe(true)
      const details = await driver.describe({ database: 'shop', schema: 'public', name: 'orders' })
      expect(details.primaryKey).toEqual(['id'])
      expect(details.columns.map((c) => c.name)).toContain('user_id')
      expect(details.foreignKeys.length).toBeGreaterThan(0)
      expect(details.indexes.length).toBeGreaterThan(0)
      const ddl = await driver.ddl({
        database: 'shop',
        schema: 'public',
        name: 'orders',
        kind: 'table'
      })
      expect(ddl).toMatch(/CREATE TABLE/i)
      const completion = await driver.completionSchema('shop')
      expect(completion.tables.find((t) => t.name === 'users')?.columns.length).toBeGreaterThan(3)
    })

    itLive('streams every row on a side connection', async () => {
      const seen: unknown[][] = []
      let columns: string[] = []
      const res = await driver.streamRows(
        'SELECT id, email FROM users ORDER BY id',
        { readOnlySandbox: true, signal: new AbortController().signal },
        async (cols, rows) => {
          columns = cols
          seen.push(...rows)
        }
      )
      expect(columns).toEqual(['id', 'email'])
      expect(res.rows).toBe(seen.length)
      expect(seen.length).toBeGreaterThan(100)
    })
  })
}

// ---------------------------------------------------------------------------------------------
// Engine-specific behaviour
// ---------------------------------------------------------------------------------------------

const withDriver = async <T>(
  t: Target,
  extra: {
    ssl?: { mode: 'disable' | 'prefer' | 'require' | 'verify-ca' | 'verify-full' }
    queryTimeoutMs?: number
    timezone?: string
  },
  fn: (d: DataDriver) => Promise<T>
): Promise<T> => {
  const input = {
    project: makeRecord({
      id: `live-extra-${t.engine}`,
      engine: t.engine,
      config: { host: '127.0.0.1', port: t.port, user: t.user, database: t.database, ...extra }
    }),
    secrets: { password: t.password },
    redact: (text: string) => text
  }
  const d = t.engine === 'postgres' ? createPostgresDriver(input) : createMysqlDriver(input)
  try {
    return await fn(d)
  } finally {
    await d.close()
  }
}

for (const target of TARGETS.filter((t) => t.engine !== 'postgres')) {
  describe(`${target.engine} specifics (live)`, () => {
    itLive('connects with sslmode require (encrypted, unverified)', async () => {
      await withDriver(target, { ssl: { mode: 'require' } }, async (d) => {
        await d.connect()
        const r = await d.execute("SHOW SESSION STATUS LIKE 'Ssl_cipher'", base)
        expect(r.output.kind === 'rows' && String(r.output.rows[0]?.[1] ?? '')).not.toBe('')
      })
    })

    itLive('returns every result set of a CALL', async () => {
      await withDriver(target, {}, async (d) => {
        await d.connect()
        await d.execute('DROP PROCEDURE IF EXISTS tmp_engine_core_two', base)
        await d.execute(
          'CREATE PROCEDURE tmp_engine_core_two() BEGIN SELECT 1 AS a; SELECT 2 AS b, 3 AS c; END',
          base
        )
        try {
          const r = await d.execute('CALL tmp_engine_core_two()', base)
          expect(r.output.kind === 'rows' && r.output.columns.map((c) => c.name)).toEqual(['a'])
          // Integer literals are BIGINT on MySQL (exact strings), INT on MariaDB (numbers).
          expect(r.moreOutputs?.map((o) => o.kind === 'rows' && o.rows[0].map(String))).toEqual([
            ['2', '3']
          ])
        } finally {
          await d.execute('DROP PROCEDURE IF EXISTS tmp_engine_core_two', base)
        }
      })
    })

    itLive('kills another connection by id and tracks transactions', async () => {
      await withDriver(target, {}, async (victim) => {
        await victim.connect()
        const r = await victim.execute('SELECT CONNECTION_ID() AS id', base)
        const victimId = r.output.kind === 'rows' ? String(r.output.rows[0][0]) : ''
        await victim.execute('START TRANSACTION', base)
        expect(victim.sessionState().inTransaction).toBe(true)
        await victim.execute('ROLLBACK', base)
        expect(victim.sessionState().inTransaction).toBe(false)
        await withDriver(target, {}, async (killer) => {
          await killer.connect()
          const list = await killer.listProcesses()
          expect(list.some((p) => p.id === victimId && !p.isOwn)).toBe(true)
          await killer.killProcess(victimId, 'connection')
        })
        await new Promise((res) => setTimeout(res, 200))
        const err = await victim.execute('SELECT 1', base).catch((e: unknown) => e)
        expect(err === null || err instanceof DataDriverError).toBe(true)
        expect(victim.isConnected()).toBe(false)
      })
    })

    itLive('maps binary, BIT, JSON and DECIMAL exactly', async () => {
      await withDriver(target, {}, async (d) => {
        await d.connect()
        await d.execute(
          'CREATE TEMPORARY TABLE tmp_engine_core_bits (b BIT(3), small TINYINT, txt TEXT)',
          base
        )
        await d.execute("INSERT INTO tmp_engine_core_bits VALUES (b'101', 7, 'héllo')", base)
        const bitRow = await d.execute('SELECT b, small, txt FROM tmp_engine_core_bits', base)
        // BIT up to 53 bits is a number: edits and SQL exports write it unquoted.
        expect(bitRow.output.kind === 'rows' && bitRow.output.rows[0]).toEqual([5, 7, 'héllo'])
        expect(bitRow.output.kind === 'rows' && bitRow.output.columns.map((c) => c.table)).toEqual([
          'tmp_engine_core_bits',
          'tmp_engine_core_bits',
          'tmp_engine_core_bits'
        ])
        const r = await d.execute(
          "SELECT X'DEADBEEF' AS bin, b'101' AS bits, CAST(12345678901234567890.123 AS DECIMAL(30,3)) AS dec_v, CAST(9223372036854775807 AS SIGNED) AS big, JSON_OBJECT('a', 1) AS j",
          base
        )
        if (r.output.kind !== 'rows') throw new Error('rows expected')
        const [bin, bits, dec, big, j] = r.output.rows[0]
        expect(bin).toEqual({ $t: 'bin', hex: 'deadbeef', len: 4 })
        // b'101' is a binary-string literal, not a BIT column.
        expect(bits).toEqual({ $t: 'bin', hex: '05', len: 1 })
        expect(dec).toBe('12345678901234567890.123')
        expect(big).toBe('9223372036854775807')
        expect(JSON.parse(String(j))).toEqual({ a: 1 })
      })
    })
  })
}

for (const target of TARGETS.filter((t) => t.engine !== 'postgres')) {
  describe(`${target.engine} session fidelity (live)`, () => {
    itLive('keeps BIT values numeric so an edit writes the bits, not a quoted string', async () => {
      await withDriver(target, {}, async (d) => {
        await d.connect()
        // A real table: the export runs on a connection of its own.
        await d.execute('DROP TABLE IF EXISTS tmp_fix_b1_bits', base)
        await d.execute(
          'CREATE TABLE tmp_fix_b1_bits (id INT PRIMARY KEY, flag BIT(1), b8 BIT(8), wide BIT(64))',
          base
        )
        try {
          await d.execute(
            "INSERT INTO tmp_fix_b1_bits VALUES (1, b'1', 5, b'1111111111111111111111111111111111111111111111111111111111111111')",
            base
          )
          const r = rowsOf(await d.execute('SELECT flag, b8, wide FROM tmp_fix_b1_bits', base))
          expect(r.rows[0]).toEqual([1, 5, '18446744073709551615'])
          // What the grid's save builds from a number cell (table-ops → quoteSqlLiteral).
          const lit = (v: number): string => quoteSqlLiteral(v, target.engine as 'mysql')
          await d.execute(
            `UPDATE tmp_fix_b1_bits SET b8 = ${lit(6)}, flag = ${lit(0)} WHERE id = 1`,
            base
          )
          expect(
            rowsOf(
              await d.execute('SELECT b8 + 0, flag + 0 FROM tmp_fix_b1_bits', base)
            ).rows[0].map(String)
          ).toEqual(['6', '0'])
          // An SQL export writes the same numbers.
          expect((await exportRows(d, 'SELECT flag, b8 FROM tmp_fix_b1_bits'))[0]).toEqual([0, 6])
        } finally {
          await d.execute('DROP TABLE IF EXISTS tmp_fix_b1_bits', base)
        }
      })
    })

    itLive('reports the warnings of a SELECT, also inside the read-only sandbox', async () => {
      await withDriver(target, {}, async (d) => {
        await d.connect()
        for (const readOnlySandbox of [false, true]) {
          const r = await d.execute("SELECT CAST('12abc' AS SIGNED) AS n", {
            ...base,
            readOnlySandbox
          })
          expect(rowsOf(r).rows[0].map(String)).toEqual(['12'])
          expect(r.notices?.some((n) => /^Warning 1292: /.test(n))).toBe(true)
        }
        const clean = await d.execute('SELECT 1 AS one', base)
        expect(clean.notices).toBeUndefined()
        // SHOW WARNINGS itself: its rows are the warnings, not repeated as notices.
        await d.execute("SELECT CAST('12abc' AS SIGNED) AS n", base)
        const shown = await d.execute('SHOW WARNINGS', base)
        expect(rowsOf(shown).rows.length).toBeGreaterThan(0)
        expect(shown.notices).toBeUndefined()
        // Statements without rows keep reporting theirs.
        const ok = await d.execute("DO CAST('12abc' AS SIGNED)", base)
        expect(ok.notices?.some((n) => /1292/.test(n))).toBe(true)
      })
    })

    itLive('tracks NO_BACKSLASH_ESCAPES and reads exports like the session', async () => {
      await withDriver(target, {}, async (d) => {
        await d.connect()
        expect(d.sessionState().backslashEscapes).toBe(true)
        await d.execute("SET SESSION sql_mode = CONCAT(@@sql_mode, ',NO_BACKSLASH_ESCAPES')", base)
        expect(d.sessionState().backslashEscapes).toBe(false)
        // Under that mode 'C:\temp' is 7 characters; an export must read the text the same way.
        const sql = "SELECT 'C:\\temp' AS v"
        expect(await firstCell(d, sql)).toBe('C:\\temp')
        expect((await exportRows(d, sql))[0]).toEqual(['C:\\temp'])
        await d.execute(
          "SET SESSION sql_mode = REPLACE(@@sql_mode, 'NO_BACKSLASH_ESCAPES', '')",
          base
        )
        expect(d.sessionState().backslashEscapes).toBe(true)
        expect(await firstCell(d, sql)).toBe('C:\temp')
      })
    })

    itLive('exports TIMESTAMP values in the project time zone, like the grid', async () => {
      await withDriver(target, { timezone: '+09:00' }, async (d) => {
        await d.connect()
        const sql = 'SELECT FROM_UNIXTIME(0) AS t'
        expect(await firstCell(d, sql)).toBe('1970-01-01 09:00:00')
        expect((await exportRows(d, sql))[0]).toEqual(['1970-01-01 09:00:00'])
      })
    })

    itLive(
      'runs each request in its database after a USE (the USE sticks within a request)',
      async () => {
        await withDriver(target, {}, async (d) => {
          await d.connect()
          await d.execute('CREATE DATABASE IF NOT EXISTS tmp_fix_b1_db', base)
          try {
            await d.execute('USE tmp_fix_b1_db', { ...base, database: 'shop' })
            expect(d.sessionState().currentDatabase).toBe('tmp_fix_b1_db')
            // The query runner passes the session's database to the statements after a USE.
            const inRequest = { database: d.sessionState().currentDatabase }
            expect(await firstCell(d, 'SELECT DATABASE()', inRequest)).toBe('tmp_fix_b1_db')
            // A new request for the tab's database goes back there.
            expect(await firstCell(d, 'SELECT DATABASE()', { database: 'shop' })).toBe('shop')
          } finally {
            await d.execute('DROP DATABASE IF EXISTS tmp_fix_b1_db', base)
          }
        })
      }
    )

    itLive(
      'cuts a result at the byte budget and says so',
      async () => {
        await withDriver(target, {}, async (d) => {
          await d.connect()
          const r = await d.execute(
            "SELECT id, REPEAT('x', 1000000) AS v FROM order_items ORDER BY id LIMIT 120",
            { ...base, limit: 1000 }
          )
          const out = rowsOf(r)
          expect(out.rows.length).toBeGreaterThan(50)
          expect(out.rows.length).toBeLessThan(120)
          expect(out).toMatchObject({ truncated: true, autoLimited: false, limit: out.rows.length })
          expect(r.notices).toEqual([
            `Showing the first ${out.rows.length} rows: the full result is too large to display.`
          ])
        })
      },
      30_000
    )

    itLive('a LIMIT that does not bound the outer query cannot hide a cut', async () => {
      // When the user's LIMIT wins (hasUserLimit), sql_select_limit must yield too: otherwise
      // the server cuts a result that LIMIT does not bound at auto-limit + 1 rows that read as
      // complete. Whichever limit applies, a cut result must say it was cut.
      await withDriver(target, {}, async (d) => {
        await d.connect()
        const total = Number(await firstCell(d, 'SELECT COUNT(*) FROM order_items'))
        expect(total).toBeGreaterThan(20)
        const complete = (r: DataRowsResult, rows: number): void => {
          if (r.truncated) {
            // The auto-limit applied (and says so).
            expect(r).toMatchObject({ autoLimited: true, limit: 10 })
            expect(r.rows).toHaveLength(10)
          } else {
            expect(r.rows).toHaveLength(rows)
          }
        }
        const union =
          '(SELECT id FROM order_items ORDER BY id LIMIT 3) UNION ALL (SELECT id FROM order_items)'
        complete(rowsOf(await d.execute(union, { ...base, limit: 10 })), total + 3)
        // A cap (here the hard cap, or the auto-limit) always reports its cut.
        const capped = rowsOf(await d.execute(union, { ...base, limit: 10, hardCap: 15 }))
        expect(capped.truncated).toBe(true)
        expect(capped.rows).toHaveLength(capped.limit ?? -1)
        // Without a LIMIT of its own, the auto-limit still cuts and says so.
        const auto = rowsOf(await d.execute('SELECT id FROM order_items', { ...base, limit: 10 }))
        expect(auto).toMatchObject({ truncated: true, autoLimited: true, limit: 10 })
        if (target.engine === 'mariadb') {
          const examined = await d.execute(
            'SELECT id FROM order_items LIMIT ROWS EXAMINED 1000000',
            { ...base, limit: 10 }
          )
          complete(rowsOf(examined), total)
        }
      })
    })

    itLive(
      'the read sandbox keeps the session’s LOCK TABLES locks (and still refuses writes)',
      async () => {
        await withDriver(target, {}, async (d) => {
          await withDriver(target, {}, async (other) => {
            await d.connect()
            await other.connect()
            await d.execute('DROP TABLE IF EXISTS tmp_fix2_lock', base)
            await d.execute('CREATE TABLE tmp_fix2_lock (id INT PRIMARY KEY, v INT)', base)
            const locked = (): boolean | undefined =>
              (d.sessionState() as { tablesLocked?: boolean }).tablesLocked
            /** Another session's write: '1205' while the lock holds. */
            const otherWrite = async (): Promise<string | undefined> => {
              const err = await other
                .execute('UPDATE tmp_fix2_lock SET v = v + 10 WHERE id = 1', base)
                .then(
                  () => null,
                  (e: unknown) => e as DataDriverError
                )
              return err?.code
            }
            const sandboxed = { ...base, readOnlySandbox: true }
            try {
              await d.execute('INSERT INTO tmp_fix2_lock VALUES (1, 1)', base)
              await other.execute('SET SESSION lock_wait_timeout = 1', base)
              await d.execute('/* keep it */ LOCK TABLES tmp_fix2_lock WRITE', base)
              expect(locked()).toBe(true)
              // An auto-run read (table page, sandboxed editor read) must not release the lock.
              expect(
                rowsOf(await d.execute('SELECT v FROM tmp_fix2_lock', sandboxed)).rows
              ).toEqual([[1]])
              expect(await otherWrite()).toBe('1205')
              // The sandbox still refuses a write that slipped past the classifier.
              const refused = await d
                .execute('UPDATE tmp_fix2_lock SET v = 2 WHERE id = 1', sandboxed)
                .then(
                  () => null,
                  (e: unknown) => e as DataDriverError
                )
              expect(refused?.sandboxRejected).toBe(true)
              // autocommit off: the read's read-only transaction is rolled back, locks kept.
              await d.execute('SET autocommit = 0', base)
              rowsOf(await d.execute('SELECT v FROM tmp_fix2_lock', sandboxed))
              expect(d.sessionState().inTransaction).toBe(false)
              expect(await otherWrite()).toBe('1205')
              await d.execute('SET autocommit = 1', base)
              // The session is writable again: the read-only flag was restored.
              await d.execute('UPDATE tmp_fix2_lock SET v = 5 WHERE id = 1', base)
              await d.execute('UNLOCK TABLES', base)
              expect(locked()).toBe(false)
              expect(await otherWrite()).toBeUndefined()
              expect(await firstCell(d, 'SELECT v FROM tmp_fix2_lock', sandboxed)).toBe(15)
              // START TRANSACTION releases table locks: the flag follows.
              await d.execute('LOCK TABLES tmp_fix2_lock READ', base)
              expect(locked()).toBe(true)
              await d.execute('START TRANSACTION', base)
              expect(locked()).toBe(false)
              await d.execute('ROLLBACK', base)
            } finally {
              await d.execute('UNLOCK TABLES', base).catch(() => undefined)
              await d.execute('SET autocommit = 1', base).catch(() => undefined)
              await d.execute('DROP TABLE IF EXISTS tmp_fix2_lock', base)
            }
          })
        })
      },
      30_000
    )

    itLive('an SQL export of BIT(54..64) values re-imports the same bits', async () => {
      await withDriver(target, {}, async (d) => {
        await d.connect()
        const create = (name: string): string =>
          `CREATE TABLE ${name} (id INT PRIMARY KEY, b64 BIT(64), b54 BIT(54), b8 BIT(8))`
        await d.execute('DROP TABLE IF EXISTS tmp_fix2_bits', base)
        await d.execute('DROP TABLE IF EXISTS tmp_fix2_bits_copy', base)
        await d.execute(create('tmp_fix2_bits'), base)
        await d.execute(create('tmp_fix2_bits_copy'), base)
        try {
          await d.execute(
            'INSERT INTO tmp_fix2_bits VALUES (1, 5, 3, 5), (2, 1, 0, 1), (3, 99, 12, 255), ' +
              '(4, 18446744073709551615, 18014398509481983, 0), (5, NULL, NULL, NULL)',
            base
          )
          const formatter = new ExportFormatter('sql', {
            delimiter: ',',
            header: true,
            dialect: target.engine as 'mysql' | 'mariadb',
            table: 'tmp_fix2_bits_copy'
          })
          let sql = ''
          let columns: string[] = []
          const stream = d.streamRows as (
            statement: string,
            options: { readOnlySandbox: boolean; signal: AbortSignal },
            onBatch: (c: string[], r: unknown[][], types?: string[]) => Promise<void>
          ) => Promise<{ rows: number }>
          await stream.call(
            d,
            'SELECT id, b64, b54, b8 FROM tmp_fix2_bits ORDER BY id',
            { readOnlySandbox: true, signal: new AbortController().signal },
            async (c, rows, types) => {
              expect(types).toEqual(['INT', 'BIT', 'BIT', 'BIT'])
              columns = c
              sql += formatter.batch(c, rows, types)
            }
          )
          sql += formatter.end(columns)
          expect(sql).toContain('(1, 5, 3, 5)')
          expect(sql).toContain('(4, 18446744073709551615, 18014398509481983, 0)')
          const insert = sql.slice(sql.indexOf('INSERT INTO')).trim().replace(/;$/, '')
          await d.execute(insert, base)
          const read = async (table: string): Promise<unknown[][]> =>
            rowsOf(
              await d.execute(
                `SELECT id, CAST(b64 AS UNSIGNED), CAST(b54 AS UNSIGNED), CAST(b8 AS UNSIGNED) FROM ${table} ORDER BY id`,
                base
              )
            ).rows.map((row) => row.map((cell) => (cell === null ? null : String(cell))))
          expect(await read('tmp_fix2_bits_copy')).toEqual(await read('tmp_fix2_bits'))
          expect((await read('tmp_fix2_bits_copy'))[3]).toEqual([
            '4',
            '18446744073709551615',
            '18014398509481983',
            '0'
          ])
        } finally {
          await d.execute('DROP TABLE IF EXISTS tmp_fix2_bits', base)
          await d.execute('DROP TABLE IF EXISTS tmp_fix2_bits_copy', base)
        }
      })
    })

    itLive('ends a control connection that finishes opening after close()', async () => {
      await expectNoLeakOnClose(target)
    })
  })
}

const PG = TARGETS.find((t) => t.engine === 'postgres')!

describe('postgres specifics (live)', () => {
  itLive(
    'a cancel that reaches the backend between two cursor reads still stops the statement',
    async () => {
      // Between reads the portal is suspended and the backend (idle in ClientRead) drops a
      // cancel. Fired from the first read's callback, the cancel lands exactly there.
      type ReadFn = (rows: number, cb: (...args: unknown[]) => void) => unknown
      const mod = (await import('pg-cursor')) as unknown
      const Cursor = (typeof mod === 'function' ? mod : (mod as { default: unknown }).default) as {
        prototype: { read: ReadFn }
      }
      const original = Cursor.prototype.read
      for (const readOnlySandbox of [true, false]) {
        await withDriver(PG, {}, async (d) => {
          await d.connect()
          let armed = true
          Cursor.prototype.read = function (this: unknown, rows, cb) {
            return original.call(this, rows, (...args: unknown[]) => {
              if (armed) {
                armed = false
                void d.cancelCurrent()
              }
              cb(...args)
            })
          }
          const started = Date.now()
          let err: unknown
          try {
            // ~3 s if it ran to the end: 100 rows in the first read, the rest in the second.
            err = await d
              .execute('SELECT g, pg_sleep(0.003) FROM generate_series(1, 1000) g', {
                ...base,
                limit: 2000,
                readOnlySandbox
              })
              .then(
                () => null,
                (e: unknown) => e
              )
          } finally {
            Cursor.prototype.read = original
          }
          expect(armed, 'the cancel fired').toBe(false)
          expect(err, `sandbox ${readOnlySandbox}`).toBeInstanceOf(DataDriverError)
          expect((err as DataDriverError).cancelled).toBe(true)
          expect(Date.now() - started).toBeLessThan(2_000)
          // The session is idle and usable, outside any transaction.
          expect(await firstCell(d, 'SELECT 1')).toBeTruthy()
          expect(d.sessionState().inTransaction).toBe(false)
        })
      }
    },
    20_000
  )

  itLive(
    'sslmode prefer falls back to plain TCP; require fails clearly when the server has no TLS',
    async () => {
      await withDriver(PG, { ssl: { mode: 'prefer' } }, async (d) => {
        await expect(d.connect()).resolves.toMatchObject({ currentDatabase: 'shop' })
      })
      await withDriver(PG, { ssl: { mode: 'require' } }, async (d) => {
        await expect(d.connect()).rejects.toThrow(/SSL/)
      })
    }
  )

  itLive(
    'collects notices, tracks the transaction status and rewrites simple SELECTs for the planner',
    async () => {
      await withDriver(PG, {}, async (d) => {
        await d.connect()
        const n = await d.execute("DO $$ BEGIN RAISE NOTICE 'hello %', 42; END $$", base)
        expect(n.notices).toEqual(['NOTICE: hello 42'])
        await d.execute('BEGIN', base)
        expect(d.sessionState().inTransaction).toBe(true)
        await d.execute('SELECT 1/0', base).catch(() => undefined)
        expect(d.sessionState().inTransaction).toBe(true)
        await d.execute('ROLLBACK', base)
        expect(d.sessionState().inTransaction).toBe(false)
        const limited = await d.execute('SELECT id FROM users ORDER BY id', { ...base, limit: 3 })
        expect(limited.executedText).toMatch(/LIMIT 4$/)
        expect(limited.output.kind === 'rows' && limited.output.rows).toEqual([[1], [2], [3]])
      })
    }
  )

  itLive('maps bytea, booleans, int8, numeric and json exactly', async () => {
    await withDriver(PG, {}, async (d) => {
      await d.connect()
      const r = await d.execute(
        "SELECT '\\xdeadbeef'::bytea AS b, true AS t, 9223372036854775807::int8 AS big, 1.10::numeric(5,2) AS n, '{\"a\": 1}'::jsonb AS j, ARRAY[1,2] AS arr",
        base
      )
      if (r.output.kind !== 'rows') throw new Error('rows expected')
      expect(r.output.rows[0]).toEqual([
        { $t: 'bin', hex: 'deadbeef', len: 4 },
        true,
        '9223372036854775807',
        '1.10',
        '{"a": 1}',
        '{1,2}'
      ])
      expect(r.output.columns.map((c) => c.type)).toEqual([
        'bytea',
        'boolean',
        'bigint',
        'numeric',
        'jsonb',
        'integer[]'
      ])
    })
  })

  itLive('applies the statement timeout (an error, not a user cancel)', async () => {
    await withDriver(PG, {}, async (d) => {
      await d.connect()
      const err = await d
        .execute('SELECT pg_sleep(2)', { ...base, timeoutMs: 200 })
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(DataDriverError)
      expect((err as DataDriverError).code).toBe('57014')
      expect((err as DataDriverError).cancelled).toBe(false)
      const ok = await d.execute('SELECT 1', base)
      expect(ok.output.kind).toBe('rows')
    })
  })

  itLive('builds DDL for views and describes schemas', async () => {
    await withDriver(PG, {}, async (d) => {
      await d.connect()
      const view = await d.ddl({ schema: 'analytics', name: 'daily_revenue', kind: 'view' })
      expect(view).toMatch(/^CREATE OR REPLACE VIEW analytics\.daily_revenue AS/)
      const listing = await d.listObjects('shop')
      expect(listing.schemas).toEqual(expect.arrayContaining(['public', 'analytics']))
      expect(listing.objects.some((o) => o.schema === 'analytics' && o.kind === 'view')).toBe(true)
      expect(listing.objects.some((o) => o.kind === 'type' && o.name === 'order_status')).toBe(true)
      const enumDdl = await d.ddl({ schema: 'public', name: 'order_status', kind: 'type' })
      expect(enumDdl).toMatch(/CREATE TYPE public\.order_status AS ENUM/)
      const table = await d.ddl({ schema: 'public', name: 'orders', kind: 'table' })
      expect(table).toMatch(/^CREATE TABLE public\.orders \(/)
      expect(table).toMatch(/CONSTRAINT orders_pkey PRIMARY KEY \(id\)/)
      expect(table).toMatch(/CREATE INDEX idx_orders_created ON public\.orders/)
    })
  })

  itLive('refuses COPY … STDIN without breaking the session', async () => {
    await withDriver(PG, {}, async (d) => {
      await d.connect()
      await expect(d.execute('COPY users FROM STDIN', base)).rejects.toThrow(/COPY/)
      const ok = await d.execute('SELECT 1', base)
      expect(ok.output.kind).toBe('rows')
    })
  })
})

describe('postgres transaction safety (live)', () => {
  itLive('a failing app-run read inside an open transaction does not abort it', async () => {
    await withDriver(PG, {}, async (d) => {
      await d.connect()
      await d.execute('BEGIN', base)
      await d.execute('CREATE TEMP TABLE tmp_engine_core_tx (v int)', base)
      const err = await d
        .execute('SELECT pg_sleep(1)', { ...base, readOnlySandbox: true, timeoutMs: 100 })
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(DataDriverError)
      // Still a healthy transaction ('T', not 'E'): the next statement works.
      await d.execute('INSERT INTO tmp_engine_core_tx VALUES (1)', base)
      const r = await d.execute('SELECT COUNT(*) FROM tmp_engine_core_tx', base)
      expect(r.output.kind === 'rows' && r.output.rows[0][0]).toBe('1')
      expect(d.sessionState().inTransaction).toBe(true)
      await d.execute('ROLLBACK', base)
      expect(d.sessionState().inTransaction).toBe(false)
    })
  })
})

describe('postgres control client and session fidelity (live)', () => {
  itLive(
    "a lock held by the session's own transaction does not stall the tree, describe, results or COMMIT",
    async () => {
      await withDriver(PG, {}, async (d) => {
        await d.connect()
        await d.execute(
          'CREATE TABLE IF NOT EXISTS tmp_fix_b1_lock (id int PRIMARY KEY, v text GENERATED ALWAYS AS (id::text) STORED, w text DEFAULT $$x$$)',
          base
        )
        try {
          await d.execute('BEGIN', base)
          await d.execute('LOCK TABLE tmp_fix_b1_lock IN ACCESS EXCLUSIVE MODE', base)
          const started = Date.now()
          // The tree refresh and a describe run on the control client while the lock is held…
          const listing = d.listObjects('shop', 'public')
          const details = d.describe({ schema: 'public', name: 'tmp_fix_b1_lock' })
          // …and a result on a relation not seen before needs that client for its metadata.
          const result = await d.execute('SELECT * FROM orders ORDER BY id LIMIT 1', base)
          expect(rowsOf(result).rows).toHaveLength(1)
          expect(rowsOf(result).columns[0].name).toBe('id')
          const locked = (await listing).objects.find((o) => o.name === 'tmp_fix_b1_lock')
          expect(locked).toMatchObject({ kind: 'table', sizeBytes: null })
          expect(
            (await listing).objects.find((o) => o.name === 'orders')?.sizeBytes
          ).toBeGreaterThan(0)
          const described = await details
          expect(described.columns.map((c) => [c.name, c.defaultValue])).toEqual([
            ['id', null],
            ['v', null],
            ['w', "'x'::text"]
          ])
          expect(described.columns[1].extra).toMatch(/GENERATED ALWAYS AS/)
          expect(described.indexes).toEqual([
            expect.objectContaining({
              name: 'tmp_fix_b1_lock_pkey',
              columns: ['id'],
              primary: true
            })
          ])
          await expect(
            d.ddl({ schema: 'public', name: 'tmp_fix_b1_lock', kind: 'table' })
          ).rejects.toMatchObject({ code: '55P03' })
          await d.execute('COMMIT', base)
          expect(Date.now() - started).toBeLessThan(5_000)
          expect(d.sessionState().inTransaction).toBe(false)
          // Unlocked again: the full description comes back.
          const full = await d.describe({ schema: 'public', name: 'tmp_fix_b1_lock' })
          expect(full.columns[1].extra).toBe('GENERATED ALWAYS AS ((id)::text) STORED')
          expect(full.indexes[0].definition).toMatch(/^CREATE UNIQUE INDEX/)
        } finally {
          if (d.sessionState().inTransaction) await d.execute('ROLLBACK', base)
          await d.execute('DROP TABLE IF EXISTS tmp_fix_b1_lock', base)
        }
      })
    },
    30_000
  )

  itLive('catalog reads on the control client give up on locks instead of waiting', async () => {
    await withDriver(PG, {}, async (d) => {
      await d.connect()
      const control = d as unknown as {
        controlQuery: (sql: string) => Promise<Array<{ lt: string; st: string }>>
      }
      const [row] = await control.controlQuery(
        "SELECT current_setting('lock_timeout') AS lt, current_setting('statement_timeout') AS st"
      )
      expect(row).toEqual({ lt: '2s', st: '30s' })
    })
  })

  itLive(
    'returns a finished result without waiting for a busy control client',
    async () => {
      await withDriver(PG, {}, async (d) => {
        await d.connect()
        const control = d as unknown as { controlQuery: (sql: string) => Promise<unknown> }
        const busy = control.controlQuery('SELECT pg_sleep(3)')
        // Let the sleep start so the metadata lookups queue behind it.
        await sleep(100)
        const started = Date.now()
        const r = await d.execute('SELECT id, name FROM users ORDER BY id LIMIT 1', base)
        expect(Date.now() - started).toBeLessThan(1_500)
        expect(rowsOf(r).columns.map((c) => c.name)).toEqual(['id', 'name'])
        expect(rowsOf(r).rows[0]).toEqual([1, 'Shira Levi'])
        await busy
        // The late metadata answer filled the caches: the next result has types and tables.
        const again = rowsOf(
          await d.execute('SELECT id, name FROM users ORDER BY id LIMIT 1', base)
        )
        expect(again.columns[0]).toMatchObject({ name: 'id', type: 'integer', table: 'users' })
      })
    },
    15_000
  )

  itLive("a user's SET search_path is not undone by the schema the request names", async () => {
    await withDriver(PG, {}, async (d) => {
      await d.connect()
      const path = (schema: string): Promise<unknown> =>
        firstCell(d, "SELECT current_setting('search_path')", { schema })
      expect(await path('public')).toBe('"public"')
      await d.execute('SET search_path TO tmp_fix_b1_schema', { ...base, schema: 'public' })
      // Same request and the next ones still name 'public': the user's path stays.
      expect(await path('public')).toBe('tmp_fix_b1_schema')
      expect(await path('public')).toBe('tmp_fix_b1_schema')
      // Picking another schema applies it.
      expect(await path('analytics')).toBe('"analytics", public')
      // A rollback of the transaction that carried our SET puts it back.
      await d.execute('BEGIN', { ...base, schema: 'analytics' })
      expect(await path('public')).toBe('"public"')
      await d.execute('ROLLBACK', { ...base, schema: 'public' })
      expect(await path('public')).toBe('"public"')
      // DISCARD ALL wipes it: set again.
      await d.execute('DISCARD ALL', { ...base, schema: 'public' })
      expect(await path('public')).toBe('"public"')
    })
  })

  itLive(
    'cuts a result at the byte budget without buffering it whole, and says so',
    async () => {
      await withDriver(PG, {}, async (d) => {
        await d.connect()
        const r = await d.execute("SELECT g, repeat('x', 1000000) FROM generate_series(1, 120) g", {
          ...base,
          limit: 1000
        })
        const out = rowsOf(r)
        expect(out.rows.length).toBeGreaterThan(50)
        expect(out.rows.length).toBeLessThan(120)
        expect(out).toMatchObject({ truncated: true, autoLimited: false, limit: out.rows.length })
        expect(r.notices).toEqual([
          `Showing the first ${out.rows.length} rows: the full result is too large to display.`
        ])
        // Batched reads still detect a plain row-limit truncation exactly.
        const limited = rowsOf(
          await d.execute('SELECT g FROM generate_series(1, 5000) g', { ...base, limit: 1000 })
        )
        expect(limited).toMatchObject({ truncated: true, autoLimited: true, limit: 1000 })
        expect(limited.rows).toHaveLength(1000)
        expect(limited.rows[999]).toEqual([1000])
        const exact = rowsOf(
          await d.execute('SELECT g FROM generate_series(1, 250) g', { ...base, hardCap: 250 })
        )
        expect(exact).toMatchObject({ truncated: false })
        expect(exact.rows).toHaveLength(250)
      })
    },
    30_000
  )

  itLive(
    'exports timestamps, dates and bytea like the grid shows them',
    async () => {
      await withDriver(PG, { timezone: 'Asia/Tokyo' }, async (d) => {
        await d.connect()
        const sql =
          "SELECT '2024-01-01 00:00:00+00'::timestamptz AS t, '2024-02-03'::date AS d, '\\xdead'::bytea AS b"
        const grid = rowsOf(await d.execute(sql, base)).rows[0]
        expect(grid).toEqual([
          '2024-01-01 09:00:00+09',
          '2024-02-03',
          { $t: 'bin', hex: 'dead', len: 2 }
        ])
        expect((await exportRows(d, sql))[0]).toEqual(grid)
        // Exports of wide rows come in batches sized by bytes, not one huge read.
        const batches: number[] = []
        await d.streamRows(
          "SELECT g, repeat('x', 100000) FROM generate_series(1, 300) g",
          { readOnlySandbox: true, signal: new AbortController().signal },
          async (_columns, rows) => {
            batches.push(rows.length)
          }
        )
        expect(batches.reduce((a, b) => a + b, 0)).toBe(300)
        expect(Math.max(...batches)).toBeLessThanOrEqual(100)
      })
    },
    30_000
  )

  itLive('ends a control connection that finishes opening after close()', async () => {
    await expectNoLeakOnClose(PG)
  })
})

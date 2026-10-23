// ClickHouse driver: statement analysis / error helpers (always), and live tests against the
// dev container (gated: TEDOOO_DP_IT=1, http://127.0.0.1:18123 default/chpw, database shop).
// Scratch objects are named tmp_dpcs_* and dropped again.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { DataConnectionConfig, DataRowsResult } from '../../../../shared/data-projects/types'
import {
  DataDriverError,
  type DataDriver,
  type DataProjectRecord,
  type DriverExecuteOptions,
  type DriverStatementResult
} from '../contracts'
import {
  analyzeClickHouseStatement,
  clickHouseCell,
  clickHouseCommandTag,
  clickHouseEndpoint,
  clickHouseErrorPosition,
  compactRowsFromBytes,
  createClickHouseDriver,
  restoreClickHouseString,
  withFormatClause
} from './clickhouse'

const itLive = process.env.TEDOOO_DP_IT ? it : it.skip
const describeLive = process.env.TEDOOO_DP_IT ? describe : describe.skip

const PASSWORD = 'chpw'
const BASE: DataConnectionConfig = {
  host: '127.0.0.1',
  port: 18123,
  user: 'default',
  database: 'shop',
  clickhouseProtocol: 'http'
}

const record = (config: DataConnectionConfig): DataProjectRecord => ({
  id: 'dp-ch',
  name: 'Shop (ClickHouse)',
  engine: 'clickhouse',
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
  secretState: 'stored',
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastAccessedAt: '2026-01-01T00:00:00.000Z'
})

const redactor = (secrets: string[]) => (text: string) =>
  secrets.reduce((t, s) => t.split(s).join('***'), text)

const drivers: DataDriver[] = []
const makeDriver = (
  config: Partial<DataConnectionConfig> = {},
  password = PASSWORD
): DataDriver => {
  const driver = createClickHouseDriver({
    project: record({ ...BASE, ...config }),
    secrets: { password },
    redact: redactor([password])
  })
  drivers.push(driver)
  return driver
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

/** 10 s of server time in 0.5 s steps (max_block_size=1 keeps sleepEachRow under its per-block cap). */
const SLOW = 'SELECT sleepEachRow(0.5) FROM numbers(20) SETTINGS max_block_size = 1'

describe('analyzeClickHouseStatement', () => {
  it('routes row-returning statements to query()', () => {
    for (const sql of [
      'SELECT 1',
      '(SELECT 1) UNION ALL (SELECT 2)',
      'WITH x AS (SELECT 1) SELECT * FROM x',
      'SHOW TABLES',
      'DESCRIBE TABLE users',
      'EXPLAIN SELECT 1',
      'EXISTS TABLE users',
      'CHECK TABLE users',
      "KILL QUERY WHERE query_id = 'x'",
      '-- lead comment\nSELECT 1'
    ]) {
      expect(analyzeClickHouseStatement(sql).returnsRows, sql).toBe(true)
    }
    for (const sql of [
      'INSERT INTO t VALUES (1)',
      'CREATE TABLE t (a UInt8) ENGINE = Memory',
      'SET max_threads = 1',
      'USE shop',
      'OPTIMIZE TABLE t FINAL',
      'SYSTEM FLUSH LOGS'
    ]) {
      expect(analyzeClickHouseStatement(sql).returnsRows, sql).toBe(false)
    }
    expect(analyzeClickHouseStatement('USE shop').leading).toBe('USE')
  })

  it('detects a trailing FORMAT clause but not format() or aliases', () => {
    expect(analyzeClickHouseStatement('SELECT 1 FORMAT CSV').format).toBe('CSV')
    expect(
      analyzeClickHouseStatement('SELECT 1 FORMAT JSONEachRow SETTINGS max_threads = 1').format
    ).toBe('JSONEachRow')
    expect(analyzeClickHouseStatement("SELECT format('{}', 1)").format).toBeNull()
    expect(analyzeClickHouseStatement('SELECT 1 AS format').format).toBeNull()
    expect(analyzeClickHouseStatement('SELECT t.format FROM t').format).toBeNull()
    expect(analyzeClickHouseStatement("SELECT 'FORMAT CSV'").format).toBeNull()
    expect(analyzeClickHouseStatement('SELECT * FROM (SELECT 1 FORMAT CSV)').format).toBeNull()
    // INSERT … FORMAT carries data, it is a command.
    expect(analyzeClickHouseStatement('INSERT INTO t FORMAT CSV').format).toBeNull()
  })

  it('knows which LIMITs cap the whole result', () => {
    expect(analyzeClickHouseStatement('SELECT * FROM t LIMIT 10').hasLimit).toBe(true)
    expect(analyzeClickHouseStatement('SELECT * FROM t LIMIT 5, 10').hasLimit).toBe(true)
    expect(
      analyzeClickHouseStatement('SELECT * FROM t LIMIT 10 OFFSET 5 SETTINGS max_threads = 1')
        .hasLimit
    ).toBe(true)
    expect(analyzeClickHouseStatement('SELECT * FROM t LIMIT 1 BY user_id').hasLimit).toBe(false)
    expect(analyzeClickHouseStatement('SELECT * FROM t LIMIT 1 BY user_id LIMIT 10').hasLimit).toBe(
      true
    )
    expect(analyzeClickHouseStatement('SELECT * FROM (SELECT * FROM t LIMIT 5)').hasLimit).toBe(
      false
    )
    expect(analyzeClickHouseStatement('SELECT 1 UNION ALL SELECT 2 LIMIT 1').hasLimit).toBe(false)
  })

  it('flags mutations', () => {
    expect(analyzeClickHouseStatement('ALTER TABLE t DELETE WHERE id = 1').isMutation).toBe(true)
    expect(analyzeClickHouseStatement('ALTER TABLE t UPDATE a = 1 WHERE id = 1').isMutation).toBe(
      true
    )
    expect(analyzeClickHouseStatement('ALTER TABLE t ADD COLUMN c UInt8').isMutation).toBe(false)
  })

  it('derives command tags', () => {
    expect(clickHouseCommandTag('CREATE TABLE t (a UInt8) ENGINE = Memory')).toBe('CREATE TABLE')
    expect(clickHouseCommandTag('create temporary table t (a UInt8)')).toBe(
      'CREATE TEMPORARY TABLE'
    )
    expect(clickHouseCommandTag('CREATE MATERIALIZED VIEW mv TO t AS SELECT 1')).toBe(
      'CREATE MATERIALIZED VIEW'
    )
    expect(clickHouseCommandTag('INSERT INTO t VALUES (1)')).toBe('INSERT')
    expect(clickHouseCommandTag('SYSTEM FLUSH LOGS')).toBe('SYSTEM')
  })
})

describe('clickhouse helpers', () => {
  it('maps a byte position to a character offset inside the statement', () => {
    expect(
      clickHouseErrorPosition("Syntax error: failed at position 10 ('FRM')", 'SELECT * FRM users')
    ).toBe(9)
    // 'é' is two bytes: byte 12 (1-based) is character 10.
    expect(clickHouseErrorPosition('failed at position 12', "SELECT 'é' FRM")).toBe(10)
    // Pointing into the FORMAT suffix the client appended: no position.
    expect(clickHouseErrorPosition('failed at position 40', 'SELECT 1')).toBeUndefined()
    expect(clickHouseErrorPosition('Unknown table', 'SELECT 1')).toBeUndefined()
  })

  it('builds the HTTP endpoint', () => {
    expect(clickHouseEndpoint({ host: 'ch.local' })).toEqual({
      url: 'http://ch.local:8123',
      tls: false
    })
    expect(clickHouseEndpoint({ host: 'x.clickhouse.cloud', clickhouseProtocol: 'https' })).toEqual(
      {
        url: 'https://x.clickhouse.cloud:8443',
        tls: true
      }
    )
    expect(clickHouseEndpoint({ host: 'h', port: 9999, ssl: { mode: 'require' } })).toEqual({
      url: 'https://h:9999',
      tls: true
    })
    expect(
      clickHouseEndpoint({ host: 'h', clickhouseProtocol: 'http', ssl: { mode: 'require' } }).tls
    ).toBe(false)
    expect(clickHouseEndpoint({ host: '::1', port: 8123 }).url).toBe('http://[::1]:8123')
    expect(clickHouseEndpoint({ host: 'h', options: { pathname: '/ch/' } }).url).toBe(
      'http://h:8123/ch/'
    )
  })
})

describe('clickhouse rows from raw bytes', () => {
  /** A JSON line whose string values carry raw bytes, the way ClickHouse writes them. */
  const line = (...parts: Array<string | Buffer>): Buffer =>
    Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'utf8') : p)))
  const collect = async (chunks: Buffer[]): Promise<unknown[][]> => {
    const out: unknown[][] = []
    for await (const batch of compactRowsFromBytes(chunks)) out.push(...batch)
    return out
  }

  it('splits rows across chunk boundaries, also inside a multi-byte character', async () => {
    // 0xFF raw, NUL escaped (JSON control characters are).
    const body = line(
      '["b","t"]\n["String","String"]\n["',
      Buffer.from([0xff]),
      '\\u0000","héllo"]\n'
    )
    const at = body.indexOf(Buffer.from('é')) + 1 // between the two bytes of é
    const rows = await collect([body.subarray(0, 5), body.subarray(5, at), body.subarray(at)])
    expect(rows).toHaveLength(3)
    const [names, types, data] = rows
    expect(names).toEqual(['b', 't'])
    expect(types).toEqual(['String', 'String'])
    expect(data.map((v, i) => clickHouseCell(v, types[i] as string))).toEqual([
      { $t: 'bin', hex: 'ff00', len: 2 },
      'héllo'
    ])
  })

  it('keeps invalid UTF-8 as bytes only in String/FixedString columns', () => {
    const raw = Buffer.from([0xff, 0xab]).toString('latin1')
    expect(restoreClickHouseString(raw)).toEqual(Buffer.from([0xff, 0xab]))
    expect(restoreClickHouseString(Buffer.from('ok ✓', 'utf8').toString('latin1'))).toBe('ok ✓')
    // A \u2028 escape parses to a character past latin1: kept as that character.
    expect(restoreClickHouseString(`${Buffer.from('é').toString('latin1')}\u2028`)).toBe('é\u2028')
    expect(clickHouseCell(raw, 'Nullable(FixedString(2))', Infinity)).toEqual({
      $t: 'bin',
      hex: 'ffab',
      len: 2
    })
    expect(clickHouseCell(raw, 'LowCardinality(String)')).toEqual({
      $t: 'bin',
      hex: 'ffab',
      len: 2
    })
    expect(clickHouseCell(raw, "Enum8('a' = 1)")).toBe('\ufffd\ufffd')
    // Nested values become JSON text (lossy for bytes inside them).
    expect(clickHouseCell([Buffer.from('é').toString('latin1'), 1], 'Array(String)')).toBe(
      '["é",1]'
    )
    expect(clickHouseCell(7, 'UInt8')).toBe(7)
    expect(clickHouseCell(null, 'Nullable(String)')).toBeNull()
  })

  it('throws the exception ClickHouse writes after rows have started', async () => {
    const chunks = [
      Buffer.from('["n"]\n["UInt64"]\n["1"]\n["2'),
      Buffer.from(
        '"]\nCode: 241. DB::Exception: Memory limit (total) exceeded. (MEMORY_LIMIT_EXCEEDED) (version 24.8.1)\n'
      )
    ]
    const seen: unknown[][] = []
    const error = await (async () => {
      for await (const batch of compactRowsFromBytes(chunks)) seen.push(...batch)
    })().catch((e: unknown) => e)
    expect(seen).toEqual([['n'], ['UInt64'], ['1'], ['2']])
    expect(error).toMatchObject({ code: '241' })
    expect((error as Error).message).toMatch(/^Code: 241\. DB::Exception: Memory limit/)
  })

  it('appends FORMAT like the client does', () => {
    expect(withFormatClause('  SELECT 1;; \n', 'JSONCompactEachRowWithNamesAndTypes')).toBe(
      'SELECT 1 \nFORMAT JSONCompactEachRowWithNamesAndTypes'
    )
    expect(withFormatClause('SELECT 1 -- note', 'X')).toBe('SELECT 1 -- note \nFORMAT X')
  })
})

describeLive('clickhouse driver (live)', () => {
  let driver: DataDriver

  beforeAll(async () => {
    driver = makeDriver()
    await driver.connect()
    await driver.execute('DROP TABLE IF EXISTS shop.tmp_dpcs_t', opts())
    await driver.execute('DROP TABLE IF EXISTS shop.tmp_dpcs_mv', opts())
  })

  afterAll(async () => {
    await driver.execute('DROP TABLE IF EXISTS shop.tmp_dpcs_t', opts()).catch(() => undefined)
    await driver.execute('DROP TABLE IF EXISTS shop.tmp_dpcs_mv', opts()).catch(() => undefined)
    await Promise.all(drivers.map((d) => d.close().catch(() => undefined)))
  })

  afterEach(async () => {
    // Reset the session database between tests.
    await driver.execute('USE shop', opts())
  })

  itLive('connects and reports version and database', async () => {
    const other = makeDriver()
    const info = await other.connect()
    expect(info.serverVersion).toMatch(/^ClickHouse \d+\.\d+/)
    expect(info).toMatchObject({ currentDatabase: 'shop', readOnlyUser: false })
    expect(other.sessionState()).toEqual({ currentDatabase: 'shop' })
    await other.close()
    expect(other.isConnected()).toBe(false)
  })

  itLive('fails to connect with a wrong password without echoing it', async () => {
    const bad = makeDriver({}, 'definitely-wrong-pw')
    const error = await bad.connect().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DataDriverError)
    expect((error as DataDriverError).code).toBe('516')
    expect((error as Error).message).not.toContain('definitely-wrong-pw')
    expect(bad.isConnected()).toBe(false)
  })

  itLive('explains a protocol mismatch (HTTPS against the HTTP port)', async () => {
    const bad = makeDriver({ clickhouseProtocol: 'https' })
    const error = await bad.connect().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DataDriverError)
    expect((error as DataDriverError).hint).toMatch(/HTTPS|TLS/)
  })

  itLive('fails to connect to a database that does not exist', async () => {
    const bad = makeDriver({ database: 'tmp_dpcs_nope' })
    await expect(bad.connect()).rejects.toMatchObject({ code: '81' })
  })

  itLive('auto-limits with max_result_rows, trims, and reports stats', async () => {
    const res = await driver.execute('SELECT number FROM numbers(100000)', opts({ limit: 100 }))
    const r = rows(res)
    expect(r.rows).toHaveLength(100)
    expect(r.rows[0]).toEqual(['0'])
    expect(r).toMatchObject({ truncated: true, limit: 100, autoLimited: true })
    expect(r.columns).toEqual([{ name: 'number', type: 'UInt64' }])
    expect(res.stats?.rowsRead).toBeGreaterThan(0)
    expect(res.stats?.bytesRead).toBeGreaterThan(0)
    expect(typeof res.stats?.elapsedMs).toBe('number')

    const own = rows(
      await driver.execute('SELECT number FROM numbers(1000) LIMIT 500', opts({ limit: 100 }))
    )
    expect(own.rows).toHaveLength(500)
    expect(own).toMatchObject({ truncated: false, autoLimited: false })

    const perGroup = rows(
      await driver.execute(
        'SELECT number % 300 AS g FROM numbers(1000) LIMIT 1 BY g',
        opts({ limit: 100 })
      )
    )
    expect(perGroup.rows).toHaveLength(100)
    expect(perGroup.truncated).toBe(true)

    const capped = rows(
      await driver.execute('SELECT number FROM numbers(1000)', opts({ limit: null, hardCap: 10 }))
    )
    expect(capped).toMatchObject({ truncated: true, limit: 10, autoLimited: false })
    expect(capped.rows).toHaveLength(10)
  })

  itLive('returns exact cells for ClickHouse types', async () => {
    const r = rows(
      await driver.execute(
        `SELECT toUInt64(18446744073709551615) AS u64, toDecimal64(12.345, 3) AS d,
                toDateTime('2024-01-02 03:04:05', 'UTC') AS dt, toDateTime64('2024-01-02 03:04:05.678', 3, 'UTC') AS dt64,
                CAST('paid', 'Enum8(\\'pending\\' = 1, \\'paid\\' = 2)') AS e, toLowCardinality('x') AS lc,
                [1, 2, 3] AS arr, map('a', 1) AS m, CAST(NULL, 'Nullable(UInt8)') AS n, nan AS f, true AS b,
                toUUID('00000000-0000-0000-0000-000000000001') AS u, toInt128(-5) AS i128, toUInt8(7) AS small`,
        opts()
      )
    )
    expect(r.columns.map((c) => c.type)).toEqual([
      'UInt64',
      'Decimal(18, 3)',
      "DateTime('UTC')",
      "DateTime64(3, 'UTC')",
      "Enum8('pending' = 1, 'paid' = 2)",
      'LowCardinality(String)',
      'Array(UInt8)',
      'Map(String, UInt8)',
      'Nullable(UInt8)',
      'Float64',
      'Bool',
      'UUID',
      'Int128',
      'UInt8'
    ])
    expect(r.rows[0]).toEqual([
      '18446744073709551615',
      '12.345',
      '2024-01-02 03:04:05',
      '2024-01-02 03:04:05.678',
      'paid',
      'x',
      '[1,2,3]',
      '{"a":1}',
      null,
      'nan',
      true,
      '00000000-0000-0000-0000-000000000001',
      '-5',
      7
    ])

    const orders = rows(
      await driver.execute(
        'SELECT id, status, total, created_at FROM orders ORDER BY id LIMIT 1',
        opts()
      )
    )
    expect(orders.columns.map((c) => c.name)).toEqual(['id', 'status', 'total', 'created_at'])
    expect(typeof orders.rows[0][0]).toBe('string') // UInt64 → exact string
    expect(orders.rows[0][2]).toMatch(/^\d+\.\d{1,2}$/) // Decimal(12, 2) → exact string
  })

  itLive('returns columns and types for an empty result', async () => {
    const r = rows(await driver.execute('SELECT * FROM users WHERE 0', opts()))
    expect(r.rows).toEqual([])
    expect(r.columns).toEqual([
      { name: 'id', type: 'UInt32' },
      { name: 'name', type: 'String' },
      { name: 'email', type: 'String' },
      { name: 'country', type: 'LowCardinality(String)' },
      { name: 'created_at', type: 'DateTime' },
      { name: 'is_banned', type: 'Bool' }
    ])
  })

  itLive('runs commands with affected rows; temp tables and SETs live in the session', async () => {
    const create = await driver.execute(
      'CREATE TABLE shop.tmp_dpcs_t (id UInt64, v String) ENGINE = MergeTree ORDER BY id',
      opts()
    )
    expect(create.output).toEqual({ kind: 'command', message: 'CREATE TABLE', affectedRows: null })
    const insert = await driver.execute(
      "INSERT INTO shop.tmp_dpcs_t VALUES (1, 'a'), (2, 'b')",
      opts()
    )
    expect(insert.output).toMatchObject({ kind: 'command', message: 'INSERT', affectedRows: 2 })
    const mutation = await driver.execute('ALTER TABLE shop.tmp_dpcs_t DELETE WHERE id = 2', opts())
    expect(mutation.notices?.[0]).toMatch(/asynchronous mutation/)

    await driver.execute('CREATE TEMPORARY TABLE tmp_dpcs_tt (a UInt8)', opts())
    await driver.execute('INSERT INTO tmp_dpcs_tt VALUES (1), (2), (3)', opts())
    expect(rows(await driver.execute('SELECT count() FROM tmp_dpcs_tt', opts())).rows).toEqual([
      ['3']
    ])
    await driver.execute('SET max_threads = 3', opts())
    expect(
      Number(rows(await driver.execute("SELECT getSetting('max_threads')", opts())).rows[0][0])
    ).toBe(3)
    await driver.execute('DROP TEMPORARY TABLE tmp_dpcs_tt', opts())
  })

  itLive('rejects writes in the readonly=2 sandbox as sandboxRejected', async () => {
    const error = await driver
      .execute(
        'INSERT INTO shop.users SELECT * FROM shop.users LIMIT 1',
        opts({ readOnlySandbox: true })
      )
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DataDriverError)
    expect(error).toMatchObject({ code: '164', sandboxRejected: true, cancelled: false })
    const escalate = await driver
      .execute('SELECT 1 SETTINGS readonly = 0', opts({ readOnlySandbox: true }))
      .catch((e: unknown) => e)
    expect(escalate).toMatchObject({ sandboxRejected: true })
    expect(
      rows(await driver.execute('SELECT count() FROM shop.users', opts({ readOnlySandbox: true })))
        .rows
    ).toEqual([['200']])
    // Outside the sandbox the same code is not a sandbox rejection.
    expect(rows(await driver.execute('SELECT 1', opts())).rows).toEqual([[1]])
  })

  itLive('handles USE by moving the session database', async () => {
    const use = await driver.execute('USE system', opts({ database: 'shop' }))
    expect(use.output).toEqual({ kind: 'command', message: 'USE system' })
    expect(driver.sessionState().currentDatabase).toBe('system')
    // Later statements of the same request: the query runner passes the session's database.
    const inRequest = opts({ database: driver.sessionState().currentDatabase })
    expect(rows(await driver.execute('SELECT currentDatabase()', inRequest)).rows).toEqual([
      ['system']
    ])
    expect(rows(await driver.execute('SELECT count() > 0 FROM one', opts())).rows).toEqual([[1]])
    // A later request runs where it asks to, also when that is the database the USE left
    // (another tab, or the dropdown switched back).
    expect(
      rows(await driver.execute('SELECT currentDatabase()', opts({ database: 'shop' }))).rows
    ).toEqual([['shop']])
    expect(driver.sessionState().currentDatabase).toBe('shop')
    expect(
      rows(await driver.execute('SELECT currentDatabase()', opts({ database: 'default' }))).rows
    ).toEqual([['default']])
  })

  itLive(
    'shows a user FORMAT as raw text and falls back for statements that refuse ours',
    async () => {
      const csv = rows(await driver.execute("SELECT 1 AS a, 'x' AS b FORMAT CSV", opts()))
      expect(csv.columns).toEqual([{ name: 'CSV output', type: 'String' }])
      expect(csv.rows).toEqual([['1,"x"']])
      const tsv = rows(
        await driver.execute('SELECT number FROM numbers(3) FORMAT TSVWithNames', opts())
      )
      expect(tsv.rows).toEqual([['number'], ['0'], ['1'], ['2']])
    }
  )

  itLive('reports syntax error positions inside the statement', async () => {
    // `FRM` parses as an alias of *, so the parser fails at `users`.
    const error = await driver.execute('SELECT * FRM users', opts()).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: '62', position: 13 })
    // 'é' is two bytes: the server's byte offset must come back as a character offset.
    const sql = "SELECT 'é' AS a FRM users"
    const multibyte = await driver.execute(sql, opts()).catch((e: unknown) => e)
    expect(multibyte).toMatchObject({ code: '62', position: sql.indexOf('FRM') })
    const unknown = await driver
      .execute('SELECT * FROM tmp_dpcs_missing', opts())
      .catch((e: unknown) => e)
    expect(unknown).toMatchObject({ code: '60' })
  })

  itLive(
    'cancels a running query (abort + KILL QUERY) and the session stays usable',
    async () => {
      const started = Date.now()
      const pending = driver.execute(SLOW, opts()).catch((e: unknown) => e)
      await sleep(700)
      const processes = await driver.listProcesses()
      const own = processes.find((p) => p.isOwn)
      expect(own).toMatchObject({ state: 'running', database: 'shop' })
      expect(own?.query).toContain('sleepEachRow')
      expect(own?.durationMs).toBeGreaterThan(0)
      await driver.cancelCurrent()
      const error = await pending
      expect(error).toBeInstanceOf(DataDriverError)
      expect(error).toMatchObject({ cancelled: true })
      expect(Date.now() - started).toBeLessThan(6_000)
      // The session may still be unwinding the killed query: the driver waits out the lock.
      expect(rows(await driver.execute('SELECT 42', opts())).rows).toEqual([[42]])
    },
    30_000
  )

  itLive(
    'kills another connection’s query from the process list',
    async () => {
      const other = makeDriver()
      await other.connect()
      const pending = other.execute(SLOW, opts()).catch((e: unknown) => e)
      await sleep(700)
      const target = (await driver.listProcesses()).find((p) => p.query?.includes('sleepEachRow'))
      expect(target).toBeDefined()
      expect(target?.isOwn).toBe(false)
      await driver.killProcess(target!.id, 'query')
      const error = await pending
      expect(error).toBeInstanceOf(DataDriverError)
      await expect(driver.killProcess('tmp-dpcs-no-such-query', 'query')).rejects.toMatchObject({
        code: 'NO_SUCH_QUERY'
      })
    },
    30_000
  )

  itLive('introspects databases, objects, details, DDL and completion data', async () => {
    const dbs = await driver.listDatabases()
    expect(dbs.find((d) => d.name === 'shop')).toMatchObject({ name: 'shop' })
    expect(dbs.find((d) => d.name === 'shop')?.sizeBytes).toBeGreaterThan(0)
    expect(dbs.find((d) => d.name === 'system')).toMatchObject({ isSystem: true })

    await driver.execute(
      'CREATE MATERIALIZED VIEW IF NOT EXISTS shop.tmp_dpcs_mv ENGINE = SummingMergeTree ORDER BY status AS SELECT status, count() AS n FROM shop.orders GROUP BY status',
      opts()
    )
    const { objects } = await driver.listObjects('shop')
    expect(objects.find((o) => o.name === 'orders')).toMatchObject({
      kind: 'table',
      engine: 'MergeTree',
      rowEstimate: 2000
    })
    expect(objects.find((o) => o.name === 'tmp_dpcs_mv')).toMatchObject({
      kind: 'materialized_view',
      engine: 'MaterializedView'
    })
    // The MV's hidden storage table (.inner_id.<uuid>) is an implementation detail.
    expect(objects.some((o) => o.name.startsWith('.inner'))).toBe(false)

    const orders = await driver.describe({ database: 'shop', name: 'orders' })
    expect(orders.kind).toBe('table')
    expect(orders.primaryKey).toEqual([])
    expect(orders.columns.map((c) => c.name)).toEqual([
      'id',
      'user_id',
      'status',
      'total',
      'created_at'
    ])
    expect(orders.columns[0]).toMatchObject({
      type: 'UInt64',
      isPrimaryKey: true,
      nullable: false,
      ordinal: 1
    })
    expect(orders.columns[4].extra).toContain('partition key')
    expect(orders.indexes[0]).toMatchObject({
      name: 'PRIMARY KEY',
      primary: true,
      columns: ['id', 'created_at']
    })
    const props = Object.fromEntries((orders.properties ?? []).map((p) => [p.label, p.value]))
    expect(props['Partition key']).toBe('toYYYYMM(created_at)')
    expect(props['Sorting key']).toBe('created_at, id')
    expect(props['Active parts']).toBeDefined()
    expect(orders.rowEstimate).toBe(2000)
    await expect(
      driver.describe({ database: 'shop', name: 'tmp_dpcs_none' })
    ).rejects.toBeInstanceOf(DataDriverError)

    const ddl = await driver.ddl({ database: 'shop', name: 'orders' })
    expect(ddl).toMatch(/^CREATE TABLE shop\.orders/)
    expect(ddl).toContain('PARTITION BY toYYYYMM(created_at)')
    expect(ddl.trimEnd().endsWith(';')).toBe(true)

    const completion = await driver.completionSchema('shop')
    expect(completion.database).toBe('shop')
    expect(completion.databases).toContain('system')
    expect(completion.tables.find((t) => t.name === 'users')?.columns.map((c) => c.name)).toContain(
      'email'
    )
    expect(completion.functions).toContain('sum')
    expect(completion.functions).toContain('numbers') // table functions too
    await driver.execute('DROP TABLE shop.tmp_dpcs_mv', opts())
  })

  itLive(
    'returns String values that are not UTF-8 as binary cells, in the grid and exports',
    async () => {
      const sql =
        "SELECT unhex('FF00AB') AS b, toFixedString(unhex('00FF'), 2) AS f, 'héllo ✓' AS t, " +
        "CAST(unhex('C3') AS Nullable(String)) AS n, [unhex('FF')] AS arr"
      const r = rows(await driver.execute(sql, opts()))
      expect(r.columns.map((c) => c.type)).toEqual([
        'String',
        'FixedString(2)',
        'String',
        'Nullable(String)',
        'Array(String)'
      ])
      expect(r.rows[0].slice(0, 4)).toEqual([
        { $t: 'bin', hex: 'ff00ab', len: 3 },
        { $t: 'bin', hex: '00ff', len: 2 },
        'héllo ✓',
        { $t: 'bin', hex: 'c3', len: 1 }
      ])
      expect(typeof r.rows[0][4]).toBe('string') // nested: JSON text

      const exported: unknown[][] = []
      let names: string[] = []
      await driver.streamRows(
        sql,
        { readOnlySandbox: true, signal: new AbortController().signal },
        async (columns, batch) => {
          names = columns
          exported.push(...batch)
        }
      )
      expect(names).toEqual(['b', 'f', 't', 'n', 'arr'])
      expect(exported[0].slice(0, 4)).toEqual(r.rows[0].slice(0, 4))
    }
  )

  itLive(
    'streams every row of an export and stops on abort',
    async () => {
      let names: string[] = []
      let total = 0
      const res = await driver.streamRows(
        'SELECT * FROM order_items',
        { database: 'shop', readOnlySandbox: true, signal: new AbortController().signal },
        async (columns, batch) => {
          names = columns
          total += batch.length
        }
      )
      expect(res.rows).toBe(4997)
      expect(total).toBe(4997)
      expect(names).toEqual(['id', 'order_id', 'product_id', 'quantity', 'unit_price'])

      const controller = new AbortController()
      const started = Date.now()
      const pending = driver
        .streamRows(
          SLOW,
          { readOnlySandbox: true, signal: controller.signal },
          async () => undefined
        )
        .catch((e: unknown) => e)
      await sleep(500)
      controller.abort()
      expect(await pending).toMatchObject({ cancelled: true })
      expect(Date.now() - started).toBeLessThan(5_000)

      const sandboxed = await driver
        .streamRows(
          'INSERT INTO shop.users SELECT * FROM shop.users',
          { readOnlySandbox: true, signal: new AbortController().signal },
          async () => undefined
        )
        .catch((e: unknown) => e)
      expect(sandboxed).toMatchObject({ code: 'EXPORT_NOT_ROWS' })
    },
    30_000
  )

  itLive(
    'works for a readonly=1 profile (no settings sent, values as strings)',
    async () => {
      await driver.execute(
        "CREATE USER IF NOT EXISTS tmp_dpcs_ro IDENTIFIED WITH plaintext_password BY 'ropw' SETTINGS readonly = 1",
        opts()
      )
      // INSERT is granted so the refusal below comes from the readonly profile (164), not ACL (497).
      await driver.execute('GRANT SELECT, INSERT ON shop.* TO tmp_dpcs_ro', opts())
      try {
        const ro = makeDriver({ user: 'tmp_dpcs_ro' }, 'ropw')
        const info = await ro.connect()
        expect(info.readOnlyUser).toBe(true)
        const r = rows(
          await ro.execute(
            'SELECT id, total FROM orders ORDER BY id LIMIT 3',
            opts({ readOnlySandbox: true })
          )
        )
        expect(r.rows).toHaveLength(3)
        expect(r.columns[1]).toEqual({ name: 'total', type: 'Decimal(12, 2)' })
        const limited = rows(await ro.execute('SELECT id FROM orders', opts({ limit: 5 })))
        expect(limited).toMatchObject({ truncated: true, limit: 5, autoLimited: true })
        expect(limited.rows).toHaveLength(5)
        const write = await ro
          .execute('INSERT INTO shop.users SELECT * FROM shop.users LIMIT 1', opts())
          .catch((e: unknown) => e)
        expect(write).toMatchObject({ code: '164', hint: expect.stringContaining('read-only') })
      } finally {
        await driver.execute('DROP USER IF EXISTS tmp_dpcs_ro', opts())
      }
    },
    30_000
  )
})

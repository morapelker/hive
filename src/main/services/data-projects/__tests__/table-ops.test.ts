import { afterEach, describe, expect, it } from 'vitest'
import type { DataRowEdit, DataTableDetails } from '../../../../shared/data-projects/types'
import type { DataProjectRecord, DriverConnectInput } from '../contracts'
import { noopLogger } from '../connection-manager'
import { createDataEngineService, type DataEngineServiceInternals } from '../engine-service'
import { createSafetyGate } from '../safety-gate'
import {
  assertSingleRead,
  buildCountSql,
  buildEditStatements,
  buildSelectSql,
  clickhouseSortingKey,
  qualifiedTableName
} from '../table-ops'
import {
  FakeDriver,
  MemoryRepository,
  MemorySecrets,
  makeRecord,
  rowsOutput
} from './engine-fixtures'

const details = (overrides: Partial<DataTableDetails> = {}): DataTableDetails => ({
  ref: { name: 'users', schema: 'public', database: 'shop' },
  kind: 'table',
  columns: [
    { name: 'id', type: 'int', nullable: false, isPrimaryKey: true, ordinal: 1 },
    { name: 'name', type: 'text', nullable: false, isPrimaryKey: false, ordinal: 2 },
    { name: 'data', type: 'bytea', nullable: true, isPrimaryKey: false, ordinal: 3 }
  ],
  indexes: [],
  foreignKeys: [],
  triggers: [],
  primaryKey: ['id'],
  rowEstimate: 50,
  ...overrides
})

describe('table SQL generation', () => {
  it('qualifies names per dialect', () => {
    const ref = { database: 'shop', schema: 'public', name: 'or"d`ers' }
    expect(qualifiedTableName(ref, 'postgres')).toBe('"public"."or""d`ers"')
    expect(qualifiedTableName(ref, 'mysql')).toBe('`shop`.`or"d``ers`')
    expect(qualifiedTableName(ref, 'mariadb')).toBe('`shop`.`or"d``ers`')
    expect(qualifiedTableName({ name: 't', schema: 'main' }, 'sqlite')).toBe('"main"."t"')
    expect(qualifiedTableName({ name: 't', database: 'db' }, 'clickhouse')).toBe('`db`.`t`')
  })

  it('builds SELECT with filters, raw WHERE, ORDER BY and paging', () => {
    const sql = buildSelectSql(
      'postgres',
      { schema: 'public', name: 'users' },
      {
        filters: [{ column: 'country', operator: '=', value: "O'Neil" }],
        where: "WHERE created_at > now() - interval '1 day' -- recent;",
        orderBy: [
          { column: 'name', direction: 'desc' },
          { column: 'id', direction: 'asc' }
        ],
        limit: 50,
        offset: 100
      }
    )
    expect(sql).toBe(
      `SELECT * FROM "public"."users" WHERE ("country" = 'O''Neil') AND (created_at > now() - interval '1 day' -- recent\n) ORDER BY "name" DESC, "id" ASC LIMIT 50 OFFSET 100`
    )
    expect(() => assertSingleRead(sql, 'postgres')).not.toThrow()
    expect(buildSelectSql('mysql', { database: 'shop', name: 'users' }, { limit: 10 })).toBe(
      'SELECT * FROM `shop`.`users` LIMIT 10'
    )
    expect(
      buildCountSql('clickhouse', { database: 'shop', name: 'orders' }, [
        { column: 'status', operator: 'is null' }
      ])
    ).toBe('SELECT COUNT(*) FROM `shop`.`orders` WHERE (`status` IS NULL)')
  })

  it('groups OR filters in parentheses before ANDing the raw WHERE, per dialect', () => {
    const filters = [
      { column: 'country', operator: '=' as const, value: 'IL' },
      { column: 'name', operator: 'starts with' as const, value: 'A' }
    ]
    const cases = [
      [
        'postgres',
        { schema: 'public', name: 'users' },
        `SELECT * FROM "public"."users" WHERE ("country" = 'IL' OR CAST("name" AS TEXT) LIKE 'A%' ESCAPE '!') AND (id > 1\n) LIMIT 5`
      ],
      [
        'mysql',
        { database: 'shop', name: 'users' },
        "SELECT * FROM `shop`.`users` WHERE (`country` = 'IL' OR `name` LIKE 'A%' ESCAPE '!') AND (id > 1\n) LIMIT 5"
      ],
      [
        'mariadb',
        { database: 'shop', name: 'users' },
        "SELECT * FROM `shop`.`users` WHERE (`country` = 'IL' OR `name` LIKE 'A%' ESCAPE '!') AND (id > 1\n) LIMIT 5"
      ],
      [
        'sqlite',
        { schema: 'main', name: 'users' },
        `SELECT * FROM "main"."users" WHERE ("country" = 'IL' OR "name" LIKE 'A%' ESCAPE '!') AND (id > 1\n) LIMIT 5`
      ],
      [
        'clickhouse',
        { database: 'shop', name: 'users' },
        "SELECT * FROM `shop`.`users` WHERE (`country` = 'IL' OR toString(`name`) LIKE 'A%') AND (id > 1\n) LIMIT 5"
      ]
    ] as const
    for (const [dialect, ref, expected] of cases) {
      const sql = buildSelectSql(dialect, ref, {
        filters,
        filterJoin: 'or',
        where: 'id > 1',
        limit: 5
      })
      expect(sql).toBe(expected)
      expect(() => assertSingleRead(sql, dialect)).not.toThrow()
      expect(
        buildCountSql(dialect, ref, filters, undefined, { join: 'or' }).endsWith(
          expected.slice(expected.indexOf(' WHERE '), expected.indexOf(' AND (id'))
        )
      ).toBe(true)
    }
    // AND stays the default.
    expect(buildSelectSql('postgres', { name: 'users' }, { filters, filterJoin: 'and' })).toBe(
      `SELECT * FROM "users" WHERE ("country" = 'IL' AND CAST("name" AS TEXT) LIKE 'A%' ESCAPE '!')`
    )
  })

  it('refuses raw WHERE text that is not a single plain read', () => {
    const inject = buildSelectSql(
      'postgres',
      { name: 'users' },
      { where: '1=1); DROP TABLE users; --' }
    )
    expect(() => assertSingleRead(inject, 'postgres')).toThrow(/WHERE/)
    const sleepy = buildSelectSql(
      'postgres',
      { name: 'users' },
      { where: 'pg_sleep(100) IS NOT NULL' }
    )
    expect(() => assertSingleRead(sleepy, 'postgres')).toThrow(/only read/)
    const mysqlExec = buildSelectSql(
      'mysql',
      { name: 'users' },
      { where: '1=1 /*!50000 ; DROP TABLE users */' }
    )
    expect(() => assertSingleRead(mysqlExec, 'mysql')).toThrow()
  })

  it('generates keyed UPDATE/INSERT/DELETE per dialect', () => {
    const edits: DataRowEdit[] = [
      { kind: 'update' as const, key: { id: 7, name: 'ignored' }, changes: { name: "it's" } },
      {
        kind: 'insert' as const,
        values: { id: 8, name: 'new', data: { $t: 'bin' as const, hex: 'cafe', len: 2 } }
      },
      { kind: 'delete' as const, key: { id: 9 } }
    ]
    expect(
      buildEditStatements('postgres', { schema: 'public', name: 'users' }, details(), edits)
    ).toEqual([
      `UPDATE "public"."users" SET "name" = 'it''s' WHERE "id" = 7`,
      `INSERT INTO "public"."users" ("id", "name", "data") VALUES (8, 'new', decode('CAFE', 'hex'))`,
      `DELETE FROM "public"."users" WHERE "id" = 9`
    ])
    expect(
      buildEditStatements('mysql', { database: 'shop', name: 'users' }, details(), edits)
    ).toEqual([
      "UPDATE `shop`.`users` SET `name` = 'it''s' WHERE `id` = 7 LIMIT 1",
      "INSERT INTO `shop`.`users` (`id`, `name`, `data`) VALUES (8, 'new', X'CAFE')",
      'DELETE FROM `shop`.`users` WHERE `id` = 9 LIMIT 1'
    ])
    expect(
      buildEditStatements('sqlite', { schema: 'main', name: 'users' }, details(), edits)[0]
    ).toBe(`UPDATE "main"."users" SET "name" = 'it''s' WHERE "id" = 7`)
    expect(
      buildEditStatements('clickhouse', { database: 'shop', name: 'users' }, details(), edits)
    ).toEqual([
      "ALTER TABLE `shop`.`users` UPDATE `name` = 'it\\'s' WHERE `id` = 7",
      "INSERT INTO `shop`.`users` (`id`, `name`, `data`) VALUES (8, 'new', unhex('CAFE'))",
      'ALTER TABLE `shop`.`users` DELETE WHERE `id` = 9'
    ])
  })

  it('quotes MySQL literals for the session’s NO_BACKSLASH_ESCAPES mode', () => {
    const edit: DataRowEdit[] = [
      { kind: 'update', key: { id: 1 }, changes: { name: 'C:\\temp\\new' } }
    ]
    const ref = { database: 'shop', name: 'users' }
    expect(buildEditStatements('mysql', ref, details(), edit)).toEqual([
      "UPDATE `shop`.`users` SET `name` = 'C:\\\\temp\\\\new' WHERE `id` = 1 LIMIT 1"
    ])
    expect(buildEditStatements('mysql', ref, details(), edit, false)).toEqual([
      "UPDATE `shop`.`users` SET `name` = 'C:\\temp\\new' WHERE `id` = 1 LIMIT 1"
    ])
    // The filter literal and the check of the generated text follow the same mode.
    const sql = buildSelectSql('mysql', ref, {
      filters: [{ column: 'name', operator: '=', value: "a\\'b" }],
      backslashEscapes: false
    })
    expect(sql).toBe("SELECT * FROM `shop`.`users` WHERE (`name` = 'a\\''b')")
    expect(() => assertSingleRead(sql, 'mysql', { backslashEscapes: false })).not.toThrow()
  })

  it('orders ClickHouse pages by the sorting key, else the primary key columns', () => {
    const ch = (props: Array<{ label: string; value: string }>, pk: string[] = []) =>
      details({
        properties: props,
        primaryKey: [],
        columns: [
          {
            name: 'ts',
            type: 'DateTime',
            nullable: false,
            isPrimaryKey: pk.includes('ts'),
            ordinal: 1
          },
          {
            name: 'id',
            type: 'UInt64',
            nullable: false,
            isPrimaryKey: pk.includes('id'),
            ordinal: 2
          }
        ]
      })
    expect(clickhouseSortingKey(ch([{ label: 'Sorting key', value: 'toDate(ts), id' }]))).toBe(
      'toDate(ts), id'
    )
    expect(clickhouseSortingKey(ch([{ label: 'Sorting key', value: 'tuple()' }]))).toBeUndefined()
    expect(clickhouseSortingKey(ch([], ['id', 'ts']))).toBe('`ts`, `id`')
    expect(clickhouseSortingKey(ch([]))).toBeUndefined()
    expect(
      buildSelectSql(
        'clickhouse',
        { database: 'shop', name: 'events' },
        { orderByExpression: 'toDate(ts), id', limit: 3, offset: 700000 }
      )
    ).toBe('SELECT * FROM `shop`.`events` ORDER BY toDate(ts), id LIMIT 3 OFFSET 700000')
  })

  it('writes MySQL BIT values unquoted (typed text and values wider than 53 bits)', () => {
    const d = details({
      columns: [
        { name: 'id', type: 'int', nullable: false, isPrimaryKey: true, ordinal: 1 },
        { name: 'flag', type: 'bit(1)', nullable: true, isPrimaryKey: false, ordinal: 2 },
        { name: 'mask', type: 'BIT(64)', nullable: true, isPrimaryKey: false, ordinal: 3 }
      ]
    })
    const ref = { database: 'shop', name: 't' }
    expect(
      buildEditStatements('mysql', ref, d, [
        { kind: 'update', key: { id: 1 }, changes: { flag: '1', mask: '18446744073709551615' } }
      ])
    ).toEqual([
      'UPDATE `shop`.`t` SET `flag` = 1, `mask` = 18446744073709551615 WHERE `id` = 1 LIMIT 1'
    ])
    expect(
      buildEditStatements('mariadb', ref, d, [
        { kind: 'insert', values: { flag: "b'1'", mask: 5 } }
      ])
    ).toEqual(["INSERT INTO `shop`.`t` (`flag`, `mask`) VALUES (b'1', 5)"])
    expect(() =>
      buildEditStatements('mysql', ref, d, [
        { kind: 'update', key: { id: 1 }, changes: { flag: "1'; DROP TABLE t; --" } }
      ])
    ).toThrow(/BIT column/)
    // Other engines and non-BIT text columns keep quoting.
    expect(
      buildEditStatements('postgres', { name: 't' }, d, [
        { kind: 'update', key: { id: 1 }, changes: { flag: '1' } }
      ])
    ).toEqual(['UPDATE "t" SET "flag" = \'1\' WHERE "id" = 1'])
  })

  it('handles composite keys, NULL keys and empty inserts', () => {
    const d = details({ primaryKey: ['a', 'b'], columns: [] })
    expect(
      buildEditStatements('postgres', { name: 't' }, d, [
        { kind: 'delete', key: { a: 1, b: null } }
      ])
    ).toEqual(['DELETE FROM "t" WHERE "a" = 1 AND "b" IS NULL'])
    expect(
      buildEditStatements('postgres', { name: 't' }, d, [{ kind: 'insert', values: {} }])
    ).toEqual(['INSERT INTO "t" DEFAULT VALUES'])
    expect(
      buildEditStatements('mariadb', { name: 't' }, d, [{ kind: 'insert', values: {} }])
    ).toEqual(['INSERT INTO `t` () VALUES ()'])
  })

  it('refuses edits without a primary key, unknown columns, missing key parts and previewed binaries', () => {
    expect(() =>
      buildEditStatements('postgres', { name: 't' }, details({ primaryKey: [] }), [
        { kind: 'delete', key: { id: 1 } }
      ])
    ).toThrow(/primary key/)
    expect(() =>
      buildEditStatements('postgres', { name: 't' }, details(), [
        { kind: 'update', key: { id: 1 }, changes: { nope: 1 } }
      ])
    ).toThrow(/Unknown column/)
    expect(() =>
      buildEditStatements('postgres', { name: 't' }, details(), [
        { kind: 'delete', key: { name: 'x' } }
      ])
    ).toThrow(/missing the primary key/)
    expect(() =>
      buildEditStatements('postgres', { name: 't' }, details(), [
        { kind: 'update', key: { id: 1 }, changes: { data: { $t: 'bin', hex: 'ab', len: 900 } } }
      ])
    ).toThrow(/binary/)
    expect(() =>
      buildEditStatements('postgres', { name: 'v' }, details({ kind: 'view' }), [
        { kind: 'delete', key: { id: 1 } }
      ])
    ).toThrow(/Only tables/)
  })
})

// ---------------------------------------------------------------------------------------------
// Operations through the engine (fake driver)
// ---------------------------------------------------------------------------------------------

let engines: DataEngineServiceInternals[] = []
afterEach(async () => {
  for (const e of engines) await e.shutdown()
  engines = []
})

function setup(record: Partial<DataProjectRecord> = {}) {
  const repo = new MemoryRepository([makeRecord(record)])
  const drivers: FakeDriver[] = []
  let configure: (d: FakeDriver) => void = () => {}
  const engine = createDataEngineService({
    repository: repo,
    secrets: new MemorySecrets(),
    publish: () => {},
    createDriver: (input: DriverConnectInput) => {
      const d = new FakeDriver(input)
      d.details = details()
      configure(d)
      drivers.push(d)
      return d
    },
    gate: createSafetyGate(),
    logger: noopLogger
  })
  engines.push(engine)
  return {
    engine,
    repo,
    drivers,
    configure: (fn: (d: FakeDriver) => void) => {
      configure = fn
      drivers.forEach(fn)
    }
  }
}

describe('tableRows', () => {
  it('pages in the sandbox ordered by the primary key and counts small tables exactly', async () => {
    const h = setup()
    h.configure((d) => {
      d.handler = (sql) =>
        sql.startsWith('SELECT COUNT')
          ? rowsOutput(['count'], [['123']])
          : rowsOutput(['id'], [[1], [2]])
    })
    const res = await h.engine.tableRows(
      {
        dataProjectId: 'dp-1',
        queryId: 'q',
        ref: { schema: 'public', name: 'users', database: 'shop' },
        limit: 2,
        offset: 0
      },
      { clientId: null }
    )
    expect(res.sql).toBe('SELECT * FROM "public"."users" ORDER BY "id" ASC LIMIT 2')
    expect(res.primaryKey).toEqual(['id'])
    expect(res.totalRows).toBe(123)
    expect(res.totalIsEstimate).toBe(false)
    expect(res.result.truncated).toBe(true)
    expect(h.drivers[0].calls.every((c) => c.options.readOnlySandbox)).toBe(true)
  })

  it('uses the estimate for big unfiltered tables and the page size when the page is short', async () => {
    const h = setup()
    h.configure((d) => {
      d.details = details({ rowEstimate: 5_000_000 })
      d.handler = () => rowsOutput(['id'], [[1], [2]])
    })
    const big = await h.engine.tableRows(
      {
        dataProjectId: 'dp-1',
        queryId: 'q1',
        ref: { schema: 'public', name: 'users' },
        limit: 2,
        offset: 0
      },
      { clientId: null }
    )
    expect(big).toMatchObject({ totalRows: 5_000_000, totalIsEstimate: true })
    const short = await h.engine.tableRows(
      {
        dataProjectId: 'dp-1',
        queryId: 'q2',
        ref: { schema: 'public', name: 'users' },
        limit: 10,
        offset: 20
      },
      { clientId: null }
    )
    expect(short).toMatchObject({ totalRows: 22, totalIsEstimate: false })
  })

  it('refuses a page the driver cut by its byte budget instead of reading it as the last page', async () => {
    // Wide rows: the driver keeps 95 of the 100 asked for and reports the cut (truncated, limit
    // = rows kept). Shown short, rows 96–100 could never be reached and the total would be 95.
    const h = setup()
    const counted: string[] = []
    h.configure((d) => {
      d.handler = (sql) => {
        if (sql.startsWith('SELECT COUNT')) {
          counted.push(sql)
          return rowsOutput(['count'], [['130']])
        }
        const ids = Array.from({ length: 95 }, (_, i) => [i + 1])
        return {
          output: {
            kind: 'rows',
            columns: [{ name: 'id' }],
            rows: ids,
            truncated: true,
            limit: 95,
            autoLimited: false
          },
          notices: ['Showing the first 95 rows: the full result is too large to display.']
        }
      }
    })
    const page = (limit: number) =>
      h.engine.tableRows(
        {
          dataProjectId: 'dp-1',
          queryId: `q-${limit}`,
          ref: { schema: 'public', name: 'users' },
          limit,
          offset: 0
        },
        { clientId: null }
      )
    await expect(page(100)).rejects.toMatchObject({
      code: 'ResultTooLarge',
      message: expect.stringMatching(/too large to show 100 per page.*smaller page size/)
    })
    expect(counted).toEqual([])
    // A page that fits (here: the 95 rows asked for) is an ordinary full page.
    const fits = await page(95)
    expect(fits.result.rows).toHaveLength(95)
    expect(fits.totalRows).toBe(130)
  })

  it('combines the filters with OR for the page and the count when filterJoin is or', async () => {
    const h = setup()
    h.configure((d) => {
      d.handler = (sql) =>
        sql.startsWith('SELECT COUNT')
          ? rowsOutput(['count'], [['7']])
          : rowsOutput(['id'], [[1], [2]])
    })
    const res = await h.engine.tableRows(
      {
        dataProjectId: 'dp-1',
        queryId: 'q-or',
        ref: { schema: 'public', name: 'users', database: 'shop' },
        filters: [
          { column: 'id', operator: '=', value: '1' },
          { column: 'name', operator: 'is null' }
        ],
        filterJoin: 'or',
        where: 'id < 100',
        limit: 2,
        offset: 0
      },
      { clientId: null }
    )
    const where = `WHERE ("id" = '1' OR "name" IS NULL) AND (id < 100\n)`
    expect(res.sql).toBe(`SELECT * FROM "public"."users" ${where} ORDER BY "id" ASC LIMIT 2`)
    expect(h.drivers[0].calls.map((c) => c.statement)).toEqual([
      res.sql,
      `SELECT COUNT(*) FROM "public"."users" ${where}`
    ])
    expect(res.totalRows).toBe(7)
  })

  it('rejects filters on unknown columns and side-effecting raw WHERE', async () => {
    const h = setup()
    await expect(
      h.engine.tableRows(
        {
          dataProjectId: 'dp-1',
          queryId: 'q',
          ref: { name: 'users' },
          filters: [{ column: 'zzz', operator: '=', value: '1' }],
          limit: 5,
          offset: 0
        },
        { clientId: null }
      )
    ).rejects.toMatchObject({ code: 'DATA_INVALID_INPUT' })
    await expect(
      h.engine.tableRows(
        {
          dataProjectId: 'dp-1',
          queryId: 'q',
          ref: { name: 'users' },
          where: 'id = 1; DELETE FROM users',
          limit: 5,
          offset: 0
        },
        { clientId: null }
      )
    ).rejects.toMatchObject({ code: 'DATA_INVALID_INPUT' })
  })
})

describe('applyEdits', () => {
  const edits = [{ kind: 'update' as const, key: { id: 1 }, changes: { name: 'x' } }]

  it('confirms in half-safe, then commits in one transaction', async () => {
    const h = setup()
    const req = { dataProjectId: 'dp-1', ref: { schema: 'public', name: 'users' }, edits }
    const first = await h.engine.applyEdits(req, { clientId: null })
    expect(first.status).toBe('confirmation_required')
    if (first.status !== 'confirmation_required') return
    expect(first.plan.statements[0].classification).toBe('write')
    const done = await h.engine.applyEdits(
      { ...req, confirmToken: first.confirmToken },
      { clientId: null }
    )
    expect(done).toMatchObject({
      status: 'ok',
      affectedRows: 1,
      statements: [`UPDATE "public"."users" SET "name" = 'x' WHERE "id" = 1`]
    })
    expect(h.drivers[0].calls.map((c) => c.statement)).toEqual([
      'BEGIN',
      `UPDATE "public"."users" SET "name" = 'x' WHERE "id" = 1`,
      'COMMIT'
    ])
    expect(h.repo.history.at(-1)).toMatchObject({ status: 'ok', rowCount: 1 })
  })

  it('rolls back when a row was changed underneath (0 rows)', async () => {
    const h = setup({ safeMode: 'off' })
    h.configure((d) => {
      d.handler = (sql) => ({
        output: {
          kind: 'command',
          affectedRows: sql.startsWith('UPDATE') ? 0 : null,
          message: 'ok'
        }
      })
    })
    await expect(
      h.engine.applyEdits(
        { dataProjectId: 'dp-1', ref: { schema: 'public', name: 'users' }, edits },
        { clientId: null }
      )
    ).rejects.toThrow(/matched no row/)
    expect(h.drivers[0].calls.map((c) => c.statement).at(-1)).toBe('ROLLBACK')
    expect(h.repo.history.at(-1)?.status).toBe('error')
  })

  it('is blocked in read-only mode and refused while the session has an open transaction', async () => {
    const ro = setup({ safeMode: 'read-only' })
    const blocked = await ro.engine.applyEdits(
      { dataProjectId: 'dp-1', ref: { name: 'users' }, edits },
      { clientId: null }
    )
    expect(blocked.status).toBe('blocked')
    const busy = setup({ safeMode: 'off' })
    busy.configure((d) => {
      d.inTransaction = true
    })
    await expect(
      busy.engine.applyEdits(
        { dataProjectId: 'dp-1', ref: { name: 'users' }, edits },
        { clientId: null }
      )
    ).rejects.toMatchObject({ code: 'DATA_BUSY' })
  })

  it('is refused while the MySQL session holds LOCK TABLES (its transaction would release them)', async () => {
    const h = setup({ engine: 'mysql', safeMode: 'off' })
    const locked = { inTransaction: false, tablesLocked: true }
    h.configure((d) => {
      d.sessionState = () => locked
    })
    await expect(
      h.engine.applyEdits(
        { dataProjectId: 'dp-1', ref: { database: 'shop', name: 'users' }, edits },
        { clientId: null }
      )
    ).rejects.toMatchObject({
      code: 'DATA_BUSY',
      message: expect.stringContaining('UNLOCK TABLES')
    })
    expect(h.drivers[0].calls).toEqual([])
  })

  it('previewEdits returns the statements without running anything', async () => {
    const h = setup()
    const sql = await h.engine.previewEdits('dp-1', { schema: 'public', name: 'users' }, [
      { kind: 'delete', key: { id: 4 } }
    ])
    expect(sql).toEqual(['DELETE FROM "public"."users" WHERE "id" = 4'])
    expect(h.drivers[0]?.calls ?? []).toHaveLength(0)
  })
})

describe('tableRows: page order and session mode', () => {
  const page = (h: ReturnType<typeof setup>, extra: Record<string, unknown> = {}) =>
    h.engine.tableRows(
      {
        dataProjectId: 'dp-1',
        queryId: `q-${Math.random()}`,
        ref: { database: 'shop', name: 'events' },
        limit: 3,
        offset: 6,
        ...extra
      },
      { clientId: null }
    )

  it('ClickHouse pages follow the sorting key unless the user sorted', async () => {
    const h = setup({ engine: 'clickhouse', config: { host: 'ch', database: 'shop' } })
    h.configure((d) => {
      d.details = details({
        ref: { database: 'shop', name: 'events' },
        primaryKey: [],
        properties: [{ label: 'Sorting key', value: 'id' }]
      })
      d.handler = () => rowsOutput(['id'], [[1]])
    })
    expect((await page(h)).sql).toBe('SELECT * FROM `shop`.`events` ORDER BY id LIMIT 3 OFFSET 6')
    expect((await page(h, { orderBy: [{ column: 'name', direction: 'desc' }] })).sql).toBe(
      'SELECT * FROM `shop`.`events` ORDER BY `name` DESC LIMIT 3 OFFSET 6'
    )
  })

  it('a sorting key the classifier refuses pages unordered instead of failing', async () => {
    const h = setup({ engine: 'clickhouse', config: { host: 'ch', database: 'shop' } })
    h.configure((d) => {
      d.details = details({
        ref: { database: 'shop', name: 'events' },
        primaryKey: [],
        properties: [{ label: 'Sorting key', value: 'id; DROP TABLE x' }]
      })
      d.handler = () => rowsOutput(['id'], [[1]])
    })
    expect((await page(h)).sql).toBe('SELECT * FROM `shop`.`events` LIMIT 3 OFFSET 6')
  })

  it('MySQL filter literals are quoted for the live session mode', async () => {
    const h = setup({ engine: 'mysql', config: { host: 'db', database: 'shop' } })
    h.configure((d) => {
      d.backslashEscapes = false
      d.details = details({ ref: { database: 'shop', name: 'users' } })
      d.handler = () => rowsOutput(['id'], [[1]])
    })
    const res = await page(h, {
      ref: { database: 'shop', name: 'users' },
      filters: [{ column: 'name', operator: '=', value: 'C:\\temp' }]
    })
    expect(res.sql).toBe(
      "SELECT * FROM `shop`.`users` WHERE (`name` = 'C:\\temp') ORDER BY `id` ASC LIMIT 3 OFFSET 6"
    )
  })
})

describe('applyEdits: MySQL backslash mode', () => {
  const edits = [{ kind: 'update' as const, key: { id: 1 }, changes: { name: 'C:\\temp\\new' } }]
  const mysql = { engine: 'mysql' as const, safeMode: 'off' as const, config: { database: 'shop' } }

  it('writes single backslashes under NO_BACKSLASH_ESCAPES (preview and save agree)', async () => {
    const h = setup(mysql)
    h.configure((d) => {
      d.backslashEscapes = false
    })
    const ref = { database: 'shop', name: 'users' }
    const expected = "UPDATE `shop`.`users` SET `name` = 'C:\\temp\\new' WHERE `id` = 1 LIMIT 1"
    expect(await h.engine.previewEdits('dp-1', ref, edits)).toEqual([expected])
    const res = await h.engine.applyEdits({ dataProjectId: 'dp-1', ref, edits }, { clientId: null })
    expect(res).toMatchObject({ status: 'ok', statements: [expected] })
    expect(h.drivers[0].calls.map((c) => c.statement)).toEqual([
      'START TRANSACTION',
      expected,
      'COMMIT'
    ])
  })

  it('refuses to save when the mode changed after the statements were built', async () => {
    const h = setup(mysql)
    h.configure((d) => {
      d.backslashEscapes = true
    })
    const manager = h.engine.connections
    const lookup = manager.backslashEscapes.bind(manager)
    manager.backslashEscapes = async (id, database) => {
      const mode = await lookup(id, database)
      // A queued `SET sql_mode = 'NO_BACKSLASH_ESCAPES'` lands before the save runs.
      h.drivers[0].backslashEscapes = !mode
      return mode
    }
    await expect(
      h.engine.applyEdits(
        { dataProjectId: 'dp-1', ref: { database: 'shop', name: 'users' }, edits },
        { clientId: null }
      )
    ).rejects.toMatchObject({ code: 'DATA_BUSY' })
    expect(h.drivers[0].calls).toHaveLength(0)
  })

  it('grid-edit history masks password literals', async () => {
    const h = setup({ safeMode: 'off' })
    h.configure((d) => {
      d.details = details({
        columns: [
          { name: 'id', type: 'int', nullable: false, isPrimaryKey: true, ordinal: 1 },
          { name: 'password', type: 'text', nullable: false, isPrimaryKey: false, ordinal: 2 }
        ]
      })
    })
    await h.engine.applyEdits(
      {
        dataProjectId: 'dp-1',
        ref: { schema: 'public', name: 'users' },
        edits: [{ kind: 'update', key: { id: 1 }, changes: { password: 'Hunter22' } }]
      },
      { clientId: null }
    )
    expect(h.repo.history.at(-1)?.text).not.toContain('Hunter22')
  })
})

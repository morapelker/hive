// SqliteSession / protocol handler tests on a copy of the seeded shop database, plus one raw
// protocol round trip through a forked child (the fixture entry stands in for the server
// bundle). Needs better-sqlite3 built for this runtime: run with the Electron runner
// (ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run <file>).

import { fork } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { DataTableDetails } from '../../../../shared/data-projects/types'
import {
  SqliteSession,
  SqliteWorkerFailure,
  commandTag,
  handleSqliteWorkerRequest,
  leadingWords,
  sqliteCell,
  sqliteErrorPosition,
  toSqliteWorkerError,
  type SqliteExecResult,
  type SqliteRowsPayload,
  type SqliteWorkerMessage,
  type SqliteWorkerRequest
} from './sqlite-worker'

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
const haveSeed = existsSync(SEED)
const describeSeed = sqliteAvailable && haveSeed ? describe : describe.skip

const ENTRY = join(__dirname, '__fixtures__', 'sqlite-worker-entry.cjs')

// realpath: SQLite reports resolved paths (/private/var/... on macOS).
const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'tedooo-sqlite-worker-')))
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }))

let copySeq = 0
const seedCopy = (): string => {
  const path = join(tmpRoot, `shop-${++copySeq}.sqlite`)
  copyFileSync(SEED, path)
  return path
}

const rowsOf = (result: SqliteExecResult): SqliteRowsPayload => {
  if (result.output.kind !== 'rows') throw new Error(`expected rows, got ${result.output.kind}`)
  return result.output
}

describe('sqlite-worker helpers', () => {
  it('converts values to exact JSON-safe cells', () => {
    expect(sqliteCell(null)).toBeNull()
    expect(sqliteCell(42n)).toBe(42)
    expect(sqliteCell(9223372036854775807n)).toBe('9223372036854775807')
    expect(sqliteCell(-9007199254740993n)).toBe('-9007199254740993')
    expect(sqliteCell(1.5)).toBe(1.5)
    expect(sqliteCell(Infinity)).toBe('Infinity')
    expect(sqliteCell('x')).toBe('x')
    const big = Buffer.alloc(100, 0xab)
    expect(sqliteCell(big)).toEqual({ $t: 'bin', hex: 'ab'.repeat(64), len: 100 })
    expect(sqliteCell(big, true)).toEqual({ $t: 'bin', hex: 'ab'.repeat(100), len: 100 })
  })

  it('reads leading words past comments and derives command tags', () => {
    expect(leadingWords('  -- hi\n /* x */ create temp table t(a)')).toEqual([
      'CREATE',
      'TEMP',
      'TABLE'
    ])
    expect(commandTag('CREATE TABLE t(a)')).toBe('CREATE TABLE')
    expect(commandTag('create unique index i on t(a)')).toBe('CREATE UNIQUE INDEX')
    expect(commandTag('INSERT INTO t VALUES (1)')).toBe('INSERT')
    expect(commandTag('-- only a comment')).toBe('OK')
  })

  it('locates syntax errors when the token is unambiguous', () => {
    expect(sqliteErrorPosition('near "SELEC": syntax error', 'SELEC 1')).toBe(0)
    expect(sqliteErrorPosition('near "FROM": syntax error', 'SELECT a, FROM t')).toBe(10)
    expect(sqliteErrorPosition('near "a": syntax error', 'SELECT a a a')).toBeUndefined()
    expect(sqliteErrorPosition('incomplete input', 'SELECT * FROM t WHERE   ')).toBe(21)
    expect(sqliteErrorPosition('no such table: x', 'SELECT * FROM x')).toBeUndefined()
  })

  it('serialises errors with codes, hints and the sandbox flag', () => {
    const busy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })
    expect(toSqliteWorkerError(busy)).toMatchObject({
      code: 'SQLITE_BUSY',
      hint: expect.stringContaining('locked')
    })
    const ro = Object.assign(new Error('attempt to write a readonly database'), {
      code: 'SQLITE_READONLY'
    })
    expect(toSqliteWorkerError(ro, 'DELETE FROM t', true).sandboxRejected).toBe(true)
    expect(toSqliteWorkerError(ro, 'DELETE FROM t', false).sandboxRejected).toBeUndefined()
    const failure = new SqliteWorkerFailure('nope', { code: 'X', hint: 'h' })
    expect(toSqliteWorkerError(failure)).toEqual({
      message: 'nope',
      code: 'X',
      hint: 'h',
      position: undefined,
      sandboxRejected: undefined
    })
    expect(
      toSqliteWorkerError(
        new RangeError('The supplied SQL string contains more than one statement')
      ).code
    ).toBe('SQLITE_MULTIPLE_STATEMENTS')
  })
})

describeSeed('SqliteSession on the shop seed', () => {
  let session: SqliteSession
  let path: string

  beforeEach(async () => {
    session?.close()
    path = seedCopy()
    session = new SqliteSession()
    const opened = await session.open({ path, readonly: false, create: false, busyTimeoutMs: 1000 })
    expect(opened.sqliteVersion).toMatch(/^3\./)
    expect(opened.fileSize).toBeGreaterThan(0)
    expect(opened.state).toEqual({ inTransaction: false, attached: [], tempObjects: 0 })
  })

  afterAll(() => session?.close())

  it('returns typed, exact cells and column metadata', () => {
    const res = rowsOf(
      session.exec({
        sql: "SELECT id, price, attributes, 9223372036854775807 AS big, x'00ff' AS b, NULL AS n, 1e999 AS inf FROM products ORDER BY id LIMIT 1",
        maxRows: 10,
        sandbox: false
      })
    )
    expect(res.columns.map((c) => c.name)).toEqual([
      'id',
      'price',
      'attributes',
      'big',
      'b',
      'n',
      'inf'
    ])
    expect(res.columns[0]).toEqual({
      name: 'id',
      type: 'INTEGER',
      table: 'products',
      database: 'main'
    })
    expect(res.columns[1].type).toBe('DECIMAL(10,2)')
    // Expression columns have no declared type: the storage class of the first value is used.
    expect(res.columns[3].type).toBe('INTEGER')
    expect(res.columns[4].type).toBe('BLOB')
    expect(res.columns[5].type).toBeUndefined()
    const [row] = res.rows
    expect(row[0]).toBe(1)
    expect(typeof row[1]).toBe('number')
    expect(JSON.parse(row[2] as string)).toHaveProperty('color')
    expect(row[3]).toBe('9223372036854775807')
    expect(row[4]).toEqual({ $t: 'bin', hex: '00ff', len: 2 })
    expect(row[5]).toBeNull()
    expect(row[6]).toBe('Infinity')
    expect(res.truncated).toBe(false)
  })

  it('reports columns for an empty result', () => {
    const res = rowsOf(
      session.exec({ sql: 'SELECT * FROM users WHERE 0', maxRows: 10, sandbox: false })
    )
    expect(res.rows).toEqual([])
    expect(res.columns.map((c) => `${c.name}:${c.type}`)).toEqual([
      'id:INTEGER',
      'name:VARCHAR(100)',
      'email:VARCHAR(200)',
      'country:CHAR(2)',
      'created_at:DATETIME',
      'is_banned:TINYINT(1)'
    ])
  })

  it('stops reading at maxRows and flags truncation', () => {
    const res = rowsOf(
      session.exec({ sql: 'SELECT * FROM order_items', maxRows: 10, sandbox: false })
    )
    expect(res.rows).toHaveLength(10)
    expect(res.truncated).toBe(true)
    expect(res.byteLimited).toBe(false)
    const exact = rowsOf(
      session.exec({ sql: 'SELECT * FROM users LIMIT 10', maxRows: 10, sandbox: false })
    )
    expect(exact.rows).toHaveLength(10)
    expect(exact.truncated).toBe(false)
  })

  it('runs writes as commands with affected rows and insert ids', () => {
    const insert = session.exec({
      sql: "INSERT INTO users (name, email, created_at) VALUES ('T', 'tmp_dpcs@example.com', '2026-01-01')",
      maxRows: 10,
      sandbox: false
    })
    expect(insert.output).toEqual({
      kind: 'command',
      message: 'INSERT',
      affectedRows: 1,
      lastInsertId: '201'
    })
    const update = session.exec({
      sql: 'UPDATE users SET is_banned = 1 WHERE id <= 3',
      maxRows: 10,
      sandbox: false
    })
    expect(update.output).toMatchObject({ affectedRows: 3, lastInsertId: null })
    const ddl = session.exec({ sql: 'CREATE TABLE tmp_dpcs_t (a)', maxRows: 10, sandbox: false })
    expect(ddl.output).toMatchObject({
      kind: 'command',
      message: 'CREATE TABLE',
      affectedRows: null
    })
    const returning = rowsOf(
      session.exec({
        sql: 'UPDATE users SET name = name WHERE id = 1 RETURNING id',
        maxRows: 10,
        sandbox: false
      })
    )
    expect(returning.rows).toEqual([[1]])
  })

  it('enforces foreign keys', () => {
    expect(() =>
      session.exec({
        sql: "INSERT INTO orders (user_id, status, total, created_at) VALUES (99999, 'paid', 1, '2026-01-01')",
        maxRows: 1,
        sandbox: false
      })
    ).toThrow(/FOREIGN KEY/)
  })

  it('refuses writes in the sandbox before they run and restores query_only', () => {
    expect(() => session.exec({ sql: 'DELETE FROM users', maxRows: 1, sandbox: true })).toThrow(
      SqliteWorkerFailure
    )
    try {
      session.exec({ sql: 'DELETE FROM users', maxRows: 1, sandbox: true })
    } catch (error) {
      expect(toSqliteWorkerError(error, 'DELETE FROM users', true)).toMatchObject({
        code: 'SQLITE_READONLY',
        sandboxRejected: true
      })
    }
    // Nothing ran.
    expect(
      rowsOf(session.exec({ sql: 'SELECT count(*) FROM users', maxRows: 1, sandbox: false })).rows
    ).toEqual([[200]])
    // query_only is ON while a sandboxed read runs, and back to OFF afterwards.
    const during = rowsOf(
      session.exec({ sql: 'SELECT * FROM pragma_query_only', maxRows: 1, sandbox: true })
    )
    expect(during.rows).toEqual([[1]])
    const after = rowsOf(
      session.exec({ sql: 'SELECT * FROM pragma_query_only', maxRows: 1, sandbox: false })
    )
    expect(after.rows).toEqual([[0]])
  })

  it('keeps a user-set query_only after a sandboxed read', () => {
    session.exec({ sql: 'PRAGMA query_only = ON', maxRows: 1, sandbox: false })
    session.exec({ sql: 'SELECT 1', maxRows: 1, sandbox: true })
    expect(
      rowsOf(session.exec({ sql: 'SELECT * FROM pragma_query_only', maxRows: 1, sandbox: false }))
        .rows
    ).toEqual([[1]])
  })

  it('treats a comment-only statement as nothing to run', () => {
    const res = session.exec({ sql: '-- nothing', maxRows: 1, sandbox: false })
    expect(res.output).toMatchObject({ kind: 'command' })
  })

  it('tracks transactions, temp objects and attachments in the state', () => {
    expect(session.exec({ sql: 'BEGIN', maxRows: 1, sandbox: false }).state.inTransaction).toBe(
      true
    )
    expect(session.exec({ sql: 'ROLLBACK', maxRows: 1, sandbox: false }).state.inTransaction).toBe(
      false
    )
    expect(
      session.exec({ sql: 'CREATE TEMP TABLE tt (a)', maxRows: 1, sandbox: false }).state
        .tempObjects
    ).toBe(1)
    const other = seedCopy()
    const attached = session.exec({
      sql: `ATTACH DATABASE '${other}' AS other`,
      maxRows: 1,
      sandbox: false
    })
    expect(attached.state.attached).toEqual([{ name: 'other', file: other }])
  })

  it('lists objects with exact counts and sizes', () => {
    const objects = session.introspect({ kind: 'objects', schema: 'main' }) as Array<{
      name: string
      kind: string
      rowEstimate?: number | null
      sizeBytes?: number | null
      detail?: string
    }>
    const byName = new Map(objects.map((o) => [o.name, o]))
    expect(byName.get('users')).toMatchObject({ kind: 'table', rowEstimate: 200 })
    expect(byName.get('products')).toMatchObject({ kind: 'table', rowEstimate: 120 })
    expect(byName.get('orders')).toMatchObject({ kind: 'table', rowEstimate: 2000 })
    expect(byName.get('order_items')).toMatchObject({ kind: 'table', rowEstimate: 4997 })
    expect(byName.get('daily_revenue')).toMatchObject({ kind: 'view' })
    // Table size includes its indexes (orders + idx_created).
    expect(byName.get('orders')?.sizeBytes).toBeGreaterThan(98_304)
    expect([...byName.keys()].some((n) => n.startsWith('sqlite_'))).toBe(false)
  })

  it('describes tables: columns, primary key, indexes, named foreign keys', () => {
    const orders = session.introspect({
      kind: 'describe',
      schema: 'main',
      name: 'orders'
    }) as DataTableDetails
    expect(orders.kind).toBe('table')
    expect(orders.primaryKey).toEqual(['id'])
    expect(orders.columns[0]).toMatchObject({
      name: 'id',
      isPrimaryKey: true,
      nullable: false,
      autoIncrement: true,
      extra: 'AUTOINCREMENT'
    })
    expect(orders.columns.find((c) => c.name === 'status')).toMatchObject({
      type: 'TEXT',
      nullable: false
    })
    expect(orders.indexes.map((i) => i.name)).toEqual(['PRIMARY KEY', 'idx_created'])
    expect(orders.indexes[1]).toMatchObject({
      columns: ['created_at'],
      unique: false,
      definition: expect.stringContaining('CREATE INDEX')
    })
    expect(orders.foreignKeys).toEqual([
      {
        name: 'fk_orders_user',
        columns: ['user_id'],
        refTable: 'users',
        refColumns: ['id'],
        onUpdate: 'NO ACTION',
        onDelete: 'NO ACTION'
      }
    ])
    expect(orders.rowEstimate).toBe(2000)

    const items = session.introspect({
      kind: 'describe',
      schema: 'main',
      name: 'order_items'
    }) as typeof orders
    expect(items.foreignKeys.map((f) => [f.name, f.refTable, f.onDelete])).toEqual([
      ['fk_items_order', 'orders', 'CASCADE'],
      ['fk_items_product', 'products', 'NO ACTION']
    ])
    const users = session.introspect({
      kind: 'describe',
      schema: 'main',
      name: 'users'
    }) as typeof orders
    expect(users.indexes.find((i) => i.unique && !i.primary)).toMatchObject({
      columns: ['email'],
      type: 'unique constraint'
    })
    const view = session.introspect({
      kind: 'describe',
      schema: 'main',
      name: 'daily_revenue'
    }) as typeof orders
    expect(view.kind).toBe('view')
    expect(view.columns.map((c) => c.name)).toEqual(['day', 'orders', 'revenue'])
    expect(() => session.introspect({ kind: 'describe', schema: 'main', name: 'nope' })).toThrow(
      /No table or view/
    )
    expect(() => session.introspect({ kind: 'describe', schema: 'nodb', name: 'users' })).toThrow(
      /Unknown database/
    )
  })

  it('builds DDL with indexes and triggers', () => {
    session.exec({
      sql: 'CREATE TRIGGER tmp_dpcs_trg AFTER INSERT ON orders BEGIN SELECT 1; END',
      maxRows: 1,
      sandbox: false
    })
    const ddl = session.introspect({ kind: 'ddl', schema: 'main', name: 'orders' }) as string
    expect(ddl).toMatch(/^CREATE TABLE orders/)
    expect(ddl).toContain('CREATE INDEX idx_created ON orders(created_at);')
    expect(ddl).toContain('CREATE TRIGGER tmp_dpcs_trg')
    const view = session.introspect({
      kind: 'ddl',
      schema: 'main',
      name: 'daily_revenue'
    }) as string
    expect(view).toMatch(/^CREATE VIEW daily_revenue/)
  })

  it('produces a completion snapshot', () => {
    const snap = session.introspect({ kind: 'completion', schema: 'main', maxTables: 100 }) as {
      tables: Array<{ name: string; kind: string; columns: Array<{ name: string }> }>
      databases: string[]
      functions: string[]
      truncated: boolean
    }
    expect(snap.databases).toEqual(['main'])
    expect(snap.tables.find((t) => t.name === 'users')?.columns.map((c) => c.name)).toContain(
      'email'
    )
    expect(snap.tables.find((t) => t.name === 'daily_revenue')?.kind).toBe('view')
    expect(snap.functions).toContain('json_extract')
    expect(snap.truncated).toBe(false)
    const capped = session.introspect({
      kind: 'completion',
      schema: 'main',
      maxTables: 2
    }) as typeof snap
    expect(capped.tables).toHaveLength(2)
    expect(capped.truncated).toBe(true)
  })

  it('introspects an attached database after syncing attachments', () => {
    const other = seedCopy()
    const objects = session.introspect({
      kind: 'objects',
      schema: 'other',
      attach: [{ name: 'other', file: other }]
    }) as Array<{
      name: string
    }>
    expect(objects.map((o) => o.name)).toContain('users')
    // Dropping it from the wanted list detaches it.
    session.introspect({ kind: 'state', attach: [] })
    expect(() => session.introspect({ kind: 'objects', schema: 'other' })).toThrow(
      /Unknown database/
    )
  })

  it('streams every row in batches with full binary values', async () => {
    const batches: number[] = []
    let columns: string[] = []
    const res = await session.stream(
      { sql: 'SELECT * FROM order_items', sandbox: true, batchSize: 1000 },
      async (cols, rows) => {
        columns = cols
        batches.push(rows.length)
      }
    )
    expect(res.rows).toBe(4997)
    expect(batches).toEqual([1000, 1000, 1000, 1000, 997])
    expect(columns).toEqual(['id', 'order_id', 'product_id', 'quantity', 'unit_price'])

    const empty: number[] = []
    await session.stream(
      { sql: 'SELECT * FROM users WHERE 0', sandbox: false, batchSize: 10 },
      async (_c, rows) => {
        empty.push(rows.length)
      }
    )
    expect(empty).toEqual([0])

    let blob: unknown
    await session.stream(
      { sql: 'SELECT zeroblob(100) AS b', sandbox: false, batchSize: 10 },
      async (_c, rows) => {
        blob = rows[0][0]
      }
    )
    expect(blob).toEqual({ $t: 'bin', hex: '00'.repeat(100), len: 100 })

    await expect(
      session.stream(
        { sql: 'DELETE FROM users', sandbox: false, batchSize: 10 },
        async () => undefined
      )
    ).rejects.toThrow(/return rows/)
  })

  it('stops a stream when the consumer throws', async () => {
    let calls = 0
    await expect(
      session.stream(
        { sql: 'SELECT * FROM order_items', sandbox: false, batchSize: 100 },
        async () => {
          calls++
          if (calls === 2) throw new Error('disk full')
        }
      )
    ).rejects.toThrow('disk full')
    expect(calls).toBe(2)
    // The statement was finalized: the connection is usable again.
    expect(rowsOf(session.exec({ sql: 'SELECT 1', maxRows: 1, sandbox: false })).rows).toEqual([
      [1]
    ])
  })

  it('maps request failures to plain error results', async () => {
    const noop = async (): Promise<void> => undefined
    const bad = await handleSqliteWorkerRequest(
      session,
      { id: 7, op: 'exec', params: { sql: 'SELECT * FROM nope', maxRows: 1, sandbox: false } },
      noop
    )
    expect(bad).toMatchObject({
      type: 'result',
      id: 7,
      ok: false,
      error: { code: 'SQLITE_ERROR', message: 'no such table: nope' }
    })
    const syntax = await handleSqliteWorkerRequest(
      session,
      { id: 8, op: 'exec', params: { sql: 'SELEC 1', maxRows: 1, sandbox: false } },
      noop
    )
    expect(syntax).toMatchObject({ ok: false, error: { position: 0 } })
    const sandbox = await handleSqliteWorkerRequest(
      session,
      { id: 9, op: 'exec', params: { sql: 'DROP TABLE users', maxRows: 1, sandbox: true } },
      noop
    )
    expect(sandbox).toMatchObject({ ok: false, error: { sandboxRejected: true } })
    const ok = await handleSqliteWorkerRequest(
      session,
      { id: 10, op: 'introspect', query: { kind: 'state' } },
      noop
    )
    expect(ok).toMatchObject({ ok: true, value: { inTransaction: false } })
  })
})

describeSeed('SqliteSession open', () => {
  it('fails clearly for a missing file unless asked to create it', async () => {
    const session = new SqliteSession()
    const missing = join(tmpRoot, 'missing.sqlite')
    await expect(
      session.open({ path: missing, readonly: false, create: false, busyTimeoutMs: 100 })
    ).rejects.toMatchObject({
      code: 'SQLITE_CANTOPEN'
    })
    const opened = await session.open({
      path: missing,
      readonly: false,
      create: true,
      busyTimeoutMs: 100
    })
    expect(opened.state.tempObjects).toBe(0)
    session.close()
    expect(existsSync(missing)).toBe(true)
  })

  it('rejects a file that is not a database', async () => {
    const path = join(tmpRoot, 'not-a-db.sqlite')
    writeFileSync(path, 'hello, this is not sqlite at all, really not a database file....')
    const session = new SqliteSession()
    await expect(
      session.open({ path, readonly: false, create: false, busyTimeoutMs: 100 })
    ).rejects.toMatchObject({
      code: 'SQLITE_NOTADB'
    })
  })

  it('opens read-only files read-only', async () => {
    const session = new SqliteSession()
    await session.open({ path: seedCopy(), readonly: true, create: false, busyTimeoutMs: 100 })
    expect(() => session.exec({ sql: 'DELETE FROM users', maxRows: 1, sandbox: false })).toThrow(
      /readonly/
    )
    session.close()
  })

  it('re-attaches databases on open and reports the ones that fail', async () => {
    const session = new SqliteSession()
    const other = seedCopy()
    const opened = await session.open({
      path: seedCopy(),
      readonly: false,
      create: false,
      busyTimeoutMs: 100,
      attach: [
        { name: 'other', file: other },
        { name: 'gone', file: join(tmpRoot, 'no-dir', 'gone.sqlite') }
      ]
    })
    expect(opened.state.attached).toEqual([{ name: 'other', file: other }])
    expect(opened.attachWarnings).toHaveLength(1)
    expect(opened.attachWarnings[0]).toMatch(/^gone: /)
    session.close()
  })
})

describeSeed('sqlite worker child process (raw protocol)', () => {
  it('speaks the protocol over IPC: ready, open, exec, stream with acks, close', async () => {
    const child = fork(ENTRY, [], {
      execPath: process.execPath,
      execArgv: [],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HIVE_DATA_SQLITE_WORKER: '1' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      serialization: 'json'
    })
    let stderr = ''
    child.stderr?.on('data', (d) => (stderr += String(d)))
    const messages: SqliteWorkerMessage[] = []
    const waiters: Array<(m: SqliteWorkerMessage) => boolean> = []
    child.on('message', (raw) => {
      const m = raw as SqliteWorkerMessage
      messages.push(m)
      for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i](m)) waiters.splice(i, 1)
    })
    const next = (pred: (m: SqliteWorkerMessage) => boolean): Promise<SqliteWorkerMessage> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout; stderr: ${stderr}`)), 20_000)
        const existing = messages.find(pred)
        if (existing) {
          clearTimeout(timer)
          resolve(existing)
          return
        }
        waiters.push((m) => {
          if (!pred(m)) return false
          clearTimeout(timer)
          resolve(m)
          return true
        })
      })
    const send = (req: SqliteWorkerRequest): void => {
      child.send(req)
    }
    const result = (id: number) => next((m) => m.type === 'result' && m.id === id)

    await next((m) => m.type === 'ready')
    send({
      id: 1,
      op: 'open',
      params: { path: seedCopy(), readonly: false, create: false, busyTimeoutMs: 1000 }
    })
    expect(await result(1)).toMatchObject({ ok: true })
    send({
      id: 2,
      op: 'exec',
      params: { sql: 'SELECT id, email FROM users ORDER BY id', maxRows: 3, sandbox: true }
    })
    const exec = (await result(2)) as Extract<SqliteWorkerMessage, { type: 'result'; ok: true }>
    const payload = (exec.value as SqliteExecResult).output as SqliteRowsPayload
    expect(payload.rows).toEqual([
      [1, 'shira.levi1@example.com'],
      [2, 'omer.mizrahi2@example.com'],
      [3, 'tal.levi3@example.com']
    ])
    expect(payload.truncated).toBe(true)

    send({ id: 3, op: 'exec', params: { sql: 'DELETE FROM users', maxRows: 1, sandbox: true } })
    expect(await result(3)).toMatchObject({
      ok: false,
      error: { sandboxRejected: true, code: 'SQLITE_READONLY' }
    })

    // Flow control: the child sends one batch and waits for our ack before the next.
    send({
      id: 4,
      op: 'stream',
      params: { sql: 'SELECT id FROM orders', sandbox: true, batchSize: 500 }
    })
    let batches = 0
    for (;;) {
      const m = await next(
        (x) =>
          (x.type === 'batch' && x.id === 4 && !(x as { seen?: boolean }).seen) ||
          (x.type === 'result' && x.id === 4)
      )
      if (m.type === 'result') {
        expect(m).toMatchObject({ ok: true, value: { rows: 2000 } })
        break
      }
      ;(m as { seen?: boolean }).seen = true
      batches++
      // No second batch may arrive before the ack.
      expect(messages.filter((x) => x.type === 'batch' && x.id === 4).length).toBe(batches)
      send({ id: 4, op: 'ack' })
    }
    expect(batches).toBe(4)

    const exited = new Promise<number | null>((resolve) =>
      child.once('exit', (code) => resolve(code))
    )
    send({ id: 5, op: 'close' })
    expect(await result(5)).toMatchObject({ ok: true })
    expect(await exited).toBe(0)
  }, 30_000)
})

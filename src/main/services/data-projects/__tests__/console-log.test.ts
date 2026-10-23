// The console log: the in-memory log itself (masking with the `masked` flag, caps, rings,
// list/since/clear, live batches, the watch lease a console's list takes), the instrumented
// driver behind the real engine (every path files its statements under the right source),
// driver-reported statements with their bind values written in, and MongoDB command monitoring
// (on per pooled connection only while a console follows the project).
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Binary, Decimal128, Long, MinKey, ObjectId, Timestamp, UUID } from 'bson'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  DATA_CONSOLE_CHANNEL,
  DATA_CONSOLE_MAX_TEXT,
  type DataConsoleEntry,
  type DataConsoleEvent
} from '../../../../shared/data-projects/console-types'
import type { DataTableDetails } from '../../../../shared/data-projects/types'
import { DataDriverError, type DataProjectRecord, type DriverConnectInput } from '../contracts'
import { noopLogger } from '../connection-manager'
import {
  DataConsoleLog,
  inlineBindValues,
  instrumentDriver,
  mongoCommandText,
  mongoReplyCounts,
  traceDriverStatement,
  withConsoleSource,
  type ConsoleEntry
} from '../console-log'
import { createDataEngineService, type DataEngineServiceInternals } from '../engine-service'
import { createSafetyGate } from '../safety-gate'
import {
  FakeDriver,
  MemoryRepository,
  MemorySecrets,
  makeRecord,
  rowsOutput
} from './engine-fixtures'

const entry = (log: DataConsoleLog, id = 'dp-1'): DataConsoleEntry[] => log.list(id).entries

describe('DataConsoleLog', () => {
  it('masks secrets like history, redacts known secrets and caps the text', () => {
    const log = new DataConsoleLog()
    log.record({
      dataProjectId: 'dp-1',
      engine: 'mysql',
      source: 'query',
      text: "CREATE USER bob IDENTIFIED BY 's3cret-pw' -- hunter2",
      redact: (t) => t.replace(/hunter2/g, '***')
    })
    log.record({
      dataProjectId: 'dp-1',
      engine: 'mongodb',
      source: 'query',
      text: 'db.createUser({ user: "x", pwd: "p@ss" })'
    })
    log.record({
      dataProjectId: 'dp-1',
      engine: 'postgres',
      source: 'query',
      text: `SELECT '${'x'.repeat(DATA_CONSOLE_MAX_TEXT + 50)}'`,
      error: "syntax error near PASSWORD 'leak'"
    })
    const [mysql, mongo, long] = entry(log)
    expect(mysql.text).not.toContain('s3cret-pw')
    expect(mysql.text).not.toContain('hunter2')
    expect(mysql).toMatchObject({ language: 'sql', status: 'ok', source: 'query' })
    expect(mongo.text).not.toContain('p@ss')
    expect(mongo.language).toBe('mongo')
    expect(long.text).toHaveLength(DATA_CONSOLE_MAX_TEXT)
    expect(long.truncated).toBe(true)
    expect(long.status).toBe('error')
    expect(long.error).not.toContain('leak')
  })

  it('flags entries whose text was masked or redacted: they are not the statement that ran', () => {
    const log = new DataConsoleLog()
    const add = (engine: 'postgres' | 'mysql' | 'mongodb', text: string, secret?: string) =>
      log.record({
        dataProjectId: 'dp-1',
        engine,
        source: 'edit',
        text,
        redact: secret ? (t) => t.split(secret).join('***') : undefined
      }) as ConsoleEntry
    const update = add('postgres', `UPDATE "users" SET "password" = 'n3wPass' WHERE "id" = 7`)
    expect(update.text).toBe(`UPDATE "users" SET "password" = '***' WHERE "id" = 7`)
    expect(update.masked).toBe(true)
    expect(add('mysql', "ALTER USER app IDENTIFIED BY 'pw'").masked).toBe(true)
    expect(add('mongodb', 'db.createUser({ user: "x", pwd: "p@ss" })').masked).toBe(true)
    expect(add('postgres', "SELECT 'tok-123' AS t", 'tok-123').masked).toBe(true)
    const plain = add('postgres', 'SELECT * FROM users WHERE id = 7')
    expect(plain.masked).toBeUndefined()
    expect('masked' in plain).toBe(false)
  })

  it('takes a list as a console following the project, for a lease', () => {
    let now = 1_000
    const log = new DataConsoleLog({ now: () => now, watchLeaseMs: 500 })
    expect(log.isWatched('dp-1')).toBe(false)
    log.list('dp-1')
    expect(log.isWatched('dp-1')).toBe(true)
    expect(log.isWatched('dp-2')).toBe(false)
    now += 499
    expect(log.isWatched('dp-1')).toBe(true)
    log.list('dp-1', 3) // the open tab's renewal
    now += 499
    expect(log.isWatched('dp-1')).toBe(true)
    now += 1
    expect(log.isWatched('dp-1')).toBe(false)
    log.watch('dp-1')
    log.forget('dp-1')
    expect(log.isWatched('dp-1')).toBe(false)
  })

  it('keeps statements and metadata in separate rings and lists them by seq', () => {
    const log = new DataConsoleLog({ maxEntries: 3 })
    const add = (source: 'query' | 'metadata', text: string): void => {
      log.record({ dataProjectId: 'dp-1', engine: 'postgres', source, text })
    }
    add('query', 'SELECT 1')
    for (let i = 0; i < 10; i++) add('metadata', `SELECT ${i} FROM pg_catalog.pg_class`)
    add('query', 'SELECT 2')
    const all = entry(log)
    // The polling metadata never pushed the user's statements out.
    expect(all.filter((e) => e.source === 'query').map((e) => e.text)).toEqual([
      'SELECT 1',
      'SELECT 2'
    ])
    expect(all.filter((e) => e.source === 'metadata')).toHaveLength(3)
    expect(all.map((e) => e.seq)).toEqual([...all.map((e) => e.seq)].sort((a, b) => a - b))
    const last = all.at(-1)!.seq
    expect(log.list('dp-1', last - 1).entries.map((e) => e.text)).toEqual(['SELECT 2'])
    expect(log.list('other').entries).toEqual([])
    expect(log.list('dp-1').epoch).toBe(log.epoch)
  })

  it('publishes batched entries per project and a clear event', () => {
    const events: Array<{ channel: string; payload: DataConsoleEvent }> = []
    const log = new DataConsoleLog({
      publish: (channel, payload) => events.push({ channel, payload: payload as DataConsoleEvent }),
      flushMs: 10_000
    })
    log.record({ dataProjectId: 'a', engine: 'sqlite', source: 'query', text: 'SELECT 1' })
    log.record({ dataProjectId: 'a', engine: 'sqlite', source: 'table', text: 'SELECT 2' })
    log.record({ dataProjectId: 'b', engine: 'sqlite', source: 'query', text: 'SELECT 3' })
    expect(events).toEqual([])
    log.flush()
    expect(events.map((e) => e.channel)).toEqual([DATA_CONSOLE_CHANNEL, DATA_CONSOLE_CHANNEL])
    const a = events.find((e) => e.payload.dataProjectId === 'a')!.payload
    expect(a.kind === 'entries' && a.entries.map((e) => e.text)).toEqual(['SELECT 1', 'SELECT 2'])
    log.clear('a')
    expect(events.at(-1)!.payload).toEqual({
      dataProjectId: 'a',
      epoch: log.epoch,
      kind: 'cleared'
    })
    expect(entry(log, 'a')).toEqual([])
    expect(entry(log, 'b')).toHaveLength(1)
  })

  it('never throws, whatever the input', () => {
    const log = new DataConsoleLog()
    expect(
      log.record({
        dataProjectId: 'dp-1',
        engine: 'postgres',
        source: 'query',
        text: 'SELECT 1',
        redact: () => {
          throw new Error('boom')
        }
      })?.text
    ).toMatch(/could not be checked/)
    expect(
      log.record({ dataProjectId: 'dp-1', engine: 'postgres', source: 'query', text: '   ' })
    ).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
// Through the engine
// ---------------------------------------------------------------------------------------------

const details = (): DataTableDetails => ({
  ref: { name: 'users', schema: 'public', database: 'shop' },
  kind: 'table',
  columns: [
    { name: 'id', type: 'int', nullable: false, isPrimaryKey: true, ordinal: 1 },
    { name: 'name', type: 'text', nullable: true, isPrimaryKey: false, ordinal: 2 }
  ],
  indexes: [],
  foreignKeys: [],
  triggers: [],
  primaryKey: ['id'],
  rowEstimate: 10
})

let engines: DataEngineServiceInternals[] = []
let dir = ''
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tedooo-console-test-'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})
afterEach(async () => {
  for (const e of engines) await e.shutdown()
  engines = []
})

function setup(record: Partial<DataProjectRecord> = {}) {
  const log = new DataConsoleLog()
  const drivers: FakeDriver[] = []
  let configure: (d: FakeDriver) => void = () => {}
  const engine = createDataEngineService({
    repository: new MemoryRepository([makeRecord({ safeMode: 'off', ...record })]),
    secrets: new MemorySecrets(),
    publish: () => {},
    createDriver: (input: DriverConnectInput) => {
      const d = new FakeDriver(input)
      d.details = details()
      configure(d)
      drivers.push(d)
      return instrumentDriver(d, input, log)
    },
    showSaveDialog: async () => null,
    gate: createSafetyGate(),
    logger: noopLogger
  })
  engines.push(engine)
  return {
    engine,
    log,
    drivers,
    entries: () => log.list('dp-1').entries,
    statements: () => log.list('dp-1').entries.filter((e) => e.source !== 'metadata'),
    configure: (fn: (d: FakeDriver) => void) => {
      configure = fn
      drivers.forEach(fn)
    }
  }
}

describe('instrumented drivers', () => {
  it('files editor statements under query and schema actions under structure', async () => {
    const h = setup()
    h.configure((d) => {
      d.handler = (sql) =>
        sql.startsWith('SELECT')
          ? rowsOutput(['n'], [[1], [2]])
          : { output: { kind: 'command', affectedRows: 3 } }
    })
    await h.engine.execute(
      {
        dataProjectId: 'dp-1',
        queryId: 'q1',
        text: 'SELECT 1; UPDATE t SET a = 1 WHERE id > 0',
        limit: null,
        source: 'editor',
        database: 'shop'
      },
      { clientId: null }
    )
    await h.engine.execute(
      {
        dataProjectId: 'dp-1',
        queryId: 'q2',
        text: 'ALTER TABLE t ADD c int',
        limit: null,
        source: 'schema-action'
      },
      { clientId: null }
    )
    expect(h.statements().map((e) => [e.source, e.text, e.rows, e.affected, e.database])).toEqual([
      ['query', 'SELECT 1', 2, null, 'shop'],
      ['query', 'UPDATE t SET a = 1 WHERE id > 0', null, 3, 'shop'],
      ['structure', 'ALTER TABLE t ADD c int', null, 3, 'shop']
    ])
    // The connection itself shows up as metadata (the fake driver reports no SQL of its own).
    expect(h.entries().find((e) => e.source === 'metadata')).toMatchObject({
      text: '-- connect',
      summary: true
    })
  })

  it('records failures and cancels with their status', async () => {
    const h = setup()
    h.configure((d) => {
      d.handler = (sql) => {
        if (sql.includes('boom')) throw new DataDriverError('relation "boom" does not exist')
        return new Promise(() => {})
      }
    })
    await h.engine.execute(
      {
        dataProjectId: 'dp-1',
        queryId: 'q1',
        text: 'SELECT * FROM boom',
        limit: null,
        source: 'editor'
      },
      { clientId: null }
    )
    const running = h.engine.execute(
      {
        dataProjectId: 'dp-1',
        queryId: 'q2',
        text: 'SELECT pg_sleep(10)',
        limit: null,
        source: 'editor'
      },
      { clientId: null }
    )
    await new Promise((r) => setTimeout(r, 5))
    await h.engine.cancel('q2')
    await running
    expect(h.statements().map((e) => [e.text, e.status, e.error])).toEqual([
      ['SELECT * FROM boom', 'error', 'relation "boom" does not exist'],
      ['SELECT pg_sleep(10)', 'cancelled', 'canceling statement due to user request']
    ])
  })

  it('files table pages and counts under table, grid edits under edit, exports under export', async () => {
    const h = setup()
    h.configure((d) => {
      d.handler = (sql) =>
        sql.startsWith('SELECT COUNT')
          ? rowsOutput(['count'], [['40']])
          : sql.startsWith('SELECT')
            ? rowsOutput(['id'], [[1], [2]])
            : { output: { kind: 'command', affectedRows: 1 } }
      d.streamBatches = [{ columns: ['id'], rows: [[1], [2], [3]] }]
    })
    await h.engine.tableRows(
      {
        dataProjectId: 'dp-1',
        queryId: 't1',
        ref: { schema: 'public', name: 'users', database: 'shop' },
        filters: [
          { column: 'id', operator: '=', value: '1' },
          { column: 'name', operator: 'is null' }
        ],
        filterJoin: 'or',
        limit: 2,
        offset: 0
      },
      { clientId: null }
    )
    await h.engine.applyEdits(
      {
        dataProjectId: 'dp-1',
        ref: { schema: 'public', name: 'users', database: 'shop' },
        edits: [{ kind: 'update', key: { id: 1 }, changes: { name: 'x' } }]
      },
      { clientId: null }
    )
    await h.engine.exportStart(
      {
        dataProjectId: 'dp-1',
        exportId: 'e1',
        source: { kind: 'table', ref: { schema: 'public', name: 'users' } },
        format: 'csv',
        filePath: join(dir, 'users.csv')
      },
      { clientId: null }
    )
    expect(h.statements().map((e) => [e.source, e.text, e.rows ?? e.affected])).toEqual([
      [
        'table',
        `SELECT * FROM "public"."users" WHERE ("id" = '1' OR "name" IS NULL) ORDER BY "id" ASC LIMIT 2`,
        2
      ],
      ['table', `SELECT COUNT(*) FROM "public"."users" WHERE ("id" = '1' OR "name" IS NULL)`, 1],
      ['edit', 'BEGIN', 1],
      ['edit', `UPDATE "public"."users" SET "name" = 'x' WHERE "id" = 1`, 1],
      ['edit', 'COMMIT', 1],
      ['export', 'SELECT * FROM "public"."users"', 3]
    ])
    // The describe the table view needed is metadata (one summary: the fake reports no SQL).
    expect(h.entries().filter((e) => e.text.startsWith('-- describe'))).toHaveLength(1)
  })

  it('logs introspection as metadata summaries, kills as admin, and the AI sample read as assistant', async () => {
    const h = setup({ allowAiDataAccess: true })
    await h.engine.databases('dp-1')
    await h.engine.objects('dp-1', 'shop', 'public')
    await h.engine.ddl('dp-1', { database: 'shop', schema: 'public', name: 'users' })
    await h.engine.processes('dp-1')
    await h.engine.kill('dp-1', '42', 'query')
    h.configure((d) => {
      d.handler = () => rowsOutput(['id'], [[1]])
    })
    await h.engine.sampleRows('dp-1', { schema: 'public', name: 'users' }, 5)
    expect(h.entries().map((e) => [e.source, e.text, e.rows])).toEqual([
      ['metadata', '-- connect', null],
      ['metadata', '-- list databases', 2],
      ['metadata', '-- list objects of shop.public', 0],
      ['metadata', '-- DDL of shop.public.users', null],
      ['metadata', '-- list processes', 0],
      ['admin', '-- kill query 42', null],
      ['assistant', 'SELECT * FROM "public"."users" LIMIT 5', 1]
    ])
  })

  it('logs the statements a driver reports instead of a summary, and its own housekeeping as metadata', async () => {
    const h = setup()
    h.configure((d) => {
      d.listDatabases = async () =>
        traceDriverStatement(
          'SELECT datname FROM pg_database',
          async () => [{ name: 'shop' }],
          (r) => ({ rows: r.length })
        )
      const execute = d.execute.bind(d)
      d.execute = async (statement, options) => {
        await traceDriverStatement('SET statement_timeout = 0', async () => undefined)
        // A report of the statement being executed is not logged twice.
        return traceDriverStatement(statement, () => execute(statement, options))
      }
    })
    await h.engine.databases('dp-1')
    await h.engine.execute(
      {
        dataProjectId: 'dp-1',
        queryId: 'q',
        text: 'DELETE FROM t WHERE id = 1',
        limit: null,
        source: 'editor'
      },
      { clientId: null }
    )
    expect(h.entries().map((e) => [e.source, e.text, e.summary ?? false])).toEqual([
      ['metadata', '-- connect', true],
      ['metadata', 'SELECT datname FROM pg_database', false],
      ['metadata', 'SET statement_timeout = 0', false],
      ['query', 'DELETE FROM t WHERE id = 1', false]
    ])
    // Outside an instrumented call, a report just runs.
    await expect(traceDriverStatement('SELECT 1', async () => 7)).resolves.toBe(7)
  })

  it('logs reported statements with their bind values in place of the placeholders', async () => {
    const h = setup()
    h.configure((d) => {
      d.describe = async (ref) =>
        traceDriverStatement(
          'SELECT attname FROM pg_attribute WHERE attrelid = $2::regclass AND $1 = $1',
          async () => ({ columns: [], name: ref.name }) as never,
          undefined,
          [true, `"public"."users"`]
        )
    })
    await h.engine.describe('dp-1', { name: 'users', schema: 'public', kind: 'table' })
    expect(h.entries().map((e) => [e.source, e.text, e.summary ?? false])).toContainEqual([
      'metadata',
      `SELECT attname FROM pg_attribute WHERE attrelid = '"public"."users"'::regclass AND TRUE = TRUE`,
      false
    ])
  })

  it('wraps once and passes everything else through to the driver', async () => {
    const log = new DataConsoleLog()
    const input = { project: makeRecord(), secrets: {}, redact: (t: string) => t }
    const fake = new FakeDriver(input)
    const driver = instrumentDriver(fake, input, log)
    expect(instrumentDriver(driver, input, log)).toBe(driver)
    expect(driver.isConnected).toBe(driver.isConnected)
    await driver.connect()
    expect(driver.isConnected()).toBe(true)
    expect(driver.sessionState()).toEqual(fake.sessionState())
    expect(driver.engine).toBe('postgres')
    // A caller scope names the source of whatever the driver is asked to run.
    await withConsoleSource('assistant', () =>
      driver.execute('SELECT 1', { limit: null, hardCap: 1, readOnlySandbox: true })
    )
    expect(log.list('dp-1').entries.at(-1)).toMatchObject({ source: 'assistant', text: 'SELECT 1' })
  })
})

// ---------------------------------------------------------------------------------------------
// MongoDB
// ---------------------------------------------------------------------------------------------

describe('Mongo command text', () => {
  it('writes runnable mongosh without the driver envelope', () => {
    const { text, summary } = mongoCommandText('find', {
      find: 'orders',
      filter: {
        _id: new ObjectId('64b0c0ffee0000000000abcd'),
        total: { $gt: Long.fromString('9007199254740993') },
        price: Decimal128.fromString('1.10'),
        at: new Date('2026-01-02T03:04:05.000Z'),
        name: /^an/i,
        'a.b': new MinKey(),
        ts: new Timestamp({ t: 5, i: 2 }),
        bin: new Binary(Buffer.from('hi')),
        uuid: new UUID('0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0')
      },
      limit: 21,
      comment: 'tedooo:1234',
      $db: 'shop',
      lsid: { id: 'x' },
      $clusterTime: {},
      $readPreference: { mode: 'primary' }
    })
    expect(summary).toBe(false)
    expect(text).toBe(
      'db.runCommand({ find: "orders", filter: { _id: ObjectId("64b0c0ffee0000000000abcd"), total: { $gt: NumberLong("9007199254740993") }, price: NumberDecimal("1.10"), at: ISODate("2026-01-02T03:04:05.000Z"), name: /^an/i, "a.b": MinKey(), ts: Timestamp({ t: 5, i: 2 }), bin: BinData(0, "aGk="), uuid: UUID("0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0") }, limit: 21 })'
    )
  })

  it('cuts big commands and hides commands the driver redacted', () => {
    const big = mongoCommandText(
      'insert',
      {
        insert: 'logs',
        documents: Array.from({ length: 1000 }, (_, i) => ({ i, s: 'x'.repeat(50) }))
      },
      300
    )
    expect(big.text.length).toBeLessThanOrEqual(301)
    expect(big.text.endsWith('…')).toBe(true)
    expect(mongoCommandText('createUser', {})).toEqual({
      text: '// createUser (arguments not shown: they carry credentials)',
      summary: true
    })
  })

  it('counts documents from replies', () => {
    expect(mongoReplyCounts('find', { cursor: { firstBatch: [{}, {}], id: 0 } })).toEqual({
      rows: 2
    })
    expect(mongoReplyCounts('getMore', { cursor: { nextBatch: [{}] } })).toEqual({ rows: 1 })
    expect(mongoReplyCounts('update', { n: 3, nModified: 2 })).toEqual({ affected: 2 })
    expect(mongoReplyCounts('delete', { n: 4 })).toEqual({ affected: 4 })
    expect(mongoReplyCounts('distinct', { values: [1, 2, 3] })).toEqual({ rows: 3 })
  })
})

/** A MongoDriver stand-in whose client emits command monitoring events. */
class FakeMongoDriver extends FakeDriver {
  client = Object.assign(new EventEmitter(), { options: { monitorCommands: true } })
  private request = 0
  async getClient(): Promise<unknown> {
    return this.client
  }
  /** Simulates one wire command (started → succeeded/failed) in the caller's async context. */
  async command(
    name: string,
    command: Record<string, unknown>,
    reply: Record<string, unknown> | Error
  ): Promise<void> {
    const requestId = ++this.request
    const base = { commandName: name, requestId, connectionId: 1, databaseName: 'shop' }
    this.client.emit('commandStarted', { ...base, command: { [name]: 'orders', ...command } })
    await Promise.resolve()
    if (reply instanceof Error)
      this.client.emit('commandFailed', { ...base, duration: 2, failure: reply })
    else this.client.emit('commandSucceeded', { ...base, duration: 1.5, reply })
  }
  override async listDatabases() {
    await this.command('listDatabases', {}, { databases: [] })
    return [{ name: 'shop' }]
  }
}

describe('Mongo command monitoring', () => {
  it('logs wire commands with the caller’s source, housekeeping as metadata', async () => {
    const log = new DataConsoleLog()
    const project = makeRecord({
      engine: 'mongodb',
      config: { hosts: [], database: 'shop' } as never
    })
    const input = { project, secrets: {}, redact: (t: string) => t }
    const fake = new FakeMongoDriver(input)
    fake.handler = async () => {
      await fake.command('find', { filter: { status: 'A' } }, { cursor: { firstBatch: [{}, {}] } })
      await fake.command('getMore', {}, { cursor: { nextBatch: [{}] } })
      return {
        output: { kind: 'documents', documents: [{}, {}, {}], truncated: false, limit: null }
      }
    }
    const driver = instrumentDriver(fake, input, log)
    await driver.connect()
    await withConsoleSource('query', () =>
      driver.execute('db.orders.find({ status: "A" })', {
        limit: 20,
        hardCap: 20,
        readOnlySandbox: true
      })
    )
    // A command no scope claims (the Documents view's find) is a 'mongo' entry; a catalog one
    // is metadata; a server error is recorded as such.
    await fake.command('aggregate', { pipeline: [] }, { cursor: { firstBatch: [] } })
    await fake.command('collStats', {}, { ok: 1 })
    await fake.command('insert', { documents: [{ a: 1 }] }, new Error('E11000 duplicate key'))
    await driver.listDatabases()
    expect(
      log.list('dp-1').entries.map((e) => [e.source, e.text, e.rows ?? e.affected, e.status])
    ).toEqual([
      ['metadata', '// connect', null, 'ok'],
      ['query', 'db.runCommand({ find: "orders", filter: { status: "A" } })', 2, 'ok'],
      ['metadata', 'db.runCommand({ getMore: "orders" })', 1, 'ok'],
      ['mongo', 'db.runCommand({ aggregate: "orders", pipeline: [] })', 0, 'ok'],
      ['metadata', 'db.runCommand({ collStats: "orders" })', null, 'ok'],
      ['mongo', 'db.runCommand({ insert: "orders", documents: [{ a: 1 }] })', null, 'error'],
      // listDatabases reported a command: no summary line.
      ['metadata', 'db.runCommand({ listDatabases: "orders" })', null, 'ok']
    ])
    expect(log.list('dp-1').entries[1]).toMatchObject({ language: 'mongo', database: 'shop' })
  })

  it('without command monitoring, logs the Shell statements as typed', async () => {
    const log = new DataConsoleLog()
    const project = makeRecord({
      engine: 'mongodb',
      config: { hosts: [], database: 'shop' } as never
    })
    const input = { project, secrets: {}, redact: (t: string) => t }
    const fake = new FakeMongoDriver(input)
    fake.client.options.monitorCommands = false
    fake.handler = () => ({ output: { kind: 'value', value: 3 } })
    const driver = instrumentDriver(fake, input, log)
    await driver.connect()
    await withConsoleSource('query', () =>
      driver.execute('db.orders.countDocuments()', {
        limit: null,
        hardCap: 1,
        readOnlySandbox: true
      })
    )
    await fake.command('find', {}, { cursor: { firstBatch: [] } })
    expect(log.list('dp-1').entries.map((e) => [e.source, e.text])).toEqual([
      ['metadata', '// connect'],
      ['query', 'db.orders.countDocuments()']
    ])
  })
})

describe('inlineBindValues', () => {
  it('writes MySQL / SQLite ? and PostgreSQL $n values as literals, never inside strings', () => {
    expect(
      inlineBindValues(
        "SELECT '?' AS q, c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? -- ?",
        ['shop', "o'brien"],
        'mysql'
      )
    ).toBe(
      "SELECT '?' AS q, c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'shop' AND TABLE_NAME = 'o''brien' -- ?"
    )
    expect(
      inlineBindValues('SELECT * FROM t WHERE id IN (?) AND x = ?', [[1, 2], null], 'mysql')
    ).toBe('SELECT * FROM t WHERE id IN (1, 2) AND x = NULL')
    expect(
      inlineBindValues(
        "SELECT $2, '$1', $$ $1 $$, $1, $10",
        ['a', 2, 3, 4, 5, 6, 7, 8, 9, 'ten'],
        'postgres'
      )
    ).toBe("SELECT 2, '$1', $$ $1 $$, 'a', 'ten'")
    expect(
      inlineBindValues("SELECT set_config('search_path', $1, false)", ['a\\b'], 'postgres')
    ).toBe("SELECT set_config('search_path', E'a\\\\b', false)")
    expect(inlineBindValues('SELECT ?2, ?1', ['x', 9n], 'sqlite')).toBe("SELECT 9, 'x'")
    expect(inlineBindValues('SELECT 1', [], 'postgres')).toBe('SELECT 1')
    // PostgreSQL arrays as array text, which the cast or the comparison types
    expect(
      inlineBindValues(
        'SELECT * FROM pg_class WHERE oid = ANY($1::oid[]) AND n = ANY($2)',
        [
          [16402, 7],
          ['a b', 'q"x', null]
        ],
        'postgres'
      )
    ).toBe(
      `SELECT * FROM pg_class WHERE oid = ANY('{16402,7}'::oid[]) AND n = ANY(E'{"a b","q\\\\"x",NULL}')`
    )
  })

  it('keeps the statement as sent and lists the values when they have no faithful literal', () => {
    expect(
      inlineBindValues('SELECT * FROM t WHERE a = ANY($1)', [[{ nested: 1 }]], 'postgres')
    ).toBe('SELECT * FROM t WHERE a = ANY($1)\n-- params: [{"nested":1}]')
    // a placeholder without a value
    expect(inlineBindValues('SELECT ?, ?', ['only'], 'mysql')).toBe(
      "SELECT ?, ?\n-- params: 'only'"
    )
    expect(inlineBindValues('SELECT {id:UInt32}', [1], 'clickhouse')).toBe(
      'SELECT {id:UInt32}\n-- params: 1'
    )
  })
})

/** A MongoClient stand-in with the pool internals the monitor flips (mongodb 7.x shape). */
class PooledFakeMongoDriver extends FakeMongoDriver {
  readonly connection = { id: 4, monitorCommands: true }
  readonly pooled = Object.assign(this.client, {
    topology: {
      s: {
        servers: new Map([
          ['127.0.0.1:27018', { pool: { checkedOut: new Set([this.connection]) } }]
        ])
      }
    }
  })
  /** The pool checks the connection out for an operation, then the operation's command runs. */
  async operation(name: string, reply: Record<string, unknown>): Promise<void> {
    this.client.emit('connectionCheckedOut', { address: '127.0.0.1:27018', connectionId: 4 })
    // The driver emits command events only when the connection's flag is on.
    if (this.connection.monitorCommands) await this.command(name, {}, reply)
  }
}

describe('Mongo command monitoring while watched', () => {
  it('turns each connection’s events on only while a console follows the project', async () => {
    let now = 0
    const log = new DataConsoleLog({ now: () => now, watchLeaseMs: 1_000 })
    const project = makeRecord({
      engine: 'mongodb',
      config: { hosts: [], database: 'shop' } as never
    })
    const input = { project, secrets: {}, redact: (t: string) => t }
    const fake = new PooledFakeMongoDriver(input)
    fake.handler = () => ({ output: { kind: 'value', value: 3 } })
    const driver = instrumentDriver(fake, input, log)
    await driver.connect()
    const texts = (): string[] => log.list('dp-1').entries.map((e) => e.text)

    // Nobody follows: the connection is checked out quiet, the Shell is logged as typed.
    await fake.operation('find', { cursor: { firstBatch: [{}] } })
    expect(fake.connection.monitorCommands).toBe(false)
    await withConsoleSource('query', () =>
      driver.execute('db.orders.countDocuments()', {
        limit: null,
        hardCap: 1,
        readOnlySandbox: true
      })
    )
    expect(texts()).toEqual(['// connect', 'db.orders.countDocuments()'])

    // texts() listed: a console follows now; the next checkout turns events on.
    await fake.operation('find', { cursor: { firstBatch: [{}, {}] } })
    expect(fake.connection.monitorCommands).toBe(true)
    expect(log.list('dp-1').entries.at(-1)).toMatchObject({
      source: 'mongo',
      text: 'db.runCommand({ find: "orders" })',
      rows: 2
    })

    // The lease ends (the tab closed): quiet again; a stray event of a connection flagged
    // before that is not logged twice next to the Shell's own line.
    now += 5_000
    await fake.command('find', {}, { cursor: { firstBatch: [] } })
    await fake.operation('find', { cursor: { firstBatch: [] } })
    expect(fake.connection.monitorCommands).toBe(false)
    now += 5_000
    const before = log.list('dp-1').entries.length
    now += 5_000
    await fake.command('aggregate', {}, { cursor: { firstBatch: [] } })
    expect(log.list('dp-1').entries).toHaveLength(before)
  })
})

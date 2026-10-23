import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  DATA_EXPORT_CHANNEL,
  type DataExportProgressEvent,
  type DataExportRequest
} from '../../../../shared/data-projects/types'
import { DataDriverError, type DataProjectRecord, type DriverConnectInput } from '../contracts'
import { noopLogger } from '../connection-manager'
import { createDataEngineService, type DataEngineServiceInternals } from '../engine-service'
import { csvField, csvLine, ExportFormatter, jsonRow, sqlInsert, uniqueKeys } from '../export'
import { createSafetyGate } from '../safety-gate'
import { FakeDriver, MemoryRepository, MemorySecrets, makeRecord } from './engine-fixtures'

describe('CSV formatting (RFC 4180)', () => {
  it('quotes delimiter, quotes, CR/LF and edge spaces; NULL is empty', () => {
    expect(csvField('plain', ',')).toBe('plain')
    expect(csvField('a,b', ',')).toBe('"a,b"')
    expect(csvField('say "hi"', ',')).toBe('"say ""hi"""')
    expect(csvField('two\nlines', ',')).toBe('"two\nlines"')
    expect(csvField('cr\r', ',')).toBe('"cr\r"')
    expect(csvField(' padded', ',')).toBe('" padded"')
    expect(csvField('a;b', ';')).toBe('"a;b"')
    expect(csvField('a,b', ';')).toBe('a,b')
    expect(csvField(null, ',')).toBe('')
    expect(csvField(undefined, ',')).toBe('')
    // The empty string is quoted so a re-import can tell it from NULL (PG COPY … CSV).
    expect(csvField('', ',')).toBe('""')
    expect(csvLine([null, '', 'x'], ';')).toBe(';"";x\r\n')
    expect(csvField(true, ',')).toBe('true')
    expect(csvField(12.5, ',')).toBe('12.5')
    expect(csvField(10n ** 20n, ',')).toBe('100000000000000000000')
    expect(csvField(Buffer.from([0xca, 0xfe]), ',')).toBe('cafe')
    expect(csvField({ a: 1 }, ',')).toBe('"{""a"":1}"')
    expect(csvLine(['a', null, 'b\tc'], '\t')).toBe('a\t\t"b\tc"\r\n')
  })
})

describe('JSON and SQL formatting', () => {
  it('dedupes keys and keeps exact strings', () => {
    expect(uniqueKeys(['id', 'id', 'name', '', 'id'])).toEqual([
      'id',
      'id_2',
      'name',
      'column',
      'id_3'
    ])
    expect(jsonRow(['id', 'n', 'b'], ['9007199254740993', null, Buffer.from('hi')])).toBe(
      '{"id":"9007199254740993","n":null,"b":"6869"}'
    )
  })

  it('streams a valid JSON array, also for zero rows and Mongo EJSON rows', () => {
    const f = new ExportFormatter('json', {
      delimiter: ',',
      header: true,
      dialect: 'postgres',
      table: 't'
    })
    let out = f.batch(['a'], [[1], [2]])
    out += f.batch(['a'], [[3]])
    out += f.end(['a'])
    expect(JSON.parse(out)).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }])
    const empty = new ExportFormatter('json', {
      delimiter: ',',
      header: true,
      dialect: 'postgres',
      table: 't'
    })
    expect(JSON.parse(empty.end(['a']))).toEqual([])
    const mongo = new ExportFormatter('json', {
      delimiter: ',',
      header: true,
      dialect: null,
      table: 'c'
    })
    const doc = { _id: { $oid: '64b0' }, n: { $numberLong: '5' } }
    expect(JSON.parse(mongo.batch(['__ejson__'], [[doc]]) + mongo.end(['__ejson__']))).toEqual([
      doc
    ])
  })

  it('writes multi-row INSERTs in batches of 100', () => {
    expect(
      sqlInsert(
        'mysql',
        'users',
        ['id', 'name'],
        [
          [1, "O'x"],
          [2, null]
        ]
      )
    ).toBe("INSERT INTO `users` (`id`, `name`) VALUES\n  (1, 'O''x'),\n  (2, NULL);\n")
    const f = new ExportFormatter('sql', {
      delimiter: ',',
      header: true,
      dialect: 'postgres',
      table: 't'
    })
    const rows = Array.from({ length: 250 }, (_, i) => [i])
    const out = f.batch(['id'], rows) + f.end(['id'])
    expect(out.match(/INSERT INTO/g)).toHaveLength(3)
    expect(out.startsWith('-- Exported by Hive\n')).toBe(true)
  })

  it('MySQL SQL exports write literals for the session’s backslash mode', () => {
    expect(sqlInsert('mysql', 't', ['p'], [['C:\\x']])).toBe(
      "INSERT INTO `t` (`p`) VALUES\n  ('C:\\\\x');\n"
    )
    expect(sqlInsert('mysql', 't', ['p'], [['C:\\x']], { backslashEscapes: false })).toBe(
      "INSERT INTO `t` (`p`) VALUES\n  ('C:\\x');\n"
    )
    const f = new ExportFormatter('sql', {
      delimiter: ',',
      header: true,
      dialect: 'mariadb',
      table: 't',
      backslashEscapes: false
    })
    const out = f.batch(['p'], [['a\\b']]) + f.end(['p'])
    expect(out).toContain('NO_BACKSLASH_ESCAPES')
    expect(out).toContain("('a\\b')")
  })

  it('writes MySQL BIT values wider than 53 bits unquoted, from the driver’s column types', () => {
    // The driver reads BIT(54..64) as exact decimal text; quoted, '5' would re-import as the
    // byte 0x35 (53). BIT up to 53 bits already arrives as a number.
    const types = ['INT', 'BIT', 'BIT', 'VARCHAR']
    expect(
      sqlInsert(
        'mysql',
        't',
        ['id', 'b64', 'b8', 's'],
        [
          [1, '18446744073709551615', 5, '5'],
          [2, null, 0, '0']
        ],
        {},
        types
      )
    ).toBe(
      "INSERT INTO `t` (`id`, `b64`, `b8`, `s`) VALUES\n  (1, 18446744073709551615, 5, '5'),\n  (2, NULL, 0, '0');\n"
    )
    // Without types, and outside MySQL/MariaDB, text stays quoted (a PG bit string is text).
    expect(sqlInsert('mysql', 't', ['b'], [['5']])).toBe("INSERT INTO `t` (`b`) VALUES\n  ('5');\n")
    expect(sqlInsert('postgres', 't', ['b'], [['0101']], {}, ['bit'])).toBe(
      `INSERT INTO "t" ("b") VALUES\n  ('0101');\n`
    )
    // Only digits go in bare: anything else in a BIT column is still a quoted literal.
    expect(sqlInsert('mariadb', 't', ['b'], [["1'); DROP TABLE t; --"]], {}, ['BIT'])).toContain(
      "('1''); DROP TABLE t; --')"
    )
    const f = new ExportFormatter('sql', {
      delimiter: ',',
      header: true,
      dialect: 'mariadb',
      table: 't'
    })
    const out = f.batch(['id', 'b'], [[1, '99']], ['INT', 'BIT']) + f.end(['id', 'b'])
    expect(out).toContain('VALUES\n  (1, 99);')
  })

  it('CSV header can be turned off', () => {
    const f = new ExportFormatter('csv', {
      delimiter: ',',
      header: false,
      dialect: 'postgres',
      table: 't'
    })
    expect(f.batch(['a', 'b'], [[1, 2]]) + f.end(['a', 'b'])).toBe('1,2\r\n')
  })
})

// ---------------------------------------------------------------------------------------------
// startExport through the engine (fake driver, real files in a temp dir)
// ---------------------------------------------------------------------------------------------

let dir = ''
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tedooo-export-test-'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

let engines: DataEngineServiceInternals[] = []
afterEach(async () => {
  for (const e of engines) await e.shutdown()
  engines = []
})

function setup(record: Partial<DataProjectRecord> = {}, dialog: string | null = null) {
  const events: DataExportProgressEvent[] = []
  const drivers: FakeDriver[] = []
  let configure: (d: FakeDriver) => void = () => {}
  const engine = createDataEngineService({
    repository: new MemoryRepository([makeRecord(record)]),
    secrets: new MemorySecrets(),
    publish: (channel, payload) => {
      if (channel === DATA_EXPORT_CHANNEL) events.push(payload as DataExportProgressEvent)
    },
    createDriver: (input: DriverConnectInput) => {
      const d = new FakeDriver(input)
      configure(d)
      drivers.push(d)
      return d
    },
    showSaveDialog: async () => dialog,
    gate: createSafetyGate(),
    logger: noopLogger
  })
  engines.push(engine)
  return {
    engine,
    events,
    drivers,
    configure: (fn: (d: FakeDriver) => void) => {
      configure = fn
    }
  }
}

const base = (extra: Partial<DataExportRequest>): DataExportRequest => ({
  dataProjectId: 'dp-1',
  exportId: `e-${Math.random().toString(36).slice(2)}`,
  source: { kind: 'table', ref: { schema: 'public', name: 'users' } },
  format: 'csv',
  ...extra
})

describe('startExport', () => {
  it('streams a table to CSV in the sandbox, renames into place and reports progress', async () => {
    const h = setup()
    h.configure((d) => {
      d.streamBatches = [
        {
          columns: ['id', 'name'],
          rows: [
            [1, 'a,b'],
            [2, null]
          ]
        },
        { columns: ['id', 'name'], rows: [[3, 'c']] }
      ]
    })
    const filePath = join(dir, 'users.csv')
    const res = await h.engine.exportStart(base({ filePath, csv: { delimiter: ';' } }), {
      clientId: null
    })
    expect(res).toMatchObject({ status: 'ok', filePath, rows: 3 })
    expect(await readFile(filePath, 'utf8')).toBe('id;name\r\n1;a,b\r\n2;\r\n3;c\r\n')
    expect(h.drivers[0].streamCalls[0]).toEqual({
      statement: 'SELECT * FROM "public"."users"',
      readOnlySandbox: true
    })
    expect(h.events.at(-1)).toMatchObject({ done: true, rows: 3 })
    expect((await readdir(dir)).filter((f) => f.endsWith('.part'))).toEqual([])
  })

  it('exports a table view with its OR filters, sort and raw WHERE', async () => {
    const h = setup()
    h.configure((d) => {
      d.streamBatches = [{ columns: ['id'], rows: [[1]] }]
    })
    const filePath = join(dir, 'users-or.csv')
    const res = await h.engine.exportStart(
      base({
        filePath,
        source: {
          kind: 'table',
          ref: { schema: 'public', name: 'users' },
          filters: [
            { column: 'country', operator: '=', value: 'IL' },
            { column: 'country', operator: '=', value: 'US' }
          ],
          filterJoin: 'or',
          where: 'id > 0',
          orderBy: [{ column: 'id', direction: 'desc' }]
        }
      }),
      { clientId: null }
    )
    expect(res).toMatchObject({ status: 'ok', rows: 1 })
    expect(h.drivers[0].streamCalls[0].statement).toBe(
      `SELECT * FROM "public"."users" WHERE ("country" = 'IL' OR "country" = 'US') AND (id > 0\n) ORDER BY "id" DESC`
    )
  })

  it('asks for a path when none is given; a cancelled dialog cancels', async () => {
    const h = setup({}, null)
    expect(await h.engine.exportStart(base({}), { clientId: null })).toEqual({
      status: 'cancelled'
    })
    const withDialog = setup({}, join(dir, 'picked.json'))
    withDialog.configure((d) => {
      d.streamBatches = [{ columns: ['id'], rows: [[1]] }]
    })
    const res = await withDialog.engine.exportStart(base({ format: 'json' }), { clientId: null })
    expect(res).toMatchObject({ status: 'ok', filePath: join(dir, 'picked.json') })
    expect(JSON.parse(await readFile(join(dir, 'picked.json'), 'utf8'))).toEqual([{ id: 1 }])
  })

  it('blocks writes, refuses several statements and confirms dangerous reads', async () => {
    const h = setup()
    const write = await h.engine.exportStart(
      base({ source: { kind: 'query', text: 'DELETE FROM users' }, filePath: join(dir, 'x.csv') }),
      { clientId: null }
    )
    expect(write.status).toBe('blocked')
    await expect(
      h.engine.exportStart(
        base({
          source: { kind: 'query', text: 'SELECT 1; SELECT 2' },
          filePath: join(dir, 'x.csv')
        }),
        {
          clientId: null
        }
      )
    ).rejects.toMatchObject({ code: 'DATA_INVALID_INPUT' })
    const safe = setup({ safeMode: 'safe' })
    safe.configure((d) => {
      d.streamBatches = [{ columns: ['n'], rows: [[1]] }]
    })
    const req = base({
      source: { kind: 'query', text: 'SELECT 1 AS n' },
      filePath: join(dir, 'q.csv')
    })
    const confirm = await safe.engine.exportStart(req, { clientId: null })
    expect(confirm.status).toBe('confirmation_required')
    if (confirm.status !== 'confirmation_required') return
    const ok = await safe.engine.exportStart(
      { ...req, exportId: 'again', confirmToken: confirm.confirmToken },
      { clientId: null }
    )
    expect(ok.status).toBe('ok')
  })

  it('cancel by exportId removes the partial file', async () => {
    const h = setup()
    h.configure((d) => {
      d.streamRows = async (_s, options, onBatch) => {
        await onBatch(['id'], [[1]])
        await new Promise<void>((resolve) =>
          options.signal.addEventListener('abort', () => resolve())
        )
        throw new DataDriverError('cancelled', { cancelled: true })
      }
    })
    const req = base({ exportId: 'exp-cancel', filePath: join(dir, 'cancelled.csv') })
    const running = h.engine.exportStart(req, { clientId: 'c1' })
    await new Promise((r) => setTimeout(r, 20))
    expect(await h.engine.exportCancel('exp-cancel')).toEqual({ cancelled: true })
    expect(await running).toEqual({ status: 'cancelled' })
    const files = await readdir(dir)
    expect(files).not.toContain('cancelled.csv')
    expect(files.filter((f) => f.includes('cancelled.csv'))).toEqual([])
  })

  it('a driver failure deletes the temp file and reports the error', async () => {
    const h = setup()
    h.configure((d) => {
      d.streamRows = async (_s, _o, onBatch) => {
        await onBatch(['id'], [[1]])
        throw new DataDriverError('relation "users" does not exist', { code: '42P01' })
      }
    })
    await expect(
      h.engine.exportStart(base({ filePath: join(dir, 'failed.csv') }), { clientId: null })
    ).rejects.toThrow(/does not exist/)
    expect((await readdir(dir)).filter((f) => f.includes('failed.csv'))).toEqual([])
    expect(h.events.at(-1)).toMatchObject({
      done: true,
      error: expect.stringContaining('does not exist')
    })
  })

  it('a Mongo filter or pipeline ending in a // comment still exports (not misread as a write)', async () => {
    const h = setup({ engine: 'mongodb', config: { database: 'shop' } })
    h.configure((d) => {
      d.streamBatches = [{ columns: ['_id', 'status'], rows: [[1, 'shipped']] }]
    })
    const found = await h.engine.exportStart(
      base({
        source: {
          kind: 'mongo',
          database: 'shop',
          collection: 'orders',
          filter: "{ status: 'shipped' } // shipped only"
        },
        filePath: join(dir, 'orders.csv')
      }),
      { clientId: null }
    )
    expect(found).toMatchObject({ status: 'ok', rows: 1 })
    const piped = await h.engine.exportStart(
      base({
        source: {
          kind: 'mongo',
          database: 'shop',
          collection: 'orders',
          pipeline: '[{ $match: { status: "shipped" } }] // pipeline'
        },
        filePath: join(dir, 'orders-agg.csv')
      }),
      { clientId: null }
    )
    expect(piped).toMatchObject({ status: 'ok', rows: 1 })
    // $out still is not exportable.
    const out = await h.engine.exportStart(
      base({
        source: {
          kind: 'mongo',
          database: 'shop',
          collection: 'orders',
          pipeline: '[{ $out: "copy" }] // write'
        },
        filePath: join(dir, 'orders-out.csv')
      }),
      { clientId: null }
    )
    expect(out.status).toBe('blocked')
  })

  it('a MySQL SQL export writes the BIT values the driver types as BIT unquoted', async () => {
    const h = setup({ engine: 'mysql', config: { database: 'shop' } })
    h.configure((d) => {
      d.streamRows = async (_s, _o, onBatch) => {
        // The MySQL driver's streamRows hands over its column type names as a third argument.
        const withTypes = onBatch as (
          columns: string[],
          rows: unknown[][],
          columnTypes?: string[]
        ) => Promise<void>
        await withTypes(['id', 'wide', 'note'], [[1, '5', '5']], ['INT', 'BIT', 'VARCHAR'])
        return { rows: 1 }
      }
    })
    const filePath = join(dir, 'bits.sql')
    const res = await h.engine.exportStart(
      base({
        source: { kind: 'table', ref: { database: 'shop', name: 'bits' } },
        format: 'sql',
        filePath
      }),
      { clientId: null }
    )
    expect(res).toMatchObject({ status: 'ok', rows: 1 })
    expect(await readFile(filePath, 'utf8')).toContain(
      "INSERT INTO `bits` (`id`, `wide`, `note`) VALUES\n  (1, 5, '5');\n"
    )
  })

  it('CSV keeps NULL and the empty string apart in a full export', async () => {
    const h = setup()
    h.configure((d) => {
      d.streamBatches = [
        {
          columns: ['id', 'note'],
          rows: [
            [1, null],
            [2, '']
          ]
        }
      ]
    })
    const filePath = join(dir, 'nulls.csv')
    await h.engine.exportStart(base({ filePath }), { clientId: null })
    expect(await readFile(filePath, 'utf8')).toBe('id,note\r\n1,\r\n2,""\r\n')
  })

  it('SQL export of MongoDB data is refused', async () => {
    const h = setup({ engine: 'mongodb' })
    await expect(
      h.engine.exportStart(
        base({
          source: { kind: 'mongo', database: 'shop', collection: 'users' },
          format: 'sql',
          filePath: join(dir, 'm.sql')
        }),
        { clientId: null }
      )
    ).rejects.toMatchObject({ code: 'DATA_UNSUPPORTED' })
  })
})

// The console's metadata view against the real servers: PostgreSQL's session housekeeping (the
// connect prologue, set_config of search_path / statement_timeout, the read-only sandbox's
// BEGIN READ ONLY / ROLLBACK, an export's transaction) is listed like MySQL's USE / SET / START
// TRANSACTION READ ONLY, and catalog statements show their bind values in place of the `?` /
// `$n` placeholders, so an entry names the object it read. Read-only: nothing is written.
// Gated: TEDOOO_DP_IT=1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DataEngine } from '../../../../shared/data-projects/types'
import type { DataDriver, DriverConnectInput } from '../contracts'
import { DataConsoleLog, instrumentDriver, withConsoleSource } from '../console-log'
import { createDriver } from '../drivers'
import { makeRecord } from './engine-fixtures'

const LIVE = !!process.env.TEDOOO_DP_IT
const itLive = LIVE ? it : it.skip

const log = new DataConsoleLog()
const drivers: DataDriver[] = []

function open(id: string, engine: DataEngine, port: number, user: string, password: string) {
  const input: DriverConnectInput = {
    project: makeRecord({
      id,
      engine,
      config: { host: '127.0.0.1', port, user, database: 'shop' }
    }),
    secrets: { password },
    redact: (t) => t
  }
  const driver = instrumentDriver(createDriver(input), input, log)
  drivers.push(driver)
  return driver
}

const entries = (id: string) => log.list(id).entries

beforeAll(() => undefined)
afterAll(async () => {
  await Promise.all(drivers.map((d) => d.close().catch(() => undefined)))
})

describe('console housekeeping and catalog statements (live)', () => {
  itLive('lists PostgreSQL session housekeeping as metadata, around the statement', async () => {
    const pg = open('hk-postgres', 'postgres', 15432, 'postgres', 'pgpw')
    await pg.connect()
    await withConsoleSource('table', () =>
      pg.execute('SELECT id FROM users ORDER BY id', {
        limit: 5,
        hardCap: 5,
        readOnlySandbox: true,
        schema: 'public',
        timeoutMs: 15_000
      })
    )
    const texts = entries('hk-postgres').map((e) => [e.source, e.text])
    expect(texts).toContainEqual([
      'metadata',
      "SET datestyle = 'ISO, MDY'; SET bytea_output = 'hex'"
    ])
    expect(
      texts.some(([s, t]) => s === 'metadata' && t.startsWith('SELECT current_setting('))
    ).toBe(true)
    // In order around the statement (the result's column lookups sit in between).
    const around = texts
      .slice(texts.findIndex(([, t]) => t.includes("'search_path'")))
      .filter(([s, t]) => s !== 'metadata' || !/\b(pg_type|pg_class|lock_timeout)\b/.test(t))
    expect(around).toEqual([
      ['metadata', `SELECT set_config('search_path', '"public"', false)`],
      ['metadata', "SELECT set_config('statement_timeout', '15000', false)"],
      ['metadata', 'BEGIN READ ONLY'],
      ['metadata', 'ROLLBACK'],
      ['table', 'SELECT id FROM users ORDER BY id LIMIT 6']
    ])
    // A user transaction: the app's read runs in a savepoint, also listed.
    await withConsoleSource('query', () =>
      pg.execute('BEGIN', { limit: null, hardCap: 1, readOnlySandbox: false })
    )
    await withConsoleSource('table', () =>
      pg.execute('SELECT 1', { limit: null, hardCap: 1, readOnlySandbox: true })
    )
    await withConsoleSource('query', () =>
      pg.execute('ROLLBACK', { limit: null, hardCap: 1, readOnlySandbox: false })
    )
    const tail = entries('hk-postgres')
      .slice(-4)
      .map((e) => [e.source, e.text])
    expect(tail).toEqual([
      ['metadata', 'SAVEPOINT tedooo_read'],
      ['metadata', 'RELEASE SAVEPOINT tedooo_read'],
      ['table', 'SELECT 1'],
      ['query', 'ROLLBACK']
    ])
  })

  itLive('writes catalog bind values in, so entries name the object (PostgreSQL)', async () => {
    const pg = open('cat-postgres', 'postgres', 15432, 'postgres', 'pgpw')
    await pg.describe({ database: 'shop', schema: 'public', name: 'users', kind: 'table' })
    const metadata = entries('cat-postgres').filter((e) => e.source === 'metadata')
    expect(metadata.some((e) => e.summary)).toBe(false)
    expect(metadata.some((e) => /'users'|"users"/.test(e.text))).toBe(true)
    // Every placeholder was written in, or the values follow the statement.
    for (const e of metadata) {
      if (/\$\d/.test(e.text.replace(/'(?:[^']|'')*'/g, ''))) expect(e.text).toContain('-- params:')
    }
  })

  itLive('writes catalog bind values in, so entries name the object (MySQL)', async () => {
    const my = open('cat-mysql', 'mysql', 13306, 'root', 'rootpw')
    await my.describe({ database: 'shop', name: 'users', kind: 'table' })
    const metadata = entries('cat-mysql').filter((e) => e.source === 'metadata')
    const columns = metadata.find((e) => e.text.includes('information_schema.COLUMNS'))
    expect(columns?.text).toContain("'users'")
    expect(columns?.text).not.toMatch(/TABLE_NAME = \?/)
  })
})

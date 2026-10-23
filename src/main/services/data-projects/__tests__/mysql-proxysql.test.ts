// The MySQL driver behind ProxySQL (fake mysql2): an untracked SET locks a connection to its
// hostgroup, and catalog SELECTs routed to the readers must not then fail with 9006.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMysqlDriver } from '../drivers/mysql'
import { makeRecord } from './engine-fixtures'

interface FakeServer {
  version: string
  /** Emulate ProxySQL with mysql-set_query_lock_on_hostgroup=1 and SELECTs routed to hostgroup 1. */
  proxysql: boolean
}

const server: FakeServer = { version: '8.0.36', proxysql: true }
const sent: Array<{ conn: number; sql: string }> = []
let opened = 0

// ProxySQL locks on a SET of a variable it does not track; everything else here it tracks.
const untrackedSet = (sql: string): boolean =>
  /^SET SESSION information_schema_stats_expiry/i.test(sql) || /^SET STATEMENT /i.test(sql)

function fakeConnection(): unknown {
  const id = ++opened
  let lockedTo: number | null = null
  return {
    threadId: id,
    connect: (cb: (error: unknown) => void) => cb(null),
    on: () => undefined,
    destroy: () => undefined,
    end: (cb?: () => void) => cb?.(),
    query: (opts: { sql: string }, cb: (error: unknown, rows?: unknown) => void) => {
      const sql = opts.sql
      sent.push({ conn: id, sql })
      if (server.proxysql) {
        const hostgroup = /^SELECT/i.test(sql) ? 1 : 0
        if (lockedTo !== null && lockedTo !== hostgroup) {
          const message = `ProxySQL Error: connection is locked to hostgroup ${lockedTo} but trying to reach hostgroup ${hostgroup}`
          cb(
            Object.assign(new Error(message), {
              errno: 9006,
              sqlMessage: message,
              sqlState: 'Y0000'
            })
          )
          return
        }
        if (untrackedSet(sql)) lockedTo = hostgroup
      }
      if (/^SET SESSION/i.test(sql)) return cb(null, { affectedRows: 0, serverStatus: 2 })
      if (sql.startsWith('SELECT VERSION()'))
        return cb(null, [{ v: server.version, db: 'shop', ro: 0, id }])
      if (sql.includes('@@SESSION.sql_mode')) return cb(null, [{ mode: 'STRICT_TRANS_TABLES' }])
      if (sql.includes('information_schema.SCHEMATA')) return cb(null, [{ name: 'shop', size: 10 }])
      return cb(null, [])
    }
  }
}

vi.mock('mysql2', () => ({ createConnection: () => fakeConnection() }))

const make = () =>
  createMysqlDriver({
    project: makeRecord({
      id: 'proxysql',
      engine: server.version.includes('MariaDB') ? 'mariadb' : 'mysql',
      config: { host: '127.0.0.1', port: 6033, user: 'app', database: 'shop' }
    }),
    secrets: { password: 'pw' },
    redact: (text) => text
  })

const sqlOn = (conn: number) => sent.filter((s) => s.conn === conn).map((s) => s.sql)

describe('mysql driver behind ProxySQL', () => {
  beforeEach(() => {
    sent.length = 0
    opened = 0
    server.version = '8.0.36'
    server.proxysql = true
  })

  it('reopens the control connection without the stats-expiry SET after a hostgroup lock', async () => {
    const driver = make()
    await driver.connect()
    await expect(driver.listDatabases()).resolves.toEqual([
      { name: 'shop', sizeBytes: 10, isSystem: false }
    ])
    // 1 = session, 2 = control that got locked, 3 = control reopened without the SET.
    expect(opened).toBe(3)
    expect(sqlOn(2)).toContain('SET SESSION information_schema_stats_expiry = 0')
    expect(sqlOn(3)).not.toContain('SET SESSION information_schema_stats_expiry = 0')

    await driver.listObjects('shop')
    await driver.listDatabases()
    expect(opened).toBe(3)
    await driver.close()
  })

  it('keeps the stats-expiry SET on a plain server', async () => {
    server.proxysql = false
    const driver = make()
    await driver.connect()
    await driver.listDatabases()
    expect(opened).toBe(2)
    expect(sqlOn(2)).toContain('SET SESSION information_schema_stats_expiry = 0')
    await driver.close()
  })

  it('drops the MariaDB SET STATEMENT hint once a control connection got locked', async () => {
    server.version = '10.11.6-MariaDB'
    const driver = make()
    await driver.connect()
    // The hinted listing itself runs (it is what locks the connection).
    await driver.listDatabases()
    expect(sqlOn(2).some((s) => s.startsWith('SET STATEMENT'))).toBe(true)
    // The next catalog SELECT hits the lock: the connection is replaced and the read retried.
    await expect(driver.listObjects('shop')).resolves.toBeDefined()
    expect(opened).toBe(3)
    await driver.listDatabases()
    expect(sqlOn(3).some((s) => s.startsWith('SET STATEMENT'))).toBe(false)
    expect(sqlOn(3).some((s) => s.includes('information_schema.SCHEMATA'))).toBe(true)
    await driver.close()
  })
})

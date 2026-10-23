// PostgreSQL driver: helpers and control-client fallbacks without a server (the live behaviour
// is covered in __tests__/drivers.live.test.ts, gated by TEDOOO_DP_IT=1).

import { describe, expect, it } from 'vitest'
import { makeRecord } from '../__tests__/engine-fixtures'
import { DataDriverError } from '../contracts'
import { __postgresInternals, createPostgresDriver } from './postgres'

const { setsSearchPath } = __postgresInternals

/** A driver whose catalog reads are answered by `answer` (no connection is opened). */
const stubbedDriver = (answer: (sql: string) => unknown[]) => {
  const driver = createPostgresDriver({
    project: makeRecord({ engine: 'postgres' }),
    secrets: {},
    redact: (t) => t
  })
  const seen: string[] = []
  const internals = driver as unknown as {
    controlQuery: (sql: string) => Promise<unknown[]>
    serverVersion: string
    versionNum: number
  }
  internals.serverVersion = 'PostgreSQL 17'
  internals.versionNum = 170000
  internals.controlQuery = async (sql: string) => {
    seen.push(sql)
    return answer(sql)
  }
  return { driver, seen }
}

const lockTimeout = (): DataDriverError =>
  new DataDriverError('canceling statement due to lock timeout', { code: '55P03' })

describe('postgres search_path tracking', () => {
  it('recognises statements that set the search_path', () => {
    expect(setsSearchPath('SET search_path TO a, b')).toBe(true)
    expect(setsSearchPath('set  session search_path = a')).toBe(true)
    expect(setsSearchPath('SET LOCAL search_path TO a')).toBe(true)
    expect(setsSearchPath('RESET search_path')).toBe(true)
    expect(setsSearchPath("SELECT set_config('search_path', 'a', false)")).toBe(true)
    expect(setsSearchPath('SHOW search_path')).toBe(false)
    expect(setsSearchPath("SELECT current_setting('search_path')")).toBe(false)
  })
})

describe('postgres catalog reads under a lock', () => {
  it('lists objects without sizes when the sized listing hits the lock timeout', async () => {
    const { driver, seen } = stubbedDriver((sql) => {
      if (sql.includes('FROM pg_namespace WHERE')) return [{ name: 'public' }]
      if (sql.includes('pg_total_relation_size')) throw lockTimeout()
      if (sql.includes('FROM pg_class c JOIN pg_namespace'))
        return [
          {
            schema: 'public',
            name: 'orders',
            kind: 'r',
            est: '10',
            size: null,
            comment: null,
            am: 'heap'
          }
        ]
      return []
    })
    const listing = await driver.listObjects('shop')
    expect(listing.objects).toEqual([
      expect.objectContaining({ name: 'orders', kind: 'table', rowEstimate: 10, sizeBytes: null })
    ])
    const relationReads = seen.filter((sql) => sql.includes('c.relkind::text AS kind'))
    expect(relationReads).toHaveLength(2)
    expect(relationReads[0]).toMatch(/^WITH locked AS/)
    expect(relationReads[1]).not.toMatch(/pg_total_relation_size|pg_locks/)
  })

  it('describes a relation without what needs its lock when the full read times out', async () => {
    const { driver, seen } = stubbedDriver((sql) => {
      if (sql.includes('pg_get_userbyid(c.relowner)')) {
        if (sql.includes('pg_total_relation_size')) throw lockTimeout()
        return [
          {
            oid: 42,
            schema: 'public',
            name: 't',
            qualified: 'public.t',
            relkind: 'r',
            est: '1',
            size: null,
            locked: true,
            comment: null,
            owner: 'me',
            persistence: 'p',
            ispartition: false
          }
        ]
      }
      if (sql.includes('FROM pg_attribute a JOIN pg_type t')) {
        // The lock-free column read: no pg_get_expr with the relation.
        expect(sql).not.toContain('pg_get_expr(d.adbin, d.adrelid)')
        return [
          {
            num: 1,
            name: 'v',
            qname: 'v',
            type: 'text',
            notnull: false,
            def: null,
            identity: '',
            generated: 's',
            comment: null,
            collation: null
          }
        ]
      }
      if (sql.includes('FROM pg_index i')) {
        expect(sql).not.toContain('pg_get_indexdef')
        return [
          { name: 't_pkey', uniq: true, prim: true, def: null, type: 'btree', size: null, col: 'v' }
        ]
      }
      return []
    })
    const details = await driver.describe({ schema: 'public', name: 't' })
    expect(details.columns[0]).toMatchObject({
      name: 'v',
      defaultValue: null,
      extra: 'GENERATED ALWAYS AS (…) STORED'
    })
    expect(details.indexes).toEqual([
      {
        name: 't_pkey',
        columns: ['v'],
        unique: true,
        primary: true,
        definition: undefined,
        type: 'btree',
        sizeBytes: null
      }
    ])
    expect(details.sizeBytes).toBeNull()
    // DDL of a locked relation is refused at once instead of waiting.
    await expect(driver.ddl({ schema: 'public', name: 't', kind: 'table' })).rejects.toMatchObject({
      code: '55P03'
    })
    expect(seen.some((sql) => sql.includes('pg_get_viewdef'))).toBe(false)
  })
})

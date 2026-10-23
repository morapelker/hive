import { describe, expect, it } from 'vitest'

import type { SqlDialect } from '../data-projects/types'
import { applyAutoLimit } from './limit'

describe('applyAutoLimit: rewrites simple top-level SELECTs (PG, SQLite)', () => {
  const cases: Array<[SqlDialect, string, string]> = [
    ['postgres', 'SELECT * FROM t', 'SELECT * FROM t LIMIT 101'],
    ['sqlite', 'SELECT * FROM t', 'SELECT * FROM t LIMIT 101'],
    ['postgres', 'SELECT * FROM t;', 'SELECT * FROM t LIMIT 101;'],
    ['postgres', 'SELECT * FROM t  ;  ', 'SELECT * FROM t LIMIT 101  ;  '],
    ['postgres', 'SELECT * FROM t -- note', 'SELECT * FROM t LIMIT 101 -- note'],
    ['postgres', 'SELECT * FROM t /* c */\n', 'SELECT * FROM t LIMIT 101 /* c */\n'],
    ['postgres', 'SELECT * FROM t ORDER BY a DESC', 'SELECT * FROM t ORDER BY a DESC LIMIT 101'],
    [
      'postgres',
      'SELECT a FROM t UNION SELECT b FROM u',
      'SELECT a FROM t UNION SELECT b FROM u LIMIT 101'
    ],
    ['postgres', '(SELECT 1) UNION (SELECT 2)', '(SELECT 1) UNION (SELECT 2) LIMIT 101'],
    ['postgres', '(SELECT * FROM t)', '(SELECT * FROM t) LIMIT 101'],
    [
      'postgres',
      'WITH x AS (SELECT * FROM t LIMIT 5) SELECT * FROM x',
      'WITH x AS (SELECT * FROM t LIMIT 5) SELECT * FROM x LIMIT 101'
    ],
    [
      'postgres',
      'SELECT * FROM (SELECT * FROM t LIMIT 5) s',
      'SELECT * FROM (SELECT * FROM t LIMIT 5) s LIMIT 101'
    ],
    [
      'postgres',
      'select a, count(*) from t group by a having count(*) > 1 window w as (partition by a)',
      'select a, count(*) from t group by a having count(*) > 1 window w as (partition by a) LIMIT 101'
    ],
    ['sqlite', 'SELECT * FROM [t] WHERE a = :a', 'SELECT * FROM [t] WHERE a = :a LIMIT 101']
  ]
  it.each(cases)('%s %j', (dialect, sql, expected) => {
    expect(applyAutoLimit(sql, dialect, 101)).toEqual({ text: expected, applied: true })
  })
})

describe('applyAutoLimit: leaves everything else alone', () => {
  const cases: Array<[SqlDialect, string]> = [
    ['postgres', 'SELECT * FROM t LIMIT 5'],
    ['postgres', 'SELECT * FROM t LIMIT ALL'],
    ['postgres', 'SELECT * FROM t OFFSET 5'],
    ['postgres', 'SELECT * FROM t FETCH FIRST 5 ROWS ONLY'],
    ['postgres', 'SELECT * FROM t FOR UPDATE'],
    ['postgres', 'SELECT * FROM t FOR SHARE'],
    ['postgres', 'SELECT * INTO t2 FROM t'],
    ['postgres', '(SELECT * FROM t LIMIT 5)'],
    ['postgres', 'VALUES (1), (2)'],
    ['postgres', 'TABLE t'],
    ['postgres', 'EXPLAIN SELECT * FROM t'],
    ['postgres', 'SHOW search_path'],
    ['postgres', 'INSERT INTO t SELECT * FROM u'],
    ['postgres', 'WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d'],
    ['postgres', 'WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x'],
    ['postgres', 'SELECT pg_sleep(1)'],
    ['postgres', "SELECT 'unterminated"],
    ['postgres', 'SELECT 1; SELECT 2'],
    ['postgres', '-- nothing'],
    ['postgres', ''],
    ['sqlite', 'PRAGMA table_info(t)'],
    ['sqlite', 'SELECT * FROM t LIMIT 5 OFFSET 10']
  ]
  it.each(cases)('%s %j', (dialect, sql) => {
    expect(applyAutoLimit(sql, dialect, 101)).toEqual({ text: sql, applied: false })
  })

  it.each(['mysql', 'mariadb', 'clickhouse'] as const)('never rewrites %s', (dialect) => {
    expect(applyAutoLimit('SELECT * FROM t', dialect, 101)).toEqual({
      text: 'SELECT * FROM t',
      applied: false
    })
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'ignores an invalid limit %s',
    (limit) => {
      expect(applyAutoLimit('SELECT 1', 'postgres', limit).applied).toBe(false)
    }
  )
})

import { describe, expect, it } from 'vitest'

import type { DataFilter, DataFilterOperator, SqlDialect } from '../data-projects/types'
import { DATA_FILTER_OPERATORS } from '../data-projects/types'
import { classifySqlStatement } from './classify'
import { buildSqlWhere, buildSqlWhereClause, splitFilterList } from './filters'

const one = (
  operator: DataFilterOperator,
  value: string | undefined,
  dialect: SqlDialect
): string => buildSqlWhere([{ column: 'name', operator, value }], dialect)

describe('buildSqlWhere: every operator per dialect', () => {
  const cases: Array<[SqlDialect, DataFilterOperator, string | undefined, string]> = [
    ['postgres', '=', 'Ann', `"name" = 'Ann'`],
    ['mysql', '!=', 'Ann', "`name` <> 'Ann'"],
    ['sqlite', '<', '5', `"name" < '5'`],
    ['clickhouse', '<=', '5', "`name` <= '5'"],
    ['mariadb', '>', '5', "`name` > '5'"],
    ['postgres', '>=', '5', `"name" >= '5'`],
    ['postgres', '=', undefined, `"name" = ''`],
    ['postgres', 'contains', 'an', `CAST("name" AS TEXT) ILIKE '%an%' ESCAPE '!'`],
    ['mysql', 'contains', 'an', "`name` LIKE '%an%' ESCAPE '!'"],
    ['sqlite', 'contains', 'an', `"name" LIKE '%an%' ESCAPE '!'`],
    ['clickhouse', 'contains', 'an', "toString(`name`) ILIKE '%an%'"],
    ['postgres', 'not contains', 'an', `CAST("name" AS TEXT) NOT ILIKE '%an%' ESCAPE '!'`],
    ['mysql', 'not contains', 'an', "`name` NOT LIKE '%an%' ESCAPE '!'"],
    ['clickhouse', 'not contains', 'an', "toString(`name`) NOT ILIKE '%an%'"],
    ['postgres', 'starts with', 'An', `CAST("name" AS TEXT) LIKE 'An%' ESCAPE '!'`],
    ['mariadb', 'starts with', 'An', "`name` LIKE 'An%' ESCAPE '!'"],
    ['clickhouse', 'starts with', 'An', "toString(`name`) LIKE 'An%'"],
    ['postgres', 'contains', '50%_off!', `CAST("name" AS TEXT) ILIKE '%50!%!_off!!%' ESCAPE '!'`],
    ['mysql', 'contains', '50%_\\', "`name` LIKE '%50!%!_\\\\%' ESCAPE '!'"],
    ['clickhouse', 'contains', '50%_\\', "toString(`name`) ILIKE '%50\\\\%\\\\_\\\\\\\\%'"],
    ['postgres', 'like', 'A%_x', `CAST("name" AS TEXT) LIKE 'A%_x'`],
    ['mysql', 'like', 'A%', "`name` LIKE 'A%'"],
    ['clickhouse', 'like', 'A%', "toString(`name`) LIKE 'A%'"],
    ['postgres', 'in', 'a, b ,c', `"name" IN ('a', 'b', 'c')`],
    ['mysql', 'not in', '1,2', "`name` NOT IN ('1', '2')"],
    ['postgres', 'in', `"x,y", 'z', w`, `"name" IN ('x,y', 'z', 'w')`],
    ['postgres', 'in', ' , ,', ''],
    ['postgres', 'is null', 'ignored', '"name" IS NULL'],
    ['sqlite', 'is not null', undefined, '"name" IS NOT NULL'],
    ['postgres', '=', "O'Brien", `"name" = 'O''Brien'`]
  ]
  it.each(cases)('%s %s %j', (dialect, operator, value, expected) => {
    expect(one(operator, value, dialect)).toBe(expected)
  })

  it('joins filters with AND and returns an empty string when there are none', () => {
    const filters: DataFilter[] = [
      { column: 'a', operator: '=', value: '1' },
      { column: 'b', operator: 'is null' }
    ]
    expect(buildSqlWhere(filters, 'postgres')).toBe(`"a" = '1' AND "b" IS NULL`)
    expect(buildSqlWhere([], 'postgres')).toBe('')
  })

  it('quotes awkward column names', () => {
    expect(buildSqlWhere([{ column: 'we"ird', operator: '=', value: 'x' }], 'postgres')).toBe(
      `"we""ird" = 'x'`
    )
  })

  it('throws on an operator outside the contract', () => {
    expect(() =>
      buildSqlWhere([{ column: 'a', operator: 'regex' as DataFilterOperator, value: 'x' }], 'mysql')
    ).toThrow(/Unsupported filter operator/)
  })

  it.each(['mysql', 'mariadb', 'postgres', 'sqlite', 'clickhouse'] as const)(
    'every operator yields a read-only condition in %s',
    (dialect) => {
      for (const operator of DATA_FILTER_OPERATORS) {
        const where = buildSqlWhere(
          [{ column: 'c', operator, value: "x'; DROP TABLE t; --" }],
          dialect
        )
        const sql = `SELECT * FROM t WHERE ${where}`
        expect(classifySqlStatement(sql, dialect).classification).toBe('read')
      }
    }
  )
})

describe('buildSqlWhereClause', () => {
  it('combines filters with the raw WHERE text in parentheses', () => {
    expect(
      buildSqlWhereClause([{ column: 'a', operator: '=', value: '1' }], 'mysql', 'b = 2 OR c = 3')
    ).toBe(" WHERE `a` = '1' AND (b = 2 OR c = 3)")
  })
  it('accepts a raw WHERE alone and strips a leading WHERE / trailing ;', () => {
    expect(buildSqlWhereClause([], 'postgres', ' WHERE x > 1; ')).toBe(' WHERE (x > 1)')
  })
  it('closes the parenthesis on a new line after a trailing line comment', () => {
    expect(buildSqlWhereClause([], 'postgres', 'x > 1 -- recent')).toBe(
      ' WHERE (x > 1 -- recent\n)'
    )
  })
  it('is empty when there is nothing to filter', () => {
    expect(buildSqlWhereClause([], 'sqlite', '   ')).toBe('')
    expect(buildSqlWhereClause([], 'sqlite')).toBe('')
  })
})

describe('OR filters (join)', () => {
  const filters: DataFilter[] = [
    { column: 'country', operator: '=', value: 'IL' },
    { column: 'email', operator: 'contains', value: 'a_b' },
    { column: 'id', operator: 'in', value: '1, 2' }
  ]
  const cases: Array<[SqlDialect, string]> = [
    [
      'postgres',
      `"country" = 'IL' OR CAST("email" AS TEXT) ILIKE '%a!_b%' ESCAPE '!' OR "id" IN ('1', '2')`
    ],
    ['mysql', "`country` = 'IL' OR `email` LIKE '%a!_b%' ESCAPE '!' OR `id` IN ('1', '2')"],
    ['mariadb', "`country` = 'IL' OR `email` LIKE '%a!_b%' ESCAPE '!' OR `id` IN ('1', '2')"],
    ['sqlite', `"country" = 'IL' OR "email" LIKE '%a!_b%' ESCAPE '!' OR "id" IN ('1', '2')`],
    ['clickhouse', "`country` = 'IL' OR toString(`email`) ILIKE '%a\\\\_b%' OR `id` IN ('1', '2')"]
  ]
  it.each(cases)('joins with OR in %s', (dialect, expected) => {
    expect(buildSqlWhere(filters, dialect, { join: 'or' })).toBe(expected)
    // AND stays the default (and is what an explicit 'and' gives).
    expect(buildSqlWhere(filters, dialect, { join: 'and' })).toBe(
      expected.split(' OR ').join(' AND ')
    )
    expect(buildSqlWhere(filters, dialect)).toBe(expected.split(' OR ').join(' AND '))
  })

  it.each(cases)('groups the OR filters before ANDing the raw WHERE in %s', (dialect, expected) => {
    expect(buildSqlWhereClause(filters, dialect, 'total > 10 OR status = 1', { join: 'or' })).toBe(
      ` WHERE (${expected}) AND (total > 10 OR status = 1)`
    )
    // Alone, the OR group needs no parentheses.
    expect(buildSqlWhereClause(filters, dialect, null, { join: 'or' })).toBe(` WHERE ${expected}`)
  })

  it('needs no group for a single contributing filter', () => {
    const single: DataFilter[] = [
      { column: 'a', operator: '=', value: 'x OR y' },
      { column: 'b', operator: 'in', value: ' , ' }
    ]
    expect(buildSqlWhereClause(single, 'postgres', 'c = 1', { join: 'or' })).toBe(
      ` WHERE "a" = 'x OR y' AND (c = 1)`
    )
    expect(buildSqlWhere([], 'postgres', { join: 'or' })).toBe('')
    expect(buildSqlWhereClause([], 'postgres', '', { join: 'or' })).toBe('')
  })

  it('keeps the MySQL backslash mode with a join', () => {
    const f: DataFilter[] = [
      { column: 'p', operator: '=', value: 'C:\\t' },
      { column: 'q', operator: 'is null' }
    ]
    expect(buildSqlWhere(f, 'mysql', { join: 'or', backslashEscapes: false })).toBe(
      "`p` = 'C:\\t' OR `q` IS NULL"
    )
    expect(buildSqlWhere(f, 'mysql', { join: 'or' })).toBe("`p` = 'C:\\\\t' OR `q` IS NULL")
  })

  it.each(['mysql', 'mariadb', 'postgres', 'sqlite', 'clickhouse'] as const)(
    'an OR group with a raw WHERE is one plain read in %s',
    (dialect) => {
      const where = buildSqlWhereClause(
        DATA_FILTER_OPERATORS.map((operator) => ({
          column: 'c',
          operator,
          value: "x'; DROP TABLE t; --"
        })),
        dialect,
        'id > 0',
        { join: 'or' }
      )
      const c = classifySqlStatement(`SELECT * FROM t${where}`, dialect)
      expect(c.classification).toBe('read')
      expect(c.dangerous).toEqual([])
    }
  )
})

describe('splitFilterList', () => {
  const cases: Array<[string, string[]]> = [
    ['a,b,c', ['a', 'b', 'c']],
    [' a , b ', ['a', 'b']],
    ['a,,b,', ['a', 'b']],
    ['"x,y", z', ['x,y', 'z']],
    ["'it''s', b", ["it's", 'b']],
    ['"unbalanced, x', ['"unbalanced, x']],
    ['', []]
  ]
  it.each(cases)('%j → %j', (value, expected) => {
    expect(splitFilterList(value)).toEqual(expected)
  })
})

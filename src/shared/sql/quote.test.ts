import { describe, expect, it } from 'vitest'

import type { DataCell, SqlDialect } from '../data-projects/types'
import { lexSql } from './lexer'
import { qualifiedSqlName, quoteSqlIdentifier, quoteSqlLiteral, quoteSqlString } from './quote'

describe('quoteSqlIdentifier', () => {
  const cases: Array<[SqlDialect, string, string]> = [
    ['mysql', 'orders', '`orders`'],
    ['mysql', 'we`ird', '`we``ird`'],
    ['mariadb', 'a b', '`a b`'],
    ['postgres', 'Users', '"Users"'],
    ['postgres', 'say "hi"', '"say ""hi"""'],
    ['sqlite', 'order', '"order"'],
    ['sqlite', 'x"y', '"x""y"'],
    ['clickhouse', 'a`b', '`a\\`b`'],
    ['clickhouse', 'a\\b', '`a\\\\b`']
  ]
  it.each(cases)('%s %j → %s', (dialect, name, expected) => {
    expect(quoteSqlIdentifier(name, dialect)).toBe(expected)
  })

  it.each(['mysql', 'mariadb', 'postgres', 'sqlite', 'clickhouse'] as const)(
    'round-trips through the %s lexer as one quoted identifier',
    (dialect) => {
      for (const name of ['plain', 'we`ird', 'say "hi"', 'semi;colon', 'back\\slash', "it's"]) {
        const tokens = lexSql(quoteSqlIdentifier(name, dialect), dialect).tokens
        expect(tokens).toHaveLength(1)
        expect(tokens[0]?.type).toBe('quoted_identifier')
      }
    }
  )
})

describe('qualifiedSqlName', () => {
  const cases: Array<[SqlDialect, { database?: string; schema?: string; name: string }, string]> = [
    ['postgres', { schema: 'public', name: 'orders' }, '"public"."orders"'],
    ['postgres', { database: 'shop', schema: 'analytics', name: 'daily' }, '"analytics"."daily"'],
    ['postgres', { database: 'shop', name: 'orders' }, '"orders"'],
    ['mysql', { database: 'shop', name: 'orders' }, '`shop`.`orders`'],
    ['mysql', { name: 'orders' }, '`orders`'],
    ['mariadb', { schema: 'shop', name: 'orders' }, '`shop`.`orders`'],
    ['clickhouse', { database: 'default', name: 'events' }, '`default`.`events`'],
    ['sqlite', { database: 'main', name: 'users' }, '"main"."users"'],
    ['sqlite', { name: 'users' }, '"users"']
  ]
  it.each(cases)('%s %j → %s', (dialect, ref, expected) => {
    expect(qualifiedSqlName(ref, dialect)).toBe(expected)
  })
})

describe('quoteSqlLiteral', () => {
  const cases: Array<[SqlDialect, DataCell | undefined, string]> = [
    ['postgres', null, 'NULL'],
    ['mysql', undefined, 'NULL'],
    ['postgres', 42, '42'],
    ['mysql', -1.5, '-1.5'],
    ['sqlite', -0, '0'],
    ['postgres', true, 'TRUE'],
    ['mysql', false, 'FALSE'],
    ['sqlite', true, '1'],
    ['sqlite', false, '0'],
    ['clickhouse', true, 'true'],
    ['postgres', "it's", "'it''s'"],
    ['postgres', 'C:\\dir', "E'C:\\\\dir'"],
    ['mysql', 'C:\\dir', "'C:\\\\dir'"],
    ['mysql', "a'b", "'a''b'"],
    ['mysql', 'nul\0z', "'nul\\0z'"],
    ['sqlite', 'C:\\dir', "'C:\\dir'"],
    ['clickhouse', "a'b\\c", "'a\\'b\\\\c'"],
    ['postgres', '12345678901234567890', "'12345678901234567890'"],
    ['mysql', { $t: 'bin', hex: 'deadbeef', len: 4 }, "X'DEADBEEF'"],
    ['sqlite', { $t: 'bin', hex: '00ff', len: 2 }, "X'00FF'"],
    ['postgres', { $t: 'bin', hex: '00ff', len: 2 }, "decode('00FF', 'hex')"],
    ['clickhouse', { $t: 'bin', hex: 'ab', len: 1 }, "unhex('AB')"],
    ['mysql', { $t: 'bin', hex: '', len: 0 }, "X''"]
  ]
  it.each(cases)('%s %j → %s', (dialect, value, expected) => {
    expect(quoteSqlLiteral(value, dialect)).toBe(expected)
  })

  it('writes literal backslashes for a NO_BACKSLASH_ESCAPES session', () => {
    expect(quoteSqlLiteral('C:\\dir', 'mysql', { backslashEscapes: false })).toBe("'C:\\dir'")
  })

  it('refuses a truncated binary preview instead of writing partial data', () => {
    expect(() => quoteSqlLiteral({ $t: 'bin', hex: 'ab', len: 300 }, 'mysql')).toThrow(/truncated/)
  })

  it('refuses malformed hex', () => {
    expect(() => quoteSqlLiteral({ $t: 'bin', hex: 'xyz', len: 1 }, 'mysql')).toThrow(/hex/)
  })

  it.each(['mysql', 'mariadb', 'postgres', 'sqlite', 'clickhouse'] as const)(
    'every string literal lexes back as one %s string token',
    (dialect) => {
      for (const value of ["it's", 'back\\slash', "\\'", "''", 'semi;colon', 'new\nline', '']) {
        const tokens = lexSql(quoteSqlString(value, dialect), dialect).tokens
        expect(tokens).toHaveLength(1)
        expect(tokens[0]?.type).toBe('string')
      }
    }
  )
})

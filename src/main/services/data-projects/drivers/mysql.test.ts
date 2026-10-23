// MySQL/MariaDB driver: value decoding and table-lock tracking without a server (the live
// behaviour is covered in __tests__/drivers.live.test.ts, gated by TEDOOO_DP_IT=1).

import { describe, expect, it } from 'vitest'
import { __mysqlInternals } from './mysql'

const { decodeValue } = __mysqlInternals

const BIT = 0x10
const bitColumn = (bits: number) => ({
  name: 'b',
  columnType: BIT,
  characterSet: 63,
  flags: 32,
  columnLength: bits,
  decimals: 0
})

describe('mysql value decoding', () => {
  it('decodes BIT up to 53 bits as a number (unquoted on write-back), wider as exact text', () => {
    expect(decodeValue(Buffer.from([0x01]), bitColumn(1), 64)).toBe(1)
    expect(decodeValue(Buffer.from([0x05]), bitColumn(8), 64)).toBe(5)
    expect(
      decodeValue(Buffer.from([0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), bitColumn(53), 64)
    ).toBe(2 ** 53 - 1)
    expect(decodeValue(Buffer.alloc(8, 0xff), bitColumn(64), 64)).toBe('18446744073709551615')
    expect(decodeValue(Buffer.from([0x00, 0x05]), bitColumn(64), 64)).toBe('5')
    expect(decodeValue(null, bitColumn(8), 64)).toBeNull()
  })
})

describe('mysql table-lock tracking', () => {
  const { tableLockEffect } = __mysqlInternals

  it('notices the statements that take table locks (a START TRANSACTION would release them)', () => {
    for (const sql of [
      'LOCK TABLES accounts WRITE',
      'lock table accounts read, orders write',
      '/* note */ -- why\n# more\n  LOCK TABLES t WRITE',
      'FLUSH TABLES t1, t2 WITH READ LOCK',
      'FLUSH TABLES WITH READ LOCK',
      'FLUSH TABLES t FOR EXPORT'
    ])
      expect(tableLockEffect(sql), sql).toBe('takes')
  })

  it('notices the statements that release them', () => {
    for (const sql of [
      'UNLOCK TABLES',
      'unlock table',
      'START TRANSACTION',
      'start transaction read only',
      'BEGIN',
      'begin work;',
      '-- go\nBEGIN'
    ])
      expect(tableLockEffect(sql), sql).toBe('releases')
  })

  it('leaves everything else alone', () => {
    for (const sql of [
      'SELECT * FROM t FOR UPDATE',
      'SELECT * FROM t LOCK IN SHARE MODE',
      'BEGIN NOT ATOMIC SELECT 1; END',
      'FLUSH TABLES',
      'COMMIT',
      'ROLLBACK',
      "SELECT 'LOCK TABLES t WRITE'",
      '/*!40000 ALTER TABLE t DISABLE KEYS */'
    ])
      expect(tableLockEffect(sql), sql).toBeNull()
  })
})

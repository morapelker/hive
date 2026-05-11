import { describe, expect, test } from 'vitest'

import {
  classifyDbError,
  DbBusy,
  DbConstraintViolation,
  DbCorrupt,
  DbForeignKeyViolation,
  DbUnknown
} from '../../src/main/effect/db/errors'

const sqliteErr = (code: string, message = 'msg'): Error & { code: string } => {
  const e = new Error(message) as Error & { code: string }
  e.code = code
  return e
}

describe('classifyDbError', () => {
  test('SQLITE_CONSTRAINT_UNIQUE -> DbConstraintViolation', () => {
    const out = classifyDbError(sqliteErr('SQLITE_CONSTRAINT_UNIQUE', 'UNIQUE failed'))
    expect(out).toBeInstanceOf(DbConstraintViolation)
    expect(out._tag).toBe('DbConstraintViolation')
    expect((out as DbConstraintViolation).code).toBe('SQLITE_CONSTRAINT_UNIQUE')
  })

  test('SQLITE_CONSTRAINT_PRIMARYKEY -> DbConstraintViolation', () => {
    const out = classifyDbError(sqliteErr('SQLITE_CONSTRAINT_PRIMARYKEY'))
    expect(out._tag).toBe('DbConstraintViolation')
  })

  test('SQLITE_CONSTRAINT_NOTNULL -> DbConstraintViolation', () => {
    const out = classifyDbError(sqliteErr('SQLITE_CONSTRAINT_NOTNULL'))
    expect(out._tag).toBe('DbConstraintViolation')
  })

  test('SQLITE_CONSTRAINT_FOREIGNKEY -> DbForeignKeyViolation', () => {
    const out = classifyDbError(sqliteErr('SQLITE_CONSTRAINT_FOREIGNKEY', 'FOREIGN KEY constraint failed'))
    expect(out).toBeInstanceOf(DbForeignKeyViolation)
    expect(out._tag).toBe('DbForeignKeyViolation')
  })

  test('SQLITE_BUSY -> DbBusy', () => {
    const out = classifyDbError(sqliteErr('SQLITE_BUSY'))
    expect(out).toBeInstanceOf(DbBusy)
    expect(out._tag).toBe('DbBusy')
  })

  test('SQLITE_BUSY_SNAPSHOT -> DbBusy', () => {
    const out = classifyDbError(sqliteErr('SQLITE_BUSY_SNAPSHOT'))
    expect(out._tag).toBe('DbBusy')
  })

  test('SQLITE_CORRUPT -> DbCorrupt', () => {
    const out = classifyDbError(sqliteErr('SQLITE_CORRUPT'))
    expect(out).toBeInstanceOf(DbCorrupt)
    expect(out._tag).toBe('DbCorrupt')
  })

  test('unknown code -> DbUnknown', () => {
    const out = classifyDbError(sqliteErr('SQLITE_MISUSE', 'misuse'))
    expect(out).toBeInstanceOf(DbUnknown)
    expect(out._tag).toBe('DbUnknown')
    expect((out as DbUnknown).code).toBe('SQLITE_MISUSE')
  })

  test('non-Error input -> DbUnknown with cause', () => {
    const out = classifyDbError('plain string')
    expect(out._tag).toBe('DbUnknown')
    expect((out as DbUnknown).cause).toBe('plain string')
  })

  test('FOREIGN KEY message without code -> DbForeignKeyViolation', () => {
    const out = classifyDbError(new Error('FOREIGN KEY constraint failed'))
    expect(out._tag).toBe('DbForeignKeyViolation')
  })
})

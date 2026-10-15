import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { instrumentDatabase, sqlKey } from './db-instrumentation'
import { getPerfLogger, resetPerfLoggerForTests } from './perf-logger'

describe('db instrumentation', () => {
  let db: Database.Database
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'db-instrumentation-'))
    db = new Database(':memory:')
    instrumentDatabase(db)
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)')
  })

  afterEach(() => {
    resetPerfLoggerForTests()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps statements fully functional, including chaining and transactions', () => {
    const insert = db.prepare('INSERT INTO t (name) VALUES (?)')
    const many = db.transaction((names: string[]) => {
      for (const name of names) insert.run(name)
    })
    many(['a', 'b', 'c'])
    expect(db.prepare('SELECT name FROM t ORDER BY id').pluck().all()).toEqual(['a', 'b', 'c'])
    expect(db.prepare('SELECT * FROM t WHERE id = ?').get(2)).toEqual({ id: 2, name: 'b' })
    expect([...db.prepare('SELECT id FROM t').iterate()].length).toBe(3)
    expect(db.prepare('SELECT count(*) AS n FROM t').raw().get()).toEqual([3])
  })

  it('records statement timings only while logging is enabled', () => {
    const logger = getPerfLogger('server')
    ;(logger as unknown as { logDir: string }).logDir = dir
    db.prepare('SELECT 1').get()
    expect((logger.sample().db as { count: number }).count).toBe(0)

    logger.start()
    db.prepare('SELECT name FROM t').all()
    db.prepare('SELECT   name   FROM t').all()
    db.exec('DELETE FROM t')
    const sample = logger.sample() as {
      db: { count: number; top: Array<{ sql: string; count: number }> }
    }
    logger.stop()
    expect(sample.db.count).toBe(3)
    expect(sample.db.top.find((s) => s.sql === 'SELECT name FROM t')?.count).toBe(2)
    expect(sample.db.top.some((s) => s.sql === 'exec: DELETE FROM t')).toBe(true)
  })

  it('collapses whitespace and caps the statement key', () => {
    expect(sqlKey('SELECT\n  1\t FROM   t')).toBe('SELECT 1 FROM t')
    expect(sqlKey('x'.repeat(500)).length).toBeLessThan(170)
  })
})

import type Database from 'better-sqlite3'
import { performance } from 'node:perf_hooks'
import { perfLog } from './perf-logger'

/**
 * Times every statement executed through one better-sqlite3 handle when performance logging is
 * on. better-sqlite3 runs on the event loop, so a statement that takes 80 ms *is* 80 ms of UI
 * lag for every connected renderer; the log aggregates by statement text per sample window and
 * records each slow one individually.
 *
 * `prepare` is wrapped on the instance (not the prototype): statements returned from it get
 * `run` / `get` / `all` wrappers that cost one `perfLog.isEnabled()` check while logging is off.
 */

const SQL_KEY_MAX = 160

export const sqlKey = (sql: string): string => {
  const collapsed = sql.replace(/\s+/g, ' ').trim()
  return collapsed.length > SQL_KEY_MAX ? `${collapsed.slice(0, SQL_KEY_MAX)}…` : collapsed
}

type TimedMethod = 'run' | 'get' | 'all'
const TIMED_METHODS: readonly TimedMethod[] = ['run', 'get', 'all']

const INSTRUMENTED = Symbol.for('hive.perf-logging.db-instrumented')

export function instrumentDatabase(db: Database.Database): void {
  const marked = db as unknown as Record<symbol, boolean>
  if (marked[INSTRUMENTED]) return
  marked[INSTRUMENTED] = true

  const originalPrepare = db.prepare.bind(db)
  const originalExec = db.exec.bind(db)

  const prepare = (source: string): Database.Statement => {
    const statement = originalPrepare(source)
    // Computed on first timed call only: prepare() runs on almost every DB access.
    let key: string | null = null
    for (const method of TIMED_METHODS) {
      const original = (statement as unknown as Record<string, (...args: unknown[]) => unknown>)[
        method
      ]
      if (typeof original !== 'function') continue
      ;(statement as unknown as Record<string, unknown>)[method] = function (
        this: unknown,
        ...args: unknown[]
      ) {
        if (!perfLog.isEnabled()) return original.apply(statement, args)
        const started = performance.now()
        try {
          return original.apply(statement, args)
        } finally {
          key ??= sqlKey(statement.source)
          perfLog.recordDb(key, performance.now() - started)
        }
      }
    }
    return statement
  }

  const exec: Database.Database['exec'] = (source) => {
    if (!perfLog.isEnabled()) return originalExec(source)
    const started = performance.now()
    try {
      return originalExec(source)
    } finally {
      perfLog.recordDb(`exec: ${sqlKey(source)}`, performance.now() - started)
    }
  }

  Object.defineProperty(db, 'prepare', { value: prepare, configurable: true, writable: true })
  Object.defineProperty(db, 'exec', { value: exec, configurable: true, writable: true })
}

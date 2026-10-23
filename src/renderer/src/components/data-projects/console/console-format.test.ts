// Console helpers: the filter (metadata toggle, source, errors, text), counts and time, what can
// be opened (never summaries, cut texts, masked texts or unbound parameters), and the commented
// blocks Copy writes.
import { describe, expect, it } from 'vitest'
import type { DataConsoleEntry } from '@shared/data-projects/console-types'
import {
  DEFAULT_CONSOLE_FILTER,
  consoleEntryBlock,
  consoleLogText,
  consoleOpenBlocker,
  formatConsoleCounts,
  formatConsoleTime,
  isMaskedConsoleEntry,
  matchesConsoleFilter
} from './console-format'

const at = new Date(2026, 9, 23, 14, 3, 7, 215).toISOString()
const entry = (overrides: Partial<DataConsoleEntry> = {}): DataConsoleEntry => ({
  seq: 1,
  dataProjectId: 'dp-1',
  at,
  source: 'query',
  language: 'sql',
  database: 'shop',
  text: 'SELECT * FROM users',
  status: 'ok',
  durationMs: 3.2,
  rows: 20,
  affected: null,
  error: null,
  ...overrides
})

describe('matchesConsoleFilter', () => {
  it('hides metadata unless asked, and filters by source, errors and text', () => {
    const meta = entry({ source: 'metadata', text: 'SHOW VARIABLES' })
    expect(matchesConsoleFilter(meta, DEFAULT_CONSOLE_FILTER)).toBe(false)
    expect(matchesConsoleFilter(meta, { ...DEFAULT_CONSOLE_FILTER, metadata: true })).toBe(true)
    // With the toggle on, metadata stays visible next to one source (its context).
    expect(
      matchesConsoleFilter(meta, { ...DEFAULT_CONSOLE_FILTER, metadata: true, source: 'edit' })
    ).toBe(true)

    const q = entry()
    expect(matchesConsoleFilter(q, { ...DEFAULT_CONSOLE_FILTER, source: 'query' })).toBe(true)
    expect(matchesConsoleFilter(q, { ...DEFAULT_CONSOLE_FILTER, source: 'table' })).toBe(false)
    expect(matchesConsoleFilter(q, { ...DEFAULT_CONSOLE_FILTER, errorsOnly: true })).toBe(false)
    const failed = entry({ status: 'error', error: 'Unknown column zz' })
    expect(matchesConsoleFilter(failed, { ...DEFAULT_CONSOLE_FILTER, errorsOnly: true })).toBe(true)

    for (const text of ['users', 'SELECT *', 'SHOP', 'unknown column', 'query'])
      expect(matchesConsoleFilter(failed, { ...DEFAULT_CONSOLE_FILTER, text })).toBe(true)
    expect(matchesConsoleFilter(failed, { ...DEFAULT_CONSOLE_FILTER, text: 'orders' })).toBe(false)
  })
})

describe('formatting', () => {
  it('formats time with milliseconds and the counts per language', () => {
    expect(formatConsoleTime(at)).toBe('14:03:07.215')
    expect(formatConsoleTime('nope')).toBe('')
    expect(formatConsoleCounts(entry())).toBe('20 rows')
    expect(formatConsoleCounts(entry({ rows: 1 }))).toBe('1 row')
    expect(formatConsoleCounts(entry({ rows: null, affected: 1200 }))).toBe('1,200 affected')
    expect(formatConsoleCounts(entry({ language: 'mongo', rows: 2 }))).toBe('2 docs')
    expect(formatConsoleCounts(entry({ rows: null }))).toBe('')
    // "0 affected" only where it means something.
    expect(formatConsoleCounts(entry({ rows: null, affected: 0, text: 'START TRANSACTION' }))).toBe(
      ''
    )
    expect(
      formatConsoleCounts(entry({ rows: null, affected: 0, text: 'UPDATE t SET a = 1 WHERE 0' }))
    ).toBe('0 affected')
    expect(
      formatConsoleCounts(
        entry({
          language: 'mongo',
          rows: null,
          affected: 0,
          text: 'db.runCommand({ delete: "x" })'
        })
      )
    ).toBe('0 affected')
    expect(formatConsoleCounts(entry({ summary: true, rows: 3, text: '-- describe t' }))).toBe(
      '3 results'
    )
  })

  it('only opens whole statements', () => {
    expect(consoleOpenBlocker(entry())).toBeNull()
    expect(consoleOpenBlocker(entry({ summary: true }))).toMatch(/summary/)
    expect(consoleOpenBlocker(entry({ truncated: true }))).toMatch(/Too long/)
  })

  it('never opens a statement whose secrets were masked, or one with unbound parameters', () => {
    // Opened and run, this would set the password to the literal '***'.
    const masked = {
      ...entry({ text: `UPDATE "users" SET "password" = '***' WHERE "id" = 7` }),
      masked: true
    }
    expect(isMaskedConsoleEntry(masked)).toBe(true)
    expect(consoleOpenBlocker(masked)).toMatch(/masked \(\*\*\*\)/)
    expect(isMaskedConsoleEntry(entry())).toBe(false)
    expect(
      consoleOpenBlocker(
        entry({ source: 'metadata', text: 'SELECT * FROM t WHERE a = ANY($1)\n-- params: [{}]' })
      )
    ).toMatch(/bind parameters/)
    // a statement that merely mentions *** or params is still a statement
    expect(consoleOpenBlocker(entry({ text: "SELECT '***' AS stars -- params: none" }))).toBeNull()
  })

  it('copies entries as commented, terminated statements', () => {
    expect(consoleEntryBlock(entry())).toBe(
      '-- 14:03:07.215 · Query · shop · 3 ms · 20 rows\nSELECT * FROM users;'
    )
    expect(
      consoleEntryBlock(
        entry({
          language: 'mongo',
          source: 'mongo',
          text: 'db.runCommand({ find: "orders" })',
          status: 'error',
          error: 'not authorized\non shop',
          rows: null,
          durationMs: null
        })
      )
    ).toBe(
      '// 14:03:07.215 · Mongo · shop\n// error: not authorized on shop\ndb.runCommand({ find: "orders" })'
    )
    expect(consoleLogText([entry(), entry({ seq: 2, text: 'COMMIT;', rows: null })])).toBe(
      '-- 14:03:07.215 · Query · shop · 3 ms · 20 rows\nSELECT * FROM users;\n\n-- 14:03:07.215 · Query · shop · 3 ms\nCOMMIT;'
    )
  })
})

import { describe, expect, it } from 'vitest'

import { DATA_STATEMENT_CLASSES, type SqlDialect } from '../data-projects/types'
import {
  applyAutoLimit,
  classifySqlStatement,
  lexSql,
  splitSqlStatements,
  statementAtOffset
} from '.'

// Seeded fuzzing over SQL-significant characters: the editor calls these on every keystroke and
// the server on every request, so no input may throw, and every offset must stay valid.
const DIALECTS: readonly SqlDialect[] = ['mysql', 'mariadb', 'postgres', 'sqlite', 'clickhouse']
const PIECES = [
  'SELECT ',
  'select ',
  'FROM t ',
  'WHERE ',
  'a',
  '1',
  ' ',
  '\n',
  ';',
  "'",
  '"',
  '`',
  '[',
  ']',
  '(',
  ')',
  '--',
  '-- ',
  '#',
  '/*',
  '*/',
  '/*!',
  '/*M!',
  '$',
  '$$',
  '$a$',
  '\\',
  '?',
  ':x',
  '@v',
  '@@g',
  '{p:Int8}',
  'DELIMITER $$\n',
  'BEGIN ',
  'END ',
  'CASE ',
  'CREATE PROCEDURE p() ',
  'CREATE TRIGGER t ',
  'DELETE ',
  'UPDATE ',
  'INTO ',
  'LIMIT 5 ',
  'FOR UPDATE ',
  'WITH x AS ',
  'E',
  'U&',
  'X',
  '.',
  ',',
  '=',
  'é',
  '\u{1F600}'
]

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function randomSql(next: () => number): string {
  const n = Math.floor(next() * 24)
  let out = ''
  for (let i = 0; i < n; i++) out += PIECES[Math.floor(next() * PIECES.length)]
  return out
}

describe('robustness (seeded fuzz)', () => {
  const next = rng(20261023)
  const inputs = Array.from({ length: 400 }, () => randomSql(next))

  it('never throws and always covers the input', () => {
    for (const text of inputs) {
      for (const dialect of DIALECTS) {
        const { tokens } = lexSql(text, dialect)
        expect(tokens.map((t) => t.text).join('')).toBe(text)

        const spans = splitSqlStatements(text, dialect)
        let last = -1
        for (const s of spans) {
          expect(s.start).toBeGreaterThan(last)
          expect(s.end).toBeGreaterThan(s.start)
          expect(text.slice(s.start, s.end)).toBe(s.text)
          last = s.end - 1
          const c = classifySqlStatement(s.text, dialect)
          expect(DATA_STATEMENT_CLASSES).toContain(c.classification)
          const limited = applyAutoLimit(s.text, dialect, 11)
          if (limited.applied) {
            const again = classifySqlStatement(limited.text, dialect)
            expect(again.classification).toBe('read')
            expect(again.hasLimitClause).toBe(true)
          }
        }
        for (let offset = 0; offset <= text.length; offset += 3) {
          const at = statementAtOffset(text, offset, dialect)
          if (spans.length === 0) expect(at).toBeNull()
          else expect(spans).toContainEqual(at)
        }
      }
    }
  })

  it('splits a large script quickly', () => {
    const script = Array.from(
      { length: 5000 },
      (_, i) => `SELECT a, 'x;${i}' FROM t WHERE id = ${i}; -- row ${i}\n`
    ).join('')
    const started = Date.now()
    const spans = splitSqlStatements(script, 'mysql')
    expect(spans).toHaveLength(5000)
    expect(Date.now() - started).toBeLessThan(3000)
  })
})

// The proposal card's read-only views over the shared toolkits: tokens that give the query back
// exactly (SQL through the shared lexer, mongosh through the panel's scanner) and the READ/WRITE
// verdict of the shared classifiers, where the model's own claim can only add caution.
import { describe, expect, it } from 'vitest'
import { classifyQuery, tokenizeQuery } from './query-insight'

const joined = (tokens: Array<{ text: string }>): string => tokens.map((t) => t.text).join('')

describe('tokenizeQuery', () => {
  it('covers SQL text exactly and marks keywords, strings, numbers and functions', () => {
    const sql = "SELECT count(*) FROM orders WHERE status = 'paid' AND id > 10 -- recent"
    const tokens = tokenizeQuery(sql, 'sql', 'postgres')
    expect(joined(tokens)).toBe(sql)
    const kindOf = (text: string): string | undefined => tokens.find((t) => t.text === text)?.kind
    expect(kindOf('SELECT')).toBe('keyword')
    expect(kindOf("'paid'")).toBe('string')
    expect(kindOf('10')).toBe('number')
    expect(kindOf('count')).toBe('function')
    expect(kindOf('-- recent')).toBe('comment')
  })

  it('covers mongosh text exactly and marks operators, strings and calls', () => {
    const shell = 'db.orders.find({ status: "paid", total: { $gte: 10 } }).sort({ createdAt: -1 })'
    const tokens = tokenizeQuery(shell, 'mongo', null)
    expect(joined(tokens)).toBe(shell)
    const kindOf = (text: string): string | undefined => tokens.find((t) => t.text === text)?.kind
    expect(kindOf('db')).toBe('keyword')
    expect(kindOf('find')).toBe('function')
    expect(kindOf('"paid"')).toBe('string')
    expect(kindOf('$gte')).toBe('variable')
    expect(kindOf('-1')).toBe('number')
  })
})

describe('classifyQuery', () => {
  it('reads SELECTs as reads and anything else as a write, whatever the model claimed', () => {
    expect(classifyQuery('SELECT * FROM orders', 'sql', 'postgres', false).kind).toBe('read')
    expect(classifyQuery('DELETE FROM orders WHERE id = 1', 'sql', 'postgres', false).kind).toBe(
      'write'
    )
    expect(classifyQuery('SELECT 1', 'sql', 'mysql', true).kind).toBe('write')
  })

  it('carries the dangerous-statement warnings', () => {
    const verdict = classifyQuery('DELETE FROM orders', 'sql', 'postgres', true)
    expect(verdict.kind).toBe('write')
    expect(verdict.dangerous.length).toBeGreaterThan(0)
  })

  it('classifies mongosh statements', () => {
    expect(classifyQuery('db.orders.find({})', 'mongo', null, false).kind).toBe('read')
    expect(classifyQuery('db.orders.deleteMany({})', 'mongo', null, false).kind).toBe('write')
  })
})

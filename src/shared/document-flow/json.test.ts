import { describe, expect, it } from 'vitest'

import { extractJsonObject } from './json'

describe('extractJsonObject', () => {
  it('parses a bare JSON object', () => {
    expect(extractJsonObject('  {"status": "done", "n": 1}\n')).toEqual({ status: 'done', n: 1 })
  })

  it('finds the object inside surrounding prose', () => {
    const reply = 'Here is the result you asked for:\n{"tickets": [{"key": "A1"}]}\nLet me know!'
    expect(extractJsonObject(reply)).toEqual({ tickets: [{ key: 'A1' }] })
  })

  it('unwraps a json code fence', () => {
    const reply = 'Sure.\n```json\n{"tickets": []}\n```\n'
    expect(extractJsonObject(reply)).toEqual({ tickets: [] })
  })

  it('unwraps a fence without an info string', () => {
    expect(extractJsonObject('```\n{"a": 1}\n```')).toEqual({ a: 1 })
  })

  it('keeps code fences that sit inside JSON strings', () => {
    const summary = 'Run:\n```sh\npnpm db:migrate\n```\nthen check {the} output'
    const reply = JSON.stringify({ tickets: [{ key: 'A1', summary }] }, null, 2)
    expect(extractJsonObject(reply)).toEqual({ tickets: [{ key: 'A1', summary }] })
  })

  it('keeps fences inside strings when the whole reply is fenced too', () => {
    const value = { summary: 'Use ```ts\nconst a = 1\n``` here' }
    const reply = '```json\n' + JSON.stringify(value) + '\n```'
    expect(extractJsonObject(reply)).toEqual(value)
  })

  it('takes the fenced object when the prose around it has braces', () => {
    const reply = 'I used {curly} braces above.\n```json\n{"ok": true}\n```\nDone {really}.'
    expect(extractJsonObject(reply)).toEqual({ ok: true })
  })

  it('finds a balanced object when prose with braces follows it', () => {
    const reply = 'Result: {"a": {"b": "} not the end"}} and a stray } here'
    expect(extractJsonObject(reply)).toEqual({ a: { b: '} not the end' } })
  })

  it('tolerates trailing commas', () => {
    const reply = '{"tickets": [{"key": "A1", "deps": ["B1", ],},], "note": "a, ] b",}'
    expect(extractJsonObject(reply)).toEqual({
      tickets: [{ key: 'A1', deps: ['B1'] }],
      note: 'a, ] b'
    })
  })

  it('unwraps a double-encoded object', () => {
    expect(extractJsonObject(JSON.stringify(JSON.stringify({ a: 1 })))).toEqual({ a: 1 })
  })

  it('ignores a leading byte-order mark', () => {
    expect(extractJsonObject(String.fromCharCode(0xfeff) + '{"a": 1}')).toEqual({ a: 1 })
  })

  it.each([
    ['an empty reply', ''],
    ['whitespace', '  \n '],
    ['prose', 'I could not find any tasks in this document.'],
    ['an array', '[1, 2, 3]'],
    ['a scalar', '42'],
    ['null', 'null'],
    ['a cut-off object', '{"tickets": [{"key": "A1", "title": "Tot'],
    ['broken braces', '{ this is not json }']
  ])('returns undefined for %s', (_name, reply) => {
    expect(extractJsonObject(reply)).toBeUndefined()
  })
})

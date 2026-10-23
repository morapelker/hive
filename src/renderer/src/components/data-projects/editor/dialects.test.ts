// The CodeMirror dialects: ClickHouse is defined here (lang-sql has none) and must tokenize its
// keywords, types, builtins, `#` comments, backslash strings and backtick identifiers; MySQL gets
// backslash escapes; the theme's highlighter maps lezer tag names to our token classes.
import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { ClickHouseDialect, cmSqlDialect, explainPrefix, isExplainStatement } from './dialects'
import { formatSql, formatSqlChanges } from './format'
import { tokenClassForTagName } from './theme'

/** [nodeName, text] pairs of the leaf tokens lang-sql produces for `text`. */
function tokens(text: string, language = ClickHouseDialect.language): Array<[string, string]> {
  const state = EditorState.create({ doc: text, extensions: [language] })
  const out: Array<[string, string]> = []
  syntaxTree(state).iterate({
    enter: (node) => {
      if (!node.node.firstChild && node.to > node.from) {
        out.push([node.name, text.slice(node.from, node.to)])
      }
    }
  })
  return out
}

const nodeOf = (list: Array<[string, string]>, text: string): string | undefined =>
  list.find(([, t]) => t === text)?.[0]

describe('ClickHouse dialect', () => {
  it('knows its keywords, types and builtins (lowercase lists, any case in the text)', () => {
    const t = tokens(
      'SELECT count() FROM events FINAL PREWHERE ts > now() SETTINGS max_threads = 2'
    )
    expect(nodeOf(t, 'SELECT')).toBe('Keyword')
    expect(nodeOf(t, 'FINAL')).toBe('Keyword')
    expect(nodeOf(t, 'PREWHERE')).toBe('Keyword')
    expect(nodeOf(t, 'SETTINGS')).toBe('Keyword')
    expect(nodeOf(t, 'count')).toBe('Builtin')
    expect(nodeOf(t, 'events')).toBe('Identifier')
    const types = tokens('CREATE TABLE t (a UInt32, b LowCardinality(String)) ENGINE = MergeTree')
    expect(nodeOf(types, 'UInt32')).toBe('Type')
    expect(nodeOf(types, 'LowCardinality')).toBe('Type')
    expect(nodeOf(types, 'String')).toBe('Type')
  })

  it('keeps common column names as identifiers', () => {
    const t = tokens('SELECT id, type, user, query FROM system.processes')
    for (const name of ['id', 'type', 'user', 'query']) expect(nodeOf(t, name)).toBe('Identifier')
  })

  it('lexes # comments, backslash strings, backtick identifiers and :: casts', () => {
    const t = tokens("SELECT 'a\\'b', `my col`, x::String # trailing note")
    expect(nodeOf(t, "'a\\'b'")).toBe('String')
    expect(nodeOf(t, '`my col`')).toBe('QuotedIdentifier')
    expect(t.some(([name, text]) => name === 'LineComment' && text.startsWith('#'))).toBe(true)
    expect(nodeOf(t, 'String')).toBe('Type')
  })
})

describe('other dialects', () => {
  it('MySQL reads backslash escapes inside strings', () => {
    const t = tokens("SELECT 'it\\'s', id FROM t", cmSqlDialect('mysql').language)
    expect(nodeOf(t, "'it\\'s'")).toBe('String')
    expect(nodeOf(t, 'id')).toBe('Identifier')
  })

  it('SQLite accepts bracket and backtick identifiers', () => {
    const t = tokens('SELECT [a b], `c` FROM t', cmSqlDialect('sqlite').language)
    expect(nodeOf(t, '[a b]')).toBe('QuotedIdentifier')
    expect(nodeOf(t, '`c`')).toBe('QuotedIdentifier')
  })

  it('explain prefixes', () => {
    expect(explainPrefix('sqlite')).toBe('EXPLAIN QUERY PLAN ')
    expect(explainPrefix('postgres')).toBe('EXPLAIN ')
    expect(isExplainStatement('  explain select 1')).toBe(true)
    expect(isExplainStatement('select 1')).toBe(false)
  })
})

describe('highlighter tag mapping', () => {
  it('maps lezer tag names to token classes', () => {
    expect(tokenClassForTagName('keyword')).toBe('keyword')
    expect(tokenClassForTagName('standard(name)')).toBe('builtin')
    expect(tokenClassForTagName('typeName')).toBe('type')
    expect(tokenClassForTagName('comment')).toBe('comment')
    expect(tokenClassForTagName('name')).toBeNull()
  })
})

describe('format', () => {
  it('formats per statement and keeps separators', () => {
    expect(formatSql('select id,name from users where id=1', 'postgres')).toBe(
      'SELECT\n  id,\n  name\nFROM\n  users\nWHERE\n  id = 1'
    )
    const text = 'select 1;\n-- keep me\nselect 2'
    const { changes, failed } = formatSqlChanges(text, 'mysql')
    expect(failed).toBe(0)
    let out = text
    for (const c of [...changes].reverse()) out = out.slice(0, c.from) + c.insert + out.slice(c.to)
    expect(out).toBe('SELECT\n  1;\n-- keep me\nSELECT\n  2')
  })

  it('leaves statements it cannot parse untouched', () => {
    const { changes, failed } = formatSqlChanges('select (( from', 'postgres')
    expect(failed).toBe(1)
    expect(changes).toEqual([])
  })
})

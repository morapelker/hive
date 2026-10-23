// The alias/scope-aware SQL completion as pure functions: what is wanted at the cursor
// (qualified / table / column / INSERT column list / nothing), which tables are in scope
// (aliases, JOINs, UPDATE targets, derived tables, CTEs), and the options produced against a
// schema snapshot (qualified names, ambiguous columns, quoting).
import { describe, expect, it } from 'vitest'
import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import type { DataCompletionSchema, SqlDialect } from '@shared/data-projects/types'
import { dataEditorConfig } from './context'
import { cmSqlDialect } from './dialects'
import {
  analyzeSqlCompletion,
  buildSqlCompletionIndex,
  completionStatement,
  identifierText,
  resolveTable,
  sqlKeywordCompletionSource,
  sqlSchemaCompletions,
  sqlSchemaCompletionSource
} from './sql-completion'

const PG_SCHEMA: DataCompletionSchema = {
  database: 'shop',
  defaultSchema: 'public',
  databases: ['shop', 'postgres'],
  schemas: ['public', 'analytics'],
  tables: [
    {
      schema: 'public',
      name: 'users',
      kind: 'table',
      columns: [
        { name: 'id', type: 'int4' },
        { name: 'name', type: 'text' },
        { name: 'email', type: 'text' },
        { name: 'country', type: 'text' }
      ]
    },
    {
      schema: 'public',
      name: 'orders',
      kind: 'table',
      columns: [
        { name: 'id', type: 'int4' },
        { name: 'user_id', type: 'int4' },
        { name: 'status', type: 'text' },
        { name: 'total', type: 'numeric' }
      ]
    },
    {
      schema: 'analytics',
      name: 'daily_revenue',
      kind: 'view',
      columns: [
        { name: 'day', type: 'date' },
        { name: 'revenue', type: 'numeric' }
      ]
    },
    {
      schema: 'public',
      name: 'MixedCase',
      kind: 'table',
      columns: [{ name: 'Value', type: 'text' }]
    }
  ],
  functions: ['my_func']
}

const MYSQL_SCHEMA: DataCompletionSchema = {
  database: 'shop',
  databases: ['shop', 'mysql'],
  tables: [
    {
      name: 'users',
      kind: 'table',
      columns: [
        { name: 'id', type: 'int' },
        { name: 'email', type: 'varchar(255)' }
      ]
    },
    {
      name: 'order_items',
      kind: 'table',
      columns: [
        { name: 'order_id', type: 'int' },
        { name: 'quantity', type: 'int' }
      ]
    }
  ]
}

/** Runs analysis + options for `sql` with `|` marking the cursor. */
function complete(sql: string, dialect: SqlDialect = 'postgres', schema = PG_SCHEMA) {
  const pos = sql.indexOf('|')
  const text = sql.slice(0, pos) + sql.slice(pos + 1)
  const range = completionStatement(text, pos, dialect)
  const analysis = analyzeSqlCompletion(text.slice(range.from, range.to), pos - range.from, dialect)
  const index = buildSqlCompletionIndex(schema, dialect)
  const options = analysis ? sqlSchemaCompletions(analysis, index) : []
  return { analysis, options, labels: options.map((o) => o.label) }
}

describe('completion context', () => {
  it('resolves FROM/JOIN aliases for qualified columns', () => {
    const r = complete('SELECT u.| FROM users u JOIN orders o ON o.user_id = u.id')
    expect(r.analysis?.want).toEqual({ kind: 'qualified', path: ['u'] })
    expect(r.labels).toEqual(['id', 'name', 'email', 'country'])
    const o = complete('SELECT o.st| FROM users AS u LEFT OUTER JOIN orders AS o ON true')
    expect(o.labels).toContain('status')
    expect(o.analysis?.word).toBe('st')
  })

  it('offers columns of every table in scope for unqualified names, qualifying ambiguous ones', () => {
    const r = complete('SELECT na| FROM users u JOIN orders o ON o.user_id = u.id')
    expect(r.analysis?.want.kind).toBe('column')
    expect(r.labels).toEqual(expect.arrayContaining(['name', 'status', 'total', 'u', 'o']))
    const id = r.options.filter((o) => o.label === 'id')
    expect(id.map((o) => o.apply)).toEqual(['u.id', 'o.id'])
    const name = r.options.find((o) => o.label === 'name')
    expect(name?.apply).toBe('name')
  })

  it('handles UPDATE targets and SET', () => {
    const r = complete('UPDATE users u SET u.| = 1')
    expect(r.labels).toEqual(['id', 'name', 'email', 'country'])
    const bare = complete('UPDATE users SET em|')
    expect(bare.analysis?.want.kind).toBe('column')
    expect(bare.labels).toContain('email')
  })

  it('offers the INSERT column list with an all-columns shortcut', () => {
    const r = complete('INSERT INTO users (|')
    expect(r.analysis?.want).toEqual({ kind: 'insertColumns', table: ['users'] })
    expect(r.labels[0]).toBe('id, name, email, country')
    expect(r.labels).toContain('email')
    const second = complete('INSERT INTO public.users (id, |) VALUES (1, 2)')
    expect(second.analysis?.want).toEqual({ kind: 'insertColumns', table: ['public', 'users'] })
  })

  it('wants tables after FROM/JOIN and after a comma in the FROM list, nothing in alias position', () => {
    expect(complete('SELECT * FROM |').analysis?.want.kind).toBe('table')
    expect(complete('SELECT * FROM us|').analysis?.want.kind).toBe('table')
    expect(complete('SELECT * FROM users u JOIN |').analysis?.want.kind).toBe('table')
    expect(complete('SELECT * FROM users u, |').analysis?.want.kind).toBe('table')
    expect(complete('SELECT * FROM users |').analysis?.want.kind).toBe('none')
    expect(complete('|').analysis?.want.kind).toBe('none')
    const tables = complete('SELECT * FROM |').labels
    expect(tables).toEqual(expect.arrayContaining(['users', 'orders', 'analytics.daily_revenue']))
    expect(tables).toEqual(expect.arrayContaining(['public', 'analytics']))
  })

  it('resolves schema- and database-qualified names', () => {
    const schemaTables = complete('SELECT * FROM analytics.|')
    expect(schemaTables.labels).toEqual(['daily_revenue'])
    const cols = complete('SELECT analytics.daily_revenue.| FROM analytics.daily_revenue')
    expect(cols.labels).toEqual(['day', 'revenue'])
    const viaAlias = complete('SELECT r.| FROM analytics.daily_revenue r')
    expect(viaAlias.labels).toEqual(['day', 'revenue'])
    const mysqlDb = complete('SELECT * FROM shop.|', 'mysql', MYSQL_SCHEMA)
    expect(mysqlDb.labels).toEqual(['users', 'order_items'])
    const mysqlCols = complete('SELECT shop.users.| FROM shop.users', 'mysql', MYSQL_SCHEMA)
    expect(mysqlCols.labels).toEqual(['id', 'email'])
  })

  it('reads derived tables and CTEs (best effort)', () => {
    const derived = complete('SELECT s.| FROM (SELECT id, email AS mail, count(*) n FROM users) s')
    expect(derived.labels).toEqual(['id', 'mail', 'n'])
    const cte = complete('WITH x AS (SELECT id, name FROM users) SELECT x.| FROM x')
    expect(cte.labels).toEqual(['id', 'name'])
    const cteCols = complete('WITH t(a, b) AS (SELECT 1, 2) SELECT | FROM t', 'postgres')
    // unqualified in a column context with an empty word: options still computed
    expect(cteCols.labels).toEqual(expect.arrayContaining(['a', 'b']))
    const cteTable = complete('WITH recent AS (SELECT * FROM orders) SELECT * FROM |')
    expect(cteTable.labels[0]).toBe('recent')
    const star = complete('SELECT s.| FROM (SELECT * FROM orders o) s')
    expect(star.labels).toEqual(['id', 'user_id', 'status', 'total'])
  })

  it('sees the inner scope of a subquery and the outer one ranked lower', () => {
    const r = complete('SELECT * FROM users u WHERE u.id IN (SELECT o.| FROM orders o)')
    expect(r.labels).toEqual(['id', 'user_id', 'status', 'total'])
    const both = complete(
      'SELECT * FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = |)'
    )
    const status = both.options.find((o) => o.label === 'status')
    const email = both.options.find((o) => o.label === 'email')
    expect(status?.boost).toBeGreaterThan(email?.boost ?? 0)
  })

  it('returns nothing inside strings and comments', () => {
    expect(complete("SELECT 'u.|' FROM users u").analysis).toBeNull()
    expect(complete('SELECT 1 -- u.|').analysis).toBeNull()
  })

  it('keeps working after an unterminated opening quote', () => {
    const r = complete('SELECT * FROM "Mix|')
    expect(r.analysis?.quote).toBe('"')
    expect(r.analysis?.word).toBe('Mix')
    expect(r.analysis?.want.kind).toBe('table')
    const cols = complete('SELECT "|  FROM users', 'postgres')
    expect(cols.analysis?.scope.map((s) => s.path)).toEqual([['users']])
  })

  it('cuts the statement at delimiters around the cursor', () => {
    const doc = 'SELECT 1;\nSELECT * FROM users u WHERE u.| ;\nSELECT 2'
    const r = complete(doc)
    expect(r.labels).toEqual(['id', 'name', 'email', 'country'])
    const afterLast = completionStatement('SELECT 1;\nSELECT * FROM ', 23, 'postgres')
    expect(afterLast.from).toBe(9)
  })
})

describe('schema index', () => {
  it('quotes identifiers only when needed', () => {
    expect(identifierText('users', 'postgres')).toBe('users')
    expect(identifierText('MixedCase', 'postgres')).toBe('"MixedCase"')
    expect(identifierText('MixedCase', 'mysql')).toBe('MixedCase')
    expect(identifierText('order', 'mysql')).toBe('`order`')
    expect(identifierText('my col', 'clickhouse')).toBe('`my col`')
    const r = complete('SELECT * FROM Mix|')
    const option = r.options.find((o) => o.label === 'MixedCase')
    expect(option?.apply).toBe('"MixedCase"')
  })

  it('resolves tables case-insensitively, preferring the default schema', () => {
    const index = buildSqlCompletionIndex(PG_SCHEMA, 'postgres')
    expect(resolveTable(index, ['USERS'])?.name).toBe('users')
    expect(resolveTable(index, ['analytics', 'daily_revenue'])?.kind).toBe('view')
    expect(resolveTable(index, ['nope'])).toBeNull()
  })

  it('offers functions (user-defined first) in column context', () => {
    const r = complete('SELECT my|', 'postgres')
    const fn = r.options.find((o) => o.label === 'my_func')
    expect(fn?.type).toBe('function')
    expect(r.labels).toContain('count')
  })
})

describe('CodeMirror sources', () => {
  const contextFor = (sql: string, keywordCase: 'upper' | 'lower' = 'upper', explicit = false) => {
    const pos = sql.indexOf('|')
    const doc = sql.slice(0, pos) + sql.slice(pos + 1)
    const state = EditorState.create({
      doc,
      selection: { anchor: pos },
      extensions: [
        cmSqlDialect('postgres').language,
        dataEditorConfig.of({
          language: 'sql',
          dialect: 'postgres',
          completionIndex: buildSqlCompletionIndex(PG_SCHEMA, 'postgres'),
          keywordCase,
          extraSources: [],
          statementRange: null
        })
      ]
    })
    return new CompletionContext(state, pos, explicit)
  }

  it('completes alias members from the editor state', async () => {
    const result = await sqlSchemaCompletionSource(contextFor('SELECT u.em| FROM users u'))
    expect(result?.from).toBe(9)
    expect(result?.options.map((o) => o.label)).toContain('email')
  })

  it('stays quiet for an empty word in column position unless asked', async () => {
    expect(await sqlSchemaCompletionSource(contextFor('SELECT | FROM users'))).toBeNull()
    const explicit = await sqlSchemaCompletionSource(
      contextFor('SELECT | FROM users', 'upper', true)
    )
    expect(explicit?.options.map((o) => o.label)).toContain('email')
  })

  it('offers keywords in the configured case', async () => {
    const upper = await sqlKeywordCompletionSource(contextFor('sel|'))
    expect(upper?.options.some((o) => o.label === 'SELECT')).toBe(true)
    const lower = await sqlKeywordCompletionSource(contextFor('sel|', 'lower'))
    expect(lower?.options.some((o) => o.label === 'select')).toBe(true)
  })

  it('offers no keywords after a member dot', async () => {
    expect(await sqlKeywordCompletionSource(contextFor('SELECT u.co| FROM users u'))).toBeNull()
    expect(await sqlKeywordCompletionSource(contextFor('SELECT * FROM "public".us|'))).toBeNull()
    expect(await sqlKeywordCompletionSource(contextFor('SELECT u.| FROM users u'))).toBeNull()
  })

  // CodeMirror lists unsectioned options above every section, so keywords and functions must
  // sit in sections ranked after the per-table column groups (rank = scope index).
  it('ranks keywords and functions after columns', async () => {
    const keywords = await sqlKeywordCompletionSource(contextFor('SELECT * FROM users WHERE co|'))
    const columns = await sqlSchemaCompletionSource(contextFor('SELECT * FROM users WHERE co|'))
    const rank = (o: { section?: unknown }): number =>
      typeof o.section === 'object' && o.section && 'rank' in o.section
        ? Number((o.section as { rank: number }).rank)
        : -1
    const column = columns?.options.find((o) => o.label === 'country')
    const fn = columns?.options.find((o) => o.type === 'function')
    expect(column && rank(column)).toBe(0)
    expect(fn && rank(fn)).toBeGreaterThan(0)
    expect(keywords?.options.every((o) => rank(o) > (fn ? rank(fn) : 0))).toBe(true)
  })

  it('ranks everyday keywords above the SQL-standard tail', async () => {
    const result = await sqlKeywordCompletionSource(contextFor('sel|'))
    const boost = (label: string): number =>
      result?.options.find((o) => o.label === label)?.boost ?? Number.NaN
    expect(boost('SELECT')).toBeGreaterThan(boost('SELF'))
  })
})

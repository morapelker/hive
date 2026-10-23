// @vitest-environment node
// The assistant's tool registry and toolbox: which tools are offered (data-reading tools only
// with allowAiDataAccess), what they read and say, the 8 KB cap, argument validation, credential
// masking of everything a tool returns, and the propose_query path (validation, rejection,
// proposal event). Nothing here runs a query.
import { describe, expect, it, vi } from 'vitest'
import type {
  DataAssistantEvent,
  DataStatementOutput
} from '../../../../../shared/data-projects/types'
import {
  AssistantToolbox,
  buildAssistantTools,
  capText,
  formatZonedIso,
  stripCodeFence,
  TOOL_RESULT_MAX_CHARS
} from '../tools'
import { AssistantAbort } from '../types'
import { fakeEngine, ORDERS_DETAILS, toolContext } from './fakes'

function toolbox(
  ctx = toolContext(),
  validateProposal?: ConstructorParameters<typeof AssistantToolbox>[0]['validateProposal']
): { box: AssistantToolbox; events: DataAssistantEvent[] } {
  const events: DataAssistantEvent[] = []
  const box = new AssistantToolbox({
    ctx,
    emit: (event) => events.push(event),
    ...(validateProposal ? { validateProposal } : {})
  })
  return { box, events }
}

describe('buildAssistantTools', () => {
  it('offers the SQL tools without sample_rows unless the project allows AI data access', () => {
    const names = buildAssistantTools({ engine: 'postgres', allowDataAccess: false }).map(
      (t) => t.name
    )
    expect(names).toEqual([
      'list_databases',
      'list_tables',
      'describe_table',
      'get_table_ddl',
      'search_columns',
      'get_current_time',
      'propose_query'
    ])
    const withData = buildAssistantTools({ engine: 'mysql', allowDataAccess: true }).map(
      (t) => t.name
    )
    expect(withData).toContain('sample_rows')
  })

  it('offers the Mongo tools, gating sample_documents the same way', () => {
    const names = buildAssistantTools({ engine: 'mongodb', allowDataAccess: false }).map(
      (t) => t.name
    )
    expect(names).toEqual([
      'list_databases',
      'list_collections',
      'infer_collection_schema',
      'list_indexes',
      'get_current_time',
      'propose_query'
    ])
    expect(
      buildAssistantTools({ engine: 'mongodb', allowDataAccess: true }).map((t) => t.name)
    ).toContain('sample_documents')
  })
})

describe('capText', () => {
  it('cuts long results at a line break and says how much is missing', () => {
    const long = Array.from({ length: 2000 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n')
    const capped = capText(long)
    expect(capped.length).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS)
    expect(capped).toMatch(/\[truncated: [\d,]+ more characters not shown/)
    expect(capText('short')).toBe('short')
    // Characters already dropped (past the masking window) still count as missing.
    expect(capText('short', TOOL_RESULT_MAX_CHARS, 1_234)).toBe(
      'short\n… [truncated: 1,234 more characters not shown. Narrow the request (a pattern, one table, a smaller sample) to see the rest.]'
    )
  })
})

describe('AssistantToolbox — schema tools', () => {
  it('lists tables with row estimates, counts other objects and names the schemas', async () => {
    const { box, events } = toolbox()
    const result = await box.call('list_tables', {})
    expect(result.ok).toBe(true)
    expect(result.text).toContain('public.orders (~1,234 rows) — customer orders')
    expect(result.text).toContain('Also in this schema: 1 function(s)')
    expect(result.text).toContain('Schemas in this database: public, analytics.')
    expect(events.map((e) => e.type)).toEqual(['tool_start', 'tool_end'])
    expect(events[1]).toMatchObject({ type: 'tool_end', ok: true, summary: '4 tables' })
  })

  it('filters by a glob or substring pattern', async () => {
    const { box } = toolbox()
    expect((await box.call('list_tables', { pattern: 'order*' })).text).toMatch(/: 2\n/)
    expect((await box.call('list_tables', { pattern: 'USER' })).text).toContain('public.users')
  })

  it('splits schema.table for PostgreSQL and describes the table compactly', async () => {
    const engine = fakeEngine()
    const { box } = toolbox(toolContext({ service: engine }))
    const result = await box.call('mcp__db__describe_table', { table: 'analytics.orders' })
    expect(engine.describe).toHaveBeenCalledWith('dp-1', {
      name: 'orders',
      schema: 'analytics',
      database: 'shop'
    })
    expect(result.text).toContain('id integer NOT NULL PK auto-increment')
    expect(result.text).toContain("status text NOT NULL DEFAULT 'new'::text")
    expect(result.text).toContain('(user_id) → public.users(id) ON DELETE CASCADE')
    expect(result.text).toContain('orders_user_id_idx (user_id)')
  })

  it('treats db.table as database.table on MySQL-family engines', async () => {
    const engine = fakeEngine()
    const { box } = toolbox(toolContext({ engine: 'mysql', schema: undefined, service: engine }))
    await box.call('get_table_ddl', { table: 'other.orders' })
    expect(engine.ddl).toHaveBeenCalledWith('dp-1', { name: 'orders', database: 'other' })
  })

  it('searches columns across the schema snapshot', async () => {
    const { box } = toolbox()
    const result = await box.call('search_columns', { pattern: '*_at' })
    expect(result.text).toContain('public.users.created_at timestamptz')
    expect(result.text).toContain('public.orders.created_at timestamptz')
    expect(result.text).not.toContain('email')
  })

  it('caps a huge listing at ~8 KB and says it was truncated', async () => {
    const objects = Array.from({ length: 2_000 }, (_, i) => ({
      name: `table_with_a_long_name_${i}`,
      schema: 'public',
      kind: 'table' as const,
      comment: 'x'.repeat(60)
    }))
    const engine = fakeEngine({ objects: vi.fn(async () => ({ objects })) })
    const { box } = toolbox(toolContext({ service: engine }))
    const result = await box.call('list_tables', {})
    expect(result.text.length).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS)
    expect(result.text).toContain('[truncated:')
    // The count covers the whole ~30 KB listing (300 lines), not just the 10 KB masked window.
    const missing = Number(/\[truncated: ([\d,]+) more/.exec(result.text)?.[1].replace(/,/g, ''))
    expect(missing).toBeGreaterThan(15_000)
  })

  it('reports tool failures to the model instead of throwing', async () => {
    const engine = fakeEngine({
      describe: vi.fn(async () => {
        throw new Error('relation "nope" does not exist')
      })
    })
    const { box, events } = toolbox(toolContext({ service: engine }))
    const result = await box.call('describe_table', { table: 'nope' })
    expect(result).toEqual({ ok: false, text: 'Error: relation "nope" does not exist' })
    expect(events[1]).toMatchObject({ type: 'tool_end', ok: false })
  })

  it('rejects invalid arguments and unknown tools with a usable message', async () => {
    const { box, events } = toolbox()
    const invalid = await box.call('describe_table', { table: 42 })
    expect(invalid.ok).toBe(false)
    expect(invalid.text).toContain('Invalid arguments for describe_table')
    expect(invalid.text).toContain('{ table: string')
    expect(events.at(-1)).toMatchObject({
      type: 'tool_end',
      ok: false,
      summary: 'invalid arguments'
    })

    const unknown = await box.call('drop_everything', {})
    expect(unknown.ok).toBe(false)
    expect(unknown.text).toContain('Available tools:')
  })

  it('accepts null for optional arguments (some models send it)', async () => {
    const { box } = toolbox()
    const result = await box.call('list_tables', { database: null, schema: null, pattern: null })
    expect(result.ok).toBe(true)
  })

  it('gives today and yesterday in the user time zone', async () => {
    const { box } = toolbox()
    const result = await box.call('get_current_time', {})
    expect(result.text).toContain('now: 2026-10-23T07:05:00-04:00 (America/New_York), Friday')
    expect(result.text).toContain('today starts: 2026-10-23T00:00:00-04:00')
    expect(result.text).toContain('yesterday starts: 2026-10-22T00:00:00-04:00')
    expect(formatZonedIso(new Date('2026-01-15T12:00:00Z'), 'Asia/Jerusalem')).toBe(
      '2026-01-15T14:00:00+02:00'
    )
  })
})

describe('AssistantToolbox — data access', () => {
  it('does not offer or run sample_rows without data access', async () => {
    const engine = fakeEngine()
    const { box } = toolbox(toolContext({ service: engine }))
    const result = await box.call('sample_rows', { table: 'orders' })
    expect(result.ok).toBe(false)
    expect(result.text).toContain('Unknown tool')
    expect(engine.sampleRows).not.toHaveBeenCalled()
  })

  it('samples at most 5 rows and redacts sensitive-looking columns', async () => {
    const engine = fakeEngine()
    const { box } = toolbox(toolContext({ service: engine, allowDataAccess: true }))
    const result = await box.call('sample_rows', { table: 'orders', limit: 50 })
    expect(engine.sampleRows).toHaveBeenCalledWith(
      'dp-1',
      { name: 'orders', database: 'shop', schema: 'public' },
      5
    )
    expect(result.text).toContain('{ id: 1, status: "paid", password_hash: [redacted] }')
    expect(result.text).toContain('1 sensitive-looking column(s) redacted')
    expect(result.text).not.toContain('$2b$')
  })

  it('infers a collection schema without sample values unless data access is allowed', async () => {
    const engine = fakeEngine()
    const ctx = toolContext({ engine: 'mongodb', schema: undefined, service: engine })
    const { box } = toolbox(ctx)
    const result = await box.call('infer_collection_schema', {
      collection: 'orders',
      sampleSize: 500
    })
    expect(engine.mongo.schema).toHaveBeenCalledWith({
      dataProjectId: 'dp-1',
      database: 'shop',
      collection: 'orders',
      sampleSize: 100
    })
    expect(result.text).toContain('shop.orders — ~300 documents, sampled 50 document(s)')
    expect(result.text).toContain('createdAt: Date 75% | Null 25% [in 80% of documents]')
    expect(result.text).not.toContain('"paid"')

    const allowed = toolbox({ ...ctx, allowDataAccess: true })
    const withValues = await allowed.box.call('infer_collection_schema', { collection: 'orders' })
    expect(withValues.text).toContain('status: String  e.g. "paid", "shipped"')
  })

  it('lists Mongo indexes and asks for a database when none is selected', async () => {
    const { box } = toolbox(toolContext({ engine: 'mongodb', schema: undefined }))
    const result = await box.call('list_indexes', { collection: 'orders' })
    expect(result.text).toContain('createdAt_-1 {"createdAt":-1} (TTL 3600s)')

    const noDb = toolbox(toolContext({ engine: 'mongodb', schema: undefined, database: undefined }))
    const missing = await noDb.box.call('list_collections', {})
    expect(missing.ok).toBe(false)
    expect(missing.text).toContain('No database is selected')
  })
})

describe('AssistantToolbox — credentials never reach the model', () => {
  it('masks credentials embedded in server DDL (FEDERATED CONNECTION, dblink conninfo)', async () => {
    const mysql = fakeEngine({
      ddl: vi.fn(
        async () =>
          "CREATE TABLE `remote_users` (\n  `id` int NOT NULL\n) ENGINE=FEDERATED CONNECTION='mysql://fed_user:FedPw!9@10.0.0.7:3306/crm/users'"
      )
    })
    const federated = await toolbox(
      toolContext({ engine: 'mysql', schema: undefined, service: mysql })
    ).box.call('get_table_ddl', { table: 'remote_users' })
    expect(federated.ok).toBe(true)
    expect(federated.text).not.toContain('FedPw!9')
    expect(federated.text).toContain("CONNECTION='mysql://fed_user:***@10.0.0.7:3306/crm/users'")

    const pg = fakeEngine({
      ddl: vi.fn(
        async () =>
          "CREATE VIEW public.remote_orders AS\n SELECT t.id FROM dblink('host=10.0.0.8 dbname=crm user=crm password=DblinkPw7'::text, 'select id from orders'::text) t(id integer);"
      )
    })
    const view = await toolbox(toolContext({ service: pg })).box.call('get_table_ddl', {
      table: 'remote_orders'
    })
    expect(view.text).not.toContain('DblinkPw7')
    expect(view.text).toContain('password=***')
  })

  it('masks defaults, comments and engine clauses before they are cut', async () => {
    const engine = fakeEngine({
      describe: vi.fn(async () => ({
        ...ORDERS_DETAILS,
        comment: 'synced from postgres://sync:CommentPw1@replica/shop',
        columns: [
          ...ORDERS_DETAILS.columns,
          {
            name: 'api_token',
            type: 'text',
            nullable: true,
            isPrimaryKey: false,
            ordinal: 6,
            defaultValue: "'tok_DefaultSecret'::text"
          },
          {
            name: 'dsn',
            type: 'text',
            nullable: true,
            isPrimaryKey: false,
            ordinal: 7,
            // The 80-character cut falls inside the password.
            defaultValue: `'host=replica.internal.example.com dbname=shop user=sync password=LongDefaultPw55'::text`
          }
        ],
        properties: [
          {
            label: 'Engine',
            value: `MySQL('mysql-host:3306', 'shop', 'orders', 'reader', 'EnginePw3')${' '.repeat(300)}`
          }
        ]
      }))
    })
    const result = await toolbox(toolContext({ engine: 'clickhouse', service: engine })).box.call(
      'describe_table',
      { table: 'orders' }
    )
    for (const secret of ['CommentPw1', 'tok_DefaultSecret', 'LongDefault', 'EnginePw3'])
      expect(result.text).not.toContain(secret)
    expect(result.text).toContain('api_token text NULL DEFAULT [redacted]')
    expect(result.text).toContain(
      "Engine: MySQL('mysql-host:3306', 'shop', 'orders', 'reader', '***')"
    )
  })

  it('masks credentials in sample cells and documents, and in tool errors', async () => {
    const rows: DataStatementOutput = {
      kind: 'rows',
      columns: [{ name: 'id' }, { name: 'webhook' }],
      rows: [[1, `https://hooks:CellPw4@example.com/${'x'.repeat(300)}`]],
      truncated: false,
      limit: 3,
      autoLimited: false
    }
    const sql = fakeEngine({
      sampleRows: vi.fn(async () => rows),
      describe: vi.fn(async () => {
        throw new Error(
          'syntax error at or near "IDENTIFIED": ALTER USER app IDENTIFIED BY \'ErrorPw5\''
        )
      })
    })
    const { box } = toolbox(toolContext({ service: sql, allowDataAccess: true }))
    const sample = await box.call('sample_rows', { table: 'hooks' })
    expect(sample.text).not.toContain('CellPw4')
    expect(sample.text).toContain('https://hooks:***@example.com/')
    const failed = await box.call('describe_table', { table: 'x' })
    expect(failed.ok).toBe(false)
    expect(failed.text).not.toContain('ErrorPw5')
    expect(failed.text).toContain("IDENTIFIED BY '***'")

    const docs: DataStatementOutput = {
      kind: 'documents',
      documents: [{ _id: 1, conn: 'mongodb://svc:DocPw6@mongo-1/shop', nested: { pwd: 'x' } }],
      truncated: false,
      limit: 3
    }
    const mongo = fakeEngine({ sampleRows: vi.fn(async () => docs) })
    const documents = await toolbox(
      toolContext({ engine: 'mongodb', schema: undefined, service: mongo, allowDataAccess: true })
    ).box.call('sample_documents', { collection: 'orders' })
    expect(documents.text).not.toContain('DocPw6')
    expect(documents.text).toContain('mongodb://svc:***@mongo-1/shop')
    // Not a SENSITIVE_NAME column, but the mongosh masker knows `pwd`.
    expect(documents.text).toContain('"nested":{"pwd":"***"}')
  })
})

describe('AssistantToolbox — propose_query', () => {
  it('delivers the query as a proposal event and ends the run', async () => {
    const { box, events } = toolbox()
    const result = await box.call('propose_query', {
      query: '```sql\nSELECT id FROM orders\n```',
      explanation: 'Order ids.',
      is_write: false
    })
    expect(result).toMatchObject({ ok: true, final: true })
    expect(box.proposal).toEqual({
      language: 'sql',
      query: 'SELECT id FROM orders',
      explanation: 'Order ids.',
      isWrite: false,
      database: 'shop'
    })
    expect(events.map((e) => e.type)).toEqual(['tool_start', 'tool_end', 'proposal'])
    // The chip never shows the query itself.
    expect(events[0]).toMatchObject({ type: 'tool_start', args: { is_write: false } })

    const again = await box.call('list_tables', {})
    expect(again.final).toBe(true)
    expect(events).toHaveLength(3)
  })

  it('bounces an unparseable query back to the model twice, then delivers it with a warning', async () => {
    const validate = vi.fn(async () => ({ ok: false as const, error: 'unterminated string' }))
    const { box, events } = toolbox(toolContext(), validate)
    const args = { query: "SELECT 'oops", explanation: 'x', is_write: false }
    expect((await box.call('propose_query', args)).text).toContain(
      'NOT delivered: unterminated string'
    )
    expect((await box.call('propose_query', args)).ok).toBe(false)
    const third = await box.call('propose_query', args)
    expect(third.final).toBe(true)
    expect(box.proposal?.explanation).toContain('could not parse this query (unterminated string)')
    expect(events.filter((e) => e.type === 'proposal')).toHaveLength(1)
  })

  it('lets the classifier mark a write the model called a read', async () => {
    const validate = vi.fn(async () => ({ ok: true as const, isWrite: true }))
    const { box } = toolbox(toolContext(), validate)
    await box.call('propose_query', {
      query: 'DELETE FROM orders WHERE id = 1',
      explanation: '',
      is_write: false
    })
    expect(validate).toHaveBeenCalledWith({
      language: 'sql',
      dialect: 'postgres',
      engine: 'postgres',
      query: 'DELETE FROM orders WHERE id = 1'
    })
    expect(box.proposal?.isWrite).toBe(true)
  })

  it('still delivers when the validator itself fails', async () => {
    const validate = vi.fn(async () => {
      throw new Error('module missing')
    })
    const { box } = toolbox(toolContext({ engine: 'mongodb', schema: undefined }), validate)
    await box.call('propose_query', {
      query: 'db.orders.find({})',
      explanation: '',
      is_write: false
    })
    expect(box.proposal).toMatchObject({ language: 'mongo', query: 'db.orders.find({})' })
  })

  it('throws once the run is aborted', async () => {
    const controller = new AbortController()
    controller.abort(new AssistantAbort('cancelled'))
    const { box } = toolbox(toolContext({ signal: controller.signal }))
    await expect(box.call('list_tables', {})).rejects.toMatchObject({ reason: 'cancelled' })
  })

  it('strips a Markdown fence around a proposed query', () => {
    expect(stripCodeFence('```js\ndb.orders.find()\n```')).toBe('db.orders.find()')
    expect(stripCodeFence('  SELECT 1  ')).toBe('SELECT 1')
  })
})

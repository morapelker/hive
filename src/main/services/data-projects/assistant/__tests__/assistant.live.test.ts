// @vitest-environment node
// LIVE: the real Claude runner (Agent SDK + the system `claude` binary + in-process MCP tools)
// answering questions about the live PostgreSQL `shop` database, through a minimal engine
// backed by `pg` directly. Gated separately from the database integration tests because it
// spends model tokens: TEDOOO_DP_AI_IT=1 (model: TEDOOO_DP_AI_MODEL, default sonnet).
//
//   TEDOOO_DP_AI_IT=1 ./node_modules/.bin/vitest run --project main \
//     src/main/services/data-projects/assistant/__tests__/assistant.live.test.ts
//
// It checks the whole loop: tools are called, a query is proposed (never executed), it names
// real columns, and a delete request comes back flagged as a write.
import { execFileSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import type {
  DataAssistantEvent,
  DataAssistantEventPayload,
  DataCompletionSchema,
  DataConnectionStatus,
  DataObjectRef,
  DataTableDetails
} from '../../../../../shared/data-projects/types'
import { createClaudeRunner, type ClaudeAgentSdk } from '../runner-claude'
import { DataAssistantService } from '../service'
import type { AssistantEngineService, AssistantRunner } from '../types'
import { sampleRecord } from './fakes'

vi.mock('../../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

const itLive = process.env.TEDOOO_DP_AI_IT ? it : it.skip
const MODEL = process.env.TEDOOO_DP_AI_MODEL || 'sonnet'

type PgClient = {
  connect(): Promise<void>
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
  end(): Promise<void>
}

async function withPg<T>(run: (client: PgClient) => Promise<T>): Promise<T> {
  const { Client } = await import('pg')
  const client = new Client({
    host: '127.0.0.1',
    port: 15432,
    user: 'postgres',
    password: 'pgpw',
    database: 'shop'
  }) as unknown as PgClient
  await client.connect()
  try {
    // Defense in depth: nothing in this engine writes, and the session cannot either.
    await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY')
    return await run(client)
  } finally {
    await client.end()
  }
}

/** The introspection slice of DataEngineService over plain catalog queries. */
function pgEngine(): AssistantEngineService & { calls: string[] } {
  const calls: string[] = []
  const describe = async (ref: DataObjectRef): Promise<DataTableDetails> =>
    withPg(async (client) => {
      const schema = ref.schema ?? 'public'
      const columns = await client.query(
        `SELECT column_name, data_type, is_nullable, column_default, ordinal_position
           FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2
          ORDER BY ordinal_position`,
        [schema, ref.name]
      )
      if (!columns.rows.length) throw new Error(`relation "${schema}.${ref.name}" does not exist`)
      const pk = await client.query(
        `SELECT a.attname FROM pg_index i
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
          WHERE i.indrelid = ($1 || '.' || $2)::regclass AND i.indisprimary`,
        [schema, ref.name]
      )
      const fks = await client.query(
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = ($1 || '.' || $2)::regclass AND contype = 'f'`,
        [schema, ref.name]
      )
      const primaryKey = pk.rows.map((row) => String(row.attname))
      return {
        ref: { ...ref, schema },
        kind: 'table',
        columns: columns.rows.map((row) => ({
          name: String(row.column_name),
          type: String(row.data_type),
          nullable: row.is_nullable === 'YES',
          defaultValue: (row.column_default as string | null) ?? null,
          isPrimaryKey: primaryKey.includes(String(row.column_name)),
          ordinal: Number(row.ordinal_position)
        })),
        indexes: [],
        foreignKeys: fks.rows.map((row) => {
          const def = String(row.def)
          const match = /FOREIGN KEY \((.+?)\) REFERENCES (.+?)\((.+?)\)/.exec(def)
          return {
            name: String(row.conname),
            columns: match ? match[1].split(', ') : [],
            refTable: match ? match[2] : def,
            refColumns: match ? match[3].split(', ') : []
          }
        }),
        triggers: [],
        primaryKey
      }
    })

  const connected = async (): Promise<DataConnectionStatus> => {
    const version = await withPg(
      async (client) => (await client.query('SHOW server_version')).rows[0]
    )
    return {
      dataProjectId: 'dp-1',
      state: 'connected',
      serverVersion: String(version.server_version).split(' ')[0],
      currentDatabase: 'shop'
    }
  }

  return {
    calls,
    status: () => ({ dataProjectId: 'dp-1', state: 'disconnected' }),
    connect: async () => connected(),
    databases: async () => {
      calls.push('databases')
      return withPg(async (client) =>
        (
          await client.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY 1')
        ).rows.map((row) => ({ name: String(row.datname) }))
      )
    },
    objects: async (_id, _database, schema) => {
      calls.push(`objects(${schema ?? ''})`)
      return withPg(async (client) => {
        const objects = await client.query(
          `SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1`,
          [schema ?? 'public']
        )
        const schemas = await client.query(
          `SELECT schema_name FROM information_schema.schemata
            WHERE schema_name NOT LIKE 'pg_%' AND schema_name <> 'information_schema' ORDER BY 1`
        )
        return {
          schemas: schemas.rows.map((row) => String(row.schema_name)),
          objects: objects.rows.map((row) => ({
            name: String(row.table_name),
            schema: schema ?? 'public',
            kind: row.table_type === 'VIEW' ? ('view' as const) : ('table' as const)
          }))
        }
      })
    },
    describe: async (_id, ref) => {
      calls.push(`describe(${ref.schema ?? ''}.${ref.name})`)
      return describe(ref)
    },
    ddl: async (_id, ref) => {
      calls.push(`ddl(${ref.name})`)
      const details = await describe(ref)
      return `CREATE TABLE ${details.ref.schema}.${ref.name} (\n${details.columns
        .map((c) => `  ${c.name} ${c.type}${c.nullable ? '' : ' NOT NULL'}`)
        .join(',\n')}\n);`
    },
    completionSchema: async (): Promise<DataCompletionSchema> => {
      calls.push('completionSchema')
      return withPg(async (client) => {
        const rows = await client.query(
          `SELECT c.table_schema, c.table_name, c.column_name, c.data_type, t.table_type
             FROM information_schema.columns c
             JOIN information_schema.tables t USING (table_schema, table_name)
            WHERE c.table_schema IN ('public', 'analytics')
            ORDER BY c.table_schema, c.table_name, c.ordinal_position`
        )
        const tables = new Map<string, DataCompletionSchema['tables'][number]>()
        for (const row of rows.rows) {
          const key = `${row.table_schema}.${row.table_name}`
          if (!tables.has(key)) {
            tables.set(key, {
              schema: String(row.table_schema),
              name: String(row.table_name),
              kind: row.table_type === 'VIEW' ? 'view' : 'table',
              columns: []
            })
          }
          tables
            .get(key)!
            .columns.push({ name: String(row.column_name), type: String(row.data_type) })
        }
        return {
          database: 'shop',
          defaultSchema: 'public',
          databases: ['shop'],
          schemas: ['public', 'analytics'],
          tables: [...tables.values()]
        }
      })
    },
    sampleRows: async () => {
      throw new Error('sampling is not allowed in this test')
    },
    mongo: {
      schema: async () => {
        throw new Error('not a MongoDB project')
      },
      indexes: async () => {
        throw new Error('not a MongoDB project')
      }
    }
  }
}

function liveClaudeRunner(): AssistantRunner {
  const binaryPath = execFileSync('which', ['claude'], { encoding: 'utf-8' }).trim() || null
  // Like the app's backend: the user's environment, minus this test runner's own Claude Code
  // session markers (the assistant is not a nested coding session).
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key !== 'CLAUDECODE' && !key.startsWith('CLAUDE_CODE_')
    )
  )
  return createClaudeRunner({
    loadSdk: async () =>
      (await import('@anthropic-ai/claude-agent-sdk')) as unknown as ClaudeAgentSdk,
    launch: async () => {
      const { normalizeClaudeCliModel } = await import('../../../claude-cli-spawner')
      return { env, binaryPath, normalizeModel: normalizeClaudeCliModel }
    }
  })
}

async function ask(
  question: string
): Promise<{ events: DataAssistantEvent[]; engine: ReturnType<typeof pgEngine> }> {
  const engine = pgEngine()
  const payloads: DataAssistantEventPayload[] = []
  let finish: (events: DataAssistantEvent[]) => void = () => {}
  const finished = new Promise<DataAssistantEvent[]>((resolve) => {
    finish = resolve
  })
  const { validateAssistantProposal } = await import('../service')
  const service = new DataAssistantService({
    publish: (payload) => {
      payloads.push(payload)
      if (payload.event.type === 'done' || payload.event.type === 'error') {
        finish(payloads.map((p) => p.event))
      }
    },
    getProject: async () => sampleRecord(),
    getEngine: async () => engine,
    runClaude: liveClaudeRunner(),
    runJsonLoop: async () => {
      throw new Error('the live test exercises the Claude runner only')
    },
    validateProposal: validateAssistantProposal,
    timeZone: () => 'Asia/Jerusalem'
  })
  await service.start({
    requestId: `live-${Date.now()}`,
    dataProjectId: 'dp-1',
    question,
    database: 'shop',
    schema: 'public',
    history: [],
    generation: { provider: 'claude-code', model: MODEL, effort: 'low' }
  })
  const events = await finished
  // A readable transcript for the report.
  const lines = events
    .filter((e) => e.type !== 'text_delta')
    .map((e) => {
      switch (e.type) {
        case 'tool_start':
          return `  → ${e.name}(${JSON.stringify(e.args)})`
        case 'tool_end':
          return `    ${e.ok ? 'ok' : 'ERR'} ${e.summary} (${e.ms} ms)`
        case 'proposal':
          return `  PROPOSAL [${e.proposal.isWrite ? 'write' : 'read'}] ${e.proposal.query.replace(/\s+/g, ' ')}\n    ${e.proposal.explanation}`
        default:
          return `  ${e.type}: ${JSON.stringify(e).slice(0, 200)}`
      }
    })
  console.log(`\nQ: ${question}\n${lines.join('\n')}\n  engine calls: ${engine.calls.join(', ')}`)
  return { events, engine }
}

describe('database assistant (live Claude, live PostgreSQL)', () => {
  itLive(
    'proposes a read query over real columns for a relative-date question',
    async () => {
      const { events } = await ask('How many orders were created since yesterday, per status?')
      expect(events.at(-1)?.type).toBe('done')
      expect(events.some((e) => e.type === 'tool_start')).toBe(true)
      const proposal = events.find((e) => e.type === 'proposal')
      expect(proposal?.type).toBe('proposal')
      if (proposal?.type !== 'proposal') return
      expect(proposal.proposal.language).toBe('sql')
      expect(proposal.proposal.isWrite).toBe(false)
      expect(proposal.proposal.query).toMatch(/orders/i)
      expect(proposal.proposal.query).toMatch(/created_at/i)
      expect(proposal.proposal.query).toMatch(/status/i)
    },
    240_000
  )

  itLive(
    'flags a delete request as a write',
    async () => {
      const { events } = await ask('Delete all cancelled orders.')
      expect(events.at(-1)?.type).toBe('done')
      const proposal = events.find((e) => e.type === 'proposal')
      if (proposal?.type === 'proposal') {
        expect(proposal.proposal.isWrite).toBe(true)
        expect(proposal.proposal.query).toMatch(/delete/i)
      } else {
        // A clarifying question is an acceptable answer to a destructive request.
        expect(events.some((e) => e.type === 'answer')).toBe(true)
      }
    },
    240_000
  )
})

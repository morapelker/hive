// runQueryInTab bookkeeping that other parts rely on: the run keeps the PostgreSQL schema it ran
// with (a full export re-runs the statement on a fresh connection and needs it; other engines
// send none), and a run in which DDL succeeded tells the workspace store (explorer + completion
// reload) while a failed or read-only run does not. DDL run inside an open transaction is not
// visible to the explorer's control connection, so the run that ends that transaction reloads
// again.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DataProject,
  DataQueryRequest,
  DataStatementClass,
  DataStatementResult
} from '@shared/data-projects/types'

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  completionSchema: vi.fn(async () => ({ databases: [], tables: [] }))
}))

vi.mock('@/api/data-projects-api', () => ({
  dataProjectsApi: { execute: mocks.execute, completionSchema: mocks.completionSchema }
}))
vi.mock('@/stores/useDataProjectStore', () => ({
  useDataProjectStore: { getState: () => ({ openCredentialsPrompt: vi.fn() }) }
}))
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), warning: vi.fn() } }))

const { useDataWorkspaceStore } = await import('@/stores/useDataWorkspaceStore')
const { runQueryInTab, ranSchemaChange, resetQueryRunnerForTests } = await import('./query-runner')

const project = (engine: DataProject['engine']): DataProject => ({
  id: 'dp-1',
  name: 'Shop',
  engine,
  config: { database: 'shop' },
  icon: null,
  iconColor: null,
  environment: 'local',
  color: null,
  safeMode: 'off',
  defaultLimit: 1000,
  allowAiDataAccess: false,
  pinned: false,
  secretState: 'stored',
  sortOrder: 0,
  createdAt: '2026-10-01T00:00:00.000Z',
  lastAccessedAt: '2026-10-01T00:00:00.000Z'
})

const statement = (
  text: string,
  classification: DataStatementClass,
  failed = false
): DataStatementResult => ({
  index: 0,
  text,
  start: 0,
  end: text.length,
  classification,
  durationMs: 1,
  output: failed ? null : { kind: 'command', affectedRows: 0 },
  ...(failed ? { error: { message: 'relation "x" already exists' } } : {})
})

const store = () => useDataWorkspaceStore.getState()

beforeEach(() => {
  store().reset()
  resetQueryRunnerForTests()
  mocks.execute.mockReset()
})

async function run(
  engine: DataProject['engine'],
  statements: DataStatementResult[],
  schema = 'analytics'
): Promise<string> {
  const tabId = store().openQuery('dp-1', 'x')
  mocks.execute.mockResolvedValueOnce({ status: 'ok', statements, durationMs: 2 })
  await runQueryInTab({
    project: project(engine),
    tabId,
    target: { text: 'x', from: 0, to: 1, mode: 'all' },
    database: 'shop',
    schema,
    limit: 100
  })
  return tabId
}

describe('runQueryInTab', () => {
  it('keeps the PostgreSQL schema on the run (and sends none for other engines)', async () => {
    const pg = await run('postgres', [statement('SELECT 1', 'read')])
    expect(store().runs[pg].schema).toBe('analytics')
    expect((mocks.execute.mock.calls[0][0] as DataQueryRequest).schema).toBe('analytics')
    const my = await run('mysql', [statement('SELECT 1', 'read')])
    expect(store().runs[my].schema).toBeUndefined()
    expect((mocks.execute.mock.calls[1][0] as DataQueryRequest).schema).toBeUndefined()
  })

  it('reports a successful DDL statement as a schema change, nothing else', async () => {
    await run('postgres', [statement('SELECT 1', 'read'), statement('INSERT', 'write')])
    expect(store().schemaVersion['dp-1']).toBeUndefined()
    await run('postgres', [statement('CREATE TABLE x (id int)', 'ddl', true)])
    expect(store().schemaVersion['dp-1']).toBeUndefined()
    await run('mysql', [statement('SELECT 1', 'read'), statement('ALTER TABLE t ADD c int', 'ddl')])
    expect(store().schemaVersion['dp-1']).toBe(1)
    expect(ranSchemaChange([statement('TRUNCATE t', 'ddl')])).toBe(true)
  })
})

describe('DDL inside an explicit transaction', () => {
  async function runTx(
    engine: DataProject['engine'],
    statements: DataStatementResult[],
    response: { inTransaction?: boolean; database?: string; status?: 'ok' | 'cancelled' },
    database = 'shop'
  ): Promise<void> {
    const tabId = store().openQuery('dp-1', 'x')
    mocks.execute.mockResolvedValueOnce({
      status: response.status ?? 'ok',
      statements,
      durationMs: 2,
      ...(response.status === 'cancelled'
        ? {}
        : {
            ...(response.inTransaction !== undefined
              ? { inTransaction: response.inTransaction }
              : {}),
            ...(response.database ? { database: response.database } : {})
          })
    })
    await runQueryInTab({
      project: project(engine),
      tabId,
      target: { text: 'x', from: 0, to: 1, mode: 'all' },
      database,
      limit: 100
    })
  }
  const version = (): number | undefined => store().schemaVersion['dp-1']

  it('reloads again when a later run commits (or rolls back) the transaction', async () => {
    await runTx(
      'postgres',
      [statement('BEGIN', 'tx'), statement('CREATE TABLE tmp_x (id int)', 'ddl')],
      { inTransaction: true }
    )
    expect(version()).toBe(1)
    // Still inside the transaction: nothing new to see.
    await runTx('postgres', [statement('SELECT 1', 'read')], { inTransaction: true })
    expect(version()).toBe(1)
    await runTx('postgres', [statement('COMMIT', 'tx')], { inTransaction: false })
    expect(version()).toBe(2)
    // Only once: the next run outside a transaction does not reload.
    await runTx('postgres', [statement('SELECT 1', 'read')], { inTransaction: false })
    expect(version()).toBe(2)

    await runTx('sqlite', [statement('DROP TABLE t', 'ddl')], { inTransaction: true })
    expect(version()).toBe(3)
    await runTx('sqlite', [statement('ROLLBACK', 'tx')], { inTransaction: false })
    expect(version()).toBe(4)
  })

  it('does not reload for a transaction that ran no DDL', async () => {
    await runTx('postgres', [statement('BEGIN', 'tx'), statement('INSERT', 'write')], {
      inTransaction: true
    })
    await runTx('postgres', [statement('COMMIT', 'tx')], { inTransaction: false })
    expect(version()).toBeUndefined()
  })

  it('keeps PostgreSQL databases apart (one session each)', async () => {
    await runTx('postgres', [statement('CREATE TABLE a (id int)', 'ddl')], {
      inTransaction: true,
      database: 'shop'
    })
    expect(version()).toBe(1)
    // A run on another database's session ends nothing in shop's transaction.
    await runTx('postgres', [statement('SELECT 1', 'read')], { inTransaction: false }, 'other')
    expect(version()).toBe(1)
    await runTx('postgres', [statement('COMMIT', 'tx')], { inTransaction: false, database: 'shop' })
    expect(version()).toBe(2)
  })

  it('checks again after a cancelled run that ran DDL (transaction state unknown)', async () => {
    await runTx('postgres', [statement('CREATE TABLE a (id int)', 'ddl')], { status: 'cancelled' })
    expect(version()).toBe(1)
    await runTx('postgres', [statement('COMMIT', 'tx')], { inTransaction: false })
    expect(version()).toBe(2)
  })
})

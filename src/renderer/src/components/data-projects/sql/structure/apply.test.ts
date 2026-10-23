// Apply's engine rules against a mocked API: MySQL / MariaDB refuse to run DDL inside an open
// transaction and check NO_BACKSLASH_ESCAPES before sending statements with a backslash; a
// PostgreSQL failure inside an open transaction applies nothing; a failed ClickHouse type change
// is read back (SHOW CREATE TABLE) and reported as in effect; the banner texts for each case.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DataConnectionStatus,
  DataProject,
  DataQueryRequest,
  DataQueryResponse
} from '@shared/data-projects/types'

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  execute: vi.fn(),
  ddl: vi.fn()
}))
vi.mock('@/api/data-projects-api', () => ({
  dataProjectsApi: { status: mocks.status, execute: mocks.execute, ddl: mocks.ddl }
}))
vi.mock('../../shared/confirm', () => ({
  runWithConfirmation: (run: (token?: string) => Promise<unknown>) => run(undefined)
}))
vi.mock('../query-runner', () => ({ newQueryId: () => 'q' }))

const { applyFailureSummary, applyStructureStatements } = await import('./apply')
type Planned = Parameters<typeof applyStructureStatements>[2][number]

const project = (engine: DataProject['engine']): DataProject =>
  ({ id: 'dp', name: 'dp', engine, safeMode: 'off', environment: 'local' }) as DataProject

const statement = (sql: string, ops: Planned['ops'] = []): Planned => ({
  sql,
  ops,
  parts: ops.map((op) => ({ sql, op }))
})

const response = (
  texts: string[],
  errorAt = -1,
  inTransaction = false,
  message = 'boom'
): DataQueryResponse => ({
  status: 'ok',
  durationMs: 1,
  inTransaction,
  statements: texts.slice(0, errorAt >= 0 ? errorAt + 1 : texts.length).map((text, index) => ({
    index,
    text,
    start: 0,
    end: text.length,
    classification: 'ddl' as const,
    durationMs: 1,
    output: index === errorAt ? null : { kind: 'command' as const, rowCount: 0 },
    ...(index === errorAt ? { error: { message } } : {})
  }))
})

const sqlModeResponse = (mode: string, inTransaction = false): DataQueryResponse => ({
  status: 'ok',
  durationMs: 1,
  inTransaction,
  statements: [
    {
      index: 0,
      text: 'SELECT @@SESSION.sql_mode',
      start: 0,
      end: 25,
      classification: 'read',
      durationMs: 1,
      output: {
        kind: 'rows',
        columns: [{ name: '@@SESSION.sql_mode', type: 'varchar' }],
        rows: [[mode]],
        truncated: false,
        limit: null,
        autoLimited: false
      }
    }
  ]
})

const connected = (extra: Partial<DataConnectionStatus> = {}): DataConnectionStatus => ({
  dataProjectId: 'dp',
  state: 'connected',
  inTransaction: false,
  ...extra
})

beforeEach(() => {
  mocks.status.mockReset()
  mocks.execute.mockReset()
  mocks.ddl.mockReset()
  mocks.status.mockResolvedValue(connected())
})

const MODIFY = "ALTER TABLE `shop`.`t`\n  MODIFY COLUMN `q` int COMMENT 'C:\\new'"

describe('MySQL / MariaDB', () => {
  it('refuses to run DDL while the session has an open transaction', async () => {
    mocks.status.mockResolvedValue(connected({ inTransaction: true }))
    const outcome = await applyStructureStatements(project('mariadb'), 'shop', [
      statement('ALTER TABLE `shop`.`t`\n  DROP COLUMN `x`')
    ])
    expect(outcome).toMatchObject({ status: 'refused', applied: 0, inTransaction: true })
    expect(outcome.error?.message).toMatch(/MariaDB commits it before running any DDL/)
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(applyFailureSummary(outcome).headline).toBe('Nothing was applied.')
  })

  it('sends statements without a backslash without reading the sql_mode', async () => {
    mocks.execute.mockResolvedValue(response(['x']))
    const outcome = await applyStructureStatements(project('mysql'), 'shop', [
      statement("ALTER TABLE `shop`.`t`\n  MODIFY COLUMN `q` int COMMENT 'plain'")
    ])
    expect(outcome.status).toBe('ok')
    expect(mocks.execute).toHaveBeenCalledTimes(1)
    expect((mocks.execute.mock.calls[0][0] as DataQueryRequest).source).toBe('schema-action')
  })

  it('reads the sql_mode before statements with a backslash and refuses a mismatch', async () => {
    mocks.execute.mockResolvedValueOnce(
      sqlModeResponse('STRICT_TRANS_TABLES,NO_BACKSLASH_ESCAPES,NO_ENGINE_SUBSTITUTION')
    )
    const outcome = await applyStructureStatements(project('mysql'), 'shop', [statement(MODIFY)])
    expect(outcome).toMatchObject({ status: 'refused', applied: 0, backslashEscapes: false })
    expect(outcome.error?.message).toMatch(/runs with NO_BACKSLASH_ESCAPES/)
    expect(mocks.execute).toHaveBeenCalledTimes(1)
    expect(mocks.execute.mock.calls[0][0]).toMatchObject({
      text: 'SELECT @@SESSION.sql_mode',
      source: 'table',
      database: 'shop'
    })
  })

  it('runs when the statements were built for the session’s mode', async () => {
    mocks.execute
      .mockResolvedValueOnce(sqlModeResponse('NO_BACKSLASH_ESCAPES'))
      .mockResolvedValueOnce(response([MODIFY]))
    const outcome = await applyStructureStatements(project('mysql'), 'shop', [statement(MODIFY)], {
      backslashEscapes: false
    })
    expect(outcome.status).toBe('ok')
    expect((mocks.execute.mock.calls[1][0] as DataQueryRequest).text).toBe(`${MODIFY};`)
  })

  it('uses the mode the status reports instead of a query when it has one', async () => {
    mocks.status.mockResolvedValue({ ...connected(), backslashEscapes: true })
    mocks.execute.mockResolvedValueOnce(response([MODIFY]))
    const outcome = await applyStructureStatements(project('mysql'), 'shop', [statement(MODIFY)])
    expect(outcome.status).toBe('ok')
    expect(mocks.execute).toHaveBeenCalledTimes(1)
  })

  it('the sql_mode read also catches an open transaction the status missed', async () => {
    mocks.status.mockRejectedValue(new Error('offline'))
    mocks.execute.mockResolvedValueOnce(sqlModeResponse('', true))
    const outcome = await applyStructureStatements(project('mysql'), 'shop', [statement(MODIFY)])
    expect(outcome).toMatchObject({ status: 'refused', inTransaction: true })
    expect(mocks.execute).toHaveBeenCalledTimes(1)
  })
})

describe('PostgreSQL', () => {
  const texts = [
    'ALTER TABLE "public"."t" RENAME COLUMN "a" TO "a2"',
    'ALTER TABLE "public"."t" ALTER COLUMN "b" TYPE integer'
  ]
  const plan = [
    statement(texts[0], [{ kind: 'column', name: 'a', fields: ['name'], renameTo: 'a2' }]),
    statement(texts[1], [{ kind: 'column', name: 'b', fields: ['type'] }])
  ]

  it('a failure inside an open transaction applies nothing (COMMIT would roll back)', async () => {
    mocks.execute.mockResolvedValue(response(texts, 1, true, 'cannot be cast automatically'))
    const outcome = await applyStructureStatements(project('postgres'), 'shop', plan)
    expect(outcome).toMatchObject({
      status: 'failed',
      applied: 0,
      appliedOps: [],
      inTransaction: true,
      transactionAborted: true
    })
    const summary = applyFailureSummary(outcome)
    expect(summary.headline).toBe(
      'Statement 2 of 2 failed inside the open transaction, which is now aborted: nothing of this run will be kept.'
    )
    expect(summary.note).toMatch(/ROLLBACK in a query tab/)
    expect(mocks.status).not.toHaveBeenCalled()
  })

  it('without a transaction the statements before the failure stay applied', async () => {
    mocks.execute.mockResolvedValue(response(texts, 1, false))
    const outcome = await applyStructureStatements(project('postgres'), 'shop', plan)
    expect(outcome).toMatchObject({ status: 'failed', applied: 1 })
    expect(outcome.transactionAborted).toBeUndefined()
    expect(applyFailureSummary(outcome).headline).toBe(
      'Statement 2 of 2 failed; the 1 statement before it was applied, the rest is still staged.'
    )
  })
})

describe('ClickHouse', () => {
  const sql = 'ALTER TABLE `shop`.`t` MODIFY COLUMN `n` String'
  const retype = {
    column: 'n',
    from: 'Nullable(String)',
    to: 'String',
    revert: 'ALTER TABLE `shop`.`t` MODIFY COLUMN `n` Nullable(String)'
  }
  const plan = [statement(sql, [{ kind: 'column', name: 'n', fields: ['type'], retype }])]
  const table = { database: 'shop', name: 't', kind: 'table' as const }
  const ddlWith = (type: string) =>
    `CREATE TABLE shop.t\n(\n    \`id\` UInt64,\n    \`n\` ${type}\n)\nENGINE = MergeTree\nORDER BY id`

  it('a failed conversion with the new type in effect is reported as such', async () => {
    mocks.execute.mockResolvedValue(
      response([sql], 0, false, 'Cannot convert NULL value to non-Nullable type')
    )
    mocks.ddl.mockResolvedValue(ddlWith('String'))
    const outcome = await applyStructureStatements(project('clickhouse'), 'shop', plan, { table })
    expect(mocks.ddl).toHaveBeenCalledWith('dp', table)
    expect(outcome).toMatchObject({
      status: 'failed',
      applied: 0,
      schemaChanged: true,
      retype: { ...retype, now: 'String', state: 'in-effect' }
    })
    const summary = applyFailureSummary(outcome)
    expect(summary.headline).toBe(
      'The statement failed after its type change took effect: "n" is now String, but ClickHouse could not convert the stored data.'
    )
    expect(summary.headline).not.toMatch(/nothing was applied/)
    expect(summary.note).toMatch(/not transactional/)
  })

  it('a type still in place is a plain failure; an unreadable table says it may have changed', async () => {
    mocks.execute.mockResolvedValue(response([sql], 0))
    mocks.ddl.mockResolvedValue(ddlWith('Nullable(String) DEFAULT NULL'))
    const kept = await applyStructureStatements(project('clickhouse'), 'shop', plan, { table })
    expect(kept.retype?.state).toBe('not-applied')
    expect(applyFailureSummary(kept).headline).toBe('The statement failed; nothing was applied.')

    mocks.ddl.mockRejectedValue(new Error('gone'))
    const unknown = await applyStructureStatements(project('clickhouse'), 'shop', plan, { table })
    expect(unknown.retype?.state).toBe('unknown')
    expect(applyFailureSummary(unknown).headline).toMatch(/may have kept the new type of "n"/)
  })

  it('any failed ClickHouse ALTER asks for the table to be read again', async () => {
    const comment = "ALTER TABLE `shop`.`t` COMMENT COLUMN `n` 'x'"
    mocks.execute.mockResolvedValue(response([comment], 0))
    const outcome = await applyStructureStatements(
      project('clickhouse'),
      'shop',
      [statement(comment, [{ kind: 'column', name: 'n', fields: ['comment'] }])],
      { table }
    )
    expect(outcome).toMatchObject({ status: 'failed', schemaChanged: true })
    expect(outcome.retype).toBeUndefined()
    expect(mocks.ddl).not.toHaveBeenCalled()
  })
})

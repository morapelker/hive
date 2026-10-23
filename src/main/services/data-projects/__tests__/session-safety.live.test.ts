// Live regressions for the engine's session handling against the docker containers: a
// transaction lost while the session sat idle, a USE that carries over inside one request,
// NO_BACKSLASH_ESCAPES grid edits, masked history errors and stable ClickHouse table pages.
// Gated: TEDOOO_DP_IT=1. Only tmp_fix_b2_* objects are created, and they are dropped again.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type {
  DataEngine,
  DataQueryRequest,
  DataQueryResponse
} from '../../../../shared/data-projects/types'
import { noopLogger } from '../connection-manager'
import { createDataEngineService, type DataEngineServiceInternals } from '../engine-service'
import { createSafetyGate } from '../safety-gate'
import { MemoryRepository, MemorySecrets, makeRecord } from './engine-fixtures'

const LIVE = !!process.env.TEDOOO_DP_IT
// Real servers, sleeps for idle timeouts and a full parallel suite: allow more than 5 s.
const itLive = LIVE ? it : it.skip
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })
const T = 'tmp_fix_b2'

const PROJECTS: Array<{ id: string; engine: DataEngine; port: number; password: string }> = [
  { id: 'my', engine: 'mysql', port: 13306, password: 'rootpw' },
  { id: 'maria', engine: 'mariadb', port: 13307, password: 'rootpw' },
  { id: 'pg', engine: 'postgres', port: 15432, password: 'pgpw' }
]

let repo: MemoryRepository
let engine: DataEngineServiceInternals

beforeAll(() => {
  if (!LIVE) return
  repo = new MemoryRepository([
    ...PROJECTS.map((p) =>
      makeRecord({
        id: p.id,
        engine: p.engine,
        config: {
          host: '127.0.0.1',
          port: p.port,
          user: p.engine === 'postgres' ? 'postgres' : 'root',
          database: 'shop'
        },
        safeMode: 'off',
        environment: 'local'
      })
    ),
    makeRecord({
      id: 'ch',
      engine: 'clickhouse',
      config: {
        host: '127.0.0.1',
        port: 18123,
        user: 'default',
        database: 'shop',
        clickhouseProtocol: 'http'
      },
      safeMode: 'off',
      environment: 'local'
    })
  ])
  engine = createDataEngineService({
    repository: repo,
    secrets: new MemorySecrets({
      ...Object.fromEntries(PROJECTS.map((p) => [p.id, { password: p.password }])),
      ch: { password: 'chpw' }
    }),
    gate: createSafetyGate(),
    logger: noopLogger,
    txWatchMs: 100
  })
})

afterAll(async () => {
  if (!LIVE) return
  for (const id of ['my', 'maria', 'pg']) {
    await run(id, `DROP TABLE IF EXISTS ${T}_tx`).catch(() => undefined)
    await run(id, `DROP TABLE IF EXISTS ${T}_bs`).catch(() => undefined)
  }
  await run('ch', `DROP TABLE IF EXISTS ${T}_pages`).catch(() => undefined)
  await engine?.shutdown()
})

const run = (
  id: string,
  text: string,
  extra: Partial<DataQueryRequest> = {}
): Promise<DataQueryResponse> =>
  engine.execute(
    {
      dataProjectId: id,
      queryId: `${id}-${Math.random().toString(36).slice(2)}`,
      text,
      database: 'shop',
      limit: 100,
      source: 'editor',
      ...extra
    },
    { clientId: 'live-b2' }
  )

/** Rows of statement `i`; throws on a statement error. */
const rowsOf = (res: DataQueryResponse, i = 0): unknown[][] => {
  if (res.status !== 'ok') throw new Error(`expected ok, got ${res.status}`)
  const st = res.statements[i]
  if (st?.error) throw new Error(st.error.message)
  if (st?.output?.kind !== 'rows') throw new Error(`expected rows, got ${st?.output?.kind}`)
  return st.output.rows
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('a transaction lost while the session sat idle (live)', () => {
  for (const id of ['my', 'pg']) {
    itLive(`${id}: COMMIT is refused instead of "succeeding" on a fresh session`, async () => {
      await run(id, `DROP TABLE IF EXISTS ${T}_tx; CREATE TABLE ${T}_tx (v int)`)
      // The server drops a session idle inside its transaction after one second.
      const open = await run(
        id,
        id === 'pg'
          ? `SET idle_in_transaction_session_timeout = '1s'; BEGIN; INSERT INTO ${T}_tx VALUES (1)`
          : `BEGIN; SET SESSION wait_timeout = 1; INSERT INTO ${T}_tx VALUES (1)`
      )
      expect(open).toMatchObject({ status: 'ok', inTransaction: true })
      expect(engine.status(id).inTransaction).toBe(true)

      await sleep(2_500)
      // Published without anyone asking: no session left, the loss is the status.
      expect(engine.status(id)).toMatchObject({ state: 'error' })
      expect(engine.status(id).inTransaction).toBeUndefined()

      const commit = await run(id, 'COMMIT')
      expect(commit.status).toBe('ok')
      if (commit.status !== 'ok') return
      expect(commit.statements[0].error?.code).toBe('CONNECTION_LOST')
      expect(commit.statements[0].error?.message).toMatch(/rolled the transaction back/)
      expect(commit.inTransaction).toBe(false)

      // The next run reconnects; the insert was rolled back by the server.
      expect(Number(rowsOf(await run(id, `SELECT COUNT(*) FROM ${T}_tx`))[0][0])).toBe(0)
      expect(engine.status(id).state).toBe('connected')
      await run(id, `DROP TABLE ${T}_tx`)
    })
  }
})

describe('session database inside one request (live)', () => {
  for (const id of ['my', 'maria']) {
    itLive(
      `${id}: a USE carries over to the next statement and not to the next request`,
      async () => {
        const res = await run(id, 'USE information_schema; SELECT DATABASE()')
        expect(rowsOf(res, 1)[0][0]).toBe('information_schema')
        expect(rowsOf(await run(id, 'SELECT DATABASE()'))[0][0]).toBe('shop')
      }
    )
  }
})

describe('NO_BACKSLASH_ESCAPES grid edits (live)', () => {
  for (const id of ['my', 'maria']) {
    itLive(`${id}: a backslash value is stored as typed`, async () => {
      await run(
        id,
        `DROP TABLE IF EXISTS ${T}_bs; CREATE TABLE ${T}_bs (id INT PRIMARY KEY, v VARCHAR(50)); INSERT INTO ${T}_bs VALUES (1, 'x')`
      )
      const ref = { database: 'shop', name: `${T}_bs` }
      try {
        await run(id, "SET SESSION sql_mode = CONCAT(@@sql_mode, ',NO_BACKSLASH_ESCAPES')")
        const saved = await engine.applyEdits(
          {
            dataProjectId: id,
            ref,
            edits: [{ kind: 'update', key: { id: 1 }, changes: { v: 'C:\\temp\\new' } }]
          },
          { clientId: null }
        )
        expect(saved).toMatchObject({
          status: 'ok',
          statements: [
            `UPDATE \`shop\`.\`${T}_bs\` SET \`v\` = 'C:\\temp\\new' WHERE \`id\` = 1 LIMIT 1`
          ]
        })
        const page = await engine.tableRows(
          {
            dataProjectId: id,
            queryId: `${id}-page`,
            ref,
            filters: [{ column: 'v', operator: '=', value: 'C:\\temp\\new' }],
            limit: 10,
            offset: 0
          },
          { clientId: null }
        )
        expect(page.result.rows).toEqual([[1, 'C:\\temp\\new']])
        expect(Number(rowsOf(await run(id, `SELECT LENGTH(v) FROM ${T}_bs`))[0][0])).toBe(11)
      } finally {
        await run(id, "SET SESSION sql_mode = REPLACE(@@sql_mode, 'NO_BACKSLASH_ESCAPES', '')")
        await run(id, `DROP TABLE IF EXISTS ${T}_bs`)
      }
    })
  }
})

describe('history keeps passwords out of the error column (live)', () => {
  for (const id of ['my', 'ch']) {
    itLive(`${id}: a syntax error that echoes IDENTIFIED BY is stored masked`, async () => {
      const secret = id === 'ch' ? 'TopSecretCH' : 'TopSecret1'
      const text =
        id === 'ch'
          ? `CREAT USER ${T}_u IDENTIFIED BY '${secret}'`
          : `CREAT USER '${T}_u'@'%' IDENTIFIED BY '${secret}'`
      const res = await run(id, text)
      expect(res.status === 'ok' && res.statements[0].error?.message).toContain(secret)
      const row = repo.history.filter((h) => h.dataProjectId === id).at(-1)
      expect(row?.status).toBe('error')
      expect(row?.error).toBeTruthy()
      expect(row?.error).not.toContain(secret)
      expect(row?.text).not.toContain(secret)
    })
  }
})

describe('ClickHouse table pages (live)', () => {
  itLive(
    'the same page returns the same rows (ordered by the sorting key)',
    async () => {
      await run(
        'ch',
        `DROP TABLE IF EXISTS ${T}_pages; CREATE TABLE ${T}_pages (id UInt64, v String) ENGINE = MergeTree ORDER BY id`
      )
      try {
        // Several parts read in parallel: without an ORDER BY the page differs between calls.
        for (let part = 0; part < 3; part++) {
          await run(
            'ch',
            `INSERT INTO ${T}_pages SELECT number * 3 + ${part}, 'x' FROM numbers(300000)`
          )
        }
        const firstIds: unknown[] = []
        for (let i = 0; i < 4; i++) {
          const page = await engine.tableRows(
            {
              dataProjectId: 'ch',
              queryId: `ch-page-${i}`,
              ref: { database: 'shop', name: `${T}_pages` },
              limit: 3,
              offset: 400_000
            },
            { clientId: null }
          )
          expect(page.sql).toBe(
            `SELECT * FROM \`shop\`.\`${T}_pages\` ORDER BY id LIMIT 3 OFFSET 400000`
          )
          firstIds.push(page.result.rows[0][0])
        }
        expect(new Set(firstIds.map(String))).toEqual(new Set(['400000']))
      } finally {
        await run('ch', `DROP TABLE IF EXISTS ${T}_pages`)
      }
    },
    60_000
  )
})

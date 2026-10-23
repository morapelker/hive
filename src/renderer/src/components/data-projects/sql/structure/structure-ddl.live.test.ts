// @vitest-environment node
// The structure editor's DDL against the real servers (the throwaway test databases), through the
// real engine: the query runner's split / classify, the safety gate and every driver. For each
// engine a tmp_par_p3_* table is created, a batch of staged edits is planned exactly as the editor
// plans it (from the live describe + DDL) and applied with the editor's own apply function, then
// the table is described again. Also: a run that stops part way (the rebase keeps the rest), and
// the gate's answers for production (typed confirmation for a drop) and read-only mode.
// The engine rules (tmp_fix3_q2_* objects): a ClickHouse retype whose conversion fails keeps the
// new type and is reported so (then changed back), MySQL / MariaDB NO_BACKSLASH_ESCAPES keeps
// literals intact, an open MySQL transaction is never committed by Apply, a PostgreSQL failure
// inside a transaction applies nothing, MariaDB CHANGE COLUMN restates its CHECK under the new
// name, USING after a rename, and SQLite's non-constant ADD COLUMN default.
// Gated: TEDOOO_DP_IT=1 and the Electron runner (better-sqlite3).

import { copyFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type {
  DataConnectionStatus,
  DataObjectRef,
  DataQueryRequest,
  DataQueryResponse,
  DataTableDetails,
  SqlDialect
} from '@shared/data-projects/types'
import type { StructureModel } from './structure-model'

const holder = vi.hoisted(() => ({
  execute: null as null | ((req: DataQueryRequest) => Promise<DataQueryResponse>),
  status: null as null | ((id: string) => Promise<DataConnectionStatus>),
  ddl: null as null | ((id: string, ref: DataObjectRef) => Promise<string>)
}))
vi.mock('@/api/data-projects-api', () => ({
  dataProjectsApi: {
    execute: (req: DataQueryRequest) => holder.execute!(req),
    status: (id: string) => holder.status!(id),
    ddl: (id: string, ref: DataObjectRef) => holder.ddl!(id, ref)
  }
}))
vi.mock('../query-runner', () => ({ newQueryId: () => `q-${Math.random()}` }))
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
}))

const { applyStructureStatements } = await import('./apply')
const { parseCreateTable } = await import('./ddl-parse')
const model = await import('./structure-model')
const {
  addNewColumn,
  baseKey,
  buildStructureModel,
  emptyStructure,
  newKey,
  parseServerVersion,
  planStructureChanges,
  rebaseAfterApply,
  setColumnField,
  setColumnUsing,
  toggleDropColumn,
  toggleDropIndex,
  updateNewColumn,
  upsertIndex
} = model

const sqliteAvailable = (() => {
  try {
    const Database = createRequire(import.meta.url)('better-sqlite3')
    new Database(':memory:').close()
    return true
  } catch {
    return false
  }
})()
const LIVE = !!process.env.TEDOOO_DP_IT
const describeLive = LIVE ? describe : describe.skip

/** Main-process modules, loaded at run time only: the renderer's tsconfig does not cover them. */
const MAIN = '../../../../../../main/services/data-projects'
const loadMain = async <T>(path: string): Promise<T> =>
  (await import(/* @vite-ignore */ `${MAIN}/${path}`)) as T

interface LiveEngine {
  connect(id: string): Promise<DataConnectionStatus>
  status(id: string): DataConnectionStatus
  describe(id: string, ref: DataObjectRef): Promise<DataTableDetails>
  ddl(id: string, ref: DataObjectRef): Promise<string>
  execute(req: DataQueryRequest, ctx: { clientId: string | null }): Promise<DataQueryResponse>
  shutdown(): Promise<void>
}

const SEED_SQLITE = join(__dirname, '../../../../../../..', '.test-dbs', 'shop.sqlite')
let engine: LiveEngine
let dir = ''

const project = (id: string, engineName: string) =>
  ({
    id,
    name: id,
    engine: engineName,
    config: {},
    environment: 'local',
    safeMode: 'off'
  }) as never

beforeAll(async () => {
  if (!LIVE) return
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'tmp_par_p3-')))
  const sqlitePath = join(dir, 'shop.sqlite')
  copyFileSync(SEED_SQLITE, sqlitePath)
  const [engineModule, gateModule, managerModule, fixtures] = await Promise.all([
    loadMain<{ createDataEngineService: (deps: object) => LiveEngine }>('engine-service'),
    loadMain<{ createSafetyGate: () => object }>('safety-gate'),
    loadMain<{ noopLogger: object }>('connection-manager'),
    loadMain<{
      MemoryRepository: new (records: unknown[]) => object
      MemorySecrets: new (secrets: object) => object
      makeRecord: (overrides: object) => object
    }>('__tests__/engine-fixtures')
  ])
  const record = (id: string, engineName: string, config: object, extra: object = {}) =>
    fixtures.makeRecord({
      id,
      engine: engineName,
      config,
      environment: 'local',
      safeMode: 'off',
      ...extra
    })
  const mysqlConfig = (port: number) => ({
    host: '127.0.0.1',
    port,
    database: 'shop',
    user: 'root'
  })
  const pgConfig = { host: '127.0.0.1', port: 15432, database: 'shop', user: 'postgres' }
  engine = engineModule.createDataEngineService({
    repository: new fixtures.MemoryRepository([
      record('pg', 'postgres', pgConfig),
      record('pg-prod', 'postgres', pgConfig, { environment: 'production', safeMode: 'half-safe' }),
      record('pg-ro', 'postgres', pgConfig, { safeMode: 'read-only' }),
      record('my', 'mysql', mysqlConfig(13306)),
      record('maria', 'mariadb', mysqlConfig(13307)),
      record('ch', 'clickhouse', {
        host: '127.0.0.1',
        port: 18123,
        user: 'default',
        database: 'shop',
        clickhouseProtocol: 'http'
      }),
      ...(sqliteAvailable
        ? [record('lite', 'sqlite', { filePath: sqlitePath, database: 'main' })]
        : [])
    ]),
    secrets: new fixtures.MemorySecrets({
      pg: { password: 'pgpw' },
      'pg-prod': { password: 'pgpw' },
      'pg-ro': { password: 'pgpw' },
      my: { password: 'rootpw' },
      maria: { password: 'rootpw' },
      ch: { password: 'chpw' }
    }),
    gate: gateModule.createSafetyGate(),
    logger: managerModule.noopLogger
  })
  holder.execute = (req) => engine.execute(req, { clientId: null })
  holder.status = async (id) => engine.status(id)
  holder.ddl = (id, ref) => engine.ddl(id, ref)
}, 60_000)

afterAll(async () => {
  if (!LIVE) return
  await engine?.shutdown()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

/** Runs setup / cleanup SQL (not under test) and fails loudly on any error. */
async function run(id: string, text: string, database?: string): Promise<void> {
  const res = await engine.execute(
    {
      dataProjectId: id,
      queryId: `setup-${Math.random()}`,
      text,
      limit: null,
      source: 'editor',
      ...(database ? { database } : {})
    },
    { clientId: null }
  )
  if (res.status !== 'ok') throw new Error(`${id}: ${res.status}`)
  const failed = res.statements.find((s) => s.error)
  if (failed) throw new Error(`${id}: ${failed.error!.message}\n${failed.text}`)
}

/** The rows of a read (setup / checks, not under test). */
async function rows(id: string, text: string, database?: string): Promise<unknown[][]> {
  const res = await engine.execute(
    {
      dataProjectId: id,
      queryId: `read-${Math.random()}`,
      text,
      limit: null,
      source: 'editor',
      ...(database ? { database } : {})
    },
    { clientId: null }
  )
  if (res.status !== 'ok') throw new Error(`${id}: ${res.status}`)
  const s = res.statements[0]
  if (s?.error) throw new Error(`${id}: ${s.error.message}`)
  return s?.output?.kind === 'rows' ? s.output.rows : []
}

async function loadModel(
  id: string,
  dialect: SqlDialect,
  ref: DataObjectRef,
  backslashEscapes?: boolean
) {
  const status = await engine.connect(id)
  const details = await engine.describe(id, ref)
  const ddl = await engine.ddl(id, ref)
  return buildStructureModel({
    dialect,
    details,
    ref,
    safeMode: 'off',
    server: parseServerVersion(status.serverVersion, dialect),
    parsed: parseCreateTable(ddl, dialect),
    ddlState: 'ready',
    ...(backslashEscapes !== undefined ? { backslashEscapes } : {})
  })
}

const col = (m: StructureModel, name: string) => m.columns.find((c) => c.info.name === name)!

describeLive('structure editor DDL (live)', () => {
  it('PostgreSQL: rename / type / nullability / default / comment, add, drop, indexes, constraint', async () => {
    const ref = {
      database: 'shop',
      schema: 'public',
      name: 'tmp_par_p3_pg',
      kind: 'table' as const
    }
    await run('pg', 'DROP TABLE IF EXISTS public.tmp_par_p3_pg')
    try {
      await run(
        'pg',
        `CREATE TABLE public.tmp_par_p3_pg (id integer PRIMARY KEY, name text NOT NULL, note text, code integer DEFAULT 1, CONSTRAINT tmp_par_p3_pg_name_key UNIQUE (name));
         CREATE INDEX tmp_par_p3_pg_note_idx ON public.tmp_par_p3_pg (note);
         INSERT INTO public.tmp_par_p3_pg VALUES (1, 'a', 'n', 2)`
      )
      const m = await loadModel('pg', 'postgres', ref)
      expect(m.indexes.find((i) => i.info.name === 'tmp_par_p3_pg_name_key')!.constraint).toBe(true)
      let s = toggleDropIndex(emptyStructure(), 'tmp_par_p3_pg_note_idx')
      s = toggleDropIndex(s, 'tmp_par_p3_pg_name_key')
      s = toggleDropColumn(s, 'code')
      s = setColumnField(s, col(m, 'name'), 'name', 'full name')
      s = setColumnField(s, col(m, 'name'), 'type', 'varchar(200)')
      s = setColumnField(s, col(m, 'name'), 'nullable', true)
      s = setColumnField(s, col(m, 'name'), 'defaultExpr', "'anon'")
      s = setColumnField(s, col(m, 'name'), 'comment', "it's")
      const added = addNewColumn(s, m)
      s = updateNewColumn(added.staged, added.id, {
        name: 'age',
        type: 'integer',
        nullable: false,
        defaultExpr: '0',
        comment: 'years'
      })
      s = upsertIndex(s, {
        id: 'i',
        name: 'tmp_par_p3_pg_age_idx',
        columns: [{ key: newKey(added.id) }, { key: baseKey('name') }],
        unique: true
      })
      const plan = planStructureChanges(m, s)
      expect(plan.issues).toEqual([])
      const outcome = await applyStructureStatements(
        project('pg', 'postgres'),
        'shop',
        plan.statements
      )
      expect(outcome).toMatchObject({ status: 'ok', applied: plan.statements.length })
      const after = await engine.describe('pg', ref)
      expect(
        after.columns.map((c) => [
          c.name,
          c.type,
          c.nullable,
          c.defaultValue ?? null,
          c.comment ?? null
        ])
      ).toEqual([
        ['id', 'integer', false, null, null],
        ['full name', 'character varying(200)', true, "'anon'::character varying", "it's"],
        ['note', 'text', true, null, null],
        ['age', 'integer', false, '0', 'years']
      ])
      expect(after.indexes.map((i) => i.name).sort()).toEqual(
        ['tmp_par_p3_pg_age_idx', 'tmp_par_p3_pg_pkey'].sort()
      )
    } finally {
      await run('pg', 'DROP TABLE IF EXISTS public.tmp_par_p3_pg')
    }
  }, 60_000)

  it('PostgreSQL: a run that stops at a failing statement keeps the rest staged', async () => {
    const ref = {
      database: 'shop',
      schema: 'public',
      name: 'tmp_par_p3_pg2',
      kind: 'table' as const
    }
    await run('pg', 'DROP TABLE IF EXISTS public.tmp_par_p3_pg2')
    try {
      await run('pg', 'CREATE TABLE public.tmp_par_p3_pg2 (id integer PRIMARY KEY, name text)')
      const m = await loadModel('pg', 'postgres', ref)
      let s = setColumnField(emptyStructure(), col(m, 'name'), 'name', 'title')
      s = setColumnField(s, col(m, 'name'), 'type', 'not_a_type_p3')
      s = setColumnField(s, col(m, 'name'), 'comment', 'kept')
      const plan = planStructureChanges(m, s)
      expect(plan.statements).toHaveLength(3)
      const outcome = await applyStructureStatements(
        project('pg', 'postgres'),
        'shop',
        plan.statements
      )
      expect(outcome.status).toBe('failed')
      expect(outcome.applied).toBe(1)
      expect(outcome.error?.message).toMatch(/not_a_type_p3/)
      const rebased = rebaseAfterApply(s, outcome.appliedOps)
      expect(rebased.changes).toEqual({ title: { type: 'not_a_type_p3', comment: 'kept' } })
      const m2 = await loadModel('pg', 'postgres', ref)
      expect(m2.columns.map((c) => c.info.name)).toEqual(['id', 'title'])
      // Fix the type and apply what is left.
      const fixed = setColumnField(rebased, col(m2, 'title'), 'type', 'varchar(20)')
      const rest = planStructureChanges(m2, fixed)
      expect(rest.statements.map((x) => x.sql)).toEqual([
        'ALTER TABLE "public"."tmp_par_p3_pg2" ALTER COLUMN "title" TYPE varchar(20)',
        'COMMENT ON COLUMN "public"."tmp_par_p3_pg2"."title" IS \'kept\''
      ])
      expect(
        await applyStructureStatements(project('pg', 'postgres'), 'shop', rest.statements)
      ).toMatchObject({ status: 'ok', applied: 2 })
    } finally {
      await run('pg', 'DROP TABLE IF EXISTS public.tmp_par_p3_pg2')
    }
  }, 60_000)

  it('PostgreSQL: production asks for the table name before a drop; read-only mode blocks', async () => {
    const ref = {
      database: 'shop',
      schema: 'public',
      name: 'tmp_par_p3_pg3',
      kind: 'table' as const
    }
    await run('pg', 'DROP TABLE IF EXISTS public.tmp_par_p3_pg3')
    try {
      await run('pg', 'CREATE TABLE public.tmp_par_p3_pg3 (id integer PRIMARY KEY, gone text)')
      const m = await loadModel('pg', 'postgres', ref)
      const plan = planStructureChanges(m, toggleDropColumn(emptyStructure(), 'gone'))
      const text = plan.statements.map((x) => `${x.sql};`).join('\n')
      const ask = await engine.execute(
        {
          dataProjectId: 'pg-prod',
          queryId: 'p',
          text,
          database: 'shop',
          limit: null,
          source: 'schema-action'
        },
        { clientId: null }
      )
      expect(ask.status).toBe('confirmation_required')
      if (ask.status === 'confirmation_required') {
        expect(ask.plan.typedConfirmation).toBe('tmp_par_p3_pg3')
        expect(ask.plan.statements[0].classification).toBe('ddl')
      }
      const blocked = await engine.execute(
        {
          dataProjectId: 'pg-ro',
          queryId: 'r',
          text,
          database: 'shop',
          limit: null,
          source: 'schema-action'
        },
        { clientId: null }
      )
      expect(blocked.status).toBe('blocked')
      // Nothing ran.
      expect((await engine.describe('pg', ref)).columns.map((c) => c.name)).toEqual(['id', 'gone'])
    } finally {
      await run('pg', 'DROP TABLE IF EXISTS public.tmp_par_p3_pg3')
    }
  }, 60_000)

  for (const [id, dialect] of [
    ['my', 'mysql'],
    ['maria', 'mariadb']
  ] as const) {
    it(`${dialect}: one ALTER keeps charset / collation / ON UPDATE / comments`, async () => {
      const ref = { database: 'shop', name: 'tmp_par_p3_my', kind: 'table' as const }
      await run(id, 'DROP TABLE IF EXISTS shop.tmp_par_p3_my', 'shop')
      try {
        await run(
          id,
          `CREATE TABLE shop.tmp_par_p3_my (
             id int NOT NULL AUTO_INCREMENT PRIMARY KEY,
             name varchar(100) CHARACTER SET latin1 COLLATE latin1_bin NOT NULL DEFAULT 'x' COMMENT 'who',
             ts timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
             email varchar(200) DEFAULT NULL,
             code int DEFAULT 1,
             UNIQUE KEY email (email),
             KEY idx_code (code))`,
          'shop'
        )
        const m = await loadModel(id, dialect, ref)
        let s = toggleDropIndex(emptyStructure(), 'idx_code')
        s = toggleDropColumn(s, 'code')
        s = setColumnField(s, col(m, 'name'), 'name', 'full_name')
        s = setColumnField(s, col(m, 'name'), 'type', 'varchar(150)')
        s = setColumnField(s, col(m, 'ts'), 'nullable', false)
        s = setColumnField(s, col(m, 'email'), 'name', 'mail')
        const added = addNewColumn(s, m)
        s = updateNewColumn(
          added.staged,
          added.id,
          { name: 'age', type: 'int', nullable: false, defaultExpr: '0', comment: "it's" },
          { kind: 'after', column: baseKey('name') }
        )
        s = upsertIndex(s, {
          id: 'i',
          name: 'idx_mail',
          columns: [{ key: baseKey('email'), length: 10 }],
          unique: true
        })
        const plan = planStructureChanges(m, s)
        expect(plan.issues).toEqual([])
        expect(plan.statements).toHaveLength(1)
        const outcome = await applyStructureStatements(
          project(id, dialect),
          'shop',
          plan.statements
        )
        expect(outcome).toMatchObject({ status: 'ok', applied: 1 })
        const ddl = await engine.ddl(id, ref)
        expect(ddl).toMatch(
          /`full_name` varchar\(150\) CHARACTER SET latin1 COLLATE latin1_bin NOT NULL DEFAULT 'x' COMMENT 'who'/
        )
        expect(ddl).toMatch(
          /`ts` timestamp NOT NULL DEFAULT current_timestamp(\(\))? ON UPDATE current_timestamp/i
        )
        expect(ddl).toMatch(/`age` int(\(11\))? NOT NULL DEFAULT '?0'? COMMENT 'it''s'/)
        expect(ddl).toMatch(/UNIQUE KEY `idx_mail` \(`mail`\(10\)\)/)
        const after = await engine.describe(id, ref)
        expect(after.columns.map((c) => c.name)).toEqual(['id', 'full_name', 'age', 'ts', 'mail'])
        expect(after.indexes.map((i) => i.name).sort()).toEqual(['PRIMARY', 'email', 'idx_mail'])
      } finally {
        await run(id, 'DROP TABLE IF EXISTS shop.tmp_par_p3_my', 'shop')
      }
    }, 60_000)
  }

  ;(sqliteAvailable ? it : it.skip)(
    'SQLite: rename, add, drop column, create / drop index',
    async () => {
      const ref = { database: 'main', name: 'tmp_par_p3_lite', kind: 'table' as const }
      await run(
        'lite',
        `CREATE TABLE tmp_par_p3_lite (id INTEGER PRIMARY KEY, name TEXT, tag TEXT, gone TEXT, CHECK (length(name) < 50));
         CREATE INDEX idx_tag ON tmp_par_p3_lite (tag)`
      )
      const m = await loadModel('lite', 'sqlite', ref)
      let s = toggleDropIndex(emptyStructure(), 'idx_tag')
      s = toggleDropColumn(s, 'gone')
      s = setColumnField(s, col(m, 'name'), 'name', 'full_name')
      const added = addNewColumn(s, m)
      s = updateNewColumn(added.staged, added.id, {
        name: 'n',
        type: 'INTEGER',
        nullable: false,
        defaultExpr: '0'
      })
      s = upsertIndex(s, {
        id: 'i',
        name: 'idx_n',
        columns: [{ key: newKey(added.id) }],
        unique: true
      })
      const plan = planStructureChanges(m, s)
      expect(plan.issues).toEqual([])
      const outcome = await applyStructureStatements(
        project('lite', 'sqlite'),
        'main',
        plan.statements
      )
      expect(outcome).toMatchObject({ status: 'ok', applied: plan.statements.length })
      const after = await engine.describe('lite', ref)
      expect(after.columns.map((c) => [c.name, c.nullable])).toEqual([
        ['id', false],
        ['full_name', true],
        ['tag', true],
        ['n', false]
      ])
      expect(after.indexes.map((i) => i.name)).toContain('idx_n')
      expect(after.indexes.map((i) => i.name)).not.toContain('idx_tag')
      const parsed = parseCreateTable(await engine.ddl('lite', ref), 'sqlite')
      expect(parsed?.checks).toEqual([{ name: null, expression: 'length("full_name") < 50' }])
    },
    60_000
  )

  it('ClickHouse: rename, MODIFY type / default, comments, ADD AFTER, skipping indexes', async () => {
    const ref = { database: 'shop', name: 'tmp_par_p3_ch', kind: 'table' as const }
    await run('ch', 'DROP TABLE IF EXISTS shop.tmp_par_p3_ch', 'shop')
    try {
      await run(
        'ch',
        `CREATE TABLE shop.tmp_par_p3_ch (id UInt64, name LowCardinality(String) COMMENT 'nm', n Nullable(Int32) DEFAULT 5, gone String,
           INDEX idx_gone gone TYPE bloom_filter GRANULARITY 4, CONSTRAINT c_id CHECK id > 0) ENGINE = MergeTree ORDER BY id`,
        'shop'
      )
      const m = await loadModel('ch', 'clickhouse', ref)
      expect(col(m, 'id').locks.drop).toMatch(/sorting key/)
      let s = toggleDropIndex(emptyStructure(), 'idx_gone')
      s = toggleDropColumn(s, 'gone')
      s = setColumnField(s, col(m, 'n'), 'name', 'n2')
      s = setColumnField(s, col(m, 'n'), 'type', 'Nullable(Int64)')
      s = setColumnField(s, col(m, 'n'), 'defaultExpr', '')
      s = setColumnField(s, col(m, 'name'), 'comment', 'the name')
      const added = addNewColumn(s, m)
      s = updateNewColumn(
        added.staged,
        added.id,
        { name: 'x', type: 'String', defaultExpr: "'q'", comment: 'c' },
        { kind: 'after', column: baseKey('id') }
      )
      s = upsertIndex(s, {
        id: 'k',
        name: 'idx_x',
        columns: [{ key: newKey(added.id) }],
        unique: false,
        skipType: 'set(100)',
        granularity: 2
      })
      const plan = planStructureChanges(m, s)
      // Only the retype warning (its conversion runs as a mutation, without a rollback).
      expect(plan.issues).toEqual([
        expect.objectContaining({ level: 'warning', confirm: true, field: 'type' })
      ])
      const outcome = await applyStructureStatements(
        project('ch', 'clickhouse'),
        'shop',
        plan.statements
      )
      expect(outcome).toMatchObject({ status: 'ok', applied: plan.statements.length })
      const after = await engine.describe('ch', ref)
      expect(
        after.columns.map((c) => [c.name, c.type, c.defaultValue ?? null, c.comment ?? null])
      ).toEqual([
        ['id', 'UInt64', null, null],
        ['x', 'String', "'q'", 'c'],
        ['name', 'LowCardinality(String)', null, 'the name'],
        ['n2', 'Nullable(Int64)', null, null]
      ])
      expect(after.indexes.map((i) => i.name)).toEqual(['PRIMARY KEY', 'idx_x'])
      const parsed = parseCreateTable(await engine.ddl('ch', ref), 'clickhouse')
      expect(parsed?.checks).toEqual([{ name: 'c_id', expression: 'id > 0' }])
    } finally {
      await run('ch', 'DROP TABLE IF EXISTS shop.tmp_par_p3_ch', 'shop')
    }
  }, 60_000)

  // ---- Engine rules (tmp_fix3_q2_*) ---------------------------------------------------------

  it('ClickHouse: a retype whose conversion fails is reported in effect, then changed back', async () => {
    const ref = { database: 'shop', name: 'tmp_fix3_q2_ch', kind: 'table' as const }
    await run('ch', 'DROP TABLE IF EXISTS shop.tmp_fix3_q2_ch', 'shop')
    try {
      await run(
        'ch',
        `CREATE TABLE shop.tmp_fix3_q2_ch (id UInt64, n Nullable(String)) ENGINE = MergeTree ORDER BY id;
         INSERT INTO shop.tmp_fix3_q2_ch VALUES (1, NULL), (2, 'x')`,
        'shop'
      )
      const m = await loadModel('ch', 'clickhouse', ref)
      const s = setColumnField(emptyStructure(), col(m, 'n'), 'type', 'String')
      const plan = planStructureChanges(m, s)
      expect(plan.issues).toEqual([
        expect.objectContaining({ level: 'warning', confirm: true, field: 'type' })
      ])
      const outcome = await applyStructureStatements(
        project('ch', 'clickhouse'),
        'shop',
        plan.statements,
        { table: ref }
      )
      expect(outcome).toMatchObject({
        status: 'failed',
        applied: 0,
        schemaChanged: true,
        retype: { column: 'n', from: 'Nullable(String)', now: 'String', state: 'in-effect' }
      })
      expect(outcome.error?.message).toMatch(/NULL/)
      // The way back the banner offers restores the type and the reads.
      const back = await applyStructureStatements(
        project('ch', 'clickhouse'),
        'shop',
        [{ sql: outcome.retype!.revert, ops: [], parts: [] }],
        { table: ref }
      )
      expect(back.status).toBe('ok')
      const after = await engine.describe('ch', ref)
      expect(after.columns.map((c) => [c.name, c.type])).toEqual([
        ['id', 'UInt64'],
        ['n', 'Nullable(String)']
      ])
      expect(await rows('ch', 'SELECT count() FROM shop.tmp_fix3_q2_ch', 'shop')).toEqual([['2']])
    } finally {
      await run('ch', 'DROP TABLE IF EXISTS shop.tmp_fix3_q2_ch', 'shop')
    }
  }, 60_000)

  for (const [id, dialect] of [
    ['my', 'mysql'],
    ['maria', 'mariadb']
  ] as const) {
    it(`${dialect}: NO_BACKSLASH_ESCAPES keeps kept and typed literals intact`, async () => {
      const ref = { database: 'shop', name: 'tmp_fix3_q2_nbe', kind: 'table' as const }
      await run(id, 'DROP TABLE IF EXISTS shop.tmp_fix3_q2_nbe', 'shop')
      try {
        // Created in the default mode: the value is C:\tmp.
        await run(
          id,
          "CREATE TABLE shop.tmp_fix3_q2_nbe (p varchar(20) DEFAULT 'C:\\\\tmp' COMMENT 'a\\\\b''c', q int)",
          'shop'
        )
        await run(id, "SET SESSION sql_mode = CONCAT(@@sql_mode, ',NO_BACKSLASH_ESCAPES')", 'shop')
        const stage = (m: StructureModel) => {
          let s = setColumnField(emptyStructure(), col(m, 'p'), 'type', 'varchar(30)')
          s = setColumnField(s, col(m, 'q'), 'comment', 'path C:\\new')
          return planStructureChanges(m, s)
        }
        // Built for the default mode: Apply reads the session's mode and sends nothing.
        const stale = await applyStructureStatements(
          project(id, dialect),
          'shop',
          stage(await loadModel(id, dialect, ref)).statements
        )
        expect(stale).toMatchObject({ status: 'refused', applied: 0, backslashEscapes: false })
        // Rebuilt for the session's mode.
        const m = await loadModel(id, dialect, ref, false)
        const plan = stage(m)
        expect(plan.issues).toEqual([])
        const outcome = await applyStructureStatements(
          project(id, dialect),
          'shop',
          plan.statements,
          { backslashEscapes: false }
        )
        expect(outcome).toMatchObject({ status: 'ok', applied: 1 })
        // SHOW CREATE TABLE escapes in every mode: one backslash in each value.
        const ddl = await engine.ddl(id, ref)
        expect(ddl).toMatch(/`p` varchar\(30\) DEFAULT 'C:\\\\tmp' COMMENT 'a\\\\b''c'/)
        expect(ddl).toMatch(/COMMENT 'path C:\\\\new'/)
        // Another edit keeps them as they are (no doubling per edit).
        const m2 = await loadModel(id, dialect, ref, false)
        const again = planStructureChanges(
          m2,
          setColumnField(emptyStructure(), col(m2, 'q'), 'type', 'bigint')
        )
        expect(
          await applyStructureStatements(project(id, dialect), 'shop', again.statements, {
            backslashEscapes: false
          })
        ).toMatchObject({ status: 'ok' })
        expect(await engine.ddl(id, ref)).toMatch(
          /`q` bigint(\(20\))? DEFAULT NULL COMMENT 'path C:\\\\new'/
        )
      } finally {
        await run(
          id,
          "SET SESSION sql_mode = REPLACE(@@sql_mode, 'NO_BACKSLASH_ESCAPES', '')",
          'shop'
        )
        await run(id, 'DROP TABLE IF EXISTS shop.tmp_fix3_q2_nbe', 'shop')
      }
    }, 60_000)

    it(`${dialect}: Apply never commits a transaction left open on the session`, async () => {
      const ref = { database: 'shop', name: 'tmp_fix3_q2_tx', kind: 'table' as const }
      await run(id, 'DROP TABLE IF EXISTS shop.tmp_fix3_q2_tx', 'shop')
      try {
        await run(id, 'CREATE TABLE shop.tmp_fix3_q2_tx (a int)', 'shop')
        const m = await loadModel(id, dialect, ref)
        await run(id, 'START TRANSACTION; INSERT INTO shop.tmp_fix3_q2_tx VALUES (1)', 'shop')
        const plan = planStructureChanges(
          m,
          setColumnField(emptyStructure(), col(m, 'a'), 'comment', 'c')
        )
        const outcome = await applyStructureStatements(
          project(id, dialect),
          'shop',
          plan.statements
        )
        expect(outcome).toMatchObject({ status: 'refused', applied: 0, inTransaction: true })
        await run(id, 'ROLLBACK', 'shop')
        const [[count]] = await rows(id, 'SELECT COUNT(*) FROM shop.tmp_fix3_q2_tx', 'shop')
        expect(Number(count)).toBe(0)
        expect(await engine.ddl(id, ref)).not.toMatch(/COMMENT/)
      } finally {
        await run(id, 'ROLLBACK', 'shop').catch(() => undefined)
        await run(id, 'DROP TABLE IF EXISTS shop.tmp_fix3_q2_tx', 'shop')
      }
    }, 60_000)
  }

  it('MariaDB: CHANGE COLUMN restates an inline CHECK under the new name', async () => {
    const ref = { database: 'shop', name: 'tmp_fix3_q2_ck', kind: 'table' as const }
    await run('maria', 'DROP TABLE IF EXISTS shop.tmp_fix3_q2_ck', 'shop')
    try {
      await run(
        'maria',
        'CREATE TABLE shop.tmp_fix3_q2_ck (id int PRIMARY KEY, j json, ck int NOT NULL CHECK (ck > 0))',
        'shop'
      )
      const m = await loadModel('maria', 'mariadb', ref)
      let s = setColumnField(emptyStructure(), col(m, 'j'), 'name', 'j2')
      s = setColumnField(s, col(m, 'j'), 'comment', 'doc')
      s = setColumnField(s, col(m, 'ck'), 'name', 'ck3')
      s = setColumnField(s, col(m, 'ck'), 'nullable', true)
      const plan = planStructureChanges(m, s)
      expect(plan.issues).toEqual([])
      expect(
        await applyStructureStatements(project('maria', 'mariadb'), 'shop', plan.statements)
      ).toMatchObject({ status: 'ok', applied: 1 })
      const ddl = await engine.ddl('maria', ref)
      expect(ddl).toMatch(/`j2` longtext .*COMMENT 'doc' CHECK \(json_valid\(`j2`\)\)/)
      expect(ddl).toMatch(/`ck3` int\(11\) DEFAULT NULL CHECK \(`ck3` > 0\)/)
    } finally {
      await run('maria', 'DROP TABLE IF EXISTS shop.tmp_fix3_q2_ck', 'shop')
    }
  }, 60_000)

  it('PostgreSQL: a failure inside an open transaction applies nothing; USING after a rename', async () => {
    const ref = {
      database: 'shop',
      schema: 'public',
      name: 'tmp_fix3_q2_pg',
      kind: 'table' as const
    }
    await run('pg', 'DROP TABLE IF EXISTS public.tmp_fix3_q2_pg')
    try {
      await run(
        'pg',
        "CREATE TABLE public.tmp_fix3_q2_pg (id integer PRIMARY KEY, a text, b text, price text); INSERT INTO public.tmp_fix3_q2_pg VALUES (1, 'x', 'y', '1.5')"
      )
      const m = await loadModel('pg', 'postgres', ref)
      let s = setColumnField(emptyStructure(), col(m, 'a'), 'name', 'a2')
      s = setColumnField(s, col(m, 'b'), 'type', 'integer')
      const plan = planStructureChanges(m, s)
      await run('pg', 'BEGIN')
      const outcome = await applyStructureStatements(
        project('pg', 'postgres'),
        'shop',
        plan.statements
      )
      expect(outcome).toMatchObject({
        status: 'failed',
        applied: 0,
        appliedOps: [],
        inTransaction: true,
        transactionAborted: true
      })
      // Nothing to rebase: both edits stay staged.
      expect(rebaseAfterApply(s, outcome.appliedOps)).toEqual(s)
      await run('pg', 'ROLLBACK')
      expect((await engine.describe('pg', ref)).columns.map((c) => c.name)).toEqual([
        'id',
        'a',
        'b',
        'price'
      ])

      // USING sees the column under the name the rename gave it.
      let u = setColumnField(emptyStructure(), col(m, 'price'), 'name', 'amount')
      u = setColumnField(u, col(m, 'price'), 'type', 'numeric')
      expect(
        planStructureChanges(m, setColumnUsing(u, 'price', '"price"::numeric')).issues
      ).toEqual([expect.objectContaining({ level: 'error', field: 'using' })])
      const good = planStructureChanges(m, setColumnUsing(u, 'price', '"amount"::numeric'))
      expect(good.issues).toEqual([])
      expect(
        await applyStructureStatements(project('pg', 'postgres'), 'shop', good.statements)
      ).toMatchObject({ status: 'ok', applied: 2 })
      expect(
        (await engine.describe('pg', ref)).columns.map((c) => [c.name, c.type])
      ).toContainEqual(['amount', 'numeric'])
    } finally {
      await run('pg', 'ROLLBACK').catch(() => undefined)
      await run('pg', 'DROP TABLE IF EXISTS public.tmp_fix3_q2_pg')
    }
  }, 60_000)

  ;(sqliteAvailable ? it : it.skip)(
    'SQLite: a non-constant ADD COLUMN default warns on a table with rows (and fails there)',
    async () => {
      const ref = { database: 'main', name: 'tmp_fix3_q2_lite', kind: 'table' as const }
      const emptyRef = { ...ref, name: 'tmp_fix3_q2_lite_empty' }
      await run(
        'lite',
        'CREATE TABLE tmp_fix3_q2_lite (id INTEGER PRIMARY KEY); CREATE TABLE tmp_fix3_q2_lite_empty (id INTEGER PRIMARY KEY)'
      )
      try {
        await run('lite', 'INSERT INTO tmp_fix3_q2_lite VALUES (1)')
        const addNow = (m: StructureModel) => {
          const added = addNewColumn(emptyStructure(), m)
          return planStructureChanges(
            m,
            updateNewColumn(added.staged, added.id, {
              name: 'created',
              type: 'TEXT',
              defaultExpr: 'CURRENT_TIMESTAMP'
            })
          )
        }
        const m = await loadModel('lite', 'sqlite', ref)
        expect(m.rows).toBe(1)
        const plan = addNow(m)
        expect(plan.issues).toEqual([
          expect.objectContaining({ level: 'warning', confirm: true, field: 'defaultExpr' })
        ])
        const outcome = await applyStructureStatements(
          project('lite', 'sqlite'),
          'main',
          plan.statements
        )
        expect(outcome.status).toBe('failed')
        expect(outcome.error?.message).toMatch(/non-constant default/)
        // An empty table takes it.
        // (Describe is cached for a while, so a table that was always empty.)
        const empty = await loadModel('lite', 'sqlite', emptyRef)
        expect(empty.rows).toBe(0)
        const ok = addNow(empty)
        expect(ok.issues).toEqual([])
        expect(
          await applyStructureStatements(project('lite', 'sqlite'), 'main', ok.statements)
        ).toMatchObject({ status: 'ok' })
      } finally {
        await run(
          'lite',
          'DROP TABLE IF EXISTS tmp_fix3_q2_lite; DROP TABLE IF EXISTS tmp_fix3_q2_lite_empty'
        )
      }
    },
    60_000
  )
})

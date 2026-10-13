import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_DOCUMENT_RUN_CONFIG,
  type DocumentRun,
  type DocumentRunConfig,
  type DocumentRunExtractionMeta,
  type DocumentRunItemDraft,
  type DocumentRunItemMember,
  type DocumentRunLaunchConfig,
  type DocumentRunMember,
  type DocumentRunReport,
  type DocumentRunVerdict
} from '@shared/types/document-flow'
import type {
  DocumentRunCreate,
  DocumentRunItemRowPatch,
  DocumentRunRowPatch
} from '../services/document-flow/db-port'
import {
  flushPendingDbChangedEvents,
  setDbChangeEventPublisher
} from '../services/db-change-events'
import { DatabaseService } from './database'
import {
  CURRENT_SCHEMA_VERSION,
  DOCUMENT_FLOW_TABLES_DROP_SQL,
  DOCUMENT_FLOW_TABLES_SQL,
  MIGRATIONS
} from './schema'

// The persistence of the "Implement document" flow (v55) against a real SQLite file: the
// migration and its idempotent replay, the JSON / boolean mapping, the patch semantics the
// orchestrator relies on (present keys only, null clears) and the single-owner runner lease.

const TABLES = [
  'document_runs',
  'document_run_items',
  'document_run_events',
  'session_final_messages'
]

const tempDirs: string[] = []
const openDbs: DatabaseService[] = []

const canRunDatabaseTests = (): boolean => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3')
    const db = new Database(':memory:')
    db.close()
    return true
  } catch {
    return false
  }
}

const describeIf = canRunDatabaseTests() ? describe : describe.skip

const makeDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-document-flow-'))
  tempDirs.push(dir)
  return join(dir, 'state.sqlite')
}

const openDb = (path = makeDbPath()): DatabaseService => {
  const db = new DatabaseService(path)
  db.init()
  openDbs.push(db)
  return db
}

/** `new Date()` inside DatabaseService returns this instant until the next call. */
const at = (iso: string): string => {
  vi.setSystemTime(new Date(iso))
  return iso
}

const makeProject = (db: DatabaseService, name = 'repo'): string =>
  db.createProject({ name, path: `/tmp/document-flow-${name}` }).id

const makeRun = (
  db: DatabaseService,
  projectId: string,
  over: Partial<DocumentRunCreate> = {}
): DocumentRun =>
  db.createDocumentRun({
    id: randomUUID(),
    project_id: projectId,
    title: 'Checkout spec',
    source_path: '/docs/checkout.html',
    run_dir: '/runs/checkout',
    status: 'extracting',
    config: DEFAULT_DOCUMENT_RUN_CONFIG,
    ...over
  })

const draft = (key: string, over: Partial<DocumentRunItemDraft> = {}): DocumentRunItemDraft => ({
  key,
  title: `Task ${key}`,
  summary: '',
  description: '',
  kind: 'change',
  depends_on: [],
  has_migration: false,
  size: null,
  conflict_risk: null,
  doc_status: 'unknown',
  selected: true,
  figures: [],
  open_questions: [],
  verification_suggested: [],
  verification: [],
  verification_reason: '',
  ...over
})

const count = (db: DatabaseService, table: string, where = '1 = 1'): number =>
  (
    db.getRawDb().prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get() as {
      count: number
    }
  ).count

const LAUNCH: DocumentRunLaunchConfig = {
  sdk: 'claude-code-cli',
  model: { providerID: 'anthropic', modelID: 'opus', variant: 'ultracode' },
  codexFastMode: false,
  customProviderId: null
}

const VERDICT: DocumentRunVerdict = {
  status: 'done',
  reason: 'The footer says STATUS: DONE and the tests pass.',
  question: null,
  summary: 'Added the coupon field.',
  migrations: ['db/migrations/0042_coupons.sql'],
  manualSteps: ['Set COUPON_SECRET in production'],
  confidence: 'high',
  source: 'model',
  classifiedAt: '2026-03-01T10:05:00.000Z'
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  at('2026-03-01T10:00:00.000Z')
})

afterEach(() => {
  vi.useRealTimers()
  for (const db of openDbs.splice(0)) {
    try {
      db.close()
    } catch {
      /* already closed */
    }
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('document flow schema', () => {
  it('ships as the v55 migration', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(55)
    const migration = MIGRATIONS.find((m) => m.version === 55)
    expect(migration?.name).toBe('add_document_flow')
    expect(migration?.up).toBe(DOCUMENT_FLOW_TABLES_SQL)
    expect(migration?.down).toBe(DOCUMENT_FLOW_TABLES_DROP_SQL)
  })

  it('ships the run ticket link as the v57 migration, a column added by the repair step', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(57)
    const migration = MIGRATIONS.find((m) => m.version === 57)
    expect(migration?.name).toBe('add_document_run_ticket')
    // Comment only: safeAddColumn() adds the column, so a replay cannot fail on a duplicate.
    expect(migration?.up.replace(/--.*$/gm, '').trim()).toBe('')
    expect(DOCUMENT_FLOW_TABLES_SQL).toMatch(/ticket_id\s+TEXT DEFAULT NULL,\s+report/)
  })

  it('ships the migration session of a run as the v58 migration, columns added by the repair step', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(58)
    const migration = MIGRATIONS.find((m) => m.version === 58)
    expect(migration?.name).toBe('add_document_run_migration_session')
    // Comment only: safeAddColumn() adds the columns, so a replay cannot fail on a duplicate.
    expect(migration?.up.replace(/--.*$/gm, '').trim()).toBe('')
    expect(migration?.down.replace(/--.*$/gm, '').trim()).toBe('')
    for (const column of ['migration_session_id', 'migration_started_at', 'migration_owner_pid']) {
      expect(migration?.up).toContain(`document_runs.${column}`)
    }
    expect(DOCUMENT_FLOW_TABLES_SQL).toMatch(
      /report\s+TEXT DEFAULT NULL,\s+migration_session_id\s+TEXT DEFAULT NULL,\s+migration_started_at\s+TEXT DEFAULT NULL,\s+migration_owner_pid\s+INTEGER DEFAULT NULL,\s+runner_client_id/
    )
  })

  it('ships the verification of a ticket as the v59 migration, columns added by the repair step', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(59)
    const migration = MIGRATIONS.find((m) => m.version === 59)
    expect(migration?.name).toBe('add_document_run_item_verification')
    // Comment only: safeAddColumn() adds the columns, so a replay cannot fail on a duplicate.
    expect(migration?.up.replace(/--.*$/gm, '').trim()).toBe('')
    expect(migration?.down.replace(/--.*$/gm, '').trim()).toBe('')
    for (const column of ['verification_suggested', 'verification', 'verification_reason']) {
      expect(migration?.up).toContain(`document_run_items.${column}`)
    }
    expect(DOCUMENT_FLOW_TABLES_SQL).toMatch(
      /open_questions\s+TEXT NOT NULL DEFAULT '\[\]',\s+verification_suggested\s+TEXT NOT NULL DEFAULT '\[\]',\s+verification\s+TEXT NOT NULL DEFAULT '\[\]',\s+verification_reason\s+TEXT NOT NULL DEFAULT '',\s+launch_config/
    )
  })

  it('ships the connection-project columns of a run and its items as the v60 migration, columns added by the repair step', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(60)
    const migration = MIGRATIONS.find((m) => m.version === 60)
    expect(migration?.name).toBe('add_document_run_connection_project')
    expect(migration?.up.replace(/--.*$/gm, '').trim()).toBe('')
    expect(migration?.down.replace(/--.*$/gm, '').trim()).toBe('')
    for (const column of ['integration_connection_id', 'integration_connection_path', 'members']) {
      expect(migration?.up).toContain(`document_runs.${column}`)
    }
    for (const column of ['connection_id', 'members']) {
      expect(migration?.up).toContain(`document_run_items.${column}`)
    }
    expect(DOCUMENT_FLOW_TABLES_SQL).toMatch(
      /integration_worktree_path\s+TEXT DEFAULT NULL,\s+integration_connection_id\s+TEXT DEFAULT NULL,\s+integration_connection_path TEXT DEFAULT NULL,\s+members\s+TEXT DEFAULT NULL/
    )
    expect(DOCUMENT_FLOW_TABLES_SQL).toMatch(
      /worktree_id\s+TEXT DEFAULT NULL,\s+connection_id\s+TEXT DEFAULT NULL,\s+members\s+TEXT DEFAULT NULL/
    )
  })

  it('keeps the migration versions strictly increasing', () => {
    for (let i = 1; i < MIGRATIONS.length; i++) {
      expect(MIGRATIONS[i].version).toBeGreaterThan(MIGRATIONS[i - 1].version)
    }
    expect(MIGRATIONS[MIGRATIONS.length - 1].version).toBe(CURRENT_SCHEMA_VERSION)
  })

  it('can be replayed: every CREATE is IF NOT EXISTS and every table has a DROP', () => {
    expect(DOCUMENT_FLOW_TABLES_SQL.match(/CREATE\s+(TABLE|INDEX)\s+(?!IF NOT EXISTS)/g)).toBeNull()
    for (const table of TABLES) {
      expect(DOCUMENT_FLOW_TABLES_SQL).toContain(`CREATE TABLE IF NOT EXISTS ${table} (`)
      expect(DOCUMENT_FLOW_TABLES_DROP_SQL).toContain(`DROP TABLE IF EXISTS ${table};`)
    }
  })
})

describeIf('document flow tables', () => {
  it('creates the four tables and their indexes on a fresh database', () => {
    const db = openDb()
    expect(db.getSetting('schema_version')).toBe(String(CURRENT_SCHEMA_VERSION))
    for (const table of TABLES) expect(db.tableExists(table)).toBe(true)
    expect(db.getIndexes()).toEqual(
      expect.arrayContaining([
        { name: 'idx_document_runs_project', tbl_name: 'document_runs' },
        { name: 'idx_document_run_items_run', tbl_name: 'document_run_items' },
        { name: 'idx_document_run_events_run', tbl_name: 'document_run_events' }
      ])
    )
  })

  it('recreates the tables from the repair step when the version is already past 55', () => {
    const path = makeDbPath()
    const db = openDb(path)
    db.getRawDb().exec(DOCUMENT_FLOW_TABLES_DROP_SQL)
    for (const table of TABLES) expect(db.tableExists(table)).toBe(false)
    // Another build already claimed this version and the next: no migration will run.
    const stamped = String(CURRENT_SCHEMA_VERSION + 1)
    db.setSetting('schema_version', stamped)
    db.close()

    const repaired = openDb(path)
    expect(repaired.getSetting('schema_version')).toBe(stamped)
    for (const table of TABLES) expect(repaired.tableExists(table)).toBe(true)
    const run = makeRun(repaired, makeProject(repaired))
    expect(repaired.replaceDocumentRunItems(run.id, [draft('A1')])).toHaveLength(1)
  })

  it('applies, replays and reverts the v55 migration on its own', () => {
    const db = openDb()
    const migration = MIGRATIONS.find((m) => m.version === 55)!
    db.getRawDb().exec(migration.down)
    for (const table of TABLES) expect(db.tableExists(table)).toBe(false)
    expect(db.getIndexes().filter((index) => index.name.startsWith('idx_document_'))).toEqual([])

    db.getRawDb().exec(migration.up)
    db.getRawDb().exec(migration.up)
    for (const table of TABLES) expect(db.tableExists(table)).toBe(true)
  })

  it('upgrades a v54 database through the migration', () => {
    const path = makeDbPath()
    const db = openDb(path)
    db.getRawDb().exec(DOCUMENT_FLOW_TABLES_DROP_SQL)
    db.setSetting('schema_version', '54')
    db.close()

    const upgraded = openDb(path)
    expect(upgraded.getSetting('schema_version')).toBe(String(CURRENT_SCHEMA_VERSION))
    for (const table of TABLES) expect(upgraded.tableExists(table)).toBe(true)
  })

  it('adds the migration session columns to a runs table created by an earlier build', () => {
    const path = makeDbPath()
    const db = openDb(path)
    const run = makeRun(db, makeProject(db), { id: 'run-old' })
    const raw = db.getRawDb()
    raw.exec('ALTER TABLE document_runs DROP COLUMN migration_session_id')
    raw.exec('ALTER TABLE document_runs DROP COLUMN migration_started_at')
    raw.exec('ALTER TABLE document_runs DROP COLUMN migration_owner_pid')
    db.setSetting('schema_version', '57')
    db.close()

    const upgraded = openDb(path)
    expect(upgraded.getSetting('schema_version')).toBe(String(CURRENT_SCHEMA_VERSION))
    // The run of the earlier build reads as one whose migrations nobody is executing.
    expect(upgraded.getDocumentRun('run-old')).toEqual(run)
    expect(
      upgraded.updateDocumentRun('run-old', {
        migration_session_id: 'session-1',
        migration_started_at: '2026-03-01T10:00:00.000Z',
        migration_owner_pid: 4321
      })
    ).toMatchObject({
      migration_session_id: 'session-1',
      migration_started_at: '2026-03-01T10:00:00.000Z',
      migration_owner_pid: 4321
    })

    // Replayed on every start: the columns are there already.
    upgraded.close()
    expect(openDb(path).getDocumentRun('run-old')).toMatchObject({
      migration_session_id: 'session-1',
      migration_owner_pid: 4321
    })
  })

  it('adds the owner of the migration session to a runs table that has the session columns', () => {
    const path = makeDbPath()
    const db = openDb(path)
    makeRun(db, makeProject(db), { id: 'run-old' })
    // A session recorded by a build that did not say which app instance it belongs to.
    const session = {
      migration_session_id: 'session-1',
      migration_started_at: '2026-03-01T10:00:00.000Z'
    }
    const run = db.updateDocumentRun('run-old', session)
    db.getRawDb().exec('ALTER TABLE document_runs DROP COLUMN migration_owner_pid')
    // Already at v58: no migration runs, the repair step alone adds the column.
    expect(db.getSetting('schema_version')).toBe(String(CURRENT_SCHEMA_VERSION))
    db.close()

    const repaired = openDb(path)
    expect(repaired.getDocumentRun('run-old')).toEqual(run)
    expect(repaired.getDocumentRun('run-old')).toMatchObject({
      ...session,
      migration_owner_pid: null
    })
    expect(
      repaired.updateDocumentRun('run-old', { migration_owner_pid: 4321 })?.migration_owner_pid
    ).toBe(4321)
  })

  it('adds the verification columns to an items table created by an earlier build', () => {
    const path = makeDbPath()
    const db = openDb(path)
    const run = makeRun(db, makeProject(db), { id: 'run-old' })
    const [item] = db.replaceDocumentRunItems(run.id, [
      draft('A1', {
        verification_suggested: ['tests'],
        verification: ['tests'],
        verification_reason: 'It ships with unit tests.'
      })
    ])
    const raw = db.getRawDb()
    raw.exec('ALTER TABLE document_run_items DROP COLUMN verification_suggested')
    raw.exec('ALTER TABLE document_run_items DROP COLUMN verification')
    raw.exec('ALTER TABLE document_run_items DROP COLUMN verification_reason')
    db.setSetting('schema_version', '58')
    db.close()

    const upgraded = openDb(path)
    expect(upgraded.getSetting('schema_version')).toBe(String(CURRENT_SCHEMA_VERSION))
    // The ticket of the earlier build reads as one nobody suggested or chose a verification for.
    expect(upgraded.getDocumentRunItem(item.id)).toEqual({
      ...item,
      verification_suggested: [],
      verification: [],
      verification_reason: ''
    })
    expect(
      upgraded.updateDocumentRunItem(item.id, { verification: ['tcu', 'playwright'] })
    ).toMatchObject({
      verification_suggested: [],
      verification: ['tcu', 'playwright'],
      verification_reason: ''
    })

    // Replayed on every start: the columns are there already.
    upgraded.close()
    expect(openDb(path).getDocumentRunItem(item.id)).toMatchObject({
      verification: ['tcu', 'playwright']
    })
  })
})

describeIf('document runs', () => {
  it('creates a run and round-trips its config, extraction and report', () => {
    const db = openDb()
    const projectId = makeProject(db)
    const config: DocumentRunConfig = {
      maxParallel: 2,
      verifyCommand: 'pnpm test',
      interactive: false,
      promptStyle: 'small',
      defaultLaunch: LAUNCH,
      generation: { provider: 'claude-code', model: 'sonnet', effort: 'high' },
      baseBranch: 'develop',
      notes: null,
      verificationDisabled: true,
      memberBaseBranches: {},
      memberVerifyCommands: {}
    }
    const createdAt = at('2026-03-01T10:00:00.000Z')
    const run = makeRun(db, projectId, { id: 'run-1', config })
    expect(run).toEqual({
      id: 'run-1',
      project_id: projectId,
      title: 'Checkout spec',
      source_path: '/docs/checkout.html',
      run_dir: '/runs/checkout',
      document_path: null,
      status: 'extracting',
      error: null,
      config,
      extraction: null,
      base_branch: null,
      base_sha: null,
      integration_branch: null,
      integration_worktree_id: null,
      integration_worktree_path: null,
      integration_connection_id: null,
      integration_connection_path: null,
      members: null,
      ticket_id: null,
      report: null,
      migration_session_id: null,
      migration_started_at: null,
      migration_owner_pid: null,
      runner_client_id: null,
      runner_heartbeat_at: null,
      created_at: createdAt,
      updated_at: createdAt,
      started_at: null,
      finished_at: null
    })
    expect(db.getDocumentRun('run-1')).toEqual(run)

    const extraction: DocumentRunExtractionMeta = {
      documentTitle: 'Checkout redesign',
      numbering: 'A1…C3',
      openQuestions: ['Which currencies?'],
      warnings: ['Dropped a dependency on the unknown task Z9'],
      generatedBy: 'claude-code / sonnet',
      textLength: 48213,
      figureCount: 3
    }
    const report: DocumentRunReport = {
      generatedAt: '2026-03-01T12:00:00.000Z',
      integrationBranch: 'document/checkout',
      integrationWorktreePath: '/worktrees/checkout',
      baseBranch: 'develop',
      baseSha: 'aaa111',
      headSha: 'bbb222',
      baseMoved: true,
      merged: [{ key: 'A1', title: 'Coupons', mergeSha: 'ccc333', summary: null }],
      unmerged: [{ key: 'A2', title: 'Taxes', status: 'needs_attention', reason: 'verify failed' }],
      migrations: ['db/migrations/0042_coupons.sql'],
      manualSteps: ['Set COUPON_SECRET in production'],
      stats: { filesChanged: 12, insertions: 340, deletions: 21, commits: 5 },
      verify: { command: 'pnpm test', ok: false, output: '1 failed' }
    }
    const updatedAt = at('2026-03-01T11:00:00.000Z')
    const updated = db.updateDocumentRun('run-1', {
      title: 'Checkout redesign',
      document_path: '/runs/checkout/document.md',
      status: 'completed_with_issues',
      error: 'one ticket needs attention',
      extraction,
      base_branch: 'develop',
      base_sha: 'aaa111',
      integration_branch: 'document/checkout',
      integration_worktree_id: 'wt-1',
      integration_worktree_path: '/worktrees/checkout',
      ticket_id: 'ticket-run',
      report,
      started_at: '2026-03-01T10:30:00.000Z',
      finished_at: '2026-03-01T12:00:00.000Z'
    })
    expect(updated).toEqual({
      ...run,
      title: 'Checkout redesign',
      document_path: '/runs/checkout/document.md',
      status: 'completed_with_issues',
      error: 'one ticket needs attention',
      extraction,
      base_branch: 'develop',
      base_sha: 'aaa111',
      integration_branch: 'document/checkout',
      integration_worktree_id: 'wt-1',
      integration_worktree_path: '/worktrees/checkout',
      ticket_id: 'ticket-run',
      report,
      updated_at: updatedAt,
      started_at: '2026-03-01T10:30:00.000Z',
      finished_at: '2026-03-01T12:00:00.000Z'
    })
    expect(db.getDocumentRun('run-1')).toEqual(updated)
  })

  it('round-trips the integration instance and members of a run on a connection project', () => {
    const db = openDb()
    const run = makeRun(db, makeProject(db))
    const members: DocumentRunMember[] = [
      {
        project_id: 'member-web',
        project_name: 'web',
        project_path: '/repos/web',
        symlink_name: 'web',
        base_branch: 'main',
        base_sha: 'aaa111',
        integration_branch: 'doc-checkout',
        integration_worktree_id: 'wt-web',
        integration_worktree_path: '/worktrees/web/doc-checkout'
      },
      {
        project_id: 'member-api',
        project_name: 'api',
        project_path: '/repos/api',
        symlink_name: 'api',
        base_branch: 'develop',
        base_sha: 'bbb222',
        integration_branch: 'doc-checkout',
        integration_worktree_id: 'wt-api',
        integration_worktree_path: '/worktrees/api/doc-checkout'
      }
    ]
    const config: DocumentRunConfig = {
      ...DEFAULT_DOCUMENT_RUN_CONFIG,
      memberBaseBranches: { 'member-api': 'develop', 'member-web': null },
      memberVerifyCommands: { 'member-web': 'pnpm check', 'member-api': '' }
    }

    const updatedAt = at('2026-03-01T11:00:00.000Z')
    const launched = db.updateDocumentRun(run.id, {
      config,
      base_branch: 'main + develop',
      integration_branch: 'doc-checkout',
      integration_connection_id: 'connection-1',
      integration_connection_path: '/connections/abc',
      members
    })
    expect(launched).toEqual({
      ...run,
      config,
      base_branch: 'main + develop',
      base_sha: null,
      integration_branch: 'doc-checkout',
      integration_worktree_id: null,
      integration_worktree_path: null,
      integration_connection_id: 'connection-1',
      integration_connection_path: '/connections/abc',
      members,
      updated_at: updatedAt
    })
    expect(db.getDocumentRun(run.id)).toEqual(launched)
    // A run on a git project never has these; the readers tell the two apart by them.
    expect(db.updateDocumentRun(run.id, { title: 'Still there' })).toMatchObject({
      integration_connection_id: 'connection-1',
      members
    })
    expect(
      db.updateDocumentRun(run.id, {
        integration_connection_id: null,
        integration_connection_path: null,
        members: null
      })
    ).toMatchObject({
      integration_connection_id: null,
      integration_connection_path: null,
      members: null
    })

    // A corrupt members column reads as no members rather than a broken run.
    db.updateDocumentRun(run.id, { members })
    db.getRawDb()
      .prepare('UPDATE document_runs SET members = ? WHERE id = ?')
      .run('{broken', run.id)
    expect(db.getDocumentRun(run.id)?.members).toEqual([])
  })

  it('patches only the keys that are present; null clears and config is replaced whole', () => {
    const db = openDb()
    const run = makeRun(db, makeProject(db), {
      document_path: '/runs/checkout/document.md',
      config: { ...DEFAULT_DOCUMENT_RUN_CONFIG, maxParallel: 2, verifyCommand: 'pnpm test' }
    })
    at('2026-03-01T10:10:00.000Z')
    db.updateDocumentRun(run.id, { status: 'extract_failed', error: 'model timed out' })

    // An absent key and an explicit undefined both leave the column alone.
    const stampedAt = at('2026-03-01T10:20:00.000Z')
    const retried = db.updateDocumentRun(run.id, { status: 'extracting', error: undefined })
    expect(retried).toMatchObject({
      status: 'extracting',
      error: 'model timed out',
      title: run.title,
      document_path: '/runs/checkout/document.md',
      updated_at: stampedAt,
      created_at: run.created_at
    })

    const cleared = db.updateDocumentRun(run.id, { error: null, document_path: null })
    expect(cleared).toMatchObject({ error: null, document_path: null, status: 'extracting' })

    // The stored config is the given object, not a merge with what was there.
    const replaced = db.updateDocumentRun(run.id, {
      config: { ...DEFAULT_DOCUMENT_RUN_CONFIG, maxParallel: 8 }
    })
    expect(replaced?.config).toEqual({ ...DEFAULT_DOCUMENT_RUN_CONFIG, maxParallel: 8 })
    expect(
      JSON.parse(
        (
          db.getRawDb().prepare('SELECT config FROM document_runs WHERE id = ?').get(run.id) as {
            config: string
          }
        ).config
      )
    ).toEqual({ ...DEFAULT_DOCUMENT_RUN_CONFIG, maxParallel: 8 })
  })

  it('records the migration session of a run, keeps it across other patches and clears it with null', () => {
    const db = openDb()
    const run = makeRun(db, makeProject(db))
    expect(run).toMatchObject({
      migration_session_id: null,
      migration_started_at: null,
      migration_owner_pid: null
    })

    const startedAt = at('2026-03-01T12:30:00.000Z')
    const started = db.updateDocumentRun(run.id, {
      migration_session_id: 'session-migrations',
      migration_started_at: startedAt,
      migration_owner_pid: 4321
    })
    expect(started).toEqual({
      ...run,
      migration_session_id: 'session-migrations',
      migration_started_at: startedAt,
      migration_owner_pid: 4321,
      updated_at: startedAt
    })
    expect(db.getDocumentRun(run.id)).toEqual(started)
    expect(db.listDocumentRuns(run.project_id)).toEqual([started])
    // Plain columns, not JSON: two of text and the owner's process id as a number.
    expect(
      db
        .getRawDb()
        .prepare(
          'SELECT migration_session_id, migration_started_at, migration_owner_pid, typeof(migration_owner_pid) AS owner_type FROM document_runs WHERE id = ?'
        )
        .get(run.id)
    ).toEqual({
      migration_session_id: 'session-migrations',
      migration_started_at: startedAt,
      migration_owner_pid: 4321,
      owner_type: 'integer'
    })

    // An absent key and an explicit undefined both leave the session alone.
    const patched = db.updateDocumentRun(run.id, {
      ticket_id: 'ticket-run',
      migration_session_id: undefined
    })
    expect(patched).toMatchObject({
      ticket_id: 'ticket-run',
      migration_session_id: 'session-migrations',
      migration_started_at: startedAt,
      migration_owner_pid: 4321
    })

    const endedAt = at('2026-03-01T12:45:00.000Z')
    const ended = db.updateDocumentRun(run.id, {
      migration_session_id: null,
      migration_started_at: null,
      migration_owner_pid: null
    })
    expect(ended).toEqual({ ...run, ticket_id: 'ticket-run', updated_at: endedAt })
    expect(db.getDocumentRun(run.id)).toEqual(ended)

    // A session of an app instance that did not say which process it is has no owner.
    expect(
      db.updateDocumentRun(run.id, {
        migration_session_id: 'session-unowned',
        migration_started_at: endedAt
      })
    ).toMatchObject({ migration_session_id: 'session-unowned', migration_owner_pid: null })
  })

  it('returns the row untouched for an empty patch and null for an unknown id', () => {
    const db = openDb()
    const run = makeRun(db, makeProject(db))
    at('2026-03-01T10:30:00.000Z')
    expect(db.updateDocumentRun(run.id, {})).toEqual(run)
    // A key the table does not have (an older or newer caller) is ignored, never interpolated.
    const foreign = { 'title = title, error': 'x', bogus: 1 } as unknown as DocumentRunRowPatch
    expect(db.updateDocumentRun(run.id, foreign)).toEqual(run)
    expect(db.getDocumentRun(run.id)?.updated_at).toBe(run.updated_at)

    expect(db.updateDocumentRun('ghost', { title: 'x' })).toBeNull()
    expect(db.getDocumentRun('ghost')).toBeNull()
  })

  it('falls back to the defaults when a JSON column is partial, corrupt or mis-shaped', () => {
    const db = openDb()
    const run = makeRun(db, makeProject(db))
    const raw = db.getRawDb()
    const write = (column: string, value: string | null): void => {
      raw.prepare(`UPDATE document_runs SET ${column} = ? WHERE id = ?`).run(value, run.id)
    }

    // Written by a build that knew fewer settings.
    write('config', '{"maxParallel":2}')
    expect(db.getDocumentRun(run.id)?.config).toEqual({
      ...DEFAULT_DOCUMENT_RUN_CONFIG,
      maxParallel: 2
    })
    for (const corrupt of ['{not json', '[1,2]', '"text"', 'null', '']) {
      write('config', corrupt)
      write('extraction', corrupt)
      write('report', corrupt)
      expect(db.getDocumentRun(run.id)).toMatchObject({
        config: DEFAULT_DOCUMENT_RUN_CONFIG,
        extraction: null,
        report: null
      })
    }

    const [item] = db.replaceDocumentRunItems(run.id, [draft('A1', { depends_on: ['A0'] })])
    raw
      .prepare(
        `UPDATE document_run_items
         SET depends_on = '{"a":1}', figures = 'oops', open_questions = '', launch_config = '[]',
             verdict = '{broken'
         WHERE id = ?`
      )
      .run(item.id)
    expect(db.getDocumentRunItem(item.id)).toMatchObject({
      depends_on: [],
      figures: [],
      open_questions: [],
      launch_config: null,
      verdict: null
    })

    const event = db.appendDocumentRunEvent({ run_id: run.id, type: 'note', message: 'x' })
    raw.prepare(`UPDATE document_run_events SET data = '{broken' WHERE id = ?`).run(event.id)
    expect(db.listDocumentRunEvents(run.id)[0].data).toBeNull()
  })

  it('lists newest first, by project, within the limit', () => {
    const db = openDb()
    const first = makeProject(db, 'first')
    const second = makeProject(db, 'second')
    at('2026-03-01T10:00:00.000Z')
    makeRun(db, first, { id: 'old' })
    at('2026-03-01T11:00:00.000Z')
    makeRun(db, second, { id: 'other-project' })
    at('2026-03-01T12:00:00.000Z')
    // Same instant: the later insert is the newer one.
    makeRun(db, first, { id: 'tie-1' })
    makeRun(db, first, { id: 'tie-2' })

    expect(db.listDocumentRuns().map((run) => run.id)).toEqual([
      'tie-2',
      'tie-1',
      'other-project',
      'old'
    ])
    expect(db.listDocumentRuns(first).map((run) => run.id)).toEqual(['tie-2', 'tie-1', 'old'])
    expect(db.listDocumentRuns(second).map((run) => run.id)).toEqual(['other-project'])
    expect(db.listDocumentRuns('ghost')).toEqual([])
    expect(db.listDocumentRuns(first, 2).map((run) => run.id)).toEqual(['tie-2', 'tie-1'])
    expect(db.listDocumentRuns(undefined, 1).map((run) => run.id)).toEqual(['tie-2'])
    // Clamped to 1..200; a non-number falls back to the default.
    expect(db.listDocumentRuns(undefined, 0)).toHaveLength(1)
    expect(db.listDocumentRuns(undefined, -5)).toHaveLength(1)
    expect(db.listDocumentRuns(undefined, 1.9)).toHaveLength(1)
    expect(db.listDocumentRuns(undefined, Number.NaN)).toHaveLength(4)
    expect(db.listDocumentRuns(undefined, 100000)).toHaveLength(4)
  })

  it('caps the list at 200 runs', () => {
    const db = openDb()
    const projectId = makeProject(db)
    db.transaction(() => {
      for (let i = 0; i < 205; i++) makeRun(db, projectId, { id: `run-${i}` })
    })
    expect(db.listDocumentRuns(projectId)).toHaveLength(50)
    expect(db.listDocumentRuns(projectId, 500)).toHaveLength(200)
    expect(db.listDocumentRuns(projectId, 500)[0].id).toBe('run-204')
  })

  it('refuses a run for an unknown project or a reused id', () => {
    const db = openDb()
    expect(() => makeRun(db, 'no-such-project')).toThrow(/FOREIGN KEY/i)
    const projectId = makeProject(db)
    makeRun(db, projectId, { id: 'run-1' })
    expect(() => makeRun(db, projectId, { id: 'run-1' })).toThrow(/UNIQUE|PRIMARY/i)
    expect(db.listDocumentRuns()).toHaveLength(1)
  })

  it('deletes a run with its items and events, without relying on foreign keys', () => {
    const db = openDb()
    const projectId = makeProject(db)
    const doomed = makeRun(db, projectId)
    const kept = makeRun(db, projectId)
    db.replaceDocumentRunItems(doomed.id, [draft('A1'), draft('A2')])
    db.replaceDocumentRunItems(kept.id, [draft('B1')])
    db.appendDocumentRunEvent({ run_id: doomed.id, type: 'launched', message: 'A1 launched' })
    db.appendDocumentRunEvent({ run_id: kept.id, type: 'launched', message: 'B1 launched' })

    db.getRawDb().pragma('foreign_keys = OFF')
    expect(db.deleteDocumentRun(doomed.id)).toBe(true)
    expect(db.deleteDocumentRun(doomed.id)).toBe(false)
    expect(db.deleteDocumentRun('ghost')).toBe(false)

    expect(db.getDocumentRun(doomed.id)).toBeNull()
    expect(db.getDocumentRunItems(doomed.id)).toEqual([])
    expect(db.listDocumentRunEvents(doomed.id)).toEqual([])
    expect(count(db, 'document_run_items')).toBe(1)
    expect(count(db, 'document_run_events')).toBe(1)
    expect(db.getDocumentRunItems(kept.id).map((item) => item.key)).toEqual(['B1'])
  })

  it('goes away with its project', () => {
    const db = openDb()
    const projectId = makeProject(db)
    const run = makeRun(db, projectId)
    db.replaceDocumentRunItems(run.id, [draft('A1')])
    db.appendDocumentRunEvent({ run_id: run.id, type: 'launched', message: 'A1 launched' })

    expect(db.deleteProject(projectId)).toBe(true)
    expect(count(db, 'document_runs')).toBe(0)
    expect(count(db, 'document_run_items')).toBe(0)
    expect(count(db, 'document_run_events')).toBe(0)
  })
})

describeIf('document run items', () => {
  it('stores the drafts in array order with fresh ids, pending and mapped back', () => {
    const db = openDb()
    const run = makeRun(db, makeProject(db))
    const now = at('2026-03-01T10:15:00.000Z')
    const figures = [{ id: 'fig-01', path: '/runs/checkout/fig-01.png', label: 'Cart mockup' }]
    const items = db.replaceDocumentRunItems(run.id, [
      draft('B2', {
        title: 'Tax table',
        summary: 'Adds the tax table',
        description: 'Create the `taxes` table and backfill it.',
        kind: 'data',
        depends_on: ['A1', 'A3'],
        has_migration: true,
        size: 'L',
        conflict_risk: 'high',
        doc_status: 'partial',
        selected: false,
        figures,
        open_questions: ['Which regions?'],
        launch_config: LAUNCH
      }),
      draft('A1'),
      draft('A3', { launch_config: null })
    ])

    expect(items.map((item) => [item.key, item.position])).toEqual([
      ['B2', 0],
      ['A1', 1],
      ['A3', 2]
    ])
    expect(new Set(items.map((item) => item.id)).size).toBe(3)
    expect(items[0]).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      run_id: run.id,
      key: 'B2',
      position: 0,
      title: 'Tax table',
      summary: 'Adds the tax table',
      description: 'Create the `taxes` table and backfill it.',
      kind: 'data',
      depends_on: ['A1', 'A3'],
      has_migration: true,
      size: 'L',
      conflict_risk: 'high',
      doc_status: 'partial',
      selected: false,
      figures,
      open_questions: ['Which regions?'],
      verification_suggested: [],
      verification: [],
      verification_reason: '',
      launch_config: LAUNCH,
      status: 'pending',
      status_detail: null,
      ticket_id: null,
      worktree_id: null,
      connection_id: null,
      members: null,
      session_id: null,
      fix_ticket_id: null,
      fix_session_id: null,
      branch_name: null,
      verdict: null,
      nudge_count: 0,
      conflict_attempts: 0,
      conflict_head: null,
      fix_attempts: 0,
      continue_attempts: 0,
      pre_merge_sha: null,
      merge_sha: null,
      last_prompt_at: null,
      last_checked_at: null,
      retry_at: null,
      created_at: now,
      updated_at: now,
      started_at: null,
      finished_at: null
    })
    expect(items[1]).toMatchObject({
      has_migration: false,
      selected: true,
      size: null,
      conflict_risk: null,
      launch_config: null,
      depends_on: [],
      figures: [],
      open_questions: [],
      verification_suggested: [],
      verification: [],
      verification_reason: ''
    })
    expect(items[2].launch_config).toBeNull()
    expect(db.getDocumentRunItems(run.id)).toEqual(items)
    expect(db.getDocumentRunItem(items[1].id)).toEqual(items[1])
    expect(db.getDocumentRunItem('ghost')).toBeNull()
    expect(db.getDocumentRunItems('ghost')).toEqual([])
  })

  it('round-trips the connection instance and member worktrees of a ticket', () => {
    const db = openDb()
    const run = makeRun(db, makeProject(db))
    const [item] = db.replaceDocumentRunItems(run.id, [draft('A1')])
    const members: DocumentRunItemMember[] = [
      {
        project_id: 'member-web',
        worktree_id: 'wt-web-a1',
        branch_name: 'a1-coupons',
        pre_merge_sha: null,
        merge_sha: null
      },
      {
        project_id: 'member-api',
        worktree_id: 'wt-api-a1',
        branch_name: 'a1-coupons',
        pre_merge_sha: null,
        merge_sha: null
      }
    ]

    const launchedAt = at('2026-03-01T10:20:00.000Z')
    const launched = db.updateDocumentRunItem(item.id, {
      status: 'running',
      connection_id: 'connection-a1',
      members,
      branch_name: 'a1-coupons'
    })
    expect(launched).toEqual({
      ...item,
      status: 'running',
      worktree_id: null,
      connection_id: 'connection-a1',
      members,
      branch_name: 'a1-coupons',
      updated_at: launchedAt
    })
    expect(db.getDocumentRunItem(item.id)).toEqual(launched)

    // The merge writes the per-member shas and their composites together.
    const merged = members.map((member, index) => ({
      ...member,
      pre_merge_sha: `pre${index}`,
      merge_sha: index === 0 ? 'merge0' : null
    }))
    expect(
      db.updateDocumentRunItem(item.id, {
        members: merged,
        pre_merge_sha: 'web=pre0,api=pre1',
        merge_sha: 'web=merge0'
      })
    ).toMatchObject({
      connection_id: 'connection-a1',
      members: merged,
      pre_merge_sha: 'web=pre0,api=pre1',
      merge_sha: 'web=merge0'
    })
    expect(db.updateDocumentRunItem(item.id, { connection_id: null, members: null })).toMatchObject(
      {
        connection_id: null,
        members: null,
        pre_merge_sha: 'web=pre0,api=pre1'
      }
    )
  })

  it('round-trips the verification of a ticket and drops the methods it does not know', () => {
    const db = openDb()
    const run = makeRun(db, makeProject(db))
    const raw = db.getRawDb()
    const [item, plain] = db.replaceDocumentRunItems(run.id, [
      draft('A1', {
        verification_suggested: ['tcu', 'tests'],
        verification: ['tests'],
        verification_reason: 'x'
      }),
      draft('A2')
    ])
    expect(item).toMatchObject({
      verification_suggested: ['tcu', 'tests'],
      verification: ['tests'],
      verification_reason: 'x'
    })
    expect(plain).toMatchObject({
      verification_suggested: [],
      verification: [],
      verification_reason: ''
    })
    expect(db.getDocumentRunItem(item.id)).toEqual(item)
    expect(
      raw
        .prepare(
          'SELECT verification_suggested, verification, verification_reason FROM document_run_items WHERE id = ?'
        )
        .get(item.id)
    ).toEqual({
      verification_suggested: '["tcu","tests"]',
      verification: '["tests"]',
      verification_reason: 'x'
    })

    // Written by a build that knew other methods: only the known ones survive, in canonical order.
    raw
      .prepare(
        `UPDATE document_run_items
         SET verification_suggested = '["manual","tests","tcu"]',
             verification = '["tests","browser",7,"playwright"]'
         WHERE id = ?`
      )
      .run(item.id)
    expect(db.getDocumentRunItem(item.id)).toMatchObject({
      verification_suggested: ['tcu', 'tests'],
      verification: ['playwright', 'tests'],
      verification_reason: 'x'
    })
    raw
      .prepare(
        `UPDATE document_run_items SET verification_suggested = 'oops', verification = '{"a":1}'
         WHERE id = ?`
      )
      .run(item.id)
    expect(db.getDocumentRunItem(item.id)).toMatchObject({
      verification_suggested: [],
      verification: []
    })
  })

  it('patches the chosen verification of a ticket and leaves the suggestion alone', () => {
    const db = openDb()
    const run = makeRun(db, makeProject(db))
    const [item] = db.replaceDocumentRunItems(run.id, [
      draft('A1', {
        verification_suggested: ['tests'],
        verification: ['tests'],
        verification_reason: 'x'
      })
    ])

    const changedAt = at('2026-03-01T10:20:00.000Z')
    expect(db.updateDocumentRunItem(item.id, { verification: ['tcu', 'playwright'] })).toEqual({
      ...item,
      verification: ['tcu', 'playwright'],
      updated_at: changedAt
    })
    expect(db.getDocumentRunItem(item.id)).toMatchObject({
      verification_suggested: ['tests'],
      verification: ['tcu', 'playwright'],
      verification_reason: 'x'
    })

    // Every method switched off is an empty list, not a missing one.
    expect(db.updateDocumentRunItem(item.id, { verification: [] })).toMatchObject({
      verification_suggested: ['tests'],
      verification: [],
      verification_reason: 'x'
    })
    expect(
      (
        db
          .getRawDb()
          .prepare('SELECT verification FROM document_run_items WHERE id = ?')
          .get(item.id) as { verification: string }
      ).verification
    ).toBe('[]')
    // Other patches leave the choice where it is.
    expect(db.updateDocumentRunItem(item.id, { title: 'Renamed' })).toMatchObject({
      title: 'Renamed',
      verification: []
    })
  })

  it('replaces every item of that run and of no other', () => {
    const db = openDb()
    const projectId = makeProject(db)
    const run = makeRun(db, projectId)
    const other = makeRun(db, projectId)
    const before = db.replaceDocumentRunItems(run.id, [draft('A1'), draft('A2'), draft('A3')])
    db.updateDocumentRunItem(before[0].id, { status: 'running', session_id: 'session-1' })
    const untouched = db.replaceDocumentRunItems(other.id, [draft('A1')])

    const after = db.replaceDocumentRunItems(run.id, [draft('A3'), draft('A1')])
    expect(after.map((item) => [item.key, item.position, item.status, item.session_id])).toEqual([
      ['A3', 0, 'pending', null],
      ['A1', 1, 'pending', null]
    ])
    for (const old of before) expect(db.getDocumentRunItem(old.id)).toBeNull()
    expect(count(db, 'document_run_items', `run_id = '${run.id}'`)).toBe(2)
    expect(db.getDocumentRunItems(other.id)).toEqual(untouched)

    expect(db.replaceDocumentRunItems(run.id, [])).toEqual([])
    expect(db.getDocumentRunItems(run.id)).toEqual([])
    expect(db.getDocumentRunItems(other.id)).toEqual(untouched)
  })

  it('keeps the previous items when an insert fails mid-way', () => {
    const db = openDb()
    const run = makeRun(db, makeProject(db))
    const before = db.replaceDocumentRunItems(run.id, [draft('A1'), draft('A2')])
    const broken = draft('A4', { title: null as unknown as string })
    expect(() => db.replaceDocumentRunItems(run.id, [draft('A3'), broken])).toThrow(/NOT NULL/i)
    expect(db.getDocumentRunItems(run.id)).toEqual(before)

    expect(() => db.replaceDocumentRunItems('no-such-run', [draft('A1')])).toThrow(/FOREIGN KEY/i)
  })

  it('patches only the keys that are present, clears with null and stores the counters', () => {
    const db = openDb()
    const run = makeRun(db, makeProject(db))
    const [first, second] = db.replaceDocumentRunItems(run.id, [
      draft('A1', { title: 'Coupons', description: 'Add coupons', open_questions: ['Stacking?'] }),
      draft('A2', { depends_on: ['A1'] })
    ])

    const launchedAt = at('2026-03-01T10:20:00.000Z')
    const launched = db.updateDocumentRunItem(first.id, {
      status: 'running',
      status_detail: 'Agent is working',
      ticket_id: 'ticket-1',
      worktree_id: 'wt-1',
      session_id: 'session-1',
      branch_name: 'document/checkout/a1',
      launch_config: LAUNCH,
      last_prompt_at: launchedAt,
      started_at: launchedAt
    })
    expect(launched).toEqual({
      ...first,
      status: 'running',
      status_detail: 'Agent is working',
      ticket_id: 'ticket-1',
      worktree_id: 'wt-1',
      session_id: 'session-1',
      branch_name: 'document/checkout/a1',
      launch_config: LAUNCH,
      last_prompt_at: launchedAt,
      started_at: launchedAt,
      updated_at: launchedAt
    })

    const mergedAt = at('2026-03-01T10:40:00.000Z')
    const merged = db.updateDocumentRunItem(first.id, {
      title: 'Coupons v2',
      summary: 'Coupon codes at checkout',
      description: 'Add coupons, with stacking',
      depends_on: ['A0'],
      selected: false,
      status: 'merged',
      status_detail: null,
      fix_ticket_id: 'ticket-9',
      fix_session_id: 'session-9',
      verdict: VERDICT,
      nudge_count: 1,
      conflict_attempts: 2,
      fix_attempts: 3,
      continue_attempts: 4,
      pre_merge_sha: 'aaa111',
      merge_sha: 'bbb222',
      last_checked_at: '2026-03-01T10:35:00.000Z',
      retry_at: '2026-03-01T10:36:00.000Z',
      finished_at: mergedAt
    })
    expect(merged).toEqual({
      ...launched,
      title: 'Coupons v2',
      summary: 'Coupon codes at checkout',
      description: 'Add coupons, with stacking',
      depends_on: ['A0'],
      selected: false,
      status: 'merged',
      status_detail: null,
      fix_ticket_id: 'ticket-9',
      fix_session_id: 'session-9',
      verdict: VERDICT,
      nudge_count: 1,
      conflict_attempts: 2,
      fix_attempts: 3,
      continue_attempts: 4,
      pre_merge_sha: 'aaa111',
      merge_sha: 'bbb222',
      last_checked_at: '2026-03-01T10:35:00.000Z',
      retry_at: '2026-03-01T10:36:00.000Z',
      finished_at: mergedAt,
      updated_at: mergedAt
    })

    // A rollback: everything nullable goes back to NULL, the counters to 0, the flag to true.
    const rolledBack = db.updateDocumentRunItem(first.id, {
      selected: true,
      depends_on: [],
      launch_config: null,
      status: 'needs_attention',
      ticket_id: null,
      worktree_id: null,
      session_id: null,
      fix_ticket_id: null,
      fix_session_id: null,
      branch_name: null,
      verdict: null,
      nudge_count: 0,
      conflict_attempts: 0,
      conflict_head: null,
      fix_attempts: 0,
      continue_attempts: 0,
      pre_merge_sha: null,
      merge_sha: null,
      last_prompt_at: null,
      last_checked_at: null,
      retry_at: null,
      started_at: null,
      finished_at: null
    })
    expect(rolledBack).toEqual({
      ...first,
      title: 'Coupons v2',
      summary: 'Coupon codes at checkout',
      description: 'Add coupons, with stacking',
      status: 'needs_attention',
      updated_at: mergedAt
    })

    // An explicit undefined is an absent key.
    const kept = db.updateDocumentRunItem(first.id, {
      status_detail: 'verify failed twice',
      session_id: undefined,
      verdict: undefined
    })
    expect(kept).toMatchObject({ status_detail: 'verify failed twice', session_id: null })
    db.updateDocumentRunItem(first.id, { session_id: 'session-2', verdict: VERDICT })
    expect(
      db.updateDocumentRunItem(first.id, { session_id: undefined, verdict: undefined })
    ).toMatchObject({ session_id: 'session-2', verdict: VERDICT })

    expect(db.getDocumentRunItem(second.id)).toEqual(second)
  })

  it('returns the row untouched for an empty patch and null for an unknown id', () => {
    const db = openDb()
    const run = makeRun(db, makeProject(db))
    const [item] = db.replaceDocumentRunItems(run.id, [draft('A1')])
    at('2026-03-01T10:30:00.000Z')
    expect(db.updateDocumentRunItem(item.id, {})).toEqual(item)
    // `key`, `position` and `run_id` are not patchable; an unknown key is ignored.
    const foreign = { key: 'Z9', position: 7, run_id: 'x', bogus: true }
    expect(
      db.updateDocumentRunItem(item.id, foreign as unknown as DocumentRunItemRowPatch)
    ).toEqual(item)
    expect(db.updateDocumentRunItem('ghost', { status: 'running' })).toBeNull()
    // The run's own timestamp does not move with its items.
    db.updateDocumentRunItem(item.id, { status: 'running' })
    expect(db.getDocumentRun(run.id)?.updated_at).toBe(run.updated_at)
  })
})

describeIf('document run events', () => {
  it('appends with an increasing id and returns the newest ones oldest first', () => {
    const db = openDb()
    const projectId = makeProject(db)
    const run = makeRun(db, projectId)
    const other = makeRun(db, projectId)
    const [item] = db.replaceDocumentRunItems(run.id, [draft('A1')])

    const firstAt = at('2026-03-01T10:01:00.000Z')
    const first = db.appendDocumentRunEvent({
      run_id: run.id,
      item_id: item.id,
      type: 'launched',
      message: 'A1 launched',
      data: { sessionId: 'session-1', attempt: 1, nested: { ok: true } }
    })
    expect(first).toEqual({
      id: expect.any(Number),
      run_id: run.id,
      item_id: item.id,
      at: firstAt,
      type: 'launched',
      message: 'A1 launched',
      data: { sessionId: 'session-1', attempt: 1, nested: { ok: true } }
    })
    db.appendDocumentRunEvent({ run_id: other.id, type: 'note', message: 'another run' })
    at('2026-03-01T10:02:00.000Z')
    const second = db.appendDocumentRunEvent({ run_id: run.id, type: 'verdict', message: 'done' })
    const third = db.appendDocumentRunEvent({
      run_id: run.id,
      item_id: null,
      type: 'conflict',
      message: 'src/cart.ts',
      data: ['src/cart.ts', 'src/tax.ts']
    })
    const fourth = db.appendDocumentRunEvent({
      run_id: run.id,
      type: 'merged',
      message: 'A1 merged',
      data: null
    })

    expect(second).toMatchObject({ item_id: null, data: null })
    expect(third.data).toEqual(['src/cart.ts', 'src/tax.ts'])
    expect(fourth.data).toBeNull()
    expect([first.id, second.id, third.id, fourth.id]).toEqual(
      [first.id, second.id, third.id, fourth.id].sort((a, b) => a - b)
    )
    // Without data the column is NULL, not the string "null".
    expect(count(db, 'document_run_events', `id = ${second.id} AND data IS NULL`)).toBe(1)

    expect(db.listDocumentRunEvents(run.id)).toEqual([first, second, third, fourth])
    expect(db.listDocumentRunEvents(run.id, 2)).toEqual([third, fourth])
    expect(db.listDocumentRunEvents(run.id, 0)).toEqual([fourth])
    expect(db.listDocumentRunEvents(run.id, Number.NaN)).toHaveLength(4)
    expect(db.listDocumentRunEvents(other.id).map((event) => event.message)).toEqual([
      'another run'
    ])
    expect(db.listDocumentRunEvents('ghost')).toEqual([])
  })

  it('defaults to the newest 200 and never returns more than 1000', () => {
    const db = openDb()
    const run = makeRun(db, makeProject(db))
    db.transaction(() => {
      for (let i = 1; i <= 1005; i++) {
        db.appendDocumentRunEvent({ run_id: run.id, type: 'tick', message: `event ${i}` })
      }
    })
    const recent = db.listDocumentRunEvents(run.id)
    expect(recent).toHaveLength(200)
    expect(recent[0].message).toBe('event 806')
    expect(recent[199].message).toBe('event 1005')
    const most = db.listDocumentRunEvents(run.id, 5000)
    expect(most).toHaveLength(1000)
    expect(most[0].message).toBe('event 6')
  })

  it('lists the events of one type on their own, so the rest of the log cannot crowd them out', () => {
    const db = openDb()
    const projectId = makeProject(db)
    const run = makeRun(db, projectId)
    const other = makeRun(db, projectId)
    db.transaction(() => {
      for (let i = 1; i <= 1200; i++) {
        db.appendDocumentRunEvent({
          run_id: run.id,
          type: i % 400 === 1 ? 'rolled_back' : 'tick',
          message: `event ${i}`
        })
      }
    })
    db.appendDocumentRunEvent({ run_id: other.id, type: 'rolled_back', message: 'other run' })

    // The first rollback is beyond the newest thousand of everything…
    expect(
      db
        .listDocumentRunEvents(run.id, 1000)
        .filter((event) => event.type === 'rolled_back')
        .map((event) => event.message)
    ).toEqual(['event 401', 'event 801'])
    // …but not of its own type.
    expect(db.listDocumentRunEvents(run.id, 1000, 'rolled_back').map((e) => e.message)).toEqual([
      'event 1',
      'event 401',
      'event 801'
    ])
    expect(db.listDocumentRunEvents(run.id, 2, 'rolled_back').map((e) => e.message)).toEqual([
      'event 401',
      'event 801'
    ])
    expect(db.listDocumentRunEvents(run.id, 10, 'merged')).toEqual([])
    expect(db.listDocumentRunEvents(other.id, 10, 'rolled_back').map((e) => e.message)).toEqual([
      'other run'
    ])
  })

  it('refuses an event for a run that does not exist', () => {
    const db = openDb()
    expect(() =>
      db.appendDocumentRunEvent({ run_id: 'no-such-run', type: 'note', message: 'x' })
    ).toThrow(/FOREIGN KEY/i)
    expect(count(db, 'document_run_events')).toBe(0)
  })
})

describeIf('document run runner lease', () => {
  const T0 = '2026-03-01T10:00:00.000Z'
  const plus = (seconds: number): string => new Date(Date.parse(T0) + seconds * 1000).toISOString()
  /** Claim at T0 + `seconds` with a 30 s lease. */
  const claim = (db: DatabaseService, runId: string, clientId: string, seconds: number) =>
    db.claimDocumentRunRunner(runId, clientId, plus(seconds), plus(seconds - 30))

  it('grants a free run, refuses a second client while fresh and hands over once stale', () => {
    const db = openDb()
    const run = makeRun(db, makeProject(db))
    at('2026-03-01T11:00:00.000Z')

    expect(claim(db, run.id, 'client-a', 0)).toEqual({ owned: true, ownerClientId: 'client-a' })
    expect(db.getDocumentRun(run.id)).toMatchObject({
      runner_client_id: 'client-a',
      runner_heartbeat_at: plus(0)
    })

    // 10 s later the heartbeat is fresh: refused, and the heartbeat is not touched.
    expect(claim(db, run.id, 'client-b', 10)).toEqual({ owned: false, ownerClientId: 'client-a' })
    expect(db.getDocumentRun(run.id)?.runner_heartbeat_at).toBe(plus(0))

    // The owner renews.
    expect(claim(db, run.id, 'client-a', 20)).toEqual({ owned: true, ownerClientId: 'client-a' })
    expect(db.getDocumentRun(run.id)?.runner_heartbeat_at).toBe(plus(20))

    // Exactly at the lease boundary the heartbeat is not yet stale.
    expect(claim(db, run.id, 'client-b', 50)).toEqual({ owned: false, ownerClientId: 'client-a' })

    // 40 s of silence: the other client takes over, and the first one is now refused.
    expect(claim(db, run.id, 'client-b', 60)).toEqual({ owned: true, ownerClientId: 'client-b' })
    expect(db.getDocumentRun(run.id)).toMatchObject({
      runner_client_id: 'client-b',
      runner_heartbeat_at: plus(60)
    })
    expect(claim(db, run.id, 'client-a', 61)).toEqual({ owned: false, ownerClientId: 'client-b' })

    // A heartbeat is not a change to the run.
    expect(db.getDocumentRun(run.id)?.updated_at).toBe(run.updated_at)
  })

  it('lets only one of two clients racing for a stale lease win', () => {
    const db = openDb()
    const run = makeRun(db, makeProject(db))
    claim(db, run.id, 'client-a', 0)
    const results = [claim(db, run.id, 'client-b', 120), claim(db, run.id, 'client-c', 120)]
    expect(results).toEqual([
      { owned: true, ownerClientId: 'client-b' },
      { owned: false, ownerClientId: 'client-b' }
    ])
  })

  it('treats an owner without a heartbeat as stale', () => {
    const db = openDb()
    const run = makeRun(db, makeProject(db))
    db.getRawDb()
      .prepare(`UPDATE document_runs SET runner_client_id = 'ghost-client' WHERE id = ?`)
      .run(run.id)
    expect(claim(db, run.id, 'client-a', 0)).toEqual({ owned: true, ownerClientId: 'client-a' })
  })

  it('leases each run separately and owns nothing on an unknown run', () => {
    const db = openDb()
    const projectId = makeProject(db)
    const first = makeRun(db, projectId)
    const second = makeRun(db, projectId)
    expect(claim(db, first.id, 'client-a', 0).owned).toBe(true)
    expect(claim(db, second.id, 'client-b', 0)).toEqual({ owned: true, ownerClientId: 'client-b' })
    expect(db.getDocumentRun(first.id)?.runner_client_id).toBe('client-a')

    expect(claim(db, 'no-such-run', 'client-a', 0)).toEqual({ owned: false, ownerClientId: null })
    expect(count(db, 'document_runs')).toBe(2)
  })
})

describeIf('session final messages', () => {
  it('keeps one row per session and overwrites it with the latest turn end', () => {
    const db = openDb()
    expect(db.getSessionFinalMessage('session-1')).toBeNull()

    const firstAt = at('2026-03-01T10:05:00.000Z')
    db.upsertSessionFinalMessage({
      session_id: 'session-1',
      text: 'All done.\nSTATUS: DONE',
      completion: 'completed',
      api_error: null,
      hook_event: 'Stop'
    })
    // No sessions row is needed: the table is keyed by the id alone.
    expect(db.getSessionFinalMessage('session-1')).toEqual({
      session_id: 'session-1',
      state: 'ended',
      text: 'All done.\nSTATUS: DONE',
      completion: 'completed',
      api_error: null,
      hook_event: 'Stop',
      detail: null,
      background_work: null,
      updated_at: firstAt
    })

    db.upsertSessionFinalMessage({
      session_id: 'session-2',
      text: 'Which currency?',
      completion: 'waiting',
      api_error: null,
      hook_event: 'Stop'
    })
    const secondAt = at('2026-03-01T10:09:00.000Z')
    db.upsertSessionFinalMessage({
      session_id: 'session-1',
      text: '',
      completion: null,
      api_error: 'overloaded_error',
      hook_event: 'StopFailure'
    })
    expect(db.getSessionFinalMessage('session-1')).toEqual({
      session_id: 'session-1',
      state: 'ended',
      text: '',
      completion: null,
      api_error: 'overloaded_error',
      hook_event: 'StopFailure',
      detail: null,
      background_work: null,
      updated_at: secondAt
    })
    expect(db.getSessionFinalMessage('session-2')).toMatchObject({
      text: 'Which currency?',
      completion: 'waiting',
      updated_at: firstAt
    })
    expect(count(db, 'session_final_messages')).toBe(2)
  })

  it('records a blocking or busy state without losing the last turn end text', () => {
    const db = openDb()
    db.upsertSessionFinalMessage({
      session_id: 'session-1',
      text: 'Which currency?\nSTATUS: NEEDS_INPUT',
      completion: 'completed',
      api_error: null,
      hook_event: 'Stop'
    })
    const blockedAt = at('2026-03-01T10:20:00.000Z')
    db.upsertSessionFinalMessage({
      session_id: 'session-1',
      state: 'blocked',
      completion: null,
      api_error: null,
      hook_event: 'answering',
      detail: 'Which currency should the report use?'
    })
    expect(db.getSessionFinalMessage('session-1')).toEqual({
      session_id: 'session-1',
      state: 'blocked',
      text: 'Which currency?\nSTATUS: NEEDS_INPUT',
      completion: null,
      api_error: null,
      hook_event: 'answering',
      detail: 'Which currency should the report use?',
      updated_at: blockedAt
    })

    db.upsertSessionFinalMessage({
      session_id: 'session-1',
      state: 'working',
      completion: null,
      api_error: null,
      hook_event: 'SdkBusy'
    })
    expect(db.getSessionFinalMessage('session-1')).toMatchObject({
      state: 'working',
      text: 'Which currency?\nSTATUS: NEEDS_INPUT',
      detail: null
    })

    db.upsertSessionFinalMessage({
      session_id: 'session-1',
      text: 'Done.',
      completion: 'completed',
      api_error: null,
      hook_event: 'Stop'
    })
    expect(db.getSessionFinalMessage('session-1')).toMatchObject({ state: 'ended', text: 'Done.' })

    db.deleteSessionFinalMessage('session-1')
    expect(db.getSessionFinalMessage('session-1')).toBeNull()
  })

  it('goes away with its session, which holds the last assistant text', () => {
    const db = openDb()
    const projectId = makeProject(db)
    const worktree = db.createWorktree({
      project_id: projectId,
      name: 'wt',
      branch_name: 'wt',
      path: '/tmp/document-flow-wt'
    })
    const session = db.createSession({ project_id: projectId, worktree_id: worktree.id })
    db.upsertSessionFinalMessage({
      session_id: session.id,
      text: 'Done.',
      completion: 'completed',
      api_error: null,
      hook_event: 'Stop'
    })

    expect(db.deleteSession(session.id)).toBe(true)

    expect(db.getSessionFinalMessage(session.id)).toBeNull()
  })

  it('adds the state columns to a table created by an earlier build', () => {
    const db = openDb()
    const raw = db.getRawDb()
    raw.exec('DROP TABLE session_final_messages')
    raw.exec(`CREATE TABLE session_final_messages (
      session_id TEXT PRIMARY KEY, text TEXT NOT NULL DEFAULT '', completion TEXT,
      api_error TEXT, hook_event TEXT NOT NULL, updated_at TEXT NOT NULL)`)
    raw
      .prepare(
        `INSERT INTO session_final_messages (session_id, text, hook_event, updated_at)
         VALUES ('old', 'legacy text', 'Stop', '2026-01-01T00:00:00.000Z')`
      )
      .run()

    db.init()

    expect(db.getSessionFinalMessage('old')).toMatchObject({
      state: 'ended',
      text: 'legacy text',
      detail: null
    })
  })
})

describeIf('document flow writes and db:changed', () => {
  it('publish nothing: the flow has its own channel', () => {
    const publisher = vi.fn<(channel: string, payload: unknown) => Promise<void>>(async () => {})
    setDbChangeEventPublisher(publisher)
    try {
      const db = openDb()
      const projectId = makeProject(db)
      // Drop what the migrations and the project insert queued.
      flushPendingDbChangedEvents()
      publisher.mockClear()

      const run = makeRun(db, projectId)
      db.updateDocumentRun(run.id, { status: 'preview' })
      const [item] = db.replaceDocumentRunItems(run.id, [draft('A1')])
      db.updateDocumentRunItem(item.id, { status: 'running' })
      db.appendDocumentRunEvent({ run_id: run.id, type: 'launched', message: 'A1 launched' })
      db.claimDocumentRunRunner(
        run.id,
        'client-a',
        '2026-03-01T10:00:30.000Z',
        '2026-03-01T10:00:00.000Z'
      )
      db.upsertSessionFinalMessage({
        session_id: 'session-1',
        text: 'done',
        completion: 'completed',
        api_error: null,
        hook_event: 'Stop'
      })
      db.deleteDocumentRun(run.id)

      flushPendingDbChangedEvents()
      expect(publisher).not.toHaveBeenCalled()
    } finally {
      flushPendingDbChangedEvents()
      setDbChangeEventPublisher(null)
    }
  })
})

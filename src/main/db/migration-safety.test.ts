import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { CURRENT_SCHEMA_VERSION } from './schema'
import { DatabaseService } from './database'

const tempDirs: string[] = []
let databaseLoadError: Error | null = null

const canRunDatabaseTests = (): boolean => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3')
    const db = new Database(':memory:')
    db.close()
    return true
  } catch (error) {
    databaseLoadError = error as Error
    return false
  }
}

const describeIf = canRunDatabaseTests() ? describe : describe.skip

const makeDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-migration-safety-'))
  tempDirs.push(dir)
  return join(dir, 'state.sqlite')
}

const columnNames = (db: DatabaseService, table: string): string[] =>
  (db.getRawDb().pragma(`table_info(${table})`) as { name: string }[]).map((column) => column.name)

const seedOriginMainVersion31Shape = (dbPath: string): void => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3')
  const db = new Database(dbPath)
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      custom_commands TEXT DEFAULT NULL,
      worktree_create_script TEXT DEFAULT NULL,
      kanban_simple_mode INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_accessed_at TEXT NOT NULL
    );

    CREATE TABLE worktrees (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      branch_name TEXT NOT NULL,
      path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      attachments TEXT DEFAULT '[]',
      pinned INTEGER NOT NULL DEFAULT 0,
      context TEXT DEFAULT NULL,
      github_pr_number INTEGER DEFAULT NULL,
      github_pr_url TEXT DEFAULT NULL,
      created_at TEXT NOT NULL,
      last_accessed_at TEXT NOT NULL
    );

    CREATE TABLE connections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      color TEXT DEFAULT NULL,
      custom_name TEXT DEFAULT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      worktree_id TEXT REFERENCES worktrees(id) ON DELETE SET NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      connection_id TEXT DEFAULT NULL REFERENCES connections(id) ON DELETE SET NULL,
      agent_sdk TEXT NOT NULL DEFAULT 'opencode',
      claude_session_id TEXT DEFAULT NULL,
      pinned_to_board INTEGER NOT NULL DEFAULT 0,
      session_type TEXT NOT NULL DEFAULT 'default',
      status TEXT NOT NULL DEFAULT 'active',
      mode TEXT NOT NULL DEFAULT 'build',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE kanban_tickets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      attachments TEXT NOT NULL DEFAULT '[]',
      "column" TEXT NOT NULL DEFAULT 'todo',
      sort_order REAL NOT NULL DEFAULT 0,
      current_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      worktree_id TEXT REFERENCES worktrees(id) ON DELETE SET NULL,
      mode TEXT,
      plan_ready INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT DEFAULT NULL,
      github_pr_number INTEGER DEFAULT NULL,
      github_pr_url TEXT DEFAULT NULL,
      mark TEXT DEFAULT NULL,
      note TEXT DEFAULT NULL,
      goal_mode INTEGER NOT NULL DEFAULT 0,
      goal_success_criteria TEXT DEFAULT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE ticket_followup_messages (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES kanban_tickets(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      mode TEXT,
      session_id TEXT,
      source TEXT,
      created_at TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user'
    );

    CREATE TABLE saved_usage_accounts (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL CHECK (provider IN ('anthropic','openai')),
      email TEXT NOT NULL,
      credentials_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    INSERT INTO settings (key, value) VALUES ('schema_version', '31');
    INSERT INTO projects (id, name, path, created_at, last_accessed_at)
      VALUES ('project-1', 'Project', '/tmp/project-1', '2026-06-06T00:00:00.000Z', '2026-06-06T00:00:00.000Z');
    INSERT INTO worktrees (id, project_id, name, branch_name, path, created_at, last_accessed_at)
      VALUES ('worktree-1', 'project-1', 'Main', 'main', '/tmp/project-1', '2026-06-06T00:00:00.000Z', '2026-06-06T00:00:00.000Z');
  `)
  db.close()
}

const seedTicketModelColumnsV38Shape = (dbPath: string): void => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3')
  const db = new Database(dbPath)
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      last_accessed_at TEXT NOT NULL
    );

    CREATE TABLE worktrees (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      branch_name TEXT NOT NULL,
      path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      last_accessed_at TEXT NOT NULL
    );

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      worktree_id TEXT REFERENCES worktrees(id) ON DELETE SET NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'active',
      mode TEXT NOT NULL DEFAULT 'build',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- v38 shape: kanban_tickets has auto_approve_plan (added at v38) but NOT
    -- the model_provider_id/model_id/model_variant/variant_group_id columns
    -- added at v39.
    CREATE TABLE kanban_tickets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      attachments TEXT NOT NULL DEFAULT '[]',
      "column" TEXT NOT NULL DEFAULT 'todo',
      sort_order REAL NOT NULL DEFAULT 0,
      current_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      worktree_id TEXT REFERENCES worktrees(id) ON DELETE SET NULL,
      mode TEXT,
      plan_ready INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT DEFAULT NULL,
      github_pr_number INTEGER DEFAULT NULL,
      github_pr_url TEXT DEFAULT NULL,
      mark TEXT DEFAULT NULL,
      note TEXT DEFAULT NULL,
      goal_mode INTEGER NOT NULL DEFAULT 0,
      goal_success_criteria TEXT DEFAULT NULL,
      created_from_session INTEGER NOT NULL DEFAULT 0,
      auto_approve_plan INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Same v38 shape for the markdown runtime-state table.
    CREATE TABLE markdown_kanban_card_state (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      card_id TEXT NOT NULL,
      current_session_id TEXT DEFAULT NULL REFERENCES sessions(id) ON DELETE SET NULL,
      worktree_id TEXT DEFAULT NULL REFERENCES worktrees(id) ON DELETE SET NULL,
      note TEXT DEFAULT NULL,
      attachments TEXT NOT NULL DEFAULT '[]',
      plan_ready INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      pending_launch_config TEXT DEFAULT NULL,
      last_seen_path TEXT DEFAULT NULL,
      orphaned_at TEXT DEFAULT NULL,
      auto_approve_plan INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, card_id)
    );

    INSERT INTO settings (key, value) VALUES ('schema_version', '38');
    INSERT INTO projects (id, name, path, created_at, last_accessed_at)
      VALUES ('project-1', 'Project', '/tmp/project-1', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
    INSERT INTO kanban_tickets (id, project_id, title, note, auto_approve_plan, created_at, updated_at)
      VALUES ('ticket-1', 'project-1', 'Pre-upgrade ticket', 'kept note', 1, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
    INSERT INTO markdown_kanban_card_state (project_id, card_id, note, auto_approve_plan, created_at, updated_at)
      VALUES ('project-1', 'card-1', 'kept card note', 0, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
  `)
  db.close()
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describeIf('database migration safety', () => {
  if (databaseLoadError) {
    it('skips when better-sqlite3 is not available for this Node runtime', () => {
      expect(databaseLoadError?.message).toBeTruthy()
    })
  }

  it('creates branch-added Discord and teleport schema on a fresh database', () => {
    const db = new DatabaseService(makeDbPath())
    db.init()

    expect(db.getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.tableExists('discord_resources')).toBe(true)
    expect(columnNames(db, 'discord_resources')).toEqual(
      expect.arrayContaining(['managed_session_id'])
    )
    expect(columnNames(db, 'worktrees')).toEqual(expect.arrayContaining(['teleported_to']))

    db.close()
  })

  it('supports the kanban auto_approve_plan flag end-to-end on a fresh database', () => {
    const db = new DatabaseService(makeDbPath())
    db.init()

    expect(columnNames(db, 'kanban_tickets')).toEqual(expect.arrayContaining(['auto_approve_plan']))
    expect(columnNames(db, 'markdown_kanban_card_state')).toEqual(
      expect.arrayContaining(['auto_approve_plan'])
    )

    const project = db.createProject({ name: 'Project', path: makeDbPath() })
    const ticket = db.createKanbanTicket({ project_id: project.id, title: 'Ticket', mode: 'plan' })
    expect(ticket.auto_approve_plan).toBe(false)

    expect(db.updateKanbanTicket(ticket.id, { auto_approve_plan: true })?.auto_approve_plan).toBe(
      true
    )
    expect(db.getKanbanTicket(ticket.id)?.auto_approve_plan).toBe(true)
    expect(db.updateKanbanTicket(ticket.id, { auto_approve_plan: false })?.auto_approve_plan).toBe(
      false
    )

    db.close()
  })

  it('supports the multi-model ticket columns end-to-end on a fresh database', () => {
    const db = new DatabaseService(makeDbPath())
    db.init()

    expect(columnNames(db, 'kanban_tickets')).toEqual(
      expect.arrayContaining(['model_provider_id', 'model_id', 'model_variant', 'variant_group_id'])
    )
    expect(columnNames(db, 'markdown_kanban_card_state')).toEqual(
      expect.arrayContaining(['model_provider_id', 'model_id', 'model_variant', 'variant_group_id'])
    )

    const project = db.createProject({ name: 'Project', path: makeDbPath() })

    // Create without model fields -> all four null
    const bareTicket = db.createKanbanTicket({ project_id: project.id, title: 'No model' })
    expect(bareTicket.model_provider_id).toBeNull()
    expect(bareTicket.model_id).toBeNull()
    expect(bareTicket.model_variant).toBeNull()
    expect(bareTicket.variant_group_id).toBeNull()
    expect(bareTicket.note).toBeNull()

    // Create with model fields + note -> round-trips via create response, get, and list
    const ticket = db.createKanbanTicket({
      project_id: project.id,
      title: 'With model',
      note: 'private annotation',
      model_provider_id: 'anthropic',
      model_id: 'claude-sonnet-5',
      model_variant: 'high',
      variant_group_id: 'group-1'
    })
    expect(ticket.note).toBe('private annotation')
    expect(ticket.model_provider_id).toBe('anthropic')
    expect(ticket.model_id).toBe('claude-sonnet-5')
    expect(ticket.model_variant).toBe('high')
    expect(ticket.variant_group_id).toBe('group-1')

    const fetched = db.getKanbanTicket(ticket.id)
    expect(fetched?.note).toBe('private annotation')
    expect(fetched?.model_provider_id).toBe('anthropic')
    expect(fetched?.model_id).toBe('claude-sonnet-5')
    expect(fetched?.model_variant).toBe('high')
    expect(fetched?.variant_group_id).toBe('group-1')

    const listedTicket = db
      .getKanbanTicketsByProject(project.id)
      .find((candidate) => candidate.id === ticket.id)
    expect(listedTicket?.model_provider_id).toBe('anthropic')
    expect(listedTicket?.variant_group_id).toBe('group-1')

    // Update: set each field, then clear each field back to null
    const updatedSet = db.updateKanbanTicket(ticket.id, {
      model_provider_id: 'openai',
      model_id: 'gpt-5',
      model_variant: 'medium',
      variant_group_id: 'group-2'
    })
    expect(updatedSet?.model_provider_id).toBe('openai')
    expect(updatedSet?.model_id).toBe('gpt-5')
    expect(updatedSet?.model_variant).toBe('medium')
    expect(updatedSet?.variant_group_id).toBe('group-2')

    const updatedClear = db.updateKanbanTicket(ticket.id, {
      model_provider_id: null,
      model_id: null,
      model_variant: null,
      variant_group_id: null
    })
    expect(updatedClear?.model_provider_id).toBeNull()
    expect(updatedClear?.model_id).toBeNull()
    expect(updatedClear?.model_variant).toBeNull()
    expect(updatedClear?.variant_group_id).toBeNull()

    db.close()
  })

  it('is idempotent when the ticket model columns already exist', () => {
    const dbPath = makeDbPath()
    const db1 = new DatabaseService(dbPath)
    db1.init()
    db1.close()

    // Re-running init() on an already-migrated database must not throw
    // (safeAddColumn no-ops when the column is already present).
    const db2 = new DatabaseService(dbPath)
    expect(() => db2.init()).not.toThrow()
    expect(columnNames(db2, 'kanban_tickets')).toEqual(
      expect.arrayContaining(['model_provider_id', 'model_id', 'model_variant', 'variant_group_id'])
    )
    expect(columnNames(db2, 'markdown_kanban_card_state')).toEqual(
      expect.arrayContaining(['model_provider_id', 'model_id', 'model_variant', 'variant_group_id'])
    )
    db2.close()
  })

  it('upgrades an origin/main v31-shaped database to v34 without losing existing worktrees', () => {
    const dbPath = makeDbPath()
    seedOriginMainVersion31Shape(dbPath)

    const db = new DatabaseService(dbPath)
    db.init()

    expect(db.getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION)
    expect(columnNames(db, 'discord_resources')).toEqual(
      expect.arrayContaining(['managed_session_id'])
    )
    expect(columnNames(db, 'worktrees')).toEqual(expect.arrayContaining(['teleported_to']))
    expect(db.getRawDb().prepare('SELECT COUNT(*) AS count FROM worktrees').get()).toEqual({
      count: 1
    })

    db.close()
  })

  it('upgrades a v38-shaped database to v39, adding the ticket model columns and preserving pre-upgrade tickets', () => {
    const dbPath = makeDbPath()
    seedTicketModelColumnsV38Shape(dbPath)

    const db = new DatabaseService(dbPath)
    db.init()

    expect(db.getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION)
    expect(columnNames(db, 'kanban_tickets')).toEqual(
      expect.arrayContaining(['model_provider_id', 'model_id', 'model_variant', 'variant_group_id'])
    )
    expect(columnNames(db, 'markdown_kanban_card_state')).toEqual(
      expect.arrayContaining(['model_provider_id', 'model_id', 'model_variant', 'variant_group_id'])
    )

    // The ticket written before the upgrade keeps its pre-existing fields and
    // round-trips with the four new columns null.
    const ticket = db.getKanbanTicket('ticket-1')
    expect(ticket?.title).toBe('Pre-upgrade ticket')
    expect(ticket?.note).toBe('kept note')
    expect(ticket?.auto_approve_plan).toBe(true)
    expect(ticket?.model_provider_id).toBeNull()
    expect(ticket?.model_id).toBeNull()
    expect(ticket?.model_variant).toBeNull()
    expect(ticket?.variant_group_id).toBeNull()

    const cardStateRow = db
      .getRawDb()
      .prepare('SELECT * FROM markdown_kanban_card_state WHERE project_id = ? AND card_id = ?')
      .get('project-1', 'card-1') as Record<string, unknown>
    expect(cardStateRow.note).toBe('kept card note')
    expect(cardStateRow.model_provider_id).toBeNull()
    expect(cardStateRow.model_id).toBeNull()
    expect(cardStateRow.model_variant).toBeNull()
    expect(cardStateRow.variant_group_id).toBeNull()

    db.close()
  })

  it('repairs branch-added columns even if schema_version was already advanced', () => {
    const dbPath = makeDbPath()
    seedOriginMainVersion31Shape(dbPath)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3')
    const rawDb = new Database(dbPath)
    rawDb.exec(`
      UPDATE settings SET value = '${CURRENT_SCHEMA_VERSION}' WHERE key = 'schema_version';
      CREATE TABLE discord_resources (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        worktree_id TEXT REFERENCES worktrees(id) ON DELETE CASCADE,
        discord_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('category','channel')),
        guild_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `)
    rawDb.close()

    const db = new DatabaseService(dbPath)
    db.init()

    expect(db.getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION)
    expect(columnNames(db, 'discord_resources')).toEqual(
      expect.arrayContaining(['managed_session_id'])
    )
    expect(columnNames(db, 'worktrees')).toEqual(expect.arrayContaining(['teleported_to']))

    db.close()
  })
})

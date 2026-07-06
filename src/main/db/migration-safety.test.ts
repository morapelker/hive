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

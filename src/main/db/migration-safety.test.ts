import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_DOCUMENT_RUN_CONFIG } from '@shared/types/document-flow'

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
    -- added at v40.
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

// v54 shape: projects has custom_commands but not shell_commands; sessions has
// remote_launch / custom_provider_id but not shell_command (both added at v55).
const seedShellCommandsV54Shape = (dbPath: string): void => {
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
      agent_sdk TEXT NOT NULL DEFAULT 'opencode',
      session_type TEXT NOT NULL DEFAULT 'default',
      remote_launch TEXT DEFAULT NULL,
      custom_provider_id TEXT DEFAULT NULL,
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
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE markdown_kanban_card_state (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      card_id TEXT NOT NULL,
      current_session_id TEXT DEFAULT NULL REFERENCES sessions(id) ON DELETE SET NULL,
      worktree_id TEXT DEFAULT NULL REFERENCES worktrees(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, card_id)
    );

    INSERT INTO settings (key, value) VALUES ('schema_version', '54');
    INSERT INTO projects (id, name, path, custom_commands, created_at, last_accessed_at)
      VALUES ('project-1', 'Project', '/tmp/project-1', '[{"id":"c1","name":"Ask","prompt":"hi"}]', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    INSERT INTO worktrees (id, project_id, name, branch_name, path, created_at, last_accessed_at)
      VALUES ('worktree-1', 'project-1', 'Main', 'main', '/tmp/project-1', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    INSERT INTO sessions (id, worktree_id, project_id, agent_sdk, created_at, updated_at)
      VALUES ('session-1', 'worktree-1', 'project-1', 'terminal', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
  `)
  db.close()
}

const SHELL_SNAPSHOT = {
  commandId: 'cmd-1',
  name: 'Build',
  script: 'pnpm build',
  detached: false,
  state: 'pending',
  runId: null,
  exitCode: null,
  signal: null,
  reason: null,
  error: null,
  startedAt: null,
  finishedAt: null
}

const shellSnapshotJson = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({ ...SHELL_SNAPSHOT, ...overrides })

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

  it('supports the project trust_check_done flag end-to-end on a fresh database', () => {
    const db = new DatabaseService(makeDbPath())
    db.init()

    expect(columnNames(db, 'projects')).toEqual(expect.arrayContaining(['trust_check_done']))

    const project = db.createProject({ name: 'Project', path: makeDbPath() })
    expect(project.trust_check_done).toBe(false)

    db.updateProjectTrustCheck(project.id, true)
    expect(db.getProject(project.id)?.trust_check_done).toBe(true)

    db.updateProjectTrustCheck(project.id, false)
    expect(db.getProject(project.id)?.trust_check_done).toBe(false)

    db.close()
  })

  it('supports the ticket awaiting_completion flag end-to-end on a fresh database', () => {
    const db = new DatabaseService(makeDbPath())
    db.init()

    expect(columnNames(db, 'kanban_tickets')).toEqual(
      expect.arrayContaining(['awaiting_completion'])
    )
    expect(columnNames(db, 'markdown_kanban_card_state')).toEqual(
      expect.arrayContaining(['awaiting_completion'])
    )

    const project = db.createProject({ name: 'Project', path: makeDbPath() })
    const ticket = db.createKanbanTicket({
      project_id: project.id,
      title: 'Ticket',
      column: 'in_progress'
    })
    expect(ticket.awaiting_completion).toBe(false)

    // A plain move into review marks unread only.
    const reviewed = db.moveKanbanTicket(ticket.id, 'review', 0)
    expect(reviewed?.unread).toBe(true)
    expect(reviewed?.awaiting_completion).toBe(false)

    // A Claude CLI stop without a detected completion flags the in-progress
    // ticket in place (it is not moved); a same-column reorder keeps the flag.
    db.moveKanbanTicket(ticket.id, 'in_progress', 0)
    const paused = db.updateKanbanTicket(ticket.id, { awaiting_completion: true })
    expect(paused?.column).toBe('in_progress')
    expect(paused?.awaiting_completion).toBe(true)
    expect(db.moveKanbanTicket(ticket.id, 'in_progress', 3)?.awaiting_completion).toBe(true)

    // The run resuming clears the flag in place.
    const resumed = db.updateKanbanTicket(ticket.id, { awaiting_completion: false })
    expect(resumed?.column).toBe('in_progress')
    expect(resumed?.awaiting_completion).toBe(false)

    // Any column change (move or update) drops the flag: the real completion
    // moves the ticket to review with only the unread dot.
    db.updateKanbanTicket(ticket.id, { awaiting_completion: true })
    const finished = db.moveKanbanTicket(ticket.id, 'review', 0)
    expect(finished?.unread).toBe(true)
    expect(finished?.awaiting_completion).toBe(false)
    db.moveKanbanTicket(ticket.id, 'in_progress', 0)
    db.updateKanbanTicket(ticket.id, { awaiting_completion: true })
    expect(db.updateKanbanTicket(ticket.id, { column: 'review' })?.awaiting_completion).toBe(false)
    // …unless the ticket is not actually changing column (no-op update keeps it).
    db.moveKanbanTicket(ticket.id, 'in_progress', 0)
    db.updateKanbanTicket(ticket.id, { awaiting_completion: true })
    expect(db.updateKanbanTicket(ticket.id, { title: 'Renamed' })?.awaiting_completion).toBe(true)
    // An explicit awaiting_completion on a column-changing update still wins.
    expect(
      db.updateKanbanTicket(ticket.id, { column: 'review', awaiting_completion: true })
        ?.awaiting_completion
    ).toBe(true)

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
      model_id: 'claude-sonnet-5-5',
      model_variant: 'high',
      variant_group_id: 'group-1'
    })
    expect(ticket.note).toBe('private annotation')
    expect(ticket.model_provider_id).toBe('anthropic')
    expect(ticket.model_id).toBe('claude-sonnet-5-5')
    expect(ticket.model_variant).toBe('high')
    expect(ticket.variant_group_id).toBe('group-1')

    const fetched = db.getKanbanTicket(ticket.id)
    expect(fetched?.note).toBe('private annotation')
    expect(fetched?.model_provider_id).toBe('anthropic')
    expect(fetched?.model_id).toBe('claude-sonnet-5-5')
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

  it('upgrades a v38-shaped database to v40, adding the ticket model columns and preserving pre-upgrade tickets', () => {
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

  describe('shell commands (v51)', () => {
    it('adds projects.shell_commands and sessions.shell_command on a fresh database', () => {
      const db = new DatabaseService(makeDbPath())
      db.init()

      expect(db.getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION)
      expect(columnNames(db, 'projects')).toEqual(expect.arrayContaining(['shell_commands']))
      expect(columnNames(db, 'sessions')).toEqual(expect.arrayContaining(['shell_command']))

      db.close()
    })

    it('stores shell_commands on the project (keepRunningOnQuit kept) and drops invalid entries', () => {
      const db = new DatabaseService(makeDbPath())
      db.init()

      const project = db.createProject({ name: 'Project', path: makeDbPath() })
      expect(project.shell_commands).toEqual([])

      const updated = db.updateProject(project.id, {
        shell_commands: [
          { id: 'build', name: 'Build', commands: 'pnpm build', keepRunningOnQuit: true },
          { id: 'test', name: 'Test', commands: 'pnpm test' },
          // invalid: comment-only script
          { id: 'noop', name: 'Noop', commands: '# nothing' },
          // invalid: missing name
          { id: 'bad', commands: 'echo hi' } as never
        ]
      })
      expect(updated?.shell_commands).toEqual([
        { id: 'build', name: 'Build', commands: 'pnpm build', keepRunningOnQuit: true },
        { id: 'test', name: 'Test', commands: 'pnpm test' }
      ])
      expect(db.getProject(project.id)?.shell_commands).toEqual(updated?.shell_commands)

      // Stored as normalized JSON; clearing writes NULL.
      const raw = db
        .getRawDb()
        .prepare('SELECT shell_commands FROM projects WHERE id = ?')
        .get(project.id) as { shell_commands: string | null }
      expect(JSON.parse(raw.shell_commands as string)).toHaveLength(2)

      expect(db.updateProject(project.id, { shell_commands: [] })?.shell_commands).toEqual([])
      const cleared = db
        .getRawDb()
        .prepare('SELECT shell_commands FROM projects WHERE id = ?')
        .get(project.id) as { shell_commands: string | null }
      expect(cleared.shell_commands).toBeNull()

      // Unrelated updates leave the definitions alone.
      db.updateProject(project.id, {
        shell_commands: [{ id: 'build', name: 'Build', commands: 'pnpm build' }]
      })
      expect(db.updateProject(project.id, { name: 'Renamed' })?.shell_commands).toHaveLength(1)

      db.close()
    })

    it('persists shell_command on create and rewrites it on update', () => {
      const db = new DatabaseService(makeDbPath())
      db.init()

      const project = db.createProject({ name: 'Project', path: makeDbPath() })
      const worktree = db.createWorktree({
        project_id: project.id,
        name: 'Main',
        branch_name: 'main',
        path: project.path
      })

      const plain = db.createSession({ worktree_id: worktree.id, project_id: project.id })
      expect(plain.shell_command).toBeNull()
      expect(db.getSession(plain.id)?.shell_command).toBeNull()

      const snapshot = shellSnapshotJson()
      const session = db.createSession({
        worktree_id: worktree.id,
        project_id: project.id,
        agent_sdk: 'terminal',
        session_type: 'shell-command',
        shell_command: snapshot
      })
      expect(session.session_type).toBe('shell-command')
      expect(session.shell_command).toBe(snapshot)
      expect(db.getSession(session.id)?.shell_command).toBe(snapshot)

      const running = shellSnapshotJson({ state: 'running', runId: 'run-1' })
      expect(db.updateSession(session.id, { shell_command: running })?.shell_command).toBe(running)
      expect(db.getSession(session.id)?.shell_command).toBe(running)

      // Unrelated updates leave the snapshot alone.
      expect(db.updateSession(session.id, { name: 'Renamed' })?.shell_command).toBe(running)

      db.close()
    })

    it('getShellCommandSessionsInStates filters by persisted state and tolerates malformed JSON', () => {
      const db = new DatabaseService(makeDbPath())
      db.init()

      const project = db.createProject({ name: 'Project', path: makeDbPath() })
      const worktree = db.createWorktree({
        project_id: project.id,
        name: 'Main',
        branch_name: 'main',
        path: project.path
      })
      const create = (shellCommand: string | null, sessionType = 'shell-command' as const) =>
        db.createSession({
          worktree_id: worktree.id,
          project_id: project.id,
          agent_sdk: 'terminal',
          session_type: sessionType,
          shell_command: shellCommand
        })

      const running = create(shellSnapshotJson({ state: 'running', runId: 'run-1' }))
      const pending = create(shellSnapshotJson())
      const succeeded = create(shellSnapshotJson({ state: 'succeeded', exitCode: 0 }))
      create('{not json')
      create(null)
      // A default session with a running-looking snapshot is not a shell command.
      db.createSession({
        worktree_id: worktree.id,
        project_id: project.id,
        agent_sdk: 'terminal',
        shell_command: shellSnapshotJson({ state: 'running' })
      })

      expect(db.getShellCommandSessionsInStates([])).toEqual([])
      expect(db.getShellCommandSessionsInStates(['running']).map((s) => s.id)).toEqual([running.id])
      expect(
        db
          .getShellCommandSessionsInStates(['pending', 'running'])
          .map((s) => s.id)
          .sort()
      ).toEqual([pending.id, running.id].sort())
      expect(db.getShellCommandSessionsInStates(['succeeded']).map((s) => s.id)).toEqual([
        succeeded.id
      ])
      expect(db.getShellCommandSessionsInStates(['failed'])).toEqual([])

      db.close()
    })

    it('getShellCommandRunRows returns the mapped rows newest first', () => {
      const db = new DatabaseService(makeDbPath())
      db.init()

      const project = db.createProject({ name: 'Project', path: makeDbPath() })
      const worktree = db.createWorktree({
        project_id: project.id,
        name: 'Main',
        branch_name: 'main',
        path: project.path
      })

      const first = db.createSession({
        worktree_id: worktree.id,
        project_id: project.id,
        agent_sdk: 'terminal',
        session_type: 'shell-command',
        shell_command: shellSnapshotJson()
      })
      const second = db.createSession({
        worktree_id: worktree.id,
        project_id: project.id,
        agent_sdk: 'terminal',
        session_type: 'shell-command',
        shell_command: shellSnapshotJson({ state: 'succeeded', exitCode: 0 })
      })
      // Not shell commands: excluded.
      db.createSession({ worktree_id: worktree.id, project_id: project.id })
      db.createSession({
        worktree_id: worktree.id,
        project_id: project.id,
        session_type: 'shell-command',
        shell_command: null
      })
      // Make the ordering deterministic: `first` was updated last.
      db.getRawDb()
        .prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
        .run('2030-01-01T00:00:00.000Z', first.id)

      const rows = db.getShellCommandRunRows()
      expect(rows).toEqual([
        {
          sessionId: first.id,
          projectId: project.id,
          worktreeId: worktree.id,
          shellCommand: shellSnapshotJson()
        },
        {
          sessionId: second.id,
          projectId: project.id,
          worktreeId: worktree.id,
          shellCommand: shellSnapshotJson({ state: 'succeeded', exitCode: 0 })
        }
      ])
      expect(db.getShellCommandRunRows(1)).toHaveLength(1)

      db.close()
    })

    it('upgrades a v54-shaped database to v55 keeping its rows', () => {
      const dbPath = makeDbPath()
      seedShellCommandsV54Shape(dbPath)

      const db = new DatabaseService(dbPath)
      db.init()

      expect(db.getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION)
      expect(columnNames(db, 'projects')).toEqual(expect.arrayContaining(['shell_commands']))
      expect(columnNames(db, 'sessions')).toEqual(expect.arrayContaining(['shell_command']))

      const project = db.getProject('project-1')
      expect(project?.custom_commands).toEqual([{ id: 'c1', name: 'Ask', prompt: 'hi' }])
      expect(project?.shell_commands).toEqual([])

      const session = db.getSession('session-1')
      expect(session?.agent_sdk).toBe('terminal')
      expect(session?.session_type).toBe('default')
      expect(session?.shell_command).toBeNull()
      expect(db.getShellCommandRunRows()).toEqual([])
      expect(db.getShellCommandSessionsInStates(['running'])).toEqual([])

      // Re-running init() on the upgraded database is a no-op.
      db.close()
      const db2 = new DatabaseService(dbPath)
      expect(() => db2.init()).not.toThrow()
      expect(db2.getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION)
      db2.close()
    })
  })

  describe('document run ticket (v57)', () => {
    it('adds document_runs.ticket_id on a fresh database', () => {
      const db = new DatabaseService(makeDbPath())
      db.init()

      expect(db.getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION)
      expect(columnNames(db, 'document_runs')).toEqual(expect.arrayContaining(['ticket_id']))

      db.close()
    })

    it('upgrades a v56-shaped database to v57 keeping its runs, and links a ticket afterwards', () => {
      const dbPath = makeDbPath()
      const seeded = new DatabaseService(dbPath)
      seeded.init()
      const projectId = seeded.createProject({ name: 'repo', path: '/tmp/run-ticket-repo' }).id
      seeded.createDocumentRun({
        id: 'run-1',
        project_id: projectId,
        title: 'Checkout spec',
        source_path: '/docs/checkout.html',
        run_dir: '/runs/checkout',
        status: 'extracting',
        config: DEFAULT_DOCUMENT_RUN_CONFIG
      })
      seeded.updateDocumentRun('run-1', {
        status: 'completed',
        base_branch: 'main',
        integration_branch: 'doc-checkout',
        integration_worktree_id: 'wt-integration'
      })
      // v56 shape: document_runs without the ticket link.
      seeded.getRawDb().exec('ALTER TABLE document_runs DROP COLUMN ticket_id')
      seeded.setSetting('schema_version', '56')
      seeded.close()

      const db = new DatabaseService(dbPath)
      db.init()

      expect(db.getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION)
      expect(columnNames(db, 'document_runs')).toEqual(expect.arrayContaining(['ticket_id']))
      expect(db.getDocumentRun('run-1')).toMatchObject({
        status: 'completed',
        base_branch: 'main',
        integration_branch: 'doc-checkout',
        integration_worktree_id: 'wt-integration',
        ticket_id: null
      })

      expect(db.updateDocumentRun('run-1', { ticket_id: 'ticket-run' })?.ticket_id).toBe(
        'ticket-run'
      )
      expect(db.updateDocumentRun('run-1', { ticket_id: null })?.ticket_id).toBeNull()

      // Re-running init() on the upgraded database is a no-op.
      db.close()
      const db2 = new DatabaseService(dbPath)
      expect(() => db2.init()).not.toThrow()
      expect(db2.getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION)
      db2.close()
    })

    it('repairs the column even if schema_version was already advanced', () => {
      const dbPath = makeDbPath()
      const seeded = new DatabaseService(dbPath)
      seeded.init()
      seeded.getRawDb().exec('ALTER TABLE document_runs DROP COLUMN ticket_id')
      seeded.close()

      const db = new DatabaseService(dbPath)
      db.init()

      expect(columnNames(db, 'document_runs')).toEqual(expect.arrayContaining(['ticket_id']))
      db.close()
    })

    it('setWorktreeBaseBranch re-points one worktree and reports an unknown id', () => {
      const db = new DatabaseService(makeDbPath())
      db.init()
      const projectId = db.createProject({ name: 'repo', path: '/tmp/run-ticket-base' }).id
      const worktree = (name: string): string =>
        db.createWorktree({
          project_id: projectId,
          name,
          branch_name: name,
          path: `/tmp/run-ticket-base/${name}`,
          base_branch: 'doc-checkout'
        }).id
      const task = worktree('a1-task')
      const other = worktree('a2-task')

      expect(db.setWorktreeBaseBranch(task, 'main')).toBe(true)

      expect(db.getWorktree(task)?.base_branch).toBe('main')
      expect(db.getWorktree(other)?.base_branch).toBe('doc-checkout')
      expect(db.setWorktreeBaseBranch('no-such-worktree', 'main')).toBe(false)

      db.close()
    })
  })

  describe('document run source kind (v69)', () => {
    it('adds document_runs.source_kind on a fresh database', () => {
      const db = new DatabaseService(makeDbPath())
      db.init()

      expect(db.getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION)
      expect(columnNames(db, 'document_runs')).toEqual(expect.arrayContaining(['source_kind']))

      db.close()
    })

    it('upgrades a v68-shaped database keeping its runs, which read as document runs', () => {
      const dbPath = makeDbPath()
      const seeded = new DatabaseService(dbPath)
      seeded.init()
      const projectId = seeded.createProject({ name: 'repo', path: '/tmp/source-kind-repo' }).id
      seeded.createDocumentRun({
        id: 'run-1',
        project_id: projectId,
        title: 'Checkout spec',
        source_path: '/docs/checkout.html',
        run_dir: '/runs/checkout',
        status: 'preview',
        config: DEFAULT_DOCUMENT_RUN_CONFIG
      })
      // v68 shape: document_runs without the source kind.
      seeded.getRawDb().exec('ALTER TABLE document_runs DROP COLUMN source_kind')
      seeded.setSetting('schema_version', '68')
      seeded.close()

      const db = new DatabaseService(dbPath)
      db.init()

      expect(db.getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION)
      expect(columnNames(db, 'document_runs')).toEqual(expect.arrayContaining(['source_kind']))
      expect(db.getDocumentRun('run-1')).toMatchObject({
        source_kind: 'document',
        source_path: '/docs/checkout.html',
        status: 'preview'
      })

      // Re-running init() on the upgraded database is a no-op.
      db.close()
      const db2 = new DatabaseService(dbPath)
      expect(() => db2.init()).not.toThrow()
      expect(db2.getDocumentRun('run-1')?.source_kind).toBe('document')
      db2.close()
    })

    it('repairs the column even if schema_version was already advanced', () => {
      const dbPath = makeDbPath()
      const seeded = new DatabaseService(dbPath)
      seeded.init()
      seeded.getRawDb().exec('ALTER TABLE document_runs DROP COLUMN source_kind')
      seeded.close()

      const db = new DatabaseService(dbPath)
      db.init()

      expect(columnNames(db, 'document_runs')).toEqual(expect.arrayContaining(['source_kind']))
      db.close()
    })
  })
})

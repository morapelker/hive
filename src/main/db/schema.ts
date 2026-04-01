export const CURRENT_SCHEMA_VERSION = 18

export const SCHEMA_SQL = `
-- Projects table
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  description TEXT,
  tags TEXT,
  language TEXT,
  setup_script TEXT DEFAULT NULL,
  run_script TEXT DEFAULT NULL,
  archive_script TEXT DEFAULT NULL,
  custom_icon TEXT DEFAULT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  auto_assign_port INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL
);

-- Worktrees table
CREATE TABLE IF NOT EXISTS worktrees (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  is_default INTEGER DEFAULT 0,
  branch_renamed INTEGER NOT NULL DEFAULT 0,
  last_message_at INTEGER DEFAULT NULL,
  session_titles TEXT DEFAULT '[]',
  last_model_provider_id TEXT,
  last_model_id TEXT,
  last_model_variant TEXT,
  attachments TEXT DEFAULT '[]',
  pinned INTEGER NOT NULL DEFAULT 0,
  context TEXT DEFAULT NULL,
  github_pr_number INTEGER DEFAULT NULL,
  github_pr_url TEXT DEFAULT NULL,
  created_at TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL
);

-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  worktree_id TEXT REFERENCES worktrees(id) ON DELETE SET NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  opencode_session_id TEXT,
  mode TEXT NOT NULL DEFAULT 'build',
  draft_input TEXT DEFAULT NULL,
  model_provider_id TEXT,
  model_id TEXT,
  model_variant TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

-- Session messages table (legacy fallback only).
-- NOTE: Keep this table during OpenCode transcript migration; drop in a follow-up
-- migration after stabilization.
CREATE TABLE IF NOT EXISTS session_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  opencode_message_id TEXT,
  opencode_message_json TEXT,
  opencode_parts_json TEXT,
  opencode_timeline_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_activities (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_session_id TEXT,
  thread_id TEXT,
  turn_id TEXT,
  item_id TEXT,
  request_id TEXT,
  kind TEXT NOT NULL,
  tone TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload_json TEXT,
  sequence INTEGER,
  created_at TEXT NOT NULL
);

-- Settings table
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Spaces table
CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon_type TEXT NOT NULL DEFAULT 'default',
  icon_value TEXT NOT NULL DEFAULT 'Folder',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- Project-Space assignments
CREATE TABLE IF NOT EXISTS project_spaces (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, space_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_worktrees_project ON worktrees(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_worktree ON sessions(worktree_id);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_messages_session ON session_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_session_opencode
  ON session_messages(session_id, opencode_message_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_session_opencode_unique
  ON session_messages(session_id, opencode_message_id)
  WHERE opencode_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_session_activities_session_created
  ON session_activities(session_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_session_activities_session_turn
  ON session_activities(session_id, turn_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);
CREATE INDEX IF NOT EXISTS idx_projects_accessed ON projects(last_accessed_at);
CREATE INDEX IF NOT EXISTS idx_project_spaces_space ON project_spaces(space_id);
CREATE INDEX IF NOT EXISTS idx_project_spaces_project ON project_spaces(project_id);
`

export interface Migration {
  version: number
  name: string
  up: string
  down: string
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up: SCHEMA_SQL,
    down: `
      DROP INDEX IF EXISTS idx_project_spaces_project;
      DROP INDEX IF EXISTS idx_project_spaces_space;
      DROP INDEX IF EXISTS idx_projects_accessed;
      DROP INDEX IF EXISTS idx_sessions_updated;
      DROP INDEX IF EXISTS idx_messages_session_opencode_unique;
      DROP INDEX IF EXISTS idx_messages_session_opencode;
      DROP INDEX IF EXISTS idx_messages_session;
      DROP INDEX IF EXISTS idx_session_activities_session_turn;
      DROP INDEX IF EXISTS idx_session_activities_session_created;
      DROP INDEX IF EXISTS idx_sessions_project;
      DROP INDEX IF EXISTS idx_sessions_worktree;
      DROP INDEX IF EXISTS idx_worktrees_project;
      DROP TABLE IF EXISTS project_spaces;
      DROP TABLE IF EXISTS spaces;
      DROP TABLE IF EXISTS settings;
      DROP TABLE IF EXISTS session_activities;
      DROP TABLE IF EXISTS session_messages;
      DROP TABLE IF EXISTS sessions;
      DROP TABLE IF EXISTS worktrees;
      DROP TABLE IF EXISTS projects;
    `
  },
  {
    version: 2,
    name: 'add_agent_sdk_column',
    up: `-- NOTE: ALTER TABLE for agent_sdk is handled idempotently by
         -- ensureConnectionTables() in database.ts to avoid "duplicate column" errors.`,
    down: `-- SQLite cannot drop columns; this is a no-op for safety`
  },
  {
    version: 3,
    name: 'add_connections',
    up: `
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS connection_members (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        worktree_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        symlink_name TEXT NOT NULL,
        added_at TEXT NOT NULL,
        FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE,
        FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_connection_members_connection ON connection_members(connection_id);
      CREATE INDEX IF NOT EXISTS idx_connection_members_worktree ON connection_members(worktree_id);

      -- NOTE: ALTER TABLE for connection_id is handled idempotently by
      -- ensureConnectionTables() in database.ts to avoid "duplicate column" errors.

      CREATE INDEX IF NOT EXISTS idx_sessions_connection ON sessions(connection_id);
    `,
    down: `
      DROP INDEX IF EXISTS idx_sessions_connection;
      DROP INDEX IF EXISTS idx_connection_members_worktree;
      DROP INDEX IF EXISTS idx_connection_members_connection;
      DROP TABLE IF EXISTS connection_members;
      DROP TABLE IF EXISTS connections;
    `
  },
  {
    version: 4,
    name: 'add_connection_color',
    up: `-- NOTE: ALTER TABLE for color is handled idempotently by
         -- ensureConnectionTables() in database.ts to avoid "duplicate column" errors.`,
    down: `-- SQLite cannot drop columns; this is a no-op for safety`
  },
  {
    version: 5,
    name: 'add_connection_custom_name',
    up: `-- NOTE: ALTER TABLE for custom_name is handled idempotently by
         -- ensureConnectionTables() in database.ts to avoid "duplicate column" errors.`,
    down: `-- SQLite cannot drop columns; this is a no-op for safety`
  },
  {
    version: 6,
    name: 'add_worktree_attachments',
    up: `ALTER TABLE worktrees ADD COLUMN attachments TEXT DEFAULT '[]'`,
    down: `-- SQLite cannot drop columns; this is a no-op for safety`
  },
  {
    version: 7,
    name: 'add_pinned_columns',
    up: `-- NOTE: ALTER TABLE for pinned is handled idempotently by
         -- ensureConnectionTables() in database.ts to avoid "duplicate column" errors.`,
    down: `-- SQLite cannot drop columns; this is a no-op for safety`
  },
  {
    version: 8,
    name: 'add_worktree_context',
    up: `ALTER TABLE worktrees ADD COLUMN context TEXT DEFAULT NULL`,
    down: `-- SQLite cannot drop columns; this is a no-op for safety`
  },
  {
    version: 9,
    name: 'add_session_activities',
    up: `
      CREATE TABLE IF NOT EXISTS session_activities (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        agent_session_id TEXT,
        thread_id TEXT,
        turn_id TEXT,
        item_id TEXT,
        request_id TEXT,
        kind TEXT NOT NULL,
        tone TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload_json TEXT,
        sequence INTEGER,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_activities_session_created
        ON session_activities(session_id, created_at, id);
      CREATE INDEX IF NOT EXISTS idx_session_activities_session_turn
        ON session_activities(session_id, turn_id, created_at);
    `,
    down: `
      DROP INDEX IF EXISTS idx_session_activities_session_turn;
      DROP INDEX IF EXISTS idx_session_activities_session_created;
      DROP TABLE IF EXISTS session_activities;
    `
  },
  {
    version: 10,
    name: 'add_worktree_github_pr',
    up: `ALTER TABLE worktrees ADD COLUMN github_pr_number INTEGER DEFAULT NULL;
         ALTER TABLE worktrees ADD COLUMN github_pr_url TEXT DEFAULT NULL`,
    down: `-- SQLite cannot drop columns; this is a no-op for safety`
  },
  {
    version: 11,
    name: 'add_kanban_tickets',
    up: `
      CREATE TABLE IF NOT EXISTS kanban_tickets (
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

      CREATE INDEX IF NOT EXISTS idx_kanban_tickets_project ON kanban_tickets(project_id);
      CREATE INDEX IF NOT EXISTS idx_kanban_tickets_session ON kanban_tickets(current_session_id);
      CREATE INDEX IF NOT EXISTS idx_kanban_tickets_worktree ON kanban_tickets(worktree_id);
    `,
    down: `
      DROP INDEX IF EXISTS idx_kanban_tickets_worktree;
      DROP INDEX IF EXISTS idx_kanban_tickets_session;
      DROP INDEX IF EXISTS idx_kanban_tickets_project;
      DROP TABLE IF EXISTS kanban_tickets;
    `
  },
  {
    version: 12,
    name: 'add_kanban_archived_at',
    up: `ALTER TABLE kanban_tickets ADD COLUMN archived_at TEXT DEFAULT NULL`,
    down: `-- SQLite cannot drop columns; no-op for safety`
  },
  {
    version: 13,
    name: 'add_ticket_followup_messages',
    up: `
      CREATE TABLE IF NOT EXISTS ticket_followup_messages (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL REFERENCES kanban_tickets(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'build',
        session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        source TEXT NOT NULL DEFAULT 'direct',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ticket_followup_messages_ticket
        ON ticket_followup_messages(ticket_id, created_at);
    `,
    down: `
      DROP INDEX IF EXISTS idx_ticket_followup_messages_ticket;
      DROP TABLE IF EXISTS ticket_followup_messages;
    `
  },
  {
    version: 14,
    name: 'add_ticket_followup_messages_role',
    up: `
      ALTER TABLE ticket_followup_messages ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
    `,
    down: `
      ALTER TABLE ticket_followup_messages DROP COLUMN role;
    `
  },
  {
    version: 15,
    name: 'add_kanban_ticket_external_source',
    up: `
      ALTER TABLE kanban_tickets ADD COLUMN external_provider TEXT DEFAULT NULL;
      ALTER TABLE kanban_tickets ADD COLUMN external_id TEXT DEFAULT NULL;
      ALTER TABLE kanban_tickets ADD COLUMN external_url TEXT DEFAULT NULL;
      CREATE INDEX IF NOT EXISTS idx_kanban_tickets_external
        ON kanban_tickets(external_provider, external_id);
    `,
    down: `
      DROP INDEX IF EXISTS idx_kanban_tickets_external;
      ALTER TABLE kanban_tickets DROP COLUMN external_url;
      ALTER TABLE kanban_tickets DROP COLUMN external_id;
      ALTER TABLE kanban_tickets DROP COLUMN external_provider;
    `
  },
  {
    version: 16,
    name: 'add_composite_performance_indexes',
    up: `
      CREATE INDEX IF NOT EXISTS idx_sessions_worktree_status
        ON sessions(worktree_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_connection_status
        ON sessions(connection_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_worktrees_project_status
        ON worktrees(project_id, status, last_accessed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_worktrees_status_message
        ON worktrees(status, last_message_at DESC);
    `,
    down: `
      DROP INDEX IF EXISTS idx_sessions_worktree_status;
      DROP INDEX IF EXISTS idx_sessions_connection_status;
      DROP INDEX IF EXISTS idx_worktrees_project_status;
      DROP INDEX IF EXISTS idx_worktrees_status_message;
    `
  },
  {
    version: 17,
    name: 'add_worktree_base_branch',
    up: `ALTER TABLE worktrees ADD COLUMN base_branch TEXT DEFAULT NULL`,
    down: `-- SQLite cannot drop columns; this is a no-op for safety`
  },
  {
    version: 18,
    name: 'add_ticket_total_tokens',
    up: `ALTER TABLE kanban_tickets ADD COLUMN total_tokens INTEGER NOT NULL DEFAULT 0`,
    down: `-- SQLite cannot drop columns; this is a no-op for safety`
  }
]

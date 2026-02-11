export const CURRENT_SCHEMA_VERSION = 8

export const SCHEMA_SQL = `
-- Projects table
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  description TEXT,
  tags TEXT,
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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

-- Session messages table (for history/search)
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

-- Settings table
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
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
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);
CREATE INDEX IF NOT EXISTS idx_projects_accessed ON projects(last_accessed_at);
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
      DROP INDEX IF EXISTS idx_projects_accessed;
      DROP INDEX IF EXISTS idx_sessions_updated;
      DROP INDEX IF EXISTS idx_messages_session;
      DROP INDEX IF EXISTS idx_messages_session_opencode;
      DROP INDEX IF EXISTS idx_messages_session_opencode_unique;
      DROP INDEX IF EXISTS idx_sessions_project;
      DROP INDEX IF EXISTS idx_sessions_worktree;
      DROP INDEX IF EXISTS idx_worktrees_project;
      DROP TABLE IF EXISTS settings;
      DROP TABLE IF EXISTS session_messages;
      DROP TABLE IF EXISTS sessions;
      DROP TABLE IF EXISTS worktrees;
      DROP TABLE IF EXISTS projects;
    `
  },
  {
    version: 2,
    name: 'add_session_mode',
    up: `ALTER TABLE sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'build';`,
    down: `-- SQLite does not support DROP COLUMN; recreate table if needed`
  },
  {
    version: 3,
    name: 'add_project_language',
    up: `ALTER TABLE projects ADD COLUMN language TEXT;`,
    down: `-- SQLite does not support DROP COLUMN; recreate table if needed`
  },
  {
    version: 4,
    name: 'add_project_scripts_and_default_worktree',
    up: `
      ALTER TABLE projects ADD COLUMN setup_script TEXT DEFAULT NULL;
      ALTER TABLE projects ADD COLUMN run_script TEXT DEFAULT NULL;
      ALTER TABLE projects ADD COLUMN archive_script TEXT DEFAULT NULL;
      ALTER TABLE worktrees ADD COLUMN is_default INTEGER DEFAULT 0;

      -- Create default worktrees for existing projects that don't have one
      INSERT INTO worktrees (id, project_id, name, branch_name, path, status, is_default, created_at, last_accessed_at)
      SELECT lower(hex(randomblob(4))), p.id, '(no-worktree)', '', p.path, 'active', 1, datetime('now'), datetime('now')
      FROM projects p
      WHERE p.id NOT IN (SELECT project_id FROM worktrees WHERE is_default = 1);
    `,
    down: `-- SQLite does not support DROP COLUMN; recreate table if needed`
  },
  {
    version: 5,
    name: 'add_structured_opencode_message_columns',
    up: `
      ALTER TABLE session_messages ADD COLUMN opencode_message_id TEXT;
      ALTER TABLE session_messages ADD COLUMN opencode_message_json TEXT;
      ALTER TABLE session_messages ADD COLUMN opencode_parts_json TEXT;
      ALTER TABLE session_messages ADD COLUMN opencode_timeline_json TEXT;
      CREATE INDEX IF NOT EXISTS idx_messages_session_opencode
        ON session_messages(session_id, opencode_message_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_session_opencode_unique
        ON session_messages(session_id, opencode_message_id)
        WHERE opencode_message_id IS NOT NULL;
    `,
    down: `-- SQLite does not support DROP COLUMN; recreate table if needed`
  },
  {
    version: 6,
    name: 'add_session_draft_input',
    up: `ALTER TABLE sessions ADD COLUMN draft_input TEXT DEFAULT NULL;`,
    down: `-- SQLite does not support DROP COLUMN; recreate table if needed`
  },
  {
    version: 7,
    name: 'add_worktree_branch_renamed',
    up: `ALTER TABLE worktrees ADD COLUMN branch_renamed INTEGER NOT NULL DEFAULT 0;`,
    down: `-- SQLite does not support DROP COLUMN; recreate table if needed`
  },
  {
    version: 8,
    name: 'add_project_custom_icon',
    up: `ALTER TABLE projects ADD COLUMN custom_icon TEXT DEFAULT NULL;`,
    down: `-- SQLite does not support DROP COLUMN; recreate table if needed`
  }
]

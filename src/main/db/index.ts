export { DatabaseService, getDatabase, closeDatabase } from './database'
export { CURRENT_SCHEMA_VERSION, MIGRATIONS } from './schema'
export type {
  Project,
  ProjectCreate,
  ProjectUpdate,
  Worktree,
  WorktreeCreate,
  WorktreeUpdate,
  Session,
  SessionCreate,
  SessionUpdate,
  SessionMessage,
  SessionMessageCreate,
  Setting,
  SessionSearchOptions,
  SessionWithWorktree
} from './types'

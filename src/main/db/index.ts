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
  SessionMessageUpdate,
  SessionMessageUpsertByOpenCode,
  Setting,
  SessionSearchOptions,
  SessionWithWorktree,
  Space,
  SpaceCreate,
  SpaceUpdate,
  ProjectSpaceAssignment
} from './types'

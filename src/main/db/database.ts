import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { randomUUID } from 'crypto'
import { MIGRATIONS } from './schema'
import type {
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
  ProjectSpaceAssignment,
  Connection,
  ConnectionCreate,
  ConnectionMember,
  ConnectionMemberCreate,
  ConnectionWithMembers
} from './types'

export class DatabaseService {
  private db: Database.Database | null = null
  private dbPath: string

  constructor(dbPath?: string) {
    if (dbPath) {
      this.dbPath = dbPath
    } else {
      const hiveDir = join(app.getPath('home'), '.hive')
      if (!existsSync(hiveDir)) {
        mkdirSync(hiveDir, { recursive: true })
      }
      this.dbPath = join(hiveDir, 'hive.db')
    }
  }

  getDbPath(): string {
    return this.dbPath
  }

  init(): void {
    if (this.db) return

    this.db = new Database(this.dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')

    this.runMigrations()
  }

  close(): void {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }

  private getDb(): Database.Database {
    if (!this.db) {
      throw new Error('Database not initialized. Call init() first.')
    }
    return this.db
  }

  // Maps SQLite INTEGER 0/1 to boolean for worktree rows
  private mapWorktreeRow(row: Record<string, unknown>): Worktree {
    return {
      ...row,
      is_default: !!row.is_default,
      branch_renamed: (row.branch_renamed as number) ?? 0,
      last_message_at: (row.last_message_at as number) ?? null,
      session_titles: (row.session_titles as string) ?? '[]',
      last_model_provider_id: (row.last_model_provider_id as string) ?? null,
      last_model_id: (row.last_model_id as string) ?? null,
      last_model_variant: (row.last_model_variant as string) ?? null
    } as Worktree
  }

  private runMigrations(): void {
    const db = this.getDb()

    // Ensure settings table exists for version tracking
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `)

    const currentVersion = this.getSetting('schema_version')
    const version = currentVersion ? parseInt(currentVersion, 10) : 0

    for (const migration of MIGRATIONS) {
      if (migration.version > version) {
        db.exec(migration.up)
        this.setSetting('schema_version', migration.version.toString())
      }
    }

    // Post-migration repair: ensure v2 tables exist even if version was already set.
    // This handles the case where another worktree's build set the version without
    // the tables existing (e.g. different code at that version).
    this.ensureConnectionTables()
  }

  /**
   * Idempotently ensure connection-related tables and columns exist.
   * Safe to run multiple times -- uses IF NOT EXISTS and checks column presence.
   */
  private ensureConnectionTables(): void {
    const db = this.getDb()

    db.exec(`
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
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
    `)

    // Add connection_id to sessions if it doesn't exist yet
    const columns = db.pragma('table_info(sessions)') as { name: string }[]
    const hasConnectionId = columns.some((c) => c.name === 'connection_id')
    if (!hasConnectionId) {
      db.exec(`
        ALTER TABLE sessions ADD COLUMN connection_id TEXT DEFAULT NULL
          REFERENCES connections(id) ON DELETE SET NULL;
      `)
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_connection ON sessions(connection_id);
    `)
  }

  // Settings operations
  getSetting(key: string): string | null {
    const db = this.getDb()
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | Setting
      | undefined
    return row?.value ?? null
  }

  setSetting(key: string, value: string): void {
    const db = this.getDb()
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
  }

  deleteSetting(key: string): void {
    const db = this.getDb()
    db.prepare('DELETE FROM settings WHERE key = ?').run(key)
  }

  getAllSettings(): Setting[] {
    const db = this.getDb()
    return db.prepare('SELECT key, value FROM settings').all() as Setting[]
  }

  // Project operations
  createProject(data: ProjectCreate): Project {
    const db = this.getDb()
    const now = new Date().toISOString()
    // New projects get sort_order 0 (top), bump all others down
    db.prepare('UPDATE projects SET sort_order = sort_order + 1').run()

    const project: Project = {
      id: randomUUID(),
      name: data.name,
      path: data.path,
      description: data.description ?? null,
      tags: data.tags ? JSON.stringify(data.tags) : null,
      language: null,
      custom_icon: null,
      setup_script: data.setup_script ?? null,
      run_script: data.run_script ?? null,
      archive_script: data.archive_script ?? null,
      auto_assign_port: false,
      sort_order: 0,
      created_at: now,
      last_accessed_at: now
    }

    db.prepare(
      `INSERT INTO projects (id, name, path, description, tags, language, setup_script, run_script, archive_script, auto_assign_port, sort_order, created_at, last_accessed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      project.id,
      project.name,
      project.path,
      project.description,
      project.tags,
      project.language,
      project.setup_script,
      project.run_script,
      project.archive_script,
      project.auto_assign_port ? 1 : 0,
      project.sort_order,
      project.created_at,
      project.last_accessed_at
    )

    return project
  }

  getProject(id: string): Project | null {
    const db = this.getDb()
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
      | (Project & { auto_assign_port: number | boolean })
      | undefined
    if (!row) return null
    return {
      ...row,
      auto_assign_port: Boolean(row.auto_assign_port)
    }
  }

  getProjectByPath(path: string): Project | null {
    const db = this.getDb()
    const row = db.prepare('SELECT * FROM projects WHERE path = ?').get(path) as
      | (Project & { auto_assign_port: number | boolean })
      | undefined
    if (!row) return null
    return {
      ...row,
      auto_assign_port: Boolean(row.auto_assign_port)
    }
  }

  getAllProjects(): Project[] {
    const db = this.getDb()
    const rows = db
      .prepare('SELECT * FROM projects ORDER BY sort_order ASC, last_accessed_at DESC')
      .all() as Array<Project & { auto_assign_port: number | boolean }>

    return rows.map((row) => ({
      ...row,
      auto_assign_port: Boolean(row.auto_assign_port)
    }))
  }

  reorderProjects(orderedIds: string[]): void {
    const db = this.getDb()
    const stmt = db.prepare('UPDATE projects SET sort_order = ? WHERE id = ?')
    const tx = db.transaction(() => {
      for (let i = 0; i < orderedIds.length; i++) {
        stmt.run(i, orderedIds[i])
      }
    })
    tx()
  }

  updateProject(id: string, data: ProjectUpdate): Project | null {
    const db = this.getDb()
    const existing = this.getProject(id)
    if (!existing) return null

    const updates: string[] = []
    const values: (string | number | null)[] = []

    if (data.name !== undefined) {
      updates.push('name = ?')
      values.push(data.name)
    }
    if (data.description !== undefined) {
      updates.push('description = ?')
      values.push(data.description)
    }
    if (data.tags !== undefined) {
      updates.push('tags = ?')
      values.push(data.tags ? JSON.stringify(data.tags) : null)
    }
    if (data.language !== undefined) {
      updates.push('language = ?')
      values.push(data.language)
    }
    if (data.custom_icon !== undefined) {
      updates.push('custom_icon = ?')
      values.push(data.custom_icon)
    }
    if (data.setup_script !== undefined) {
      updates.push('setup_script = ?')
      values.push(data.setup_script)
    }
    if (data.run_script !== undefined) {
      updates.push('run_script = ?')
      values.push(data.run_script)
    }
    if (data.archive_script !== undefined) {
      updates.push('archive_script = ?')
      values.push(data.archive_script)
    }
    if (data.auto_assign_port !== undefined) {
      updates.push('auto_assign_port = ?')
      values.push(data.auto_assign_port ? 1 : 0)
    }
    if (data.last_accessed_at !== undefined) {
      updates.push('last_accessed_at = ?')
      values.push(data.last_accessed_at)
    }

    if (updates.length === 0) return existing

    values.push(id)
    db.prepare(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`).run(...values)

    return this.getProject(id)
  }

  deleteProject(id: string): boolean {
    const db = this.getDb()
    const result = db.prepare('DELETE FROM projects WHERE id = ?').run(id)
    return result.changes > 0
  }

  touchProject(id: string): void {
    const db = this.getDb()
    const now = new Date().toISOString()
    db.prepare('UPDATE projects SET last_accessed_at = ? WHERE id = ?').run(now, id)
  }

  // Worktree operations
  createWorktree(data: WorktreeCreate): Worktree {
    const db = this.getDb()
    const now = new Date().toISOString()
    const isDefault = data.is_default ?? false
    const worktree: Worktree = {
      id: randomUUID(),
      project_id: data.project_id,
      name: data.name,
      branch_name: data.branch_name,
      path: data.path,
      status: 'active',
      is_default: isDefault,
      branch_renamed: 0,
      last_message_at: null,
      session_titles: '[]',
      last_model_provider_id: null,
      last_model_id: null,
      last_model_variant: null,
      created_at: now,
      last_accessed_at: now
    }

    db.prepare(
      `INSERT INTO worktrees (id, project_id, name, branch_name, path, status, is_default, branch_renamed, created_at, last_accessed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      worktree.id,
      worktree.project_id,
      worktree.name,
      worktree.branch_name,
      worktree.path,
      worktree.status,
      isDefault ? 1 : 0,
      worktree.branch_renamed,
      worktree.created_at,
      worktree.last_accessed_at
    )

    return worktree
  }

  getWorktree(id: string): Worktree | null {
    const db = this.getDb()
    const row = db.prepare('SELECT * FROM worktrees WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? this.mapWorktreeRow(row) : null
  }

  getWorktreesByProject(projectId: string): Worktree[] {
    const db = this.getDb()
    const rows = db
      .prepare(
        'SELECT * FROM worktrees WHERE project_id = ? ORDER BY is_default ASC, last_accessed_at DESC'
      )
      .all(projectId) as Record<string, unknown>[]
    return rows.map((row) => this.mapWorktreeRow(row))
  }

  getActiveWorktreesByProject(projectId: string): Worktree[] {
    const db = this.getDb()
    const rows = db
      .prepare(
        "SELECT * FROM worktrees WHERE project_id = ? AND status = 'active' ORDER BY is_default ASC, last_accessed_at DESC"
      )
      .all(projectId) as Record<string, unknown>[]
    return rows.map((row) => this.mapWorktreeRow(row))
  }

  updateWorktree(id: string, data: WorktreeUpdate): Worktree | null {
    const db = this.getDb()
    const existing = this.getWorktree(id)
    if (!existing) return null

    const updates: string[] = []
    const values: (string | number | null)[] = []

    if (data.name !== undefined) {
      updates.push('name = ?')
      values.push(data.name)
    }
    if (data.branch_name !== undefined) {
      updates.push('branch_name = ?')
      values.push(data.branch_name)
    }
    if (data.status !== undefined) {
      updates.push('status = ?')
      values.push(data.status)
    }
    if (data.branch_renamed !== undefined) {
      updates.push('branch_renamed = ?')
      values.push(data.branch_renamed)
    }
    if (data.last_message_at !== undefined) {
      updates.push('last_message_at = ?')
      values.push(data.last_message_at)
    }
    if (data.last_accessed_at !== undefined) {
      updates.push('last_accessed_at = ?')
      values.push(data.last_accessed_at)
    }

    if (updates.length === 0) return existing

    values.push(id)
    db.prepare(`UPDATE worktrees SET ${updates.join(', ')} WHERE id = ?`).run(...values)

    return this.getWorktree(id)
  }

  deleteWorktree(id: string): boolean {
    const db = this.getDb()
    const result = db.prepare('DELETE FROM worktrees WHERE id = ?').run(id)
    return result.changes > 0
  }

  archiveWorktree(id: string): Worktree | null {
    return this.updateWorktree(id, { status: 'archived' })
  }

  touchWorktree(id: string): void {
    const db = this.getDb()
    const now = new Date().toISOString()
    db.prepare('UPDATE worktrees SET last_accessed_at = ? WHERE id = ?').run(now, id)
  }

  /**
   * Append a session title to the worktree's session_titles JSON array.
   * Skips duplicates.
   */
  appendSessionTitle(worktreeId: string, title: string): void {
    const db = this.getDb()
    const row = db.prepare('SELECT session_titles FROM worktrees WHERE id = ?').get(worktreeId) as
      | Record<string, unknown>
      | undefined
    const titles: string[] = JSON.parse((row?.session_titles as string) || '[]')
    if (!titles.includes(title)) {
      titles.push(title)
      db.prepare('UPDATE worktrees SET session_titles = ? WHERE id = ?').run(
        JSON.stringify(titles),
        worktreeId
      )
    }
  }

  /**
   * Update the last-used model for a worktree.
   */
  updateWorktreeModel(
    worktreeId: string,
    modelProviderId: string,
    modelId: string,
    modelVariant: string | null
  ): void {
    const db = this.getDb()
    db.prepare(
      `UPDATE worktrees
       SET last_model_provider_id = ?, last_model_id = ?, last_model_variant = ?
       WHERE id = ?`
    ).run(modelProviderId, modelId, modelVariant, worktreeId)
  }

  /**
   * Look up the worktree that owns a given session.
   */
  getWorktreeBySessionId(sessionId: string): Worktree | null {
    const session = this.getSession(sessionId)
    if (!session?.worktree_id) return null
    return this.getWorktree(session.worktree_id)
  }

  // Session operations
  createSession(data: SessionCreate): Session {
    const db = this.getDb()
    const now = new Date().toISOString()
    const session: Session = {
      id: randomUUID(),
      worktree_id: data.worktree_id,
      project_id: data.project_id,
      connection_id: data.connection_id ?? null,
      name: data.name ?? null,
      status: 'active',
      opencode_session_id: data.opencode_session_id ?? null,
      mode: 'build',
      model_provider_id: data.model_provider_id ?? null,
      model_id: data.model_id ?? null,
      model_variant: data.model_variant ?? null,
      created_at: now,
      updated_at: now,
      completed_at: null
    }

    db.prepare(
      `INSERT INTO sessions (id, worktree_id, project_id, connection_id, name, status, opencode_session_id, mode, model_provider_id, model_id, model_variant, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      session.id,
      session.worktree_id,
      session.project_id,
      session.connection_id,
      session.name,
      session.status,
      session.opencode_session_id,
      session.mode,
      session.model_provider_id,
      session.model_id,
      session.model_variant,
      session.created_at,
      session.updated_at,
      session.completed_at
    )

    return session
  }

  getSession(id: string): Session | null {
    const db = this.getDb()
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session | undefined
    return row ?? null
  }

  getSessionsByWorktree(worktreeId: string): Session[] {
    const db = this.getDb()
    return db
      .prepare('SELECT * FROM sessions WHERE worktree_id = ? ORDER BY updated_at DESC')
      .all(worktreeId) as Session[]
  }

  getSessionsByProject(projectId: string): Session[] {
    const db = this.getDb()
    return db
      .prepare('SELECT * FROM sessions WHERE project_id = ? ORDER BY updated_at DESC')
      .all(projectId) as Session[]
  }

  getActiveSessionsByWorktree(worktreeId: string): Session[] {
    const db = this.getDb()
    return db
      .prepare(
        "SELECT * FROM sessions WHERE worktree_id = ? AND status = 'active' ORDER BY updated_at DESC"
      )
      .all(worktreeId) as Session[]
  }

  updateSession(id: string, data: SessionUpdate): Session | null {
    const db = this.getDb()
    const existing = this.getSession(id)
    if (!existing) return null

    const updates: string[] = ['updated_at = ?']
    const values: (string | null)[] = [new Date().toISOString()]

    if (data.name !== undefined) {
      updates.push('name = ?')
      values.push(data.name)
    }
    if (data.status !== undefined) {
      updates.push('status = ?')
      values.push(data.status)
    }
    if (data.opencode_session_id !== undefined) {
      updates.push('opencode_session_id = ?')
      values.push(data.opencode_session_id)
    }
    if (data.mode !== undefined) {
      updates.push('mode = ?')
      values.push(data.mode)
    }
    if (data.model_provider_id !== undefined) {
      updates.push('model_provider_id = ?')
      values.push(data.model_provider_id)
    }
    if (data.model_id !== undefined) {
      updates.push('model_id = ?')
      values.push(data.model_id)
    }
    if (data.model_variant !== undefined) {
      updates.push('model_variant = ?')
      values.push(data.model_variant)
    }
    if (data.completed_at !== undefined) {
      updates.push('completed_at = ?')
      values.push(data.completed_at)
    }

    values.push(id)
    db.prepare(`UPDATE sessions SET ${updates.join(', ')} WHERE id = ?`).run(...values)

    return this.getSession(id)
  }

  deleteSession(id: string): boolean {
    const db = this.getDb()
    const result = db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    return result.changes > 0
  }

  searchSessions(options: SessionSearchOptions): SessionWithWorktree[] {
    const db = this.getDb()
    const conditions: string[] = []
    const values: (string | null)[] = []

    let query = `
      SELECT
        s.*,
        w.name as worktree_name,
        w.branch_name as worktree_branch_name,
        p.name as project_name
      FROM sessions s
      LEFT JOIN worktrees w ON s.worktree_id = w.id
      LEFT JOIN projects p ON s.project_id = p.id
    `

    if (options.keyword) {
      conditions.push(`(
        s.name LIKE ? OR
        p.name LIKE ? OR
        w.name LIKE ? OR
        w.branch_name LIKE ?
      )`)
      const keyword = `%${options.keyword}%`
      values.push(keyword, keyword, keyword, keyword)
    }

    if (options.project_id) {
      conditions.push('s.project_id = ?')
      values.push(options.project_id)
    }

    if (options.worktree_id) {
      conditions.push('s.worktree_id = ?')
      values.push(options.worktree_id)
    }

    if (options.dateFrom) {
      conditions.push('s.created_at >= ?')
      values.push(options.dateFrom)
    }

    if (options.dateTo) {
      conditions.push('s.created_at <= ?')
      values.push(options.dateTo)
    }

    if (!options.includeArchived) {
      conditions.push("(w.status = 'active' OR w.id IS NULL)")
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ')
    }

    query += ' ORDER BY s.updated_at DESC'

    return db.prepare(query).all(...values) as SessionWithWorktree[]
  }

  // Session draft operations
  getSessionDraft(sessionId: string): string | null {
    const db = this.getDb()
    const row = db.prepare('SELECT draft_input FROM sessions WHERE id = ?').get(sessionId) as
      | { draft_input: string | null }
      | undefined
    return row?.draft_input ?? null
  }

  updateSessionDraft(sessionId: string, draft: string | null): void {
    const db = this.getDb()
    db.prepare('UPDATE sessions SET draft_input = ? WHERE id = ?').run(draft, sessionId)
  }

  // Session message operations
  createSessionMessage(data: SessionMessageCreate): SessionMessage {
    const db = this.getDb()
    const now = data.created_at ?? new Date().toISOString()
    const message: SessionMessage = {
      id: randomUUID(),
      session_id: data.session_id,
      role: data.role,
      content: data.content,
      opencode_message_id: data.opencode_message_id ?? null,
      opencode_message_json: data.opencode_message_json ?? null,
      opencode_parts_json: data.opencode_parts_json ?? null,
      opencode_timeline_json: data.opencode_timeline_json ?? null,
      created_at: now
    }

    db.prepare(
      `INSERT INTO session_messages (
        id,
        session_id,
        role,
        content,
        opencode_message_id,
        opencode_message_json,
        opencode_parts_json,
        opencode_timeline_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      message.id,
      message.session_id,
      message.role,
      message.content,
      message.opencode_message_id,
      message.opencode_message_json,
      message.opencode_parts_json,
      message.opencode_timeline_json,
      message.created_at
    )

    // Update session updated_at
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, data.session_id)

    return message
  }

  updateSessionMessage(id: string, data: SessionMessageUpdate): SessionMessage | null {
    const db = this.getDb()
    const existing = db.prepare('SELECT * FROM session_messages WHERE id = ?').get(id) as
      | SessionMessage
      | undefined
    if (!existing) return null

    const updates: string[] = []
    const values: (string | null)[] = []

    if (data.content !== undefined) {
      updates.push('content = ?')
      values.push(data.content)
    }
    if (data.opencode_message_json !== undefined) {
      updates.push('opencode_message_json = ?')
      values.push(data.opencode_message_json)
    }
    if (data.opencode_parts_json !== undefined) {
      updates.push('opencode_parts_json = ?')
      values.push(data.opencode_parts_json)
    }
    if (data.opencode_timeline_json !== undefined) {
      updates.push('opencode_timeline_json = ?')
      values.push(data.opencode_timeline_json)
    }

    if (updates.length === 0) return existing

    values.push(id)
    db.prepare(`UPDATE session_messages SET ${updates.join(', ')} WHERE id = ?`).run(...values)

    const updated = db.prepare('SELECT * FROM session_messages WHERE id = ?').get(id) as
      | SessionMessage
      | undefined
    if (!updated) return null

    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(
      new Date().toISOString(),
      updated.session_id
    )

    return updated
  }

  getSessionMessageByOpenCodeId(
    sessionId: string,
    opencodeMessageId: string
  ): SessionMessage | null {
    const db = this.getDb()
    const row = db
      .prepare(
        `SELECT * FROM session_messages
         WHERE session_id = ? AND opencode_message_id = ?
         ORDER BY created_at ASC
         LIMIT 1`
      )
      .get(sessionId, opencodeMessageId) as SessionMessage | undefined
    return row ?? null
  }

  upsertSessionMessageByOpenCodeId(data: SessionMessageUpsertByOpenCode): SessionMessage {
    const existing = this.getSessionMessageByOpenCodeId(data.session_id, data.opencode_message_id)
    if (existing) {
      const updated = this.updateSessionMessage(existing.id, {
        content: data.content,
        opencode_message_json: data.opencode_message_json ?? existing.opencode_message_json,
        opencode_parts_json: data.opencode_parts_json ?? existing.opencode_parts_json,
        opencode_timeline_json: data.opencode_timeline_json ?? existing.opencode_timeline_json
      })
      if (!updated) return existing
      return updated
    }

    return this.createSessionMessage({
      session_id: data.session_id,
      role: data.role,
      content: data.content,
      opencode_message_id: data.opencode_message_id,
      opencode_message_json: data.opencode_message_json ?? null,
      opencode_parts_json: data.opencode_parts_json ?? null,
      opencode_timeline_json: data.opencode_timeline_json ?? null,
      created_at: data.created_at
    })
  }

  getSessionMessages(sessionId: string): SessionMessage[] {
    const db = this.getDb()
    return db
      .prepare('SELECT * FROM session_messages WHERE session_id = ? ORDER BY created_at ASC')
      .all(sessionId) as SessionMessage[]
  }

  deleteSessionMessage(id: string): boolean {
    const db = this.getDb()
    const result = db.prepare('DELETE FROM session_messages WHERE id = ?').run(id)
    return result.changes > 0
  }

  // Connection operations
  createConnection(data: ConnectionCreate): Connection {
    const db = this.getDb()
    const now = new Date().toISOString()
    const connection: Connection = {
      id: randomUUID(),
      name: data.name,
      path: data.path,
      status: 'active',
      created_at: now,
      updated_at: now
    }

    db.prepare(
      `INSERT INTO connections (id, name, path, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      connection.id,
      connection.name,
      connection.path,
      connection.status,
      connection.created_at,
      connection.updated_at
    )

    return connection
  }

  getConnection(id: string): ConnectionWithMembers | null {
    const db = this.getDb()
    const row = db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as
      | Connection
      | undefined
    if (!row) return null

    const members = db
      .prepare(
        `SELECT cm.*, w.name as worktree_name, w.branch_name as worktree_branch,
                w.path as worktree_path, p.name as project_name
         FROM connection_members cm
         JOIN worktrees w ON cm.worktree_id = w.id
         JOIN projects p ON cm.project_id = p.id
         WHERE cm.connection_id = ?
         ORDER BY cm.added_at ASC`
      )
      .all(id) as ConnectionWithMembers['members']

    return { ...row, members }
  }

  getAllConnections(): ConnectionWithMembers[] {
    const db = this.getDb()
    const rows = db
      .prepare("SELECT * FROM connections WHERE status = 'active' ORDER BY updated_at DESC")
      .all() as Connection[]

    return rows.map((row) => {
      const members = db
        .prepare(
          `SELECT cm.*, w.name as worktree_name, w.branch_name as worktree_branch,
                  w.path as worktree_path, p.name as project_name
           FROM connection_members cm
           JOIN worktrees w ON cm.worktree_id = w.id
           JOIN projects p ON cm.project_id = p.id
           WHERE cm.connection_id = ?
           ORDER BY cm.added_at ASC`
        )
        .all(row.id) as ConnectionWithMembers['members']
      return { ...row, members }
    })
  }

  updateConnection(id: string, data: Partial<Connection>): Connection | null {
    const db = this.getDb()
    const existing = db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as
      | Connection
      | undefined
    if (!existing) return null

    const updates: string[] = ['updated_at = ?']
    const values: (string | null)[] = [new Date().toISOString()]

    if (data.name !== undefined) {
      updates.push('name = ?')
      values.push(data.name)
    }
    if (data.path !== undefined) {
      updates.push('path = ?')
      values.push(data.path)
    }
    if (data.status !== undefined) {
      updates.push('status = ?')
      values.push(data.status)
    }

    values.push(id)
    db.prepare(`UPDATE connections SET ${updates.join(', ')} WHERE id = ?`).run(...values)

    return db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as Connection
  }

  deleteConnection(id: string): boolean {
    const db = this.getDb()
    const result = db.prepare('DELETE FROM connections WHERE id = ?').run(id)
    return result.changes > 0
  }

  createConnectionMember(data: ConnectionMemberCreate): ConnectionMember {
    const db = this.getDb()
    const now = new Date().toISOString()
    const member: ConnectionMember = {
      id: randomUUID(),
      connection_id: data.connection_id,
      worktree_id: data.worktree_id,
      project_id: data.project_id,
      symlink_name: data.symlink_name,
      added_at: now
    }

    db.prepare(
      `INSERT INTO connection_members (id, connection_id, worktree_id, project_id, symlink_name, added_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      member.id,
      member.connection_id,
      member.worktree_id,
      member.project_id,
      member.symlink_name,
      member.added_at
    )

    return member
  }

  deleteConnectionMember(connectionId: string, worktreeId: string): boolean {
    const db = this.getDb()
    const result = db
      .prepare('DELETE FROM connection_members WHERE connection_id = ? AND worktree_id = ?')
      .run(connectionId, worktreeId)
    return result.changes > 0
  }

  getConnectionMembersByWorktree(worktreeId: string): ConnectionMember[] {
    const db = this.getDb()
    return db
      .prepare('SELECT * FROM connection_members WHERE worktree_id = ?')
      .all(worktreeId) as ConnectionMember[]
  }

  getActiveSessionsByConnection(connectionId: string): Session[] {
    const db = this.getDb()
    return db
      .prepare(
        "SELECT * FROM sessions WHERE connection_id = ? AND status = 'active' ORDER BY updated_at DESC"
      )
      .all(connectionId) as Session[]
  }

  getSessionsByConnection(connectionId: string): Session[] {
    const db = this.getDb()
    return db
      .prepare('SELECT * FROM sessions WHERE connection_id = ? ORDER BY updated_at DESC')
      .all(connectionId) as Session[]
  }

  // Space operations
  createSpace(data: SpaceCreate): Space {
    const db = this.getDb()
    const now = new Date().toISOString()

    // New spaces get sort_order at the end
    const maxOrder = db
      .prepare('SELECT COALESCE(MAX(sort_order), -1) as max_order FROM spaces')
      .get() as { max_order: number }

    const space: Space = {
      id: randomUUID(),
      name: data.name,
      icon_type: data.icon_type ?? 'default',
      icon_value: data.icon_value ?? 'Folder',
      sort_order: maxOrder.max_order + 1,
      created_at: now
    }

    db.prepare(
      `INSERT INTO spaces (id, name, icon_type, icon_value, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      space.id,
      space.name,
      space.icon_type,
      space.icon_value,
      space.sort_order,
      space.created_at
    )

    return space
  }

  getSpace(id: string): Space | null {
    const db = this.getDb()
    const row = db.prepare('SELECT * FROM spaces WHERE id = ?').get(id) as Space | undefined
    return row ?? null
  }

  listSpaces(): Space[] {
    const db = this.getDb()
    return db.prepare('SELECT * FROM spaces ORDER BY sort_order ASC').all() as Space[]
  }

  updateSpace(id: string, data: SpaceUpdate): Space | null {
    const db = this.getDb()
    const existing = this.getSpace(id)
    if (!existing) return null

    const updates: string[] = []
    const values: (string | number)[] = []

    if (data.name !== undefined) {
      updates.push('name = ?')
      values.push(data.name)
    }
    if (data.icon_type !== undefined) {
      updates.push('icon_type = ?')
      values.push(data.icon_type)
    }
    if (data.icon_value !== undefined) {
      updates.push('icon_value = ?')
      values.push(data.icon_value)
    }
    if (data.sort_order !== undefined) {
      updates.push('sort_order = ?')
      values.push(data.sort_order)
    }

    if (updates.length === 0) return existing

    values.push(id)
    db.prepare(`UPDATE spaces SET ${updates.join(', ')} WHERE id = ?`).run(...values)

    return this.getSpace(id)
  }

  deleteSpace(id: string): boolean {
    const db = this.getDb()
    const result = db.prepare('DELETE FROM spaces WHERE id = ?').run(id)
    return result.changes > 0
  }

  reorderSpaces(orderedIds: string[]): void {
    const db = this.getDb()
    const stmt = db.prepare('UPDATE spaces SET sort_order = ? WHERE id = ?')
    const tx = db.transaction(() => {
      for (let i = 0; i < orderedIds.length; i++) {
        stmt.run(i, orderedIds[i])
      }
    })
    tx()
  }

  // Project-Space assignment operations
  assignProjectToSpace(projectId: string, spaceId: string): void {
    const db = this.getDb()
    db.prepare('INSERT OR IGNORE INTO project_spaces (project_id, space_id) VALUES (?, ?)').run(
      projectId,
      spaceId
    )
  }

  removeProjectFromSpace(projectId: string, spaceId: string): void {
    const db = this.getDb()
    db.prepare('DELETE FROM project_spaces WHERE project_id = ? AND space_id = ?').run(
      projectId,
      spaceId
    )
  }

  getProjectIdsForSpace(spaceId: string): string[] {
    const db = this.getDb()
    const rows = db
      .prepare('SELECT project_id FROM project_spaces WHERE space_id = ?')
      .all(spaceId) as { project_id: string }[]
    return rows.map((r) => r.project_id)
  }

  getAllProjectSpaceAssignments(): ProjectSpaceAssignment[] {
    const db = this.getDb()
    return db
      .prepare('SELECT project_id, space_id FROM project_spaces')
      .all() as ProjectSpaceAssignment[]
  }

  // Utility methods
  getSchemaVersion(): number {
    const version = this.getSetting('schema_version')
    return version ? parseInt(version, 10) : 0
  }

  // Check if tables exist
  tableExists(tableName: string): boolean {
    const db = this.getDb()
    const result = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(tableName) as { name: string } | undefined
    return !!result
  }

  // Get all indexes
  getIndexes(): { name: string; tbl_name: string }[] {
    const db = this.getDb()
    return db
      .prepare(
        "SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'"
      )
      .all() as { name: string; tbl_name: string }[]
  }

  // Transaction wrapper
  transaction<T>(fn: () => T): T {
    const db = this.getDb()
    return db.transaction(fn)()
  }
}

// Singleton instance
let dbService: DatabaseService | null = null

export function getDatabase(): DatabaseService {
  if (!dbService) {
    dbService = new DatabaseService()
    dbService.init()
  }
  return dbService
}

export function closeDatabase(): void {
  if (dbService) {
    dbService.close()
    dbService = null
  }
}

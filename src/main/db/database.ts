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
  Setting,
  SessionSearchOptions,
  SessionWithWorktree
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
    const project: Project = {
      id: randomUUID(),
      name: data.name,
      path: data.path,
      description: data.description ?? null,
      tags: data.tags ? JSON.stringify(data.tags) : null,
      created_at: now,
      last_accessed_at: now
    }

    db.prepare(
      `INSERT INTO projects (id, name, path, description, tags, created_at, last_accessed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      project.id,
      project.name,
      project.path,
      project.description,
      project.tags,
      project.created_at,
      project.last_accessed_at
    )

    return project
  }

  getProject(id: string): Project | null {
    const db = this.getDb()
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined
    return row ?? null
  }

  getProjectByPath(path: string): Project | null {
    const db = this.getDb()
    const row = db.prepare('SELECT * FROM projects WHERE path = ?').get(path) as Project | undefined
    return row ?? null
  }

  getAllProjects(): Project[] {
    const db = this.getDb()
    return db.prepare('SELECT * FROM projects ORDER BY last_accessed_at DESC').all() as Project[]
  }

  updateProject(id: string, data: ProjectUpdate): Project | null {
    const db = this.getDb()
    const existing = this.getProject(id)
    if (!existing) return null

    const updates: string[] = []
    const values: (string | null)[] = []

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
    const worktree: Worktree = {
      id: randomUUID(),
      project_id: data.project_id,
      name: data.name,
      branch_name: data.branch_name,
      path: data.path,
      status: 'active',
      created_at: now,
      last_accessed_at: now
    }

    db.prepare(
      `INSERT INTO worktrees (id, project_id, name, branch_name, path, status, created_at, last_accessed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      worktree.id,
      worktree.project_id,
      worktree.name,
      worktree.branch_name,
      worktree.path,
      worktree.status,
      worktree.created_at,
      worktree.last_accessed_at
    )

    return worktree
  }

  getWorktree(id: string): Worktree | null {
    const db = this.getDb()
    const row = db.prepare('SELECT * FROM worktrees WHERE id = ?').get(id) as Worktree | undefined
    return row ?? null
  }

  getWorktreesByProject(projectId: string): Worktree[] {
    const db = this.getDb()
    return db
      .prepare(
        'SELECT * FROM worktrees WHERE project_id = ? ORDER BY last_accessed_at DESC'
      )
      .all(projectId) as Worktree[]
  }

  getActiveWorktreesByProject(projectId: string): Worktree[] {
    const db = this.getDb()
    return db
      .prepare(
        "SELECT * FROM worktrees WHERE project_id = ? AND status = 'active' ORDER BY last_accessed_at DESC"
      )
      .all(projectId) as Worktree[]
  }

  updateWorktree(id: string, data: WorktreeUpdate): Worktree | null {
    const db = this.getDb()
    const existing = this.getWorktree(id)
    if (!existing) return null

    const updates: string[] = []
    const values: (string | null)[] = []

    if (data.name !== undefined) {
      updates.push('name = ?')
      values.push(data.name)
    }
    if (data.status !== undefined) {
      updates.push('status = ?')
      values.push(data.status)
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

  // Session operations
  createSession(data: SessionCreate): Session {
    const db = this.getDb()
    const now = new Date().toISOString()
    const session: Session = {
      id: randomUUID(),
      worktree_id: data.worktree_id,
      project_id: data.project_id,
      name: data.name ?? null,
      status: 'active',
      opencode_session_id: data.opencode_session_id ?? null,
      created_at: now,
      updated_at: now,
      completed_at: null
    }

    db.prepare(
      `INSERT INTO sessions (id, worktree_id, project_id, name, status, opencode_session_id, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      session.id,
      session.worktree_id,
      session.project_id,
      session.name,
      session.status,
      session.opencode_session_id,
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
        EXISTS (SELECT 1 FROM session_messages m WHERE m.session_id = s.id AND m.content LIKE ?)
      )`)
      const keyword = `%${options.keyword}%`
      values.push(keyword, keyword)
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

  // Session message operations
  createSessionMessage(data: SessionMessageCreate): SessionMessage {
    const db = this.getDb()
    const now = new Date().toISOString()
    const message: SessionMessage = {
      id: randomUUID(),
      session_id: data.session_id,
      role: data.role,
      content: data.content,
      created_at: now
    }

    db.prepare(
      `INSERT INTO session_messages (id, session_id, role, content, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(message.id, message.session_id, message.role, message.content, message.created_at)

    // Update session updated_at
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, data.session_id)

    return message
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
      .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'")
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

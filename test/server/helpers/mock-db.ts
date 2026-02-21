/**
 * In-memory mock of DatabaseService for GraphQL resolver integration tests.
 * Mirrors the public API surface of src/main/db/database.ts using plain arrays.
 */

import { randomUUID } from 'node:crypto'

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Lightweight row types (snake_case, matching real DB output)
// ---------------------------------------------------------------------------

interface ProjectRow {
  id: string
  name: string
  path: string
  description: string | null
  tags: string | null
  language: string | null
  custom_icon: string | null
  setup_script: string | null
  run_script: string | null
  archive_script: string | null
  auto_assign_port: boolean
  sort_order: number
  created_at: string
  last_accessed_at: string
}

interface WorktreeRow {
  id: string
  project_id: string
  name: string
  branch_name: string
  path: string
  status: string
  is_default: boolean
  branch_renamed: number
  last_message_at: number | null
  session_titles: string
  last_model_provider_id: string | null
  last_model_id: string | null
  last_model_variant: string | null
  created_at: string
  last_accessed_at: string
}

interface SessionRow {
  id: string
  worktree_id: string | null
  project_id: string
  connection_id: string | null
  name: string | null
  status: string
  opencode_session_id: string | null
  agent_sdk: string
  mode: string
  model_provider_id: string | null
  model_id: string | null
  model_variant: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
  draft_input?: string | null
}

interface ConnectionRow {
  id: string
  name: string
  custom_name: string | null
  path: string
  color: string | null
  status: string
  created_at: string
  updated_at: string
}

interface ConnectionMemberRow {
  id: string
  connection_id: string
  worktree_id: string
  project_id: string
  symlink_name: string
  added_at: string
}

interface SpaceRow {
  id: string
  name: string
  icon_type: string
  icon_value: string
  sort_order: number
  created_at: string
}

interface SettingRow {
  key: string
  value: string
}

interface SpaceAssignment {
  project_id: string
  space_id: string
}

// ---------------------------------------------------------------------------
// MockDatabaseService
// ---------------------------------------------------------------------------

export class MockDatabaseService {
  projects: ProjectRow[] = []
  worktrees: WorktreeRow[] = []
  sessions: SessionRow[] = []
  spaces: SpaceRow[] = []
  settings: SettingRow[] = []
  spaceAssignments: SpaceAssignment[] = []
  connections: ConnectionRow[] = []
  connectionMembers: ConnectionMemberRow[] = []

  // -- Settings --
  getSetting(key: string): string | null {
    return this.settings.find((s) => s.key === key)?.value ?? null
  }

  setSetting(key: string, value: string): void {
    const idx = this.settings.findIndex((s) => s.key === key)
    if (idx >= 0) {
      this.settings[idx].value = value
    } else {
      this.settings.push({ key, value })
    }
  }

  deleteSetting(key: string): void {
    this.settings = this.settings.filter((s) => s.key !== key)
  }

  getAllSettings(): SettingRow[] {
    return [...this.settings]
  }

  // -- Projects --
  createProject(data: any): ProjectRow {
    // Enforce UNIQUE path constraint (mirrors real SQLite schema)
    if (this.projects.some((p) => p.path === data.path)) {
      throw new Error(`UNIQUE constraint failed: projects.path`)
    }
    const now = new Date().toISOString()
    const project: ProjectRow = {
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
    this.projects.unshift(project)
    return project
  }

  getProject(id: string): ProjectRow | null {
    return this.projects.find((p) => p.id === id) ?? null
  }

  getProjectByPath(path: string): ProjectRow | null {
    return this.projects.find((p) => p.path === path) ?? null
  }

  getAllProjects(): ProjectRow[] {
    return [...this.projects].sort((a, b) => a.sort_order - b.sort_order)
  }

  updateProject(id: string, data: any): ProjectRow | null {
    const project = this.projects.find((p) => p.id === id)
    if (!project) return null
    Object.assign(project, data)
    return project
  }

  deleteProject(id: string): boolean {
    const len = this.projects.length
    this.projects = this.projects.filter((p) => p.id !== id)
    return this.projects.length < len
  }

  touchProject(id: string): void {
    const project = this.projects.find((p) => p.id === id)
    if (project) project.last_accessed_at = new Date().toISOString()
  }

  reorderProjects(orderedIds: string[]): void {
    for (let i = 0; i < orderedIds.length; i++) {
      const p = this.projects.find((p) => p.id === orderedIds[i])
      if (p) p.sort_order = i
    }
  }

  getProjectIdsSortedByLastMessage(): string[] {
    return this.projects.map((p) => p.id)
  }

  // -- Worktrees --
  createWorktree(data: any): WorktreeRow {
    const now = new Date().toISOString()
    const worktree: WorktreeRow = {
      id: randomUUID(),
      project_id: data.project_id,
      name: data.name,
      branch_name: data.branch_name,
      path: data.path,
      status: 'active',
      is_default: data.is_default ?? false,
      branch_renamed: 0,
      last_message_at: null,
      session_titles: '[]',
      last_model_provider_id: null,
      last_model_id: null,
      last_model_variant: null,
      created_at: now,
      last_accessed_at: now
    }
    this.worktrees.push(worktree)
    return worktree
  }

  getWorktree(id: string): WorktreeRow | null {
    return this.worktrees.find((w) => w.id === id) ?? null
  }

  getWorktreesByProject(projectId: string): WorktreeRow[] {
    return this.worktrees.filter((w) => w.project_id === projectId)
  }

  getActiveWorktreesByProject(projectId: string): WorktreeRow[] {
    return this.worktrees.filter(
      (w) => w.project_id === projectId && w.status === 'active'
    )
  }

  updateWorktree(id: string, data: any): WorktreeRow | null {
    const worktree = this.worktrees.find((w) => w.id === id)
    if (!worktree) return null
    Object.assign(worktree, data)
    return worktree
  }

  archiveWorktree(id: string): WorktreeRow | null {
    return this.updateWorktree(id, { status: 'archived' })
  }

  touchWorktree(id: string): void {
    const worktree = this.worktrees.find((w) => w.id === id)
    if (worktree) worktree.last_accessed_at = new Date().toISOString()
  }

  appendSessionTitle(worktreeId: string, title: string): void {
    const worktree = this.worktrees.find((w) => w.id === worktreeId)
    if (!worktree) return
    const titles: string[] = JSON.parse(worktree.session_titles || '[]')
    if (!titles.includes(title)) {
      titles.push(title)
      worktree.session_titles = JSON.stringify(titles)
    }
  }

  updateWorktreeModel(
    worktreeId: string,
    modelProviderId: string,
    modelId: string,
    modelVariant: string | null
  ): void {
    const worktree = this.worktrees.find((w) => w.id === worktreeId)
    if (!worktree) return
    worktree.last_model_provider_id = modelProviderId
    worktree.last_model_id = modelId
    worktree.last_model_variant = modelVariant
  }

  getWorktreeBySessionId(sessionId: string): WorktreeRow | null {
    const session = this.sessions.find((s) => s.id === sessionId)
    if (!session?.worktree_id) return null
    return this.getWorktree(session.worktree_id)
  }

  // -- Sessions --
  createSession(data: any): SessionRow {
    const now = new Date().toISOString()
    const session: SessionRow = {
      id: randomUUID(),
      worktree_id: data.worktree_id ?? null,
      project_id: data.project_id,
      connection_id: data.connection_id ?? null,
      name: data.name ?? null,
      status: 'active',
      opencode_session_id: data.opencode_session_id ?? null,
      agent_sdk: data.agent_sdk ?? 'opencode',
      mode: 'build',
      model_provider_id: data.model_provider_id ?? null,
      model_id: data.model_id ?? null,
      model_variant: data.model_variant ?? null,
      created_at: now,
      updated_at: now,
      completed_at: null,
      draft_input: null
    }
    this.sessions.push(session)
    return session
  }

  getSession(id: string): SessionRow | null {
    return this.sessions.find((s) => s.id === id) ?? null
  }

  getSessionsByWorktree(worktreeId: string): SessionRow[] {
    return this.sessions.filter((s) => s.worktree_id === worktreeId)
  }

  getActiveSessionsByWorktree(worktreeId: string): SessionRow[] {
    return this.sessions.filter(
      (s) => s.worktree_id === worktreeId && s.status === 'active'
    )
  }

  getSessionsByProject(projectId: string): SessionRow[] {
    return this.sessions.filter((s) => s.project_id === projectId)
  }

  getSessionsByConnection(connectionId: string): SessionRow[] {
    return this.sessions.filter((s) => s.connection_id === connectionId)
  }

  getActiveSessionsByConnection(connectionId: string): SessionRow[] {
    return this.sessions.filter(
      (s) => s.connection_id === connectionId && s.status === 'active'
    )
  }

  updateSession(id: string, data: any): SessionRow | null {
    const session = this.sessions.find((s) => s.id === id)
    if (!session) return null
    Object.assign(session, data)
    session.updated_at = new Date().toISOString()
    return session
  }

  deleteSession(id: string): boolean {
    const len = this.sessions.length
    this.sessions = this.sessions.filter((s) => s.id !== id)
    return this.sessions.length < len
  }

  searchSessions(options: any): any[] {
    let results = [...this.sessions]

    if (options.keyword) {
      const kw = options.keyword.toLowerCase()
      results = results.filter((s) => s.name?.toLowerCase().includes(kw))
    }
    if (options.project_id) {
      results = results.filter((s) => s.project_id === options.project_id)
    }
    if (options.worktree_id) {
      results = results.filter((s) => s.worktree_id === options.worktree_id)
    }

    // Add worktree/project names for SessionWithWorktree shape
    return results.map((s) => {
      const worktree = s.worktree_id
        ? this.worktrees.find((w) => w.id === s.worktree_id)
        : null
      const project = this.projects.find((p) => p.id === s.project_id)
      return {
        ...s,
        worktree_name: worktree?.name ?? null,
        worktree_branch_name: worktree?.branch_name ?? null,
        project_name: project?.name ?? null
      }
    })
  }

  getSessionDraft(sessionId: string): string | null {
    const session = this.sessions.find((s) => s.id === sessionId)
    return session?.draft_input ?? null
  }

  updateSessionDraft(sessionId: string, draft: string | null): void {
    const session = this.sessions.find((s) => s.id === sessionId)
    if (session) session.draft_input = draft
  }

  getAgentSdkForSession(agentSessionId: string): string | null {
    const session = this.sessions.find(
      (s) => s.opencode_session_id === agentSessionId
    )
    return session?.agent_sdk ?? null
  }

  // -- Spaces --
  createSpace(data: any): SpaceRow {
    const now = new Date().toISOString()
    const maxOrder = this.spaces.reduce(
      (max, s) => Math.max(max, s.sort_order),
      -1
    )
    const space: SpaceRow = {
      id: randomUUID(),
      name: data.name,
      icon_type: data.icon_type ?? 'default',
      icon_value: data.icon_value ?? 'Folder',
      sort_order: maxOrder + 1,
      created_at: now
    }
    this.spaces.push(space)
    return space
  }

  getSpace(id: string): SpaceRow | null {
    return this.spaces.find((s) => s.id === id) ?? null
  }

  listSpaces(): SpaceRow[] {
    return [...this.spaces].sort((a, b) => a.sort_order - b.sort_order)
  }

  updateSpace(id: string, data: any): SpaceRow | null {
    const space = this.spaces.find((s) => s.id === id)
    if (!space) return null
    Object.assign(space, data)
    return space
  }

  deleteSpace(id: string): boolean {
    const len = this.spaces.length
    this.spaces = this.spaces.filter((s) => s.id !== id)
    this.spaceAssignments = this.spaceAssignments.filter(
      (a) => a.space_id !== id
    )
    return this.spaces.length < len
  }

  reorderSpaces(orderedIds: string[]): void {
    for (let i = 0; i < orderedIds.length; i++) {
      const s = this.spaces.find((s) => s.id === orderedIds[i])
      if (s) s.sort_order = i
    }
  }

  assignProjectToSpace(projectId: string, spaceId: string): void {
    const exists = this.spaceAssignments.some(
      (a) => a.project_id === projectId && a.space_id === spaceId
    )
    if (!exists) {
      this.spaceAssignments.push({ project_id: projectId, space_id: spaceId })
    }
  }

  removeProjectFromSpace(projectId: string, spaceId: string): void {
    this.spaceAssignments = this.spaceAssignments.filter(
      (a) => !(a.project_id === projectId && a.space_id === spaceId)
    )
  }

  getProjectIdsForSpace(spaceId: string): string[] {
    return this.spaceAssignments
      .filter((a) => a.space_id === spaceId)
      .map((a) => a.project_id)
  }

  getAllProjectSpaceAssignments(): SpaceAssignment[] {
    return [...this.spaceAssignments]
  }

  // -- Connections --
  createConnection(data: any): ConnectionRow {
    const now = new Date().toISOString()
    const connection: ConnectionRow = {
      id: randomUUID(),
      name: data.name,
      custom_name: data.custom_name ?? null,
      path: data.path,
      color: data.color ?? null,
      status: 'active',
      created_at: now,
      updated_at: now
    }
    this.connections.push(connection)
    return connection
  }

  getConnection(id: string): (ConnectionRow & { members: any[] }) | null {
    const connection = this.connections.find((c) => c.id === id)
    if (!connection) return null

    const members = this.connectionMembers
      .filter((m) => m.connection_id === id)
      .map((m) => {
        const worktree = this.worktrees.find((w) => w.id === m.worktree_id)
        const project = this.projects.find((p) => p.id === m.project_id)
        return {
          ...m,
          worktree_name: worktree?.name ?? '',
          worktree_branch: worktree?.branch_name ?? '',
          worktree_path: worktree?.path ?? '',
          project_name: project?.name ?? ''
        }
      })

    return { ...connection, members }
  }

  getAllConnections(): (ConnectionRow & { members: any[] })[] {
    return this.connections
      .filter((c) => c.status === 'active')
      .map((c) => {
        const members = this.connectionMembers
          .filter((m) => m.connection_id === c.id)
          .map((m) => {
            const worktree = this.worktrees.find((w) => w.id === m.worktree_id)
            const project = this.projects.find((p) => p.id === m.project_id)
            return {
              ...m,
              worktree_name: worktree?.name ?? '',
              worktree_branch: worktree?.branch_name ?? '',
              worktree_path: worktree?.path ?? '',
              project_name: project?.name ?? ''
            }
          })
        return { ...c, members }
      })
  }

  updateConnection(id: string, data: any): ConnectionRow | null {
    const connection = this.connections.find((c) => c.id === id)
    if (!connection) return null
    Object.assign(connection, data, { updated_at: new Date().toISOString() })
    return connection
  }

  deleteConnection(id: string): boolean {
    const len = this.connections.length
    this.connections = this.connections.filter((c) => c.id !== id)
    this.connectionMembers = this.connectionMembers.filter(
      (m) => m.connection_id !== id
    )
    return this.connections.length < len
  }

  createConnectionMember(data: any): ConnectionMemberRow {
    const now = new Date().toISOString()
    const member: ConnectionMemberRow = {
      id: randomUUID(),
      connection_id: data.connection_id,
      worktree_id: data.worktree_id,
      project_id: data.project_id,
      symlink_name: data.symlink_name,
      added_at: now
    }
    this.connectionMembers.push(member)
    return member
  }

  deleteConnectionMember(connectionId: string, worktreeId: string): boolean {
    const len = this.connectionMembers.length
    this.connectionMembers = this.connectionMembers.filter(
      (m) => !(m.connection_id === connectionId && m.worktree_id === worktreeId)
    )
    return this.connectionMembers.length < len
  }

  getConnectionMembersByWorktree(worktreeId: string): ConnectionMemberRow[] {
    return this.connectionMembers.filter((m) => m.worktree_id === worktreeId)
  }

  // -- Utility --
  getSchemaVersion(): number {
    return 4
  }

  tableExists(_tableName: string): boolean {
    return true
  }

  getIndexes(): { name: string; tbl_name: string }[] {
    return []
  }

  transaction<T>(fn: () => T): T {
    return fn()
  }
}

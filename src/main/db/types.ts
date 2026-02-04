export interface Project {
  id: string
  name: string
  path: string
  description: string | null
  tags: string | null // JSON array
  created_at: string
  last_accessed_at: string
}

export interface ProjectCreate {
  name: string
  path: string
  description?: string | null
  tags?: string[] | null
}

export interface ProjectUpdate {
  name?: string
  description?: string | null
  tags?: string[] | null
  last_accessed_at?: string
}

export interface Worktree {
  id: string
  project_id: string
  name: string
  branch_name: string
  path: string
  status: 'active' | 'archived'
  created_at: string
  last_accessed_at: string
}

export interface WorktreeCreate {
  project_id: string
  name: string
  branch_name: string
  path: string
}

export interface WorktreeUpdate {
  name?: string
  status?: 'active' | 'archived'
  last_accessed_at?: string
}

export interface Session {
  id: string
  worktree_id: string | null
  project_id: string
  name: string | null
  status: 'active' | 'completed' | 'error'
  opencode_session_id: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

export interface SessionCreate {
  worktree_id: string | null
  project_id: string
  name?: string | null
  opencode_session_id?: string | null
}

export interface SessionUpdate {
  name?: string | null
  status?: 'active' | 'completed' | 'error'
  opencode_session_id?: string | null
  updated_at?: string
  completed_at?: string | null
}

export interface SessionMessage {
  id: string
  session_id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  created_at: string
}

export interface SessionMessageCreate {
  session_id: string
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface Setting {
  key: string
  value: string
}

// Database response types for queries
export interface SessionWithWorktree extends Session {
  worktree_name?: string
  worktree_branch_name?: string
  project_name?: string
}

// Search/filter types
export interface SessionSearchOptions {
  keyword?: string
  project_id?: string
  worktree_id?: string
  dateFrom?: string
  dateTo?: string
  includeArchived?: boolean
}

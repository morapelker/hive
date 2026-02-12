export interface Project {
  id: string
  name: string
  path: string
  description: string | null
  tags: string | null // JSON array
  language: string | null
  custom_icon: string | null
  setup_script: string | null
  run_script: string | null
  archive_script: string | null
  sort_order: number
  created_at: string
  last_accessed_at: string
}

export interface ProjectCreate {
  name: string
  path: string
  description?: string | null
  tags?: string[] | null
  setup_script?: string | null
  run_script?: string | null
  archive_script?: string | null
}

export interface ProjectUpdate {
  name?: string
  description?: string | null
  tags?: string[] | null
  language?: string | null
  custom_icon?: string | null
  setup_script?: string | null
  run_script?: string | null
  archive_script?: string | null
  last_accessed_at?: string
}

export interface Worktree {
  id: string
  project_id: string
  name: string
  branch_name: string
  path: string
  status: 'active' | 'archived'
  is_default: boolean
  branch_renamed: number // 0 = auto-named (city), 1 = user/auto renamed
  last_message_at: number | null // epoch ms of last AI message activity
  created_at: string
  last_accessed_at: string
}

export interface WorktreeCreate {
  project_id: string
  name: string
  branch_name: string
  path: string
  is_default?: boolean
}

export interface WorktreeUpdate {
  name?: string
  branch_name?: string
  status?: 'active' | 'archived'
  branch_renamed?: number
  last_message_at?: number | null
  last_accessed_at?: string
}

export type SessionMode = 'build' | 'plan'

export interface Session {
  id: string
  worktree_id: string | null
  project_id: string
  name: string | null
  status: 'active' | 'completed' | 'error'
  opencode_session_id: string | null
  mode: SessionMode
  model_provider_id: string | null
  model_id: string | null
  model_variant: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

export interface SessionCreate {
  worktree_id: string | null
  project_id: string
  name?: string | null
  opencode_session_id?: string | null
  model_provider_id?: string | null
  model_id?: string | null
  model_variant?: string | null
}

export interface SessionUpdate {
  name?: string | null
  status?: 'active' | 'completed' | 'error'
  opencode_session_id?: string | null
  mode?: SessionMode
  model_provider_id?: string | null
  model_id?: string | null
  model_variant?: string | null
  updated_at?: string
  completed_at?: string | null
}

export interface SessionMessage {
  id: string
  session_id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  opencode_message_id: string | null
  opencode_message_json: string | null
  opencode_parts_json: string | null
  opencode_timeline_json: string | null
  created_at: string
}

export interface SessionMessageCreate {
  session_id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  opencode_message_id?: string | null
  opencode_message_json?: string | null
  opencode_parts_json?: string | null
  opencode_timeline_json?: string | null
  created_at?: string
}

export interface SessionMessageUpdate {
  content?: string
  opencode_message_json?: string | null
  opencode_parts_json?: string | null
  opencode_timeline_json?: string | null
}

export interface SessionMessageUpsertByOpenCode {
  session_id: string
  role: 'assistant' | 'user' | 'system'
  opencode_message_id: string
  content: string
  opencode_message_json?: string | null
  opencode_parts_json?: string | null
  opencode_timeline_json?: string | null
  created_at?: string
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

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
  auto_assign_port: boolean
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
  auto_assign_port?: boolean
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
  session_titles: string // JSON array of session title strings
  last_model_provider_id: string | null
  last_model_id: string | null
  last_model_variant: string | null
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
  last_model_provider_id?: string | null
  last_model_id?: string | null
  last_model_variant?: string | null
  last_accessed_at?: string
}

export type SessionMode = 'build' | 'plan'

export interface Session {
  id: string
  worktree_id: string | null
  project_id: string
  connection_id: string | null
  name: string | null
  status: 'active' | 'completed' | 'error'
  opencode_session_id: string | null
  agent_sdk: 'opencode' | 'claude-code'
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
  connection_id?: string | null
  name?: string | null
  opencode_session_id?: string | null
  agent_sdk?: 'opencode' | 'claude-code'
  model_provider_id?: string | null
  model_id?: string | null
  model_variant?: string | null
}

export interface SessionUpdate {
  name?: string | null
  status?: 'active' | 'completed' | 'error'
  opencode_session_id?: string | null
  agent_sdk?: 'opencode' | 'claude-code'
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

export interface Space {
  id: string
  name: string
  icon_type: string
  icon_value: string
  sort_order: number
  created_at: string
}

export interface SpaceCreate {
  name: string
  icon_type?: string
  icon_value?: string
}

export interface SpaceUpdate {
  name?: string
  icon_type?: string
  icon_value?: string
  sort_order?: number
}

export interface ProjectSpaceAssignment {
  project_id: string
  space_id: string
}

// Connection color quad: [inactiveBg, activeBg, inactiveText, activeText] stored as JSON string
export type ConnectionColorQuad = [string, string, string, string]

// Connection types
export interface Connection {
  id: string
  name: string
  custom_name: string | null
  path: string
  color: string | null // JSON-serialised ConnectionColorQuad
  status: 'active' | 'archived'
  created_at: string
  updated_at: string
}

export interface ConnectionCreate {
  name: string
  path: string
  color?: string | null
  custom_name?: string | null
}

export interface ConnectionUpdate {
  name?: string
  custom_name?: string | null
  path?: string
  color?: string | null
  status?: 'active' | 'archived'
}

export interface ConnectionMember {
  id: string
  connection_id: string
  worktree_id: string
  project_id: string
  symlink_name: string
  added_at: string
}

export interface ConnectionMemberCreate {
  connection_id: string
  worktree_id: string
  project_id: string
  symlink_name: string
}

export interface ConnectionWithMembers extends Connection {
  members: (ConnectionMember & {
    worktree_name: string
    worktree_branch: string
    worktree_path: string
    project_name: string
  })[]
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

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
  attachments: string // JSON array of Attachment objects
  pinned: number // 0 = not pinned, 1 = pinned
  context: string | null
  github_pr_number: number | null
  github_pr_url: string | null
  base_branch: string | null
  created_at: string
  last_accessed_at: string
}

export interface WorktreeCreate {
  project_id: string
  name: string
  branch_name: string
  path: string
  is_default?: boolean
  base_branch?: string | null
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
  pinned?: number
  github_pr_number?: number | null
  github_pr_url?: string | null
  last_accessed_at?: string
}

export type SessionMode = 'build' | 'plan' | 'super-plan'

export interface Session {
  id: string
  worktree_id: string | null
  project_id: string
  connection_id: string | null
  name: string | null
  status: 'active' | 'completed' | 'error'
  opencode_session_id: string | null
  agent_sdk: 'opencode' | 'claude-code' | 'codex' | 'terminal'
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
  agent_sdk?: 'opencode' | 'claude-code' | 'codex' | 'terminal'
  mode?: SessionMode
  model_provider_id?: string | null
  model_id?: string | null
  model_variant?: string | null
}

export interface SessionUpdate {
  name?: string | null
  status?: 'active' | 'completed' | 'error'
  opencode_session_id?: string | null
  agent_sdk?: 'opencode' | 'claude-code' | 'codex' | 'terminal'
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

export type SessionActivityKind =
  | 'tool.started'
  | 'tool.updated'
  | 'tool.completed'
  | 'tool.failed'
  | 'approval.requested'
  | 'approval.resolved'
  | 'user-input.requested'
  | 'user-input.resolved'
  | 'task.started'
  | 'task.updated'
  | 'task.completed'
  | 'plan.ready'
  | 'plan.resolved'
  | 'session.error'
  | 'session.retry'
  | 'session.info'

export type SessionActivityTone = 'tool' | 'approval' | 'info' | 'error'

export interface SessionActivity {
  id: string
  session_id: string
  agent_session_id: string | null
  thread_id: string | null
  turn_id: string | null
  item_id: string | null
  request_id: string | null
  kind: SessionActivityKind
  tone: SessionActivityTone
  summary: string
  payload_json: string | null
  sequence: number | null
  created_at: string
}

export interface SessionActivityCreate {
  id?: string
  session_id: string
  agent_session_id?: string | null
  thread_id?: string | null
  turn_id?: string | null
  item_id?: string | null
  request_id?: string | null
  kind: SessionActivityKind
  tone: SessionActivityTone
  summary: string
  payload_json?: string | null
  sequence?: number | null
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
  pinned: number // 0 = not pinned, 1 = pinned
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
  pinned?: number
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

// Kanban ticket types
export type KanbanTicketColumn = 'todo' | 'in_progress' | 'review' | 'done'

export interface KanbanTicket {
  id: string
  project_id: string
  title: string
  description: string | null
  attachments: unknown[] // Parsed JSON array (stored as TEXT in DB)
  column: KanbanTicketColumn
  sort_order: number
  current_session_id: string | null
  worktree_id: string | null
  mode: 'build' | 'plan' | 'super-plan' | null
  plan_ready: boolean // Mapped from INTEGER 0/1 in DB
  created_at: string
  updated_at: string
  archived_at: string | null
  external_provider: string | null
  external_id: string | null
  external_url: string | null
  total_tokens: number
}

export interface KanbanTicketCreate {
  id?: string
  project_id: string
  title: string
  description?: string | null
  attachments?: unknown[]
  column?: KanbanTicketColumn
  sort_order?: number
  current_session_id?: string | null
  worktree_id?: string | null
  mode?: 'build' | 'plan' | 'super-plan' | null
  plan_ready?: boolean
  external_provider?: string | null
  external_id?: string | null
  external_url?: string | null
}

export interface KanbanTicketUpdate {
  title?: string
  description?: string | null
  attachments?: unknown[]
  column?: KanbanTicketColumn
  sort_order?: number
  current_session_id?: string | null
  worktree_id?: string | null
  mode?: 'build' | 'plan' | 'super-plan' | null
  plan_ready?: boolean
}

// Ticket followup message types
export interface TicketFollowupMessage {
  id: string
  ticket_id: string
  content: string
  role: 'user' | 'assistant'
  mode: 'build' | 'plan' | 'super-plan'
  session_id: string | null
  source: 'direct' | 'supercharge' | 'error_retry'
  created_at: string
}

export interface TicketFollowupMessageCreate {
  ticket_id: string
  content: string
  role?: 'user' | 'assistant'
  mode: 'build' | 'plan' | 'super-plan'
  session_id?: string | null
  source?: 'direct' | 'supercharge' | 'error_retry'
}

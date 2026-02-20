export interface Session {
  id: string
  worktree_id: string | null
  project_id: string
  connection_id: string | null
  name: string | null
  status: 'active' | 'completed' | 'error'
  opencode_session_id: string | null
  agent_sdk: 'opencode' | 'claude-code'
  mode: 'build' | 'plan'
  model_provider_id: string | null
  model_id: string | null
  model_variant: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

export interface SessionWithWorktree extends Session {
  worktree_name?: string
  worktree_branch_name?: string
  project_name?: string
}

export interface SessionSearchOptions {
  keyword?: string
  project_id?: string
  worktree_id?: string
  dateFrom?: string
  dateTo?: string
  includeArchived?: boolean
}

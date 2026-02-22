export interface Worktree {
  id: string
  project_id: string
  name: string
  branch_name: string
  path: string
  status: 'active' | 'archived'
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

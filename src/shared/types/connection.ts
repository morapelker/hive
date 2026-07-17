export interface Connection {
  id: string
  name: string
  custom_name: string | null
  status: 'active' | 'archived'
  path: string
  color: string | null
  pinned: number
  created_at: string
  updated_at: string
}

export interface ConnectionMember {
  id: string
  connection_id: string
  worktree_id: string
  project_id: string
  symlink_name: string
  added_at: string
}

export interface ConnectionWithMembers extends Connection {
  members: (ConnectionMember & {
    worktree_name: string
    worktree_branch: string
    worktree_path: string
    project_name: string
  })[]
}

export interface RecentConnectionProject {
  id: string
  name: string
  path: string
}

export interface RecentConnectionEntry {
  id: string
  project_set_key: string
  projects: RecentConnectionProject[]
  last_used_at: string
  use_count: number
  note: string | null
}

export interface Connection {
  id: string
  name: string
  status: 'active' | 'archived'
  path: string
  color: string | null
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

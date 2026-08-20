import type { CustomProjectCommand } from '@shared/lib/custom-commands'

export type ProjectKind = 'git' | 'connection'

export interface Project {
  id: string
  name: string
  path: string
  /** 'git' (default) or 'connection' (a saved connection promoted to a project). */
  kind?: ProjectKind
  /** connection projects only: JSON array of member project ids (creation order). */
  member_project_ids?: string | null
  description: string | null
  tags: string | null
  language: string | null
  custom_icon: string | null
  detected_icon: string | null
  setup_script: string | null
  run_script: string | null
  archive_script: string | null
  worktree_create_script: string | null
  custom_commands: CustomProjectCommand[] | null
  auto_assign_port: boolean
  sort_order: number
  created_at: string
  last_accessed_at: string
}

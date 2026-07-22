// The YAML file root
export interface BackupFile {
  version: number // 1 for now
  kind: 'hive-backup'
  created_at: string // ISO timestamp
  app_version: string
  projects: BackupProject[]
}

export interface BackupProject {
  name: string
  path: string // original absolute path
  remote_url: string | null // normalized-agnostic raw URL as read from git; null if no remote
  description: string | null
  tags: string[] | null
  language: string | null
  setup_script: string | null
  run_script: string | null
  archive_script: string | null
  worktree_create_script: string | null
  custom_commands: unknown[] | null // CustomProjectCommand[] round-tripped as YAML
  auto_assign_port: boolean
  sort_order: number // exported for fidelity; NOT applied on restore
  kanban_simple_mode: boolean
  kanban_storage_mode: 'internal' | 'markdown'
  kanban_markdown_config: unknown | null // parsed JSON object
  custom_icon: BackupProjectIcon | null
  worktrees: BackupWorktree[]
  tickets: BackupTicket[] | null // null/absent for markdown-mode projects
  ticket_dependencies: BackupTicketDependency[] | null
}

export interface BackupProjectIcon {
  filename: string
  data_base64: string
}

export interface BackupWorktree {
  name: string
  branch_name: string
  base_branch: string | null
}

export interface BackupTicket {
  key: string // stable export-time key t1..tN for dependency edges
  title: string
  description: string | null
  column: 'todo' | 'in_progress' | 'review' | 'merged' | 'done'
  sort_order: number
  mode: 'build' | 'plan' | 'super-plan' | null
  mark: string | null // 'common'|'rare'|'epic'|'legendary'
  total_tokens: number
  archived_at: string | null
  worktree_branch: string | null // branch_name of assigned worktree
}

export interface BackupTicketDependency {
  dependent: string // BackupTicket.key
  blocker: string // BackupTicket.key
}

// Restore-side result types (returned by RPC methods; also used by the renderer wizard)
export type ProjectClassificationKind =
  | 'exists-match' // path (or remote-matched Hive project) exists, remote matches → pull
  | 'missing-clone' // path missing, has remote → clone
  | 'conflict' // path exists but is a different/non-git repo → skipped
  | 'skipped-no-remote' // path missing and no remote → cannot restore

export interface ProjectClassification {
  path: string // the backed-up path (identity key in the wizard)
  classification: ProjectClassificationKind
  alreadyInHive: boolean
  hiveProjectId: string | null
  effectivePath: string // where restore will operate (differs when matched by remote)
  localRemoteUrl: string | null
}

export interface RestoreWorktreeResult {
  branch: string
  status: 'created' | 'skipped-existing' | 'created-fresh-branch' | 'failed'
  error?: string
}

export interface RestoreProjectResult {
  success: boolean
  projectId?: string
  projectName: string
  action: 'cloned' | 'pulled' | 'attached' | 'skipped-conflict' | 'skipped-no-remote' | 'failed'
  warnings: string[]
  worktrees: RestoreWorktreeResult[]
  tickets: { restored: number; dependencyErrors: number; skipped: boolean } | null
  error?: string
}

// backupOps.exportBackup / backupOps.openBackupFile RPC result shapes.
// Shared between the server RPC domain (src/server/rpc/domains/backup-ops.ts)
// and the renderer API wrapper (src/renderer/src/api/backup-api.ts).
export interface BackupExportResult {
  readonly success: boolean
  readonly canceled?: boolean
  readonly path?: string
  readonly projectCount?: number
  // Non-fatal issues encountered while building the export (e.g. a custom
  // icon that was skipped for being missing or oversized). Absent/empty when
  // the export had nothing to warn about.
  readonly warnings?: string[]
  readonly error?: string
}

export interface BackupOpenResult {
  readonly canceled: boolean
  readonly backup?: BackupFile
  readonly error?: string
}

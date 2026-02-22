export type GitStatusCode = 'M' | 'A' | 'D' | '?' | 'C' | ''

export interface GitFileStatus {
  path: string
  relativePath: string
  status: GitStatusCode
  staged: boolean
}

export interface GitStatusChangedEvent {
  worktreePath: string
}

export interface GitBranchInfo {
  name: string
  tracking: string | null
  ahead: number
  behind: number
}

export interface GitDiffStatFile {
  path: string
  additions: number
  deletions: number
  binary: boolean
}

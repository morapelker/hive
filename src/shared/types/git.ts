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

export interface PRReviewComment {
  id: number
  body: string
  bodyHTML: string
  path: string
  line: number | null
  originalLine: number | null
  side: 'LEFT' | 'RIGHT'
  diffHunk: string
  user: { login: string; avatarUrl: string }
  createdAt: string
  updatedAt: string
  inReplyToId: number | null
  pullRequestReviewId: number | null
  subjectType: 'line' | 'file'
}

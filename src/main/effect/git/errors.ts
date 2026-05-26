import { Data } from 'effect'

export class GitNotARepository extends Data.TaggedError('GitNotARepository')<{
  readonly worktreePath: string
  readonly command: string
  readonly stderrExcerpt?: string
  readonly cause: unknown
}> {}

export class GitDirty extends Data.TaggedError('GitDirty')<{
  readonly worktreePath: string
  readonly command: string
  readonly affectedPaths?: readonly string[]
  readonly stderrExcerpt?: string
  readonly cause: unknown
}> {}

export class GitMergeConflict extends Data.TaggedError('GitMergeConflict')<{
  readonly worktreePath: string
  readonly command: string
  readonly operation: 'merge' | 'rebase' | 'cherry-pick' | 'apply'
  readonly conflicts: readonly string[]
  readonly stderrExcerpt?: string
  readonly cause: unknown
}> {}

export class GitNetworkError extends Data.TaggedError('GitNetworkError')<{
  readonly worktreePath: string
  readonly command: string
  readonly remote?: string
  readonly stderrExcerpt?: string
  readonly cause: unknown
}> {}

export class GitPermissionDenied extends Data.TaggedError('GitPermissionDenied')<{
  readonly worktreePath: string
  readonly command: string
  readonly stderrExcerpt?: string
  readonly cause: unknown
}> {}

export class GitUnknown extends Data.TaggedError('GitUnknown')<{
  readonly worktreePath: string
  readonly command: string
  readonly stderrExcerpt?: string
  readonly cause: unknown
}> {}

export type GitError =
  | GitNotARepository
  | GitDirty
  | GitMergeConflict
  | GitNetworkError
  | GitPermissionDenied
  | GitUnknown

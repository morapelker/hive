import { gitApi } from '@/api/git-api'
import type { GitUnreachableCommit } from '@/api/git-api'
import type { DiffStatFile } from '@/components/worktrees/DirtyFilesConfirmDialog'

/** What branch info reports as the branch name when HEAD is detached. */
const DETACHED_BRANCH_NAME = 'HEAD'

interface WorktreeIdentity {
  name: string
  branch_name: string
  is_default: boolean
}

/**
 * True when a linked worktree is on no branch. The live branch info wins when it has loaded
 * (a rebase detaches a worktree whose row still names its branch); until then an empty
 * `branch_name` on the row says the same. The project's own checkout is left out: its row
 * name is a placeholder, so its title keeps showing what git reports.
 */
export function isDetachedWorktree(
  worktree: WorktreeIdentity,
  liveBranchName: string | undefined
): boolean {
  if (worktree.is_default) return false
  return liveBranchName === undefined
    ? !worktree.branch_name
    : liveBranchName === DETACHED_BRANCH_NAME
}

/**
 * The sidebar title of a worktree: its live branch, or for a detached one the name it is
 * known by (the branch on its row if it has one, else its directory) instead of "HEAD".
 */
export function getWorktreeDisplayName(
  worktree: WorktreeIdentity,
  liveBranchName: string | undefined
): string {
  if (isDetachedWorktree(worktree, liveBranchName)) return worktree.branch_name || worktree.name
  return liveBranchName ?? worktree.name
}

/** What removing a detached worktree would destroy for good. */
export interface DetachedRemovalRisk {
  /** Uncommitted and untracked files in the checkout. */
  files: DiffStatFile[]
  /** How many commits HEAD has that no branch, tag or remote ref can reach. */
  commitCount: number
  /** The newest of those commits. */
  commits: GitUnreachableCommit[]
}

/**
 * Looks for work that exists only in a detached worktree, so the caller can ask before
 * removing it. Returns null when there is nothing to lose. A check that fails counts as
 * nothing found, as with archive: the usual cause is a checkout already gone from disk, and
 * that row must stay removable.
 */
export async function getDetachedRemovalRisk(
  worktreePath: string
): Promise<DetachedRemovalRisk | null> {
  const [diffStat, unreachable] = await Promise.all([
    gitApi.getDiffStat(worktreePath).catch(() => null),
    gitApi.getUnreachableCommits(worktreePath).catch(() => null)
  ])
  const files = diffStat?.success ? (diffStat.files ?? []) : []
  const commits = unreachable?.success ? (unreachable.commits ?? []) : []
  const commitCount = unreachable?.success ? (unreachable.count ?? commits.length) : 0
  if (files.length === 0 && commitCount === 0) return null
  return { files, commitCount, commits }
}

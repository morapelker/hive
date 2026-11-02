import { gitApi } from '@/api/git-api'
import { toast } from '@/lib/toast'

/** A base branch a Done/Merged move is about to compare a ticket's branch against. */
export interface BaseBranchPullTarget {
  projectId: string
  /** Any worktree of the project's repository: the server finds where the branch lives. */
  worktreePath: string
  branch: string
  /** Names the project in the warning, for a connection's members. */
  projectName?: string
}

/** How long a drop waits for origin before it goes on with the local branch. */
export const BASE_BRANCH_PULL_DEADLINE_MS = 15_000

const pullKey = (target: Pick<BaseBranchPullTarget, 'projectId' | 'branch'>): string =>
  `${target.projectId}\0${target.branch}`

/**
 * Syncs under way, for as long as git runs (past a caller's deadline too): a second drop or
 * click joins one instead of racing it for git's locks.
 */
const inFlight = new Map<string, Promise<boolean>>()

function syncOnce(target: BaseBranchPullTarget): Promise<boolean> {
  const key = pullKey(target)
  const running = inFlight.get(key)
  if (running) return running
  const sync = gitApi
    .syncBranchWithOrigin(target.worktreePath, target.branch)
    .then(
      (result) => result.success,
      () => false
    )
    .finally(() => inFlight.delete(key))
  inFlight.set(key, sync)
  return sync
}

/** True once the branch is level with origin; false when the local branch may be stale. */
async function pullWithDeadline(target: BaseBranchPullTarget): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), BASE_BRANCH_PULL_DEADLINE_MS)
  })
  try {
    return await Promise.race([syncOnce(target), deadline])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Bring the local base branches up to date with origin before a Done/Merged move compares a
 * ticket's branch against them: against a stale main, a PR merged on the remote still reads as
 * work to merge. Run once per drop, before its first check, and in parallel across a
 * connection's members.
 *
 * Fast-forward only, so it never leaves a merge on the base checkout (the merge step pulls
 * again and handles what comes of it). Best effort: offline, a diverged local branch or a dirty
 * checkout in the way must not cost the move, so this warns and resolves, and the checks go on
 * with the local branch.
 *
 * It always pulls, with no cheaper look at origin first: `git ls-remote` takes as long as the
 * fetch it would save (0.8s vs 0.7s when measured against GitHub).
 */
export async function pullBaseBranches(targets: readonly BaseBranchPullTarget[]): Promise<void> {
  const unique = [...new Map(targets.map((target) => [pullKey(target), target])).values()]
  if (unique.length === 0) return

  // The ticket stays where it was until this is done: a drop must not look like it did nothing
  const pulling = toast.loading(
    unique.length === 1
      ? `Pulling latest ${unique[0].branch}…`
      : `Pulling latest in ${unique.length} projects…`
  )
  try {
    const pulled = await Promise.all(unique.map(pullWithDeadline))
    const failed = unique.filter((_, index) => !pulled[index])
    if (failed.length > 0) {
      const names = failed.map((target) =>
        target.projectName ? `${target.branch} (${target.projectName})` : target.branch
      )
      toast.warning(
        `Could not pull latest ${names.join(', ')} from origin - checking against the local branch`
      )
    }
  } finally {
    toast.dismiss(pulling)
  }
}

import { gitApi } from '@/api/git-api'
import { toast } from '@/lib/toast'
import { useSettingsStore } from '@/stores/useSettingsStore'

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

/**
 * How long a pull holds: moves of the project's tickets within it (one by one, or the whole
 * batch of an orchestrator's run) check against the branch as it was pulled, without asking
 * origin again.
 */
export const BASE_BRANCH_PULL_INTERVAL_MS = 60_000

const pullKey = (target: Pick<BaseBranchPullTarget, 'projectId' | 'branch'>): string =>
  `${target.projectId}\0${target.branch}`

/**
 * Syncs under way, for as long as git runs (past a caller's deadline too): a second drop or
 * click joins one instead of racing it for git's locks.
 */
const inFlight = new Map<string, Promise<boolean>>()

/**
 * When each base branch was last asked of origin, whatever came of it: an origin that is down
 * is not asked again on every drop either.
 */
const lastPulledAt = new Map<string, number>()

/**
 * Forget the pulls so far: the next move pulls again, whenever the last one was. For tests,
 * which move tickets of one project far more often than a minute allows.
 */
export function forgetBaseBranchPulls(): void {
  lastPulledAt.clear()
}

/**
 * Due unless a pull of the branch is fresh. One still under way is joined whatever the clock
 * says: waiting on it costs no fetch, and the check then reads what it brought.
 */
function isDue(key: string): boolean {
  if (inFlight.has(key)) return true
  const pulledAt = lastPulledAt.get(key)
  return pulledAt === undefined || Date.now() - pulledAt >= BASE_BRANCH_PULL_INTERVAL_MS
}

function syncOnce(target: BaseBranchPullTarget): Promise<boolean> {
  const key = pullKey(target)
  const running = inFlight.get(key)
  if (running) return running
  lastPulledAt.set(key, Date.now())
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
 * work to merge. Run before a drop's first check, and in parallel across a connection's
 * members.
 *
 * Each base branch is pulled at most once per `BASE_BRANCH_PULL_INTERVAL_MS`, however many
 * tickets of the project move in that time: a later move within the window, and every other
 * pull of a batch (the drop of an orchestrator's ticket asks for each branch it checks), checks
 * against the branch as it was pulled. Nothing at all happens with the "Pull before moving
 * tickets" setting off.
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
  if (!useSettingsStore.getState().autoPullOnTicketMove) return
  const unique = [...new Map(targets.map((target) => [pullKey(target), target])).values()]
  const due = unique.filter((target) => isDue(pullKey(target)))
  if (due.length === 0) return

  // The ticket stays where it was until this is done: a drop must not look like it did nothing
  const pulling = toast.loading(
    due.length === 1
      ? `Pulling latest ${due[0].branch}…`
      : `Pulling latest in ${due.length} projects…`
  )
  try {
    const pulled = await Promise.all(due.map(pullWithDeadline))
    const failed = due.filter((_, index) => !pulled[index])
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

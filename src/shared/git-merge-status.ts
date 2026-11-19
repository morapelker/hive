/**
 * What `gitOps.branchDiffShortStat` says about a branch against the branch it merges into.
 * `contentMerged` is absent on an answer from a Mac running a version without the check.
 */
export interface BranchMergeStat {
  commitsAhead: number
  contentMerged?: boolean
}

/**
 * Commits a merge would still bring. A branch whose commits the base lacks while their
 * content is on it already (squash-merged, rebase-merged, cherry-picked) has none: merging
 * it would change nothing, so it reads like a branch that was merged the ordinary way.
 */
export const commitsToMerge = (stat: BranchMergeStat): number =>
  stat.contentMerged ? 0 : stat.commitsAhead

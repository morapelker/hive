/**
 * Pure helpers for the connection Diffs tab: a connection groups several
 * worktrees (one per repo), so "the branch to compare against" only makes
 * sense when every member repo has a branch of that name.
 */

export interface BranchWithStatus {
  name: string
  isRemote: boolean
  isCheckedOut: boolean
  worktreePath?: string
}

/** One member's branch listing, or the reason it could not be loaded. */
export type MemberBranchListing =
  | { worktreePath: string; branches: BranchWithStatus[]; error?: undefined }
  | { worktreePath: string; branches?: undefined; error: string }

/**
 * Branches present (by exact display name) in every successfully loaded member.
 *
 * Members whose listing failed are ignored for the intersection rather than
 * emptying it, so one broken repo does not blank the whole picker; callers
 * surface those failures separately. Order follows the first loaded member
 * (git's alphabetical local-then-remote order). A name counts as "current"
 * only when every member worktree itself is checked out on it (the backend's
 * `isCheckedOut` means "checked out in some worktree of that repo", so the
 * reported worktree path is matched against the member's), and as remote when
 * the first member reports it remote (remote names carry the `origin/` prefix,
 * so a local and a remote branch never share a display name).
 */
export function intersectMemberBranches(listings: MemberBranchListing[]): BranchWithStatus[] {
  const loaded = listings.filter(
    (l): l is Extract<MemberBranchListing, { branches: BranchWithStatus[] }> => !!l.branches
  )
  if (loaded.length === 0) return []

  const byName = loaded.map((l) => {
    const map = new Map<string, BranchWithStatus>()
    for (const b of l.branches) {
      if (!map.has(b.name)) map.set(b.name, b)
    }
    return map
  })

  const [first, ...rest] = byName
  const common: BranchWithStatus[] = []
  for (const [name, branch] of first) {
    if (!rest.every((m) => m.has(name))) continue
    common.push({
      name,
      isRemote: branch.isRemote,
      isCheckedOut: loaded.every((l, i) => {
        const entry = byName[i].get(name)
        return entry?.isCheckedOut === true && entry.worktreePath === l.worktreePath
      })
    })
  }
  return common
}

/** Store key under which a connection's chosen compare branch is remembered. */
export function connectionDiffBranchKey(connectionId: string): string {
  return `connection:${connectionId}`
}

/**
 * The git RPCs return raw stderr; turn the two failures a member can hit in
 * this view into something readable, and pass anything else through.
 */
export function describeMemberGitError(error: string): string {
  if (/not a git repository/i.test(error)) return 'Not a git repository'
  if (/unknown revision|bad revision|ambiguous argument/i.test(error)) {
    return 'Branch not found in this repo'
  }
  return error
}

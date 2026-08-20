/**
 * Parsing and tidying of raw git CLI output. Pure string work, no Electron and no
 * filesystem, so the main process and the server can both import it directly.
 */

/** Strip the `remotes/` prefix git uses for remote branches, for display. */
export function normalizeBranchDisplayName(branchName: string): string {
  return branchName.startsWith('remotes/') ? branchName.replace(/^remotes\//, '') : branchName
}

/**
 * Find the worktree checked out on a branch in `git worktree list --porcelain`
 * output. Returns the worktree path, or null when the branch is not checked out.
 */
export function parseWorktreeForBranch(porcelainOutput: string, branchName: string): string | null {
  const blocks = porcelainOutput.trim().split('\n\n')

  for (const block of blocks) {
    let worktreePath = ''
    let branch = ''

    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) worktreePath = line.slice('worktree '.length)
      if (line.startsWith('branch refs/heads/')) branch = line.slice('branch refs/heads/'.length)
    }

    if (branch === branchName && worktreePath) return worktreePath
  }

  return null
}

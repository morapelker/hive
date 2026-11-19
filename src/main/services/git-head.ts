import { readFileSync, statSync } from 'fs'
import { isAbsolute, join, resolve } from 'path'

/**
 * The git dir of a checkout: `.git` itself for a main working tree, and for a linked worktree
 * the directory its `.git` file points at (`gitdir: <repo>/.git/worktrees/<name>`). null when
 * the path is not a checkout or cannot be read.
 */
export function resolveGitDir(worktreePath: string): string | null {
  const dotGit = join(worktreePath, '.git')
  try {
    if (statSync(dotGit).isDirectory()) return dotGit
    const match = readFileSync(dotGit, 'utf-8')
      .trim()
      .match(/^gitdir:\s*(.+)$/)
    if (!match) return null
    return isAbsolute(match[1]) ? match[1] : resolve(worktreePath, match[1])
  } catch {
    return null
  }
}

// What a reftable repository leaves in the HEAD file: the branch is in the reftable, not here.
const REFTABLE_PLACEHOLDER = '.invalid'

export interface ReadHeadOptions {
  /**
   * Only answer for a linked worktree (`.git` is a file). Every worktree the app made is one;
   * a directory recorded as such that has a `.git` directory of its own is the main checkout
   * of some other repository (see `getOrphanedWorktreeDirReason`), and its branch says nothing
   * about the branch this worktree had.
   */
  readonly linkedOnly?: boolean
}

/**
 * The branch a checkout is on right now, read straight from its HEAD file — no git process, so
 * it is cheap enough to ask before every use of a stored branch name.
 *
 * null means "cannot say": HEAD is detached (rebase, bisect, a checked-out commit), the path
 * is not a checkout on this machine, or the repository keeps HEAD somewhere this cannot read.
 * A caller must then keep the name it has; null never means the checkout has no branch.
 */
export function readHeadBranch(worktreePath: string, options: ReadHeadOptions = {}): string | null {
  const gitDir = resolveGitDir(worktreePath)
  if (!gitDir) return null
  if (options.linkedOnly && gitDir === join(worktreePath, '.git')) return null
  let head: string
  try {
    head = readFileSync(join(gitDir, 'HEAD'), 'utf-8').trim()
  } catch {
    return null
  }
  const match = head.match(/^ref:\s*refs\/heads\/(.+)$/)
  if (!match || match[1] === REFTABLE_PLACEHOLDER) return null
  return match[1]
}

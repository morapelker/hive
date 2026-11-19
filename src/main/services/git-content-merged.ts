import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** A dry-run merge that takes longer than this is not waited for: the caller falls back. */
const TIMEOUT_MS = 20_000

const git = async (cwd: string, args: readonly string[]): Promise<string> => {
  const { stdout } = await execFileAsync('git', [...args], {
    cwd,
    timeout: TIMEOUT_MS,
    maxBuffer: 1024 * 1024
  })
  return stdout
}

/** A name git would read as an option is never a revision we were meant to look at. */
const usable = (revision: string): boolean => revision.length > 0 && !revision.startsWith('-')

/**
 * Whether merging `branch` into `into` would leave `into` exactly as it is: the content
 * of `branch` is already there, whatever the commit graph says. That is what a squash merge
 * leaves behind (GitHub's "Squash and merge", `git merge --squash`), and a rebase merge or a
 * cherry-pick: the commits of `branch` are not in `into`, their changes are.
 *
 * Answered by a dry-run merge (`git merge-tree --write-tree`, no working tree or ref is
 * touched) whose resulting tree is compared with the tree of `into`, so it holds when
 * `into` has moved on since, and says no when the changes were reverted there.
 *
 * False whenever git cannot say so for certain: a merge that conflicts (`into` rewrote the
 * same lines later), a git older than 2.38, a missing revision, a timeout. The answer gates
 * steps that delete the branch, so "not sure" must read as "not merged".
 */
export async function mergeChangesNothing(
  cwd: string,
  into: string,
  branch: string
): Promise<boolean> {
  if (!usable(into) || !usable(branch)) return false
  try {
    const [intoTree, merged] = await Promise.all([
      git(cwd, ['rev-parse', '--verify', '--quiet', `${into}^{tree}`]),
      // Exit 0 is a clean merge and prints the merged tree; a conflict exits 1 and rejects
      git(cwd, ['merge-tree', '--write-tree', '--no-messages', into, branch])
    ])
    const mergedTree = merged.split('\n')[0]?.trim() ?? ''
    return /^[0-9a-f]{40,64}$/.test(mergedTree) && mergedTree === intoTree.trim()
  } catch {
    return false
  }
}

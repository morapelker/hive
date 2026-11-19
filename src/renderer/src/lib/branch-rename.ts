import { useConnectionStore } from '@/stores/useConnectionStore'
import { useFileViewerStore } from '@/stores/useFileViewerStore'
import { useGitStore } from '@/stores/useGitStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import type { WorktreeBranchRenamedEvent } from '@shared/worktree-events'

/**
 * A worktree is on a branch of another name than the stores know (`worktree:branchRenamed`,
 * sent for every rename the app makes or finds). Brings every place in this window that holds
 * the branch's name up to date:
 *
 *  - the worktree's own row, at once, so the sidebar shows the new name without a round trip;
 *  - the project's worktrees from the database: the row's real display name, and the
 *    `base_branch` of the worktrees that were cut from the renamed branch (what merge-on-done
 *    and the review diff compare with);
 *  - the live branch info of the checkout;
 *  - the connections the worktree is a member of (they show and archive by branch name);
 *  - with `oldBranch` (the branch itself was renamed, not merely switched away from): the
 *    remembered choices of that branch — merge source, compare branch, open diff tabs.
 */
export function applyBranchRenamed(event: WorktreeBranchRenamedEvent): void {
  const { worktreeId, newBranch, worktreePath, oldBranch } = event
  const worktreeStore = useWorktreeStore.getState()

  let projectId = event.projectId
  if (!projectId) {
    for (const [candidate, worktrees] of worktreeStore.worktreesByProject) {
      if (worktrees.some((w) => w.id === worktreeId)) {
        projectId = candidate
        break
      }
    }
  }

  worktreeStore.updateWorktreeBranch(worktreeId, newBranch)
  if (worktreePath) {
    void useGitStore.getState().loadBranchInfo(worktreePath, { force: true })
  }

  if (projectId && oldBranch && oldBranch !== newBranch) {
    // Before the reload: the paths are those of the repository the branch lives in
    const paths = new Set(
      (worktreeStore.worktreesByProject.get(projectId) ?? []).map((w) => w.path)
    )
    if (worktreePath) paths.add(worktreePath)
    useGitStore.getState().renameBranchSelections(projectId, paths, oldBranch, newBranch)
    useFileViewerStore.getState().renameCompareBranch(paths, oldBranch, newBranch)
  }

  // Only a project this window has loaded: an unloaded one reads the database when opened
  if (projectId && worktreeStore.worktreesByProject.has(projectId)) {
    void worktreeStore.loadWorktrees(projectId, { force: true })
  }

  const connectionStore = useConnectionStore.getState()
  const isMember = connectionStore.connections.some((connection) =>
    connection.members.some((member) => member.worktree_id === worktreeId)
  )
  if (isMember) void connectionStore.loadConnections()
}

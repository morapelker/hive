import { useEffect, useRef } from 'react'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useGitStore } from '@/stores/useGitStore'

/**
 * Manages the main-process worktree watcher lifecycle.
 *
 * Starts watching when a worktree is selected, stops when it's deselected
 * or changed. This runs at the AppLayout level so the watcher is always
 * active regardless of which sidebar tab is visible.
 *
 * The main-process watcher monitors:
 * - .git/index, .git/HEAD, .git/refs/ (catches all git operations)
 * - Working tree files (catches edits before staging)
 *
 * It emits 'git:statusChanged' events which are already handled by
 * ChangesView, GitStatusPanel, and FileTree components.
 */
export function useWorktreeWatcher(): void {
  const selectedWorktreeId = useWorktreeStore((s) => s.selectedWorktreeId)
  const worktreesByProject = useWorktreeStore((s) => s.worktreesByProject)
  const previousPathRef = useRef<string | null>(null)

  // Resolve current worktree path from selection
  const worktreePath = (() => {
    if (!selectedWorktreeId) return null
    for (const worktrees of worktreesByProject.values()) {
      const wt = worktrees.find((w) => w.id === selectedWorktreeId)
      if (wt) return wt.path
    }
    return null
  })()

  useEffect(() => {
    const prevPath = previousPathRef.current

    // If the path hasn't changed, do nothing
    if (prevPath === worktreePath) return

    // Stop watching the previous worktree
    if (prevPath) {
      window.gitOps.unwatchWorktree(prevPath).catch(() => {
        // Non-critical - watcher may already be stopped
      })
    }

    // Start watching the new worktree
    if (worktreePath) {
      window.gitOps.watchWorktree(worktreePath).catch(() => {
        // Non-critical - watcher setup failed
      })

      // Also do an initial load of statuses when switching worktrees
      const { loadFileStatuses, loadBranchInfo } = useGitStore.getState()
      loadFileStatuses(worktreePath)
      loadBranchInfo(worktreePath)
    }

    previousPathRef.current = worktreePath
  }, [worktreePath])

  useEffect(() => {
    return () => {
      const currentPath = previousPathRef.current
      if (currentPath) {
        window.gitOps.unwatchWorktree(currentPath).catch(() => {
          // Non-critical
        })
      }
    }
  }, [])
}

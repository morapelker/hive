import { useEffect, useRef } from 'react'
import { useGitStore } from '@/stores/useGitStore'

/**
 * Watches .git/HEAD for all provided worktree paths to keep sidebar
 * branch names up-to-date in real time.
 *
 * Uses the lightweight branch-watcher (HEAD-only, no working-tree scanning)
 * so it's cheap to watch many worktrees simultaneously.
 *
 * Lifecycle:
 * - On mount / path change: starts watchers + loads initial branch info
 * - On git:branchChanged event: refreshes branch info for matching path
 * - On unmount / path removal: stops watchers
 */
export function useSidebarBranchWatcher(worktreePaths: string[]): void {
  const previousPathsRef = useRef<string[]>([])

  // Stable key for change detection
  const pathsKey = worktreePaths.join('\n')

  // Manage watchers when paths change
  useEffect(() => {
    const prevPaths = previousPathsRef.current
    const prevKey = prevPaths.join('\n')

    if (prevKey === pathsKey) return

    const prevSet = new Set(prevPaths)
    const newSet = new Set(worktreePaths)

    // Stop watching removed paths
    for (const path of prevPaths) {
      if (!newSet.has(path)) {
        window.gitOps.unwatchBranch(path).catch(() => {
          // Non-critical
        })
      }
    }

    // Start watching added paths
    for (const path of worktreePaths) {
      if (!prevSet.has(path)) {
        window.gitOps.watchBranch(path).catch(() => {
          // Non-critical
        })
      }
    }

    // Load initial branch info for all current paths
    const { loadBranchInfo } = useGitStore.getState()
    for (const path of worktreePaths) {
      loadBranchInfo(path)
    }

    previousPathsRef.current = worktreePaths
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathsKey])

  // Subscribe to branch change events
  useEffect(() => {
    if (worktreePaths.length === 0) return

    const unsubscribe = window.gitOps.onBranchChanged((event) => {
      const currentPaths = previousPathsRef.current
      if (currentPaths.includes(event.worktreePath)) {
        useGitStore.getState().loadBranchInfo(event.worktreePath)
      }
    })

    return () => {
      unsubscribe()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathsKey])

  // Cleanup all watchers on unmount
  useEffect(() => {
    return () => {
      for (const path of previousPathsRef.current) {
        window.gitOps.unwatchBranch(path).catch(() => {
          // Non-critical
        })
      }
    }
  }, [])
}

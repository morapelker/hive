import { useEffect } from 'react'
import { useGitStore } from '@/stores/useGitStore'

const THROTTLE_MS = 2000

export function useWindowFocusRefresh(): void {
  useEffect(() => {
    let lastRefreshTime = 0

    const unsubscribe = window.systemOps.onWindowFocused(() => {
      const now = Date.now()
      if (now - lastRefreshTime < THROTTLE_MS) return
      lastRefreshTime = now

      // Refresh all worktrees that currently have loaded statuses
      const { fileStatusesByWorktree, refreshStatuses } = useGitStore.getState()
      for (const worktreePath of fileStatusesByWorktree.keys()) {
        refreshStatuses(worktreePath)
      }
    })

    return unsubscribe
  }, [])
}

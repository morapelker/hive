import { useEffect, useRef } from 'react'
import { useGitStore } from '@/stores/useGitStore'

const THROTTLE_MS = 2000

// Safety-net poll interval: if no watcher events have arrived in this window,
// do a single background refresh to catch edge cases (network drives, watcher bugs)
const IDLE_POLL_MS = 60_000

export function useWindowFocusRefresh(): void {
  // Track when the last git:statusChanged event was received
  const lastEventRef = useRef(Date.now())

  useEffect(() => {
    let lastRefreshTime = 0

    // Track incoming git status events so we can skip idle polls when the watcher is working
    const unsubscribeStatus = window.gitOps.onStatusChanged(() => {
      lastEventRef.current = Date.now()
    })

    const unsubscribeFocus = window.systemOps.onWindowFocused(() => {
      const now = Date.now()
      if (now - lastRefreshTime < THROTTLE_MS) return
      lastRefreshTime = now

      // Refresh all worktrees that currently have loaded statuses
      const { fileStatusesByWorktree, refreshStatuses } = useGitStore.getState()
      for (const worktreePath of fileStatusesByWorktree.keys()) {
        refreshStatuses(worktreePath)
      }
    })

    // Safety-net: poll every 60s, but only if no watcher event arrived recently
    const pollInterval = setInterval(() => {
      const timeSinceLastEvent = Date.now() - lastEventRef.current
      if (timeSinceLastEvent < IDLE_POLL_MS) return // watcher is active, skip poll

      const { fileStatusesByWorktree, refreshStatuses } = useGitStore.getState()
      for (const worktreePath of fileStatusesByWorktree.keys()) {
        refreshStatuses(worktreePath)
      }
    }, IDLE_POLL_MS)

    return () => {
      unsubscribeStatus()
      unsubscribeFocus()
      clearInterval(pollInterval)
    }
  }, [])
}

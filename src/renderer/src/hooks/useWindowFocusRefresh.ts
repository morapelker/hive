import { useEffect, useRef } from 'react'
import { useGitStore } from '@/stores/useGitStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useConnectionStore } from '@/stores/useConnectionStore'

const THROTTLE_MS = 2000

// Safety-net poll interval: if no watcher events have arrived in this window,
// do a single background refresh to catch edge cases (network drives, watcher bugs)
const IDLE_POLL_MS = 60_000

/**
 * Returns the worktree path(s) that should be refreshed based on the current selection.
 * In worktree mode: returns the single selected worktree path.
 * In connection mode: returns all member worktree paths.
 * If nothing is selected: returns empty array.
 */
function getActiveWorktreePaths(): string[] {
  const { selectedWorktreeId, worktreesByProject } = useWorktreeStore.getState()

  if (selectedWorktreeId) {
    // Worktree mode — find the selected worktree's path
    for (const worktrees of worktreesByProject.values()) {
      const wt = worktrees.find((w) => w.id === selectedWorktreeId)
      if (wt) return [wt.path]
    }
    return []
  }

  // Connection mode — return all member worktree paths
  const { selectedConnectionId, connections } = useConnectionStore.getState()
  if (selectedConnectionId) {
    const connection = connections.find((c) => c.id === selectedConnectionId)
    if (connection) {
      return connection.members.map((m) => m.worktree_path)
    }
  }

  return []
}

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

      const paths = getActiveWorktreePaths()
      if (paths.length === 0) return

      const { refreshStatuses } = useGitStore.getState()
      for (const path of paths) {
        refreshStatuses(path)
      }
    })

    // Safety-net: poll every 60s, but only if no watcher event arrived recently
    const pollInterval = setInterval(() => {
      const timeSinceLastEvent = Date.now() - lastEventRef.current
      if (timeSinceLastEvent < IDLE_POLL_MS) return // watcher is active, skip poll

      const paths = getActiveWorktreePaths()
      if (paths.length === 0) return

      const { refreshStatuses } = useGitStore.getState()
      for (const path of paths) {
        refreshStatuses(path)
      }
    }, IDLE_POLL_MS)

    return () => {
      unsubscribeStatus()
      unsubscribeFocus()
      clearInterval(pollInterval)
    }
  }, [])
}

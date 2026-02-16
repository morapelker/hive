import { useEffect, useRef } from 'react'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useGitStore } from '@/stores/useGitStore'

/**
 * Watches all member worktree paths when a connection is selected.
 *
 * This is the connection-mode counterpart to useWorktreeWatcher.
 * When a connection is active (selectedConnectionId set, selectedWorktreeId null),
 * it starts filesystem watchers on each member worktree so that git changes
 * are detected in real-time and the Changes view stays up to date.
 */
export function useConnectionWatcher(): void {
  const selectedWorktreeId = useWorktreeStore((s) => s.selectedWorktreeId)
  const selectedConnectionId = useConnectionStore((s) => s.selectedConnectionId)
  const connections = useConnectionStore((s) => s.connections)
  const previousPathsRef = useRef<string[]>([])

  const isConnectionMode = !!selectedConnectionId && !selectedWorktreeId

  // Resolve member worktree paths for the selected connection
  const memberPaths = (() => {
    if (!isConnectionMode || !selectedConnectionId) return []
    const connection = connections.find((c) => c.id === selectedConnectionId)
    if (!connection) return []
    return connection.members.map((m) => m.worktree_path).sort()
  })()

  // Stable string key to detect changes
  const pathsKey = memberPaths.join('\n')

  useEffect(() => {
    const prevPaths = previousPathsRef.current
    const prevKey = prevPaths.join('\n')

    if (prevKey === pathsKey) return

    // Stop watching previous paths
    for (const path of prevPaths) {
      window.gitOps.unwatchWorktree(path).catch(() => {
        // Non-critical - watcher may already be stopped
      })
    }

    // Start watching new paths and load initial statuses
    if (memberPaths.length > 0) {
      for (const path of memberPaths) {
        window.gitOps.watchWorktree(path).catch(() => {
          // Non-critical - watcher setup failed
        })
      }

      // Load initial statuses for all members
      const { loadStatusesForPaths } = useGitStore.getState()
      loadStatusesForPaths(memberPaths)
    }

    previousPathsRef.current = memberPaths
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathsKey])

  // Subscribe to git status change events for any member path
  useEffect(() => {
    if (!isConnectionMode) return

    const unsubscribe = window.gitOps.onStatusChanged((event) => {
      const currentPaths = previousPathsRef.current
      if (currentPaths.includes(event.worktreePath)) {
        useGitStore.getState().refreshStatuses(event.worktreePath)
      }
    })

    return () => {
      unsubscribe()
    }
  }, [isConnectionMode])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      for (const path of previousPathsRef.current) {
        window.gitOps.unwatchWorktree(path).catch(() => {
          // Non-critical
        })
      }
    }
  }, [])
}

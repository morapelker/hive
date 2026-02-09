import { useEffect } from 'react'
import { useProjectStore, useWorktreeStore, useSessionStore } from '@/stores'

export function useNotificationNavigation(): void {
  useEffect(() => {
    const cleanup = window.systemOps.onNotificationNavigate((data) => {
      const { selectProject } = useProjectStore.getState()
      const { selectWorktree } = useWorktreeStore.getState()
      const { setActiveSession } = useSessionStore.getState()

      selectProject(data.projectId)
      selectWorktree(data.worktreeId)
      setActiveSession(data.sessionId)
    })

    return cleanup
  }, [])
}

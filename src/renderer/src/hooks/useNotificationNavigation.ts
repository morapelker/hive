import { useEffect } from 'react'
import { useProjectStore, useWorktreeStore, useSessionStore } from '@/stores'
import { systemApi } from '@/api/system-api'

export function useNotificationNavigation(): void {
  useEffect(() => {
    const cleanup = systemApi.onNotificationNavigate((data) => {
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

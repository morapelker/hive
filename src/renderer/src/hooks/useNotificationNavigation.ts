import { useEffect } from 'react'
import { useProjectStore, useWorktreeStore, useSessionStore } from '@/stores'
import { systemApi } from '@/api/system-api'
import { leaveBoardViews } from '@/lib/board-navigation'

export function useNotificationNavigation(): void {
  useEffect(() => {
    const cleanup = systemApi.onNotificationNavigate((data) => {
      const { selectProject } = useProjectStore.getState()
      const { selectWorktree } = useWorktreeStore.getState()
      const { setActiveSession } = useSessionStore.getState()

      // Going to a session always means leaving the (pinned) board
      leaveBoardViews()
      selectProject(data.projectId)
      selectWorktree(data.worktreeId)
      setActiveSession(data.sessionId)
    })

    return cleanup
  }, [])
}

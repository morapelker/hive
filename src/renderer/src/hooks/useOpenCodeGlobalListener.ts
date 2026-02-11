import { useEffect } from 'react'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useQuestionStore } from '@/stores/useQuestionStore'

/**
 * Persistent global listener for OpenCode stream events.
 *
 * The main process now owns stream persistence into SQLite.
 * This listener handles:
 * - Unread status for sessions that finish in background
 * - Title updates for background sessions (active session handled by SessionView)
 * - Branch auto-rename notifications from the main process
 */
export function useOpenCodeGlobalListener(): void {
  // Listen for branch auto-rename events from the main process
  useEffect(() => {
    const unsubscribe = window.worktreeOps?.onBranchRenamed
      ? window.worktreeOps.onBranchRenamed((data) => {
          const { worktreeId, newBranch } = data
          useWorktreeStore.getState().updateWorktreeBranch(worktreeId, newBranch)
        })
      : () => {}

    return unsubscribe
  }, [])

  useEffect(() => {
    const unsubscribe = window.opencodeOps?.onStream
      ? window.opencodeOps.onStream((event) => {
          const sessionId = event.sessionId
          const activeId = useSessionStore.getState().activeSessionId

          // Handle session.updated for background sessions — update title in store
          // Active session title is handled by SessionView's own listener
          if (event.type === 'session.updated' && sessionId !== activeId) {
            const sessionTitle = event.data?.info?.title || event.data?.title
            if (sessionTitle) {
              useSessionStore.getState().updateSessionName(sessionId, sessionTitle)
            }
            return
          }

          // Handle question events for background sessions
          if (event.type === 'question.asked' && sessionId !== activeId) {
            const request = event.data
            if (request?.id && request?.questions) {
              useQuestionStore.getState().addQuestion(sessionId, request)
              useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'answering')
            }
            return
          }

          if (
            (event.type === 'question.replied' || event.type === 'question.rejected') &&
            sessionId !== activeId
          ) {
            const requestId = event.data?.requestID || event.data?.requestId || event.data?.id
            if (requestId) {
              useQuestionStore.getState().removeQuestion(sessionId, requestId)
            }
            return
          }

          // Use session.status (not deprecated session.idle) as the authoritative signal
          if (event.type !== 'session.status') return

          const status = event.statusPayload || event.data?.status
          if (status?.type !== 'idle') return

          // Active session is handled by SessionView.
          if (sessionId === activeId) return

          useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'unread')
        })
      : () => {}

    return unsubscribe
  }, [])
}

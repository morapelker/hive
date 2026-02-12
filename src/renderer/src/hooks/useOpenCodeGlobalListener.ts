import { useEffect } from 'react'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useQuestionStore } from '@/stores/useQuestionStore'
import { useContextStore } from '@/stores/useContextStore'
import { extractTokens, extractCost, extractModelRef } from '@/lib/token-utils'
import { COMPLETION_WORDS } from '@/lib/format-utils'
import { messageSendTimes } from '@/lib/message-send-times'

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

          // Handle message.updated for background sessions — extract title + tokens
          if (event.type === 'message.updated' && sessionId !== activeId) {
            const sessionTitle = event.data?.info?.title || event.data?.title
            if (sessionTitle) {
              useSessionStore.getState().updateSessionName(sessionId, sessionTitle)
            }

            // Extract tokens for background sessions
            const info = event.data?.info
            if (info?.time?.completed) {
              const data = event.data as Record<string, unknown> | undefined
              if (data) {
                const tokens = extractTokens(data)
                if (tokens) {
                  const modelRef = extractModelRef(data) ?? undefined
                  useContextStore.getState().setSessionTokens(sessionId, tokens, modelRef)
                }
                const cost = extractCost(data)
                if (cost > 0) {
                  useContextStore.getState().addSessionCost(sessionId, cost)
                }
              }
            }
            return
          }

          // Keep session.updated for background title sync (some events use this type)
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

          // Background session became busy again — restore working/planning status
          if (status?.type === 'busy') {
            if (sessionId !== activeId) {
              const currentMode = useSessionStore.getState().getSessionMode(sessionId)
              useWorktreeStatusStore
                .getState()
                .setSessionStatus(sessionId, currentMode === 'plan' ? 'planning' : 'working')
            }
            return
          }

          if (status?.type !== 'idle') return

          // Active session is handled by SessionView.
          if (sessionId === activeId) return

          // Set completion badge — duration measured from when user sent the message
          const sendTime = messageSendTimes.get(sessionId)
          const durationMs = sendTime ? Date.now() - sendTime : 0
          const word = COMPLETION_WORDS[Math.floor(Math.random() * COMPLETION_WORDS.length)]
          useWorktreeStatusStore
            .getState()
            .setSessionStatus(sessionId, 'completed', { word, durationMs })

          // Update last message time for the worktree
          const sessions = useSessionStore.getState().sessionsByWorktree
          for (const [worktreeId, wSessions] of sessions) {
            if (wSessions.some((s) => s.id === sessionId)) {
              useWorktreeStatusStore.getState().setLastMessageTime(worktreeId, Date.now())
              break
            }
          }
        })
      : () => {}

    return unsubscribe
  }, [])
}

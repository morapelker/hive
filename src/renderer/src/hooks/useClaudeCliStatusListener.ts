import { useEffect } from 'react'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { lastSendMode } from '@/lib/message-send-times'

function isPlanLike(mode: string | undefined): boolean {
  return mode === 'plan' || mode === 'super-plan'
}

export function useClaudeCliStatusListener(): void {
  useEffect(() => {
    const unsubscribe = window.terminalOps?.onClaudeCliStatus
      ? window.terminalOps.onClaudeCliStatus(({ sessionId, status, metadata }) => {
          const worktreeStatus = useWorktreeStatusStore.getState()
          const currentStatus = worktreeStatus.sessionStatuses[sessionId]?.status
          const currentMode = useSessionStore.getState().modeBySession.get(sessionId)

          if (
            status === 'working' &&
            metadata?.hookEventName === 'UserPromptSubmit' &&
            currentStatus === 'plan_ready'
          ) {
            lastSendMode.set(sessionId, 'build')
            worktreeStatus.setSessionStatus(sessionId, 'working', metadata)
            return
          }

          if (
            status === 'working' &&
            metadata?.hookEventName === 'UserPromptSubmit' &&
            isPlanLike(currentMode)
          ) {
            lastSendMode.set(sessionId, 'plan')
            worktreeStatus.setSessionStatus(sessionId, 'planning', metadata)
            return
          }

          if (
            status === 'completed' &&
            metadata?.hookEventName === 'Stop' &&
            lastSendMode.get(sessionId) === 'plan'
          ) {
            worktreeStatus.setSessionStatus(sessionId, 'plan_ready', metadata)
            return
          }

          worktreeStatus.setSessionStatus(sessionId, status, metadata)
        })
      : () => {}

    return unsubscribe
  }, [])
}

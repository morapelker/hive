import { useEffect } from 'react'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'

/**
 * Persistent global listener for OpenCode stream events.
 *
 * The main process now owns stream persistence into SQLite.
 * This listener only updates unread status for sessions that finish in background.
 */
export function useOpenCodeGlobalListener(): void {
  useEffect(() => {
    const unsubscribe = window.opencodeOps?.onStream
      ? window.opencodeOps.onStream((event) => {
          // Use session.status (not deprecated session.idle) as the authoritative signal
          if (event.type !== 'session.status') return

          const status = event.statusPayload || event.data?.status
          if (status?.type !== 'idle') return

          const sessionId = event.sessionId
          const activeId = useSessionStore.getState().activeSessionId

          // Active session is handled by SessionView.
          if (sessionId === activeId) return

          useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'unread')
        })
      : () => {}

    return unsubscribe
  }, [])
}

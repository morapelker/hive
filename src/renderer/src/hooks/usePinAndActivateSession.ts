import { useCallback, useState } from 'react'
import { useSessionStore } from '@/stores/useSessionStore'

/** Creates a session, pins it to the board, activates it, and optionally runs a callback (e.g. close modal). */
export function usePinAndActivateSession(onClose?: () => void) {
  const [loading, setLoading] = useState(false)

  const pinAndActivate = useCallback(
    async (createFn: () => Promise<string | null>) => {
      setLoading(true)
      try {
        const sessionId = await createFn()
        if (sessionId) {
          const sessionStore = useSessionStore.getState()
          await sessionStore.pinSessionToBoard(sessionId)
          onClose?.()
        }
      } catch {
        // Session creation itself shows toasts; nothing extra needed
      } finally {
        setLoading(false)
      }
    },
    [onClose]
  )

  return { pinAndActivate, lifecycleLoading: loading }
}

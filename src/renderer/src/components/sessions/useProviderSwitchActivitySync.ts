import { useEffect } from 'react'
import { useSessionStore, type ProviderSwitchActivity } from '@/stores/useSessionStore'

export function useProviderSwitchActivitySync(
  sessionId: string,
  activity: ProviderSwitchActivity
): void {
  useEffect(() => {
    useSessionStore.getState().setProviderSwitchActivity(sessionId, activity)
  }, [activity, sessionId])

  useEffect(() => {
    return () => {
      useSessionStore.getState().setProviderSwitchActivity(sessionId, null)
    }
  }, [sessionId])
}

import { useEffect } from 'react'
import { usageApi } from '@/api/usage-api'
import { useUsageStore } from '@/stores/useUsageStore'

/**
 * Feeds the local Claude API proxy's per-response usage events into the usage
 * store: the attributed saved-account row updates immediately, and the bottom
 * bar follows when that account is the active one. Also passes on when a
 * Code Mode session's debug log stops giving readings, so that the usage UI
 * does not go on saying "Live" for it. Mount once at the app root.
 */
export function useClaudeLiveUsageListener(): void {
  useEffect(() => {
    const offUsage = usageApi.onClaudeLiveUsage((payload) => {
      useUsageStore.getState().applyClaudeLiveUsage(payload)
    })
    const offHealth = usageApi.onClaudeLiveUsageHealth((payload) => {
      useUsageStore.getState().applyClaudeLiveUsageHealth(payload)
    })
    return () => {
      offUsage()
      offHealth()
    }
  }, [])
}

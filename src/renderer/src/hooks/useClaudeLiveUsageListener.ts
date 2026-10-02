import { useEffect } from 'react'
import { usageApi } from '@/api/usage-api'
import { useUsageStore } from '@/stores/useUsageStore'

/**
 * Feeds the local Claude API proxy's per-response usage events into the usage
 * store: the attributed saved-account row updates immediately, and the bottom
 * bar follows when that account is the active one. Mount once at the app
 * root.
 */
export function useClaudeLiveUsageListener(): void {
  useEffect(() => {
    return usageApi.onClaudeLiveUsage((payload) => {
      useUsageStore.getState().applyClaudeLiveUsage(payload)
    })
  }, [])
}

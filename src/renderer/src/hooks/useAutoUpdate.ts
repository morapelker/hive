import { useEffect } from 'react'
import { toast } from '@/lib/toast'

export function useAutoUpdate(): void {
  useEffect(() => {
    // Guard: updaterOps may not exist in test environments
    if (!window.updaterOps) return

    const cleanups: (() => void)[] = []

    // Update downloaded — show restart prompt (only toast in the update flow)
    cleanups.push(
      window.updaterOps.onUpdateDownloaded((data) => {
        toast.success(`Update v${data.version} ready to install`, {
          duration: Infinity,
          action: {
            label: 'Restart to Update',
            onClick: () => {
              window.updaterOps.installUpdate()
            }
          }
        })
      })
    )

    // Error — show error toast
    cleanups.push(
      window.updaterOps.onError((data) => {
        toast.error('Update check failed', {
          description: data.message
        })
      })
    )

    return () => {
      cleanups.forEach((cleanup) => cleanup())
    }
  }, [])
}

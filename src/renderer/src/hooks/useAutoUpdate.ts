import { useEffect, useRef } from 'react'
import { toast } from '@/lib/toast'

export function useAutoUpdate(): void {
  const toastId = useRef<string | number | null>(null)

  useEffect(() => {
    // Guard: updaterOps may not exist in test environments
    if (!window.updaterOps) return

    const cleanups: (() => void)[] = []

    // Update available — show actionable toast
    cleanups.push(
      window.updaterOps.onUpdateAvailable((data) => {
        toastId.current = toast.info(`Update v${data.version} available`, {
          duration: Infinity,
          action: {
            label: 'Download',
            onClick: () => {
              window.updaterOps.downloadUpdate()
            }
          }
        })
      })
    )

    // Download progress — update the existing toast
    cleanups.push(
      window.updaterOps.onProgress((data) => {
        const percent = Math.round(data.percent)
        if (toastId.current != null) {
          toast.dismiss(toastId.current)
        }
        toastId.current = toast.loading(`Downloading update... ${percent}%`, {
          duration: Infinity
        })
      })
    )

    // Update downloaded — show restart prompt
    cleanups.push(
      window.updaterOps.onUpdateDownloaded((data) => {
        if (toastId.current != null) {
          toast.dismiss(toastId.current)
        }
        toastId.current = toast.success(`Update v${data.version} ready to install`, {
          duration: Infinity,
          action: {
            label: 'Restart Now',
            onClick: () => {
              window.updaterOps.installUpdate()
            }
          }
        })
      })
    )

    // No update available — silent (only show if user manually checked)
    // We don't subscribe to onUpdateNotAvailable for automatic checks
    // because that would be noisy.

    // Error — show error toast
    cleanups.push(
      window.updaterOps.onError((data) => {
        if (toastId.current != null) {
          toast.dismiss(toastId.current)
          toastId.current = null
        }
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

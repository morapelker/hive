import { useEffect, useRef, createElement } from 'react'
import { toast as sonnerToast } from 'sonner'
import { toast } from '@/lib/toast'
import { UpdateProgressToast } from '@/components/toasts/UpdateProgressToast'

export function useAutoUpdate(): void {
  const progressToastId = useRef<string | number | null>(null)
  const versionRef = useRef<string>('')

  useEffect(() => {
    // Guard: updaterOps may not exist in test environments
    if (!window.updaterOps) return

    const cleanups: (() => void)[] = []

    // Update available — show progress toast (starts at 0%)
    cleanups.push(
      window.updaterOps.onUpdateAvailable((data) => {
        versionRef.current = data.version
        progressToastId.current = sonnerToast.custom(
          () =>
            createElement(UpdateProgressToast, {
              version: data.version,
              percent: 0
            }),
          { duration: Infinity }
        )
      })
    )

    // Download progress — update toast in-place
    cleanups.push(
      window.updaterOps.onProgress((data) => {
        if (progressToastId.current == null) return
        sonnerToast.custom(
          () =>
            createElement(UpdateProgressToast, {
              version: versionRef.current,
              percent: data.percent
            }),
          { id: progressToastId.current, duration: Infinity }
        )
      })
    )

    // Update downloaded — dismiss progress toast, show restart prompt
    cleanups.push(
      window.updaterOps.onUpdateDownloaded((data) => {
        if (progressToastId.current != null) {
          sonnerToast.dismiss(progressToastId.current)
          progressToastId.current = null
        }
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

    // Error — dismiss progress toast if active, show error
    cleanups.push(
      window.updaterOps.onError((data) => {
        if (progressToastId.current != null) {
          sonnerToast.dismiss(progressToastId.current)
          progressToastId.current = null
        }
        toast.error('Update check failed', {
          description: data.message
        })
      })
    )

    return () => {
      cleanups.forEach((cleanup) => cleanup())
      if (progressToastId.current != null) {
        sonnerToast.dismiss(progressToastId.current)
        progressToastId.current = null
      }
    }
  }, [])
}

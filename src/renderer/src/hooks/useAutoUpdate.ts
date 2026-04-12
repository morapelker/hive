import { useEffect, useRef, createElement } from 'react'
import { toast as sonnerToast } from 'sonner'
import { toast } from '@/lib/toast'
import { UpdateProgressToast } from '@/components/toasts/UpdateProgressToast'
import { UpdateAvailableToast } from '@/components/toasts/UpdateAvailableToast'
import { useSettingsStore } from '@/stores/useSettingsStore'

export function useAutoUpdate(): void {
  const progressToastId = useRef<string | number | null>(null)
  const promptToastId = useRef<string | number | null>(null)
  const versionRef = useRef<string>('')
  const dismissedForSessionRef = useRef<string | null>(null)

  useEffect(() => {
    // Guard: updaterOps may not exist in test environments
    if (!window.updaterOps) return

    const cleanups: (() => void)[] = []

    // Update available — show prompt toast with Later/Skip/Download options
    cleanups.push(
      window.updaterOps.onUpdateAvailable((data) => {
        const { skippedUpdateVersion, updateSetting } = useSettingsStore.getState()
        const isManual = data.isManualCheck ?? false

        // Suppress for "Later" dismissal (in-memory, resets on restart)
        if (dismissedForSessionRef.current === data.version && !isManual) return

        // Suppress for "Skip this version" (persisted)
        if (skippedUpdateVersion === data.version && !isManual) return

        versionRef.current = data.version

        // Dismiss existing prompt toast if present
        if (promptToastId.current != null) {
          sonnerToast.dismiss(promptToastId.current)
        }

        promptToastId.current = sonnerToast.custom(
          () =>
            createElement(UpdateAvailableToast, {
              version: data.version,
              onDownload: () => {
                if (promptToastId.current != null) {
                  sonnerToast.dismiss(promptToastId.current)
                  promptToastId.current = null
                }
                window.updaterOps.downloadUpdate().catch(() => {})
                progressToastId.current = sonnerToast.custom(
                  () =>
                    createElement(UpdateProgressToast, {
                      version: data.version,
                      percent: 0
                    }),
                  { duration: Infinity }
                )
              },
              onLater: () => {
                dismissedForSessionRef.current = data.version
                if (promptToastId.current != null) {
                  sonnerToast.dismiss(promptToastId.current)
                  promptToastId.current = null
                }
              },
              onSkip: () => {
                updateSetting('skippedUpdateVersion', data.version)
                if (promptToastId.current != null) {
                  sonnerToast.dismiss(promptToastId.current)
                  promptToastId.current = null
                }
              }
            }),
          { duration: Infinity }
        )
      })
    )

    // No update available — show info toast on manual checks
    cleanups.push(
      window.updaterOps.onUpdateNotAvailable((data) => {
        if (data.isManualCheck) {
          toast.info('You\u2019re up to date', {
            description: `Hive v${data.version} is the latest version`
          })
        }
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

    // Error — dismiss toasts if active, show error
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
      if (promptToastId.current != null) {
        sonnerToast.dismiss(promptToastId.current)
        promptToastId.current = null
      }
    }
  }, [])
}

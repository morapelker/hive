import { useEffect, useRef, createElement } from 'react'
import { toast as sonnerToast } from 'sonner'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { toast } from '@/lib/toast'
import { GhosttyPromoToast } from '@/components/toasts/GhosttyPromoToast'

/**
 * Shows a promotional toast when Ghostty native terminal is available
 * but not currently active, encouraging users to switch from xterm.js.
 */
export function useGhosttyPromotion(terminalTabVisible: boolean): void {
  const shownRef = useRef(false)
  const toastId = useRef<string | number | null>(null)

  useEffect(() => {
    if (!terminalTabVisible || shownRef.current) return

    const { embeddedTerminalBackend, ghosttyPromotionDismissed } = useSettingsStore.getState()

    // Already using Ghostty or user dismissed the promotion
    if (embeddedTerminalBackend === 'ghostty' || ghosttyPromotionDismissed) {
      shownRef.current = true
      return
    }

    let cancelled = false

    async function checkAndPromote(): Promise<void> {
      try {
        const result = await window.terminalOps.ghosttyIsAvailable()
        if (cancelled || !result.available) return

        shownRef.current = true

        toastId.current = sonnerToast.custom(
          (id) =>
            createElement(GhosttyPromoToast, {
              onActivate: () => {
                useSettingsStore.getState().updateSetting('embeddedTerminalBackend', 'ghostty')
                sonnerToast.dismiss(id)
                toast.success('Ghostty terminal activated')
              },
              onDismiss: () => {
                useSettingsStore.getState().updateSetting('ghosttyPromotionDismissed', true)
                sonnerToast.dismiss(id)
                toast.info('You can always enable Ghostty in Settings > Terminal')
              }
            }),
          { duration: Infinity }
        )
      } catch {
        // Ghostty check failed, silently skip promotion
      }
    }

    checkAndPromote()

    return () => {
      cancelled = true
      if (toastId.current != null) {
        toast.dismiss(toastId.current)
        toastId.current = null
      }
    }
  }, [terminalTabVisible])
}

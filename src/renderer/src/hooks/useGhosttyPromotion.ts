import { useEffect, useRef, createElement } from 'react'
import { Sparkles } from 'lucide-react'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { toast } from '@/lib/toast'

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

        toastId.current = toast.info('Ghostty native terminal is available', {
          description: 'Get Metal-accelerated rendering with your Ghostty config',
          duration: Infinity,
          icon: createElement(Sparkles, { className: 'h-4 w-4 text-blue-500' }),
          action: {
            label: 'Activate',
            onClick: () => {
              useSettingsStore.getState().updateSetting('embeddedTerminalBackend', 'ghostty')
              toast.success('Ghostty terminal activated')
            }
          },
          cancel: {
            label: "Don't show again",
            onClick: () => {
              useSettingsStore.getState().updateSetting('ghosttyPromotionDismissed', true)
              toast.info('You can always enable Ghostty in Settings > Terminal')
            }
          }
        })
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

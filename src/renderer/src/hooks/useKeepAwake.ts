import { useEffect } from 'react'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'

/**
 * Drives the main-process powerSaveBlocker based on the user's keep-awake
 * setting and whether any session is actively streaming ('working' or
 * 'planning'). Other statuses (answering, permission, command_approval,
 * completed, etc.) do not count as streaming for this purpose.
 */
export function useKeepAwake(): void {
  const enabled = useSettingsStore((s) => s.keepAwakeEnabled)

  const hasStreamingSession = useWorktreeStatusStore((state) =>
    Object.values(state.sessionStatuses).some(
      (entry) => entry && (entry.status === 'working' || entry.status === 'planning')
    )
  )

  const shouldBeAwake = enabled && hasStreamingSession

  useEffect(() => {
    window.systemOps?.setKeepAwake?.(shouldBeAwake).catch((err) => {
      console.error('[keepAwake] setKeepAwake failed', err)
    })
  }, [shouldBeAwake])
}

import { useEffect } from 'react'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { hasBusyDocumentRun } from '@/lib/document-flow/runner'
import { systemApi } from '@/api/system-api'

/**
 * Drives the main-process powerSaveBlocker based on the user's keep-awake
 * setting and whether any session is actively streaming ('working' or
 * 'planning'). Other statuses (answering, permission, command_approval,
 * completed, etc.) do not count as streaming for this purpose. A document run
 * that is between sessions (classifying, merging, verifying, about to launch)
 * counts too: nothing streams at those moments, yet the run is working.
 */
export function useKeepAwake(): void {
  const enabled = useSettingsStore((s) => s.keepAwakeEnabled)

  const hasStreamingSession = useWorktreeStatusStore((state) =>
    Object.values(state.sessionStatuses).some(
      (entry) => entry && (entry.status === 'working' || entry.status === 'planning')
    )
  )
  const hasBusyRun = useDocumentFlowStore((state) => hasBusyDocumentRun(state.runsById))

  const shouldBeAwake = enabled && (hasStreamingSession || hasBusyRun)

  useEffect(() => {
    systemApi.setKeepAwake(shouldBeAwake).catch((err) => {
      console.error('[keepAwake] setKeepAwake failed', err)
    })
  }, [shouldBeAwake])
}

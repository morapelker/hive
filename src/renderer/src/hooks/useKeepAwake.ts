import { useEffect } from 'react'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { hasBusyDocumentRun } from '@/lib/document-flow/runner'
import { systemApi } from '@/api/system-api'
import { useInProgressSessionCount } from './useInProgressSessionCount'

/**
 * Drives the main-process powerSaveBlocker based on the user's keep-awake
 * setting and whether any session is in progress (see
 * lib/in-progress-sessions): streaming ('working' / 'planning'), paused
 * behind a pending monitor/subagent/wakeup that will resume it, or linked
 * from a ticket in the board's in-progress column. A finished session
 * (completed, unread) with no in-progress ticket does not count. A document
 * run that is between sessions (classifying, merging, verifying, about to
 * launch) counts too: nothing streams at those moments, yet the run is working.
 */
export function useKeepAwake(): void {
  const enabled = useSettingsStore((s) => s.keepAwakeEnabled)

  const hasStreamingSession = useInProgressSessionCount() > 0
  const hasBusyRun = useDocumentFlowStore((state) => hasBusyDocumentRun(state.runsById))

  const shouldBeAwake = enabled && (hasStreamingSession || hasBusyRun)

  useEffect(() => {
    systemApi.setKeepAwake(shouldBeAwake).catch((err) => {
      console.error('[keepAwake] setKeepAwake failed', err)
    })
  }, [shouldBeAwake])
}

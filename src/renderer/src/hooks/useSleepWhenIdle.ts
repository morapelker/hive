import { useEffect, useRef } from 'react'
import { systemApi } from '@/api/system-api'
import { hasBusyDocumentRun } from '@/lib/document-flow/runner'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useSleepWhenIdleStore } from '@/stores/useSleepWhenIdleStore'
import { useWorktreeStatusStore, type SessionStatusType } from '@/stores/useWorktreeStatusStore'

const IDLE_DEBOUNCE_MS = 60_000
const NON_IDLE = new Set<SessionStatusType>([
  'working',
  'planning',
  'answering',
  'permission',
  'command_approval'
])

// A document run between sessions (merging, verifying, classifying) is work too, even
// though no session shows as non-idle at that moment.
function hasNonIdleSession(): boolean {
  return (
    Object.values(useWorktreeStatusStore.getState().sessionStatuses).some(
      (entry) => entry && NON_IDLE.has(entry.status)
    ) || hasBusyDocumentRun(useDocumentFlowStore.getState().runsById)
  )
}

export function useSleepWhenIdle(): void {
  const armed = useSleepWhenIdleStore((state) => state.armed)
  const disarm = useSleepWhenIdleStore((state) => state.disarm)
  const keepAwakeEnabled = useSettingsStore((state) => state.keepAwakeEnabled)
  const anyNonIdleSession = useWorktreeStatusStore((state) =>
    Object.values(state.sessionStatuses).some((entry) => entry && NON_IDLE.has(entry.status))
  )
  const anyBusyRun = useDocumentFlowStore((state) => hasBusyDocumentRun(state.runsById))
  const anyNonIdle = anyNonIdleSession || anyBusyRun
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const clear = (): void => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }

    if (!armed || !keepAwakeEnabled) {
      clear()
      if (!keepAwakeEnabled) disarm()
      return clear
    }

    if (anyNonIdle) {
      clear()
      return clear
    }

    if (!timerRef.current) {
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        const stillIdle = !hasNonIdleSession()

        if (
          stillIdle &&
          useSleepWhenIdleStore.getState().armed &&
          useSettingsStore.getState().keepAwakeEnabled
        ) {
          systemApi.sleepNow().catch((err) => {
            console.error('[sleepWhenIdle] failed', err)
          })
        }

        disarm()
      }, IDLE_DEBOUNCE_MS)
    }

    return clear
  }, [armed, keepAwakeEnabled, anyNonIdle, disarm])
}

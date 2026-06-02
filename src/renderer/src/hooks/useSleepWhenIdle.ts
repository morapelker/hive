import { useEffect, useRef } from 'react'
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

function hasNonIdleSession(): boolean {
  return Object.values(useWorktreeStatusStore.getState().sessionStatuses).some(
    (entry) => entry && NON_IDLE.has(entry.status)
  )
}

export function useSleepWhenIdle(): void {
  const armed = useSleepWhenIdleStore((state) => state.armed)
  const disarm = useSleepWhenIdleStore((state) => state.disarm)
  const keepAwakeEnabled = useSettingsStore((state) => state.keepAwakeEnabled)
  const anyNonIdle = useWorktreeStatusStore((state) =>
    Object.values(state.sessionStatuses).some((entry) => entry && NON_IDLE.has(entry.status))
  )
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
          window.systemOps?.sleepNow?.().catch((err) => {
            console.error('[sleepWhenIdle] failed', err)
          })
        }

        disarm()
      }, IDLE_DEBOUNCE_MS)
    }

    return clear
  }, [armed, keepAwakeEnabled, anyNonIdle, disarm])
}

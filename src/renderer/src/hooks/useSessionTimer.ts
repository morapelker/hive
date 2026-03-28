import { useTimerTickStore } from '@/stores/useTimerTickStore'
import { userExplicitSendTimes } from '@/lib/message-send-times'
import { formatElapsedTimer } from '@/lib/format-utils'

export function useSessionTimer(sessionId: string | null, isActive: boolean): string | null {
  // When inactive, return a stable 0 so the component does not re-render each tick
  const tickMs = useTimerTickStore((state) => (isActive ? state.tickMs : 0))

  if (!isActive || sessionId === null) return null

  const sendTime = userExplicitSendTimes.get(sessionId)
  if (sendTime === undefined) return null

  return formatElapsedTimer(tickMs - sendTime)
}

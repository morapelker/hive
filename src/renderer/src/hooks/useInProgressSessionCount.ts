import { useSyncExternalStore } from 'react'
import { countInProgressSessions } from '@/lib/in-progress-sessions'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'

function subscribe(onChange: () => void): () => void {
  const unsubscribeStatus = useWorktreeStatusStore.subscribe(onChange)
  const unsubscribeKanban = useKanbanStore.subscribe(onChange)
  return () => {
    unsubscribeStatus()
    unsubscribeKanban()
  }
}

function getSnapshot(): number {
  return countInProgressSessions(
    useWorktreeStatusStore.getState().sessionStatuses,
    useKanbanStore.getState().tickets.values()
  )
}

/**
 * Number of in-progress sessions app-wide (streaming, paused behind a pending
 * monitor/subagent/wakeup, or linked from a ticket in the in-progress column —
 * see lib/in-progress-sessions). Reads both the status store and the board,
 * so a primitive snapshot keeps re-renders to real count changes.
 */
export function useInProgressSessionCount(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

import { useEffect } from 'react'
import { useSettingsStore } from '@/stores/useSettingsStore'
import {
  registerPerfGauge,
  registerPerfStore,
  startRendererPerfCollector,
  stopRendererPerfCollector
} from './renderer-perf-collector'

/**
 * Runs the renderer performance collector while the "Performance logging" setting is on.
 * Store sizes are registered here (not in the collector) so the collector stays free of
 * store imports and can be unit-tested on its own.
 */
/** Total entries of a collection-of-collections (Map/Record of arrays), or its own size. */
const countNested = (value: unknown): number => {
  if (Array.isArray(value)) return value.length
  const values =
    value instanceof Map ? [...value.values()] : value && typeof value === 'object' ? Object.values(value) : []
  let total = 0
  for (const inner of values) {
    if (Array.isArray(inner)) total += inner.length
    else if (inner instanceof Map || inner instanceof Set) total += inner.size
    else if (inner && typeof inner === 'object') total += Object.keys(inner).length
  }
  return total
}

export const usePerfLoggingCollector = (): void => {
  const enabled = useSettingsStore((state) => state.perfDiagnosticsEnabled)

  useEffect(() => {
    if (!enabled) return undefined
    const unregister: Array<() => void> = []
    let cancelled = false
    void Promise.all([
      import('@/stores/useSessionStore'),
      import('@/stores/useKanbanStore'),
      import('@/stores/useWorktreeStore'),
      import('@/stores/useWorktreeStatusStore'),
      import('@/stores/useUsageStore'),
      import('@/stores/useBoardChatStore'),
      import('@/stores/useScriptStore')
    ])
      .then((modules) => {
        if (cancelled) return
        const stores: Array<[string, { getState: () => unknown } | undefined]> = [
          ['session', modules[0].useSessionStore],
          ['kanban', modules[1].useKanbanStore],
          ['worktree', modules[2].useWorktreeStore],
          ['worktreeStatus', modules[3].useWorktreeStatusStore],
          ['usage', modules[4].useUsageStore],
          ['boardChat', modules[5].useBoardChatStore],
          ['script', modules[6].useScriptStore]
        ]
        for (const [name, store] of stores) {
          if (store && typeof store.getState === 'function') {
            unregister.push(registerPerfStore(name, () => store.getState()))
          }
        }
        // Derived counters that shallow sizes cannot express.
        unregister.push(
          registerPerfGauge('derived', () => {
            const statuses = (modules[3].useWorktreeStatusStore.getState() as {
              sessionStatuses?: Record<string, { status?: string } | null>
            }).sessionStatuses ?? {}
            let nulls = 0
            let working = 0
            for (const entry of Object.values(statuses)) {
              if (entry === null) nulls += 1
              else if (entry?.status === 'working') working += 1
            }
            const tickets = (modules[1].useKanbanStore.getState() as { tickets?: unknown }).tickets
            return {
              sessionStatusKeys: Object.keys(statuses).length,
              sessionStatusNulls: nulls,
              sessionStatusWorking: working,
              kanbanTickets: countNested(tickets)
            }
          })
        )
      })
      .catch(() => undefined)
    startRendererPerfCollector()
    return () => {
      cancelled = true
      for (const fn of unregister) fn()
      stopRendererPerfCollector()
    }
  }, [enabled])
}

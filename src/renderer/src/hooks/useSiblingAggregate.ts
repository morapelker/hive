import { useMemo } from 'react'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useGitStore } from '@/stores/useGitStore'

export interface SiblingBucket {
  count: number
  names: string[]
}

export interface SiblingAggregate {
  working: SiblingBucket
  ready: SiblingBucket
  waiting: SiblingBucket
}

const EMPTY_BUCKET: SiblingBucket = { count: 0, names: [] }
const EMPTY_AGGREGATE: SiblingAggregate = {
  working: EMPTY_BUCKET,
  ready: EMPTY_BUCKET,
  waiting: EMPTY_BUCKET
}

/**
 * Aggregates status counts across all non-default, non-archiving siblings of a project,
 * grouped into three buckets used by the pinned main-branch row dashboard:
 *
 *   - working: working | planning
 *   - ready:   completed
 *   - waiting: answering | permission | command_approval | plan_ready
 *
 * Siblings with status `unread` or `null` (idle) are not counted.
 *
 * Reactivity: subscribes to every store slice whose change could affect the result
 * (sessionStatuses, sessionsByWorktree, connections, branchInfoByWorktree, worktrees,
 * archivingWorktreeIds). The per-sibling `getWorktreeStatus(...)` call is a one-shot
 * read against `.getState()`, which is safe because all of its inputs are subscribed
 * to above, so the enclosing useMemo re-runs whenever any of them changes.
 */
/**
 * Connection-project twin of {@link useSiblingAggregate}: aggregates status
 * counts across the sibling connection instances of a connection project
 * (connections.saved_project_id === projectId), excluding the given instance
 * (the pinned base). Buckets and skip rules match the worktree aggregate;
 * per-instance status comes from `getConnectionStatus(...)`, whose inputs
 * (sessionStatuses, sessionsByConnection) are subscribed to below.
 */
export function useConnectionInstanceAggregate(
  projectId: string | null | undefined,
  excludeConnectionId: string
): SiblingAggregate {
  const connections = useConnectionStore((s) => s.connections)
  const sessionStatuses = useWorktreeStatusStore((s) => s.sessionStatuses)
  const sessionsByConnection = useSessionStore((s) => s.sessionsByConnection)

  return useMemo<SiblingAggregate>(() => {
    if (!projectId) return EMPTY_AGGREGATE

    const working: string[] = []
    const ready: string[] = []
    const waiting: string[] = []

    for (const c of connections) {
      if (c.saved_project_id !== projectId) continue
      if (c.id === excludeConnectionId) continue

      const status = useWorktreeStatusStore.getState().getConnectionStatus(c.id)
      if (!status) continue

      const projectNames = [...new Set(c.members.map((m) => m.project_name))].join(' + ')
      const displayName = c.custom_name || projectNames || c.name || 'Connection'

      switch (status) {
        case 'working':
        case 'planning':
          working.push(displayName)
          break
        case 'completed':
          ready.push(displayName)
          break
        case 'answering':
        case 'permission':
        case 'command_approval':
        case 'plan_ready':
          waiting.push(displayName)
          break
        // unread + idle (null) are intentionally skipped
        default:
          break
      }
    }

    return {
      working: { count: working.length, names: working },
      ready: { count: ready.length, names: ready },
      waiting: { count: waiting.length, names: waiting }
    }
    // `sessionStatuses` and `sessionsByConnection` feed getConnectionStatus()
    // via `.getState()` — listed so their changes recompute the aggregate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, excludeConnectionId, connections, sessionStatuses, sessionsByConnection])
}

export function useSiblingAggregate(
  projectId: string,
  excludeWorktreeId: string
): SiblingAggregate {
  const worktrees = useWorktreeStore((s) => s.worktreesByProject.get(projectId))
  const archivingWorktreeIds = useWorktreeStore((s) => s.archivingWorktreeIds)
  const sessionStatuses = useWorktreeStatusStore((s) => s.sessionStatuses)
  const sessionsByWorktree = useSessionStore((s) => s.sessionsByWorktree)
  const connections = useConnectionStore((s) => s.connections)
  const branchInfoByWorktree = useGitStore((s) => s.branchInfoByWorktree)

  return useMemo<SiblingAggregate>(() => {
    if (!worktrees || worktrees.length === 0) return EMPTY_AGGREGATE

    const working: string[] = []
    const ready: string[] = []
    const waiting: string[] = []

    for (const w of worktrees) {
      if (w.id === excludeWorktreeId) continue
      if (w.is_default) continue
      if (archivingWorktreeIds.has(w.id)) continue

      const status = useWorktreeStatusStore.getState().getWorktreeStatus(w.id)
      if (!status) continue

      const displayName = branchInfoByWorktree.get(w.path)?.name ?? w.name

      switch (status) {
        case 'working':
        case 'planning':
          working.push(displayName)
          break
        case 'completed':
          ready.push(displayName)
          break
        case 'answering':
        case 'permission':
        case 'command_approval':
        case 'plan_ready':
          waiting.push(displayName)
          break
        // unread + idle (null) are intentionally skipped
        default:
          break
      }
    }

    return {
      working: { count: working.length, names: working },
      ready: { count: ready.length, names: ready },
      waiting: { count: waiting.length, names: waiting }
    }
    // `sessionStatuses`, `sessionsByWorktree`, and `connections` are not referenced
    // directly inside this useMemo, but `getWorktreeStatus()` reads them via
    // `.getState()`. We list them here so that a change in any of them triggers
    // a recomputation of the aggregate. `projectId` drives the outer selector
    // for `worktrees` but is also listed for clarity and stability of intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    projectId,
    excludeWorktreeId,
    worktrees,
    archivingWorktreeIds,
    sessionStatuses,
    sessionsByWorktree,
    connections,
    branchInfoByWorktree
  ])
}

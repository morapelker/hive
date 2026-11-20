import { useMemo } from 'react'
import {
  useConnectionStore,
  type Connection,
  type ConnectionArchiveProgress
} from '@/stores/useConnectionStore'
import { useSessionStore } from '@/stores/useSessionStore'

/**
 * "Archiving 2/3": the member being archived out of the batch. Members that archive side by
 * side count as they finish, so the number only reaches the total while the last one runs.
 */
export function connectionArchiveLabel(
  progress: Pick<ConnectionArchiveProgress, 'done' | 'total'>
): string {
  return `Archiving ${Math.min(progress.done + 1, progress.total)}/${progress.total}`
}

/**
 * The connections the sidebar lists: one that is being archived keeps the row it had when its
 * archive began (same name, same place) until the archive ends, although its members leave it
 * one by one and the last one takes the connection with it.
 */
export function withArchivingConnections(
  connections: Connection[],
  archiving: Record<string, ConnectionArchiveProgress>
): Connection[] {
  const batches = Object.values(archiving)
  if (batches.length === 0) return connections
  const live = new Set(connections.map((c) => c.id))
  const rows = connections.map((c) => archiving[c.id]?.connection ?? c)
  const deleted = batches
    .filter((batch) => !live.has(batch.connection.id))
    .sort((a, b) => a.index - b.index)
  for (const batch of deleted) {
    rows.splice(Math.min(batch.index, rows.length), 0, batch.connection)
  }
  return rows
}

/** `withArchivingConnections` over the connection store. */
export function useSidebarConnections(): Connection[] {
  const connections = useConnectionStore((s) => s.connections)
  const archiving = useConnectionStore((s) => s.archivingConnections)
  return useMemo(() => withArchivingConnections(connections, archiving), [connections, archiving])
}

export interface ConnectionArchiveTracker {
  /** The archive of a worktree ended, whether it worked or not. */
  settled: (worktreeId: string) => void
  /** These worktrees are kept after all: a connection they belong to is not going away. */
  release: (worktreeIds: string[]) => void
  end: () => void
}

/**
 * For a batch that archives worktrees wherever they belong (the Done dialog): shows
 * "Archiving x/y" on every connection the batch takes down whole, i.e. whose members are all
 * in it. A connection that only loses some members stays as it is.
 */
export function trackConnectionArchives(worktreeIds: string[]): ConnectionArchiveTracker {
  const batch = new Set(worktreeIds)
  const store = useConnectionStore.getState()
  const tracked = new Map<string, Set<string>>()
  for (const connection of store.connections) {
    // Another batch is already archiving it
    if (store.archivingConnections[connection.id]) continue
    const members = new Set((connection.members ?? []).map((m) => m.worktree_id))
    if (members.size === 0 || ![...members].every((id) => batch.has(id))) continue
    tracked.set(connection.id, members)
    store.beginConnectionArchive(connection.id, members.size)
  }
  return {
    settled: (worktreeId) => {
      for (const [connectionId, members] of tracked) {
        if (members.has(worktreeId)) store.advanceConnectionArchive(connectionId)
      }
    },
    release: (kept) => {
      for (const [connectionId, members] of tracked) {
        if (!kept.some((id) => members.has(id))) continue
        tracked.delete(connectionId)
        store.endConnectionArchive(connectionId)
      }
    },
    end: () => {
      for (const connectionId of tracked.keys()) store.endConnectionArchive(connectionId)
      tracked.clear()
    }
  }
}

/**
 * Archiving every worktree of an instance deletes the instance; its sessions (an agent's
 * terminal, say) must be released first — they are listed per connection, not per worktree.
 */
export async function closeInstanceSessions(connectionId: string | undefined): Promise<void> {
  if (!connectionId) return
  const sessionStore = useSessionStore.getState()
  for (const session of sessionStore.sessionsByConnection.get(connectionId) ?? []) {
    try {
      await sessionStore.closeSession(session.id)
    } catch {
      // Non-critical — the session may be gone already
    }
  }
}

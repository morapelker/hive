import { useConnectionStore } from '@/stores/useConnectionStore'
import type { Connection } from '@/stores/useConnectionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'

/**
 * The connection a sidebar click on `worktreeId` should open instead of the worktree, or null
 * when the "Open connection for connected worktrees" setting is off or the worktree is in no
 * connection. Base connections are skipped: their members are each project's default worktree,
 * so following them would make the main worktree unreachable. With several connections the
 * most recently updated one wins.
 */
export function findRedirectConnection(worktreeId: string): Connection | null {
  if (!useSettingsStore.getState().openConnectionForConnectedWorktree) return null
  const candidates = useConnectionStore
    .getState()
    .connections.filter(
      (c) =>
        c.status === 'active' && !c.is_base && c.members.some((m) => m.worktree_id === worktreeId)
    )
  if (candidates.length === 0) return null
  return candidates.reduce((best, c) => (c.updated_at > best.updated_at ? c : best))
}

/**
 * Opens the worktree's connection instead of the worktree when the setting asks for it.
 * Returns true when it redirected, so the caller skips its own worktree selection.
 */
export function redirectWorktreeToConnection(worktreeId: string): boolean {
  const connection = findRedirectConnection(worktreeId)
  if (!connection) return false
  useConnectionStore.getState().selectConnection(connection.id)
  return true
}

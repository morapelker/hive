/**
 * Git-side member resolution for the selected connection.
 *
 * A connection's git side (Changes tab, branch diff, push/pull) normally works
 * on the member worktrees the connection is made of. In the 'base' git view
 * (cmd+shift+click on a connection ticket) it works on each member project's
 * default worktree — the base branch — instead, even though no connection
 * actually combines those worktrees. Sessions, the terminal and the file tree
 * stay on the connection itself; only the git side is re-pointed.
 */
import {
  useConnectionStore,
  type Connection,
  type ConnectionGitView,
  type ConnectionMemberEnriched
} from '@/stores/useConnectionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

interface DefaultWorktreeLike {
  id: string
  name: string
  branch_name: string
  path: string
  is_default: boolean
}

/** Distinct member project ids of a connection, in member order. */
export function connectionMemberProjectIds(connection: Pick<Connection, 'members'>): string[] {
  return [...new Set(connection.members.map((m) => m.project_id))]
}

/**
 * The members the git side should work on for `gitView`.
 *
 * 'base': one synthetic member per member project, pointing at that project's
 * default worktree. Projects whose worktrees are not loaded (or have no default
 * worktree) are left out until they load — see `useConnectionGitMembers`.
 */
export function resolveConnectionGitMembers(
  connection: Connection,
  gitView: ConnectionGitView,
  worktreesByProject: ReadonlyMap<string, readonly DefaultWorktreeLike[]>
): ConnectionMemberEnriched[] {
  if (gitView !== 'base') return connection.members

  const members: ConnectionMemberEnriched[] = []
  const seen = new Set<string>()
  for (const member of connection.members) {
    if (seen.has(member.project_id)) continue
    seen.add(member.project_id)
    const base = worktreesByProject.get(member.project_id)?.find((w) => w.is_default)
    if (!base) continue
    members.push({
      ...member,
      id: `base:${connection.id}:${base.id}`,
      worktree_id: base.id,
      worktree_name: base.name,
      worktree_branch: base.branch_name,
      worktree_path: base.path
    })
  }
  return members
}

/**
 * Non-hook variant for the currently selected connection (null when no
 * connection is selected or it is not in the store).
 */
export function getSelectedConnectionGitMembers(): ConnectionMemberEnriched[] | null {
  const { selectedConnectionId, connections, connectionGitView } = useConnectionStore.getState()
  if (!selectedConnectionId) return null
  const connection = connections.find((c) => c.id === selectedConnectionId)
  if (!connection) return null
  return resolveConnectionGitMembers(
    connection,
    connectionGitView,
    useWorktreeStore.getState().worktreesByProject
  )
}

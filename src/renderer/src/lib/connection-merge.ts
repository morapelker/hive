import { connectionApi } from '@/api/connection-api'
import { dbApi } from '@/api/db-api'
import { gitApi } from '@/api/git-api'
import { useSessionStore } from '@/stores/useSessionStore'
import type { Session, Worktree } from '../../../main/db/types'

/** One connection-member worktree that needs the merge-on-done flow */
export interface ConnectionMergeTarget {
  worktreeId: string
  projectId: string
}

/**
 * Resolve the connection a ticket's session belongs to, if any.
 * Checks the session store first (cheap), then falls back to the DB —
 * the store map may be cold on project boards.
 */
export async function resolveTicketConnectionId(
  sessionId: string | null | undefined
): Promise<string | null> {
  if (!sessionId) return null
  for (const [connectionId, sessions] of useSessionStore.getState().sessionsByConnection.entries()) {
    if (sessions.some((s) => s.id === sessionId)) return connectionId
  }
  const session = await dbApi.session.get<Session>(sessionId)
  return session?.connection_id ?? null
}

/**
 * Assess every member worktree of a connection and return the ones with work
 * to merge (uncommitted changes or commits ahead of their base branch), using
 * the same pre-checks as the single-project merge-on-done drop path.
 * Members that are on their base branch or inactive are skipped, and a
 * deleted or archived connection yields an empty queue (nothing to merge);
 * an unverifiable member (DB/git failure) rejects so callers can abort the
 * move instead of treating unchecked work as clean.
 *
 * `includeAlreadyMerged` also queues clean members so each still gets the
 * archive/keep step — the connection-project analog of the single-project
 * archive-prompt-only path on Review/Merged → Done drops.
 */
export async function buildConnectionMergeQueue(
  connectionId: string,
  opts?: { includeAlreadyMerged?: boolean }
): Promise<ConnectionMergeTarget[]> {
  const result = await connectionApi.get(connectionId)
  if (!result.success || !result.connection) {
    // A deleted connection has nothing to merge — return an empty queue so
    // the ticket move proceeds instead of failing the transition
    if (result.error === 'Connection not found') return []
    throw new Error(result.error ?? 'Could not retrieve connection members')
  }
  // Same for archived connections — their members are no longer mergeable
  if (result.connection.status === 'archived') return []
  const members = result.connection.members
  const seenWorktrees = new Set<string>()

  const assessed = await Promise.all(
    members.map(async (member): Promise<ConnectionMergeTarget | null> => {
      if (seenWorktrees.has(member.worktree_id)) return null
      seenWorktrees.add(member.worktree_id)

      const worktree = await dbApi.worktree.get<Worktree>(member.worktree_id)
      if (!worktree || worktree.status !== 'active') return null

      const activeWorktrees = await dbApi.worktree.getActiveByProject<Worktree>(member.project_id)
      const defaultWt = activeWorktrees.find((w) => w.is_default)
      const baseBranch = worktree.base_branch ?? defaultWt?.branch_name
      if (!baseBranch || worktree.branch_name === baseBranch) return null

      const baseWorktree = activeWorktrees.find(
        (w) => w.branch_name === baseBranch && w.status === 'active'
      )
      if (!baseWorktree) return null

      const [hasUncommitted, branchStatResult] = await Promise.all([
        gitApi.hasUncommittedChanges(worktree.path),
        gitApi.branchDiffShortStat(worktree.path, baseBranch)
      ])
      if (!branchStatResult.success) {
        throw new Error(
          `${worktree.branch_name}: ${branchStatResult.error ?? 'could not verify merge status'}`
        )
      }

      if (hasUncommitted || branchStatResult.commitsAhead > 0 || opts?.includeAlreadyMerged) {
        return { worktreeId: worktree.id, projectId: member.project_id }
      }
      return null
    })
  )

  return assessed.filter((t): t is ConnectionMergeTarget => t !== null)
}

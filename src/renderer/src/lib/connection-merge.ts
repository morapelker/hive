import { connectionApi } from '@/api/connection-api'
import { dbApi } from '@/api/db-api'
import { gitApi } from '@/api/git-api'
import { pullBaseBranches } from '@/lib/base-branch-pull'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useSessionStore } from '@/stores/useSessionStore'
import type { Session, Worktree } from '../../../main/db/types'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

/** One connection-member worktree that needs the merge-on-done flow */
export interface ConnectionMergeTarget {
  worktreeId: string
  projectId: string
  /**
   * The branch had nothing to commit or merge when the queue was built, so the
   * dialog only has the archive/keep step left for it (see `includeAlreadyMerged`).
   * These members are queued last, so once the merges are done the dialog can
   * offer to archive all of them at once.
   */
  alreadyMerged?: boolean
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
  for (const [connectionId, sessions] of useSessionStore
    .getState()
    .sessionsByConnection.entries()) {
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
 * archive-prompt-only path on Review/Merged → Done drops. They are flagged
 * `alreadyMerged` and ordered after the members with work to merge, so the
 * merge/commit dialogs come first and the archive-only prompts are left for
 * the end, where the dialog offers to archive all of them in one go.
 */
export async function buildConnectionMergeQueue(
  connectionId: string,
  opts?: { includeAlreadyMerged?: boolean }
): Promise<ConnectionMergeTarget[]> {
  return (await assessConnectionMembers(connectionId, opts)).targets
}

/** A member `assessConnectionMembers` left out of the queue, and why. */
export interface ConnectionMemberSkipped {
  worktreeId: string
  projectId: string
  reason:
    /** The worktree row is gone, archived, or mid-archive. */
    | 'inactive'
    /** The worktree is on its base branch itself: nothing to merge. */
    | 'on-base'
    /** No active worktree holds the base branch to merge into. */
    | 'no-base-worktree'
}

export interface ConnectionMembersAssessment {
  /** Members with work first, then (with `includeAlreadyMerged`) the clean ones. */
  targets: ConnectionMergeTarget[]
  skipped: ConnectionMemberSkipped[]
  /** False when the connection is deleted or archived: nothing of it is mergeable. */
  found: boolean
}

/**
 * The assessment behind `buildConnectionMergeQueue`, with the members it leaves out named:
 * a document-run batch has to tell a member it can archive from one whose integration
 * branch can never reach its base here. Every member's base branch is pulled first, since
 * the checks read the local branches; every caller is a Done/Merged move about to rely on them.
 */
export async function assessConnectionMembers(
  connectionId: string,
  opts?: { includeAlreadyMerged?: boolean }
): Promise<ConnectionMembersAssessment> {
  const result = await connectionApi.get(connectionId)
  if (!result.success || !result.connection) {
    // A deleted connection has nothing to merge — return an empty queue so
    // the ticket move proceeds instead of failing the transition
    if (result.error === 'Connection not found') return { targets: [], skipped: [], found: false }
    throw new Error(result.error ?? 'Could not retrieve connection members')
  }
  // Same for archived connections — their members are no longer mergeable
  if (result.connection.status === 'archived') return { targets: [], skipped: [], found: false }
  const members = result.connection.members
  const seenWorktrees = new Set<string>()
  // Members mid-archive are already detached from the ticket's point of view --
  // never ask to commit/merge a branch that is on its way out (read afresh after
  // the pull below too: waiting on origin leaves time for an archive to start)
  const skipped: ConnectionMemberSkipped[] = []

  const resolved = await Promise.all(
    members.map(async (member) => {
      if (seenWorktrees.has(member.worktree_id)) return null
      seenWorktrees.add(member.worktree_id)
      const skip = (reason: ConnectionMemberSkipped['reason']): null => {
        skipped.push({ worktreeId: member.worktree_id, projectId: member.project_id, reason })
        return null
      }
      if (useWorktreeStore.getState().archivingWorktreeIds.has(member.worktree_id)) {
        return skip('inactive')
      }

      const worktree = await dbApi.worktree.get<Worktree>(member.worktree_id)
      if (!worktree || worktree.status !== 'active') return skip('inactive')

      const activeWorktrees = await dbApi.worktree.getActiveByProject<Worktree>(member.project_id)
      const defaultWt = activeWorktrees.find((w) => w.is_default)
      const baseBranch = worktree.base_branch ?? defaultWt?.branch_name
      if (!baseBranch || worktree.branch_name === baseBranch) return skip('on-base')

      const baseWorktree = activeWorktrees.find(
        (w) => w.branch_name === baseBranch && w.status === 'active'
      )
      if (!baseWorktree) return skip('no-base-worktree')

      return { member, worktree, baseBranch }
    })
  )
  const checkable = resolved.filter((entry) => entry !== null)

  await pullBaseBranches(
    checkable.map(({ member, worktree, baseBranch }) => ({
      projectId: member.project_id,
      projectName: member.project_name,
      worktreePath: worktree.path,
      branch: baseBranch
    }))
  )

  const assessed = await Promise.all(
    checkable.map(async ({ member, worktree, baseBranch }): Promise<ConnectionMergeTarget | null> => {
      if (useWorktreeStore.getState().archivingWorktreeIds.has(worktree.id)) {
        skipped.push({ worktreeId: worktree.id, projectId: member.project_id, reason: 'inactive' })
        return null
      }
      const [hasUncommitted, branchStatResult] = await Promise.all([
        gitApi.hasUncommittedChanges(worktree.path),
        gitApi.branchDiffShortStat(worktree.path, baseBranch)
      ])
      if (!branchStatResult.success) {
        throw new Error(
          `${worktree.branch_name}: ${branchStatResult.error ?? 'could not verify merge status'}`
        )
      }

      if (hasUncommitted || branchStatResult.commitsAhead > 0) {
        return { worktreeId: worktree.id, projectId: member.project_id }
      }
      if (opts?.includeAlreadyMerged) {
        return { worktreeId: worktree.id, projectId: member.project_id, alreadyMerged: true }
      }
      return null
    })
  )

  const queue = assessed.filter((t): t is ConnectionMergeTarget => t !== null)
  // Stable: members keep their connection order within each group
  return {
    targets: [...queue.filter((t) => !t.alreadyMerged), ...queue.filter((t) => t.alreadyMerged)],
    skipped,
    found: true
  }
}

/**
 * Done/Merged for the ticket of a document run on a connection project: the ticket has neither
 * worktree nor session, and its integration branches live in the run's instance, one worktree
 * per member. Queue the per-member merge-on-done flow a connection-project ticket gets (archive /
 * keep step for each member; `archivePromptOnly` queues already-merged members too, so the
 * prompt still shows on a Review/Merged → Done move). Returns true when a queue was set and the
 * move is the dialog's to finish; false when nothing is left to merge (the caller moves the
 * ticket). Rejects when a member cannot be assessed: Done means merged for this ticket.
 */
export async function queueConnectionRunMerge(args: {
  connectionId: string
  ticketId: string
  projectId: string
  targetColumn: 'done' | 'merged'
  sortOrder: number
  archivePromptOnly: boolean
}): Promise<boolean> {
  const queue = await buildConnectionMergeQueue(args.connectionId, {
    includeAlreadyMerged: args.archivePromptOnly
  })
  if (queue.length === 0) return false
  const [first, ...rest] = queue
  useKanbanStore.getState().setPendingDoneMove({
    ticketId: args.ticketId,
    projectId: args.projectId,
    sortOrder: args.sortOrder,
    targetColumn: args.targetColumn,
    worktreeId: first.worktreeId,
    worktreeProjectId: first.projectId,
    remainingWorktrees: rest,
    offerArchive: true
  })
  return true
}

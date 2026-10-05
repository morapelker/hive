import type { DocumentRunDetail } from '@shared/types/document-flow'
import { gitApi } from '@/api/git-api'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'

// A run's ticket branches are cut from the integration branch, so a ticket's branch holds the
// merges of the tickets that landed before it. The board merges such a ticket straight into
// the run's base branch; until the integration branch itself is there, those earlier merges
// come along. This finds them, for the one warning line of the merge dialog.

export interface CarriedTicketsQuery {
  ticketId: string
  worktreeId: string
  /** Checkout of the ticket's branch. */
  featureWorktreePath: string
  /** Checkout of the branch it is being merged into. */
  baseWorktreePath: string
}

type IsMerged = (worktreePath: string, ref: string) => Promise<boolean>

const isMergedInto: IsMerged = async (worktreePath, ref) =>
  (await gitApi.isBranchMerged(worktreePath, ref)).isMerged

/**
 * Keys of the run's other tickets whose merge is on this ticket's branch but not on the base
 * branch yet. Empty for a ticket of no run, and whenever git cannot tell.
 */
export async function findCarriedRunTickets(
  query: CarriedTicketsQuery,
  runs: readonly DocumentRunDetail[] = Object.values(useDocumentFlowStore.getState().runsById),
  isMerged: IsMerged = isMergedInto
): Promise<string[]> {
  const run = runs.find((detail) =>
    detail.items.some(
      (item) => item.ticket_id === query.ticketId || item.worktree_id === query.worktreeId
    )
  )
  if (!run) return []
  const others = run.items.filter(
    (item) =>
      item.merge_sha &&
      item.status === 'merged' &&
      item.ticket_id !== query.ticketId &&
      item.worktree_id !== query.worktreeId
  )
  const carried = await Promise.all(
    others.map(async (item) => {
      try {
        const sha = item.merge_sha as string
        if (!(await isMerged(query.featureWorktreePath, sha))) return null
        return (await isMerged(query.baseWorktreePath, sha)) ? null : item.key
      } catch {
        return null
      }
    })
  )
  return carried.filter((key): key is string => key !== null)
}

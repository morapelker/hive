import {
  isConnectionRun,
  type DocumentRunDetail,
  type DocumentRunItem
} from '@shared/types/document-flow'
import { gitApi } from '@/api/git-api'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'

// A run's ticket branches are cut from the integration branch, so a ticket's branch holds the
// merges of the tickets that landed before it. The board merges such a ticket straight into
// the run's base branch; until the integration branch itself is there, those earlier merges
// come along. This finds them, for the one warning line of the merge dialog. On a connection
// run the question is asked per member worktree: the merges that count are the ones in the
// member repository that worktree belongs to.

export interface CarriedTicketsQuery {
  ticketId: string
  /** A git run: the ticket's worktree. A connection run: the member worktree being merged. */
  worktreeId: string
  /** Checkout of the ticket's branch. */
  featureWorktreePath: string
  /** Checkout of the branch it is being merged into. */
  baseWorktreePath: string
}

type IsMerged = (worktreePath: string, ref: string) => Promise<boolean>

const isMergedInto: IsMerged = async (worktreePath, ref) =>
  (await gitApi.isBranchMerged(worktreePath, ref)).isMerged

/** The item's worktree is `worktreeId`: its own, or one of its member worktrees. */
const ownsWorktree = (item: DocumentRunItem, worktreeId: string): boolean =>
  item.worktree_id === worktreeId ||
  (item.members?.some((member) => member.worktree_id === worktreeId) ?? false)

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
      (item) => item.ticket_id === query.ticketId || ownsWorktree(item, query.worktreeId)
    )
  )
  if (!run) return []
  // On a connection run only the merges in the queried worktree's member repository can be on
  // its branch; a worktree of no member (the run ticket's, say) carries nothing we can name.
  let memberProjectId: string | null = null
  if (isConnectionRun(run.run)) {
    memberProjectId =
      run.items
        .flatMap((item) => item.members ?? [])
        .find((member) => member.worktree_id === query.worktreeId)?.project_id ?? null
    if (!memberProjectId) return []
  }
  const mergeShaOf = (item: DocumentRunItem): string | null =>
    memberProjectId
      ? (item.members?.find((member) => member.project_id === memberProjectId)?.merge_sha ?? null)
      : item.merge_sha
  const others = run.items.filter(
    (item) =>
      item.status === 'merged' &&
      mergeShaOf(item) &&
      item.ticket_id !== query.ticketId &&
      !ownsWorktree(item, query.worktreeId)
  )
  const carried = await Promise.all(
    others.map(async (item) => {
      try {
        const sha = mergeShaOf(item) as string
        if (!(await isMerged(query.featureWorktreePath, sha))) return null
        return (await isMerged(query.baseWorktreePath, sha)) ? null : item.key
      } catch {
        return null
      }
    })
  )
  return carried.filter((key): key is string => key !== null)
}

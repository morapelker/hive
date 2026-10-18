// Shift-dropping the ticket of a document run (the orchestrator) on Done/Merged finishes the
// whole run in one go: every ticket branch the run opened is checked, the ones with work the
// integration branch lacks are merged into it (the run's own merge path, one dialog step each),
// the integration branch is merged into the base branch like a plain drop of the run's ticket,
// and the archive step then offers to archive all of the run's branches at once and move their
// tickets along. This builds that queue for the merge-on-done dialog.
//
// What is safe to archive is decided against the branch that SURVIVES: a ticket branch may only
// go once its commits are on the integration branch (checked here, against the integration
// branch) AND the integration branch is on base (the integration entry comes before every
// archive entry, and the dialog re-checks each branch against base right before deleting it).
import { dbApi } from '@/api/db-api'
import { documentFlowApi } from '@/api/document-flow-api'
import { gitApi } from '@/api/git-api'
import { getSessionSignal } from '@/lib/document-flow/session-signal'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import {
  useKanbanStore,
  type PendingDoneMoveKept,
  type PendingDoneMoveWorktree
} from '@/stores/useKanbanStore'
import { toast } from '@/lib/toast'
import { isConnectionRun, type DocumentRunDetail } from '@shared/types/document-flow'
import type { KanbanTicket, KanbanTicketColumn, Worktree } from '../../../../main/db/types'

export interface RunDoneQueue {
  /** Merge entries (ticket branches with work), the integration entry, then archive entries. */
  entries: PendingDoneMoveWorktree[]
  /** Branches left out, named for the dialog's "Kept" line. */
  kept: PendingDoneMoveKept[]
  /** Children with no worktree of their own (fix tickets, say): moved with the run's ticket. */
  alsoMoveTicketIds: string[]
}

type RunWorktree = Pick<Worktree, 'id' | 'project_id' | 'branch_name' | 'path' | 'status' | 'base_branch'> & {
  is_default: boolean
}

const itemLabel = (key: string, title: string): string => `${key} · ${title}`

/**
 * Classify every ticket branch of `detail` for the batch. Rejects when a branch cannot be
 * verified (git failure): unchecked work must never be treated as clean. `tickets` are the
 * board's rows of the run's project (archived rows, when loaded, are never moved).
 */
export async function buildRunDoneQueue(
  detail: DocumentRunDetail,
  runTicketId: string,
  tickets: readonly KanbanTicket[]
): Promise<RunDoneQueue> {
  const { run } = detail
  const projectId = run.project_id
  const integrationId = run.integration_worktree_id
  const integration = integrationId
    ? await dbApi.worktree.get<RunWorktree>(integrationId)
    : null
  const integrationBranch = run.integration_branch
  const integrationActive =
    !!integration && integration.status === 'active' && !!integrationBranch

  const byId = new Map(tickets.map((t) => [t.id, t]))
  const moveable = (ticketId: string | null): ticketId is string => {
    const ticket = ticketId ? byId.get(ticketId) : undefined
    return !!ticket && !ticket.archived_at && ticket.id !== runTicketId
  }

  const mergeEntries: PendingDoneMoveWorktree[] = []
  const archiveEntries: PendingDoneMoveWorktree[] = []
  const kept: PendingDoneMoveKept[] = []
  const alsoMoveTicketIds: string[] = []
  const linkedTicketIds = new Set<string>()
  const seenWorktrees = new Set<string>(integrationId ? [integrationId] : [])
  let defaultBranch: string | null | undefined

  const projectDefaultBranch = async (): Promise<string | null> => {
    if (defaultBranch === undefined) {
      const active = await dbApi.worktree.getActiveByProject<RunWorktree>(projectId)
      defaultBranch = active.find((w) => w.is_default)?.branch_name ?? null
    }
    return defaultBranch
  }

  const items = [...detail.items]
    .filter((item) => item.selected)
    .sort((a, b) => a.position - b.position)

  for (const item of items) {
    const label = itemLabel(item.key, item.title)
    if (item.ticket_id) linkedTicketIds.add(item.ticket_id)
    if (item.fix_ticket_id) linkedTicketIds.add(item.fix_ticket_id)
    // A fix session's ticket runs in the integration worktree: nothing of its own to merge
    if (moveable(item.fix_ticket_id)) alsoMoveTicketIds.push(item.fix_ticket_id)

    // An agent may still be writing on the branch (a cancelled run keeps its sessions)
    const live = [item.session_id, item.fix_session_id].some((sessionId) => {
      if (!sessionId) return false
      const kind = getSessionSignal(sessionId).kind
      return kind === 'working' || kind === 'blocked'
    })
    if (live) {
      kept.push({ label, reason: 'its session is still working — stop it first' })
      continue
    }

    const worktreeId = item.worktree_id && item.worktree_id !== integrationId ? item.worktree_id : null
    if (!worktreeId) {
      if (moveable(item.ticket_id)) {
        if (byId.get(item.ticket_id)?.column === 'todo') {
          kept.push({ label, reason: 'never started' })
        } else {
          alsoMoveTicketIds.push(item.ticket_id)
        }
      }
      continue
    }
    if (seenWorktrees.has(worktreeId)) continue
    seenWorktrees.add(worktreeId)

    // The run merged this branch into the integration branch itself: its work is on the
    // branch that survives, so what is left in the worktree (an agent's stray files, a
    // fixup commit) is never force-committed and merged again by the batch
    const landed = item.status === 'merged' || !!item.merge_sha
    const worktree = await dbApi.worktree.get<RunWorktree>(worktreeId)
    if (!worktree || worktree.status !== 'active') {
      // The branch is gone: its ticket follows the run only if its work landed
      if (landed) {
        if (moveable(item.ticket_id)) alsoMoveTicketIds.push(item.ticket_id)
      } else {
        kept.push({ label, reason: 'its worktree is gone and its work never landed' })
      }
      continue
    }

    const ticketId = moveable(item.ticket_id) ? item.ticket_id : undefined
    // Landed work whose branch is left as it is: named, not archived; its ticket follows
    const keepLanded = (reason: string): void => {
      kept.push({ label, reason })
      if (ticketId) alsoMoveTicketIds.push(ticketId)
    }
    const archiveEntry: PendingDoneMoveWorktree = {
      worktreeId: worktree.id,
      projectId: worktree.project_id,
      alreadyMerged: true,
      kind: 'run-child-archive',
      label,
      ...(ticketId ? { ticketId } : {})
    }

    if (!integrationActive) {
      // Nothing to merge into any more: the branch can only go once it is on base
      const baseBranch = worktree.base_branch ?? (await projectDefaultBranch())
      if (!baseBranch) {
        kept.push({ label, reason: 'no base branch to check it against' })
        continue
      }
      const [dirty, stat] = await Promise.all([
        gitApi.hasUncommittedChanges(worktree.path),
        gitApi.branchDiffShortStat(worktree.path, baseBranch)
      ])
      if (!stat.success) {
        if (landed) {
          keepLanded(`could not be verified: ${stat.error ?? 'git failed'} — not archived`)
          continue
        }
        throw new Error(`${worktree.branch_name}: ${stat.error ?? 'could not verify merge status'}`)
      }
      if (!dirty && stat.commitsAhead === 0) {
        archiveEntries.push(archiveEntry)
      } else if (landed && stat.commitsAhead === 0) {
        keepLanded('has uncommitted changes since the run merged it — not archived')
      } else {
        kept.push({ label, reason: 'the integration worktree is gone — merge it by hand' })
      }
      continue
    }

    const [dirty, stat, statuses] = await Promise.all([
      gitApi.hasUncommittedChanges(worktree.path),
      gitApi.branchDiffShortStat(worktree.path, integrationBranch as string),
      gitApi.getFileStatuses(worktree.path)
    ])
    if (!stat.success) {
      if (landed) {
        keepLanded(`could not be verified: ${stat.error ?? 'git failed'} — not archived`)
        continue
      }
      throw new Error(`${worktree.branch_name}: ${stat.error ?? 'could not verify merge status'}`)
    }
    if (statuses.files?.some((file) => file.status === 'C')) {
      if (landed) keepLanded('has unresolved conflict markers — not archived')
      else kept.push({ label, reason: 'has unresolved conflict markers' })
      continue
    }
    if (!dirty && stat.commitsAhead === 0) {
      archiveEntries.push(archiveEntry)
      continue
    }
    if (landed && stat.commitsAhead === 0) {
      // Only uncommitted leftovers on a branch the run already merged: nothing to merge
      keepLanded('has uncommitted changes since the run merged it — not archived')
      continue
    }
    // Commits the integration branch lacks (never landed, or added since): a merge step
    mergeEntries.push({
      worktreeId: worktree.id,
      projectId: worktree.project_id,
      kind: 'run-child',
      label,
      runId: run.id,
      itemId: item.id,
      integrationBranch: integrationBranch as string,
      integrationWorktreeId: integrationId as string,
      ...(ticketId ? { ticketId } : {})
    })
    archiveEntries.push(archiveEntry)
  }

  // Tickets the run opened that no item names any more (a superseded fix ticket, say)
  for (const ticket of tickets) {
    if (
      ticket.parent_ticket_id !== runTicketId ||
      ticket.id === runTicketId ||
      linkedTicketIds.has(ticket.id) ||
      ticket.archived_at
    ) {
      continue
    }
    if (ticket.column === 'todo') {
      kept.push({ label: ticket.title, reason: 'never started' })
    } else {
      alsoMoveTicketIds.push(ticket.id)
    }
  }

  const entries: PendingDoneMoveWorktree[] = [
    ...mergeEntries,
    ...(integrationActive
      ? [
          {
            worktreeId: integration.id,
            projectId: integration.project_id,
            kind: 'run-integration' as const,
            label: run.title
          }
        ]
      : []),
    ...archiveEntries
  ]
  return { entries, kept, alsoMoveTicketIds: [...new Set(alsoMoveTicketIds)] }
}

export type RunDoneQueueOutcome =
  /** The dialog owns the move now. */
  | 'queued'
  /** Nothing to merge or archive; the caller moves the run's ticket as a plain drop would. */
  | 'nothing'
  /** A run on a connection project: its branches live in member instances; not batched. */
  | 'unsupported'

/**
 * Done/Merged for the whole run. Rejects when a branch cannot be assessed (the drop must then
 * be refused: Done means merged). Returns `nothing` when no branch is left to merge or
 * archive, after moving the run's worktree-less children along.
 */
export async function queueDocumentRunDone(args: {
  runId: string
  ticketId: string
  projectId: string
  targetColumn: 'done' | 'merged'
  sortOrder: number
}): Promise<RunDoneQueueOutcome> {
  const detail = await documentFlowApi.get(args.runId)
  if (!detail) return 'nothing'
  useDocumentFlowStore.getState().applyDetail(detail)
  if (isConnectionRun(detail.run)) return 'unsupported'

  const store = useKanbanStore.getState()
  const tickets = store.tickets.get(args.projectId) ?? []
  // Every branch is checked with git before anything shows: say so meanwhile, so a drop
  // never looks like it did nothing
  const branchCount = detail.items.filter((item) => item.selected).length
  const checking = toast.loading(
    `Checking ${branchCount} branch${branchCount === 1 ? '' : 'es'} of ${detail.run.title}…`
  )
  let queue: RunDoneQueue
  try {
    queue = await buildRunDoneQueue(detail, args.ticketId, tickets)
  } finally {
    toast.dismiss(checking)
  }

  if (queue.entries.length === 0) {
    if (queue.kept.length > 0) {
      toast.warning(
        `Kept: ${queue.kept.map((k) => `${k.label} (${k.reason})`).join(', ')}`
      )
    }
    await moveTicketsAlong(args.projectId, args.targetColumn, queue.alsoMoveTicketIds)
    return 'nothing'
  }

  const [first, ...rest] = queue.entries
  store.setPendingDoneMove({
    ticketId: args.ticketId,
    projectId: args.projectId,
    sortOrder: args.sortOrder,
    targetColumn: args.targetColumn,
    worktreeId: first.worktreeId,
    worktreeProjectId: first.projectId,
    remainingWorktrees: rest,
    offerArchive: true,
    entry: first,
    run: {
      runId: detail.run.id,
      title: detail.run.title,
      kept: queue.kept,
      alsoMoveTicketIds: queue.alsoMoveTicketIds
    }
  })
  return 'queued'
}

async function moveTicketsAlong(
  projectId: string,
  column: KanbanTicketColumn,
  ticketIds: readonly string[]
): Promise<void> {
  const state = useKanbanStore.getState()
  for (const ticketId of ticketIds) {
    const ticket = state.tickets.get(projectId)?.find((t) => t.id === ticketId)
    if (!ticket || ticket.archived_at || ticket.column === column) continue
    const sortOrder = state.computeSortOrder(state.getTicketsByColumn(projectId, column), 0)
    await state.moveTicket(ticketId, projectId, column, sortOrder, { skipCompletionEffects: true })
  }
}
